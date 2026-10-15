import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "../src/db/index.js";
import type { MessageRecord } from "../src/types.js";

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "botdb-"));
  db = new Database(path.join(tmpDir, "test.db"));
});

function msg(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    eventKey: "acct:group_100:message:1",
    accountId: "acct",
    providerId: "onebot",
    conversationId: "group_100",
    groupId: "100",
    messageId: "1",
    senderId: "u1",
    displayNameAtTime: "小明",
    sentAt: new Date("2026-10-12T10:00:00Z").toISOString(),
    receivedAt: new Date("2026-10-12T10:00:01Z").toISOString(),
    segments: [{ type: "text", data: { text: "你好" } }],
    textContent: "你好",
    status: "active",
    origin: "live",
    ...overrides,
  };
}

test("消息去重：同一消息只入库一次", () => {
  assert.equal(db.insertMessage(msg()).inserted, true);
  assert.equal(db.insertMessage(msg()).inserted, false);
  assert.equal(db.messageCountInRange("100", "2026-10-01T00:00:00Z", "2026-10-13T00:00:00Z"), 1);
});

test("live 与 backfill 同 message_id 视为同一条", () => {
  assert.equal(db.insertMessage(msg()).inserted, true);
  const backfill = msg({ eventKey: "acct:group_100:message:1:backfill", origin: "backfill" });
  assert.equal(db.insertMessage(backfill).inserted, false);
});

test("撤回更新状态而非删除", () => {
  db.insertMessage(msg());
  assert.equal(db.markRecalled("group_100", "1"), true);
  const row = db.getMessageByEventKey("acct:group_100:message:1");
  assert.equal(row?.status, "recalled");
  // 重复撤回不再计数
  assert.equal(db.markRecalled("group_100", "1"), false);
});

test("发送任务：幂等入队与状态机", () => {
  const a = db.enqueueSendTask({ taskKey: "reply:1", kind: "reply", conversationType: "group", targetId: "100", payload: {} });
  const b = db.enqueueSendTask({ taskKey: "reply:1", kind: "reply", conversationType: "group", targetId: "100", payload: {} });
  assert.equal(b.reused, true);
  assert.equal(a.id, b.id);

  const claimed = db.claimSendTask(a.id);
  assert.equal(claimed?.status, "in_flight");
  assert.equal(db.claimSendTask(a.id), undefined, "不能重复认领");

  db.finishSendTask(a.id, "confirmed", undefined, "999");
  assert.equal(db.sendTaskById(a.id)?.status, "confirmed");

  // 崩溃恢复：in_flight 的 report 类任务标 unknown，其他重新排队
  const r1 = db.enqueueSendTask({ taskKey: "r:1", kind: "report_file", conversationType: "private", targetId: "u9", payload: {} });
  const r2 = db.enqueueSendTask({ kind: "reply", conversationType: "group", targetId: "100", payload: {} });
  db.claimSendTask(r1.id);
  db.claimSendTask(r2.id);
  const res = db.resetInFlightTasks();
  assert.equal(res.unknowned, 1);
  assert.equal(res.requeued, 1);
  assert.equal(db.sendTaskById(r1.id)?.status, "unknown");
  assert.equal(db.sendTaskById(r2.id)?.status, "queued");
});

test("MiniMax图片和语音投递崩溃恢复不自动重发", () => {
  const local=new Database(":memory:");
  try {
    const tasks=["minimax_image","minimax_speech"].map((kind,index)=>local.enqueueSendTask({
      taskKey:`media-restart-${index}`,kind,conversationType:"private",targetId:"10000",
      payload:{kind:"segments",segments:[{type:index===0?"image":"record",data:{file:"fixture"}}]},
    }));
    for(const task of tasks)local.claimSendTask(task.id);
    assert.deepEqual(local.resetInFlightTasks(),{requeued:0,unknowned:2});
    for(const task of tasks)assert.equal(local.sendTaskById(task.id)?.status,"unknown");
  } finally {local.close();}
});

test("记忆：写入、查重、修订", () => {
  const base = { accountId: "acct", groupId: "100", kind: "fact" as const, statement: "小张明天考试", narratorId: "u1", narratorName: "小明", status: "candidate" as const, confidence: 0.6 };
  const id = db.insertMemory(base);
  assert.ok(id > 0);
  // 模块层去重：findMemoryByStatement 命中后不再插入（行为由 memory 层保证）
  assert.ok(db.findMemoryByStatement("acct", "100", "小张明天考试"));

  const hits = db.searchMemories("acct", "100", ["考试"], 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.statement, "小张明天考试");

  // 群隔离：别的群查不到
  assert.equal(db.searchMemories("acct", "200", ["考试"], 10).length, 0);

  assert.equal(db.reviseMemory(id, "confirmed"), true);
  assert.equal(db.memoryById(id)?.status, "confirmed");
  assert.equal(db.reviseMemory(id, "invalid"), true);
  // 作废后检索不到
  assert.equal(db.searchMemories("acct", "100", ["考试"], 10).length, 0);
});

test("日报与投递：唯一键与重试", () => {
  db.upsertReport({ reportKey: "acct:100:2026-10-12:full_day", accountId: "acct", groupId: "100", reportDate: "2026-10-12", period: "full_day", rangeStart: "2026-10-11T16:00:00Z", rangeEnd: "2026-10-12T16:00:00Z", status: "generated", filePath: "x.md", messageCount: 42 });
  const r = db.reportByKey("acct:100:2026-10-12:full_day");
  assert.equal(r?.message_count, 42);

  const d1 = db.ensureDelivery("acct:100:2026-10-12:full_day", "u9");
  const d2 = db.ensureDelivery("acct:100:2026-10-12:full_day", "u9");
  assert.equal(d2.reused, true);

  assert.equal(db.pendingDeliveries(5).length, 1);
  db.updateDelivery(d1.id, "failed", "boom", true);
  assert.equal(db.pendingDeliveries(5).length, 0, "failed 不在待投递队列");
  assert.equal(db.retryDelivery(d1.id), true);
  assert.equal(db.pendingDeliveries(5).length, 1);
});

test("消息保留期清理", () => {
  db.insertMessage(msg());
  db.insertMessage(msg({ eventKey: "k2", messageId: "2", sentAt: new Date(Date.now() - 40 * 86400_000).toISOString() }));
  const n = db.purgeOldMessages(30);
  assert.equal(n, 1);
  assert.equal(db.messageCountInRange("100", "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"), 1);
});

test("停机区间记录", () => {
  db.markDowntimeStart("acct", "conn lost");
  db.markDowntimeStart("acct", "again"); // 不重复记录
  db.markDowntimeEnd("acct");
  db.markDowntimeEnd("acct");
  const rows = db.downtimeInRange("acct", "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.ended_at);
});
