"""One disposable extraction/render process; its parent kills the entire process group."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import io
import json
import logging
import os
import sys
from urllib.parse import urljoin

from policy import (MAX_BODY, MAX_CHARS, MAX_DEADLINE_MS, MAX_REQUESTS, MAX_TOTAL, USER_AGENT,
                    PolicyError, bounded_integer, content_restricted, failed, public_url, same_origin)


def extract(data: dict, provider: str = "trafilatura") -> dict:
    import trafilatura

    url = public_url(data.get("url"))
    html = data.get("html")
    if not isinstance(html, str) or len(html.encode("utf-8")) > MAX_BODY:
        raise PolicyError("size_limit" if isinstance(html, str) else "invalid_request")
    if content_restricted({}, html.encode("utf-8")):
        raise PolicyError("site_restricted")
    maximum = bounded_integer(data.get("max_chars"), 20_000, 1, MAX_CHARS)
    # Pure extraction from supplied HTML: never use fetch_url(), discovery, or model APIs.
    text = trafilatura.extract(html, url=url, output_format="markdown", with_metadata=False,
                               include_comments=False, include_tables=True, include_links=False,
                               include_images=False, deduplicate=True, favor_precision=True,
                               date_extraction_params={"extensive_search": False})
    if not text or not text.strip():
        raise PolicyError("empty_content")
    meta = trafilatura.extract_metadata(html, default_url=url)
    title = str(getattr(meta, "title", "") or "")[:300]
    title = " ".join(title.split())
    return {"status": "ok", "title": title, "text": text[:maximum], "finalUrl": url,
            "provider": provider, "extractor": "trafilatura", "requestCount": 0}


class GatewayClient:
    def __init__(self, client, base: str, session: str):
        self.client, self.base, self.session = client, base, session
        self.request_count = 0

    async def call(self, path: str, **kwargs) -> dict:
        async with self.client.post(self.base + path, json={"session": self.session, **kwargs}) as response:
            if response.status != 200 or response.content_length and response.content_length > MAX_BODY * 2:
                raise PolicyError("worker_failed")
            payload = await response.content.read(MAX_BODY * 2 + 1)
            if len(payload) > MAX_BODY * 2:
                raise PolicyError("size_limit")
            data = json.loads(payload)
            self.request_count = max(self.request_count, int(data.get("requestCount", 0)))
            if data.get("status") != "ok":
                error = PolicyError(data.get("reason", "worker_failed"))
                if type(data.get("retryAfterMs")) is int and data["retryAfterMs"] > 0:
                    error.retry_after_ms = data["retryAfterMs"]
                raise error
            return data


class GatewayRobots:
    """Crawl4AI v0.9.5's can_fetch boundary, using the same fail-closed GET broker."""
    def __init__(self, gateway: GatewayClient):
        self.gateway = gateway

    async def can_fetch(self, url: str, user_agent: str = USER_AGENT) -> bool:
        await self.gateway.call("/robots", url=url)
        return True


def install_cookieless_setup(manager) -> None:
    """Remove Crawl4AI's synthetic cookie after every context setup, before navigation.

    Pinned v0.9.5 calls setup_context(context, crawlerRunConfig=None, is_default=False)
    from browser startup and get_page(). It unconditionally adds cookiesEnabled=true
    when crawlerRunConfig has an HTTP URL, even when BrowserConfig.cookies is empty.
    Cookie checks during actual requests remain unchanged; page-generated credentials
    are still rejected instead of being stripped or silently forwarded.
    """
    original_setup = manager.setup_context

    async def setup_without_cookies(context, crawlerRunConfig=None, is_default=False):
        try:
            return await original_setup(context, crawlerRunConfig, is_default=is_default)
        finally:
            # This happens at setup, not at request time. Failure to clear is fatal.
            await context.clear_cookies()

    manager.setup_context = setup_without_cookies


class RenderGuard:
    def __init__(self, gateway: GatewayClient, initial: str, maximum: int):
        self.gateway, self.initial, self.maximum = gateway, initial, maximum
        self.main_page = None
        self.requests = 0
        self.document_requests = 0
        self.failure: str | None = None
        self.retry_after_ms = 0
        self.pending_redirect: str | None = None
        self.awaiting_main_page = True

    def raise_if_failed(self) -> None:
        if self.failure:
            error = PolicyError(self.failure)
            if self.retry_after_ms:
                error.retry_after_ms = self.retry_after_ms
            raise error

    async def route(self, route, request) -> None:
        try:
            self.raise_if_failed()
            self.requests += 1
            if self.requests > self.maximum:
                raise PolicyError("request_limit")
            same_origin(request.url, self.initial)
            if request.method != "GET":
                raise PolicyError("site_restricted")
            if request.frame.page != self.main_page or request.frame != self.main_page.main_frame:
                raise PolicyError("site_restricted")
            headers = await request.all_headers()
            if any(headers.get(name) for name in ("authorization", "proxy-authorization", "cookie")):
                raise PolicyError("site_restricted")
            kind = request.resource_type
            # Purely visual resources are intentionally omitted. Script/XHR/document URLs still
            # pass through the broker, including every same-origin redirect target.
            if kind in {"image", "font", "media", "stylesheet"}:
                await route.abort("blockedbyclient")
                return
            if kind not in {"document", "script", "xhr", "fetch"}:
                raise PolicyError("site_restricted")
            if kind == "document":
                self.document_requests += 1
                if self.document_requests > 6:
                    raise PolicyError("redirect_blocked")
            result = await self.gateway.call("/fetch", url=request.url, kind=kind)
            if 300 <= result["code"] < 400:
                # Playwright's route handler only sees the initial URL of automatic
                # redirects. Never hand a redirect back to Chromium to follow directly.
                if kind != "document" or result["code"] not in {301, 302, 303, 307, 308}:
                    raise PolicyError("redirect_blocked")
                location = result.get("headers", {}).get("location")
                if not isinstance(location, str) or not location:
                    raise PolicyError("redirect_blocked")
                self.pending_redirect = same_origin(urljoin(request.url, location), self.initial)
                await route.abort("blockedbyclient")
                return
            body = base64.b64decode(result["body"], validate=True)
            if len(body) > MAX_BODY:
                raise PolicyError("size_limit")
            await route.fulfill(status=result["code"], headers=result["headers"], body=body)
        except PolicyError as error:
            self.failure = error.reason
            self.retry_after_ms = max(self.retry_after_ms, getattr(error, "retry_after_ms", 0))
            with contextlib.suppress(Exception):
                await route.abort("blockedbyclient")
        except Exception:
            self.failure = "site_restricted"
            with contextlib.suppress(Exception):
                await route.abort("blockedbyclient")


async def crawl_document(crawler, url: str, config, guard: RenderGuard):
    """Explicit document hops share one guard and gateway session/budget."""
    current = url
    for _ in range(6):
        guard.pending_redirect = None
        # Failed redirect navigations may leave an error page. Dispose of it before
        # allowing Crawl4AI to create the next explicitly requested main page.
        if guard.main_page is not None:
            with contextlib.suppress(Exception):
                await guard.main_page.close()
        guard.main_page = None
        guard.awaiting_main_page = True
        result = await crawler.arun(current, config=config)
        guard.raise_if_failed()
        if guard.pending_redirect:
            current = same_origin(guard.pending_redirect, guard.initial)
            continue
        if not result.success:
            raise PolicyError("worker_failed")
        return result
    raise PolicyError("redirect_blocked")


async def render(data: dict) -> dict:
    from aiohttp import ClientSession, ClientTimeout, DummyCookieJar
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
    from crawl4ai.async_logger import AsyncLogger

    url = public_url(data.get("url"))
    if os.environ.get("CRAWL4AI_CHROMIUM_SANDBOX", "").lower() != "true":
        raise PolicyError("worker_failed")
    deadline = bounded_integer(data.get("timeout_ms"), 20_000, 100, MAX_DEADLINE_MS)
    maximum = bounded_integer(data.get("max_requests"), MAX_REQUESTS, 1, MAX_REQUESTS)
    cap = bounded_integer(data.get("max_bytes"), MAX_TOTAL, 1024, MAX_TOTAL)
    # This fixed internal service URL comes from deployment, never from a browser/user request.
    gateway_base = os.environ.get("RESEARCH_GATEWAY", "http://gateway:8790")
    async with ClientSession(timeout=ClientTimeout(total=deadline / 1000), trust_env=False,
                             cookie_jar=DummyCookieJar()) as client:
        async with client.post(gateway_base + "/session", json={"url": url, "timeout_ms": deadline,
                               "max_bytes": cap, "max_requests": maximum}) as response:
            opened = await response.json()
        if opened.get("status") != "ok":
            error = PolicyError(opened.get("reason", "worker_failed"))
            if type(opened.get("retryAfterMs")) is int and opened["retryAfterMs"] > 0:
                error.retry_after_ms = opened["retryAfterMs"]
            raise error
        gateway = GatewayClient(client, gateway_base, opened["session"])
        guard = RenderGuard(gateway, url, maximum)
        try:
            browser = BrowserConfig(headless=True, browser_type="chromium", browser_mode="dedicated",
                                    use_managed_browser=False, use_persistent_context=False,
                                    accept_downloads=False, ignore_https_errors=False,
                                    user_agent=USER_AGENT, enable_stealth=False, verbose=False,
                                    memory_saving_mode=True, extra_args=[
                                        "--disable-background-networking", "--disable-quic",
                                        "--disable-breakpad", "--disable-component-update",
                                        "--no-first-run", "--no-default-browser-check",
                                        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                                    ])
            config = CrawlerRunConfig(check_robots_txt=True, user_agent=USER_AGENT,
                                     cache_mode=CacheMode.DISABLED, max_retries=0,
                                     semaphore_count=1, page_timeout=deadline,
                                     wait_until="domcontentloaded", delay_before_return_html=0.5,
                                     scan_full_page=False, process_iframes=False,
                                     simulate_user=False, override_navigator=False, magic=False,
                                     flatten_shadow_dom=False, remove_overlay_elements=False,
                                     remove_consent_popups=False, screenshot=False, pdf=False,
                                     capture_network_requests=False, capture_console_messages=False,
                                     log_console=False, verbose=False, word_count_threshold=1)
            crawler = AsyncWebCrawler(config=browser, base_directory="/tmp", logger=AsyncLogger(verbose=False))
            crawler.robots_parser = GatewayRobots(gateway)
            manager = crawler.crawler_strategy.browser_manager
            install_cookieless_setup(manager)
            original_build_args = manager._build_browser_args

            def safe_browser_args():
                arguments = original_build_args()
                # v0.9.5 includes AutomationControlled suppression even when enable_stealth=False.
                # Remove it rather than relying solely on the public stealth flag.
                forbidden = {"--disable-blink-features=AutomationControlled", "--disable-ipc-flooding-protection",
                             "--disable-dev-shm-usage", "--no-sandbox", "--disable-setuid-sandbox"}
                arguments["args"] = [value for value in arguments["args"] if value not in forbidden]
                arguments["chromium_sandbox"] = True
                return arguments

            manager._build_browser_args = safe_browser_args

            async def create_safe_context(crawlerRunConfig=None):
                # Crawl4AI v0.9.5 has no service_workers BrowserConfig argument. Override its
                # checked create_browser_context seam so blocking is active before any page exists.
                context = await manager.browser.new_context(service_workers="block", user_agent=USER_AGENT,
                                    viewport={"width": 1080, "height": 720}, accept_downloads=False,
                                    ignore_https_errors=False, java_script_enabled=True,
                                    storage_state={"cookies": [], "origins": []})
                await context.route("**/*", guard.route)
                await context.route_web_socket("**/*", lambda socket: socket.close())
                def close_extra_page(extra):
                    if not guard.awaiting_main_page and extra != guard.main_page:
                        asyncio.create_task(extra.close())
                context.on("page", close_extra_page)
                await context.add_init_script("""(() => {
                    const deny = () => { throw new Error('Disabled in public research renderer'); };
                    for (const name of ['Worker','SharedWorker','WebSocket','EventSource','RTCPeerConnection']) {
                        Object.defineProperty(globalThis, name, {value: deny, configurable: false});
                    }
                    Object.defineProperty(window, 'open', {value: () => null, configurable: false});
                    if (navigator.sendBeacon) navigator.sendBeacon = () => false;
                })();""")
                return context

            manager.create_browser_context = create_safe_context

            async def on_page_context_created(page, context, **kwargs):
                guard.main_page = page
                guard.awaiting_main_page = False
                return page

            async def before_retrieve_html(page, **kwargs):
                guard.raise_if_failed()
                same_origin(page.url, url)
                size = await page.evaluate("() => document.documentElement ? document.documentElement.outerHTML.length : 0")
                if size > MAX_BODY:
                    raise PolicyError("size_limit")
                return page

            crawler.crawler_strategy.set_hook("on_page_context_created", on_page_context_created)
            crawler.crawler_strategy.set_hook("before_retrieve_html", before_retrieve_html)
            async with crawler:
                result = await crawl_document(crawler, url, config, guard)
            guard.raise_if_failed()
            final_url = same_origin(result.redirected_url or result.url, url)
            output = extract({"url": final_url, "html": result.html, "max_chars": data.get("max_chars")}, "crawl4ai")
            output["requestCount"] = gateway.request_count
            return output
        finally:
            with contextlib.suppress(Exception):
                await gateway.call("/close")
            current_error = sys.exception()
            if current_error is not None:
                current_error.request_count = gateway.request_count


def main() -> None:
    logging.disable(logging.CRITICAL)
    source = sys.stdin.buffer.read(MAX_BODY * 2 + 1)
    provider = "trafilatura" if len(sys.argv) > 1 and sys.argv[1] == "extract" else "crawl4ai"
    result = failed("worker_failed", provider)
    try:
        if len(source) > MAX_BODY * 2:
            raise PolicyError("size_limit")
        data = json.loads(source)
        # Third-party libraries must not mix URL-bearing progress logs with our JSON protocol.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            if provider == "trafilatura":
                result = extract(data)
            else:
                result = asyncio.run(render(data))
    except PolicyError as error:
        result = failed(error.reason, provider)
        result["requestCount"] = getattr(error, "request_count", 0)
        if getattr(error, "retry_after_ms", 0) > 0:
            result["retryAfterMs"] = error.retry_after_ms
    except Exception:
        result = failed("worker_failed", provider)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
