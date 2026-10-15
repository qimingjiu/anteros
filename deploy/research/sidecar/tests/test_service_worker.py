import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from policy import PolicyError
from service import create_app
from worker import RenderGuard, crawl_document, extract, install_cookieless_setup


class ExtractionTests(unittest.TestCase):
    def test_real_trafilatura_preserves_headings_body_and_table_without_fetching(self):
        paragraph = "The public report describes how the observatory measures the Moon and records its position each night. "
        html = '<html><head><title>Moon report</title></head><body><nav>Login Subscribe</nav><article><h1>Moon report</h1>'
        html += '<p>' + paragraph * 8 + '</p><h2>Results</h2><table><tr><th>Night</th><th>Measure</th></tr><tr><td>Monday</td><td>42</td></tr></table></article></body></html>'
        result = extract({"url": "https://example.com/report", "html": html, "max_chars": 4000})
        self.assertEqual(result["status"], "ok")
        self.assertIn("observatory", result["text"])
        self.assertIn("Monday", result["text"])
        self.assertEqual(result["title"], "Moon report")
        self.assertNotIn("Subscribe", result["text"])

    def test_extraction_challenge_is_not_returned_as_article(self):
        with self.assertRaises(PolicyError):
            extract({"url": "https://example.com/", "html": "<h1>Verify you are human</h1>"})


class RenderGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_private_and_cross_origin_requests_are_aborted_before_gateway(self):
        gateway = SimpleNamespace(call=AsyncMock())
        for url in ["http://127.0.0.1/", "https://cdn.example.com/script.js"]:
            guard = RenderGuard(gateway, "https://example.com/", 24)
            route = SimpleNamespace(abort=AsyncMock(), fulfill=AsyncMock())
            await guard.route(route, SimpleNamespace(url=url, method="GET"))
            route.abort.assert_awaited()
            gateway.call.assert_not_awaited()

    async def test_post_cookie_and_childframe_never_reach_gateway(self):
        for scenario in ["post", "cookie", "authorization", "child"]:
            gateway = SimpleNamespace(call=AsyncMock())
            guard = RenderGuard(gateway, "https://example.com/", 24)
            page = SimpleNamespace(main_frame=object())
            guard.main_page = page
            frame = SimpleNamespace(page=page)
            if scenario != "child":
                page.main_frame = frame
            credentials = {"cookie": "private"} if scenario == "cookie" else {"authorization": "Bearer private"} if scenario == "authorization" else {}
            request = SimpleNamespace(url="https://example.com/script.js", method="POST" if scenario == "post" else "GET",
                frame=frame, resource_type="script", all_headers=AsyncMock(return_value=credentials))
            route = SimpleNamespace(abort=AsyncMock(), fulfill=AsyncMock())
            await guard.route(route, request)
            route.abort.assert_awaited()
            gateway.call.assert_not_awaited()

    async def test_same_origin_document_is_fulfilled_only(self):
        gateway = SimpleNamespace(call=AsyncMock(return_value={"code": 200, "headers": {"content-type": "text/html"}, "body": "PGgxPk9LPC9oMT4="}))
        guard = RenderGuard(gateway, "https://example.com/", 24)
        page = SimpleNamespace(main_frame=None)
        frame = SimpleNamespace(page=page)
        page.main_frame = frame
        guard.main_page = page
        request = SimpleNamespace(url="https://example.com/", method="GET", frame=frame,
                                 resource_type="document", all_headers=AsyncMock(return_value={}))
        route = SimpleNamespace(abort=AsyncMock(), fulfill=AsyncMock())
        await guard.route(route, request)
        route.fulfill.assert_awaited_once()
        route.abort.assert_not_awaited()
        self.assertIsNone(guard.failure)

    async def test_redirect_document_is_aborted_and_scheduled_explicitly(self):
        gateway = SimpleNamespace(call=AsyncMock(return_value={"code": 302, "headers": {"location": "/final"}, "body": ""}))
        guard = RenderGuard(gateway, "https://example.com/", 12)
        page = SimpleNamespace(main_frame=None)
        frame = SimpleNamespace(page=page)
        page.main_frame = frame
        guard.main_page = page
        request = SimpleNamespace(url="https://example.com/start", method="GET", frame=frame,
                                 resource_type="document", all_headers=AsyncMock(return_value={}))
        route = SimpleNamespace(abort=AsyncMock(), fulfill=AsyncMock())
        await guard.route(route, request)
        route.abort.assert_awaited_once()
        route.fulfill.assert_not_awaited()
        self.assertEqual(guard.pending_redirect, "https://example.com/final")
        self.assertIsNone(guard.failure)

    async def test_cross_origin_and_resource_redirects_never_reach_browser(self):
        for kind, location, reason in [("document", "https://other.example.org/", "cross_origin_blocked"),
                                       ("script", "/final.js", "redirect_blocked")]:
            gateway = SimpleNamespace(call=AsyncMock(return_value={"code": 302, "headers": {"location": location}, "body": ""}))
            guard = RenderGuard(gateway, "https://example.com/", 12)
            page = SimpleNamespace(main_frame=None)
            frame = SimpleNamespace(page=page)
            page.main_frame = frame
            guard.main_page = page
            request = SimpleNamespace(url="https://example.com/start", method="GET", frame=frame,
                                     resource_type=kind, all_headers=AsyncMock(return_value={}))
            route = SimpleNamespace(abort=AsyncMock(), fulfill=AsyncMock())
            await guard.route(route, request)
            route.fulfill.assert_not_awaited()
            self.assertEqual(guard.failure, reason)

    async def test_explicit_hops_reuse_guard_budget_and_final_result(self):
        guard = RenderGuard(SimpleNamespace(), "https://example.com/start", 12)
        calls = []
        config = SimpleNamespace(check_robots_txt=True)
        async def arun(url, config):
            calls.append(url)
            if len(calls) == 1:
                guard.pending_redirect = "https://example.com/final"
                guard.requests += 1
                return SimpleNamespace(success=False)
            guard.requests += 1
            return SimpleNamespace(success=True, redirected_url=url)
        result = await crawl_document(SimpleNamespace(arun=arun), "https://example.com/start", config, guard)
        self.assertEqual(calls, ["https://example.com/start", "https://example.com/final"])
        self.assertEqual(guard.requests, 2)
        self.assertEqual(result.redirected_url, "https://example.com/final")

    async def test_redirect_loop_stops_after_six_explicit_hops(self):
        guard = RenderGuard(SimpleNamespace(), "https://example.com/start", 12)
        calls = []
        async def arun(url, config):
            calls.append(url)
            guard.pending_redirect = "https://example.com/loop"
            return SimpleNamespace(success=False)
        with self.assertRaises(PolicyError) as raised:
            await crawl_document(SimpleNamespace(arun=arun), "https://example.com/start", object(), guard)
        self.assertEqual(raised.exception.reason, "redirect_blocked")
        self.assertEqual(len(calls), 6)


class ContextSetupTests(unittest.IsolatedAsyncioTestCase):
    async def test_default_cookie_is_cleared_after_setup_before_first_document(self):
        events, cookie_jar = [], {}
        async def original_setup(context, crawlerRunConfig=None, is_default=False):
            events.append(("setup", crawlerRunConfig, is_default))
            cookie_jar["cookiesEnabled"] = "true"
        async def clear_cookies():
            events.append(("clear",))
            cookie_jar.clear()
        context = SimpleNamespace(clear_cookies=clear_cookies)
        manager = SimpleNamespace(setup_context=original_setup)
        install_cookieless_setup(manager)
        config = SimpleNamespace(url="https://example.com/")
        # All checked call forms: startup's context-only, get_page's config, and is_default.
        await manager.setup_context(context)
        await manager.setup_context(context, config)
        await manager.setup_context(context, crawlerRunConfig=config, is_default=True)
        self.assertEqual([event[0] for event in events], ["setup", "clear"] * 3)
        self.assertEqual(events[-2], ("setup", config, True))
        self.assertEqual(cookie_jar, {})

        gateway = SimpleNamespace(call=AsyncMock(return_value={"code": 200, "headers": {"content-type": "text/html"}, "body": "PGgxPk9LPC9oMT4="}))
        guard = RenderGuard(gateway, "https://example.com/", 24)
        page = SimpleNamespace(main_frame=None)
        frame = SimpleNamespace(page=page)
        page.main_frame = frame
        guard.main_page = page
        async def headers():
            return {"cookie": "; ".join(f"{key}={value}" for key, value in cookie_jar.items())} if cookie_jar else {}
        request = SimpleNamespace(url="https://example.com/", method="GET", frame=frame,
                                 resource_type="document", all_headers=headers)
        route = SimpleNamespace(abort=AsyncMock(), fulfill=AsyncMock())
        await guard.route(route, request)
        route.fulfill.assert_awaited_once()
        self.assertIsNone(guard.failure)

        # A cookie appearing after setup is a real request credential and remains prohibited.
        cookie_jar["session"] = "private"
        next_route = SimpleNamespace(abort=AsyncMock(), fulfill=AsyncMock())
        await guard.route(next_route, request)
        next_route.abort.assert_awaited_once()
        self.assertEqual(guard.failure, "site_restricted")
        self.assertEqual(gateway.call.await_count, 1)

    async def test_failure_to_clear_context_cookies_stops_setup(self):
        manager = SimpleNamespace(setup_context=AsyncMock())
        context = SimpleNamespace(clear_cookies=AsyncMock(side_effect=RuntimeError("fixture failure")))
        install_cookieless_setup(manager)
        with self.assertRaises(RuntimeError):
            await manager.setup_context(context, None, is_default=False)


class ServiceApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_bad_input_never_reaches_worker_or_leaks_url(self):
        worker = AsyncMock()
        async with TestClient(TestServer(create_app(worker))) as client:
            response = await client.post("/render", json={"url": "http://user:secret@127.0.0.1/private"})
            text = await response.text()
            self.assertNotIn("secret", text)
            self.assertNotIn("127.0.0.1", text)
            worker.assert_not_awaited()

    async def test_deadline_has_fixed_error(self):
        worker = AsyncMock(side_effect=asyncio.TimeoutError())
        async with TestClient(TestServer(create_app(worker))) as client:
            response = await client.post("/render", json={"url": "https://example.com/", "timeout_ms": 1000})
            self.assertEqual((await response.json())["reason"], "deadline")

    async def test_extract_caller_deadline_is_used_and_capped_at_eight_seconds(self):
        worker = AsyncMock(return_value={"status": "ok", "text": "article"})
        async with TestClient(TestServer(create_app(worker))) as client:
            for milliseconds, expected in [(250, 0.25), (9000, 8.0)]:
                await client.post("/extract", json={"url": "https://example.com/", "html": "<p>article</p>", "timeout_ms": milliseconds})
                self.assertEqual(worker.call_args.args[2], expected)

    async def test_spa_navigation_url_reaches_worker_unchanged(self):
        worker = AsyncMock(return_value={"status": "ok", "text": "article"})
        async with TestClient(TestServer(create_app(worker))) as client:
            await client.post("/render", json={"url": "https://example.com/#/article/42", "timeout_ms": 1000})
        self.assertEqual(worker.call_args.args[1]["url"], "https://example.com/#/article/42")

    async def test_concurrency_one_returns_busy(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def work(*args):
            started.set()
            await release.wait()
            return {"status": "ok", "title": "", "text": "ok", "finalUrl": "https://example.com/", "provider": "crawl4ai", "extractor": "trafilatura"}
        async with TestClient(TestServer(create_app(work))) as client:
            first = asyncio.create_task(client.post("/render", json={"url": "https://example.com/"}))
            await started.wait()
            second = await client.post("/render", json={"url": "https://example.com/"})
            self.assertEqual((await second.json())["reason"], "busy")
            release.set()
            await first


if __name__ == "__main__":
    unittest.main()
