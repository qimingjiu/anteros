import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { loadConfig, type ModelProfile } from "../src/config.js";
import { Database } from "../src/db/index.js";
import type { Gateway } from "../src/gateway/index.js";
import type { LLMClient } from "../src/llm/index.js";
import { ModelSwitcher } from "../src/llm/switcher.js";
import { McpManager } from "../src/tools/mcp.js";
import type { MessageRecord, ToolDef } from "../src/types.js";

type SendTask = Parameters<Gateway["enqueueSend"]>[0];
interface InspectableAgent {
  llm: LLMClient;
  onMessage(m: MessageRecord): Promise<void>;
  availableTools(m: MessageRecord): ToolDef[];
  executeTool(name: string, args: string, m: MessageRecord): Promise<string>;
  enqueuePrivateReply(m: MessageRecord): Promise<void>;
  enqueueGroupReply(m: MessageRecord, groupId: string): Promise<void>;
  generateReply(m: MessageRecord, merged: MessageRecord[]): Promise<string>;
}

function fixture(t: { after(fn: () => void): void }, toolsEnabled = false) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "acct";
  cfg.tools.enabled = toolsEnabled;
  cfg.tools.mcp.enabled = false;
  cfg.tools.mcp.servers = [];
  cfg.memory.enabled = false;
  cfg.groups.allowlist = ["100"];
  cfg.groups.linkPreview = false;
  cfg.admins = ["admin-a", "admin-b"];
  const profiles: ModelProfile[] = [
    { name: "sora-shared", serviceName: "Sora", provider: "mock", baseUrl: "", apiKey: "", model: "shared-model" },
    { name: "sora-slash", serviceName: "Sora", provider: "mock", baseUrl: "", apiKey: "", model: "times/gemini-3.8-flash" },
    { name: "tale-shared", serviceName: "tale", provider: "mock", baseUrl: "", apiKey: "", model: "shared-model" },
  ];
  cfg.model = { ...cfg.model, provider: "mock", baseUrl: "", apiKey: "", model: "default-model", profiles, providers: [] };
  const switcher = new ModelSwitcher(profiles, cfg.model, db);
  const sent: SendTask[] = [];
  const fakeGateway = {
    getProvider: () => ({ health: () => ({ selfId: "bot", connection: "connected", login: "online", reconnectCount: 0 }) }),
    enqueueSend: (task: SendTask) => { sent.push(task); return { id: sent.length, reused: false }; },
  };
  let llmCalls = 0;
  const llm: LLMClient = {
    chat: async () => { llmCalls++; throw new Error("test upstream unavailable"); },
  };
  const agent = new Agent({
    db, cfg, gateway: fakeGateway as unknown as Gateway, llm, memory: null,
    search: null, reader: null, mcp: new McpManager(cfg.tools.mcp),
    modelSwitcher: switcher, timezone: cfg.timezone,
  });
  const inspected = agent as unknown as InspectableAgent;
  let serial = 0;
  const message = (text: string, overrides: Partial<MessageRecord> = {}): MessageRecord => {
    const messageId = String(++serial);
    const sender = overrides.senderId ?? "admin-a";
    return {
      eventKey: `acct:private-${sender}:${messageId}`, accountId: "acct", providerId: "onebot",
      conversationId: `private_${sender}`, messageId, senderId: sender, displayNameAtTime: sender,
      sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
      segments: [{ type: "text", data: { text } }], textContent: text, status: "active", origin: "live",
      ...overrides,
    };
  };
  const replyText = () => sent.map(task => task.payload.kind === "segments"
    ? task.payload.segments.map(s => s.type === "text" ? s.data.text : "").join("")
    : "").join("\n");
  return { agent: inspected, cfg, db, switcher, sent, message, replyText, llmCalls: () => llmCalls };
}

test("Agent：管理员私聊菜单在工具关闭和上游失效时仍完成三步切换，无 LLM 调用", async t => {
  const f = fixture(t);
  await f.agent.onMessage(f.message("更换模型"));
  assert.match(f.replyText(), /先选择模型商/);
  assert.doesNotMatch(f.replyText(), /shared-model|times\/gemini/);
  await f.agent.onMessage(f.message("Sora"));
  assert.match(f.replyText(), /Sora 的可选模型/);
  assert.equal(f.switcher.activeName(), "默认（default-model）");
  await f.agent.onMessage(f.message("times/gemini-3.8-flash"));
  assert.equal(f.switcher.activeName(), "sora-slash");
  assert.equal(f.db.kvGet("active_model_profile"), "sora-slash");
  assert.equal(f.llmCalls(), 0);
  assert.ok(f.sent.every(s => s.conversationType === "private" && s.targetId === "admin-a"));
  assert.ok(f.sent.every(s => s.kind === "reply"));
});

test("Agent：非管理员私聊和管理员群聊不进入模型选择，也不能执行模型工具", async t => {
  const f = fixture(t, true);
  const normalReplies: MessageRecord[] = [];
  f.agent.enqueuePrivateReply = async m => { normalReplies.push(m); };
  f.agent.enqueueGroupReply = async m => { normalReplies.push(m); };
  const unauthorized = f.message("换模型", { senderId: "guest", conversationId: "private_guest" });
  const inGroup = f.message("换模型", {
    groupId: "100", conversationId: "group_100",
    segments: [{ type: "at", data: { qq: "bot" } }, { type: "text", data: { text: "换模型" } }],
  });
  await f.agent.onMessage(unauthorized);
  await f.agent.onMessage(inGroup);
  assert.deepEqual(normalReplies, [unauthorized, inGroup]);
  assert.equal(f.sent.length, 0);
  for (const m of [unauthorized, inGroup]) {
    assert.ok(!f.agent.availableTools(m).some(tool => ["list_models", "switch_model"].includes(tool.name)));
    assert.match(await f.agent.executeTool("list_models", "{}", m), /不存在或当前不可用/);
    assert.match(await f.agent.executeTool("switch_model", '{"name":"sora-slash"}', m), /不存在或当前不可用/);
  }
  assert.equal(f.switcher.activeName(), "默认（default-model）");
});

test("Agent：未启用群聊和机器人自己发言不会创建选择会话", async t => {
  const f = fixture(t);
  const ordinary: MessageRecord[] = [];
  f.agent.enqueuePrivateReply = async m => { ordinary.push(m); };
  await f.agent.onMessage(f.message("换模型", { senderId: "bot", conversationId: "private_bot" }));
  await f.agent.onMessage(f.message("换模型", { groupId: "999", conversationId: "group_999" }));
  await f.agent.onMessage(f.message("1"));
  assert.equal(f.sent.length, 0);
  assert.equal(ordinary.length, 1, "独立私聊数字仍是普通对话，未承接群聊选择状态");
  assert.equal(f.switcher.activeName(), "默认（default-model）");
});

test("Agent：两个管理员选择状态互不干扰，同名模型按各自服务商切换", async t => {
  const f = fixture(t);
  const a = (text: string) => f.message(text);
  const b = (text: string) => f.message(text, { senderId: "admin-b", conversationId: "private_admin-b" });
  await f.agent.onMessage(a("/模型"));
  await f.agent.onMessage(b("/models"));
  await f.agent.onMessage(a("Sora"));
  await f.agent.onMessage(b("tale"));
  await f.agent.onMessage(b("shared-model"));
  assert.equal(f.switcher.activeName(), "tale-shared");
  await f.agent.onMessage(a("2"));
  assert.equal(f.switcher.activeName(), "sora-slash");
  assert.equal(f.llmCalls(), 0);
});

test("Agent：非当前账号消息被忽略，当前账号的私聊选择会话保持隔离", async t => {
  const f = fixture(t);
  const ordinary: MessageRecord[] = [];
  f.agent.enqueuePrivateReply = async m => { ordinary.push(m); };
  await f.agent.onMessage(f.message("换模型"));
  await f.agent.onMessage(f.message("Sora"));
  const menuReplies = f.sent.length;
  await f.agent.onMessage(f.message("2", { accountId: "acct-other" }));
  assert.equal(ordinary.length, 0, "非当前账号不能进入普通回复或菜单路径");
  assert.equal(f.sent.length, menuReplies, "非当前账号不能产生菜单响应");
  await f.agent.onMessage(f.message("2", { conversationId: "private_other-conversation" }));
  assert.equal(ordinary.length, 1);
  assert.equal(ordinary[0]?.accountId, "acct");
  assert.equal(f.switcher.activeName(), "默认（default-model）");
  await f.agent.onMessage(f.message("2"));
  assert.equal(f.switcher.activeName(), "sora-slash");
});

test("Agent：旧 switch_model 工具被移除，list_models 只打开服务商菜单", async t => {
  const f = fixture(t, true);
  const m = f.message("列一下模型商");
  const tools = f.agent.availableTools(m);
  assert.ok(tools.some(tool => tool.name === "list_models"));
  assert.ok(!tools.some(tool => tool.name === "switch_model"));
  assert.match(await f.agent.executeTool("list_models", "{}", m), /先选择模型商/);
  assert.equal(f.switcher.activeName(), "默认（default-model）");
  await f.agent.onMessage(f.message("Sora"));
  await f.agent.onMessage(f.message("2"));
  assert.equal(f.switcher.activeName(), "sora-slash");
  assert.equal(f.llmCalls(), 0);
});

test("Agent：普通回复调用失败后，模型错误提示冷却不会阻止菜单和取消", async t => {
  const f = fixture(t);
  await f.agent.onMessage(f.message("普通聊天"));
  assert.equal(f.llmCalls(), 1);
  assert.equal(f.sent[0]?.kind, "notice");
  await f.agent.onMessage(f.message("换模型"));
  await f.agent.onMessage(f.message("1"));
  await f.agent.onMessage(f.message("取消"));
  assert.equal(f.llmCalls(), 1);
  assert.match(f.replyText(), /先选择模型商/);
  assert.match(f.replyText(), /Sora 的可选模型/);
  assert.match(f.replyText(), /已取消/);
  assert.equal(f.switcher.activeName(), "默认（default-model）");
});

test("Agent：自然语言通过 list_models 工具打开菜单后直接返回，等待选择不再次调用模型", async t => {
  const f = fixture(t, true);
  let calls = 0;
  f.agent.llm = {
    chat: async (_messages, opts) => {
      calls++;
      assert.equal(calls, 1, "菜单工具结果不能再送回模型改写");
      assert.ok(opts?.tools?.some(tool => tool.function.name === "list_models"));
      return { content: "", toolCalls: [{ id: "menu-1", name: "list_models", arguments: "{}" }], finishReason: "tool_calls" };
    },
  };
  const text = await f.agent.generateReply(f.message("可以让我挑一下后面用谁来聊天吗"), []);
  assert.equal(calls, 1);
  assert.equal(text, f.switcher.listProviders());
  assert.equal(f.switcher.activeName(), "默认（default-model）");
  await f.agent.onMessage(f.message("Sora"));
  await f.agent.onMessage(f.message("2"));
  assert.equal(f.switcher.activeName(), "sora-slash");
  assert.equal(calls, 1);
});
