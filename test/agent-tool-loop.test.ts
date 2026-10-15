import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import type { Gateway } from "../src/gateway/index.js";
import type { ChatMessage, ChatResult, LLMClient, ToolSpec } from "../src/llm/index.js";
import type { McpManager } from "../src/tools/mcp.js";
import type { MessageRecord, ToolDef } from "../src/types.js";

type SendTask = Parameters<Gateway["enqueueSend"]>[0];
type Step = ChatResult | Error;

class ScriptedLLM implements LLMClient {
  readonly calls: { messages: ChatMessage[]; tools: ToolSpec[] | undefined }[] = [];
  constructor(private steps: Step[]) {}
  async chat(messages: ChatMessage[], opts?: { tools?: ToolSpec[] }): Promise<ChatResult> {
    this.calls.push({ messages: structuredClone(messages), tools: opts?.tools ? structuredClone(opts.tools) : undefined });
    const next = this.steps.shift();
    if (!next) throw new Error(`Unexpected LLM call ${this.calls.length}`);
    if (next instanceof Error) throw next;
    return structuredClone(next);
  }
}

const answer = (content: string): ChatResult => ({ content, toolCalls: [], finishReason: "stop" });
const lookup = (round: number): ChatResult => ({
  content: "",
  toolCalls: [{ id: `lookup-${round}`, name: "mcp__test__lookup", arguments: JSON.stringify({ round }) }],
  finishReason: "tool_calls",
});

function fixture(t: TestContext, steps: Step[]) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "acct";
  cfg.memory.enabled = false;
  cfg.tools.enabled = true;
  cfg.tools.privateToolsOwnerOnly = false;
  cfg.tools.ownerIds = ["user"];
  cfg.groups.maxReplyChars = 10_000;
  cfg.groups.linkPreview = false;
  cfg.groups.allowlist = ["100"];
  cfg.model.maxOutputChars = 10_000;
  const llm = new ScriptedLLM(steps);
  const executed: number[] = [];
  const tool: ToolDef = {
    name: "mcp__test__lookup", description: "Fixture lookup; no network requests",
    inputSchema: { type: "object", properties: { round: { type: "integer" } }, required: ["round"] },
    execute: async args => { const round = Number(args.round); executed.push(round); return `lookup-result-${round}`; },
  };
  const fakeMcp = { getTools: () => [tool] } as unknown as McpManager;
  const sent: SendTask[] = [];
  const gateway = {
    getProvider: () => ({ health: () => ({ selfId: "bot", connection: "connected", login: "online", reconnectCount: 0 }) }),
    enqueueSend: (task: SendTask) => { sent.push(task); return { id: sent.length, reused: false }; },
  } as unknown as Gateway;
  const agent = new Agent({ db, cfg, gateway, llm, memory: null, search: null, reader: null, mcp: fakeMcp, timezone: cfg.timezone });
  const inspected = agent as unknown as {
    replyFlow(m: MessageRecord, flightKey: string): Promise<void>;
    replyInFlight: Set<string>;
  };
  const message: MessageRecord = {
    eventKey: "acct:group_100:1", accountId: "acct", providerId: "onebot",
    conversationId: "group_100", groupId: "100", messageId: "1", senderId: "user", displayNameAtTime: "user",
    sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
    segments: [{ type: "at", data: { qq: "bot" } }, { type: "text", data: { text: "查一下并告诉我结果" } }],
    textContent: "查一下并告诉我结果", status: "active", origin: "live",
  };
  const flightKey = "100:user";
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = async (overrides: Partial<MessageRecord> = {}) => {
    const pending = inspected.replyFlow({ ...message, ...overrides }, flightKey);
    assert.ok(inspected.replyInFlight.has(flightKey));
    t.mock.timers.tick(1200);
    await pending;
    assert.ok(!inspected.replyInFlight.has(flightKey), "结束或出错后都必须释放回复状态");
  };
  const sentText = () => sent.map(task => task.payload.kind === "segments"
    ? task.payload.segments.map(s => s.type === "text" ? s.data.text : "").join("")
    : "").join("\n");
  return { llm, executed, sent, run, sentText };
}

test("Agent 工具循环：连续三轮工具后追加关闭工具的最终调用，并将答案发送群聊", async t => {
  const f = fixture(t, [lookup(1), lookup(2), lookup(3), answer("三轮查找的最终答案")]);
  await f.run();
  assert.equal(f.llm.calls.length, 4);
  assert.deepEqual(f.executed, [1, 2, 3]);
  for (const call of f.llm.calls.slice(0, 3)) {
    assert.ok(call.tools?.some(tool => tool.function.name === "mcp__test__lookup"));
  }
  const final = f.llm.calls[3]!;
  assert.deepEqual(final.tools?.map(tool => tool.function.name), ["conversation_action"], "最终轮只保留静默控制，不再允许业务工具");
  assert.deepEqual(final.messages.filter(m => m.role === "tool").map(m => [m.tool_call_id, m.content]), [
    ["lookup-1", "lookup-result-1"], ["lookup-2", "lookup-result-2"], ["lookup-3", "lookup-result-3"],
  ]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.kind, "reply");
  assert.equal(f.sent[0]!.conversationType, "group");
  assert.equal(f.sent[0]!.targetId, "100");
  assert.equal(f.sentText(), "三轮查找的最终答案");
  assert.equal(f.sent[0]!.payload.kind, "segments");
  if (f.sent[0]!.payload.kind === "segments") {
    assert.deepEqual(f.sent[0]!.payload.segments[0], { type: "reply", data: { id: "1" } });
  }
});

test("Agent 工具循环：普通文字回答仍只调用模型一次", async t => {
  const f = fixture(t, [answer("直接回答")]);
  await f.run();
  assert.equal(f.llm.calls.length, 1);
  assert.deepEqual(f.executed, []);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.kind, "reply");
  assert.equal(f.sentText(), "直接回答");
});

test("Agent 工具循环：一轮工具后正常回答立即发送，无多余最终调用", async t => {
  const f = fixture(t, [lookup(1), answer("根据 lookup-result-1 回答")]);
  await f.run();
  assert.equal(f.llm.calls.length, 2);
  assert.deepEqual(f.executed, [1]);
  assert.deepEqual(f.llm.calls[1]!.messages.filter(m => m.role === "tool").map(m => m.content), ["lookup-result-1"]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.kind, "reply");
  assert.equal(f.sentText(), "根据 lookup-result-1 回答");
});

test("Agent 工具循环：三轮工具后最终文字为空时发送明确错误通知，不能静默", async t => {
  const f = fixture(t, [lookup(1), lookup(2), lookup(3), answer("   \n ")]);
  await f.run();
  assert.equal(f.llm.calls.length, 4);
  assert.deepEqual(f.executed, [1, 2, 3]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.kind, "notice");
  assert.match(f.sentText(), /没有生成最终回复|暂时不可用|没能生成|重试|出错|失败/);
  assert.doesNotMatch(f.sentText(), /lookup-result/);
});

test("Agent 工具循环：最终轮仍输出工具调用时仅恢复一次正文，连续越界后通知", async t => {
  const f = fixture(t, [lookup(1), lookup(2), lookup(3), lookup(4), lookup(5)]);
  await f.run();
  assert.equal(f.llm.calls.length, 5);
  assert.deepEqual(f.llm.calls[3]!.tools?.map(tool => tool.function.name), ["conversation_action"]);
  assert.deepEqual(f.llm.calls[4]!.tools, []);
  assert.deepEqual(f.executed, [1, 2, 3], "关闭工具后模型幻觉产生的第四个调用不得执行");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.kind, "notice");
  assert.ok(f.sentText().trim().length > 0);
});

test("Agent 工具循环：明确召唤未调用工具却连续返回空答案，单次恢复后通知用户", async t => {
  const f = fixture(t, [answer(""), answer("")]);
  await f.run();
  assert.equal(f.llm.calls.length, 2);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.kind, "notice");
  assert.ok(f.sentText().trim().length > 0);
});

test("Agent 工具循环：三轮后的最终模型请求抛错时仍发送通知并清理状态", async t => {
  const f = fixture(t, [lookup(1), lookup(2), lookup(3), new Error("fixture final upstream failure")]);
  await f.run();
  assert.equal(f.llm.calls.length, 4);
  assert.deepEqual(f.executed, [1, 2, 3]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.kind, "notice");
  assert.ok(f.sentText().trim().length > 0);
});

test("Agent 工具循环：两次明确召唤各自恢复一次后仍为空，各自通知不受模型错误冷却吞掉", async t => {
  const f = fixture(t, [answer(""), answer("   "), answer(""), answer(" ")]);
  await f.run();
  await f.run({ messageId: "2", eventKey: "acct:group_100:2", textContent: "再问一次" });
  assert.equal(f.llm.calls.length, 4);
  assert.equal(f.sent.length, 2, "第二次未生成正文仍必须明确通知用户");
  assert.ok(f.sent.every(task => task.kind === "notice" && task.targetId === "100"));
  assert.match(f.sentText(), /没有生成最终回复|没能生成|未生成/);
});

test("Agent 工具循环：第三轮批量工具的全部结果进入最终正文调用", async t => {
  const third: ChatResult = {
    content: "再核对两个结果",
    toolCalls: [...lookup(3).toolCalls, ...lookup(4).toolCalls],
    finishReason: "tool_calls",
  };
  const f = fixture(t, [lookup(1), lookup(2), third, answer("结合四个工具结果给出答案")]);
  await f.run();
  assert.equal(f.llm.calls.length, 4, "预算按工具轮次计算，不按单个工具调用计算");
  assert.deepEqual(f.executed, [1, 2, 3, 4]);
  const final = f.llm.calls[3]!;
  assert.deepEqual(final.tools?.map(tool => tool.function.name), ["conversation_action"]);
  assert.deepEqual(final.messages.filter(m => m.role === "tool").map(m => [m.tool_call_id, m.content]), [
    ["lookup-1", "lookup-result-1"], ["lookup-2", "lookup-result-2"],
    ["lookup-3", "lookup-result-3"], ["lookup-4", "lookup-result-4"],
  ]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.kind, "reply");
  assert.equal(f.sentText(), "结合四个工具结果给出答案");
});

test("Agent 工具循环：关闭工具后同时输出正文和新工具调用也须拒绝执行，再恢复正文", async t => {
  const final = { ...lookup(4), content: "我要再查一次，请稍等" };
  const f = fixture(t, [lookup(1), lookup(2), lookup(3), final, answer("依据已有结果完成回答")]);
  await f.run();
  assert.equal(f.llm.calls.length, 5);
  const recovery = f.llm.calls[4]!;
  assert.deepEqual(recovery.tools, []);
  assert.match(String(recovery.messages.find(message => message.tool_call_id === "lookup-4")?.content), /没有执行/);
  assert.deepEqual(f.executed, [1, 2, 3]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.kind, "reply");
  assert.equal(f.sentText(), "依据已有结果完成回答");
  assert.doesNotMatch(f.sentText(), /我要再查一次/);
  assert.ok(f.sentText().trim().length > 0);
});

test("Agent 工具循环：明确召唤三轮业务工具后静默，只恢复最终正文，不重复业务工具", async t => {
  const final: ChatResult = { content: "这段解释应被丢弃", toolCalls: [{
    id: "silent", name: "conversation_action", arguments: '{"action":"silent"}',
  }], finishReason: "tool_calls" };
  const f = fixture(t, [lookup(1), lookup(2), lookup(3), final, answer("已有结果的最终答复")]);
  await f.run();
  assert.equal(f.llm.calls.length, 5);
  assert.deepEqual(f.executed, [1, 2, 3]);
  assert.deepEqual(f.llm.calls[3]!.tools?.map(tool => tool.function.name), ["conversation_action"]);
  assert.deepEqual(f.llm.calls[4]!.tools?.map(tool => tool.function.name), ["conversation_action"]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sentText(), "已有结果的最终答复");
});
