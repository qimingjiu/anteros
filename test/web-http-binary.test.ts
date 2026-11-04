import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { setTimeout as delay } from "node:timers/promises";
import { fetchPublic, fetchPublicBytes, WebAccessError } from "../src/tools/web-http.js";

const options = { timeoutMs: 1_000, maxBytes: 1_000 };

test("public binary fetch: preserves original binary while text wrapper retains charset decoding", async t => {
  const binary = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x81, 0xfe]);
  t.mock.method(globalThis, "fetch", async () => new Response(binary, { headers: { "Content-Type": "application/octet-stream" } }));
  const result = await fetchPublicBytes("https://8.8.8.8/fixture", options);
  assert.ok(Buffer.from(result.bytes).equals(Buffer.from(binary)), "binary fetch must not decode image bytes");
  t.mock.method(globalThis, "fetch", async () => new Response(Uint8Array.from([0xe9]), {
    headers: { "Content-Type": "text/plain; charset=windows-1252" },
  }));
  const text = await fetchPublic("https://8.8.8.8/fixture", options);
  assert.equal(text.body, "é");
  assert.equal("bytes" in text, false, "text wrapper keeps its original public shape");
});

test("public binary fetch: DNS answers are checked and every redirect receives policy and a pinned dispatcher", async t => {
  let lookups = 0, fetches = 0, policies = 0;
  t.mock.method(dns.promises, "lookup", async () => { lookups++; return [{ address: "8.8.8.8", family: 4 }]; });
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit & { dispatcher?: unknown }) => {
    fetches++;
    assert.equal(init.redirect, "manual");
    assert.ok(init.dispatcher);
    return fetches === 1 ? new Response(null, { status: 302, headers: { Location: "https://second.fixture.invalid/final" } })
      : new Response(Uint8Array.from([1, 2]));
  });
  await fetchPublicBytes("https://first.fixture.invalid/start", { ...options, beforeRequest: async () => { policies++; } });
  assert.equal(lookups, 2);
  assert.equal(fetches, 2);
  assert.equal(policies, 2);
});

test("public binary fetch: mixed DNS and redirects to private networks fail closed", async t => {
  let fetches = 0;
  t.mock.method(dns.promises, "lookup", async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
  t.mock.method(globalThis, "fetch", async () => { fetches++; return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/blocked" } }); });
  await assert.rejects(fetchPublicBytes("https://mixed.fixture.invalid/fixture", options), error =>
    error instanceof WebAccessError && error.reason === "invalid_url");
  assert.equal(fetches, 0);
  await assert.rejects(fetchPublicBytes("https://8.8.8.8/fixture", options), error =>
    error instanceof WebAccessError && error.reason === "invalid_url");
  assert.equal(fetches, 1);
});

test("public binary fetch: stream byte bound cancels remaining response content", async t => {
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; },
  })));
  const result = await fetchPublicBytes("https://8.8.8.8/fixture", { ...options, maxBytes: 5 });
  assert.equal(result.bytes.byteLength, 5);
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
});

test("public binary fetch: external abort bounds DNS resolution and never starts a connection", async t => {
  t.mock.method(dns.promises, "lookup", async () => new Promise(() => undefined));
  let fetched = false;
  t.mock.method(globalThis, "fetch", async () => { fetched = true; return new Response(); });
  const controller = new AbortController();
  const pending = fetchPublicBytes("https://slow.fixture.invalid/fixture", { ...options, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error instanceof WebAccessError && error.reason === "timeout");
  assert.equal(fetched, false);
});

test("public binary fetch: one deadline includes redirect policy waits", async t => {
  let fetches = 0, policies = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; return new Response(null, { status: 302, headers: { Location: "/next" } }); });
  await assert.rejects(fetchPublicBytes("https://8.8.8.8/fixture", { ...options, timeoutMs: 15,
    beforeRequest: async () => { if (++policies === 2) await delay(30); },
  }), error => error instanceof WebAccessError && error.reason === "timeout");
  assert.equal(fetches, 1);
});
