"""Loopback-published local API. Each job has one killable child process tree."""

from __future__ import annotations

import asyncio
import contextlib
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import signal
import sys

from aiohttp import web

from policy import (MAX_BODY, MAX_CHARS, MAX_DEADLINE_MS, MAX_REQUESTS, MAX_TOTAL, PolicyError,
                    bounded_integer, failed, public_url)

PINS = {"crawl4ai": "0.9.5", "trafilatura": "2.3.1", "aiohttp": "3.14.5", "protego": "0.7.0", "playwright": "1.63.0"}


async def run_worker(mode: str, data: dict, timeout: float) -> dict:
    process = await asyncio.create_subprocess_exec(
        sys.executable, str(Path(__file__).with_name("worker.py")), mode,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        start_new_session=(os.name != "nt"),
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(json.dumps(data, ensure_ascii=False).encode("utf-8")), timeout)
        if process.returncode != 0 or len(output) > MAX_CHARS * 8 + 8192:
            raise PolicyError("worker_failed")
        result = json.loads(output)
        if not isinstance(result, dict) or result.get("status") not in {"ok", "failed"}:
            raise PolicyError("worker_failed")
        if result["status"] == "failed":
            clean = failed(result.get("reason"), "trafilatura" if mode == "extract" else "crawl4ai")
            if type(result.get("requestCount")) is int:
                clean["requestCount"] = max(0, min(result["requestCount"], MAX_REQUESTS))
            if type(result.get("retryAfterMs")) is int and result["retryAfterMs"] > 0:
                clean["retryAfterMs"] = min(result["retryAfterMs"], 8_640_000_000_000_000)
            return clean
        return result
    finally:
        # Kill the process group even after worker success: Chromium grandchildren must not survive.
        with contextlib.suppress(ProcessLookupError, PermissionError):
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGKILL)
            elif process.returncode is None:
                process.kill()
        with contextlib.suppress(Exception):
            await process.wait()


def create_app(worker=run_worker) -> web.Application:
    running = asyncio.Semaphore(1)
    app = web.Application(client_max_size=MAX_BODY * 2)

    async def health(request):
        versions = {}
        for name in PINS:
            try:
                versions[name] = importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError:
                versions[name] = "unavailable"
        ok = versions == PINS
        return web.json_response({"status": "ok" if ok else "failed", "versions": versions}, status=200 if ok else 503)

    async def handle(request):
        mode = "extract" if request.path == "/extract" else "render"
        provider = "trafilatura" if mode == "extract" else "crawl4ai"
        try:
            data = await request.json()
            if not isinstance(data, dict) or set(data) - {"url", "html", "max_chars", "timeout_ms", "max_bytes", "max_requests"}:
                raise PolicyError("invalid_request")
            data["url"] = public_url(data.get("url"))
            data["max_chars"] = bounded_integer(data.get("max_chars"), 20_000, 1, MAX_CHARS)
            if mode == "extract":
                html = data.get("html")
                if not isinstance(html, str):
                    raise PolicyError("invalid_request")
                if len(html.encode("utf-8")) > MAX_BODY:
                    raise PolicyError("size_limit")
                data["timeout_ms"] = bounded_integer(data.get("timeout_ms"), 8000, 1, 8000)
                timeout = data["timeout_ms"] / 1000
            else:
                if "html" in data:
                    raise PolicyError("invalid_request")
                data["timeout_ms"] = bounded_integer(data.get("timeout_ms"), 20_000, 100, MAX_DEADLINE_MS)
                data["max_bytes"] = bounded_integer(data.get("max_bytes"), MAX_TOTAL, 1024, MAX_TOTAL)
                data["max_requests"] = bounded_integer(data.get("max_requests"), MAX_REQUESTS, 1, MAX_REQUESTS)
                timeout = data["timeout_ms"] / 1000
            if running.locked():
                raise PolicyError("busy")
            async with running:
                result = await worker(mode, data, timeout)
            return web.json_response(result)
        except (asyncio.TimeoutError, TimeoutError):
            return web.json_response(failed("deadline", provider))
        except PolicyError as error:
            return web.json_response(failed(error.reason, provider))
        except web.HTTPRequestEntityTooLarge:
            return web.json_response(failed("size_limit", provider))
        except Exception:
            return web.json_response(failed("worker_failed", provider))

    app.router.add_get("/health", health)
    app.router.add_post("/extract", handle)
    app.router.add_post("/render", handle)
    return app


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    web.run_app(create_app(), host="0.0.0.0", port=8787, access_log=None, print=None)
