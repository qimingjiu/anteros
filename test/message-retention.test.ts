import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { loadConfig, type AppConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import { MessageRetention } from "../src/memory/retention.js";
import type { MessageRecord } from "../src/types.js";

const DAILY: AppConfig["memory"] = { enabled: true, rawRetentionDays: 30, rawDailyCleanupTime: "04:00",
  isolateByGroup: true, topicGapMinutes: 5, extraction: "off", maxFactsPerTopic: 6 };
const CUTOFF = "2026-10-15T16:00:00.000Z"; // 北京时间 10 月 16 日零点。

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

function fixture(t: TestContext, at = "2026-10-16T04:00:00+08:00") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "message-retention-"));
  const filename = path.join(directory, "test.db");
  let db = new Database(filename);
  let now = Date.parse(at);
  let serial = 0;
  const controllers: MessageRetention[] = [];
  t.after(async () => {
    for (const controller of controllers) await controller.stop();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const message = (sentAt: string, overrides: Partial<MessageRecord> = {}): MessageRecord => {
    const id = String(++serial);
    return { eventKey: `retention:group_100:message:${id}`, accountId: "retention", providerId: "fixture",
      conversationId: "group_100", groupId: "100", messageId: id, senderId: "123456789",
      displayNameAtTime: "群成员", sentAt: new Date(sentAt).toISOString(), receivedAt: new Date(now).toISOString(),
      segments: [{ type: "text", data: { text: `原文 ${id}` } }], textContent: `原文 ${id}`,
      status: "active", origin: "live", ...overrides };
  };
  return {
    get db() { return db; },
    setNow(at: string) { now = Date.parse(at); },
    reopen() { db.close(); db = new Database(filename); },
    message,
    insert(sentAt: string, overrides: Partial<MessageRecord> = {}) {
      const record = message(sentAt, overrides);
      assert.equal(db.insertMessage(record).inserted, true);
      return record;
    },
    retention(memory?: { prepareForMessagePurge?(cutoff: string): Promise<void> }, config = DAILY) {
      const retention = new MessageRetention({ db, memory, config, timezone: "Asia/Shanghai", now: () => now });
      controllers.push(retention);
      return retention;
    },
  };
}

test("每日原文清理：北京时间 04:00 才推进当天零点，严格保留零点边界", async t => {
  const f = fixture(t, "2026-10-16T03:59:59.999+08:00");
  const twoDaysAgo = f.insert("2026-10-14T23:59:59.999+08:00");
  const yesterdayStart = f.insert("2026-10-15T00:00:00+08:00");
  const yesterdayEnd = f.insert("2026-10-15T23:59:59.999+08:00");
  const todayStart = f.insert("2026-10-16T00:00:00+08:00");
  const today = f.insert("2026-10-16T03:59:00+08:00");
  const prepared: string[] = [];
  const retention = f.retention({ async prepareForMessagePurge(cutoff) { prepared.push(cutoff); } });

  await retention.tick();
  assert.equal(f.db.kvGet("raw_messages_before"), "2026-10-14T16:00:00.000Z");
  assert.equal(f.db.getMessageByEventKey(twoDaysAgo.eventKey), undefined);
  assert.ok(f.db.getMessageByEventKey(yesterdayStart.eventKey));
  assert.ok(f.db.getMessageByEventKey(yesterdayEnd.eventKey));

  f.setNow("2026-10-16T04:00:00+08:00");
  await retention.tick();
  assert.equal(f.db.kvGet("raw_messages_before"), CUTOFF);
  assert.equal(f.db.getMessageByEventKey(yesterdayStart.eventKey), undefined);
  assert.equal(f.db.getMessageByEventKey(yesterdayEnd.eventKey), undefined);
  assert.ok(f.db.getMessageByEventKey(todayStart.eventKey));
  assert.ok(f.db.getMessageByEventKey(today.eventKey));
  assert.deepEqual(prepared, ["2026-10-14T16:00:00.000Z", CUTOFF]);
});

test("每日原文清理：重启读取持久水位跳过已完成日期，停机多日后补做最新日期", async t => {
  const f = fixture(t);
  const prepared: string[] = [];
  const memory = { async prepareForMessagePurge(cutoff: string) { prepared.push(cutoff); } };
  const first = f.retention(memory);
  await first.tick();
  await first.tick();
  await first.stop();
  f.reopen();
  const restarted = f.retention(memory);
  await restarted.tick();
  assert.deepEqual(prepared, [CUTOFF], "完成水位跨数据库重开仍然有效");

  f.setNow("2026-10-19T05:00:00+08:00");
  await restarted.tick();
  assert.deepEqual(prepared, [CUTOFF, "2026-10-18T16:00:00.000Z"]);
  assert.equal(f.db.kvGet("raw_messages_before"), "2026-10-18T16:00:00.000Z");
});

test("每日原文清理：并发 tick 共同等待一次摘要准备，准备完成前原文与水位均不变", async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = fixture(t);
  const old = f.insert("2026-10-15T23:00:00+08:00");
  let calls = 0;
  const retention = f.retention({ async prepareForMessagePurge(cutoff) {
    calls++;
    assert.equal(cutoff, CUTOFF);
    await gate.promise;
  } });
  let settled = 0;
  const first = retention.tick().then(() => { settled++; });
  const second = retention.tick().then(() => { settled++; });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(settled, 0);
  assert.ok(f.db.getMessageByEventKey(old.eventKey));
  assert.equal(f.db.kvGet("raw_messages_before"), undefined);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(settled, 2);
  assert.equal(f.db.getMessageByEventKey(old.eventKey), undefined);
  assert.equal(f.db.kvGet("raw_messages_before"), CUTOFF);
});

test("每日原文清理：等待摘要期间屏蔽旧 backfill 与晚到消息，零点边界及之后仍准入", async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = fixture(t);
  const old = f.insert("2026-10-15T23:00:00+08:00");
  const retention = f.retention({ async prepareForMessagePurge() { await gate.promise; } });
  const running = retention.tick();
  for (const origin of ["backfill", "live"] as const) {
    const expired = f.message("2026-10-15T23:59:59.999+08:00", { origin });
    assert.equal(f.db.insertMessage(expired).inserted, false, `${origin} 不得在摘要快照后混入过期原文`);
  }
  const boundary = f.insert(CUTOFF, { origin: "backfill" });
  const newer = f.insert("2026-10-16T01:00:00+08:00");
  assert.ok(f.db.getMessageByEventKey(old.eventKey), "正在摘要的旧原文仍保留");
  assert.equal(f.db.kvGet("raw_messages_before"), undefined, "暂时屏蔽不得提前写完成水位");
  gate.resolve();
  await running;
  assert.equal(f.db.getMessageByEventKey(old.eventKey), undefined);
  assert.ok(f.db.getMessageByEventKey(boundary.eventKey));
  assert.ok(f.db.getMessageByEventKey(newer.eventKey));
  assert.equal(f.db.kvGet("raw_messages_before"), CUTOFF);
});

test("每日原文清理：准备失败或 stop 释放临时屏蔽，stop 等待失败任务后仍正常结束", async t => {
  for (const mode of ["failure", "stop", "stop-failure"] as const) {
    const gate = deferred();
    t.after(() => gate.resolve());
    const f = fixture(t);
    const old = f.insert("2026-10-15T23:00:00+08:00");
    const retention = f.retention({ async prepareForMessagePurge() {
      await gate.promise;
      if (mode !== "stop") throw new Error("异步摘要准备失败");
    } });
    const running = retention.tick();
    const observed = mode === "stop" ? running : assert.rejects(running, /异步摘要准备失败/);
    assert.equal(f.db.insertMessage(f.message(old.sentAt, { origin: "backfill" })).inserted, false, mode);
    let stopped = false;
    const stopping = mode === "failure" ? undefined : retention.stop().then(() => { stopped = true; });
    if (stopping) {
      await Promise.resolve();
      assert.equal(stopped, false, "stop 必须等待正在准备的任务");
    }
    gate.resolve();
    await observed;
    if (stopping) {
      await assert.doesNotReject(stopping, "摘要准备失败不能打断后续 shutdown");
      assert.equal(stopped, true);
    }
    assert.ok(f.db.getMessageByEventKey(old.eventKey), `${mode}: 未成功清理必须保留原文`);
    assert.equal(f.db.kvGet("raw_messages_before"), undefined, `${mode}: 未成功清理不得写完成水位`);
    for (const origin of ["backfill", "live"] as const) {
      assert.equal(f.db.insertMessage(f.message(old.sentAt, { origin })).inserted, true,
        `${mode}: ${origin} 在失败或取消后恢复准入`);
    }
  }
});

test("每日原文清理：摘要准备失败不删除、不推进水位，下次 tick 重试", async t => {
  const f = fixture(t);
  const old = f.insert("2026-10-15T23:00:00+08:00");
  let attempts = 0;
  const retention = f.retention({ async prepareForMessagePurge() {
    if (++attempts === 1) throw new Error("摘要保存失败");
  } });
  await assert.rejects(retention.tick(), /摘要保存失败/);
  assert.ok(f.db.getMessageByEventKey(old.eventKey));
  assert.equal(f.db.kvGet("raw_messages_before"), undefined);
  await retention.tick();
  assert.equal(attempts, 2);
  assert.equal(f.db.getMessageByEventKey(old.eventKey), undefined);
  assert.equal(f.db.kvGet("raw_messages_before"), CUTOFF);
});

test("每日原文清理：start 在启动时立即补跑，不必等到下一个定时周期", { timeout: 2000 }, async t => {
  const entered = deferred();
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = fixture(t, "2026-10-16T09:00:00+08:00");
  const old = f.insert("2026-10-15T23:00:00+08:00");
  let calls = 0;
  const retention = f.retention({ async prepareForMessagePurge() {
    calls++;
    entered.resolve();
    await gate.promise;
  } });
  retention.start();
  retention.start();
  await entered.promise;
  assert.equal(calls, 1, "重复 start 不重复启动正在运行的清理");
  gate.resolve();
  await retention.tick();
  assert.equal(f.db.getMessageByEventKey(old.eventKey), undefined);
  assert.equal(f.db.kvGet("raw_messages_before"), CUTOFF);
});

test("每日原文清理：stop 等待进行中的准备，并阻止停机期间删除原文", async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = fixture(t);
  const old = f.insert("2026-10-15T23:00:00+08:00");
  const retention = f.retention({ async prepareForMessagePurge() { await gate.promise; } });
  const running = retention.tick();
  let stopped = false;
  const stopping = retention.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  gate.resolve();
  await Promise.all([running, stopping]);
  assert.equal(stopped, true);
  assert.ok(f.db.getMessageByEventKey(old.eventKey));
  assert.equal(f.db.kvGet("raw_messages_before"), undefined);
});

test("原文清理：只删除 messages，话题摘要、长期记忆与个人记忆逐行保留", async t => {
  const f = fixture(t);
  const old = f.insert("2026-10-15T23:00:00+08:00");
  const topic = f.db.upsertOpenTopic("retention", "100", { id: old.messageId, sentAt: old.sentAt });
  f.db.appendTopicMessage(topic, old.messageId);
  f.db.closeTopic(topic, "2026-10-15T15:30:00.000Z");
  f.db.setTopicSummary(topic, "群友约定周末一起读书。", [{ id: old.senderId, count: 1 }]);
  const memory = f.db.insertMemory({ accountId: "retention", groupId: "100", topicId: topic, kind: "plan",
    statement: "周末一起读书", narratorId: old.senderId, status: "candidate", confidence: 0.8 });
  f.db.db.exec("CREATE TABLE personal_memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL)");
  f.db.db.prepare("INSERT INTO personal_memories (id, content) VALUES (?, ?)").run(1, "主人明确要求保留的偏好");
  const before = { topic: f.db.topicById(topic), memory: f.db.memoryById(memory),
    personal: f.db.db.prepare("SELECT * FROM personal_memories").all() };

  await f.retention().tick();
  assert.equal(f.db.getMessageByEventKey(old.eventKey), undefined);
  assert.deepEqual(f.db.topicById(topic), before.topic);
  assert.deepEqual(f.db.memoryById(memory), before.memory);
  assert.deepEqual(f.db.db.prepare("SELECT * FROM personal_memories").all(), before.personal);
});

test("原文清理水位：阻止旧 backfill 和晚到消息重新入库，截止时刻及之后仍可保存", t => {
  const f = fixture(t);
  const old = f.insert("2026-10-15T23:59:59.999+08:00");
  assert.equal(f.db.purgeMessagesBefore(CUTOFF), 1);
  assert.equal(f.db.insertMessage({ ...old, origin: "backfill" }).inserted, false);
  assert.equal(f.db.insertMessage(f.message("2026-10-15T23:59:59.999+08:00", { origin: "live" })).inserted, false);
  assert.equal(f.db.insertMessage(f.message(CUTOFF, { origin: "backfill" })).inserted, true);
  assert.equal(f.db.insertMessage(f.message("2026-10-16T01:00:00+08:00")).inserted, true);
  assert.equal(f.db.purgeMessagesBefore("2026-10-14T16:00:00.000Z"), 0);
  assert.equal(f.db.kvGet("raw_messages_before"), CUTOFF, "较旧任务不能回退持久水位");
  f.reopen();
  assert.equal(f.db.insertMessage(f.message("2026-10-15T20:00:00+08:00", { origin: "backfill" })).inserted, false);
  assert.equal(f.db.recentMessages("group_100", 10).length, 2);
});

test("原文清理水位：保存水位失败同时回滚删除与水位修改", t => {
  const f = fixture(t);
  const old = f.insert("2026-10-15T23:00:00+08:00");
  const previous = "2026-10-14T16:00:00.000Z";
  f.db.kvSet("raw_messages_before", previous);
  const save = f.db.kvSet;
  f.db.kvSet = function (key, value) {
    save.call(this, key, value);
    if (key === "raw_messages_before") throw new Error("模拟水位写入失败");
  };
  try { assert.throws(() => f.db.purgeMessagesBefore(CUTOFF), /模拟水位写入失败/); }
  finally { f.db.kvSet = save; }
  assert.ok(f.db.getMessageByEventKey(old.eventKey));
  assert.equal(f.db.kvGet("raw_messages_before"), previous);
  assert.equal(f.db.purgeMessagesBefore(CUTOFF), 1);
});

test("原文清理兼容：未配置每日时间时仍按滚动保留天数，零天表示禁用", async t => {
  const f = fixture(t, "2026-10-16T12:00:00+08:00");
  const old = f.insert("2026-10-15T11:59:59.999+08:00");
  const boundary = f.insert("2026-10-15T12:00:00+08:00");
  const disabled = f.retention(undefined, { ...DAILY, rawDailyCleanupTime: undefined, rawRetentionDays: 0 });
  await disabled.tick();
  assert.ok(f.db.getMessageByEventKey(old.eventKey));
  assert.equal(f.db.kvGet("raw_messages_before"), undefined);
  await f.retention(undefined, { ...DAILY, rawDailyCleanupTime: undefined, rawRetentionDays: 1 }).tick();
  assert.equal(f.db.getMessageByEventKey(old.eventKey), undefined);
  assert.ok(f.db.getMessageByEventKey(boundary.eventKey));
  assert.equal(f.db.kvGet("raw_messages_before"), "2026-10-15T04:00:00.000Z");
});

test("每日原文清理配置：接受 HH:mm，拒绝越界或不完整时间", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "retention-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const raw = YAML.parse(fs.readFileSync(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)), "utf8"));
  raw.memory ??= {};
  const filename = path.join(directory, "config.yaml");
  for (const value of ["04:00", "00:00", "23:59", "4:00", "24:00", "04:60", "04:00:00", "凌晨四点"]) {
    raw.memory.raw_daily_cleanup_time = value;
    fs.writeFileSync(filename, YAML.stringify(raw));
    if (["04:00", "00:00", "23:59"].includes(value)) assert.equal(loadConfig(filename).memory.rawDailyCleanupTime, value);
    else assert.throws(() => loadConfig(filename), /memory\.raw_daily_cleanup_time.*HH:mm/);
  }
});
