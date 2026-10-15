import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../src/db/index.js";
import { Gateway } from "../src/gateway/index.js";
import type { CapabilityMap, GatewayEvent, MessageRecord, NormalizedIncomingMessage, Provider, ProviderHealth, SendResult } from "../src/types.js";

const ACCOUNT = "maintenance-test";
const GROUP = "100";
const BLOCKED = "4455667788";
const OLD_TEXT = "MAINTENANCE_OLD_CONVERSATION_CONTENT_7b1ef072";

async function diskFixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qq-maintenance-state-"));
  const databasePath = path.join(directory, "bot.db");
  let db = new Database(databasePath);
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { databasePath, get db() { return db; }, reopen() { db.close(); db = new Database(databasePath); return db; } };
}

function message(messageId: string, overrides: Partial<MessageRecord> = {}): MessageRecord {
  const sentAt = new Date().toISOString();
  return { eventKey: `${ACCOUNT}:group_${GROUP}:message:${messageId}`, accountId: ACCOUNT, providerId: "fixture", conversationId: `group_${GROUP}`,
    groupId: GROUP, messageId, senderId: "123456789", displayNameAtTime: "测试成员", sentAt, receivedAt: sentAt,
    segments: [{ type: "text", data: { text: OLD_TEXT } }], textContent: OLD_TEXT, status: "active", origin: "live", ...overrides };
}

class MaintenanceProvider implements Provider {
  readonly providerId = "fixture";
  callbacks: ((event: GatewayEvent) => void)[] = [];
  history: NormalizedIncomingMessage[] = [];
  historyCalls = 0;
  sent = 0;
  start(): void {}
  async stop(): Promise<void> {}
  onEvent(callback: (event: GatewayEvent) => void): void { this.callbacks.push(callback); }
  emit(event: GatewayEvent): void { for (const callback of this.callbacks) callback(event); }
  health(): ProviderHealth { return { connection: "connected", login: "online", selfId: "987654321", reconnectCount: 0 }; }
  capabilities(): CapabilityMap { return { receiveMessages: "supported", sendText: "supported", sendImage: "unsupported", sendPrivateFile: "unsupported", groupHistory: "supported" }; }
  async sendPrivateMsg(): Promise<SendResult> { this.sent++; return { status: "confirmed" }; }
  async sendGroupMsg(): Promise<SendResult> { this.sent++; return { status: "confirmed" }; }
  async getGroupMsgHistory(): Promise<{ ok: true; messages: NormalizedIncomingMessage[]; hasMore: boolean }> {
    this.historyCalls++;
    return { ok: true, messages: this.history, hasMore: false };
  }
}

test("记忆清理：真实 SQLite 删除所有聊天衍生数据、截断 WAL，重启保留模型、主动计划及黑名单", async (t) => {
  const f = await diskFixture(t);
  const db = f.db;
  db.db.exec("PRAGMA wal_autocheckpoint = 0");
  db.insertMessage(message("1", { textContent: OLD_TEXT.repeat(200), segments: [{ type: "text", data: { text: OLD_TEXT.repeat(200) } }] }));
  db.insertMemory({ accountId: ACCOUNT, groupId: GROUP, kind: "fact", statement: OLD_TEXT, narratorId: "123456789", status: "confirmed", confidence: 1 });
  const topic = db.upsertOpenTopic(ACCOUNT, GROUP, { id: "1", sentAt: new Date().toISOString() });
  db.setTopicSummary(topic, OLD_TEXT, ["123456789"]);
  db.insertLinkRead({ accountId: ACCOUNT, groupId: GROUP, url: "https://example.invalid/old-resource", title: OLD_TEXT, summary: OLD_TEXT, status: "ok" });
  db.upsertReport({ reportKey: "old-report", accountId: ACCOUNT, groupId: GROUP, reportDate: "2026-10-13", period: "full_day",
    rangeStart: "2026-10-12T16:00:00.000Z", rangeEnd: "2026-10-13T16:00:00.000Z", status: "generated", summary: OLD_TEXT, messageCount: 1 });
  db.ensureDelivery("old-report", "10001");
  db.enqueueSendTask({ taskKey: "old-reply", kind: "reply", conversationType: "group", targetId: GROUP,
    payload: { kind: "segments", segments: [{ type: "text", data: { text: OLD_TEXT } }] } });
  db.kvSet("backfill_anchors", JSON.stringify({ group_100: "1" }));
  db.kvSet("known_groups", JSON.stringify([GROUP]));
  db.kvSet("document:old-request:artifact", JSON.stringify({ path: "old-document.pdf", title: OLD_TEXT }));
  db.kvSet(`poke_sources:v1:${ACCOUNT}`, JSON.stringify([{ userId: "123456789", eventKey: OLD_TEXT }]));
  db.kvSet("forgotten_conversation_cache", OLD_TEXT);
  const keep = {
    active_model_profile: "test-provider/pdf-model",
    "model_catalog:test-provider": JSON.stringify({ version: 1, modelIds: ["pdf-model"], fingerprint: "fixture" }),
    [`proactive:v1:${ACCOUNT}:10001`]: JSON.stringify({ skipNext: true, paused: false, nextRandomAt: 1791892800000 }),
  };
  for (const [key, value] of Object.entries(keep)) db.kvSet(key, value);
  db.blockUser(ACCOUNT, BLOCKED, OLD_TEXT);
  db.markDowntimeStart(ACCOUNT, OLD_TEXT);
  assert.ok((await fs.stat(`${f.databasePath}-wal`)).size > 0, "必须检查真实磁盘 WAL，不能以内存数据库代替");
  const beforeReset = Date.now();
  const counts = db.clearConversationMemory();
  assert.deepEqual(counts, { messages: 1, memories: 1, topics: 1, link_reads: 1, reports: 1, deliveries: 1, send_tasks: 1 });
  for (const table of Object.keys(counts)) assert.equal((db.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0, `${table} 必须为空`);
  for (const key of ["backfill_anchors", "known_groups", "document:old-request:artifact", `poke_sources:v1:${ACCOUNT}`, "forgotten_conversation_cache"]) assert.equal(db.kvGet(key), undefined);
  const resetAt = db.kvGet("memory_reset_at")!;
  assert.ok(Date.parse(resetAt) >= beforeReset && Date.parse(resetAt) <= Date.now());
  for (const [key, value] of Object.entries(keep)) assert.equal(db.kvGet(key), value);
  assert.equal(db.isUserBlocked(ACCOUNT, BLOCKED), true);
  assert.equal(db.blockedUsers(ACCOUNT)[0]?.reason, "retained_after_memory_reset");
  assert.equal((db.db.prepare("SELECT reason FROM downtime").get() as { reason: string | null }).reason, null);
  assert.equal((await fs.stat(`${f.databasePath}-wal`)).size, 0, "清理后 WAL 必须实际截断");
  assert.ok(!(await fs.readFile(f.databasePath)).includes(Buffer.from(OLD_TEXT)), "主数据库也不能残留已删除正文的明文页");
  const restarted = f.reopen();
  for (const [key, value] of Object.entries(keep)) assert.equal(restarted.kvGet(key), value);
  assert.equal(restarted.kvGet("memory_reset_at"), resetAt);
  assert.equal(restarted.isUserBlocked(ACCOUNT, BLOCKED), true);
  assert.equal(restarted.recentMessages(`group_${GROUP}`, 10).length, 0);
});

test("记忆清理：主动计划只保留调度字段，未知字段、伪日期和嵌套旧正文不能留存", async (t) => {
  const f = await diskFixture(t);
  const key = `proactive:v1:${ACCOUNT}:10001`;
  f.db.kvSet(key, JSON.stringify({ version: 1, nextRandomAt: 1791892800000, routeIndex: 2, paused: true, skipNext: false,
    lastMorningDate: "2026-10-14", lastCoolingDate: OLD_TEXT, previousMessage: OLD_TEXT,
    pool: {round: 5, lastWinnerId: "impatient", consecutiveWins: 1, previousMessage: OLD_TEXT} }));
  f.db.kvSet(`proactive:v1:${ACCOUNT}:bad`, OLD_TEXT);
  f.db.clearConversationMemory();
  assert.deepEqual(JSON.parse(f.db.kvGet(key)!), { version: 1, nextRandomAt: 1791892800000, routeIndex: 2,
    paused: true, skipNext: false, lastMorningDate: "2026-10-14", pool: {round: 5, lastWinnerId: "impatient", consecutiveWins: 1} });
  assert.equal(f.db.kvGet(`proactive:v1:${ACCOUNT}:bad`), undefined);
  assert.ok(!(await fs.readFile(f.databasePath)).includes(Buffer.from(OLD_TEXT)));
});

test("记忆清理：并发读事务阻止WAL截断时明确失败，读者关闭后重试完成清理", async (t) => {
  const f = await diskFixture(t);
  f.db.insertMessage(message("concurrent-reader"));
  f.db.db.exec("PRAGMA busy_timeout = 1");
  const reader = new DatabaseSync(f.databasePath, {readOnly: true});
  try {
    reader.exec("BEGIN; SELECT count(*) FROM messages");
    assert.throws(() => f.db.clearConversationMemory(), /could not truncate WAL/);
  } finally { reader.exec("ROLLBACK"); reader.close(); }
  f.db.clearConversationMemory();
  assert.equal((await fs.stat(`${f.databasePath}-wal`)).size, 0);
  assert.ok(!(await fs.readFile(f.databasePath)).includes(Buffer.from(OLD_TEXT)));
});

test("黑名单接入：真实 Gateway 在入库与派发前丢弃同一 QQ 的群聊、私聊及历史消息", async (t) => {
  const f = await diskFixture(t);
  f.db.insertMessage(message("before-ban", { senderId: BLOCKED }));
  f.db.blockUser(ACCOUNT, BLOCKED, "malicious attack");
  assert.equal(f.db.recentMessages(`group_${GROUP}`, 10).length, 0, "既有攻击消息从上下文中删除");
  const provider = new MaintenanceProvider();
  const gateway = new Gateway(f.db, provider, { accountId: ACCOUNT, backfillMaxPages: 0, backfillPageLimit: 100 });
  t.after(() => gateway.stop());
  const dispatched: MessageRecord[] = [];
  gateway.onEvent(event => { if (event.kind === "message") dispatched.push(event.message); });
  const inserted: string[] = [];
  const originalInsert = f.db.insertMessage.bind(f.db);
  f.db.insertMessage = record => { inserted.push(record.messageId); return originalInsert(record); };
  gateway.start();
  provider.emit({ kind: "message", message: message("blocked-group", { senderId: BLOCKED }) });
  provider.emit({ kind: "message", message: message("blocked-private", { senderId: BLOCKED, groupId: undefined, conversationId: `private_${BLOCKED}` }) });
  provider.emit({ kind: "message", message: message("blocked-backfill", { senderId: BLOCKED, origin: "backfill" }) });
  provider.emit({ kind: "message", message: message("ordinary") });
  assert.deepEqual(inserted, ["ordinary"], "黑名单必须在 insertMessage 前拦截");
  assert.deepEqual(dispatched.map(record => record.messageId), ["ordinary"]);
  assert.equal(f.db.recentMessages(`group_${GROUP}`, 10).length, 1);
  assert.equal(provider.sent, 0, "拉黑和丢弃消息不能产生通知");
});

test("清理水位：实时新消息继续入库，旧 backfill 事件被拒绝，重连历史也不能回灌旧数据或黑名单", async (t) => {
  const f = await diskFixture(t);
  f.db.clearConversationMemory();
  const resetAt = f.db.kvGet("memory_reset_at")!;
  const beforeReset = new Date(Date.parse(resetAt) - 1000).toISOString();
  const afterReset = new Date(Date.parse(resetAt) + 1000).toISOString();
  f.db.blockUser(ACCOUNT, BLOCKED, "malicious attack");
  const provider = new MaintenanceProvider();
  const gateway = new Gateway(f.db, provider, { accountId: ACCOUNT, backfillMaxPages: 1, backfillPageLimit: 100 });
  t.after(() => gateway.stop());
  const dispatched: string[] = [];
  gateway.onEvent(event => { if (event.kind === "message") dispatched.push(event.message.messageId); });
  gateway.start();
  provider.emit({ kind: "message", message: message("old-event", { origin: "backfill", sentAt: beforeReset }) });
  provider.emit({ kind: "message", message: message("at-reset-event", { origin: "backfill", sentAt: resetAt }) });
  provider.emit({ kind: "message", message: message("new-event", { origin: "backfill", sentAt: afterReset }) });
  provider.emit({ kind: "message", message: message("live-after-reset", { sentAt: afterReset }) });
  assert.deepEqual(dispatched, ["new-event", "live-after-reset"]);
  gateway.updateAnchor(GROUP, "live-after-reset");
  provider.history = [
    { id: "old-history", sender: "123456789", date: beforeReset },
    { id: "at-reset-history", sender: "123456789", date: resetAt },
    { id: "blocked-history", sender: BLOCKED, date: afterReset },
    { id: "new-history", sender: "123456789", date: afterReset },
  ].map(item => ({ accountId: ACCOUNT, providerId: provider.providerId, groupId: GROUP, messageId: item.id, senderId: item.sender, senderName: "测试成员",
    sentAt: new Date(item.date), segments: [{ type: "text", data: { text: OLD_TEXT } }] }));
  provider.emit({ kind: "connection", state: "connected", at: afterReset });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(provider.historyCalls, 1);
  assert.deepEqual(f.db.recentMessages(`group_${GROUP}`, 20).map(row => row.message_id).sort(), ["live-after-reset", "new-event", "new-history"].sort());
  assert.equal(gateway.getStats().backfilled, 1);
  assert.deepEqual(dispatched, ["new-event", "live-after-reset"], "重连历史保留 backfill 语义，不重新触发聊天回复");
  assert.equal(provider.sent, 0);
});
