import asyncio
import base64
import io
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gateway import Broker, Budget, MAX_RELAY_RESPONSE, create_app
from policy import MAX_BODY, MAX_REQUESTS, MAX_TOTAL, PolicyError


class BrokerTests(unittest.IsolatedAsyncioTestCase):
    def make_broker(self, responses):
        broker = Broker()
        budget = Budget("https://example.com/", time.monotonic() + 10, MAX_TOTAL, MAX_REQUESTS)
        broker.sessions["test"] = budget
        broker.download = AsyncMock(side_effect=responses)
        return broker, budget

    async def test_robots_disallow_is_terminal_and_page_never_fetched(self):
        broker, budget = self.make_broker([(200, {"content-type": "text/plain"}, b"User-agent: *\nDisallow: /secret")])
        with self.assertRaises(PolicyError) as raised:
            await broker.fetch({"session": "test", "url": "https://example.com/secret", "kind": "document"})
        self.assertEqual(raised.exception.reason, "robots_denied")
        self.assertEqual(broker.download.await_count, 1)
        self.assertEqual(budget.stopped, "robots_denied")

    async def test_robots_html_or_server_error_is_unknown_and_stops(self):
        for response in [(200, {"content-type": "text/html"}, b"<html>rules?</html>"), (503, {}, b"")]:
            broker, _ = self.make_broker([response])
            with self.subTest(response=response), self.assertRaises(PolicyError) as raised:
                await broker.fetch({"session": "test", "url": "https://example.com/", "kind": "document"})
            self.assertEqual(raised.exception.reason, "robots_unavailable")
            self.assertEqual(broker.download.await_count, 1)

    async def test_longest_match_and_wildcard_robots(self):
        rules = b"User-agent: *\nDisallow: /private/*\nAllow: /private/public$\n"
        broker, budget = self.make_broker([(200, {"content-type": "text/plain"}, rules)])
        await broker.robots("https://example.com/private/public", budget)
        with self.assertRaises(PolicyError):
            await broker.robots("https://example.com/private/secret", budget)

    async def test_cross_origin_redirect_never_followed(self):
        broker, _ = self.make_broker([(404, {}, b""), (302, {"location": "http://169.254.169.254/meta"}, b"")])
        with self.assertRaises(PolicyError):
            await broker.fetch({"session": "test", "url": "https://example.com/", "kind": "document"})
        self.assertEqual(broker.download.await_count, 2)

    async def test_content_and_headers_do_not_forward_credentials(self):
        body = b"<html><article>Public report.</article></html>"
        broker, _ = self.make_broker([(404, {}, b""), (200, {"content-type": "text/html", "set-cookie": "session=secret"}, body)])
        result = await broker.fetch({"session": "test", "url": "https://example.com/", "kind": "document"})
        self.assertEqual(base64.b64decode(result["body"]), body)
        self.assertEqual(result["headers"], {"content-type": "text/html"})

    async def test_challenge_is_terminal(self):
        broker, _ = self.make_broker([(404, {}, b""), (200, {"content-type": "text/html"}, b"<h1>Verify you are human</h1>")])
        with self.assertRaises(PolicyError) as raised:
            await broker.fetch({"session": "test", "url": "https://example.com/", "kind": "document"})
        self.assertEqual(raised.exception.reason, "site_restricted")

    async def test_global_byte_request_and_deadline_caps(self):
        budget = Budget("https://example.com/", time.monotonic() + 10, 10, 1)
        budget.charge_request()
        with self.assertRaises(PolicyError):
            budget.charge_request()
        budget = Budget("https://example.com/", time.monotonic() + 10, 10, 1)
        with self.assertRaises(PolicyError):
            budget.charge_bytes(11)
        budget = Budget("https://example.com/", time.monotonic() - 1, 10, 1)
        with self.assertRaises(PolicyError):
            budget.check()

    async def test_crawl_delay_that_exceeds_deadline_stops(self):
        rules = b"User-agent: *\nAllow: /\nCrawl-delay: 10\n"
        broker, budget = self.make_broker([(200, {"content-type": "text/plain"}, rules)])
        await broker.robots("https://example.com/", budget)
        await broker.polite_wait("https://example.com/", budget)
        with self.assertRaises(PolicyError) as raised:
            await broker.polite_wait("https://example.com/", budget)
        self.assertEqual(raised.exception.reason, "deadline")

    async def test_retry_after_survives_new_sessions_without_network_attempts(self):
        broker = Broker()
        error = broker.rate_limited("https://example.com/a", "120")
        self.assertEqual(error.reason, "rate_limited")
        self.assertEqual(error.retry_after_ms, 120_000)
        broker.download = AsyncMock()
        for session in ("first", "second"):
            budget = Budget("https://example.com/", time.monotonic() + 10, MAX_TOTAL, 12)
            broker.sessions[session] = budget
            with self.assertRaises(PolicyError) as raised:
                await broker.fetch({"session": session, "url": "https://example.com/article", "kind": "document"})
            self.assertEqual(raised.exception.reason, "rate_limited")
            self.assertGreater(raised.exception.retry_after_ms, 119_000)
            self.assertEqual(budget.requests, 0)
        broker.download.assert_not_awaited()

    async def test_retry_after_http_date_default_and_expiry(self):
        broker = Broker()
        future = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=90), usegmt=True)
        error = broker.rate_limited("https://example.com/a", future)
        self.assertGreaterEqual(error.retry_after_ms, 88_000)
        self.assertLessEqual(error.retry_after_ms, 90_000)
        error = broker.rate_limited("https://other.example.org/a", "invalid")
        self.assertEqual(error.retry_after_ms, 60_000)
        broker.cooldowns["https://example.com"] = time.monotonic() - 1
        broker.check_cooldown("https://example.com/a")


class DownloadDeadlineTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_dns_cannot_start_http_after_absolute_deadline(self):
        broker = Broker()
        budget = Budget("https://example.com/", time.monotonic() + 0.01, MAX_TOTAL, 12)
        async def slow_dns(*args):
            await asyncio.sleep(0.1)
            return ["8.8.8.8"]
        with patch("gateway.resolve_public", slow_dns), patch("gateway.ClientSession") as client:
            with self.assertRaises(PolicyError) as raised:
                await broker.download("https://example.com/", budget, 1024)
        self.assertEqual(raised.exception.reason, "deadline")
        client.assert_not_called()

    async def test_empty_body_still_obeys_absolute_deadline(self):
        class EmptyBody:
            async def iter_chunked(self, count):
                await asyncio.sleep(0.1)
                if False:
                    yield b""
        class Response:
            status, headers, content = 200, {}, EmptyBody()
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
        class Client:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
            def get(self, *args, **kwargs): return Response()
        budget = Budget("https://example.com/", time.monotonic() + 0.01, MAX_TOTAL, 12)
        with patch("gateway.resolve_public", AsyncMock(return_value=["8.8.8.8"])), patch("gateway.TCPConnector"), patch("gateway.ClientSession", return_value=Client()):
            with self.assertRaises(PolicyError) as raised:
                await Broker().download("https://example.com/", budget, 1024)
        self.assertEqual(raised.exception.reason, "deadline")

    async def test_http_429_stores_cooldown_and_returns_fixed_reason(self):
        class Response:
            status, headers = 429, {"Retry-After": "120"}
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
        class Client:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
            def get(self, *args, **kwargs): return Response()
        broker = Broker()
        budget = Budget("https://example.com/", time.monotonic() + 10, MAX_TOTAL, 12)
        with patch("gateway.resolve_public", AsyncMock(return_value=["8.8.8.8"])), patch("gateway.TCPConnector"), patch("gateway.ClientSession", return_value=Client()):
            with self.assertRaises(PolicyError) as raised:
                await broker.download("https://example.com/", budget, 1024)
        self.assertEqual(raised.exception.reason, "rate_limited")
        self.assertEqual(raised.exception.retry_after_ms, 120_000)
        self.assertEqual(budget.requests, 1)
        with self.assertRaises(PolicyError):
            broker.check_cooldown("https://example.com/another")


class GatewayApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.broker = Broker()
        self.client = TestClient(TestServer(create_app(self.broker)))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    async def test_caps_caller_budget_and_keeps_gateway_private_protocol(self):
        response = await self.client.post("/session", json={"url": "https://example.com/", "max_bytes": 2**30, "max_requests": 10**5})
        result = await response.json()
        budget = self.broker.sessions[result["session"]]
        self.assertEqual(budget.max_bytes, MAX_TOTAL)
        self.assertEqual(budget.max_requests, MAX_REQUESTS)
        response = await self.client.post("/fetch", json={"session": result["session"], "url": "http://127.0.0.1/secret"})
        self.assertEqual((await response.json())["status"], "failed")

    async def test_error_body_never_echoes_secret_url(self):
        response = await self.client.post("/session", json={"url": "https://user:secret@example.com/private"})
        result = await response.text()
        self.assertNotIn("secret", result)
        self.assertNotIn("example.com", result)

    async def test_new_session_reports_retry_after_without_creating_session(self):
        self.broker.rate_limited("https://example.com/", "120")
        response = await self.client.post("/session", json={"url": "https://example.com/"})
        result = await response.json()
        self.assertEqual(result["reason"], "rate_limited")
        self.assertGreater(result["retryAfterMs"], 119_000)
        self.assertEqual(result["requestCount"], 0)
        self.assertEqual(len(self.broker.sessions), 0)


class FixedRelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.wait = 0
        self.reply = lambda: web.json_response({"status": "ok", "title": "Fixture", "text": "Public fixture article.",
            "finalUrl": "https://example.com/report", "provider": "crawl4ai", "extractor": "trafilatura", "requestCount": 3})

        async def handle(request):
            self.calls.append({"path": request.path_qs, "body": await request.json(), "headers": dict(request.headers)})
            if self.wait:
                await asyncio.sleep(self.wait)
            return self.reply()

        upstream = web.Application(client_max_size=MAX_BODY * 2)
        upstream.router.add_route("*", "/{path:.*}", handle)
        self.sidecar = TestServer(upstream)
        await self.sidecar.start_server()
        # Test-only app construction injection. The public HTTP request cannot choose this address.
        with patch("gateway.SIDECAR_BASE", str(self.sidecar.make_url("/")).rstrip("/")):
            self.client = TestClient(TestServer(create_app()))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        await self.sidecar.close()

    async def test_only_fixed_paths_and_target_are_used_without_incoming_credentials(self):
        response = await self.client.post("/render?url=http://127.0.0.1/private", json={"url": "https://example.com/report"},
            headers={"Authorization": "Bearer fixture-secret", "Cookie": "session=fixture-secret", "Host": "attacker.invalid",
                     "X-Forwarded-Host": "attacker.invalid", "X-Original-URL": "http://127.0.0.1/private"})
        result = await response.json()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(self.calls[0]["path"], "/render")
        self.assertEqual(self.calls[0]["body"]["url"], "https://example.com/report")
        forwarded = {key.lower(): value for key, value in self.calls[0]["headers"].items()}
        for header in ("authorization", "cookie", "x-forwarded-host", "x-original-url"):
            self.assertNotIn(header, forwarded)
        self.assertNotEqual(forwarded.get("host"), "attacker.invalid")
        self.assertNotIn("fixture-secret", await response.text())

    async def test_extract_relays_supplied_html_with_a_bounded_deadline(self):
        response = await self.client.post("/extract", json={"url": "https://example.com/report", "html": "<article>Fixture</article>",
                                                        "timeout_ms": 1000, "max_chars": 15})
        result = await response.json()
        self.assertEqual(self.calls[0]["path"], "/extract")
        self.assertEqual(self.calls[0]["body"]["html"], "<article>Fixture</article>")
        self.assertEqual(self.calls[0]["body"]["timeout_ms"], 1000)
        self.assertEqual(result["provider"], "trafilatura")
        self.assertEqual(len(result["text"]), 15)

    async def test_invalid_input_and_unknown_target_fields_never_reach_sidecar(self):
        for data in [[], {"url": "https://example.com/report", "target": "http://127.0.0.1/private"},
                     {"url": "http://user:fixture-secret@127.0.0.1/private"},
                     {"url": "https://example.com/report", "html": "not permitted on render"}]:
            response = await self.client.post("/render", json=data)
            result = await response.json()
            self.assertEqual(result["status"], "failed")
            self.assertNotIn("fixture-secret", await response.text())
        response = await self.client.post("/render", data="{invalid fixture-secret")
        self.assertEqual((await response.json())["reason"], "invalid_request")
        self.assertEqual(self.calls, [])

    async def test_unknown_route_does_not_turn_into_an_arbitrary_relay(self):
        response = await self.client.post("/render/anything", json={"url": "https://example.com/report"})
        self.assertEqual((await response.json())["status"], "failed")
        self.assertEqual(self.calls, [])

    async def test_oversize_request_is_rejected_before_forwarding(self):
        response = await self.client.post("/extract", data=io.BytesIO(b"x" * (MAX_BODY * 2 + 1)), headers={"Content-Type": "application/json"})
        result = await response.json()
        self.assertEqual(result["reason"], "size_limit")
        self.assertEqual(self.calls, [])

    async def test_oversize_response_is_stopped_and_never_echoed(self):
        self.reply = lambda: web.Response(body=b"x" * (MAX_RELAY_RESPONSE + 1), content_type="application/json")
        response = await self.client.post("/render", json={"url": "https://example.com/report"})
        result = await response.json()
        self.assertEqual(result["reason"], "size_limit")
        self.assertLess(len(await response.read()), 1024)

    async def test_timeout_returns_fixed_error_and_does_not_retry(self):
        self.wait = 0.08
        response = await self.client.post("/extract", json={"url": "https://example.com/report", "html": "<article>Fixture</article>", "timeout_ms": 10})
        result = await response.json()
        self.assertEqual(result["reason"], "deadline")
        # On Windows a 10 ms deadline can expire before the first socket is established.
        self.assertLessEqual(len(self.calls), 1)

    async def test_redirect_response_is_not_followed_or_forwarded(self):
        trap_calls = []
        async def trapped(request):
            trap_calls.append(request.path)
            return web.json_response({"status": "ok"})
        trap = web.Application()
        trap.router.add_route("*", "/{path:.*}", trapped)
        async with TestServer(trap) as trap_server:
            self.reply = lambda: web.Response(status=302, headers={"Location": str(trap_server.make_url("/private")), "Set-Cookie": "session=fixture-secret"})
            response = await self.client.post("/render", json={"url": "https://example.com/report"})
            self.assertEqual((await response.json())["reason"], "worker_failed")
            self.assertNotIn("Location", response.headers)
            self.assertNotIn("Set-Cookie", response.headers)
            self.assertEqual(trap_calls, [])

    async def test_failed_payload_preserves_safe_rate_limit_fields_and_drops_raw_error(self):
        self.reply = lambda: web.json_response({"status": "failed", "reason": "rate_limited", "error": "fixture-secret raw upstream",
                                             "retryAfterMs": 172_800_000, "requestCount": 4, "text": "private content"})
        response = await self.client.post("/render", json={"url": "https://example.com/report"})
        result = await response.json()
        self.assertEqual(result["reason"], "rate_limited")
        self.assertEqual(result["retryAfterMs"], 172_800_000)
        self.assertEqual(result["requestCount"], 4)
        self.assertNotIn("fixture-secret", await response.text())
        self.assertEqual(result["text"], "")

    async def test_malformed_sidecar_payload_and_cross_origin_output_fail_safely(self):
        for payload in [["fixture-secret"], {"status": "ok", "title": "Fixture", "text": "Public text", "finalUrl": "http://127.0.0.1/private"}]:
            self.reply = lambda payload=payload: web.json_response(payload)
            response = await self.client.post("/render", json={"url": "https://example.com/report"})
            result = await response.json()
            self.assertEqual(result["status"], "failed")
            self.assertNotIn("fixture-secret", await response.text())


if __name__ == "__main__":
    unittest.main()
