import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { isHushCommand, isStopCommand } from "../src/agent/hush.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import type { Gateway } from "../src/gateway/index.js";
import type { ChatMessage, ChatResult, LLMClient, ToolSpec } from "../src/llm/index.js";
import type { MemoryProvider } from "../src/memory/index.js";
import type { McpManager } from "../src/tools/mcp.js";
import type { MessageRecord } from "../src/types.js";

const OWNER = "10001";
const MEMBER = "12345678";
const BOT = "99999999";
const BASE = Date.parse("2026-10-27T00:30:00+08:00");
type SendTask = Parameters<Gateway["enqueueSend"]>[0];
type Step = ChatResult | ((signal: AbortSignal | undefined) => Promise<ChatResult>);
const answer = (content: string): ChatResult => ({ content, toolCalls: [], finishReason: "stop" });

async function flush() { for (let i = 0; i < 64; i++) await Promise.resolve(); }

interface Inspectable {
  onMessage(m: MessageRecord): Promise<void>;
  onPoke(ev: unknown): Promise<void>;
}

function fixture(t: TestContext, steps: Step[] = []) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: BASE });
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "acct";
  cfg.persona.name = "κόραξ";
  cfg.groups.allowlist = ["100"];
  cfg.groups.linkPreview = false;
  cfg.groups.conversation = { enabled: false, ownerAliases: ["阿盏"], wakeAliases: ["乌鸦"],
    ownerWakeAliases: [{ userId: OWNER, aliases: ["小渡"] }] };
  cfg.tools.enabled = true;
  cfg.tools.ownerIds = [OWNER];
  cfg.admins = [OWNER];
  const calls: { messages: ChatMessage[]; signal?: AbortSignal; tools?: ToolSpec[] }[] = [];
  const llm: LLMClient = { async chat(messages, options) {
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
    calls.push({ messages: structuredClone(messages), signal, tools: options?.tools && structuredClone(options.tools) });
    const next = steps.shift();
    return typeof next === "function" ? await next(signal) : next ?? answer(`回答第${calls.length}次`);
  } };
  const memory = { ingest: () => {}, retrieve: () => [], recentContextSummary: () => "" } as unknown as MemoryProvider;
  const sent: SendTask[] = [];
  let hold: ((type: "group" | "private", target: string) => boolean) | undefined;
  const gateway = {
    getProvider: () => ({ health: () => ({ selfId: BOT, connection: "connected", login: "online", reconnectCount: 0 }),
      capabilities: () => ({ sendPoke: "unsupported" }) }),
    enqueueSend(task: SendTask) { const r = db.enqueueSendTask(task); if (!r.reused) sent.push(task); return r; },
    setSendHold(fn: typeof hold) { hold = fn; },
  } as unknown as Gateway;
  const agent = new Agent({ db, cfg, llm, gateway, memory, search: null, reader: null,
    mcp: { getTools: () => [] } as unknown as McpManager, timezone: cfg.timezone }) as unknown as Inspectable;
  let serial = 0;
  const message = (text: string, patch: Partial<MessageRecord> = {}): MessageRecord => {
    t.mock.timers.tick(1);
    const id = String(++serial);
    return { eventKey: `hush-event:${id}`, accountId: "acct", providerId: "onebot", conversationId: "group_100", groupId: "100",
      messageId: id, senderId: MEMBER, displayNameAtTime: "群友", sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
      segments: [{ type: "text", data: { text } }], textContent: text, origin: "live", status: "active", ...patch };
  };
  const owner = (text: string, patch: Partial<MessageRecord> = {}) => message(text, { senderId: OWNER, displayNameAtTime: "阿盏", ...patch });
  const at = (text: string, sender = OWNER) => message(text, { senderId: sender,
    segments: [{ type: "at", data: { qq: BOT } }, { type: "text", data: { text } }] });
  const start = (m: MessageRecord) => { db.insertMessage(m); return agent.onMessage(m); };
  const run = async (m: MessageRecord) => { const p = start(m); await flush(); t.mock.timers.tick(1200); await p; await flush(); };
  const poke = (userId = OWNER) => {
    t.mock.timers.tick(1);
    const now = new Date().toISOString();
    return agent.onPoke({ kind: "poke", accountId: "acct", providerId: "onebot", conversationId: "group_100", groupId: "100",
      userId, targetId: BOT, eventKey: `poke:${++serial}`, sentAt: now, receivedAt: now, origin: "live" });
  };
  return { agent, db, cfg, calls, sent, message, owner, at, start, run, poke, hold: () => hold };
}

test("闭嘴/叫停关键词：只认短句里的明确意思", () => {
  const names = ["κόραξ", "小渡", "乌鸦"];
  for (const yes of ["闭嘴", "κόραξ闭嘴", "κόραξ，闭嘴！", "你给我闭嘴", "好了别说了", "安静", "别吵了", "住口", "shut up", "Shut up κόραξ", "闭嘴吧你😡"])
    assert.ok(isHushCommand(yes, names), yes);
  for (const no of ["这里好安静", "你不用闭嘴", "有两层搜索", "他们让我闭嘴我才不呢，今天去图书馆复习了一整天真的很累啊"])
    assert.ok(!isHushCommand(no, names), no);
  for (const yes of ["你的任务完成了，两个任务都完成了，不要再搜了", "别搜了", "不用查了", "停", "好了停下", "可以了", "任务完成了", "stop"])
    assert.ok(isStopCommand(yes, names), yes);
  for (const no of ["继续搜", "有两层搜索", "有两个搜索源头吧", "更多的还是比特币、聪明币之类的调查和市场行情的调研", "帮我查一下天气"])
    assert.ok(!isStopCommand(no, names), no);
});

test("闭嘴：打断进行中的工具循环，不发任何消息；60秒内普通消息不回，@后立即回复", async t => {
  let release!: (r: ChatResult) => void;
  let firstSignal: AbortSignal | undefined;
  const f = fixture(t, [signal => { firstSignal = signal; return new Promise(resolve => { release = resolve; }); }]);
  const first = f.start(f.at("帮我查一下最近的Kimi新闻"));
  await flush();
  assert.equal(f.calls.length, 1, "长任务已开始");
  const queued = f.start(f.owner("你再查查别的？"));
  await flush();
  await f.run(f.owner("κόραξ闭嘴"));
  assert.equal(firstSignal?.aborted, true, "进行中的模型/工具循环被 abort");
  release(answer("这条不应该发出去"));
  await first; await queued; await flush();
  assert.equal(f.sent.length, 0, "闭嘴后不发送任何消息（包括'好的'）");
  assert.equal(f.calls.length, 1, "排队中的回复被取消，不再调用模型");
  assert.equal(f.hold()?.("group", "100"), true, "网关拦截该会话的待发/定时/报告消息");

  await f.run(f.owner("你在干嘛呢？"));
  await f.run(f.at("κόραξ 你好", MEMBER));
  await f.run(f.owner("κόραξ，你说话啊"));
  assert.equal(f.calls.length, 1, "静默期间：主人普通消息、叫名字、群友@ 都不回");

  await f.run(f.at("好了可以说话了"));
  assert.equal(f.calls.length, 2, "主人 @ 立即解除静默");
  assert.equal(f.sent.length, 1);
  assert.equal(f.hold()?.("group", "100"), false);
});

test("闭嘴：主人戳一戳解除静默；别人戳不算", async t => {
  const f = fixture(t);
  await f.run(f.owner("闭嘴"));
  await f.poke(MEMBER); await flush();
  assert.equal(f.calls.length, 0, "群友戳它不解除静默");
  await f.poke(OWNER); await flush(); t.mock.timers.tick(1200); await flush();
  assert.equal(f.calls.length, 1, "主人戳一戳解除静默并回应");
});

test("闭嘴：60秒后不自动补发，跟进窗口清零，需要新的触发", async t => {
  const f = fixture(t);
  await f.run(f.at("你好"));
  assert.equal(f.calls.length, 1);
  await f.run(f.owner("闭嘴"));
  t.mock.timers.tick(61_000);
  await flush();
  assert.equal(f.sent.length, 1, "静默结束不补发");
  assert.equal(f.hold()?.("group", "100"), false);
  await f.run(f.owner("你怎么看？"));
  assert.equal(f.calls.length, 1, "闭嘴前的两分钟窗口已清零（环境通道关闭时不回）");
  await f.run(f.at("你怎么看？"));
  assert.equal(f.calls.length, 2, "新的 @ 照常回复");
});

test("叫停：中断进行中的工具循环，不进入静默；本轮只给会话控制工具", async t => {
  let release!: (r: ChatResult) => void;
  let firstSignal: AbortSignal | undefined;
  const f = fixture(t, [signal => { firstSignal = signal; return new Promise(resolve => { release = resolve; }); }]);
  const first = f.start(f.at("帮我查一下最近的Kimi新闻"));
  await flush();
  await f.run(f.owner("你的任务完成了，两个任务都完成了，不要再搜了"));
  assert.equal(firstSignal?.aborted, true, "叫停打断进行中的工具循环");
  release(answer("旧任务的回答不应发出"));
  await first; await flush();
  const last = f.calls.at(-1)!;
  assert.equal(f.calls.length, 2, "叫停消息本身走一次无工具的回复");
  assert.deepEqual((last.tools ?? []).map(tool => tool.function.name).filter(name => name !== "conversation_action"), []);
  assert.match(String(last.messages[0]!.content), /叫停/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.hold()?.("group", "100"), false, "叫停不进入静默");
  await f.run(f.at("在吗"));
  assert.equal(f.calls.length, 3);
});

test("跟进窗口：窗口内普通插话不再每句都回，对它说的话照常回", async t => {
  const f = fixture(t);
  await f.run(f.at("帮我查一下比特币价格"));
  assert.equal(f.calls.length, 1);
  await f.run(f.owner("有两层搜索"));
  await f.run(f.owner("有两个搜索源头吧"));
  await f.run(f.owner("更多的还是比特币、聪明币之类的调查和市场行情的调研"));
  assert.equal(f.calls.length, 1, "窗口内的普通陈述不触发直接回复");
  await f.run(f.owner("那以太坊呢"));
  assert.equal(f.calls.length, 2, "句末疑问语气词仍算对它说");
  await f.run(f.owner("你觉得这个靠谱吗"));
  assert.equal(f.calls.length, 3, "第二人称仍算对它说");
});

test("私聊：闭嘴同样静默60秒并打断进行中的回复，@ 不存在时只能等到期", async t => {
  let release!: (r: ChatResult) => void;
  let firstSignal: AbortSignal | undefined;
  const f = fixture(t, [signal => { firstSignal = signal; return new Promise(resolve => { release = resolve; }); }]);
  const pm = (text: string) => f.owner(text, { conversationId: `private_${OWNER}`, groupId: undefined });
  const first = f.start(pm("帮我写一篇调查"));
  await flush();
  assert.equal(f.calls.length, 1);
  await f.run(pm("闭嘴"));
  assert.equal(firstSignal?.aborted, true);
  release(answer("不应发出"));
  await first; await flush();
  await f.run(pm("你好"));
  assert.equal(f.calls.length, 1);
  assert.equal(f.sent.length, 0);
  assert.equal(f.hold()?.("private", OWNER), true);
  t.mock.timers.tick(61_000);
  await f.run(pm("你好"));
  assert.equal(f.calls.length, 2, "到期后私聊恢复正常");
});
