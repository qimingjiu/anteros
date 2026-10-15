import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../src/db/index.js";
import { SqliteMemory } from "../src/memory/index.js";
import type { AppConfig } from "../src/config.js";
import type { ChatResult, LLMClient } from "../src/llm/index.js";
import type { MessageRecord } from "../src/types.js";

const ACCOUNT = "memory-ban-test";
const GROUP = "100";
const TARGET = "4455667788";
const NORMAL = "123456789";
const SUMMARY = "测试成员和普通成员约好周六出门。";
const FACT = "测试成员计划周六去爬山。";
const result = (content: string): ChatResult => ({ content, toolCalls: [], finishReason: "stop" });
const factResult = () => result(JSON.stringify([{ subject: "测试成员", kind: "plan", statement: FACT, confidence: 0.8 }]));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

function fixture(t: TestContext, llm: LLMClient) {
  const db = new Database(":memory:");
  const cfg: AppConfig["memory"] = { enabled: true, rawRetentionDays: 30, isolateByGroup: true, topicGapMinutes: 1, extraction: "llm", maxFactsPerTopic: 6 };
  const memory = new SqliteMemory(db, cfg, llm);
  t.after(() => { memory.stop(); db.close(); });
  const start = Date.now() - 5000;
  const records: MessageRecord[] = [
    { senderId: TARGET, name: "测试成员", text: "我准备周六去爬山" },
    { senderId: NORMAL, name: "普通成员", text: "那天我们一起出门" },
    { senderId: TARGET, name: "测试成员", text: "我打算带水" },
  ].map((record, index) => ({ eventKey: `${ACCOUNT}:group_${GROUP}:message:${index + 1}`, accountId: ACCOUNT, providerId: "fixture",
    conversationId: `group_${GROUP}`, groupId: GROUP, messageId: String(index + 1), senderId: record.senderId, displayNameAtTime: record.name,
    sentAt: new Date(start + index * 1000).toISOString(), receivedAt: new Date().toISOString(),
    segments: [{ type: "text", data: { text: record.text } }], textContent: record.text, status: "active", origin: "live" }));
  const populate = () => {
    for (const record of records) { db.insertMessage(record); memory.ingest(record); }
    return db.openTopics(ACCOUNT, GROUP)[0]!.id;
  };
  const finalize = (topicId: number) => (memory as unknown as { finalizeTopic(id: number): Promise<void> }).finalizeTopic(topicId);
  return { db, memory, records, populate, finalize };
}

test("黑名单记忆：LLM 摘要等待期间拉黑，旧 snapshot 不得写回摘要或继续提取事实", async (t) => {
  const entered = deferred<void>();
  const pending = deferred<ChatResult>();
  let calls = 0;
  const f = fixture(t, { async chat() {
    calls++;
    if (calls === 1) { entered.resolve(); return pending.promise; }
    return factResult();
  } });
  const topicId = f.populate();
  const finalizing = f.finalize(topicId);
  await entered.promise;
  f.db.blockUser(ACCOUNT, TARGET, "malicious attack");
  pending.resolve(result(SUMMARY));
  await finalizing;
  assert.equal(calls, 1, "被拉黑发送者污染的 snapshot 不能再进入事实提取模型");
  assert.equal(f.db.topicById(topicId)?.summary, null);
  assert.equal(f.db.topicById(topicId)?.participants, null);
  assert.equal(f.db.recentMemories(ACCOUNT, GROUP, 10).length, 0);
  assert.deepEqual(f.db.recentMessages(`group_${GROUP}`, 10).map(row => row.sender_id), [NORMAL]);
});

test("黑名单记忆：LLM 事实提取等待期间拉黑，旧 facts 不得写回，已有相关摘要同步清除", async (t) => {
  const entered = deferred<void>();
  const pending = deferred<ChatResult>();
  let calls = 0;
  const f = fixture(t, { async chat() {
    calls++;
    if (calls === 1) return result(SUMMARY);
    entered.resolve();
    return pending.promise;
  } });
  const topicId = f.populate();
  const finalizing = f.finalize(topicId);
  await entered.promise;
  assert.equal(f.db.topicById(topicId)?.summary, SUMMARY, "拉黑前正常摘要已保存");
  f.db.blockUser(ACCOUNT, TARGET, "malicious attack");
  pending.resolve(factResult());
  await finalizing;
  assert.equal(calls, 2);
  assert.equal(f.db.recentMemories(ACCOUNT, GROUP, 10).length, 0, "异步提取结果返回后必须重新检查真实黑名单");
  assert.equal(f.db.findMemoryByStatement(ACCOUNT, GROUP, FACT), undefined);
  assert.equal(f.db.topicById(topicId)?.summary, null);
  assert.equal(f.db.topicById(topicId)?.participants, null);
});

test("黑名单记忆：未被拉黑的正常话题照常保存，随后拉黑仅清除该讲述者的事实与参与摘要", async (t) => {
  let calls = 0;
  const f = fixture(t, { async chat() { return ++calls === 1 ? result(SUMMARY) : factResult(); } });
  const topicId = f.populate();
  await f.finalize(topicId);
  assert.equal(calls, 2);
  assert.equal(f.db.topicById(topicId)?.summary, SUMMARY);
  const fact = f.db.findMemoryByStatement(ACCOUNT, GROUP, FACT);
  assert.ok(fact);
  assert.equal(fact.narrator_id, TARGET);
  assert.equal(fact.subject_user_id, TARGET);
  f.db.insertMemory({ accountId: ACCOUNT, groupId: GROUP, kind: "fact", statement: "普通成员的独立事实。", narratorId: NORMAL, status: "confirmed", confidence: 1 });
  f.db.blockUser(ACCOUNT, TARGET, "malicious attack");
  assert.equal(f.db.findMemoryByStatement(ACCOUNT, GROUP, FACT), undefined);
  assert.deepEqual(f.db.recentMemories(ACCOUNT, GROUP, 10).map(row => row.narrator_id), [NORMAL]);
  assert.equal(f.db.topicById(topicId)?.summary, null);
  assert.equal(f.db.topicById(topicId)?.participants, null);
});

test("黑名单记忆：已屏蔽发送者不创建话题，未屏蔽发送者仍能进入记忆流程", (t) => {
  const f = fixture(t, { async chat() { throw new Error("ingest 不应调用模型"); } });
  f.db.blockUser(ACCOUNT, TARGET, "malicious attack");
  f.memory.ingest(f.records[0]!);
  assert.equal(f.db.openTopics(ACCOUNT, GROUP).length, 0);
  f.memory.ingest(f.records[1]!);
  const topics = f.db.openTopics(ACCOUNT, GROUP);
  assert.equal(topics.length, 1);
  assert.equal(topics[0]!.message_count, 1);
  f.memory.ingest(f.records[2]!);
  assert.equal(f.db.topicById(topics[0]!.id)?.message_count, 1, "已屏蔽消息不能污染既有话题统计");
});
