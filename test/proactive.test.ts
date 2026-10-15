import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { loadConfig, type ProactiveConfig } from "../src/config.js";
import { Database, type DBRow_SendTask } from "../src/db/index.js";
import type { Gateway, SendPayload } from "../src/gateway/index.js";
import type { ChatMessage, ChatResult, LLMClient, ToolSpec } from "../src/llm/index.js";
import { ProactiveEngine } from "../src/proactive/index.js";
import { stripProactiveSchedulingDetails } from "../src/proactive/content.js";
import { drawInterval, renderDraw } from "../src/proactive/interval-pool.js";
import { activeWindowEnd, isActiveAt, localClock, nextActiveAt } from "../src/proactive/time.js";
import type { WeatherSnapshot } from "../src/tools/weather.js";
import type { MessageRecord } from "../src/types.js";

const OWNER = "1111111", BOT = "2222222", GROUP = "3333333", OTHER = "4444444";
const ACCOUNT = "proactive-test-account";
const ZONE = "Asia/Shanghai";
const MINUTE = 60_000;
const simPath = fileURLToPath(new URL("../config.sim.yaml", import.meta.url));
const at = (time: string, day = "2026-10-13") => Date.parse(`${day}T${time}:00+08:00`);
const answer = (content = "给你留一句今天的小问候。"): ChatResult => ({ content, toolCalls: [], finishReason: "stop" });
function sampleDraw() {
  let index = 0;
  return drawInterval(undefined, () => [0.95, 0.2, 0.15, 0.1, 0.05][index++ % 5]!);
}

function weatherFixture(timestamp: number, alerts: Partial<WeatherSnapshot["alerts"]> = {}): WeatherSnapshot {
  const iso = new Date(timestamp).toISOString();
  const day = localClock(timestamp, ZONE).date;
  return {
    location: { name: "长沙市", latitude: 28.19874, longitude: 112.97087, timezone: ZONE, countryCode: "CN", admin1: "湖南" },
    fetchedAt: iso,
    current: { time: iso, tempC: 21, feelsLikeC: 20, weatherCode: 3, condition: "阴", precipitationMm: 0, rainMm: 0, windKph: 8 },
    daily: [
      { date: day, tempMaxC: 24, tempMinC: 17, precipProbabilityPct: 20, precipitationMm: 0, weatherCode: 3, condition: "阴", sunrise: null, sunset: null },
      { date: localClock(timestamp + 24 * 60 * MINUTE, ZONE).date, tempMaxC: 23, tempMinC: 16, precipProbabilityPct: 30, precipitationMm: 0, weatherCode: 2, condition: "多云", sunrise: null, sunset: null },
    ],
    hourly: [], minutely15: [],
    alerts: { rainInNext2Hours: false, rainTotalMm: 0, texts: [], ...alerts },
    clothingAdvice: ["薄长袖，早晚带一件薄外套。"],
    precision: "中国15分钟降水为小时预报插值，不能保证准确起止分钟。",
    attribution: "来源：Open-Meteo 预报，CC BY 4.0。",
    source: { name: "Open-Meteo", url: "https://open-meteo.com/", model: "best_match", currentDataKind: "modelled", gridLatitude: 28.2, gridLongitude: 112.95, licenseUrl: "https://creativecommons.org/licenses/by/4.0/" },
  };
}

class FakeLLM implements LLMClient {
  calls: { messages: ChatMessage[]; tools: ToolSpec[] | undefined }[] = [];
  respond: () => Promise<ChatResult> = async () => answer();
  async chat(messages: ChatMessage[], opts?: { tools?: ToolSpec[] }): Promise<ChatResult> {
    this.calls.push({ messages: structuredClone(messages), tools: opts?.tools && structuredClone(opts.tools) });
    return this.respond();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 30; i++) {
    if (condition()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(condition(), "异步测试请求应当已经到达假服务");
}

function fixture(t: TestContext, overrides: Partial<ProactiveConfig> = {}, initialTime = at("08:00")) {
  const db = new Database(":memory:");
  const cfg = loadConfig(simPath);
  cfg.timezone = ZONE;
  cfg.gateway.accountId = ACCOUNT;
  cfg.groups.allowlist = [GROUP];
  cfg.tools.ownerIds = [OWNER];
  cfg.persona.prompt = "你是负责陪伴指定主人的QQ机器人。";
  cfg.weather = { enabled: true, defaultLocation: "长沙市", latitude: 28.19874, longitude: 112.97087, timezone: ZONE, requestTimeoutMs: 1000, cacheTtlMs: 0 };
  cfg.proactive = {
    enabled: true, recipientId: OWNER, groupId: GROUP, randomEnabled: true,
    morningEnabled: false, morningTime: "07:00", activeStart: "08:00", activeEnd: "23:00",
    includeDraw: true, weatherAlertsEnabled: false, weatherCheckMinutes: 15,
    weatherAlertCooldownMinutes: 120, coolingThresholdC: 5, maxMessageChars: 800,
    ...overrides,
  };
  let timestamp = initialTime;
  let diceCalls = 0;
  // Five different dice: 急急星人 wins even after its weight is halved.
  const dice = [0.95, 0.2, 0.15, 0.1, 0.05];
  const random = () => dice[diceCalls++ % dice.length]!;
  const llm = new FakeLLM();
  let weatherCalls = 0;
  let forecast: () => Promise<WeatherSnapshot> = async () => weatherFixture(timestamp);
  const weather = { getForecast: async () => { weatherCalls++; return forecast(); } };
  const health = { selfId: BOT, connection: "connected", login: "online", reconnectCount: 0 };
  const gateway = {
    getProvider: () => ({ health: () => health }),
    enqueueSend: (task: Parameters<Gateway["enqueueSend"]>[0]) => db.enqueueSendTask(task),
  } as unknown as Gateway;
  const engines: ProactiveEngine[] = [];
  const restart = () => {
    const engine = new ProactiveEngine({ db, cfg, gateway, llm, weather, now: () => timestamp, random });
    engines.push(engine);
    return engine;
  };
  const engine = restart();
  t.after(async () => { for (const instance of engines) await instance.stop(); db.close(); });
  const key = `proactive:v1:${ACCOUNT}:${OWNER}`;
  const state = () => JSON.parse(db.kvGet(key)!);
  const tasks = (kind?: string) => db.recentSendTasks(100).reverse().filter(row => !kind || row.kind === kind);
  return {
    db, cfg, llm, gateway, engine, restart, key, state, tasks, health,
    now: () => timestamp, setTime: (time: number) => { timestamp = time; },
    get diceCalls() { return diceCalls; }, get weatherCalls() { return weatherCalls; },
    setForecast: (handler: () => Promise<WeatherSnapshot>) => { forecast = handler; },
  };
}

function payload(task: DBRow_SendTask): Extract<SendPayload, { kind: "segments" }> {
  const value = JSON.parse(task.payload) as SendPayload;
  assert.equal(value.kind, "segments");
  if (value.kind !== "segments") throw new Error("主动消息必须是消息段，不能是文件传输");
  return value;
}
function taskText(task: DBRow_SendTask): string {
  const value = payload(task);
  assert.equal(value.kind, "segments");
  return value.kind === "segments" ? value.segments.filter(segment => segment.type === "text").map(segment => segment.data.text).join("") : "";
}

test("主动早安：07:00 精确发送私聊天气，同日重复/重启去重，次日重新发送", async t => {
  const f = fixture(t, { morningEnabled: true, randomEnabled: false }, at("06:59"));
  await f.engine.tick();
  assert.equal(f.tasks().length, 0);
  assert.equal(f.weatherCalls, 0);
  f.setTime(at("07:00"));
  await f.engine.tick();
  assert.equal(f.tasks("proactive_morning").length, 1);
  const morning = f.tasks()[0]!;
  assert.equal(morning.conversation_type, "private");
  assert.equal(morning.target_id, OWNER);
  assert.match(taskText(morning), /长沙市天气/);
  assert.match(taskText(morning), /今天.*明天/s);
  assert.match(taskText(morning), /Open-Meteo/);
  assert.match(taskText(morning), /插值/);
  assert.equal(Date.parse(payload(morning).expiresAt!), at("09:00"));
  await f.engine.tick();
  const restarted = f.restart();
  await restarted.tick();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.llm.calls.length, 1);
  f.setTime(at("07:00", "2026-10-14"));
  await restarted.tick();
  assert.equal(f.tasks().length, 2);
  assert.equal(f.state().lastMorningDate, "2026-10-14");
  assert.notEqual(f.tasks()[0]!.task_key, f.tasks()[1]!.task_key);
});

test("主动早安：错过两小时补发窗口后不补旧早安", async t => {
  const f = fixture(t, { morningEnabled: true, randomEnabled: false }, at("09:00"));
  await f.engine.tick();
  assert.equal(f.tasks().length, 0);
  assert.equal(f.weatherCalls, 0);
});

test("随机问候：跨 23:00 的五分钟间隔顺延到次日 08:00，消息寿命不越静默边界", async t => {
  const f = fixture(t, {}, at("22:58"));
  await f.engine.tick();
  assert.equal(f.state().nextRandomAt, at("08:00", "2026-10-14"));
  f.setTime(at("23:00")); await f.engine.tick();
  f.setTime(at("07:59", "2026-10-14")); await f.engine.tick();
  assert.equal(f.tasks().length, 0);
  f.setTime(at("08:00", "2026-10-14")); await f.engine.tick();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.state().nextRandomAt, at("08:05", "2026-10-14"));
  assert.doesNotMatch(taskText(f.tasks()[0]!), /五位选手|急急星人|权重|分钟后开口/);

  const nearClose = fixture(t, {}, at("22:50"));
  await nearClose.engine.tick();
  nearClose.setTime(at("22:55")); await nearClose.engine.tick();
  assert.equal(Date.parse(payload(nearClose.tasks()[0]!).expiresAt!), at("23:00"));
  assert.equal(nearClose.state().nextRandomAt, at("08:00", "2026-10-14"));
  assert.doesNotMatch(taskText(nearClose.tasks()[0]!), /静默时间|五位选手|权重/);
});

test("随机问候：已到期计划和骰池连胜在重启后保留，不重新抽取延迟", async t => {
  const f = fixture(t);
  await f.engine.tick();
  assert.equal(f.diceCalls, 5);
  assert.equal(f.state().pool.round, 1);
  f.setTime(at("08:05")); await f.engine.tick();
  assert.equal(f.state().pool.round, 2);
  assert.equal(f.state().pool.consecutiveWins, 2);
  f.setTime(at("08:11"));
  const restarted = f.restart();
  await restarted.tick();
  assert.equal(f.tasks().length, 2, "逾期随机计划重启即处理");
  assert.equal(f.diceCalls, 15, "重启只为下一条抽取，不额外初始化骰池");
  assert.equal(f.state().pool.round, 3);
  assert.equal(f.state().pool.lastWinnerId, null, "第三次胜出后重置连胜惩罚");
  assert.equal(f.state().nextRandomAt, at("08:16"));
});

test("随机问候：静默期间发现逾期任务只移至开放时间，重启仍保持新到期时间", async t => {
  const f = fixture(t);
  await f.engine.tick();
  f.setTime(at("23:01")); await f.engine.tick();
  assert.equal(f.tasks().length, 0);
  assert.equal(f.state().nextRandomAt, at("08:00", "2026-10-14"));
  const restarted = f.restart();
  await restarted.tick();
  assert.equal(f.diceCalls, 5);
  f.setTime(at("08:00", "2026-10-14")); await restarted.tick();
  assert.equal(f.tasks().length, 1);
});

test("随机问候：私聊/指定群轮换，群结构化 @ 只有主人，模型没有工具且 CQ 码被清除", async t => {
  const f = fixture(t);
  f.llm.respond = async () => answer("小问候。[CQ:at,qq=4444444]");
  await f.engine.tick();
  for (const time of ["08:05", "08:10", "08:15"]) { f.setTime(at(time)); await f.engine.tick(); }
  assert.deepEqual(f.tasks().map(row => [row.conversation_type, row.target_id]), [
    ["private", OWNER], ["group", GROUP], ["private", OWNER],
  ]);
  const group = payload(f.tasks()[1]!);
  assert.equal(group.kind, "segments");
  if (group.kind === "segments") {
    assert.deepEqual(group.segments.filter(segment => segment.type === "at"), [{ type: "at", data: { qq: OWNER } }]);
  }
  for (const row of f.tasks()) assert.doesNotMatch(taskText(row), /\[CQ:/);
  for (const call of f.llm.calls) assert.deepEqual(call.tools, []);
  assert.equal(f.state().routeIndex, 3);
});

test("群主动消息上下文：仅主人本群公聊与指向主人的机器人回复，不泄露私聊/其他人/账号/群", async t => {
  const f = fixture(t);
  await f.engine.tick();
  let sequence = 0;
  const insert = (text: string, changes: Partial<MessageRecord> = {}) => {
    const id = String(++sequence);
    const sentAt = new Date(at("08:01") + sequence).toISOString();
    const record: MessageRecord = {
      eventKey: `context:${id}`, accountId: ACCOUNT, providerId: "fake", conversationId: `group_${GROUP}`,
      groupId: GROUP, messageId: id, senderId: OWNER, displayNameAtTime: "测试主人", sentAt, receivedAt: sentAt,
      segments: [{ type: "text", data: { text } }], textContent: text, status: "active", origin: "live", ...changes,
    };
    f.db.insertMessage(record);
  };
  insert("PUBLIC_OWNER_TOPIC");
  insert("PUBLIC_BOT_TO_OWNER\n\n" + renderDraw(sampleDraw()),
    { senderId: BOT, segments: [{ type: "at", data: { qq: OWNER } }, { type: "text", data: { text: "PUBLIC_BOT_TO_OWNER" } }] });
  insert("SECRET_BOT_TO_OTHER", { senderId: BOT, segments: [{ type: "at", data: { qq: OTHER } }] });
  insert("SECRET_HUMAN_OTHER", { senderId: OTHER });
  insert("SECRET_PRIVATE_HISTORY", { conversationId: `private_${OWNER}`, groupId: undefined });
  insert("SECRET_OTHER_GROUP", { conversationId: "group_5555555", groupId: "5555555" });
  insert("SECRET_OTHER_ACCOUNT", { accountId: "other-account" });
  insert("SECRET_RECALLED", { status: "recalled" });
  insert("SECRET_TOO_OLD", { sentAt: new Date(at("08:00") - 8 * 24 * 60 * MINUTE).toISOString() });
  insert("SECRET_FUTURE_MESSAGE", { sentAt: new Date(at("08:30")).toISOString() });
  const fact = (statement: string, changes = {}) => f.db.insertMemory({ accountId: ACCOUNT, groupId: GROUP, kind: "fact", subjectUserId: OWNER,
    statement, narratorId: OWNER, sourceSentAt: new Date(at("08:01")).toISOString(), status: "confirmed", confidence: 1, ...changes });
  fact("PUBLIC_OWNER_CONFIRMED_FACT");
  fact("SECRET_OTHER_SUBJECT", { subjectUserId: OTHER });
  fact("SECRET_OTHER_NARRATOR", { narratorId: OTHER });
  fact("SECRET_UNCONFIRMED", { status: "candidate" });
  fact("SECRET_OTHER_GROUP_FACT", { groupId: "5555555" });
  fact("SECRET_OTHER_ACCOUNT_FACT", { accountId: "other-account" });
  fact("SECRET_PRIVATE_FACT", { groupId: `private_${OWNER}` });
  f.setTime(at("08:05")); await f.engine.tick();
  f.setTime(at("08:10")); await f.engine.tick();
  const groupCall = f.llm.calls[1]!;
  const request = JSON.parse(groupCall.messages[1]!.content as string);
  assert.equal(request.venue, "group");
  assert.equal(request.ownerId, OWNER);
  assert.deepEqual(request.context.recent.map((row: { text: string }) => row.text), ["PUBLIC_OWNER_TOPIC", "PUBLIC_BOT_TO_OWNER"]);
  assert.deepEqual(request.context.confirmedOwnerFacts.map((row: { statement: string }) => row.statement), ["PUBLIC_OWNER_CONFIRMED_FACT"]);
  assert.doesNotMatch(JSON.stringify(groupCall.messages), /SECRET_/);
  assert.doesNotMatch(JSON.stringify(groupCall.messages[1]), /急急星人|权重|赢了|分钟后开口/);
});

test("主动消息过滤：所有旧比赛模板与平点重摇均删除，保留正常问候和天气来源", () => {
  const draw = {...sampleDraw(), attempts: 2};
  for (const variant of [0, 1, 2]) {
    const tail = renderDraw(draw, variant);
    assert.equal(stripProactiveSchedulingDetails(tail), "");
    assert.equal(stripProactiveSchedulingDetails("今天喝水了吗。" + tail + "\n天气参考：Open-Meteo https://open-meteo.com/"),
      "今天喝水了吗。\n天气参考：Open-Meteo https://open-meteo.com/");
  }
  assert.equal(stripProactiveSchedulingDetails("我在看比赛，你喜欢哪支球队？"), "我在看比赛，你喜欢哪支球队？");
});

test("主动消息：即使旧includeDraw为true、模型复制比赛旧文，私聊群聊均只发送自然正文", async t => {
  const f = fixture(t, {includeDraw: true});
  const tail = renderDraw(sampleDraw());
  f.llm.respond = async () => answer("今天喝水了吗。\n\n" + tail);
  await f.engine.tick();
  for (const time of ["08:05", "08:10"]) {f.setTime(at(time)); await f.engine.tick();}
  assert.deepEqual(f.tasks().map(row => row.conversation_type), ["private", "group"]);
  for (const task of f.tasks()) assert.equal(taskText(task).trim(), "今天喝水了吗。");
  assert.equal(f.state().pool.round, 3, "只隐藏内部调度文案，不改变抽取和计划");
  const control = JSON.parse(f.engine.control("status"));
  assert.equal(control.round, undefined);
  assert.equal(control.nextRandomAt, undefined);
  assert.equal(f.engine.status().round, 3, "管理状态仍可诊断调度器");
});

test("主动消息：模型只返回已停用比赛信息时，改用自然备用问候", async t => {
  const f = fixture(t);
  f.llm.respond = async () => answer(renderDraw(sampleDraw(), 2));
  await f.engine.tick(); f.setTime(at("08:05")); await f.engine.tick();
  assert.equal(f.tasks().length, 1);
  assert.ok(taskText(f.tasks()[0]!).trim());
  assert.doesNotMatch(taskText(f.tasks()[0]!), /急急星人|权重|第\s*\d+\s*轮|赢了|分钟后/);
});

test("暂停主动消息：取消本计划待发任务，持久化暂停；恢复只安排未来，不复活已取消消息", async t => {
  const f = fixture(t);
  await f.engine.tick();
  f.setTime(at("08:05")); await f.engine.tick();
  const ownTask = f.tasks()[0]!;
  const unrelated = f.db.enqueueSendTask({ taskKey: "normal-reply", kind: "reply", conversationType: "private", targetId: OTHER, payload: {} });
  const otherPlan = f.db.enqueueSendTask({ taskKey: `proactive:v1:${ACCOUNT}:${OTHER}:random:1`, kind: "proactive_random", conversationType: "private", targetId: OTHER, payload: {} });
  assert.equal(JSON.parse(f.engine.control("pause")).paused, true);
  assert.equal(f.db.sendTaskById(ownTask.id)!.status, "failed");
  assert.equal(f.db.sendTaskById(unrelated.id)!.status, "queued");
  assert.equal(f.db.sendTaskById(otherPlan.id)!.status, "queued");
  const restarted = f.restart();
  f.setTime(at("08:20")); await restarted.tick();
  assert.equal(restarted.status().paused, true);
  assert.equal(f.tasks("proactive_random").length, 2, "只包括本计划旧消息和其他计划，无新增");
  const resumed = JSON.parse(restarted.control("resume"));
  assert.equal(resumed.paused, false);
  assert.equal(resumed.nextRandomAt, undefined, "聊天控制回执不暴露内部调度间隔");
  assert.equal(Date.parse(String(restarted.status().nextRandomAt)), at("08:25"));
  await restarted.tick();
  assert.equal(f.db.sendTaskById(ownTask.id)!.status, "failed");
  f.setTime(at("08:25")); await restarted.tick();
  assert.equal(f.tasks().filter(row => row.task_key?.startsWith(f.key + ":")).length, 2);
});

test("暂停发生在模型请求期间：晚到的问候不能进入发送队列或推进骰池", async t => {
  const f = fixture(t);
  await f.engine.tick();
  const pendingAnswer = deferred<ChatResult>();
  f.llm.respond = () => pendingAnswer.promise;
  f.setTime(at("08:05"));
  const pendingTick = f.engine.tick();
  await waitFor(() => f.llm.calls.length === 1);
  f.engine.control("pause");
  pendingAnswer.resolve(answer());
  await pendingTick;
  assert.equal(f.tasks().length, 0);
  assert.equal(f.state().paused, true);
  assert.equal(f.state().pool.round, 1);
  assert.equal(f.state().routeIndex, 0);
});

test("暂停后立即恢复：旧随机模型结果不能发送或覆盖恢复后的未来计划", async t => {
  const f = fixture(t);
  await f.engine.tick();
  const pendingAnswer = deferred<ChatResult>();
  f.llm.respond = () => pendingAnswer.promise;
  f.setTime(at("08:05"));
  const pendingTick = f.engine.tick();
  await waitFor(() => f.llm.calls.length === 1);
  f.engine.control("pause");
  f.setTime(at("08:06"));
  f.engine.control("resume");
  const resumed = f.db.kvGet(f.key);
  assert.equal(f.state().nextRandomAt, at("08:11"));
  f.setTime(at("08:07"));
  pendingAnswer.resolve(answer("旧任务不应发送"));
  await pendingTick;
  assert.equal(f.tasks().length, 0);
  assert.equal(f.db.kvGet(f.key), resumed, "旧请求不应推进骰池、路由或覆盖恢复后的时间");
  assert.equal(f.state().routeIndex, 0);
  f.llm.respond = async () => answer("恢复后的新任务");
  f.setTime(at("08:10")); await f.engine.tick();
  assert.equal(f.llm.calls.length, 1);
  f.setTime(at("08:11")); await f.engine.tick();
  assert.equal(f.tasks().length, 1);
  assert.match(taskText(f.tasks()[0]!), /恢复后的新任务/);
  assert.doesNotMatch(taskText(f.tasks()[0]!), /旧任务/);
});

test("暂停后立即恢复：旧随机天气请求完成后不再调用模型，恢复后的计划不变", async t => {
  const f = fixture(t);
  await f.engine.tick();
  const pendingWeather = deferred<WeatherSnapshot>();
  f.setForecast(() => pendingWeather.promise);
  f.setTime(at("08:05"));
  const pendingTick = f.engine.tick();
  await waitFor(() => f.weatherCalls === 1);
  f.engine.control("pause");
  f.setTime(at("08:06")); f.engine.control("resume");
  const resumed = f.db.kvGet(f.key);
  pendingWeather.resolve(weatherFixture(f.now()));
  await pendingTick;
  assert.equal(f.llm.calls.length, 0, "已作废的随机任务不能再花费模型请求");
  assert.equal(f.tasks().length, 0);
  assert.equal(f.db.kvGet(f.key), resumed);
});

test("暂停后立即恢复：旧早安天气请求不能启动模型或保存已发送日期", async t => {
  const f = fixture(t, { morningEnabled: true, randomEnabled: false }, at("07:00"));
  const pendingWeather = deferred<WeatherSnapshot>();
  f.setForecast(() => pendingWeather.promise);
  const pendingTick = f.engine.tick();
  await waitFor(() => f.weatherCalls === 1);
  f.engine.control("pause");
  f.setTime(at("07:01")); f.engine.control("resume");
  const resumed = f.db.kvGet(f.key);
  pendingWeather.resolve(weatherFixture(f.now()));
  await pendingTick;
  assert.equal(f.tasks().length, 0);
  assert.equal(f.llm.calls.length, 0);
  assert.equal(f.db.kvGet(f.key), resumed);
  assert.equal(f.state().lastMorningDate, "");
  f.setForecast(async () => weatherFixture(f.now()));
  f.setTime(at("07:02")); await f.engine.tick();
  assert.equal(f.tasks("proactive_morning").length, 1, "新一轮仍可发送今日早安");
});

test("暂停后立即恢复：旧早安模型结果不发送，恢复状态和未发送日期保留", async t => {
  const f = fixture(t, { morningEnabled: true, randomEnabled: false }, at("07:00"));
  const pendingAnswer = deferred<ChatResult>();
  f.llm.respond = () => pendingAnswer.promise;
  const pendingTick = f.engine.tick();
  await waitFor(() => f.llm.calls.length === 1);
  f.engine.control("pause");
  f.setTime(at("07:01")); f.engine.control("resume");
  const resumed = f.db.kvGet(f.key);
  pendingAnswer.resolve(answer("旧早安不应发送"));
  await pendingTick;
  assert.equal(f.tasks().length, 0);
  assert.equal(f.db.kvGet(f.key), resumed);
  assert.equal(f.state().lastMorningDate, "");
});

test("暂停后立即恢复：旧天气提醒不发送或消耗雨天/降温提醒额度", async t => {
  const f = fixture(t, { randomEnabled: false, weatherAlertsEnabled: true });
  const pendingWeather = deferred<WeatherSnapshot>();
  f.setForecast(() => pendingWeather.promise);
  const pendingTick = f.engine.tick();
  await waitFor(() => f.weatherCalls === 1);
  f.engine.control("pause");
  f.setTime(at("08:01")); f.engine.control("resume");
  const resumed = f.db.kvGet(f.key);
  pendingWeather.resolve(weatherFixture(f.now(), { rainInNext2Hours: true, rainTotalMm: 1, temperatureDropC: 7 }));
  await pendingTick;
  assert.equal(f.tasks().length, 0);
  assert.equal(f.db.kvGet(f.key), resumed);
  assert.equal(f.state().lastWeatherAlertAt, 0);
  assert.equal(f.state().rainEpisodeUntil, 0);
  assert.equal(f.state().lastCoolingDate, "");
  f.setForecast(async () => weatherFixture(f.now(), { rainInNext2Hours: true, rainTotalMm: 1, temperatureDropC: 7 }));
  f.setTime(at("08:15")); await f.engine.tick();
  assert.equal(f.tasks("proactive_weather_alert").length, 1);
  assert.equal(f.state().lastCoolingDate, "2026-10-13");
});

test("停止发生在模型请求期间：等待当前请求收尾但不排队发送", async t => {
  const f = fixture(t);
  await f.engine.tick();
  const pendingAnswer = deferred<ChatResult>();
  f.llm.respond = () => pendingAnswer.promise;
  f.setTime(at("08:05"));
  const pendingTick = f.engine.tick();
  await waitFor(() => f.llm.calls.length === 1);
  const stopped = f.engine.stop();
  pendingAnswer.resolve(answer());
  await Promise.all([pendingTick, stopped]);
  assert.equal(f.tasks().length, 0);
  f.setTime(at("08:10")); await f.engine.tick();
  assert.equal(f.llm.calls.length, 1);
});

test("并发 tick：模型挂起时只生成一条，完成后同一到期时间不会重复", async t => {
  const f = fixture(t);
  await f.engine.tick();
  const pendingAnswer = deferred<ChatResult>();
  f.llm.respond = () => pendingAnswer.promise;
  f.setTime(at("08:05"));
  const first = f.engine.tick();
  await waitFor(() => f.llm.calls.length === 1);
  await Promise.all([f.engine.tick(), f.engine.tick(), f.engine.tick()]);
  assert.equal(f.llm.calls.length, 1);
  pendingAnswer.resolve(answer()); await first;
  await f.engine.tick();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.state().routeIndex, 1);
});

test("降雨提醒：同一降雨过程四小时去重，并在重启后保留去重状态", async t => {
  const f = fixture(t, { randomEnabled: false, weatherAlertsEnabled: true });
  f.setForecast(async () => weatherFixture(f.now(), { rainInNext2Hours: true, rainTotalMm: 1, rainProbabilityPct: 80 }));
  await f.engine.tick();
  assert.equal(f.tasks("proactive_weather_alert").length, 1);
  assert.equal(f.tasks()[0]!.target_id, OWNER);
  assert.equal(f.tasks()[0]!.conversation_type, "private");
  assert.match(taskText(f.tasks()[0]!), /两小时可能有雨.*概率约80%/);
  assert.match(taskText(f.tasks()[0]!), /插值/);
  f.setTime(at("10:00")); await f.engine.tick();
  const restarted = f.restart();
  f.setTime(at("11:59")); await restarted.tick();
  assert.equal(f.tasks().length, 1);
  f.setTime(at("12:15")); await restarted.tick();
  assert.equal(f.tasks().length, 2);
  assert.equal(f.state().rainEpisodeUntil, at("16:15"));
});

test("降雨提醒：少量插值降水不触发，达到 0.2mm 才提醒", async t => {
  const f = fixture(t, { randomEnabled: false, weatherAlertsEnabled: true });
  f.setForecast(async () => weatherFixture(f.now(), { rainInNext2Hours: true, rainTotalMm: 0.19 }));
  await f.engine.tick();
  assert.equal(f.tasks().length, 0);
  f.setForecast(async () => weatherFixture(f.now(), { rainInNext2Hours: true, rainTotalMm: 0.2 }));
  f.setTime(at("08:15")); await f.engine.tick();
  assert.equal(f.tasks().length, 1);
});

test("降温提醒：每日最多一次，重启不重发；次日可以再次提醒", async t => {
  const f = fixture(t, { randomEnabled: false, weatherAlertsEnabled: true });
  f.setForecast(async () => weatherFixture(f.now(), { temperatureDropC: 7 }));
  await f.engine.tick();
  assert.equal(f.tasks().length, 1);
  assert.match(taskText(f.tasks()[0]!), /降温.*约7℃/);
  f.setTime(at("10:00")); await f.engine.tick();
  const restarted = f.restart();
  f.setTime(at("12:00")); await restarted.tick();
  assert.equal(f.tasks().length, 1);
  f.setTime(at("08:00", "2026-10-14")); await restarted.tick();
  assert.equal(f.tasks().length, 2);
  assert.equal(f.state().lastCoolingDate, "2026-10-14");
});

test("天气提醒：降雨和降温共用冷却时间，早晚静默时不请求也不发送", async t => {
  const f = fixture(t, { randomEnabled: false, weatherAlertsEnabled: true }, at("07:30"));
  f.setForecast(async () => weatherFixture(f.now(), { rainInNext2Hours: true, rainTotalMm: 1 }));
  await f.engine.tick(); assert.equal(f.weatherCalls, 0);
  f.setTime(at("08:00")); await f.engine.tick();
  f.setForecast(async () => weatherFixture(f.now(), { temperatureDropC: 6 }));
  f.setTime(at("09:00")); await f.engine.tick();
  assert.equal(f.tasks().length, 1);
  f.setTime(at("10:00")); await f.engine.tick();
  assert.equal(f.tasks().length, 2);
  const calls = f.weatherCalls;
  f.setTime(at("23:00")); await f.engine.tick();
  assert.equal(f.tasks().length, 2);
  assert.equal(f.weatherCalls, calls);
});

test("天气请求跨过静默边界：晚到的雨报不发送", async t => {
  const f = fixture(t, { randomEnabled: false, weatherAlertsEnabled: true }, at("22:59"));
  const pendingWeather = deferred<WeatherSnapshot>();
  f.setForecast(() => pendingWeather.promise);
  const pendingTick = f.engine.tick();
  await waitFor(() => f.weatherCalls === 1);
  f.setTime(at("23:00"));
  pendingWeather.resolve(weatherFixture(f.now(), { rainInNext2Hours: true, rainTotalMm: 1 }));
  await pendingTick;
  assert.equal(f.tasks().length, 0);
  assert.equal(f.state().lastWeatherAlertAt, 0);
});

test("静默边界前的天气提醒：22:59 入队必须在 23:00 过期，不能延迟到静默时段发送", async t => {
  const f = fixture(t, { randomEnabled: false, weatherAlertsEnabled: true }, at("22:59"));
  f.setForecast(async () => weatherFixture(f.now(), { rainInNext2Hours: true, rainTotalMm: 1 }));
  await f.engine.tick();
  const alerts = f.tasks("proactive_weather_alert");
  assert.equal(alerts.length, 1);
  assert.equal(Date.parse(payload(alerts[0]!).expiresAt!), at("23:00"));
  assert.match(taskText(alerts[0]!), /Open-Meteo https:\/\/open-meteo\.com\//);
});

test("天气失败：早安不伪造天气，五分钟后重试成功才保存当日标记", async t => {
  const f = fixture(t, { morningEnabled: true, randomEnabled: false }, at("07:00"));
  f.setForecast(async () => { throw new Error("fixture weather outage"); });
  await f.engine.tick();
  assert.equal(f.tasks().length, 0);
  assert.equal(f.llm.calls.length, 0);
  assert.equal(f.state().lastMorningDate, "");
  f.setTime(at("07:04")); await f.engine.tick();
  assert.equal(f.weatherCalls, 1);
  f.setForecast(async () => weatherFixture(f.now()));
  f.setTime(at("07:05")); await f.engine.tick();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.state().lastMorningDate, "2026-10-13");
});

test("天气失败：随机问候照常生成但不提供虚构天气；模型失败使用固定备用问候", async t => {
  const f = fixture(t, { includeDraw: false });
  await f.engine.tick();
  f.setForecast(async () => { throw new Error("fixture weather outage"); });
  f.setTime(at("08:05")); await f.engine.tick();
  assert.equal(f.tasks().length, 1);
  assert.equal(JSON.parse(f.llm.calls[0]!.messages[1]!.content as string).weather, undefined);
  f.llm.respond = async () => { throw new Error("fixture model outage"); };
  f.setTime(at("08:10")); await f.engine.tick();
  assert.equal(f.tasks().length, 2);
  assert.ok(taskText(f.tasks()[1]!).trim().length > 0);
  assert.doesNotMatch(taskText(f.tasks()[1]!), /天气|降雨|降温/);
});

test("主动消息原子持久化：排队后状态写入失败必须回滚队列和骰池，重试只产生一条", async t => {
  const f = fixture(t);
  await f.engine.tick();
  const saved = f.db.kvGet(f.key)!;
  const oldStatus = f.engine.status();
  const originalSet = f.db.kvSet.bind(f.db);
  let rejectOnce = true;
  f.db.kvSet = (key, value) => {
    if (key === f.key && rejectOnce) { rejectOnce = false; throw new Error("fixture state write failure"); }
    originalSet(key, value);
  };
  f.setTime(at("08:05")); await f.engine.tick();
  assert.equal(f.tasks().length, 0, "SQLite 回滚刚刚插入的待发消息");
  assert.equal(f.db.kvGet(f.key), saved);
  assert.deepEqual(f.engine.status(), oldStatus, "内存骰池与数据库必须一起保持旧状态");
  f.setTime(at("08:10")); await f.engine.tick();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.state().pool.round, 2);
  assert.equal(f.state().routeIndex, 1);
});

test("离线/未登录不积攒主动问候，恢复连接再处理到期消息", async t => {
  const f = fixture(t);
  await f.engine.tick();
  f.health.connection = "disconnected";
  f.setTime(at("08:05")); await f.engine.tick();
  assert.equal(f.tasks().length, 0);
  assert.equal(f.llm.calls.length, 0);
  f.health.connection = "connected";
  f.health.login = "offline";
  await f.engine.tick(); assert.equal(f.tasks().length, 0);
  f.health.login = "online";
  await f.engine.tick(); assert.equal(f.tasks().length, 1);
});

test("主动消息时间工具：时区、开放边界和跨午夜开放时段", () => {
  assert.deepEqual(localClock(at("07:00"), ZONE), { date: "2026-10-13", minutes: 420 });
  assert.equal(isActiveAt(at("07:59"), ZONE, "08:00", "23:00"), false);
  assert.equal(isActiveAt(at("08:00"), ZONE, "08:00", "23:00"), true);
  assert.equal(isActiveAt(at("23:00"), ZONE, "08:00", "23:00"), false);
  assert.equal(nextActiveAt(at("23:00"), ZONE, "08:00", "23:00"), at("08:00", "2026-10-14"));
  assert.equal(activeWindowEnd(at("22:59"), ZONE, "08:00", "23:00"), at("23:00"));
  assert.equal(isActiveAt(at("01:00"), ZONE, "22:00", "02:00"), true);
  assert.equal(isActiveAt(at("12:00"), ZONE, "22:00", "02:00"), false);
  assert.equal(nextActiveAt(at("12:00"), ZONE, "22:00", "02:00"), at("22:00"));
  assert.equal(activeWindowEnd(at("23:00"), ZONE, "22:00", "02:00"), at("02:00", "2026-10-14"));
});

test("主动消息配置：收件人必须是工具所有者，目标群必须已授权，天气/时间配置必须有效", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-proactive-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = YAML.parse(fs.readFileSync(simPath, "utf8"));
  raw.tools.owner_ids = [OWNER];
  raw.groups.allowlist = [GROUP];
  raw.weather = { enabled: true, default_location: "长沙市" };
  raw.proactive = { enabled: true, recipient_id: OWNER, group_id: GROUP };
  const configPath = path.join(dir, "config.yaml");
  const check = (changes: Record<string, unknown> = {}, weatherEnabled = true) => {
    const modified = structuredClone(raw);
    Object.assign(modified.proactive, changes);
    modified.weather.enabled = weatherEnabled;
    fs.writeFileSync(configPath, YAML.stringify(modified));
    return loadConfig(configPath);
  };
  assert.equal(check().proactive!.recipientId, OWNER);
  assert.throws(() => check({ recipient_id: OTHER }), /工具所有者/);
  assert.throws(() => check({ group_id: "5555555" }), /白名单/);
  assert.throws(() => check({ morning_time: "7:00" }), /HH:mm/);
  assert.throws(() => check({ active_end: "24:00" }), /HH:mm/);
  assert.throws(() => check({}, false), /需要启用 weather/);
  assert.throws(() => check({ weather_check_minutes: 4 }), /超出范围/);
  assert.throws(() => check({ weather_alert_cooldown_minutes: 14 }), /超出范围/);
  assert.throws(() => check({ cooling_threshold_c: 0 }), /超出范围/);
});
