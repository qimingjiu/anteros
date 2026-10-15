import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { GroupReplyJudge } from "../src/agent/group-reply-judge.js";
import type { GroupReplyJudgeConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import type { MessageRecord } from "../src/types.js";

const START = Date.parse("2026-10-13T00:00:00Z");
const decision = (reply = true, confidence = 0.95, targetMessageId = "1") => ({ reply, targetMessageId, confidence });
const envelope = (content: unknown = JSON.stringify(decision()), finishReason = "stop", extra: Record<string, unknown> = {}) => ({
  choices: [{ finish_reason: finishReason, message: { content, ...extra } }],
});
const response = (body: unknown = envelope(), status = 200) => new Response(JSON.stringify(body), { status });
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function fixture(t: TestContext, steps: (Response | Error | (() => Response | Promise<Response>))[], patch: Partial<GroupReplyJudgeConfig> = {}) {
  const db = new Database(":memory:");
  const cfg: GroupReplyJudgeConfig = {
    enabled: true, baseUrl: "https://primary.test/v1///", apiKey: "primary-fixture-key", model: "ling-3.1-flash",
    debounceMs: 0, minIntervalMs: 0, cooldownMs: 0, requestTimeoutMs: 8000,
    maxTokens: 512, maxContextMessages: 12, maxContextChars: 2400, confidenceThreshold: 0.9,
    thinking: "disabled", jsonMode: false,
    fallback: { baseUrl: "https://fallback.test/v4///", apiKey: "fallback-fixture-key", model: "glm-4.5-air", maxTokens: 128,
      thinking: "disabled", jsonMode: true },
    ...patch,
  };
  const calls: { url: string; init: RequestInit; body: Record<string, any> }[] = [];
  const fetcher = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init?.body)) });
    const next = steps.shift();
    if (!next) throw new Error("unexpected extra judging request");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? await next() : next;
  }) as typeof fetch;
  const judge = new GroupReplyJudge(cfg, db, () => "bot", "κόραξ", { fetch: fetcher, now: () => START, wait: async () => {} });
  t.after(() => { judge.stop(); db.close(); });
  const message = (messageId = "1"): MessageRecord => ({
    eventKey: `acct:group_100:${messageId}`, accountId: "acct", providerId: "onebot", conversationId: "group_100",
    groupId: "100", messageId, senderId: "ordinary-user", displayNameAtTime: "群友",
    sentAt: new Date(START).toISOString(), receivedAt: new Date(START).toISOString(),
    textContent: "κόραξ，你刚才说的意思是什么？", segments: [], status: "active", origin: "live",
  });
  return { judge, calls, message };
}

test("接话兜底：有效拒绝和低置信度结果不能通过第二个模型翻案", async t => {
  for (const result of [decision(false, 1), decision(true, 0.89), decision(false, 0)]) {
    const f = fixture(t, [response(envelope(JSON.stringify(result))), response()]);
    assert.equal(await f.judge.shouldReply(f.message()), false);
    assert.equal(f.calls.length, 1);
  }
});

test("接话兜底：主模型有效批准时不调用兜底", async t => {
  const f = fixture(t, [response(), response()]);
  assert.equal(await f.judge.shouldReply(f.message()), true);
  assert.equal(f.calls.length, 1);
});

test("接话兜底：主模型429后使用独立端点和密钥，同一上下文及取消预算且无工具", async t => {
  const f = fixture(t, [response({ error: "rate limited" }, 429), response()]);
  const message = f.message();
  assert.equal(await f.judge.shouldReply(message), true);
  assert.equal(f.calls.length, 2);
  const [primary, fallback] = f.calls;
  assert.equal(primary!.url, "https://primary.test/v1/chat/completions");
  assert.equal(fallback!.url, "https://fallback.test/v4/chat/completions");
  assert.equal(new Headers(primary!.init.headers).get("authorization"), "Bearer primary-fixture-key");
  assert.equal(new Headers(fallback!.init.headers).get("authorization"), "Bearer fallback-fixture-key");
  assert.equal(primary!.body.model, "ling-3.1-flash");
  assert.equal(fallback!.body.model, "glm-4.5-air");
  assert.equal(primary!.body.max_tokens, 512);
  assert.equal(fallback!.body.max_tokens, 128);
  assert.equal(primary!.body.response_format, undefined);
  assert.deepEqual(fallback!.body.response_format, { type: "json_object" });
  assert.deepEqual(fallback!.body.thinking, { type: "disabled" });
  assert.deepEqual(primary!.body.messages, fallback!.body.messages);
  assert.equal(primary!.init.signal, fallback!.init.signal);
  assert.ok(fallback!.body.messages[1].content.endsWith(f.judge.contextFor(message)));
  assert.ok(f.calls.every(call => call.body.tools === undefined && call.body.tool_choice === undefined));
});

test("接话兜底：主模型正文畸形、截断或擅自调用工具时才允许兜底", async t => {
  const failures = [
    response(envelope("不是判断JSON")),
    response(envelope(JSON.stringify(decision()), "length")),
    response(envelope(JSON.stringify(decision()), "tool_calls", { tool_calls: [{ function: { name: "unsafe" } }] })),
    response(envelope(JSON.stringify({ ...decision(), reason: "unexpected field" }))),
    new Response("not even an envelope"),
    new Error("fixture transport failure"),
  ];
  for (const failure of failures) {
    const f = fixture(t, [failure, response()]);
    assert.equal(await f.judge.shouldReply(f.message()), true);
    assert.equal(f.calls.length, 2);
  }
});

test("接话兜底：兜底也失败、拒绝或低置信度时保持安静，不递归重试", async t => {
  const failures = [
    response({ error: "unavailable" }, 503), response(envelope("malformed")),
    response(envelope(JSON.stringify(decision(false, 0)))),
    response(envelope(JSON.stringify(decision(true, 0.89)))),
    response(envelope(JSON.stringify(decision(true, 0.99, "wrong-message")))),
    new Error("fallback transport failure"),
  ];
  for (const fallback of failures) {
    const f = fixture(t, [response({}, 429), fallback]);
    assert.equal(await f.judge.shouldReply(f.message()), false);
    assert.equal(f.calls.length, 2);
  }
});

test("接话兜底：未配置兜底或缺少其密钥时只进行主判断", async t => {
  for (const fallback of [undefined, { baseUrl: "https://fallback.test", apiKey: "", model: "glm-4.5-air", maxTokens: 128 }]) {
    const f = fixture(t, [response({}, 429), response()], { fallback });
    assert.equal(await f.judge.shouldReply(f.message()), false);
    assert.equal(f.calls.length, 1);
  }
});

test("接话兜底：主模型耗时占用总预算，兜底只能用剩下的一秒", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finishPrimary!: (response: Response) => void;
  const f = fixture(t, [
    () => new Promise<Response>(resolve => { finishPrimary = resolve; }),
    () => new Promise<Response>(() => {}),
  ]);
  const pending = f.judge.shouldReply(f.message());
  await flush();
  t.mock.timers.tick(7000);
  finishPrimary(response({}, 429));
  await flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.init.signal, f.calls[1]!.init.signal);
  t.mock.timers.tick(999);
  assert.equal(f.calls[1]!.init.signal!.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(await pending, false);
  assert.equal(f.calls[1]!.init.signal!.aborted, true, "不能给兜底新的八秒预算");
});

test("接话兜底：总预算已经耗尽时，即使主模型后来失败也不请求兜底", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finishPrimary!: (response: Response) => void;
  const f = fixture(t, [() => new Promise<Response>(resolve => { finishPrimary = resolve; }), response()]);
  const pending = f.judge.shouldReply(f.message());
  await flush();
  t.mock.timers.tick(8000);
  assert.equal(await pending, false);
  finishPrimary(response({}, 429));
  await flush();
  assert.equal(f.calls.length, 1);
});

test("接话兜底：判断作废后不允许因迟到的主模型故障再启动兜底", async t => {
  let finishPrimary!: (response: Response) => void;
  const f = fixture(t, [() => new Promise<Response>(resolve => { finishPrimary = resolve; }), response()]);
  const pending = f.judge.shouldReply(f.message());
  await flush();
  f.judge.invalidate("acct", "group_100");
  assert.equal(await pending, false);
  finishPrimary(response({}, 429));
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.init.signal!.aborted, true);
});

test("接话兜底：兜底进行中作废时，迟到的批准结果也不能触发回复", async t => {
  let finishFallback!: (response: Response) => void;
  const f = fixture(t, [response({}, 429), () => new Promise<Response>(resolve => { finishFallback = resolve; })]);
  const pending = f.judge.shouldReply(f.message());
  await flush();
  assert.equal(f.calls.length, 2);
  f.judge.invalidate("acct", "group_100");
  assert.equal(await pending, false);
  assert.equal(f.calls[1]!.init.signal!.aborted, true);
  finishFallback(response());
  await flush();
  assert.equal(f.calls.length, 2);
});

test("接话兜底：主模型与兜底分别限额，兜底上限512而非无限输出", async t => {
  const fallback = { baseUrl: "https://fallback.test/", apiKey: "fallback-key", model: "glm-4.5-air", maxTokens: 50_000 };
  const f = fixture(t, [response({}, 429), response()], { maxTokens: 50_000, fallback });
  assert.equal(await f.judge.shouldReply(f.message()), true);
  assert.equal(f.calls[0]!.body.max_tokens, 1024);
  assert.equal(f.calls[1]!.body.max_tokens, 512);
  assert.deepEqual(f.calls[1]!.body.thinking, { type: "disabled" });
  assert.deepEqual(f.calls[1]!.body.response_format, { type: "json_object" });
});
