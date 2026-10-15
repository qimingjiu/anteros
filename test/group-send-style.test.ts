import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import type { Gateway } from "../src/gateway/index.js";
import type { ChatMessage, ChatResult, LLMClient, ToolSpec } from "../src/llm/index.js";
import type { MemoryProvider } from "../src/memory/index.js";
import type { McpManager } from "../src/tools/mcp.js";
import type { MessageRecord, MessageSegment, ToolDef } from "../src/types.js";

const OWNER = "10001";
const TOOL = "mcp__fixture__private_document";
type SendTask = Parameters<Gateway["enqueueSend"]>[0];
type Step = ChatResult | Error;
const answer = (content = "这是一句自然的群聊发言。"): ChatResult => ({ content, toolCalls: [], finishReason: "stop" });
const lookup = (): ChatResult => ({ content: "", toolCalls: [{ id: "lookup", name: TOOL, arguments: "{}" }], finishReason: "tool_calls" });
const silent = (): ChatResult => ({ content: "不会发送的解释", toolCalls: [{ id: "silent", name: "conversation_action", arguments: '{"action":"silent"}' }], finishReason: "tool_calls" });

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function segments(task: SendTask): MessageSegment[] {
  assert.equal(task.payload.kind, "segments");
  return task.payload.kind === "segments" ? task.payload.segments : [];
}
function text(task: SendTask): string {
  return segments(task).map(segment => segment.type === "text" ? segment.data.text : "").join("");
}
function assertPlain(task: SendTask) {
  assert.ok(segments(task).length > 0);
  assert.ok(segments(task).every(segment => segment.type === "text"), "普通发言不能追加引用框或@收件人");
}

function fixture(t: TestContext, steps: Step[] = []) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.persona.name = "κόραξ";
  cfg.gateway.accountId = "acct";
  cfg.groups.allowlist = ["100"];
  cfg.groups.linkPreview = false;
  cfg.tools.enabled = true;
  cfg.tools.ownerIds = [OWNER];
  cfg.admins = [OWNER];
  cfg.model.maxOutputChars = 10_000;
  const memoryConfig = structuredClone(cfg.memory);
  const ingested: MessageRecord[] = [];
  const memory = { ingest: (m: MessageRecord) => { ingested.push(m); }, retrieve: () => [], recentContextSummary: () => "" } as unknown as MemoryProvider;
  const sent: SendTask[] = [];
  const gateway = {
    getProvider: () => ({ health: () => ({ selfId: "bot", connection: "connected", login: "online", reconnectCount: 0 }) }),
    enqueueSend: (task: SendTask) => { sent.push(task); return { id: sent.length, reused: false }; },
  } as unknown as Gateway;
  const calls: { messages: ChatMessage[]; tools?: ToolSpec[] }[] = [];
  const llm: LLMClient = {
    chat: async (messages, options) => {
      calls.push({ messages: structuredClone(messages), tools: options?.tools && structuredClone(options.tools) });
      const next = steps.shift();
      if (next instanceof Error) throw next;
      return next ?? answer();
    },
  };
  const executed: string[] = [];
  const toolState = { fail: false };
  const tool: ToolDef = {
    name: TOOL, description: "fixture private tool", inputSchema: { type: "object" },
    execute: async () => {
      executed.push(TOOL);
      if (toolState.fail) throw new Error("fixture tool unavailable");
      return "fixture tool result";
    },
  };
  const agent = new Agent({ db, cfg, gateway, llm, memory, search: null, reader: null,
    mcp: { getTools: () => [tool] } as unknown as McpManager, timezone: cfg.timezone,
  }) as unknown as { onMessage(m: MessageRecord): Promise<void> };
  let serial = 0;
  const message = (value = "κόραξ，你怎么看？", changes: Partial<MessageRecord> = {}): MessageRecord => {
    const id = String(++serial);
    return {
      eventKey: `style-event:${id}`, accountId: "acct", providerId: "onebot", conversationId: "group_100", groupId: "100",
      messageId: id, senderId: OWNER, displayNameAtTime: "主人", sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
      segments: [{ type: "text", data: { text: value } }], textContent: value, status: "active", origin: "live", ...changes,
    };
  };
  const run = async (m: MessageRecord) => {
    db.insertMessage(m); // Mirror normal gateway persistence before the Agent callback.
    const pending = agent.onMessage(m);
    await flush();
    t.mock.timers.tick(1200);
    await pending;
  };
  return { db, cfg, memoryConfig, ingested, sent, calls, executed, toolState, message, run };
}

test("群发言样式：明确@机器人时仅引用触发消息一次，不额外@发送者", async t => {
  const f = fixture(t);
  const m = f.message("你怎么看？", { segments: [{ type: "at", data: { qq: "bot" } }, { type: "text", data: { text: "你怎么看？" } }] });
  await f.run(m);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(segments(f.sent[0]!), [{ type: "reply", data: { id: m.messageId } }, { type: "text", data: { text: answer().content } }]);
  assert.equal(f.sent[0]!.conversationType, "group");
  assert.equal(f.sent[0]!.targetId, "100");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.ingested, [m]);
});

test("群发言样式：回复同账号同群的机器人消息时引用当前追问，不引用旧答案", async t => {
  const f = fixture(t);
  const prior = f.message("上一句机器人回答", { senderId: "bot" });
  f.db.insertMessage(prior);
  const m = f.message("那你继续说", { replyToMessageId: prior.messageId,
    segments: [{ type: "reply", data: { id: prior.messageId } }, { type: "text", data: { text: "那你继续说" } }] });
  await f.run(m);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(segments(f.sent[0]!)[0], { type: "reply", data: { id: m.messageId } });
  assert.equal(segments(f.sent[0]!).filter(segment => segment.type === "reply").length, 1);
  assert.equal(f.calls.length, 1);
});

test("群发言样式：自然语言叫名字或主模型选择接话时发送普通群消息", async t => {
  for (const value of ["κόραξ，你怎么看？", "这个话题我还想补充一点"]) {
    const f = fixture(t);
    const m = f.message(value);
    await f.run(m);
    assert.equal(f.sent.length, 1);
    assertPlain(f.sent[0]!);
    assert.equal(text(f.sent[0]!), answer().content);
    assert.equal(f.sent[0]!.targetId, "100");
    assert.equal(f.calls.length, 1, "接话与正文由同一次主模型调用决定");
    assert.deepEqual(f.ingested, [m]);
  }
});

test("群发言样式：当前消息回复其他群友时，自动接话也不会自动套引用框", async t => {
  const f = fixture(t);
  const human = f.message("群友前文", { senderId: "another-user" });
  f.db.insertMessage(human);
  const m = f.message("κόραξ，这句话你怎么看", { replyToMessageId: human.messageId });
  await f.run(m);
  assert.equal(f.sent.length, 1);
  assertPlain(f.sent[0]!);
  assert.equal(f.calls.length, 1);
});

test("群发言样式：其他账号或错误群记录的机器人引用不获得直接引用样式", async t => {
  for (const patch of [{ accountId: "other-account" }, { groupId: "200" }]) {
    const f = fixture(t);
    const foreign = f.message("其他会话的机器人消息", { senderId: "bot", ...patch });
    f.db.insertMessage(foreign);
    const m = f.message("继续这个话题", { replyToMessageId: foreign.messageId });
    await f.run(m);
    assert.equal(f.sent.length, 1);
    assertPlain(f.sent[0]!);
    assert.equal(f.calls.length, 1);
  }
});

test("群发言样式：消息@其他人不能被当作明确@机器人", async t => {
  const f = fixture(t);
  const m = f.message("κόραξ，我们接着说", { segments: [{ type: "at", data: { qq: "another-user" } }, { type: "text", data: { text: "κόραξ，我们接着说" } }] });
  await f.run(m);
  assert.equal(f.sent.length, 1);
  assertPlain(f.sent[0]!);
  assert.equal(f.calls.length, 1);
});

test("群发言样式：长回复只有明确@模式的第一段带引用，续段与自动接话均为纯文本", async t => {
  const output = "abcdefghABCDEFGHijklmnopIJKLMNOPqrstuvwx";
  for (const explicit of [true, false]) {
    const f = fixture(t, [answer(output)]);
    f.cfg.groups.maxReplyChars = 8;
    const m = f.message("说详细一点", explicit ? { segments: [{ type: "at", data: { qq: "bot" } }, { type: "text", data: { text: "说详细一点" } }] } : {});
    await f.run(m);
    assert.ok(f.sent.length > 1);
    if (explicit) assert.deepEqual(segments(f.sent[0]!)[0], { type: "reply", data: { id: m.messageId } });
    else assertPlain(f.sent[0]!);
    for (const task of f.sent.slice(1)) assertPlain(task);
    assert.equal(f.sent.map(text).join(""), output);
    assert.equal(f.sent.flatMap(segments).filter(segment => segment.type === "reply").length, explicit ? 1 : 0);
    assert.equal(f.sent.flatMap(segments).filter(segment => segment.type === "at").length, 0);
    assert.equal(new Set(f.sent.map(task => task.taskKey)).size, f.sent.length);
  }
});

test("群发言样式：私聊及私聊续段保持纯文本，不受输入@与引用字段影响", async t => {
  const output = "abcdefghABCDEFGHijklmnop";
  const f = fixture(t, [answer(output)]);
  f.cfg.groups.maxReplyChars = 8;
  const prior = f.message("机器人私聊回答", { senderId: "bot", conversationId: `private_${OWNER}`, groupId: undefined });
  f.db.insertMessage(prior);
  const m = f.message("私聊问题", { conversationId: `private_${OWNER}`, groupId: undefined, replyToMessageId: prior.messageId,
    segments: [{ type: "at", data: { qq: "bot" } }, { type: "text", data: { text: "私聊问题" } }] });
  await f.run(m);
  assert.ok(f.sent.length > 1);
  for (const task of f.sent) {
    assertPlain(task);
    assert.equal(task.conversationType, "private");
    assert.equal(task.targetId, OWNER);
  }
  assert.equal(f.sent.map(text).join(""), output);
  assert.equal(f.calls.length, 1);
  assert.equal(f.ingested.length, 0);
});

test("群发言样式：明确@时正文缺失发普通错误通知，观察群聊正文缺失保持安静", async t => {
  for (const explicit of [true, false]) {
    const f = fixture(t, explicit ? [answer(""), answer("")] : [answer("")]);
    const m = f.message("回答一下", explicit ? { segments: [{ type: "at", data: { qq: "bot" } }, { type: "text", data: { text: "回答一下" } }] } : {});
    await f.run(m);
    if (!explicit) {
      assert.equal(f.sent.length, 0, "普通群聊没有正文时不广播错误");
      assert.equal(f.calls.length, 1);
      continue;
    }
    assert.equal(f.sent.length, 1);
    assert.equal(f.calls.length, 2, "明确召唤空响应只重试一次，再失败才发通知");
    assert.equal(f.sent[0]!.kind, "notice");
    assertPlain(f.sent[0]!);
    assert.match(text(f.sent[0]!), /没有生成最终回复/);
    assert.equal(f.sent[0]!.targetId, "100");
  }
});

test("群发言样式：自动接话工具失败后仍能说明失败，最终发言不带引用或@", async t => {
  const f = fixture(t, [lookup(), answer("这次工具没查到结果，我先按现有信息说明。")]);
  f.toolState.fail = true;
  await f.run(f.message("κόραξ，帮我查一下"));
  assert.deepEqual(f.executed, [TOOL]);
  assert.equal(f.calls.length, 2);
  assert.match(String(f.calls[1]!.messages.find(message => message.role === "tool")?.content), /工具执行失败/);
  assert.equal(f.sent.length, 1);
  assertPlain(f.sent[0]!);
  assert.match(text(f.sent[0]!), /工具没查到结果/);
});

test("群发言样式：改为普通发言后仍按当前发送者授予工具、摄入记忆且保留原始消息", async t => {
  for (const senderId of [OWNER, "ordinary-user"]) {
    const f = fixture(t);
    const m = f.message("κόραξ，你怎么看", { senderId });
    const original = structuredClone(m);
    await f.run(m);
    assertPlain(f.sent[0]!);
    assert.equal(f.calls[0]!.tools?.some(tool => tool.function.name === TOOL), senderId === OWNER);
    assert.deepEqual(f.ingested, [m]);
    assert.deepEqual(m, original);
    assert.deepEqual(f.cfg.memory, f.memoryConfig);
    assert.equal(f.executed.length, 0);
  }
});

test("群发言样式：主模型决定静默时不发正文或错误；未授权群不会因明确@而发言", async t => {
  const f = fixture(t, [silent()]);
  const idle = f.message("普通闲聊");
  await f.run(idle);
  assert.deepEqual(f.ingested, [idle]);
  assert.equal(f.sent.length, 0);
  const foreign = f.message("你怎么看", { groupId: "999", conversationId: "group_999",
    segments: [{ type: "at", data: { qq: "bot" } }, { type: "text", data: { text: "你怎么看" } }] });
  await f.run(foreign);
  assert.equal(f.sent.length, 0);
  assert.equal(f.calls.length, 1, "静默也只调用本次主模型，禁用群不另调模型");
  assert.deepEqual(f.ingested, [idle]);
});
