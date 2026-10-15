import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Database } from "../src/db/index.js";
import { loadConfig } from "../src/config.js";
import { MorningActivityDetector } from "../src/proactive/morning-activity.js";
import { ProactiveEngine } from "../src/proactive/index.js";
import { parseDeviceEventsSnapshot } from "../src/presence/device-events.js";
import type { PhonePresenceSnapshot } from "../src/presence/schema.js";
import type { Gateway } from "../src/gateway/index.js";
import type { LLMClient } from "../src/llm/index.js";

const OWNER = "1111111", DEVICE = "test-phone", SOURCE = "test-owner";
const minute = 60_000;
const at = (time: string, date = "2026-10-15") => Date.parse(`${date}T${time}:00+08:00`);
function event(time: number, state: Record<string, unknown>) {
  return { owner: SOURCE, device_id: DEVICE, timestamp: new Date(time).toISOString(), ...state };
}
function snapshot(rows: unknown[], now: number): PhonePresenceSnapshot | null {
  return parseDeviceEventsSnapshot(rows, OWNER, SOURCE, DEVICE, now, 24 * 3600_000);
}
function detector(t: TestContext) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  return { db, engine: new MorningActivityDetector(db, "phone-morning-test", "Asia/Shanghai") };
}
function awake(now: number) {
  return snapshot([event(now - minute, { charging: true }), event(now, { charging: false, screen_state: "unlocked" })], now);
}

test("晨间活动只接受真实unlocked与charging true→false，不把亮屏或false单样本当解锁/断电", t => {
  const f = detector(t), now = at("07:20");
  assert.equal(f.engine.evaluate(snapshot([event(now, { charging: false, screen_state: "on" })], now), now), null);
  assert.equal(f.engine.evaluate(snapshot([event(now, { charging: false, screen_state: "unlocked" })], now), now), null);
  assert.ok(f.engine.evaluate(awake(now + 2 * minute), now + 2 * minute));
});

test("EventTap元数据保留真实解锁事件，on/off不冒充unlock，也不增加普通状态字段", () => {
  const now = at("07:20");
  const result = snapshot([event(now - minute, { charging: true, screen_state: "on" }),
    event(now, { charging: false, screen_state: "unlocked" }), event(now + 1, { screen_state: "off" })], now + 1)!;
  assert.deepEqual(result.activity!.unlocks, [new Date(now).toISOString()]);
  assert.equal(result.activity!.charging.length, 2);
  assert.deepEqual(result.fields.map(field => field.field), ["charging", "screenOn"]);
});

test("夜间充电基线持久化，重启后仍需新鲜真实false事件与解锁组合", t => {
  const f = detector(t), now = at("06:40");
  assert.equal(f.engine.evaluate(snapshot([event(now - 10 * 3600_000, { charging: true })], now), now), null);
  const restarted = new MorningActivityDetector(f.db, "phone-morning-test", "Asia/Shanghai");
  assert.ok(restarted.evaluate(snapshot([event(now, { charging: false, screen_state: "unlocked" })], now), now));
});

test("只在05:00–12:00内触发，未到早间、午后和陈旧补传都静默", t => {
  for (const time of ["04:59", "12:00", "23:00"]) {
    const f = detector(t), now = at(time);
    assert.equal(f.engine.evaluate(awake(now), now), null, time);
  }
  const f = detector(t), now = at("08:00");
  assert.equal(f.engine.evaluate(snapshot([event(now - 10 * minute, { charging: true }),
    event(now - 9 * minute, { charging: false, screen_state: "unlocked" })], now), now), null);
});

test("拔充电和首次解锁允许30分钟内任意顺序，组合最新动作必须2分钟内", t => {
  for (const unlockFirst of [true, false]) {
    const f = detector(t), now = at("07:20");
    const rows = [event(now - 25 * minute, { charging: true }),
      event(now - (unlockFirst ? 0 : 20) * minute, { charging: false }),
      event(now - (unlockFirst ? 20 : 0) * minute, { screen_state: "unlocked" })];
    assert.ok(f.engine.evaluate(snapshot(rows, now), now));
  }
  const f = detector(t), now = at("07:20");
  assert.equal(f.engine.evaluate(snapshot([event(now - 40 * minute, { charging: true }),
    event(now - 31 * minute, { charging: false }), event(now, { screen_state: "unlocked" })], now), now), null);
});

test("早上第一次解锁未形成组合，后续解锁不能替换第一次；未来事件不触发", t => {
  const f = detector(t), now = at("08:00");
  assert.equal(f.engine.evaluate(snapshot([event(now - 2 * 3600_000, { screen_state: "unlocked" }),
    event(now - minute, { charging: true }), event(now, { charging: false, screen_state: "unlocked" })], now), now), null);
  const g = detector(t);
  assert.equal(g.engine.evaluate(snapshot([event(now - minute, { charging: true }),
    event(now + minute, { charging: false, screen_state: "unlocked" })], now), now), null);
});

test("设备改变不能沿用旧充电基线，重新插回充电时不发，非法基线不发", t => {
  const f = detector(t), now = at("07:20");
  f.engine.evaluate(snapshot([event(now - minute, { charging: true })], now), now);
  const other = snapshot([event(now, { charging: false, screen_state: "unlocked" })], now)!;
  other.deviceId = "other-phone";
  assert.equal(f.engine.evaluate(other, now), null);
  const g = detector(t);
  const replug = awake(now)!;
  replug.activity!.charging.push({ value: true, observedAt: new Date(now + 1).toISOString() });
  assert.equal(g.engine.evaluate(replug, now + 1), null);
});

function proactiveFixture(t: TestContext, now = at("06:40")) {
  const db = new Database(":memory:");
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.timezone = "Asia/Shanghai";
  cfg.gateway.accountId = "morning-test-account";
  cfg.proactive = { enabled: true, recipientId: OWNER, randomEnabled: false, morningEnabled: true,
    morningMode: "phone_activity", morningTime: "07:00", activeStart: "08:00", activeEnd: "23:00",
    includeDraw: false, weatherAlertsEnabled: false, weatherCheckMinutes: 15, weatherAlertCooldownMinutes: 120,
    coolingThresholdC: 5, maxMessageChars: 800 };
  cfg.presence = { enabled: true, source: "device_events", sourceOwner: SOURCE, ownerId: OWNER, deviceId: DEVICE,
    supabaseUrl: "https://example.supabase.co", serverKey: "test-key", requestTimeoutMs: 1000, cacheTtlMs: 30000, staleRetentionMs: 86400000 };
  let clock = now;
  let current: PhonePresenceSnapshot | null = null;
  const llm = { chat: async () => ({ content: "早。", toolCalls: [], finishReason: "stop" }) } as unknown as LLMClient;
  const gateway = { getProvider: () => ({ health: () => ({ selfId: "bot", connection: "connected", login: "online" }) }),
    enqueueSend: (task: Parameters<Gateway["enqueueSend"]>[0]) => db.enqueueSendTask(task) } as unknown as Gateway;
  const engines: ProactiveEngine[] = [];
  let diceIndex = 0;
  const dice = [0.95, 0.2, 0.15, 0.1, 0.05];
  const restart = () => {
    const result = new ProactiveEngine({ db, cfg, gateway, llm, weather: null,
      presence: { context: async () => "", snapshot: async () => current }, now: () => clock,
      random: () => dice[diceIndex++ % dice.length]! });
    engines.push(result);
    return result;
  };
  const engine = restart();
  t.after(async () => { for (const item of engines) await item.stop(); db.close(); });
  return { db, cfg, engine, restart, setTime: (value: number) => { clock = value; },
    setSnapshot: (value: PhonePresenceSnapshot | null) => { current = value; },
    tasks: () => db.recentSendTasks(100).filter(row => row.kind === "proactive_morning") };
}

test("phone_activity无手机事件不会在07点发；真实组合早于activeStart仍只私发，天气失败仍问早餐", async t => {
  const f = proactiveFixture(t, at("07:00"));
  await f.engine.tick();
  assert.equal(f.tasks().length, 0);
  f.setSnapshot(awake(at("07:00")));
  await f.engine.tick();
  const task = f.tasks()[0]!;
  assert.equal(task.conversation_type, "private");
  assert.equal(task.target_id, OWNER);
  const body = JSON.parse(task.payload).segments.map((segment: { data: { text?: string } }) => segment.data.text ?? "").join("");
  assert.match(body, /天气暂时没查到/);
  assert.match(body, /今天早上早餐决定好了吗/);
  assert.doesNotMatch(body, /刚醒|起床|睡了/);
});

test("晨间活动与时钟早报共用日去重，重复tick和重启不重发，次日再触发", async t => {
  const f = proactiveFixture(t);
  f.setSnapshot(awake(at("06:40")));
  await f.engine.tick();
  await f.engine.tick();
  await f.restart().tick();
  assert.equal(f.tasks().length, 1);
  const tomorrow = at("06:40", "2026-10-16");
  f.setTime(tomorrow); f.setSnapshot(awake(tomorrow));
  await f.restart().tick();
  assert.equal(f.tasks().length, 2);
});

test("暂停与跳过一轮会静默消费当天晨间动作，不在恢复后补发", async t => {
  for (const action of ["pause", "skip_once"] as const) {
    const f = proactiveFixture(t);
    f.engine.control(action);
    f.setSnapshot(awake(at("06:40")));
    await f.engine.tick();
    assert.equal(f.tasks().length, 0);
    f.engine.control("resume");
    await f.engine.tick();
    assert.equal(f.tasks().length, 0, action);
  }
});

test("主人/设备不匹配、presence关闭、陈旧动作都不触发晨报", async t => {
  const f = proactiveFixture(t);
  const wrong = awake(at("06:40"))!;
  wrong.ownerId = "someone-else";
  f.setSnapshot(wrong); await f.engine.tick();
  assert.equal(f.tasks().length, 0);
  wrong.ownerId = OWNER; wrong.deviceId = "wrong-device";
  await f.engine.tick(); assert.equal(f.tasks().length, 0);
  f.setSnapshot(awake(at("06:40"))); f.cfg.presence!.enabled = false;
  await f.engine.tick(); assert.equal(f.tasks().length, 0);
  f.cfg.presence!.enabled = true; f.setTime(at("07:00"));
  await f.engine.tick(); assert.equal(f.tasks().length, 0);
});

test("晨报进入现有静默状态，随机消息同轮不能紧接着发送", async t => {
  const f = proactiveFixture(t, at("08:20"));
  f.cfg.proactive!.randomEnabled = true;
  await f.engine.tick(); // Initialize the schedule.
  const key = `proactive:v1:${f.cfg.gateway.accountId}:${OWNER}`;
  const schedule = JSON.parse(f.db.kvGet(key)!);
  schedule.nextRandomAt = at("08:00");
  f.db.kvSet(key, JSON.stringify(schedule));
  f.setSnapshot(awake(at("08:20")));
  const restarted = f.restart();
  await restarted.tick();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.db.recentSendTasks(100).filter(row => row.kind === "proactive_random").length, 0);
  await restarted.tick();
  assert.equal(f.db.recentSendTasks(100).filter(row => row.kind === "proactive_random").length, 0);
  assert.ok(JSON.parse(f.db.kvGet(key)!).silenceUntil >= at("08:21"));
});
