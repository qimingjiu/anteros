import { test } from "node:test";
import assert from "node:assert/strict";
import { createSearchBackend, normalizeSearchUrl, SearchBackendError } from "../src/tools/search-providers.js";
import { createSearchProvider } from "../src/tools/search.js";
import { ResearchRuntime, WebAccessError } from "../src/tools/research.js";

const fixtureKey = "fixture-search-credential-never-log";
const signal = () => AbortSignal.timeout(2_000);
const result = (url = "https://example.com/guide") => ({ title: "Official guide", url, content: "Search snippet" });

function config(overrides: Record<string, unknown> = {}) {
  return { provider: "searxng", searxngUrl: "http://127.0.0.1:8888/", tavilyApiKey: fixtureKey,
    exaApiKey: fixtureKey, googleCse: { apiKey: fixtureKey, cx: "fixture-cx" },
    maxResults: 5, timeoutMs: 2_000, cacheTtlMs: 60_000, ...overrides };
}

test("SearXNG：使用 JSON POST API、规范化去重结果并保留来源", async () => {
  const backend = createSearchBackend("searxng", { searxngUrl: "http://127.0.0.1:8888/prefix/" }, async (input, init) => {
    assert.equal(String(input), "http://127.0.0.1:8888/prefix/search");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("q"), "中文搜索");
    assert.equal(body.get("format"), "json");
    assert.equal(body.get("pageno"), "1");
    return Response.json({ results: [result("https://example.com/guide?utm_source=fixture#section"),
      result("https://example.com/guide"), result("http://127.0.0.1/private"),
      result("file:///private"), result("https://user:password@example.com/private"),
      { title: 123, url: "https://example.com/second", content: "s".repeat(500) }] });
  })!;
  const results = await backend.search("中文搜索", 5, signal());
  assert.deepEqual(results.map(r => [r.url, r.source]), [
    ["https://example.com/guide", "searxng"], ["https://example.com/second", "searxng"],
  ]);
  assert.equal(results[1]!.title, "");
  assert.equal(results[1]!.snippet.length, 400);
});

test("搜索结果：过滤数字化/IPv6 内网地址和本地域名，保留公开地址", () => {
  for (const url of ["http://2130706433/", "http://0x7f000001/", "http://10.1.2.3/",
    "http://100.64.1.1/", "http://169.254.169.254/", "http://172.31.2.3/", "http://192.168.1.1/",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fc00::1]/", "http://[fe80::1]/",
    "http://localhost./", "http://host.local/", "http://internal/", "javascript:alert(1)"]) {
    assert.equal(normalizeSearchUrl(url), null, url);
  }
  assert.equal(normalizeSearchUrl("https://example.com/path?q=one&utm_campaign=fixture#part"), "https://example.com/path?q=one");
  assert.equal(normalizeSearchUrl("https://example.com/app#/route"), "https://example.com/app#/route");
  assert.equal(normalizeSearchUrl("https://example.com/app#!/route"), "https://example.com/app#!/route");
  assert.equal(normalizeSearchUrl("https://[2606:4700:4700::1111]/"), "https://[2606:4700:4700::1111]/");
});

test("Exa：官方 Search 请求不携带 contents/自动抓取或研究参数，最多 10 条", async () => {
  const backend = createSearchBackend("exa", { exaApiKey: fixtureKey }, async (input, init) => {
    assert.equal(String(input), "https://api.exa.ai/search");
    assert.equal(new Headers(init?.headers).get("x-api-key"), fixtureKey);
    assert.deepEqual(JSON.parse(String(init?.body)), { query: "fixture query", type: "auto", numResults: 10 });
    return Response.json({ results: [{ title: "Exa metadata", url: "https://example.com/exa", text: "not requested full text",
      highlights: ["not requested highlight"], publishedDate: "2026-10-15T00:00:00Z" }] });
  })!;
  assert.deepEqual(await backend.search("fixture query", 100, signal()), [
    { title: "Exa metadata", url: "https://example.com/exa", snippet: "", source: "exa" },
  ]);
});

test("Tavily：固定 basic 搜索且禁用自动深度、原始正文与答案生成", async () => {
  const backend = createSearchBackend("tavily", { tavilyApiKey: fixtureKey }, async (input, init) => {
    assert.equal(String(input), "https://api.tavily.com/search");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${fixtureKey}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { query: "fixture", max_results: 3, search_depth: "basic",
      auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false });
    return Response.json({ results: [result()] });
  })!;
  assert.equal((await backend.search("fixture", 3, signal()))[0]!.source, "tavily");
});

test("Google CSE：兼容原有 key/cx 和 items 结果格式", async () => {
  const backend = createSearchBackend("google_cse", { googleCse: { apiKey: fixtureKey, cx: "fixture-cx" } }, async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("key"), fixtureKey);
    assert.equal(url.searchParams.get("cx"), "fixture-cx");
    assert.equal(url.searchParams.get("num"), "10");
    return Response.json({ items: [{ title: "Google result", link: "https://example.com/google", snippet: "Description" }] });
  })!;
  assert.deepEqual(await backend.search("fixture", 50, signal()), [
    { title: "Google result", url: "https://example.com/google", snippet: "Description", source: "google_cse" },
  ]);
});

test("搜索错误：HTTP、网络及非法 JSON 不暴露响应正文、密钥或查询", async () => {
  const secretQuery = "fixture-private-query-never-log";
  const fetchers: (typeof fetch)[] = [
    async () => new Response(`${fixtureKey} ${secretQuery}`, { status: 401 }),
    async () => { throw new Error(`https://example.com?key=${fixtureKey}&q=${secretQuery}`); },
    async () => new Response(`{invalid ${fixtureKey} ${secretQuery}`),
    async () => Response.json({ error: `${fixtureKey} ${secretQuery}` }),
  ];
  for (const fetcher of fetchers) {
    const backend = createSearchBackend("exa", { exaApiKey: fixtureKey }, fetcher)!;
    await assert.rejects(backend.search(secretQuery, 5, signal()), error => {
      assert.ok(error instanceof SearchBackendError);
      assert.equal(`${error.message} ${error.stack}`.includes(fixtureKey), false);
      assert.equal(`${error.message} ${error.stack}`.includes(secretQuery), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("搜索响应：限制声明体积及实际流式读取体积", async () => {
  for (const fetcher of [
    async () => new Response("small", { headers: { "Content-Length": "2000000" } }),
    async () => new Response("x".repeat(1_048_577)),
  ]) {
    const backend = createSearchBackend("tavily", { tavilyApiKey: fixtureKey }, fetcher)!;
    await assert.rejects(backend.search("fixture", 5, signal()), { code: "invalid_response" });
  }
});

test("搜索备用：SearXNG 空结果后切换显式 Tavily，后端成功即停止", async () => {
  const calls: string[] = [];
  const provider = createSearchProvider(config({ fallbackProviders: ["tavily", "exa"] }), new ResearchRuntime(), async input => {
    calls.push(new URL(String(input)).hostname);
    return Response.json({ results: calls.length === 1 ? [] : [result()] });
  })!;
  assert.equal((await provider.search("fixture fallback", 5))[0]!.source, "tavily");
  assert.deepEqual(calls, ["127.0.0.1", "api.tavily.com"]);
});

test("搜索补充：默认少于 2 条时仅补搜一次，合并去重且保留各自来源", async () => {
  const calls: string[] = [];
  const provider = createSearchProvider(config({ fallbackProviders: ["tavily", "exa"] }), new ResearchRuntime(), async input => {
    calls.push(new URL(String(input)).hostname);
    return Response.json({ results: calls.length === 1 ? [result()] : [result("https://example.com/guide?utm_source=duplicate"),
      result("https://example.com/second"), result("https://example.com/third"), result("https://example.com/fourth")] });
  })!;
  const results = await provider.search("fixture supplement", 3);
  assert.deepEqual(results.map(item => [item.url, item.source]), [
    ["https://example.com/guide", "searxng"], ["https://example.com/second", "tavily"], ["https://example.com/third", "tavily"],
  ]);
  assert.deepEqual(calls, ["127.0.0.1", "api.tavily.com"]);
});

test("搜索补充：自定义最少条数与仅请求 1 条时均不会额外补搜", async () => {
  for (const [settings, count] of [[{ minResultsBeforeFallback: 1 }, 5], [{}, 1]] as const) {
    let calls = 0;
    const provider = createSearchProvider(config({ ...settings, fallbackProviders: ["tavily"] }), new ResearchRuntime(), async () => {
      calls++;
      return Response.json({ results: [result()] });
    })!;
    assert.equal((await provider.search("fixture enough for requested count", count)).length, 1);
    assert.equal(calls, 1);
  }
});

test("搜索补充：备用失败保留已有材料，并记下安全故障类别", async () => {
  const runtime = new ResearchRuntime();
  const calls: string[] = [];
  const provider = createSearchProvider(config({ fallbackProviders: ["tavily", "exa"] }), runtime, async input => {
    calls.push(new URL(String(input)).hostname);
    return calls.length === 1 ? Response.json({ results: [result()] })
      : new Response(`${fixtureKey} private upstream body`, { status: 503 });
  })!;
  assert.deepEqual(await provider.search("fixture retain partial evidence", 5), [
    { title: "Official guide", url: "https://example.com/guide", snippet: "Search snippet", source: "searxng" },
  ]);
  assert.equal(runtime.status().lastFailure?.reason, "upstream_error");
  assert.equal(runtime.status().lastFailure?.provider, "tavily");
  assert.deepEqual(calls, ["127.0.0.1", "api.tavily.com"]);
});

test("搜索补充：跳过本地日/月配额已耗尽的备用，选 Exa 且不请求 Tavily", async () => {
  const runtime = new ResearchRuntime({ quotas: { tavily: { daily: 0, monthly: 0 } } });
  const calls: string[] = [];
  const provider = createSearchProvider(config({ fallbackProviders: ["tavily", "exa"] }), runtime, async input => {
    calls.push(new URL(String(input)).hostname);
    return Response.json({ results: [result(calls.length === 1 ? "https://example.com/primary" : "https://example.com/backup")] });
  })!;
  assert.deepEqual((await provider.search("fixture quota aware supplement", 5)).map(item => item.source), ["searxng", "exa"]);
  assert.deepEqual(calls, ["127.0.0.1", "api.exa.ai"]);
  assert.equal(runtime.status().quotas.tavily?.dailyUsed, 0);
});

test("搜索补充：全局请求预算耗尽后保留已有材料，不发出备用请求", async () => {
  const runtime = new ResearchRuntime({ limits: { maxSearchRequests: 1 } });
  let calls = 0;
  const provider = createSearchProvider(config({ fallbackProviders: ["tavily", "exa"] }), runtime, async () => {
    calls++;
    return Response.json({ results: [result()] });
  })!;
  const results = await provider.search("fixture partial budget stop", 5);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.source, "searxng");
  assert.equal(runtime.status().lastFailure?.reason, "budget");
  assert.equal(calls, 1);
});

test("搜索备用：首个备用失败后不继续消耗第三家额度，错误保持固定", async () => {
  const calls: string[] = [];
  const provider = createSearchProvider(config({ fallbackProviders: ["tavily", "exa"] }), new ResearchRuntime(), async input => {
    calls.push(new URL(String(input)).hostname);
    return new Response(`${fixtureKey} private body`, { status: 503 });
  })!;
  await assert.rejects(provider.search("fixture failed fallback", 5), error => {
    assert.ok(error instanceof WebAccessError);
    assert.equal(String(error).includes(fixtureKey), false);
    assert.equal(String(error).includes("private body"), false);
    return true;
  });
  assert.deepEqual(calls, ["127.0.0.1", "api.tavily.com"]);
});

test("搜索备用：无显式备用时不自动启用带凭据的云后端", async () => {
  let calls = 0;
  const provider = createSearchProvider(config(), new ResearchRuntime(), async () => {
    calls++;
    return new Response("private failure", { status: 503 });
  })!;
  await assert.rejects(provider.search("fixture no automatic fallback", 5), WebAccessError);
  assert.equal(calls, 1);
});

test("搜索预算：全局预算停止不会切换供应商或发起网络请求", async () => {
  const runtime = new ResearchRuntime();
  runtime.beforeProvider = () => { throw new WebAccessError("budget", { fallbackAllowed: false }); };
  let calls = 0;
  const provider = createSearchProvider(config({ fallbackProviders: ["tavily", "exa"] }), runtime, async () => {
    calls++;
    return Response.json({ results: [result()] });
  })!;
  await assert.rejects(provider.search("fixture budget stop", 5), WebAccessError);
  assert.equal(calls, 0);
});

test("搜索预算：单家配额耗尽可换一次备用，缺失凭据的备用不被请求", async () => {
  const runtime = new ResearchRuntime();
  const reserve = runtime.beforeProvider.bind(runtime);
  const attempted: string[] = [];
  runtime.beforeProvider = (provider, operation) => {
    attempted.push(provider);
    if (provider === "searxng") throw new WebAccessError("quota", { fallbackAllowed: true });
    reserve(provider, operation);
  };
  const calls: string[] = [];
  const provider = createSearchProvider(config({ tavilyApiKey: "", fallbackProviders: ["tavily", "exa"] }), runtime, async input => {
    calls.push(new URL(String(input)).hostname);
    return Response.json({ results: [result()] });
  })!;
  assert.equal((await provider.search("fixture single provider quota", 5))[0]!.source, "exa");
  assert.deepEqual(attempted, ["searxng", "exa"]);
  assert.deepEqual(calls, ["api.exa.ai"]);
});

test("搜索缓存：重复规范化查询只请求一次，并隔离调用方对结果的修改", async () => {
  let calls = 0;
  const runtime = new ResearchRuntime();
  const provider = createSearchProvider(config(), runtime, async () => {
    calls++;
    return Response.json({ results: [result()] });
  })!;
  await runtime.withSession("fixture-account:fixture-conversation", async () => {
    const first = await provider.search("  fixture   cache  ", 5);
    first[0]!.title = "mutated by caller";
    const second = await provider.search("fixture cache", 5);
    assert.equal(calls, 1);
    assert.equal(second[0]!.title, "Official guide");
    assert.ok(provider.getReceipt?.());
  });
  // A second conversation must not observe the first conversation's cached search.
  await runtime.withSession("fixture-account:another-conversation", () => provider.search("fixture cache", 5));
  assert.equal(calls, 2);
});

test("搜索配置：旧提供商仍可用，none 与缺失凭据不会发请求", () => {
  assert.equal(createSearchProvider(config({ provider: "none" })), null);
  assert.equal(createSearchProvider(config({ provider: "exa", exaApiKey: "" })), null);
  assert.equal(createSearchProvider(config({ provider: "tavily" }))!.name, "tavily");
  assert.equal(createSearchProvider(config({ provider: "google_cse" }))!.name, "google_cse");
});
