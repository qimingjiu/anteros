"""Bounded same-origin GET broker. No CONNECT, forward proxy, cookies, or URL logs."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import math
import secrets
import socket
import time
from dataclasses import dataclass, field
from datetime import timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlsplit

from aiohttp import ClientError, ClientSession, ClientTimeout, DummyCookieJar, TCPConnector, web
from aiohttp.abc import AbstractResolver
from protego import Protego

from policy import (MAX_BODY, MAX_CHARS, MAX_DEADLINE_MS, MAX_REQUESTS, MAX_ROBOTS, MAX_TOTAL, USER_AGENT,
                    PolicyError, bounded_integer, content_restricted, failed, network_url, origin, public_url,
                    resolve_public, same_origin)

SIDECAR_BASE = "http://sidecar:8787"
MAX_RELAY_RESPONSE = MAX_CHARS * 8 + 8192


class PublicResolver(AbstractResolver):
    """The connector receives validated IPs, not a hostname that it resolves again."""

    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_INET) -> list[dict]:
        return [{"hostname": host, "host": address, "port": port,
                 "family": socket.AF_INET6 if ":" in address else socket.AF_INET,
                 "proto": socket.IPPROTO_TCP, "flags": socket.AI_NUMERICHOST}
                for address in await resolve_public(host, port)]

    async def close(self) -> None:
        return None


@dataclass
class Budget:
    initial: str
    deadline: float
    max_bytes: int
    max_requests: int
    requests: int = 0
    received: int = 0
    stopped: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def check(self) -> None:
        if self.stopped:
            raise PolicyError(self.stopped)
        if time.monotonic() >= self.deadline:
            self.stopped = "deadline"
            raise PolicyError("deadline")

    def charge_request(self) -> None:
        self.check()
        if self.requests >= self.max_requests:
            self.stopped = "request_limit"
            raise PolicyError("request_limit")
        self.requests += 1

    def charge_bytes(self, count: int) -> None:
        self.check()
        self.received += count
        if self.received > self.max_bytes:
            self.stopped = "size_limit"
            raise PolicyError("size_limit")


class Broker:
    def __init__(self) -> None:
        self.sessions: dict[str, Budget] = {}
        self.rules: dict[str, tuple[float, object]] = {}
        self.next_fetch: dict[str, float] = {}
        self.cooldowns: dict[str, float] = {}
        self.overflow_cooldown = 0.0

    def check_cooldown(self, url: str) -> None:
        until = max(self.cooldowns.get(origin(url), 0.0), self.overflow_cooldown)
        remaining = until - time.monotonic()
        if remaining > 0:
            error = PolicyError("rate_limited")
            error.retry_after_ms = math.ceil(remaining * 1000)
            raise error

    def rate_limited(self, url: str, retry_after: str) -> PolicyError:
        delay_ms = 60_000
        try:
            raw = retry_after.strip()
            if raw.isdigit():
                delay_ms = int(raw[:16]) * 1000 if len(raw) <= 16 else 8_640_000_000_000_000
            elif raw:
                parsed = parsedate_to_datetime(raw)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                delay_ms = math.ceil((parsed.timestamp() - time.time()) * 1000)
        except (ValueError, TypeError, OverflowError):
            delay_ms = 60_000
        # Keep output within JSON's exactly representable integer range. Very large values
        # remain a practically indefinite stop rather than being shortened to a retry window.
        delay_ms = max(1000, min(delay_ms, 8_640_000_000_000_000))
        now = time.monotonic()
        key = origin(url)
        self.cooldowns = {host: until for host, until in self.cooldowns.items() if until > now}
        until = max(self.cooldowns.get(key, 0.0), now + delay_ms / 1000)
        if key not in self.cooldowns and len(self.cooldowns) >= 128:
            # Never evict a live origin's instruction merely to fit a new one.
            self.overflow_cooldown = max(self.overflow_cooldown, until)
        else:
            self.cooldowns[key] = until
        error = PolicyError("rate_limited")
        error.retry_after_ms = math.ceil((until - now) * 1000)
        return error

    def get_budget(self, session: object) -> Budget:
        if not isinstance(session, str) or session not in self.sessions:
            raise PolicyError("invalid_request")
        budget = self.sessions[session]
        if budget.stopped == "rate_limited":
            self.check_cooldown(budget.initial)
        budget.check()
        return budget

    async def download(self, url: str, budget: Budget, limit: int) -> tuple[int, dict, bytes]:
        try:
            async with asyncio.timeout_at(budget.deadline):
                normalized = network_url(same_origin(url, budget.initial))
                self.check_cooldown(normalized)
                budget.charge_request()
                # The absolute deadline covers DNS as well as connection, headers, and empty bodies.
                parsed = urlsplit(normalized)
                await resolve_public(parsed.hostname, 443 if parsed.scheme == "https" else 80)
                budget.check()
                remaining = min(8.0, budget.deadline - time.monotonic())
                if remaining <= 0:
                    raise PolicyError("deadline")
                connector = TCPConnector(resolver=PublicResolver(), use_dns_cache=False, limit=1, force_close=True)
                async with ClientSession(connector=connector, trust_env=False, cookie_jar=DummyCookieJar(),
                                         timeout=ClientTimeout(total=remaining), auto_decompress=False,
                                         headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity",
                                                  "Accept": "*/*"}) as client:
                    async with client.get(normalized, allow_redirects=False) as response:
                        budget.check()
                        headers = {key.lower(): value for key, value in response.headers.items()}
                        if response.status == 429:
                            raise self.rate_limited(normalized, headers.get("retry-after", ""))
                        if response.status in {401, 403, 407, 451}:
                            raise PolicyError("site_restricted")
                        if headers.get("content-encoding", "identity").lower() != "identity":
                            raise PolicyError("unsupported_content")
                        length = headers.get("content-length", "")
                        if length.isdigit() and int(length) > min(limit, budget.max_bytes - budget.received):
                            raise PolicyError("size_limit")
                        output = bytearray()
                        async for chunk in response.content.iter_chunked(16384):
                            budget.charge_bytes(len(chunk))
                            if len(output) + len(chunk) > limit:
                                raise PolicyError("size_limit")
                            output.extend(chunk)
                        budget.check()
                        return response.status, headers, bytes(output)
        except PolicyError:
            raise
        except asyncio.TimeoutError:
            raise PolicyError("deadline") from None
        except (ClientError, OSError, ValueError):
            raise PolicyError("http_error") from None

    async def robots(self, url: str, budget: Budget) -> None:
        normalized = network_url(same_origin(url, budget.initial))
        self.check_cooldown(normalized)
        key = origin(normalized)
        cached = self.rules.get(key)
        if cached and cached[0] > time.monotonic():
            parser = cached[1]
        else:
            status, headers, body = await self.download(key + "/robots.txt", budget, MAX_ROBOTS)
            if status in {404, 410}:
                parser = None  # Known absent rules, as opposed to an unreadable or challenged file.
            elif status == 200:
                if content_restricted(headers, body) or (body.strip() and headers.get("content-type", "").split(";")[0].lower() not in {"text/plain", "text/robots"}):
                    raise PolicyError("robots_unavailable")
                try:
                    text = body.decode("utf-8-sig", "strict")
                except UnicodeError:
                    raise PolicyError("robots_unavailable") from None
                useful = [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
                if useful and not any(line.lower().startswith("user-agent:") for line in useful):
                    raise PolicyError("robots_unavailable")
                parser = Protego.parse(text)
            else:
                raise PolicyError("robots_unavailable")
            if len(self.rules) >= 128:
                self.rules.pop(next(iter(self.rules)))
            self.rules[key] = (time.monotonic() + 300, parser)
        if parser is not None and not parser.can_fetch(normalized, USER_AGENT):
            raise PolicyError("robots_denied")

    async def polite_wait(self, url: str, budget: Budget) -> None:
        key = origin(url)
        cached = self.rules.get(key)
        parser = cached[1] if cached else None
        interval = 1.0
        if parser is not None:
            delay = parser.crawl_delay(USER_AGENT)
            rate = parser.request_rate(USER_AGENT)
            if delay is not None:
                interval = max(interval, float(delay))
            if rate and rate.requests > 0:
                interval = max(interval, float(rate.seconds) / rate.requests)
        now = time.monotonic()
        wait = max(0, self.next_fetch.get(key, 0) - now)
        if now + wait >= budget.deadline:
            raise PolicyError("deadline")
        if wait:
            await asyncio.sleep(wait)
        if len(self.next_fetch) >= 128:
            self.next_fetch.pop(next(iter(self.next_fetch)))
        self.next_fetch[key] = time.monotonic() + interval

    async def fetch(self, data: dict) -> dict:
        budget = self.get_budget(data.get("session"))
        async with budget.lock:
            try:
                url = same_origin(data.get("url"), budget.initial)
                await self.robots(url, budget)
                await self.polite_wait(url, budget)
                status, headers, body = await self.download(url, budget, MAX_BODY)
                if 300 <= status < 400:
                    target = same_origin(urljoin(url, headers.get("location", "")), budget.initial)
                    await self.robots(target, budget)
                    return {"status": "ok", "code": status, "headers": {"location": target}, "body": "", "requestCount": budget.requests}
                if status < 200 or status >= 300:
                    raise PolicyError("http_error")
                media = headers.get("content-type", "").split(";")[0].strip().lower()
                allowed = {"text/html", "application/xhtml+xml", "application/javascript", "text/javascript",
                           "application/json", "text/plain", "text/css", "application/ld+json"}
                if media not in allowed:
                    raise PolicyError("unsupported_content")
                if data.get("kind") == "document" and media not in {"text/html", "application/xhtml+xml"}:
                    raise PolicyError("unsupported_content")
                if content_restricted(headers, body):
                    raise PolicyError("site_restricted")
                # Cookies, authentication prompts, CSP report endpoints, Refresh and all other
                # upstream headers never reach the browser. Redirects have their own guarded branch.
                return {"status": "ok", "code": status, "headers": {"content-type": headers.get("content-type", media)},
                        "body": base64.b64encode(body).decode("ascii"), "requestCount": budget.requests}
            except PolicyError as error:
                budget.stopped = error.reason
                error.request_count = budget.requests
                raise


@web.middleware
async def safe_errors(request: web.Request, handler):
    try:
        return await handler(request)
    except (PolicyError, web.HTTPRequestEntityTooLarge) as error:
        reason = error.reason if isinstance(error, PolicyError) else "size_limit"
        payload = {**failed(reason), "requestCount": getattr(error, "request_count", 0)}
        if getattr(error, "retry_after_ms", 0) > 0:
            payload["retryAfterMs"] = error.retry_after_ms
        return web.json_response(payload, status=200)
    except Exception:
        return web.json_response(failed("worker_failed"), status=200)


def create_app(broker: Broker | None = None) -> web.Application:
    state = broker or Broker()
    app = web.Application(client_max_size=MAX_BODY * 2, middlewares=[safe_errors])
    # Captured at app construction; only tests replace this constant with an in-process server.
    # Requests, headers, environment variables and redirects cannot select another target.
    sidecar_base = SIDECAR_BASE

    async def relay(request):
        mode = "extract" if request.path == "/extract" else "render"
        provider = "trafilatura" if mode == "extract" else "crawl4ai"
        try:
            started = time.monotonic()
            async with asyncio.timeout_at(started + MAX_DEADLINE_MS / 1000):
                try:
                    data = json.loads(await request.read())
                except (ValueError, UnicodeError):
                    raise PolicyError("invalid_request") from None
                if not isinstance(data, dict) or set(data) - {"url", "html", "max_chars", "timeout_ms", "max_bytes", "max_requests"}:
                    raise PolicyError("invalid_request")
                data["url"] = public_url(data.get("url"))
                data["max_chars"] = bounded_integer(data.get("max_chars"), 20_000, 1, MAX_CHARS)
                if mode == "extract":
                    if not isinstance(data.get("html"), str):
                        raise PolicyError("invalid_request")
                    if len(data["html"].encode("utf-8")) > MAX_BODY:
                        raise PolicyError("size_limit")
                    data["timeout_ms"] = bounded_integer(data.get("timeout_ms"), 8000, 1, 8000)
                else:
                    if "html" in data:
                        raise PolicyError("invalid_request")
                    data["timeout_ms"] = bounded_integer(data.get("timeout_ms"), 20_000, 100, MAX_DEADLINE_MS)
                    data["max_bytes"] = bounded_integer(data.get("max_bytes"), MAX_TOTAL, 1024, MAX_TOTAL)
                    data["max_requests"] = bounded_integer(data.get("max_requests"), MAX_REQUESTS, 1, MAX_REQUESTS)
                deadline = min(started + MAX_DEADLINE_MS / 1000, time.monotonic() + data["timeout_ms"] / 1000)
                async with asyncio.timeout_at(deadline):
                    async with ClientSession(trust_env=False, cookie_jar=DummyCookieJar(), auto_decompress=False,
                                             timeout=ClientTimeout(total=max(0.001, deadline - time.monotonic())),
                                             headers={"Content-Type": "application/json", "Accept": "application/json",
                                                      "Accept-Encoding": "identity"}) as client:
                        # No incoming Authorization, Cookie, Host, forwarding or URL headers are copied.
                        async with client.post(sidecar_base + "/" + mode, json=data, allow_redirects=False) as response:
                            if response.status != 200 or response.headers.get("content-encoding", "identity").lower() != "identity":
                                raise PolicyError("worker_failed")
                            if response.content_length is not None and response.content_length > MAX_RELAY_RESPONSE:
                                raise PolicyError("size_limit")
                            output = bytearray()
                            async for chunk in response.content.iter_chunked(16384):
                                if len(output) + len(chunk) > MAX_RELAY_RESPONSE:
                                    raise PolicyError("size_limit")
                                output.extend(chunk)
                            try:
                                result = json.loads(output)
                            except (ValueError, UnicodeError):
                                raise PolicyError("worker_failed") from None
                if not isinstance(result, dict) or result.get("status") not in {"ok", "failed"}:
                    raise PolicyError("worker_failed")
                if result["status"] == "failed":
                    clean = failed(result.get("reason"), provider)
                    if type(result.get("retryAfterMs")) is int and result["retryAfterMs"] > 0:
                        clean["retryAfterMs"] = min(result["retryAfterMs"], 8_640_000_000_000_000)
                else:
                    if not all(isinstance(result.get(key), str) for key in ("title", "text", "finalUrl")):
                        raise PolicyError("worker_failed")
                    clean = {"status": "ok", "title": result["title"][:300], "text": result["text"][:data["max_chars"]],
                             "finalUrl": same_origin(result["finalUrl"], data["url"]), "provider": provider,
                             "extractor": "trafilatura"}
                if type(result.get("requestCount")) is int:
                    clean["requestCount"] = max(0, min(result["requestCount"], MAX_REQUESTS))
                return web.json_response(clean)
        except asyncio.TimeoutError:
            return web.json_response(failed("deadline", provider))
        except web.HTTPRequestEntityTooLarge:
            return web.json_response(failed("size_limit", provider))
        except PolicyError as error:
            return web.json_response(failed(error.reason, provider))
        except Exception:
            return web.json_response(failed("worker_failed", provider))

    async def health(request):
        return web.json_response({"status": "ok", "service": "public-get-broker", "policy": 1})

    async def open_session(request):
        data = await request.json()
        now = time.monotonic()
        state.sessions = {key: value for key, value in state.sessions.items() if value.deadline > now}
        if state.sessions:
            raise PolicyError("busy")
        initial = public_url(data.get("url"))
        state.check_cooldown(initial)
        deadline = bounded_integer(data.get("timeout_ms"), 20_000, 100, MAX_DEADLINE_MS)
        cap = bounded_integer(data.get("max_bytes"), MAX_TOTAL, 1024, MAX_TOTAL)
        requests = bounded_integer(data.get("max_requests"), MAX_REQUESTS, 1, MAX_REQUESTS)
        key = secrets.token_urlsafe(24)
        state.sessions[key] = Budget(initial, now + deadline / 1000, cap, requests)
        return web.json_response({"status": "ok", "session": key})

    async def check_rules(request):
        data = await request.json()
        budget = state.get_budget(data.get("session"))
        async with budget.lock:
            try:
                await state.robots(data.get("url"), budget)
            except PolicyError as error:
                budget.stopped = error.reason
                error.request_count = budget.requests
                raise
        return web.json_response({"status": "ok", "requestCount": budget.requests})

    async def fetch(request):
        return web.json_response(await state.fetch(await request.json()))

    async def close_session(request):
        data = await request.json()
        budget = state.sessions.pop(data.get("session"), None)
        return web.json_response({"status": "ok", "requestCount": budget.requests if budget else 0})

    app.router.add_get("/health", health)
    app.router.add_post("/extract", relay)
    app.router.add_post("/render", relay)
    app.router.add_post("/session", open_session)
    app.router.add_post("/robots", check_rules)
    app.router.add_post("/fetch", fetch)
    app.router.add_post("/close", close_session)
    return app


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    web.run_app(create_app(), host="0.0.0.0", port=8790, access_log=None, print=None)
