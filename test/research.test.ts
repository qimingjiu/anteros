import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResearchRuntime, canonicalUrl, normalizeQuery } from "../src/tools/research.js";
import { assertPublicUrl, fetchPublic, isPrivateAddress, parseRetryAfter, MAX_COOLDOWN_TIMESTAMP, readBounded, WebAccessError,
  type PublicFetchOptions, type PublicResponse, type WebFailureReason } from "../src/tools/web-http.js";

const PAGE = "https://8.8.8.8/guide";
const FIXED_TIME = Date.UTC(2026, 9, 15, 12);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

async function rejectsReason(action: Promise<unknown>, reason: WebFailureReason) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof WebAccessError);
    assert.equal(error.reason, reason);
    return true;
  });
}

function response(body = "User-agent: *\nAllow: /", extra: Partial<PublicResponse> = {}): PublicResponse {
  return { body, finalUrl: "https://8.8.8.8/robots.txt", contentType: "text/plain", status: 200,
    headers: new Headers(), truncated: false, ...extra };
}

function robotsRuntime(fetcher: (url: string, options: PublicFetchOptions) => Promise<PublicResponse>,
  options: ConstructorParameters<typeof ResearchRuntime>[0] = {}) {
  return new ResearchRuntime({ publicUrl: async value => new URL(value), perHostDelayMs: 0,
    publicFetch: async (url, request) => { request.onRequest?.(); return fetcher(url, request); }, ...options });
}

function temporaryDirectory(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qq-research-test-"));
  t.after(() => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) fs.rmdirSync(filename);
      else fs.unlinkSync(filename);
    }
    fs.rmdirSync(directory);
  });
  return directory;
}

test("research: query/page identities normalize duplicates while preserving SPA routes", () => {
  assert.equal(normalizeQuery("  ＡＰＩ   Guide  "), "api guide");
  assert.equal(canonicalUrl("https://example.com/guide?utm_source=fixture&lang=zh#section"), "https://example.com/guide?lang=zh");
  assert.equal(canonicalUrl("https://example.com/app#/guide"), "https://example.com/app#/guide");
  assert.equal(canonicalUrl("https://example.com/app#!/guide"), "https://example.com/app#!/guide");
});

test("research: nested runs share unique-query and search budgets across providers", async () => {
  const runtime = new ResearchRuntime({ limits: { maxQueries: 1, maxSearchRequests: 2 } });
  await runtime.withSession("owner:conversation", async () => {
    runtime.session.visitQuery(" ＡＰＩ   Guide ");
    await runtime.run(async () => { runtime.session.visitQuery("api guide"); runtime.beforeProvider("searxng", "search"); });
    await runtime.run(async () => runtime.beforeProvider("tavily", "search"));
    await rejectsReason(runtime.run(async () => runtime.beforeProvider("exa", "search")), "budget");
    assert.throws(() => runtime.session.visitQuery("different question"), { reason: "budget" });
    assert.equal(runtime.session.used.queries, 1);
    assert.equal(runtime.session.used.searchRequests, 2);
    assert.equal(runtime.session.used.httpRequests, 2);
    assert.equal(JSON.stringify(runtime.receipt()).includes("api guide"), false);
  });
});

test("research: direct/provider/render work cannot reset the shared HTTP or extraction budgets", async () => {
  const runtime = new ResearchRuntime({ limits: { maxHttpRequests: 2, maxCloudExtractions: 1 } });
  await runtime.withSession("owner:conversation", async () => {
    runtime.beforeProvider("searxng", "search");
    await runtime.run(async () => runtime.beforeProvider("firecrawl", "extract"));
    await rejectsReason(runtime.run(async () => runtime.beforeProvider("jina", "extract")), "budget");
    await rejectsReason(runtime.run(async () => runtime.beforeProvider("crawl4ai", "render")), "budget");
    assert.equal(runtime.session.used.httpRequests, 2);
    assert.equal(runtime.session.used.cloudExtractions, 1);
  });
});

test("research: daily/monthly quotas survive restart and recover only in the next period", async t => {
  const quotaFile = path.join(temporaryDirectory(t), "quota.json");
  let now = FIXED_TIME;
  const options = { quotaFile, now: () => now, quotas: { tavily: { daily: 1, monthly: 2 } } };
  const first = new ResearchRuntime(options);
  await first.run(async () => { first.session.visitQuery("fixture private query"); first.beforeProvider("tavily", "search"); });
  const persisted = fs.readFileSync(quotaFile, "utf8");
  assert.equal(persisted.includes("private query"), false);
  assert.deepEqual(Object.keys(JSON.parse(persisted)).sort(), ["periods", "version"]);

  const sameDay = new ResearchRuntime(options);
  assert.equal(sameDay.providerAvailable("tavily"), false);
  await rejectsReason(sameDay.run(async () => sameDay.beforeProvider("tavily", "search")), "quota");
  now += 86_400_000;
  const nextDay = new ResearchRuntime(options);
  assert.equal(nextDay.providerAvailable("tavily"), true);
  await nextDay.run(async () => nextDay.beforeProvider("tavily", "search"));
  now += 86_400_000;
  const fullMonth = new ResearchRuntime(options);
  assert.equal(fullMonth.providerAvailable("tavily"), false);
  assert.equal(fullMonth.status().quotas.tavily?.dailyUsed, 0);
  assert.equal(fullMonth.status().quotas.tavily?.monthlyUsed, 2);
  await rejectsReason(fullMonth.run(async () => fullMonth.beforeProvider("tavily", "search")), "quota");
  now = Date.UTC(2026, 10, 1, 12);
  assert.equal(new ResearchRuntime(options).providerAvailable("tavily"), true);
});

test("research: malformed quota ledgers fail closed instead of resetting cloud allowances", async t => {
  const directory = temporaryDirectory(t);
  const malformed = ["not-json", JSON.stringify({ version: 2, periods: {} }),
    JSON.stringify({ version: 1, periods: { "day:2026-10-15": { tavily: -1 } } }),
    JSON.stringify({ version: 1, periods: [] })];
  for (let index = 0; index < malformed.length; index++) {
    const quotaFile = path.join(directory, `bad-${index}.json`);
    fs.writeFileSync(quotaFile, malformed[index]!);
    const runtime = new ResearchRuntime({ quotaFile });
    assert.equal(runtime.status().storageReady, false, `malformed ledger ${index}`);
    assert.equal(runtime.providerAvailable("tavily"), false);
    await rejectsReason(runtime.run(async () => runtime.beforeProvider("tavily", "search")), "storage");
    // A cloud ledger problem should still allow the explicitly self-hosted search backend.
    await runtime.run(async () => runtime.beforeProvider("searxng", "search"));
  }
});

test("research: quota write failure blocks subsequent cloud calls", async t => {
  const directory = temporaryDirectory(t);
  const parentFile = path.join(directory, "not-a-directory");
  fs.writeFileSync(parentFile, "fixture");
  const runtime = new ResearchRuntime({ quotaFile: path.join(parentFile, "quota.json") });
  await rejectsReason(runtime.run(async () => runtime.beforeProvider("exa", "search")), "storage");
  assert.equal(runtime.status().storageReady, false);
  assert.equal(runtime.providerAvailable("exa"), false);
  await rejectsReason(runtime.run(async () => runtime.beforeProvider("firecrawl", "extract")), "storage");
});

test("research: cache isolation includes scope and kind, and independent runs do not share data", async () => {
  const runtime = new ResearchRuntime();
  let calls = 0;
  const load = () => runtime.cached("search", "same-key", 60_000, async () => ({ value: ++calls }));
  await runtime.run(load);
  await runtime.run(load);
  assert.equal(calls, 2);
  const first = await runtime.withSession("account-a:conversation-a", load);
  const second = await runtime.withSession("account-a:conversation-a", load);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  await runtime.withSession("account-a:conversation-b", load);
  await runtime.withSession("account-b:conversation-a", load);
  await runtime.withSession("account-a:conversation-a", () => runtime.cached("page", "same-key", 60_000, async () => ({ value: ++calls })));
  assert.equal(calls, 6);
});

test("research: simultaneous cache misses share one request and return separate mutable values", async () => {
  const runtime = new ResearchRuntime();
  const gate = deferred<void>();
  let calls = 0;
  await runtime.withSession("owner:conversation", async () => {
    const action = async () => { calls++; await gate.promise; return { nested: { count: 1 } }; };
    const first = runtime.cached("page", "public-page", 60_000, action);
    const second = runtime.cached("page", "public-page", 60_000, action);
    await tick();
    assert.equal(calls, 1);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.cacheHit, false);
    assert.equal(b.cacheHit, true);
    a.value.nested.count = 10;
    assert.equal(b.value.nested.count, 1);
    assert.equal((await runtime.cached("page", "public-page", 60_000, action)).value.nested.count, 1);
  });
});

test("research: positive cache TTL expires and reissues the request", async () => {
  let now = FIXED_TIME, calls = 0;
  const runtime = new ResearchRuntime({ now: () => now });
  const load = () => runtime.withSession("owner:conversation", () => runtime.cached("search", "query", 20, async () => ++calls));
  assert.equal((await load()).value, 1);
  now += 19;
  assert.equal((await load()).cacheHit, true);
  now += 1;
  assert.equal((await load()).value, 2);
  assert.equal(calls, 2);
});

test("research: negative cache retains a safe denial until TTL expiry", async () => {
  let now = FIXED_TIME, calls = 0;
  const runtime = new ResearchRuntime({ now: () => now });
  const load = () => runtime.withSession("owner:conversation", () => runtime.cached("page", "denied", 120_000, async () => {
    calls++;
    throw new WebAccessError("robots_unavailable", { fallbackAllowed: false });
  }));
  await rejectsReason(load(), "robots_unavailable");
  await rejectsReason(load(), "robots_unavailable");
  assert.equal(calls, 1);
  now += 60_001;
  await rejectsReason(load(), "robots_unavailable");
  assert.equal(calls, 2);
});

test("research: synchronous cache failures release singleflight so an expired denial can retry", async () => {
  let now = FIXED_TIME, calls = 0;
  const runtime = new ResearchRuntime({ now: () => now });
  const load = () => runtime.withSession("owner:conversation", () => runtime.cached("page", "sync-denial", 20, () => {
    calls++;
    throw new WebAccessError("robots_unavailable", { fallbackAllowed: false });
  }));
  await rejectsReason(load(), "robots_unavailable");
  now += 21;
  await rejectsReason(load(), "robots_unavailable");
  assert.equal(calls, 2);
});

test("research: robots disallow, HTTP authorization failures and unknown responses remain denied on retries", async () => {
  const cases: [PublicResponse | Error, WebFailureReason][] = [
    [response("User-agent: *\nDisallow: /private"), "robots_denied"],
    [response("", { status: 401 }), "robots_denied"],
    [response("", { status: 403 }), "robots_denied"],
    [response("upstream unavailable", { status: 503 }), "robots_unavailable"],
    [response("<html>Challenge</html>", { contentType: "text/html" }), "robots_unavailable"],
    [response("User-agent: *\nAllow: /", { truncated: true }), "robots_unavailable"],
    [new Error("fixture private upstream detail"), "robots_unavailable"],
  ];
  for (const [upstream, reason] of cases) {
    let calls = 0;
    const runtime = robotsRuntime(async () => { calls++; if (upstream instanceof Error) throw upstream; return upstream; });
    for (let attempt = 0; attempt < 3; attempt++) {
      await rejectsReason(runtime.run(() => runtime.assertAllowed("https://8.8.8.8/private")), reason);
    }
    assert.equal(calls, 1, reason);
  }
});

test("research: an HTML robots response without markup is unknown and must never grant access", async () => {
  let calls = 0;
  const runtime = robotsRuntime(async () => { calls++; return response("Access denied", { contentType: "text/html" }); });
  await rejectsReason(runtime.run(() => runtime.assertAllowed(PAGE)), "robots_unavailable");
  await rejectsReason(runtime.run(() => runtime.assertAllowed(PAGE)), "robots_unavailable");
  assert.equal(calls, 1);
});

test("research: absent robots (404/410) allow reads and valid agent-specific rules are enforced", async () => {
  for (const status of [404, 410]) {
    let calls = 0;
    const runtime = robotsRuntime(async () => { calls++; return response("", { status }); });
    await runtime.run(() => runtime.assertAllowed(PAGE));
    await runtime.run(() => runtime.assertAllowed(`${PAGE}/second`));
    assert.equal(calls, 1);
  }
  const runtime = robotsRuntime(async () => response("User-agent: *\nAllow: /\n\nUser-agent: QQResearchBot\nDisallow: /private"));
  await rejectsReason(runtime.run(() => runtime.assertAllowed("https://8.8.8.8/private")), "robots_denied");
  await runtime.run(() => runtime.assertAllowed(PAGE));
});

test("research: concurrent robots checks share one lookup without bypassing a denial", async () => {
  let calls = 0;
  const gate = deferred<void>();
  const runtime = robotsRuntime(async () => { calls++; await gate.promise; return response("User-agent: *\nDisallow: /"); });
  const first = runtime.run(() => runtime.assertAllowed(PAGE));
  const second = runtime.run(() => runtime.assertAllowed(`${PAGE}/second`));
  const joined = Promise.allSettled([first, second]);
  await tick();
  assert.equal(calls, 1);
  gate.resolve();
  for (const result of await joined) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal((result.reason as WebAccessError).reason, "robots_denied");
  }
});

test("research: robots 429 honors Retry-After and retries only after the shared cooldown", async () => {
  let now = FIXED_TIME, calls = 0;
  const runtime = robotsRuntime(async () => {
    calls++;
    return calls === 1 ? response("", { status: 429, headers: new Headers({ "Retry-After": "120" }) }) : response();
  }, { now: () => now });
  await rejectsReason(runtime.run(() => runtime.assertAllowed(PAGE)), "rate_limit");
  now += 119_999;
  await rejectsReason(runtime.run(() => runtime.assertAllowed(PAGE)), "rate_limit");
  assert.equal(calls, 1);
  now += 1;
  await runtime.run(() => runtime.assertAllowed(PAGE));
  assert.equal(calls, 2);
  assert.equal(parseRetryAfter("120", FIXED_TIME), 120_000);
  assert.equal(parseRetryAfter(new Date(FIXED_TIME + 30_000).toUTCString(), FIXED_TIME), 30_000);
  assert.equal(parseRetryAfter("invalid", FIXED_TIME), MAX_COOLDOWN_TIMESTAMP);
  assert.equal(parseRetryAfter("999999999", FIXED_TIME), 999_999_999_000);
});

test("research: explicit site blocks run before robots or page requests", async () => {
  let requests = 0;
  const runtime = robotsRuntime(async () => { requests++; return response(); }, { blockedDomains: ["example.com"] });
  for (const url of ["https://example.com/page", "https://sub.example.com/page"]) {
    await rejectsReason(runtime.run(() => runtime.assertAllowed(url)), "site_policy");
  }
  assert.equal(requests, 0);
});

test("web-http: private, mapped, local, reserved and credential-bearing addresses are rejected before fetch", async t => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("must not fetch"); });
  const blocked = ["http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://10.1.2.3/",
    "http://169.254.169.254/", "http://100.64.0.1/", "http://192.168.1.1/", "http://172.16.0.1/",
    "http://192.0.2.1/", "http://198.51.100.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
    "http://[fe80::1]/", "http://[fd00::1]/", "http://[2001:db8::1]/", "http://[2002:0808:0808::1]/",
    "http://localhost/", "http://host.internal/", "http://user:password@8.8.8.8/", "file:///tmp/fixture",
    "http://8.8.8.8:8080/", "https://8.8.8.8/?api_key=fixture", "https://8.8.8.8/?access_token=fixture"];
  for (const url of blocked) {
    await rejectsReason(fetchPublic(url, { timeoutMs: 1_000, maxBytes: 1000 }), "invalid_url");
  }
  assert.equal(fetches, 0);
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("web-http: mixed public/private DNS results fail closed without opening a connection", async t => {
  t.mock.method(dns.promises, "lookup", async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; return new Response("not allowed"); });
  await rejectsReason(assertPublicUrl("https://fixture.example/guide"), "invalid_url");
  await rejectsReason(fetchPublic("https://fixture.example/guide", { timeoutMs: 1_000, maxBytes: 1000 }), "invalid_url");
  assert.equal(fetches, 0);
});

test("web-http: bounded streams retain at most maxBytes and cancel unread content", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("0123456789abcdef")); },
    cancel() { cancelled = true; },
  });
  const result = await readBounded(new Response(stream), 5);
  assert.equal(new TextDecoder().decode(result.bytes), "01234");
  assert.equal(result.bytes.byteLength, 5);
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
  assert.deepEqual(await readBounded(new Response("exact"), 5), { bytes: new TextEncoder().encode("exact"), truncated: false });
});

test("web-http: every redirect gets policy checks and a separate host lease", async t => {
  const policyChecks: string[] = [], leases: string[] = [], releases: string[] = [];
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit) => {
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal);
    fetches++;
    return fetches === 1 ? new Response("redirect", { status: 302, headers: { Location: "https://1.1.1.1/final" } })
      : new Response("public result", { headers: { "Content-Type": "text/plain" } });
  });
  const result = await fetchPublic(PAGE, { timeoutMs: 1_000, maxBytes: 1000,
    beforeRequest: async url => { policyChecks.push(url); },
    requestLease: async url => { leases.push(url); return () => { releases.push(url); }; },
  });
  assert.equal(result.finalUrl, "https://1.1.1.1/final");
  assert.equal(result.body, "public result");
  assert.deepEqual(policyChecks, [PAGE, "https://1.1.1.1/final"]);
  assert.deepEqual(leases, policyChecks);
  assert.deepEqual(releases, policyChecks);
});

test("web-http: redirects cannot cross into a private address or a robots-disallowed host", async t => {
  let fetches = 0;
  let target = "http://127.0.0.1/private";
  t.mock.method(globalThis, "fetch", async () => { fetches++; return new Response("redirect", { status: 302, headers: { Location: target } }); });
  await rejectsReason(fetchPublic(PAGE, { timeoutMs: 1_000, maxBytes: 1000 }), "invalid_url");
  assert.equal(fetches, 1);

  fetches = 0;
  target = "https://1.1.1.1/private";
  const robotOrigins: string[] = [];
  const runtime = robotsRuntime(async url => { robotOrigins.push(new URL(url).origin);
    return response(new URL(url).hostname === "1.1.1.1" ? "User-agent: *\nDisallow: /" : "User-agent: *\nAllow: /");
  });
  await rejectsReason(runtime.run(() => fetchPublic(PAGE, { timeoutMs: 1_000, maxBytes: 1000,
    beforeRequest: url => runtime.assertAllowed(url), requestLease: url => runtime.acquireHost(url),
  })), "robots_denied");
  assert.equal(fetches, 1);
  assert.deepEqual(robotOrigins, ["https://8.8.8.8", "https://1.1.1.1"]);
});

test("web-http: one deadline covers all redirects and policy waits", async t => {
  let fetches = 0, policyCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; return new Response("redirect", { status: 302, headers: { Location: "/next" } }); });
  await rejectsReason(fetchPublic(PAGE, { timeoutMs: 20, maxBytes: 1000, beforeRequest: async () => {
    policyCalls++;
    if (policyCalls === 2) await delay(40);
  } }), "timeout");
  assert.equal(fetches, 1);
  assert.equal(policyCalls, 2);
});

test("web-http: a host lease arriving after the request deadline is released instead of leaked", async t => {
  let fetches = 0, releases = 0;
  const lease = deferred<() => void>();
  t.mock.method(globalThis, "fetch", async () => { fetches++; return new Response("must not fetch"); });
  // A real runtime lease may outlive an individual reader timeout while waiting behind another request.
  const keepAlive = delay(40);
  await rejectsReason(fetchPublic(PAGE, { timeoutMs: 15, maxBytes: 1000, requestLease: () => lease.promise }), "timeout");
  lease.resolve(() => { releases++; });
  await tick();
  assert.equal(fetches, 0);
  assert.equal(releases, 1);
  await keepAlive;
});

test("research: host leases serialize active same-origin work while allowing another host", async () => {
  const runtime = new ResearchRuntime();
  await runtime.run(async () => {
    const releaseFirst = await runtime.acquireHost(PAGE);
    let acquiredSecond = false;
    const second = runtime.acquireHost(`${PAGE}/second`).then(release => { acquiredSecond = true; return release; });
    await tick();
    assert.equal(acquiredSecond, false);
    const releaseOtherHost = await runtime.acquireHost("https://1.1.1.1/page");
    assert.equal(acquiredSecond, false);
    releaseOtherHost();
    releaseFirst();
    const releaseSecond = await second;
    assert.equal(acquiredSecond, true);
    releaseSecond();
    releaseSecond();
    (await runtime.acquireHost(PAGE))();
  });
});

test("research: aborting a queued host lease neither bypasses the active lease nor deadlocks later work", async () => {
  const runtime = new ResearchRuntime();
  const releaseFirst = await runtime.withSession("first", () => runtime.acquireHost(PAGE));
  const abort = new AbortController();
  const second = runtime.withSession("second", () => runtime.acquireHost(PAGE), abort.signal);
  await tick();
  abort.abort();
  await rejectsReason(second, "timeout");
  let acquiredThird = false;
  const third = runtime.withSession("third", () => runtime.acquireHost(PAGE)).then(release => { acquiredThird = true; return release; });
  await tick();
  assert.equal(acquiredThird, false);
  releaseFirst();
  const releaseThird = await third;
  assert.equal(acquiredThird, true);
  releaseThird();
});
