"""Run INSIDE the deployed sidecar: actual Chromium routes, SW blocking, and no direct egress.

The browser sees public-looking fixture URLs, but no fixture is downloaded from the Internet.
Its GET broker is replaced by a local, in-memory test server for this process only.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import socket

from aiohttp import web

from policy import PolicyError
from worker import render

ARTICLE = "<article><h1>Public Moon report</h1><p>" + (
    "The observatory measures the Moon and records its position each night in this public scientific report. " * 10
) + "</p><p>The result is a public research sample for validating extraction.</p></article>"


async def run() -> dict:
    checks = {}
    # The isolated Docker network is an independent backstop even if Chromium routes fail.
    try:
        await asyncio.to_thread(lambda: socket.create_connection(("1.1.1.1", 443), timeout=1).close())
        checks["direct_public_egress_blocked"] = False
    except OSError:
        checks["direct_public_egress_blocked"] = True

    seen = []
    active = {"case": "plain"}

    async def opened(request):
        seen.clear()
        return web.json_response({"status": "ok", "session": "smoke-only"})

    async def rules(request):
        return web.json_response({"status": "ok", "requestCount": 1})

    async def fetch(request):
        data = await request.json()
        seen.append(data["url"])
        name = active["case"]
        script = ""
        if name == "private-resource":
            script = "<script>fetch('http://127.0.0.1:8790/private').catch(()=>{});</script>"
        elif name == "cross-origin-resource":
            script = "<script>fetch('https://other.example.org/private').catch(()=>{});</script>"
        elif name == "service-worker":
            script = "<script>navigator.serviceWorker.register('/worker.js').catch(()=>{});</script>"
        elif name == "spa-route":
            script = "<script>if(location.hash === '#/article/42') document.querySelector('article').append(' SPATARGETCONFIRMED');</script>"
        elif name == "same-origin-redirect" and not data["url"].endswith("/final"):
            return web.json_response({"status": "ok", "code": 302, "headers": {"location": "https://example.com/final"}, "body": ""})
        elif name == "cross-origin-redirect":
            return web.json_response({"status": "ok", "code": 302, "headers": {"location": "https://other.example.org/private"}, "body": ""})
        elif name == "robots-denied":
            return web.json_response({"status": "failed", "reason": "robots_denied", "requestCount": 2})
        body = f"<html><head><title>Moon report</title></head><body>{ARTICLE}{script}</body></html>".encode()
        return web.json_response({"status": "ok", "code": 200, "headers": {"content-type": "text/html; charset=utf-8"},
                                  "body": base64.b64encode(body).decode(), "requestCount": len(seen) + 1})

    async def closed(request):
        return web.json_response({"status": "ok", "requestCount": len(seen) + 1})

    app = web.Application()
    app.router.add_post("/session", opened)
    app.router.add_post("/robots", rules)
    app.router.add_post("/fetch", fetch)
    app.router.add_post("/close", closed)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    previous = os.environ.get("RESEARCH_GATEWAY")
    os.environ["RESEARCH_GATEWAY"] = f"http://127.0.0.1:{port}"
    try:
        for name, reason in [("plain", None), ("spa-route", None), ("private-resource", "url_blocked"),
                             ("cross-origin-resource", "cross_origin_blocked"),
                             ("service-worker", None), ("same-origin-redirect", None),
                             ("cross-origin-redirect", "cross_origin_blocked"), ("robots-denied", "robots_denied")]:
            active["case"] = name
            actual = None
            try:
                target = "https://example.com/start#/article/42" if name == "spa-route" else "https://example.com/start"
                result = await asyncio.wait_for(render({"url": target, "max_chars": 2000,
                                                        "timeout_ms": 15_000, "max_requests": 12}), 20)
                success = result["status"] == "ok" and "observatory" in result["text"]
                if name == "spa-route":
                    success = success and "SPATARGETCONFIRMED" in result["text"] and result["finalUrl"].endswith("#/article/42")
                if name == "same-origin-redirect":
                    success = success and result["finalUrl"] == "https://example.com/final" and seen == ["https://example.com/start", "https://example.com/final"]
            except PolicyError as error:
                actual, success = error.reason, False
            except Exception:
                actual, success = "worker_failed", False
            passed = success if reason is None else actual == reason
            if name == "service-worker":
                passed = passed and not any(url.endswith("/worker.js") for url in seen)
            if name == "cross-origin-redirect":
                passed = passed and seen == ["https://example.com/start"]
            checks[name.replace("-", "_")] = passed
    finally:
        if previous is None:
            os.environ.pop("RESEARCH_GATEWAY", None)
        else:
            os.environ["RESEARCH_GATEWAY"] = previous
        await runner.cleanup()
    return {"status": "ok" if all(checks.values()) else "failed", "checks": checks}


if __name__ == "__main__":
    import contextlib
    import io
    import logging
    logging.disable(logging.CRITICAL)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        result = asyncio.run(run())
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result["status"] == "ok" else 1)
