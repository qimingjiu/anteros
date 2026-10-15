import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { loadConfig, type ProactiveConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import type { Gateway } from "../src/gateway/index.js";
import type { ChatMessage, ChatResult, LLMClient, ToolSpec } from "../src/llm/index.js";
import { ProactiveEngine } from "../src/proactive/index.js";
import type { McpManager } from "../src/tools/mcp.js";
import type { WeatherSnapshot } from "../src/tools/weather.js";
import type { MessageRecord, ToolDef } from "../src/types.js";

const OWNER = "10001", ACCOUNT = "skip-test", GROUP = "100";
const at = (time: string) => Date.parse(`2026-10-13T${time}:00+08:00`);
const answer = (): ChatResult => ({ content: "好，这一轮先安静，你找我照常回。", toolCalls: [], finishReason: "stop" });

function fixture(t: TestContext, patch: Partial<ProactiveConfig> = {}, start = at("08:00")) {
  const db = new Database(":memory:");
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = ACCOUNT;
  cfg.tools.ownerIds = [OWNER];
  cfg.persona.name = "κόραξ";
  cfg.groups.allowlist = [GROUP];
  cfg.groups.linkPreview = false;
  cfg.proactive = { enabled: true, recipientId: OWNER, groupId: GROUP, randomEnabled: true,
    morningEnabled: false, morningTime: "07:00", activeStart: "08:00", activeEnd: "23:00", includeDraw: false,
    weatherAlertsEnabled: false, weatherCheckMinutes: 15, weatherAlertCooldownMinutes: 120, coolingThresholdC: 5,
    maxMessageChars: 800, ...patch };
  let now = start, rolls = 0, weatherCalls = 0;
  const calls: { messages: ChatMessage[]; tools?: ToolSpec[] }[] = [];
  const model = { respond: async (): Promise<ChatResult> => answer() };
  const llm: LLMClient = { chat: async (messages, options) => {
    calls.push({ messages: structuredClone(messages), tools: options?.tools && structuredClone(options.tools) });
    return model.respond();
  } };
  const weather = { getForecast: async () => {
    weatherCalls++;
    return { location: { name: "长沙市" }, current: { time: new Date(now).toISOString(), tempC: 20, feelsLikeC: 20, condition: "多云", windKph: 5 },
      daily: [], hourly: [], minutely15: [], alerts: { rainInNext2Hours: true, rainTotalMm: 1, rainProbabilityPct: 80, texts: [] },
      clothingAdvice: [], precision: "小时插值预报", attribution: "Open-Meteo", source: { url: "https://open-meteo.com/" } } as WeatherSnapshot;
  } };
  const gateway = { getProvider: () => ({ health: () => ({ selfId: "bot", connection: "connected", login: "online", reconnectCount: 0 }) }),
    enqueueSend: (task: Parameters<Gateway["enqueueSend"]>[0]) => db.enqueueSendTask(task) } as unknown as Gateway;
  const engines: ProactiveEngine[] = [];
  const restart = () => {
    const engine = new ProactiveEngine({ db, cfg, gateway, llm, weather, now: () => now,
      random: () => [0.95, 0.2, 0.15, 0.1, 0.05][rolls++ % 5]! });
    engines.push(engine);
    return engine;
  };
  const engine = restart();
  t.after(async () => { for (const e of engines) await e.stop(); db.close(); });
  const key = `proactive:v1:${ACCOUNT}:${OWNER}`;
  const state = () => JSON.parse(db.kvGet(key)!);
  const tasks = () => db.recentSendTasks(100).reverse();
  return { db, cfg, gateway, llm, engine, restart, calls, model, key, state, tasks,
    setTime: (time: number) => { now = time; }, weatherCalls: () => weatherCalls, diceCalls: () => rolls };
}

test("跳过主动消息：立即静默，下一到期槽重抽间隔，无模型/天气/路由推进，之后自然恢复", async t => {
  const f = fixture(t);
  await f.engine.tick();
  f.engine.control("skip_once");
  f.setTime(at("08:04")); await f.engine.tick();
  assert.equal(f.state().skipNext, true);
  assert.equal(f.state().pool.round, 1);
  f.setTime(at("08:05")); await f.engine.tick();
  assert.equal(f.state().skipNext, false);
  assert.equal(f.state().silenceUntil, at("08:10"));
  assert.equal(f.state().nextRandomAt, at("08:10"));
  assert.equal(f.state().pool.round, 2);
  assert.equal(f.state().routeIndex, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.weatherCalls(), 0);
  assert.equal(f.tasks().length, 0);
  f.setTime(at("08:09")); await f.engine.tick();
  assert.equal(f.tasks().length, 0);
  f.setTime(at("08:10")); await f.engine.tick();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.tasks()[0]!.conversation_type, "private");
  assert.equal(f.tasks()[0]!.target_id, OWNER);
  assert.equal(f.state().routeIndex, 1);
});

test("跳过主动消息：重启保留待跳过及新的静默截止，不会提前补发", async t => {
  const f = fixture(t);
  f.engine.control("skip_once");
  const pending = f.restart();
  f.setTime(at("08:05")); await pending.tick();
  assert.equal(f.tasks().length, 0);
  assert.equal(f.state().silenceUntil, at("08:10"));
  const quiet = f.restart();
  f.setTime(at("08:09")); await quiet.tick();
  assert.equal(f.tasks().length, 0);
  f.setTime(at("08:10")); await quiet.tick();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.state().routeIndex, 1);
});

test("跳过主动消息：只取消本计划已排队主动任务，普通回复与其他计划不受影响", async t => {
  const f = fixture(t);
  await f.engine.tick();
  f.setTime(at("08:05")); await f.engine.tick();
  const own = f.tasks()[0]!;
  const normal = f.db.enqueueSendTask({ taskKey: "ordinary", kind: "reply", conversationType: "private", targetId: OWNER, payload: {} });
  const other = f.db.enqueueSendTask({ taskKey: "proactive:v1:other:4444444:random:1", kind: "proactive_random", conversationType: "private", targetId: "4444444", payload: {} });
  f.engine.control("skip_once");
  assert.equal(f.db.sendTaskById(own.id)!.status, "failed");
  assert.equal(f.db.sendTaskById(normal.id)!.status, "queued");
  assert.equal(f.db.sendTaskById(other.id)!.status, "queued");
});

test("跳过主动消息：静默时段不能消耗旧随机/天气到期，07点早安可以消耗且不补发", async t => {
  const f = fixture(t, { morningEnabled: true, weatherAlertsEnabled: true }, at("06:59"));
  f.engine.control("skip_once");
  await f.engine.tick();
  assert.equal(f.state().skipNext, true);
  assert.equal(f.state().pool.round, 1);
  f.setTime(at("07:00")); await f.engine.tick();
  assert.equal(f.state().skipNext, false);
  assert.equal(f.state().lastMorningDate, "2026-10-13");
  assert.equal(f.state().silenceUntil, at("08:00"));
  assert.equal(f.weatherCalls(), 0);
  assert.equal(f.calls.length, 0);
  f.setTime(at("07:59")); await f.engine.tick();
  assert.equal(f.tasks().length, 0);
  f.setTime(at("08:00")); await f.engine.tick();
  assert.equal(f.tasks().some(task => task.kind === "proactive_morning"), false);
  assert.ok(f.tasks().some(task => task.kind === "proactive_random"));
});

test("跳过主动消息：随机关闭时等待真正开放的天气槽，静默不消费提醒额度", async t => {
  const f = fixture(t, { randomEnabled: false, weatherAlertsEnabled: true }, at("02:00"));
  f.engine.control("skip_once");
  await f.engine.tick();
  assert.equal(f.state().skipNext, true);
  assert.equal(f.weatherCalls(), 0);
  f.setTime(at("08:00")); await f.engine.tick();
  assert.equal(f.state().skipNext, false);
  assert.equal(f.state().silenceUntil, at("08:05"));
  assert.equal(f.state().lastWeatherAlertAt, 0);
  assert.equal(f.state().rainEpisodeUntil, 0);
  assert.equal(f.weatherCalls(), 0);
  f.setTime(at("08:05")); await f.engine.tick();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.tasks()[0]!.kind, "proactive_weather_alert");
  assert.equal(f.state().lastWeatherAlertAt, at("08:05"));
});

test("跳过主动消息：待发模型请求遇到skip失效，结束后仍跳过下一槽，不推进旧路由", async t => {
  const f = fixture(t);
  await f.engine.tick();
  let finish!: (answer: ChatResult) => void;
  f.model.respond = () => new Promise(resolve => { finish = resolve; });
  f.setTime(at("08:05"));
  const waiting = f.engine.tick();
  try {
    for (let attempt = 0; attempt < 30 && !finish; attempt++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(finish, "待发模型请求必须已到达假服务");
    f.engine.control("skip_once");
  } finally {
    finish?.(answer());
    await waiting;
  }
  assert.equal(f.tasks().length, 0);
  assert.equal(f.state().skipNext, true);
  assert.equal(f.state().routeIndex, 0);
  assert.equal(f.state().pool.round, 1);
  const calls = f.calls.length, forecasts = f.weatherCalls();
  await f.engine.tick();
  assert.equal(f.state().silenceUntil, at("08:10"));
  assert.equal(f.calls.length, calls);
  assert.equal(f.weatherCalls(), forecasts);
});

test("跳过主动消息：重绘状态保存失败不消耗跳过标志，退避后可以安全重试", async t => {
  const f = fixture(t);
  f.engine.control("skip_once");
  const saved = f.db.kvGet(f.key)!;
  const set = f.db.kvSet.bind(f.db);
  let once = true;
  f.db.kvSet = (key, value) => { if (key === f.key && once) { once = false; throw new Error("fixture save failure"); } set(key, value); };
  f.setTime(at("08:05")); await f.engine.tick();
  assert.equal(f.db.kvGet(f.key), saved);
  assert.equal(f.engine.status().skipNext, true);
  assert.equal(f.engine.status().round, 1);
  f.setTime(at("08:10")); await f.engine.tick();
  assert.equal(f.state().skipNext, false);
  assert.equal(f.state().silenceUntil, at("08:15"));
  assert.equal(f.tasks().length, 0);
});

test("跳过主动消息：重复skip不累计永久静默，不解除暂停，resume清除静默并重排未来", async t => {
  const f = fixture(t);
  f.engine.control("pause");
  f.engine.control("skip_once");
  f.engine.control("skip_once");
  f.setTime(at("09:00")); await f.engine.tick();
  assert.equal(f.state().paused, true);
  assert.equal(f.state().skipNext, true);
  f.engine.control("resume");
  assert.equal(f.state().paused, false);
  assert.equal(f.state().skipNext, false);
  assert.equal(f.state().silenceUntil, 0);
  assert.equal(f.state().nextRandomAt, at("09:05"));
  await f.engine.tick();
  assert.equal(f.tasks().length, 0);
});

test("主人闭嘴指令：真实Agent路径立即持久化skip，模型只生成确认，不需要调用工具", async t => {
  const f = fixture(t);
  const agent = new Agent({ db: f.db, cfg: f.cfg, gateway: f.gateway, llm: f.llm, memory: null, search: null, reader: null,
    mcp: { getTools: () => [] } as unknown as McpManager, proactiveEngine: f.engine, timezone: f.cfg.timezone }) as unknown as { onMessage(m: MessageRecord): Promise<void> };
  const message: MessageRecord = { eventKey: "stop:1", accountId: ACCOUNT, providerId: "fake", conversationId: "group_100", groupId: GROUP,
    messageId: "1", senderId: OWNER, displayNameAtTime: "主人", sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
    segments: [{ type: "text", data: { text: "κόραξ，闭嘴" } }], textContent: "κόραξ，闭嘴", status: "active", origin: "live" };
  await agent.onMessage(message);
  assert.equal(f.state().skipNext, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]!.tools, []);
  assert.match(String(f.calls[0]!.messages[0]!.content), /已经生效|不受影响/);
  const task = f.tasks()[0]!;
  assert.equal(task.kind, "reply");
  const content = JSON.parse(task.payload);
  assert.deepEqual(content.segments.map((s: { type: string }) => s.type), ["text"]);
});

test("主人闭嘴指令：普通聊天、工具权限、否定和转述不被误判；其他人不能skip", async t => {
  const f = fixture(t);
  const tool: ToolDef = { name: "mcp__fixture__owner", description: "fixture", inputSchema: { type: "object" }, execute: async () => "unused" };
  const controls: string[] = [];
  const original = f.engine.control.bind(f.engine);
  f.engine.control = action => { controls.push(action); return original(action); };
  const agent = new Agent({ db: f.db, cfg: f.cfg, gateway: f.gateway, llm: f.llm, memory: null, search: null, reader: null,
    mcp: { getTools: () => [tool] } as unknown as McpManager, proactiveEngine: f.engine, timezone: f.cfg.timezone }) as unknown as {
      onMessage(m: MessageRecord): Promise<void>; enqueuePrivateReply(m: MessageRecord): Promise<void>; availableTools(m: MessageRecord): ToolDef[];
    };
  const regular: MessageRecord[] = [];
  agent.enqueuePrivateReply = async m => { regular.push(m); };
  let serial = 0;
  const msg = (text: string, patch: Partial<MessageRecord> = {}): MessageRecord => ({ eventKey: `skipguard:${++serial}`, accountId: ACCOUNT, providerId: "fake",
    conversationId: `private_${OWNER}`, messageId: String(serial), senderId: OWNER, displayNameAtTime: "主人",
    sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(), segments: [{ type: "text", data: { text } }],
    textContent: text, status: "active", origin: "live", ...patch });
  for (const text of ["不要闭嘴", "他让我闭嘴", "为什么你总说闭嘴", "闭嘴是什么意思", "今天想聊点别的"]) await agent.onMessage(msg(text));
  await agent.onMessage(msg("闭嘴", { senderId: "ordinary-user" }));
  const eligibleReplies = regular.length;
  for (const patch of [{ accountId: "other-account" }, { origin: "backfill" as const }, { status: "recalled" as const }]) {
    await agent.onMessage(msg("闭嘴", patch));
    assert.equal(regular.length, eligibleReplies, "跨账号、回填与撤回消息不能进入回复或主动消息控制");
  }
  await agent.onMessage(msg("闭嘴", { groupId: "999", conversationId: "group_999" }));
  assert.equal(controls.length, 0);
  assert.equal(regular.length, 6);
  assert.equal(f.calls.length, 0);
  f.engine.control("skip_once");
  const owner = msg("继续聊天");
  assert.ok(agent.availableTools(owner).some(def => def.name === tool.name));
  assert.ok(!agent.availableTools(msg("继续聊天", { senderId: "ordinary-user" })).some(def => def.name === tool.name));
  await agent.onMessage(owner);
  assert.equal(regular.at(-1), owner);
  assert.equal(f.state().skipNext, true);
});
