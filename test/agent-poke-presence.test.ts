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
import type { MessageRecord, PokeEvent, ToolDef } from "../src/types.js";
import type { PhoneContextProvider, PhoneContextRequest, PhoneContextReceipt } from "../src/presence/index.js";
import { ProactiveEngine } from "../src/proactive/index.js";

const OWNER = "10001", MEMBER = "12345678", BOT = "90001", GROUP = "40001";
const BASE = Date.parse("2026-10-14T08:00:00+08:00");
const PHONE = "手机观察：2026-10-14 08:00，电量 32%，刚接上充电器。观察不代表睡眠或情绪。";
type Task = Parameters<Gateway["enqueueSend"]>[0];
type Step = ChatResult | ((signal?: AbortSignal) => Promise<ChatResult>);
const answer = (content: string): ChatResult => ({ content, toolCalls: [], finishReason: "stop" });
async function flush() { for (let index = 0; index < 64; index++) await Promise.resolve(); }

function fixture(t: TestContext, settings: { steps?: Step[]; presence?: PhoneContextProvider; pokeBack?: boolean; tools?: ToolDef[] } = {}) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: BASE });
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "acct";
  cfg.groups.allowlist = [GROUP];
  cfg.groups.linkPreview = false;
  cfg.groups.conversation = { enabled: true, ownerAliases: ["阿盏"], wakeAliases: ["乌鸦"],
    ownerWakeAliases: [{ userId: OWNER, aliases: ["鸦鸦", "黑羽", "小渡"] }], observerCooldownMs: 30_000 };
  cfg.tools.enabled = true;
  cfg.tools.ownerIds = [OWNER];
  cfg.admins = [OWNER];
  cfg.groups.maxReplyChars = 10_000;
  cfg.model.maxOutputChars = 10_000;
  const steps = [...settings.steps ?? []];
  const calls: { messages: ChatMessage[]; tools?: ToolSpec[]; signal?: AbortSignal; phoneContextReceipt?: PhoneContextReceipt }[] = [];
  const llm: LLMClient = { async chat(messages, options) {
    calls.push({ messages: structuredClone(messages), tools: options?.tools && structuredClone(options.tools), signal: options?.signal,
      phoneContextReceipt: options?.phoneContextReceipt });
    const next = steps.shift();
    return typeof next === "function" ? next(options?.signal) : next ?? answer(`本条只回应眼前召唤，第${calls.length}次。`);
  } };
  const ingested: MessageRecord[] = [];
  const memory = { ingest: (message: MessageRecord) => ingested.push(message), retrieve: () => [], recentContextSummary: () => "" } as unknown as MemoryProvider;
  const sent: Task[] = [];
  const gateway = {
    getProvider: () => ({ health: () => ({ selfId: BOT, connection: "connected", login: "online", reconnectCount: 0 }),
      capabilities: () => ({ sendPoke: settings.pokeBack === false ? "unsupported" : "unverified" }),
      ...(settings.pokeBack === false ? {} : { sendPoke: async () => { assert.fail("Agent 应持久排队，不能直接调用真实投递 API"); } }) }),
    enqueueSend(task: Task) {
      const queued = db.enqueueSendTask(task);
      if (!queued.reused) sent.push(task);
      return queued;
    },
  } as unknown as Gateway;
  const agent = new Agent({ db, cfg, llm, gateway, memory, search: null, reader: null,
    mcp: { getTools: () => settings.tools ?? [] } as unknown as McpManager, presence: settings.presence, timezone: cfg.timezone });
  let serial = 0;
  const message = (text: string, patch: Partial<MessageRecord> = {}): MessageRecord => {
    t.mock.timers.tick(1);
    const id = String(++serial), time = new Date().toISOString();
    return { eventKey: `message:${id}`, accountId: "acct", providerId: "onebot", conversationId: `group_${GROUP}`, groupId: GROUP,
      messageId: id, senderId: MEMBER, displayNameAtTime: "群友", sentAt: time, receivedAt: time,
      segments: [{ type: "text", data: { text } }], textContent: text, status: "active", origin: "live", ...patch };
  };
  const ownerPrivate = (text: string) => message(text, { senderId: OWNER, groupId: undefined, conversationId: `private_${OWNER}` });
  const poke = (patch: Partial<PokeEvent> = {}): PokeEvent => {
    t.mock.timers.tick(1);
    const id = String(++serial), time = new Date().toISOString();
    return { kind: "poke", eventKey: `poke:${id}`, accountId: "acct", providerId: "onebot", conversationId: `group_${GROUP}`,
      groupId: GROUP, userId: OWNER, targetId: BOT, sentAt: time, receivedAt: time, origin: "live", ...patch };
  };
  const startMessage = (record: MessageRecord) => {
    db.insertMessage(record);
    return (agent as unknown as { onMessage(record: MessageRecord): Promise<void> }).onMessage(record);
  };
  const startPoke = (event: PokeEvent) => (agent as unknown as { onPoke(event: PokeEvent): Promise<void> }).onPoke(event);
  const runMessage = async (record: MessageRecord) => { const pending = startMessage(record); await flush(); t.mock.timers.tick(1200); await pending; await flush(); };
  const immediatePoke = async (event: PokeEvent) => {
    const before = calls.length, time = Date.now();
    const pending = startPoke(event);
    await flush();
    assert.equal(calls.length, before + 1, "戳召唤无需等待 1200ms 环境合并窗口");
    assert.equal(Date.now(), time);
    await pending;
    await flush();
  };
  const fillWindow = async () => {
    for (let index = 0; index < 3; index++) {
      if (index) t.mock.timers.tick(31_000);
      await runMessage(message(`环境话题第${index}项`, { senderId: `1234567${index}` }));
    }
    assert.equal(calls.length, 3);
    assert.equal(sent.length, 3);
  };
  return { db, cfg, llm, agent, gateway, calls, ingested, sent, message, ownerPrivate, poke, startMessage, startPoke, runMessage, immediatePoke, fillWindow };
}

test("戳召唤：冷却且十分钟环境配额已满，仍立即生成并安排一个来源绑定反戳；不伪造引用或记忆", async t => {
  const f = fixture(t);
  await f.fillWindow();
  const messagesBefore = f.db.recentMessages(`group_${GROUP}`, 100).length;
  const ingestsBefore = f.ingested.length;
  const event = f.poke();
  await f.immediatePoke(event);
  assert.equal(f.calls.length, 4);
  assert.equal(f.sent.length, 5);
  const [pokeTask, textTask] = f.sent.slice(-2);
  assert.equal(pokeTask!.kind, "poke");
  assert.deepEqual(pokeTask!.payload, { kind: "poke", userId: OWNER, requesterId: OWNER, accountId: "acct", sourceEventKey: event.eventKey,
    expiresAt: new Date(Date.parse(event.receivedAt) + 60_000).toISOString() });
  assert.equal(textTask!.payload.kind, "segments");
  if (textTask!.payload.kind === "segments") {
    assert.equal(textTask!.payload.replyKind, "direct");
    assert.equal(textTask!.payload.segments.some(segment => segment.type === "reply"), false, "通知没有可供QQ引用的消息号");
  }
  assert.equal(f.db.recentMessages(`group_${GROUP}`, 100).length, messagesBefore);
  assert.equal(f.ingested.length, ingestsBefore);
});

test("戳召唤：同通知只回复和反戳一次，私聊也进入直接通道", async t => {
  const f = fixture(t);
  const event = f.poke();
  await f.immediatePoke(event);
  await f.startPoke(event);
  assert.equal(f.calls.length, 1);
  assert.equal(f.sent.length, 2);
  const privateEvent = f.poke({ groupId: undefined, conversationId: `private_${OWNER}` });
  await f.immediatePoke(privateEvent);
  assert.equal(f.calls.length, 2);
  assert.equal(f.sent.length, 4);
  assert.deepEqual(f.sent.slice(-2).map(task => [task.conversationType, task.targetId]), [["private", OWNER], ["private", OWNER]]);
  assert.equal(f.ingested.length, 0);
  assert.equal(f.db.recentMessages(`private_${OWNER}`, 10).length, 0);
});

test("戳召唤：其他人互戳、自戳、非允许群、错误账号及黑名单全部无模型无反戳", async t => {
  const f = fixture(t);
  for (const event of [f.poke({ userId: BOT }), f.poke({ targetId: MEMBER }), f.poke({ accountId: "other" }),
    f.poke({ groupId: "999999", conversationId: "group_999999" }), f.poke({ conversationId: "private_123456" })]) await f.startPoke(event);
  f.db.blockUser("acct", MEMBER, "attack");
  await f.startPoke(f.poke({ userId: MEMBER }));
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.ingested.length, 0);
});

test("戳召唤：接入没有反戳能力仍及时文字回应，并不宣称已戳回", async t => {
  const f = fixture(t, { pokeBack: false });
  await f.immediatePoke(f.poke());
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.payload.kind, "segments");
  assert.match(String(f.calls[0]!.messages[1]!.content), /当前接入不能戳回.*不声称已经戳回/s);
});

test("戳召唤：不能继承旧工具待办，模型捏造攻击也不能把无正文的戳者拉黑", async t => {
  let executed = 0;
  const fakeTool: ToolDef = { name: "cn_search", description: "搜索", inputSchema: { type: "object" }, async execute() { executed++; return "bad"; } };
  const f = fixture(t, { tools: [fakeTool], steps: [
    { content: "", toolCalls: [{ id: "fake-ban", name: "conversation_action", arguments: '{"action":"blacklist","reason":"模型幻觉"}' }], finishReason: "tool_calls" },
    answer("碰到了，回你一声。"),
  ] });
  await f.startPoke(f.poke({ userId: MEMBER }));
  assert.equal(f.calls.length, 2);
  assert.equal(f.db.isUserBlocked("acct", MEMBER), false);
  // Owner normally has the business-tool permissions. A poke alone still
  // carries no new document/search request, even when an old task is nearby.
  await f.immediatePoke(f.poke({ userId: OWNER }));
  assert.equal(f.calls.length, 3);
  assert.equal(executed, 0);
  for (const call of f.calls) {
    assert.deepEqual(call.tools?.map(tool => tool.function.name), ["conversation_action"]);
    const action = call.tools![0]!.function.parameters as { properties: { action: { enum: string[] } } };
    assert.deepEqual(action.properties.action.enum, ["silent"]);
  }
  assert.equal(f.sent.length, 4);
});

test("戳召唤：戳后喂和口语催搜直接继续，仍跳过环境满额与冷却", async t => {
  const f = fixture(t);
  await f.fillWindow();
  await f.immediatePoke(f.poke());
  const before = f.calls.length;
  for (const text of ["喂。", "你去搜啊", "你完了。"]) {
    const count = f.calls.length;
    const pending = f.startMessage(f.message(text, { senderId: OWNER }));
    await flush();
    assert.equal(f.calls.length, count + 1);
    await pending;
  }
  assert.equal(f.calls.length, before + 3);
  assert.equal(f.sent.at(-1)!.payload.kind, "segments");
  if (f.sent.at(-1)!.payload.kind === "segments") assert.equal(f.sent.at(-1)!.payload.replyKind, "direct");
});

test("戳召唤：抢占正在合并的环境插话，旧任务不迟到发出", async t => {
  const f = fixture(t);
  const old = f.startMessage(f.message("普通环境闲聊"));
  await flush();
  assert.equal(f.calls.length, 0);
  await f.immediatePoke(f.poke());
  t.mock.timers.tick(1200);
  await old;
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.sent.length, 2);
});

test("手机上下文：Agent只读取主人私聊及明确授权群，其他人和未授权群不读缓存", async t => {
  const requested: PhoneContextRequest[] = [];
  const f = fixture(t, { presence: { async context(request) { requested.push(request); return PHONE; } } });
  await f.runMessage(f.ownerPrivate("今天有点忙"));
  assert.deepEqual(requested, [{ senderId: OWNER, conversationType: "private", purpose: "chat" }]);
  assert.match(String(f.calls[0]!.messages[0]!.content), /手机观察.*32%/s);
  await f.runMessage(f.message("鸦鸦", { senderId: OWNER }));
  await f.runMessage(f.message("私聊问候", { groupId: undefined, conversationId: `private_${MEMBER}` }));
  assert.equal(requested.length, 1);
  for (const call of f.calls.slice(1)) assert.equal(JSON.stringify(call.messages).includes(PHONE), false);
  f.cfg.presence = { enabled: true, ownerId: OWNER, allowedGroupIds: [GROUP], supabaseUrl: "https://example.supabase.co", serverKey: "fixture-only",
    deviceId: "fixture-phone", requestTimeoutMs: 1000, cacheTtlMs: 1000, staleRetentionMs: 10000 };
  await f.runMessage(f.message("鸦鸦", { senderId: OWNER }));
  assert.deepEqual(requested.at(-1), { senderId: OWNER, conversationType: "group", groupId: GROUP, purpose: "chat" });
  assert.ok(JSON.stringify(f.calls.at(-1)!.messages).includes(PHONE));
  const reads = requested.length;
  await f.runMessage(f.message("鸦鸦", { senderId: MEMBER }));
  assert.equal(requested.length, reads);
  f.cfg.presence.allowedGroupIds = [];
  await f.runMessage(f.message("鸦鸦", { senderId: OWNER }));
  assert.equal(requested.length, reads);
  assert.equal(JSON.stringify(f.calls.at(-1)!.messages).includes(PHONE), false);
});

test("手机上下文：读取失败时普通私聊继续回复，不转成模型错误通知", async t => {
  const f = fixture(t, { presence: { async context() { throw new Error("Supabase temporarily unavailable"); } } });
  await f.runMessage(f.ownerPrivate("给我一句鼓励"));
  assert.equal(f.calls.length, 1);
  assert.equal(f.sent.length, 1);
  const task = f.sent[0]!;
  if (task.payload.kind === "segments") assert.match(task.payload.segments.filter(segment => segment.type === "text").map(segment => segment.data.text).join(""), /本条只回应/);
});

test("手机上下文：实际附加的观察才传递脱敏回执，工具各轮复用；授权群也传递", async t => {
  const receipt: PhoneContextReceipt = {source:"device_events", purpose:"chat", contextChars:PHONE.length,
    fieldCount:2, newestObservedAt:new Date(BASE).toISOString(), oldestObservedAt:new Date(BASE).toISOString(),
    freshFieldCount:2, staleFieldCount:0};
  let reads = 0;
  const f = fixture(t, {presence:{async context() { assert.fail("优先使用上下文与回执一起读取的接口"); },
    async contextResult() { reads++; return {context:PHONE,receipt}; }},
    tools:[{name:"mcp__fake__check", description:"read-only fixture", parameters:{type:"object"}, async execute() { return "checked"; }}],
    steps:[{content:"",finishReason:"tool_calls",toolCalls:[{id:"check-1",name:"mcp__fake__check",arguments:"{}"}]},answer("已核对") ]});
  await f.runMessage(f.ownerPrivate("请核对一下"));
  assert.equal(reads,1);
  assert.equal(f.calls.length,2);
  for(const call of f.calls) {
    assert.equal(call.phoneContextReceipt,receipt);
    assert.ok(JSON.stringify(call.messages).includes(PHONE));
  }
  await f.runMessage(f.message("鸦鸦",{senderId:OWNER}));
  assert.equal(reads,1);
  assert.equal(f.calls.at(-1)!.phoneContextReceipt,undefined);
  f.cfg.presence = { enabled: true, ownerId: OWNER, allowedGroupIds: [GROUP], supabaseUrl: "https://example.supabase.co", serverKey: "fixture-only",
    deviceId: "fixture-phone", requestTimeoutMs: 1000, cacheTtlMs: 1000, staleRetentionMs: 10000 };
  await f.runMessage(f.message("鸦鸦",{senderId:OWNER}));
  assert.equal(reads,2);
  assert.equal(f.calls.at(-1)!.phoneContextReceipt,receipt);
});

test("手机上下文：空上下文不提交回执，避免把读取回执冒充实际模型输入", async t => {
  const f = fixture(t,{presence:{async context() { return ""; },async contextResult() {
    return {context:"",receipt:{source:"device_events",purpose:"chat",contextChars:123,fieldCount:1,
      newestObservedAt:new Date(BASE).toISOString(),oldestObservedAt:new Date(BASE).toISOString(),freshFieldCount:1,staleFieldCount:0}};
  }}});
  await f.runMessage(f.ownerPrivate("今天怎么样"));
  assert.equal(f.calls[0]!.phoneContextReceipt,undefined);
});

test("手机上下文：主动私聊与明确授权的主人群问候加入临时观察，未授权群不读取；不写入记忆或启用工具", async t => {
  const requested: PhoneContextRequest[] = [];
  const f = fixture(t, { presence: { async context(request) { requested.push(request); return PHONE; } } });
  const receipt: PhoneContextReceipt = {source:"device_events",purpose:"proactive",contextChars:PHONE.length,
    fieldCount:2,newestObservedAt:new Date(BASE).toISOString(),oldestObservedAt:new Date(BASE).toISOString(),freshFieldCount:2,staleFieldCount:0};
  f.cfg.proactive = { enabled: true, recipientId: OWNER, groupId: GROUP, randomEnabled: true,
    morningEnabled: false, morningTime: "07:00", activeStart: "08:00", activeEnd: "23:00", includeDraw: false,
    weatherAlertsEnabled: false, weatherCheckMinutes: 15, weatherAlertCooldownMinutes: 120, coolingThresholdC: 5, maxMessageChars: 800 };
  const engine = new ProactiveEngine({ db: f.db, cfg: f.cfg, gateway: f.gateway, llm: f.llm, weather: null,
    presence: { async context() { assert.fail("使用上下文与回执接口"); },
      async contextResult(request) {requested.push(request);return {context:PHONE,receipt};} }, now: () => Date.now(), random: () => 0.5 });
  t.after(() => engine.stop());
  const greeting = (engine as unknown as { greeting(target: { type: "private" | "group"; id: string }, reason: string): Promise<string> }).greeting.bind(engine);
  await greeting({ type: "private", id: OWNER }, "random");
  assert.deepEqual(requested, [{ senderId: OWNER, conversationType: "private", purpose: "proactive" }]);
  assert.equal(JSON.parse(String(f.calls[0]!.messages[1]!.content)).phoneContext, PHONE);
  assert.equal(f.calls[0]!.phoneContextReceipt,receipt);
  await greeting({ type: "group", id: GROUP }, "random");
  assert.equal(requested.length, 1);
  assert.equal(JSON.parse(String(f.calls[1]!.messages[1]!.content)).phoneContext, undefined);
  assert.equal(f.calls[1]!.phoneContextReceipt,undefined);
  assert.equal(JSON.stringify(f.calls[1]!.messages).includes(PHONE), false);
  f.cfg.presence = {enabled:true,allowedGroupIds:[GROUP],ownerId:OWNER,deviceId:"test-phone",
    supabaseUrl:"https://test.supabase.co",serverKey:"test-secret",requestTimeoutMs:100,cacheTtlMs:30000,staleRetentionMs:86400000};
  await greeting({type:"group",id:GROUP},"random");
  assert.deepEqual(requested[1], {senderId:OWNER,conversationType:"group",groupId:GROUP,purpose:"proactive"});
  assert.equal(JSON.parse(String(f.calls[2]!.messages[1]!.content)).phoneContext, PHONE);
  assert.equal(f.calls[2]!.phoneContextReceipt,receipt);
  await greeting({type:"group",id:"not-authorized"},"random");
  assert.equal(requested.length,2);
  assert.equal(JSON.parse(String(f.calls[3]!.messages[1]!.content)).phoneContext,undefined);
  assert.equal(f.calls[3]!.phoneContextReceipt,undefined);
  assert.equal(f.calls.every(call => call.tools?.length === 0), true);
  assert.equal(f.sent.length, 0, "greeting 测试不启动定时或投递");
  assert.equal(f.db.recentMessages(`private_${OWNER}`, 10).length, 0);
  assert.equal(f.db.recentMemories("acct", GROUP, 10).length, 0);
});

test("手机上下文：主动读取失败仍产生原有问候", async t => {
  const f = fixture(t);
  f.cfg.proactive = { enabled: true, recipientId: OWNER, randomEnabled: true, morningEnabled: false,
    morningTime: "07:00", activeStart: "08:00", activeEnd: "23:00", includeDraw: false,
    weatherAlertsEnabled: false, weatherCheckMinutes: 15, weatherAlertCooldownMinutes: 120, coolingThresholdC: 5, maxMessageChars: 800 };
  const engine = new ProactiveEngine({ db: f.db, cfg: f.cfg, gateway: f.gateway, llm: f.llm, weather: null,
    presence: { async context() { throw new Error("telemetry unavailable"); } } });
  t.after(() => engine.stop());
  const text = await (engine as unknown as { greeting(target: { type: "private"; id: string }, reason: string): Promise<string> }).greeting({ type: "private", id: OWNER }, "random");
  assert.match(text, /本条只回应/);
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(String(f.calls[0]!.messages[1]!.content)).phoneContext, undefined);
});
