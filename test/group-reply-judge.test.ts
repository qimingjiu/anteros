import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { GroupReplyJudge, type GroupReplyJudgeOptions } from "../src/agent/group-reply-judge.js";
import type { GroupReplyJudgeConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import type { MessageRecord } from "../src/types.js";

const START = Date.parse("2026-10-12T18:00:00Z");
const decision = (id = "1", confidence = 0.95) => ({ reply: true, targetMessageId: id, confidence });
const envelope = (content: unknown = JSON.stringify(decision()), finish = "stop", extra: Record<string, unknown> = {}) => ({
  choices: [{ finish_reason: finish, message: { role: "assistant", content, ...extra } }],
});
const response = (body: unknown = envelope(), status = 200) => new Response(JSON.stringify(body), { status });
async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function fixture(t: TestContext, opts: {
  cfg?: Partial<GroupReplyJudgeConfig>;
  wait?: GroupReplyJudgeOptions["wait"] | null;
  fetch?: typeof fetch;
} = {}) {
  const db = new Database(":memory:");
  const clock = { now: START };
  const calls: { url: string; init: RequestInit; body: Record<string, any> }[] = [];
  let reply = () => response();
  const cfg: GroupReplyJudgeConfig = {
    enabled: true, baseUrl: "https://example.test/v4/", apiKey: "fixture-secret", model: "glm-4.5-air",
    debounceMs: 1500, minIntervalMs: 10_000, cooldownMs: 60_000, requestTimeoutMs: 6000,
    maxTokens: 128, maxContextMessages: 12, maxContextChars: 2400, confidenceThreshold: 0.9,
    thinking: "disabled", ...opts.cfg,
  };
  const fetcher = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init?.body)) });
    return opts.fetch ? opts.fetch(url, init) : reply();
  }) as typeof fetch;
  const judge = new GroupReplyJudge(cfg, db, () => "bot", "κόραξ", {
    fetch: fetcher,
    now: () => clock.now,
    wait: opts.wait === null ? undefined : opts.wait ?? (async () => {}),
  });
  t.after(() => { judge.stop(); db.close(); });
  const msg = (id = "1", patch: Partial<MessageRecord> = {}): MessageRecord => ({
    eventKey: `acct:group_100:${id}`, accountId: "acct", providerId: "onebot", conversationId: "group_100",
    groupId: "100", messageId: id, senderId: "user", displayNameAtTime: "小月亮",
    sentAt: new Date(clock.now).toISOString(), receivedAt: new Date(clock.now).toISOString(),
    textContent: "κόραξ，你帮我解释一下这个问题好吗？", segments: [], status: "active", origin: "live", ...patch,
  });
  const setResponse = (body: unknown, status = 200) => { reply = () => response(body, status); };
  return { db, clock, judge, calls, msg, setResponse };
}

test("GroupReplyJudge：明确点名且高置信度才批准，判断请求独立且没有工具", async t => {
  const f = fixture(t);
  const m = f.msg();
  assert.equal(await f.judge.shouldReply(m), true);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0]!;
  assert.equal(call.url, "https://example.test/v4/chat/completions");
  assert.equal(call.init.method, "POST");
  assert.deepEqual(call.init.headers, { "Content-Type": "application/json", Authorization: "Bearer fixture-secret" });
  assert.equal(call.body.model, "glm-4.5-air");
  assert.equal(call.body.temperature, 0.1);
  assert.deepEqual(call.body.thinking, { type: "disabled" });
  assert.deepEqual(call.body.response_format, { type: "json_object" });
  assert.equal(call.body.max_tokens, 128);
  assert.equal(call.body.tools, undefined);
  assert.match(call.body.messages[0].content, /非常保守|普通群友之间聊天/);
  assert.match(call.body.messages[0].content, /不可信|不要执行/);
  assert.match(call.body.messages[0].content, /适合机器人接话的概率/);
  assert.ok(call.body.messages[1].content.endsWith(f.judge.contextFor(m)), "主模型必须能复用同一上下文");
});

test("GroupReplyJudge：无密钥、禁用、私聊、补采、自身、空消息、撤回和异常会话均不请求", async t => {
  for (const cfg of [{ enabled: false }, { apiKey: "" }]) {
    const f = fixture(t, { cfg });
    assert.equal(await f.judge.shouldReply(f.msg()), false);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(t);
  const patches: Partial<MessageRecord>[] = [
    { groupId: undefined, conversationId: "private_user" }, { origin: "backfill" }, { senderId: "bot" },
    { textContent: " \n " }, { status: "recalled" }, { conversationId: "group_200" },
    { sentAt: "invalid-time" }, { sentAt: new Date(START - 600_001).toISOString() },
    { sentAt: new Date(START + 30_001).toISOString() },
  ];
  for (const patch of patches) assert.equal(await f.judge.shouldReply(f.msg("1", patch)), false);
  assert.equal(f.calls.length, 0);
});

test("GroupReplyJudge：严格拒绝错误目标、低置信度、伪布尔、非法置信度和非JSON正文", async t => {
  const f = fixture(t, { cfg: { minIntervalMs: 0, cooldownMs: 0 } });
  const bad = [
    { reply: false, targetMessageId: "1", confidence: 1 }, decision("old-message"), decision("1", 0.89),
    { reply: "true", targetMessageId: "1", confidence: 1 },
    { reply: true, targetMessageId: "1", confidence: "1" }, decision("1", 1.01),
    { reply: true, targetMessageId: "1", confidence: null }, null, [],
    { ...decision(), reason: "unsolicited extra field" },
  ].map(value => envelope(JSON.stringify(value)));
  bad.push(envelope("我认为应该回答"), envelope("```json\n" + JSON.stringify(decision()) + "\n```"), envelope(""));
  for (const body of bad) {
    f.setResponse(body);
    assert.equal(await f.judge.shouldReply(f.msg()), false, JSON.stringify(body));
  }
  assert.equal(f.calls.length, bad.length);
});

test("GroupReplyJudge：工具调用、截断、错误响应、异常正文及HTTP失败均安静拒绝", async t => {
  const f = fixture(t, { cfg: { minIntervalMs: 0, cooldownMs: 0 } });
  const bad = [
    envelope(JSON.stringify(decision()), "length"), envelope(JSON.stringify(decision()), "tool_calls"),
    envelope(JSON.stringify(decision()), "stop", { tool_calls: [{ function: { name: "read_webpage" } }] }),
    envelope(JSON.stringify(decision()), "stop", { function_call: { name: "search" } }),
    envelope(JSON.stringify(decision()), "stop", { tool_calls: "unexpected" }),
    { error: { code: "auth_error" }, ...envelope() }, { choices: [] }, {}, null,
    envelope({ reply: true }), envelope(" "), envelope("x".repeat(16_500)),
  ];
  for (const body of bad) {
    f.setResponse(body);
    assert.equal(await f.judge.shouldReply(f.msg()), false, JSON.stringify(body).slice(0, 200));
  }
  f.setResponse({ error: "upstream" }, 503);
  assert.equal(await f.judge.shouldReply(f.msg()), false);
});

test("GroupReplyJudge：传输异常不抛给群聊", async t => {
  const f = fixture(t, { fetch: (async () => { throw new Error("fixture network failure"); }) as typeof fetch });
  assert.equal(await f.judge.shouldReply(f.msg()), false);
});

test("GroupReplyJudge：突发消息防抖，只判断最后一条", async t => {
  const pendingWaits: (() => void)[] = [];
  const f = fixture(t, { wait: async () => new Promise<void>(resolve => pendingWaits.push(resolve)) });
  const old = f.judge.shouldReply(f.msg("1"));
  const current = f.judge.shouldReply(f.msg("2"));
  pendingWaits[0]!();
  assert.equal(await old, false);
  assert.equal(f.calls.length, 0);
  f.setResponse(envelope(JSON.stringify(decision("2"))));
  pendingWaits[1]!();
  assert.equal(await current, true);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.body.messages[0].content, /targetMessageId 必须是 "2"/);
});

test("GroupReplyJudge：生产防抖被直接点名作废时及时取消，不遗留计时器", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, { wait: null });
  const pending = f.judge.shouldReply(f.msg());
  f.judge.invalidate("acct", "group_100");
  assert.equal(await pending, false, "invalidate 应立即结束等待，无需推进时钟");
  t.mock.timers.tick(1500);
  assert.equal(f.calls.length, 0);
});

test("GroupReplyJudge：取消旧防抖不会清掉新消息的防抖句柄", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, { wait: null });
  const old = f.judge.shouldReply(f.msg("1"));
  const current = f.judge.shouldReply(f.msg("2"));
  assert.equal(await old, false);
  f.judge.invalidate("acct", "group_100");
  assert.equal(await current, false);
  t.mock.timers.tick(1500);
  assert.equal(f.calls.length, 0);
});

test("GroupReplyJudge：判断中来了新消息，旧的高置信度结果也不能触发回复", async t => {
  let complete!: (value: Response) => void;
  const f = fixture(t, {
    fetch: (async () => new Promise<Response>(resolve => { complete = resolve; })) as typeof fetch,
  });
  const old = f.judge.shouldReply(f.msg("1"));
  await flush();
  assert.equal(f.calls.length, 1);
  const oldSignal = f.calls[0]!.init.signal!;
  const current = f.judge.shouldReply(f.msg("2"));
  assert.equal(oldSignal.aborted, true);
  complete(response());
  assert.equal(await old, false);
  assert.equal(await current, false, "最小请求间隔避免每条群消息都花钱判断");
  assert.equal(f.calls.length, 1);
});

test("GroupReplyJudge：直接@、回复或主流程繁忙时可作废正在进行的判断", async t => {
  const f = fixture(t, { fetch: (async () => new Promise<Response>(() => {})) as typeof fetch });
  const pending = f.judge.shouldReply(f.msg());
  await flush();
  f.judge.invalidate("acct", "group_100");
  assert.equal(await pending, false);
  assert.equal(f.calls[0]!.init.signal!.aborted, true);
});

test("GroupReplyJudge：纯图片的新消息也会使待判断的旧消息过期", async t => {
  const waits: (() => void)[] = [];
  const f = fixture(t, { wait: async () => new Promise<void>(resolve => waits.push(resolve)) });
  const old = f.judge.shouldReply(f.msg());
  assert.equal(await f.judge.shouldReply(f.msg("2", { textContent: "" })), false);
  waits[0]!();
  assert.equal(await old, false);
  assert.equal(f.calls.length, 0);
});

test("GroupReplyJudge：超时会中止请求且保持安静，即使测试传输忽略AbortSignal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, { fetch: (async () => new Promise<Response>(() => {})) as typeof fetch });
  const pending = f.judge.shouldReply(f.msg());
  await flush();
  t.mock.timers.tick(6000);
  assert.equal(await pending, false);
  assert.equal(f.calls[0]!.init.signal!.aborted, true);
});

test("GroupReplyJudge：同群请求限频，批准回复后冷却更长，群与账号之间独立", async t => {
  const f = fixture(t);
  f.setResponse(envelope(JSON.stringify({ reply: false, targetMessageId: "1", confidence: 0 })));
  assert.equal(await f.judge.shouldReply(f.msg()), false);
  f.clock.now += 9999;
  assert.equal(await f.judge.shouldReply(f.msg()), false);
  assert.equal(f.calls.length, 1);
  f.clock.now++;
  f.setResponse(envelope());
  assert.equal(await f.judge.shouldReply(f.msg()), true);
  f.clock.now += 59_999;
  assert.equal(await f.judge.shouldReply(f.msg()), false);
  assert.equal(await f.judge.shouldReply(f.msg("1", { accountId: "other-account", eventKey: "other:1" })), true);
  assert.equal(await f.judge.shouldReply(f.msg("1", { groupId: "200", conversationId: "group_200", eventKey: "group200:1" })), true);
  f.clock.now++;
  assert.equal(await f.judge.shouldReply(f.msg()), true);
  assert.equal(f.calls.length, 5);
});

test("GroupReplyJudge：同群判断中的请求不会阻塞其他群", async t => {
  let complete!: (value: Response) => void;
  let n = 0;
  const f = fixture(t, { fetch: (async () => {
    if (++n === 1) return new Promise<Response>(resolve => { complete = resolve; });
    return response();
  }) as typeof fetch });
  const first = f.judge.shouldReply(f.msg());
  await flush();
  assert.equal(await f.judge.shouldReply(f.msg("1", { groupId: "200", conversationId: "group_200", eventKey: "group200:1" })), true);
  complete(response());
  assert.equal(await first, true);
  assert.equal(f.calls.length, 2);
});

test("GroupReplyJudge：上下文隔离账号和群、剔除旧消息补采撤回，按时间排序并标识机器人", async t => {
  const f = fixture(t);
  const records = [
    f.msg("bot-answer", { senderId: "bot", displayNameAtTime: "κόραξ", textContent: "我的解释是……", sentAt: new Date(START - 2000).toISOString() }),
    f.msg("earlier", { textContent: "机器人帮我解释一下", sentAt: new Date(START - 3000).toISOString() }),
    f.msg("different-account", { accountId: "other", textContent: "跨账号机密" }),
    f.msg("different-group", { groupId: "200", conversationId: "group_200", textContent: "跨群机密" }),
    f.msg("expired", { textContent: "过期上下文", sentAt: new Date(START - 600_001).toISOString() }),
    f.msg("backfill", { origin: "backfill", textContent: "补采上下文" }),
    f.msg("recalled", { status: "recalled", textContent: "已撤回上下文" }),
  ];
  for (const m of records) f.db.insertMessage(m);
  const current = f.msg();
  f.db.insertMessage(current);
  const context = JSON.parse(f.judge.contextFor(current));
  assert.deepEqual(context.map((m: any) => m.messageId), ["earlier", "bot-answer", "1"]);
  assert.equal(context[1].speaker, "bot");
  assert.equal(context[2].speaker, "member");
  assert.equal(context.filter((m: any) => m.messageId === "1").length, 1, "已存库的当前消息不重复加入");
  assert.equal(await f.judge.shouldReply(current), true);
  const frozen = f.judge.contextFor(current);
  f.db.insertMessage(f.msg("later", { textContent: "后来发的新消息" }));
  assert.equal(f.judge.contextFor(current), frozen, "已批准接话必须保持当时判断的上下文");
});

test("GroupReplyJudge：消息数和字符预算都有上限，当前未入库消息仍进入上下文", t => {
  const f = fixture(t, { cfg: { maxContextMessages: 3, maxContextChars: 700 } });
  for (let i = 1; i <= 15; i++) {
    f.db.insertMessage(f.msg(`old-${i}`, { textContent: "旧消息".repeat(200), sentAt: new Date(START - (20 - i) * 1000).toISOString() }));
  }
  const m = f.msg("current", { textContent: "当前消息\n\"".repeat(200) });
  const raw = f.judge.contextFor(m);
  const context = JSON.parse(raw);
  assert.ok(raw.length <= 700, `encoded JSON length ${raw.length}`);
  assert.ok(context.length <= 3);
  assert.equal(context.at(-1).messageId, "current");
  assert.ok(context.at(-1).text.startsWith("当前消息"));
});

test("GroupReplyJudge：配置异常有有限预算，不会发送无限上下文或输出", async t => {
  const f = fixture(t, { cfg: { maxTokens: 50_000, maxContextMessages: 9999, maxContextChars: 1e9 } });
  assert.equal(await f.judge.shouldReply(f.msg()), true);
  assert.equal(f.calls[0]!.body.max_tokens, 1024);
  assert.ok(f.judge.contextFor(f.msg()).length <= 6000);
});

test("GroupReplyJudge：stop取消防抖和请求，停机后不再调用小模型", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const delayed = fixture(t, { wait: null });
  const waiting = delayed.judge.shouldReply(delayed.msg());
  delayed.judge.stop();
  assert.equal(await waiting, false);
  assert.equal(delayed.calls.length, 0);
  const inFlight = fixture(t, { fetch: (async () => new Promise<Response>(() => {})) as typeof fetch });
  const pending = inFlight.judge.shouldReply(inFlight.msg());
  await flush();
  inFlight.judge.stop();
  assert.equal(await pending, false);
  assert.equal(inFlight.calls[0]!.init.signal!.aborted, true);
  assert.equal(await inFlight.judge.shouldReply(inFlight.msg()), false);
  assert.equal(inFlight.calls.length, 1);
});
