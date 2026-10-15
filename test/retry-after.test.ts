import { test } from "node:test";
import assert from "node:assert/strict";
import { ResearchRuntime } from "../src/tools/research.js";
import { MAX_COOLDOWN_TIMESTAMP, normalizeRetryAfterMs, parseRetryAfter, WebAccessError } from "../src/tools/web-http.js";

const PAGE = "https://93.184.216.34/guide";
const NOW = Date.UTC(2026, 9, 15, 12);
const YEAR_MS = 365 * 86_400_000;

function runtimeAt(time: () => number) {
  return new ResearchRuntime({
    now: time, perHostDelayMs: 0, publicUrl: async value => new URL(value),
    publicFetch: async url => ({ body: "User-agent: *\nAllow: /", finalUrl: url, status: 200,
      contentType: "text/plain", headers: new Headers(), truncated: false }),
  });
}

async function remaining(runtime: ResearchRuntime): Promise<number> {
  let retryAfterMs = 0;
  await assert.rejects(runtime.run(() => runtime.assertAllowed(PAGE, { countRequest: false })), error => {
    assert.ok(error instanceof WebAccessError);
    assert.equal(error.reason, "rate_limit");
    retryAfterMs = error.retryAfterMs ?? 0;
    return true;
  });
  return retryAfterMs;
}

test("retry-after: 48-hour and one-year HTTP delays retain their full delta-seconds or HTTP-date meaning", () => {
  for (const duration of [172_800_000, YEAR_MS]) {
    assert.equal(parseRetryAfter(String(duration / 1000), NOW), duration);
    assert.equal(parseRetryAfter(new Date(NOW + duration).toUTCString(), NOW), duration);
    assert.equal(normalizeRetryAfterMs(duration), duration);
  }
  assert.equal(parseRetryAfter(null, NOW), 60_000);
  assert.equal(parseRetryAfter("0", NOW), 1000);
  assert.equal(parseRetryAfter(new Date(NOW - 1000).toUTCString(), NOW), 1000);
});

test("retry-after: unsafe or malformed explicit values use a long representable fail-closed delay", () => {
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "5000"]) {
    assert.equal(normalizeRetryAfterMs(value), MAX_COOLDOWN_TIMESTAMP);
  }
  for (const value of ["-1", "invalid", "", "1e20", "999999999999999999999999999999999999999"]) {
    assert.equal(parseRetryAfter(value, NOW), MAX_COOLDOWN_TIMESTAMP);
  }
  assert.equal(normalizeRetryAfterMs(undefined), 60_000);
  assert.equal(normalizeRetryAfterMs(999), 1000);
});

test("retry-after: runtime retains a long cooldown when a later response requests a shorter one", async () => {
  let now = NOW;
  const runtime = runtimeAt(() => now);
  runtime.markCooldown(PAGE, YEAR_MS);
  runtime.markCooldown(PAGE, 1000);
  assert.equal(await remaining(runtime), YEAR_MS);
  now += YEAR_MS - 1;
  assert.equal(await remaining(runtime), 1);
  now++;
  await runtime.run(() => runtime.assertAllowed(PAGE, { countRequest: false }));
});

test("retry-after: maximum waits saturate safely instead of overflowing the timestamp", async () => {
  const runtime = runtimeAt(() => NOW);
  runtime.markCooldown(PAGE, Number.MAX_SAFE_INTEGER);
  assert.equal(await remaining(runtime), MAX_COOLDOWN_TIMESTAMP - NOW);
  const invalid = runtimeAt(() => NOW);
  invalid.markCooldown(PAGE, Infinity);
  assert.equal(await remaining(invalid), MAX_COOLDOWN_TIMESTAMP - NOW);
  const nearDateLimit = runtimeAt(() => MAX_COOLDOWN_TIMESTAMP - 1000);
  nearDateLimit.markCooldown(PAGE, YEAR_MS);
  assert.equal(await remaining(nearDateLimit), 1000);
});

test("retry-after: a robots 429 cannot be retried after one day when the site requested 48 hours", async () => {
  let now = NOW;
  let requests = 0;
  const runtime = new ResearchRuntime({
    now: () => now, publicUrl: async value => new URL(value), perHostDelayMs: 0,
    publicFetch: async url => {
      requests++;
      return { body: "", finalUrl: url, status: 429, contentType: "text/plain",
        headers: new Headers({ "retry-after": "172800" }), truncated: false };
    },
  });
  assert.equal(await remaining(runtime), 172_800_000);
  now += 86_400_001;
  assert.equal(await remaining(runtime), 86_399_999);
  assert.equal(requests, 1);
});
