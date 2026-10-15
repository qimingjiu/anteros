import { test } from "node:test";
import assert from "node:assert/strict";
import { PageReader, extractReadable, summarizePage, type ReaderOptions } from "../src/tools/reader.js";
import { ResearchRuntime, WebAccessError } from "../src/tools/research.js";
import type { PublicResponse } from "../src/tools/web-http.js";

const URL = "https://93.184.216.34/guide?lang=zh";
const FAQ = "<html><title>退款说明</title><nav>首页 登录 全部分类</nav><main><h1>多久退款？</h1><p>审核通过后，退款会在三个工作日到账。</p></main><footer>版权与导航</footer></html>";
const SHELL = "<html><title>Reference</title><body><div id='app'>Please enable JavaScript to continue.</div></body></html>";

function response(body: string, extra: Partial<PublicResponse> = {}): PublicResponse {
  return { body, finalUrl: URL, contentType: "text/html; charset=utf-8", status: 200, headers: new Headers(), truncated: false, ...extra };
}

function setup(body = FAQ, extra: Partial<ReaderOptions> = {}, output: Partial<PublicResponse> = {}) {
  let directRequests = 0;
  let robotsRequests = 0;
  const runtime = extra.runtime ?? new ResearchRuntime({
    perHostDelayMs: 0,
    publicFetch: async (_url, options) => { options.onRequest?.(); robotsRequests++; return response("User-agent: *\nAllow: /", { contentType: "text/plain" }); },
  });
  const transport: NonNullable<ReaderOptions["transport"]> = async (url, options) => {
    await options.beforeRequest?.(url);
    const release = await options.requestLease?.(url);
    try { directRequests++; return response(body, { finalUrl: url, ...output }); } finally { release?.(); }
  };
  const reader = new PageReader({ timeoutMs: 2000, maxBytes: 65536, maxChars: 4000, runtime, transport, ...extra });
  return { reader, runtime, directRequests: () => directRequests, robotsRequests: () => robotsRequests };
}

test("reader: DOM extraction preserves headings, code and the short official answer", () => {
  const page = extractReadable(FAQ.replace("</main>", "<pre><code>return 3 &lt; 4;</code></pre></main>"), 4000);
  assert.equal(page.title, "退款说明");
  assert.match(page.text, /三个工作日/);
  assert.match(page.text, /return 3 < 4/);
  assert.doesNotMatch(page.text, /全部分类|版权与导航/);
});

test("reader: short FAQ succeeds directly without rendering or cloud calls", async () => {
  let serviceCalls = 0;
  const { reader } = setup(FAQ, {
    crawl4aiUrl: "http://127.0.0.1:11235", firecrawlApiKey: "fixture-key",
    serviceFetch: async () => { serviceCalls++; throw new Error("must not render this answer"); },
  });
  const result = await reader.read(URL);
  assert.equal(result.status, "ok");
  assert.equal(result.provider, "http");
  assert.equal(result.quality?.reason, "short_answer");
  assert.equal(result.quality?.usable, true);
  assert.match(result.contentHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(serviceCalls, 0);
  assert.match(summarizePage(result), /三个工作日/);
});

test("reader: dynamic shell uses CPU extraction then one browser render", async () => {
  const calls: string[] = [];
  const { reader } = setup(SHELL, {
    crawl4aiUrl: "http://127.0.0.1:11235",
    serviceFetch: async (target, init) => {
      const endpoint = String(target);
      calls.push(endpoint);
      const input = JSON.parse(String(init?.body));
      assert.equal(input.url, URL);
      assert.ok(input.timeout_ms <= 2000);
      return Response.json(endpoint.endsWith("/extract")
        ? { text: "", extractor: "trafilatura", finalUrl: URL }
        : { text: "# Reference\n\nThe public documentation describes the complete configuration.", extractor: "trafilatura", finalUrl: URL });
    },
  });
  const result = await reader.read(URL);
  assert.equal(result.status, "ok");
  assert.equal(result.provider, "crawl4ai");
  assert.deepEqual(calls.map(value => value.split("/").pop()), ["extract", "render"]);
  assert.equal(result.attempts?.filter(value => value.action === "render").length, 1);
});

test("reader: HTTP 503 can use the renderer, without fetching HTML twice", async () => {
  const { reader, directRequests } = setup("Unavailable", {
    crawl4aiUrl: "http://127.0.0.1:11235",
    serviceFetch: async target => {
      assert.match(String(target), /\/render$/);
      return Response.json({ text: "This publicly accessible page now responds normally.", finalUrl: URL });
    },
  }, { status: 503 });
  const result = await reader.read(URL);
  assert.equal(result.provider, "crawl4ai");
  assert.equal(directRequests(), 1);
  assert.equal(result.attempts?.[0]?.httpStatus, 503);
});

for (const [status, expected] of [[401, "unauthorized"], [403, "forbidden"], [429, "rate_limited"]] as const) {
  test("reader: HTTP " + status + " stops instead of trying a different scraper", async () => {
    let calls = 0;
    const { reader } = setup("Denied", {
      crawl4aiUrl: "http://127.0.0.1:11235", firecrawlApiKey: "fixture-key",
      serviceFetch: async () => { calls++; throw new Error("unexpected fallback"); },
    }, { status });
    const result = await reader.read(URL);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, expected);
    assert.equal(result.text, "");
    assert.equal(calls, 0);
  });
}

for (const [reason, body] of [
  ["login_required", "<title>Sign in</title><main><h1>Account</h1><p>Sign in to continue.</p><input type='password'></main>"],
  ["paywall", "<title>News</title><main><h1>News report</h1><div class='paywall'>Subscribe to continue reading.</div></main>"],
  ["challenge", "<title>Security verification</title><main>Please verify you are human.</main><div class='cf-turnstile'></div>"],
] as const) {
  test("reader: HTTP 200 " + reason + " is a protected page and never rendered", async () => {
    let calls = 0;
    const { reader } = setup(body, {
      crawl4aiUrl: "http://127.0.0.1:11235", firecrawlApiKey: "fixture-key",
      serviceFetch: async () => { calls++; throw new Error("unexpected fallback"); },
    });
    const result = await reader.read(URL);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, reason);
    assert.equal(calls, 0);
  });
}

test("reader: robots denial happens before any page, renderer or cloud request", async () => {
  let direct = 0;
  let service = 0;
  const runtime = new ResearchRuntime({ publicFetch: async () => response("User-agent: *\nDisallow: /", { contentType: "text/plain" }) });
  const { reader } = setup(FAQ, {
    runtime, firecrawlApiKey: "fixture-key",
    transport: async () => { direct++; return response(FAQ); },
    serviceFetch: async () => { service++; return Response.json({}); },
  });
  const result = await reader.read(URL);
  assert.equal(result.reason, "robots_denied");
  assert.equal(direct, 0);
  assert.equal(service, 0);
});

test("reader: Firecrawl fallback reads cache only with TLS verification and no optional enrichment", async () => {
  let calls = 0;
  const { reader } = setup(SHELL, {
    firecrawlApiKey: "fixture-key",
    serviceFetch: async (target, init) => {
      calls++;
      assert.equal(String(target), "https://api.firecrawl.dev/v2/scrape");
      assert.equal(init?.redirect, "error");
      const input = JSON.parse(String(init?.body));
      assert.equal(input.proxy, "basic");
      assert.equal(input.minAge, 1);
      assert.equal(input.maxAge, 21_600_000);
      assert.equal(input.skipTlsVerification, false);
      assert.equal(input.onlyCleanContent, false);
      assert.deepEqual(input.parsers, []);
      assert.equal(input.actions, undefined);
      assert.equal(input.llm, undefined);
      assert.equal(input.enhanced, undefined);
      assert.equal(input.lockdown, undefined);
      assert.equal(input.storeInCache, false);
      return Response.json({ success: true, data: { markdown: "# Answer\n\nA concise answer taken from the public documentation.", metadata: { sourceURL: URL } } });
    },
  });
  const result = await reader.read(URL);
  assert.equal(result.provider, "firecrawl");
  assert.equal(result.status, "ok");
  assert.equal(result.remoteCacheOnly, true);
  assert.equal(result.sourceFetchedAt, null);
  assert.equal(calls, 1);
});

test("reader: cloud returned private redirect is rejected and never surfaced as content", async () => {
  const { reader } = setup(SHELL, {
    firecrawlApiKey: "fixture-key",
    serviceFetch: async () => Response.json({ success: true, data: { markdown: "PRIVATE DATA MUST NOT APPEAR", metadata: { sourceURL: "http://127.0.0.1/admin" } } }),
  });
  const result = await reader.read(URL);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "invalid_url");
  assert.equal(result.text, "");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE DATA/);
});

test("reader: same-scope in-flight pages merge, tracking params dedupe, semantic queries remain", async () => {
  const { reader, runtime, directRequests, robotsRequests } = setup();
  await runtime.withSession("conversation:A", async () => {
    const [one, two] = await Promise.all([reader.read(URL + "&utm_source=one"), reader.read(URL + "&utm_source=two")]);
    assert.equal(one.status, "ok");
    assert.equal(two.status, "ok");
    assert.equal(directRequests(), 1);
    assert.equal([one.cacheHit, two.cacheHit].filter(Boolean).length, 1);
    await reader.read(URL.replace("lang=zh", "lang=en"));
    assert.equal(directRequests(), 2);
  });
  assert.equal(robotsRequests(), 1);
  await runtime.withSession("conversation:B", async () => { await reader.read(URL); });
  assert.equal(directRequests(), 3);
});

test("reader: failures receive short negative caching, preserving the precise failure classification", async () => {
  let now = Date.now();
  const runtime = new ResearchRuntime({ now: () => now, perHostDelayMs: 0, publicFetch: async () => response("User-agent: *\nAllow: /", { contentType: "text/plain" }) });
  const { reader, directRequests } = setup("Denied", { runtime }, { status: 403 });
  await runtime.withSession("conversation:A", async () => {
    assert.equal((await reader.read(URL)).reason, "forbidden");
    const second = await reader.read(URL);
    assert.equal(second.reason, "forbidden");
    assert.equal(second.cacheHit, true);
    assert.equal(directRequests(), 1);
  });
  now += 61_000;
  await runtime.withSession("conversation:A", async () => { await reader.read(URL); });
  assert.equal(directRequests(), 2);
});

test("reader: runtime budget blocks rendering before any external service call", async () => {
  let calls = 0;
  const runtime = new ResearchRuntime({ limits: { maxBrowserRenders: 0 }, perHostDelayMs: 0, publicFetch: async () => response("User-agent: *\nAllow: /", { contentType: "text/plain" }) });
  const { reader } = setup(SHELL, {
    runtime, crawl4aiUrl: "http://127.0.0.1:11235",
    serviceFetch: async target => {
      if (String(target).endsWith("/render")) calls++;
      return Response.json({ text: "" });
    },
  });
  assert.equal((await reader.read(URL)).reason, "budget");
  assert.equal(calls, 0);
});

test("reader: one total deadline covers fetch and prevents later provider attempts", async () => {
  let services = 0;
  const { reader } = setup(SHELL, {
    timeoutMs: 5, firecrawlApiKey: "fixture-key",
    transport: async () => { await new Promise(resolve => setTimeout(resolve, 15)); return response(SHELL); },
    serviceFetch: async () => { services++; return Response.json({}); },
  });
  assert.equal((await reader.read(URL)).reason, "timeout");
  assert.equal(services, 0);
});

test("reader: service JSON is streamed with a hard size cap and the stream is cancelled", async () => {
  let cancelled = false;
  const { reader } = setup(SHELL, {
    maxBytes: 64, firecrawlApiKey: "fixture-key",
    serviceFetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(256))); },
      cancel() { cancelled = true; },
    })),
  });
  const result = await reader.read(URL);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "invalid_service_response");
  assert.equal(cancelled, true);
});

test("reader: network errors and malformed service bodies cannot leak URL, key or body text", async () => {
  const secret = "fixture-secret-never-log";
  const { reader } = setup(SHELL, {
    firecrawlApiKey: secret,
    transport: async () => { throw new Error("https://private.example/?key=" + secret); },
    serviceFetch: async () => new Response("SECRET RESPONSE BODY " + secret),
  });
  const result = await reader.read(URL);
  assert.equal(result.status, "failed");
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|SECRET RESPONSE BODY|private\.example/);
});

test("reader: unsupported binaries never enter browser or cloud fallback", async () => {
  let calls = 0;
  const { reader } = setup("%PDF", {
    firecrawlApiKey: "fixture-key", serviceFetch: async () => { calls++; return Response.json({}); },
  }, { contentType: "application/pdf" });
  assert.equal((await reader.read(URL)).reason, "unsupported_content");
  assert.equal(calls, 0);
});

test("reader: a renderer policy denial stops before Firecrawl", async () => {
  let cloud = 0;
  const { reader } = setup(SHELL, {
    crawl4aiUrl: "http://127.0.0.1:11235", firecrawlApiKey: "fixture-key",
    serviceFetch: async target => {
      if (String(target).includes("firecrawl")) cloud++;
      return Response.json(String(target).endsWith("/extract") ? { text: "" } : { text: "", reason: "robots_denied", finalUrl: URL });
    },
  });
  assert.equal((await reader.read(URL)).reason, "robots_denied");
  assert.equal(cloud, 0);
});

test("reader: public URL and mapped IPv6 restrictions fail without a network service", async () => {
  let calls = 0;
  const { reader } = setup(FAQ, { serviceFetch: async () => { calls++; throw new WebAccessError("network"); } });
  for (const address of ["http://user:pass@93.184.216.34/", "http://127.0.0.1/", "http://[::ffff:7f00:1]/"]) {
    const result = await reader.read(address);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "invalid_url");
  }
  assert.equal(calls, 0);
});

test("reader: browser child requests are conservatively reserved before rendering", async () => {
  let allocation = 0;
  const { reader, runtime } = setup(SHELL, {
    crawl4aiUrl: "http://127.0.0.1:11235",
    serviceFetch: async (target, init) => {
      if (String(target).endsWith("/extract")) return Response.json({ text: "" });
      allocation = JSON.parse(String(init?.body)).max_requests;
      return Response.json({ text: "The complete public answer is available after rendering.", finalUrl: URL });
    },
  });
  await runtime.withSession("budget", async () => {
    assert.equal((await reader.read(URL)).status, "ok");
    assert.equal(allocation, 12);
    assert.equal(runtime.session.used.browserRenders, 1);
    assert.equal(runtime.session.used.httpRequests, 15); // robots, direct fetch, gateway, 12 browser requests
  });
});

for (const reason of ["url_blocked", "dns_blocked", "cross_origin_blocked", "site_restricted", "redirect_blocked"] as const) {
  test("reader: sidecar " + reason + " cannot be sent to a different provider", async () => {
    let cloud = 0;
    const { reader } = setup(SHELL, {
      crawl4aiUrl: "http://127.0.0.1:11235", firecrawlApiKey: "fixture-key",
      serviceFetch: async target => {
        if (String(target).includes("firecrawl")) cloud++;
        return Response.json(String(target).endsWith("/extract") ? { text: "" } : { reason, status: "failed", finalUrl: URL });
      },
    });
    assert.equal((await reader.read(URL)).reason, reason);
    assert.equal(cloud, 0);
  });
}

test("reader: upstream HTTP 403 embedded in a 200 service envelope stops fallback", async () => {
  let cloud = 0;
  const { reader } = setup(SHELL, {
    crawl4aiUrl: "http://127.0.0.1:11235", firecrawlApiKey: "fixture-key",
    serviceFetch: async target => {
      if (String(target).includes("firecrawl")) cloud++;
      return Response.json(String(target).endsWith("/extract") ? { text: "" } : { httpStatus: 403, text: "Forbidden", finalUrl: URL });
    },
  });
  assert.equal((await reader.read(URL)).reason, "forbidden");
  assert.equal(cloud, 0);
});

test("reader: output budget applies to cache hits too", async () => {
  const runtime = new ResearchRuntime({
    limits: { maxOutputChars: 40 }, perHostDelayMs: 0,
    publicFetch: async () => response("User-agent: *\nAllow: /", { contentType: "text/plain" }),
  });
  const { reader, directRequests } = setup(FAQ, { runtime });
  await runtime.withSession("output", async () => {
    assert.equal((await reader.read(URL)).status, "ok");
    const second = await reader.read(URL);
    assert.equal(second.status, "failed");
    assert.equal(second.reason, "budget");
    assert.equal(second.text, "");
    assert.equal(directRequests(), 1);
  });
});

test("reader: provider credentials isolate caches without persisting their plaintext", async () => {
  const { reader: one, runtime, directRequests } = setup(FAQ, { firecrawlApiKey: "fixture-account-one" });
  const { reader: two, directRequests: secondRequests } = setup(FAQ, { runtime, firecrawlApiKey: "fixture-account-two" });
  await runtime.withSession("same-conversation", async () => {
    assert.equal((await one.read(URL)).cacheHit, false);
    assert.equal((await two.read(URL)).cacheHit, false);
  });
  assert.equal(directRequests(), 1);
  assert.equal(secondRequests(), 1);
});

test("reader: an active paywall stops access even when full text is embedded in HTML", async () => {
  let services = 0;
  const body = "<title>News</title><article><h1>Report</h1><p>" + "Embedded article paragraph. ".repeat(80) + "</p></article><div class='paywall'>Subscription required</div>";
  const { reader } = setup(body, { firecrawlApiKey: "fixture-key", serviceFetch: async () => { services++; return Response.json({}); } });
  const result = await reader.read(URL);
  assert.equal(result.reason, "paywall");
  assert.equal(result.text, "");
  assert.equal(services, 0);
});

test("reader: remote cache miss stops after one attempt without a fresh scrape retry", async () => {
  const inputs: Record<string, unknown>[] = [];
  const { reader } = setup(SHELL, {
    firecrawlApiKey: "fixture-key",
    serviceFetch: async (_target, init) => {
      inputs.push(JSON.parse(String(init?.body)));
      return Response.json({ success: false, code: "SCRAPE_NO_CACHED_DATA", error: "fixture upstream body" }, { status: 404 });
    },
  });
  const result = await reader.read(URL);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "remote_cache_miss");
  assert.equal(result.text, "");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.minAge, 1);
  assert.equal(result.attempts?.filter(value => value.provider === "firecrawl").length, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture upstream body/);
});

test("reader: a cached cloud copy with a login gate is rejected too", async () => {
  let calls = 0;
  const { reader } = setup(SHELL, {
    firecrawlApiKey: "fixture-key",
    serviceFetch: async (_target, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).minAge, 1);
      return Response.json({ success: true, data: {
        markdown: "Sign in to continue reading.",
        metadata: { title: "Sign in", sourceURL: URL, statusCode: 200 },
      } });
    },
  });
  const result = await reader.read(URL);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "login_required");
  assert.equal(result.text, "");
  assert.equal(calls, 1);
});

for (const directive of ["noai", "NOARCHIVE", "max-snippet: 50, nosnippet", "QQResearchBot: noai, noindex"]) {
  test("reader: X-Robots-Tag " + directive + " stops before extraction fallback", async () => {
    let services = 0;
    const { reader } = setup(FAQ, {
      crawl4aiUrl: "http://127.0.0.1:11235", firecrawlApiKey: "fixture-key",
      serviceFetch: async () => { services++; return Response.json({}); },
    }, { headers: new Headers({ "X-Robots-Tag": directive }) });
    const result = await reader.read(URL);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "site_policy");
    assert.equal(result.text, "");
    assert.equal(services, 0);
  });
}

for (const [name, directive] of [["robots", "noarchive"], ["QQResearchBot", "noai"], ["RoBoTs", "index, nosnippet, follow"]]) {
  test("reader: explicit meta " + name + " content " + directive + " stops access", async () => {
    let services = 0;
    const { reader } = setup('<meta name="' + name + '" content="' + directive + '">' + FAQ, {
      firecrawlApiKey: "fixture-key", serviceFetch: async () => { services++; return Response.json({}); },
    });
    const result = await reader.read(URL);
    assert.equal(result.reason, "site_policy");
    assert.equal(result.text, "");
    assert.equal(services, 0);
  });
}

test("reader: article mentions and unrelated meta keywords do not become robots directives", async () => {
  const body = '<meta name="keywords" content="noai, noarchive, nosnippet">' + FAQ.replace("</main>", "<p>The noai, noarchive and nosnippet tokens are described in this public guide.</p></main>");
  const { reader } = setup(body, {}, { headers: new Headers({ "x-robots-tag": "noindex, nofollow, max-snippet:50" }) });
  const result = await reader.read(URL);
  assert.equal(result.status, "ok");
  assert.match(result.text, /noarchive/);
});

test("reader: nested DOM has a fixed structural cap and cannot trigger expensive fallbacks", async () => {
  let services = 0;
  const { reader } = setup("<div>".repeat(150) + "A public answer." + "</div>".repeat(150), {
    firecrawlApiKey: "fixture-key", serviceFetch: async () => { services++; return Response.json({}); },
  });
  const result = await reader.read(URL);
  assert.equal(result.reason, "dom_limit");
  assert.equal(result.text, "");
  assert.equal(services, 0);
});

test("reader: sidecar rate limit with an empty final URL cools down later reads before HTTP or cloud", async () => {
  let now = Date.now();
  let cloud = 0;
  let serviceCalls = 0;
  const runtime = new ResearchRuntime({
    now: () => now, perHostDelayMs: 0,
    publicFetch: async () => response("User-agent: *\nAllow: /", { contentType: "text/plain" }),
  });
  const { reader, directRequests } = setup(SHELL, {
    runtime, crawl4aiUrl: "http://127.0.0.1:11235", firecrawlApiKey: "fixture-key",
    serviceFetch: async target => {
      serviceCalls++;
      if (String(target).includes("firecrawl")) cloud++;
      return Response.json(String(target).endsWith("/extract") ? { text: "" }
        : { status: "failed", reason: "rate_limited", finalUrl: "", retryAfterMs: 5000 });
    },
  });
  assert.equal((await reader.read(URL)).reason, "rate_limited");
  now += 4999;
  assert.equal((await reader.read(URL + "&another=1")).reason, "rate_limit");
  assert.equal(directRequests(), 1);
  assert.equal(serviceCalls, 2);
  assert.equal(cloud, 0);
  now++;
  await runtime.withSession("after-cooldown", async () => {
    assert.ok(await runtime.assertAllowed(URL, { countRequest: false }));
  });
});

for (const retryAfterMs of [-1, Number.MAX_SAFE_INTEGER + 1, "5000", null]) {
  test("reader: malformed sidecar retryAfterMs " + String(retryAfterMs) + " fails closed instead of retrying early", async () => {
    let now = Date.now();
    const runtime = new ResearchRuntime({
      now: () => now, perHostDelayMs: 0,
      publicFetch: async () => response("User-agent: *\nAllow: /", { contentType: "text/plain" }),
    });
    const { reader, directRequests } = setup(SHELL, {
      runtime, crawl4aiUrl: "http://127.0.0.1:11235",
      serviceFetch: async target => Response.json(String(target).endsWith("/extract") ? { text: "" }
        : { status: "failed", httpStatus: 429, finalUrl: "", retryAfterMs }),
    });
    assert.equal((await reader.read(URL)).reason, "rate_limited");
    now += 60_001;
    assert.equal((await reader.read(URL + "&later=1")).reason, "rate_limit");
    assert.equal(directRequests(), 1);
    now += 365 * 86_400_000;
    assert.equal((await reader.read(URL + "&later=2")).reason, "rate_limit");
    assert.equal(directRequests(), 1);
  });
}

for (const retryAfterMs of [172_800_000, 365 * 86_400_000, 1e15]) {
  test("reader: long sidecar retryAfterMs " + retryAfterMs + " is retained until its full deadline", async () => {
    let now = Date.now();
    const runtime = new ResearchRuntime({
      now: () => now, perHostDelayMs: 0,
      publicFetch: async () => response("User-agent: *\nAllow: /", { contentType: "text/plain" }),
    });
    const { reader, directRequests } = setup(SHELL, {
      runtime, crawl4aiUrl: "http://127.0.0.1:11235",
      serviceFetch: async target => Response.json(String(target).endsWith("/extract") ? { text: "" }
        : { status: "failed", reason: "rate_limited", finalUrl: "", retryAfterMs }),
    });
    assert.equal((await reader.read(URL)).reason, "rate_limited");
    now += retryAfterMs - 1;
    assert.equal((await reader.read(URL + "&before-deadline=1")).reason, "rate_limit");
    assert.equal(directRequests(), 1);
    now++;
    await runtime.withSession("full-delay-elapsed", async () => {
      assert.ok(await runtime.assertAllowed(URL, { countRequest: false }));
    });
  });
}

for (const reason of ["robots_denied", "robots_unavailable", "site_restricted", "cross_origin_blocked", "redirect_blocked"]) {
  test("reader: terminal " + reason + " survives an empty returned URL and never invokes cloud", async () => {
    let cloud = 0;
    const { reader } = setup(SHELL, {
      crawl4aiUrl: "http://127.0.0.1:11235", firecrawlApiKey: "fixture-key",
      serviceFetch: async target => {
        if (String(target).includes("firecrawl")) cloud++;
        return Response.json(String(target).endsWith("/extract") ? { text: "" } : { status: "failed", reason, finalUrl: "" });
      },
    });
    assert.equal((await reader.read(URL)).reason, reason);
    assert.equal(cloud, 0);
  });
}

for (const status of [403, 404, 429, 503]) {
  test("reader: service HTTP " + status + " cancels its response body before returning a fixed error", async () => {
    let cancelled = false;
    const { reader } = setup(SHELL, {
      firecrawlApiKey: "fixture-key",
      serviceFetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("untrusted upstream error must not leak")); },
        cancel() { cancelled = true; },
      }), { status }),
    });
    const result = await reader.read(URL);
    assert.equal(result.status, "failed");
    assert.equal(cancelled, true);
    assert.doesNotMatch(JSON.stringify(result), /untrusted upstream error/);
  });
}

test("reader: cloud metadata HTTP 429 applies host cooldown across subsequent reads", async () => {
  let cloudCalls = 0;
  const { reader, directRequests } = setup(SHELL, {
    firecrawlApiKey: "fixture-key",
    serviceFetch: async () => {
      cloudCalls++;
      return Response.json({ success: true, data: { markdown: "", metadata: { sourceURL: URL, statusCode: 429 } } });
    },
  });
  assert.equal((await reader.read(URL)).reason, "rate_limited");
  assert.equal((await reader.read(URL + "&later=1")).reason, "rate_limit");
  assert.equal(cloudCalls, 1);
  assert.equal(directRequests(), 1);
});

test("reader: an otherwise successful renderer normalizes an empty returned URL to the validated original", async () => {
  const { reader } = setup(SHELL, {
    crawl4aiUrl: "http://127.0.0.1:11235",
    serviceFetch: async target => Response.json(String(target).endsWith("/extract") ? { text: "" }
      : { text: "The complete public answer is available after rendering.", finalUrl: "" }),
  });
  const result = await reader.read(URL);
  assert.equal(result.status, "ok");
  assert.equal(result.finalUrl, URL);
});
