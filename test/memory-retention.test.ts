import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../src/db/index.js";
import { SqliteMemory } from "../src/memory/index.js";
import type { AppConfig } from "../src/config.js";
import type { ChatResult, LLMClient } from "../src/llm/index.js";
import type { MessageRecord } from "../src/types.js";

const ACCOUNT = "retention-test";
const GROUP = "100";
const result = (content: string): ChatResult => ({ content, toolCalls: [], finishReason: "stop" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

function fixture(t: TestContext, llm: LLMClient | null = null, topicGapMinutes = 3 * 24 * 60) {
  const db = new Database(":memory:");
  const cfg: AppConfig["memory"] = { enabled: true, rawRetentionDays: 1, isolateByGroup: true,
    topicGapMinutes, extraction: llm ? "llm" : "rules", maxFactsPerTopic: 6 };
  const memory = new SqliteMemory(db, cfg, llm);
  t.after(() => { memory.stop(); db.close(); });
  let sequence = 0;
  const insert = (sentAt: number, text: string): MessageRecord => {
    const id = String(++sequence);
    const message: MessageRecord = { eventKey: `${ACCOUNT}:group_${GROUP}:message:${id}`, accountId: ACCOUNT,
      providerId: "fixture", conversationId: `group_${GROUP}`, groupId: GROUP, messageId: id,
      senderId: "123456789", displayNameAtTime: "群成员", sentAt: new Date(sentAt).toISOString(),
      receivedAt: new Date().toISOString(), segments: [{ type: "text", data: { text } }],
      textContent: text, status: "active", origin: "live" };
    db.insertMessage(message);
    memory.ingest(message);
    return message;
  };
  return { db, memory, insert };
}

test("原文清理：跨日忙群先结束并摘要，等待期间的新消息另开话题，旧摘要和记忆保留", async (t) => {
  const waiting = deferred<ChatResult>();
  let calls = 0;
  let transcript = "";
  const f = fixture(t, { async chat(messages) {
    calls++;
    if (calls === 1) { transcript = String(messages[1]?.content); return waiting.promise; }
    return result("[]");
  } });
  const cutoff = Date.now() - 60 * 60_000;
  f.insert(cutoff - 3000, "昨天讨论的开头");
  f.insert(cutoff - 2000, "昨天讨论的中段");
  f.insert(cutoff - 1000, "昨天讨论的结尾");
  const retained = f.insert(Date.now() - 5000, "零点后继续讨论的内容");
  const oldTopic = f.db.openTopics(ACCOUNT, GROUP)[0]!;
  const factId = f.db.insertMemory({ accountId: ACCOUNT, groupId: GROUP, kind: "fact", statement: "原有记忆原样保留",
    narratorId: "123456789", status: "candidate", confidence: 0.6 });
  const factBefore = f.db.memoryById(factId);
  const preparing = f.memory.prepareForMessagePurge(new Date(cutoff).toISOString());
  assert.ok(f.db.topicById(oldTopic.id)?.ended_at, "第一次 await 前必须关闭旧话题");
  assert.match(transcript, /零点后继续讨论的内容/);
  const fresh = f.insert(Date.now() + 1000, "清理等待期间的新话题");
  const newTopic = f.db.openTopics(ACCOUNT, GROUP)[0]!;
  assert.notEqual(newTopic.id, oldTopic.id);
  waiting.resolve(result("昨日与零点后的讨论均已保存。"));
  await preparing;
  f.db.db.prepare("DELETE FROM messages WHERE sent_at < ?").run(new Date(cutoff).toISOString());
  assert.equal(f.db.topicById(oldTopic.id)?.summary, "昨日与零点后的讨论均已保存。");
  assert.deepEqual(f.db.memoryById(factId), factBefore);
  assert.deepEqual(f.db.recentMessages(`group_${GROUP}`, 10).map(row => row.message_id), [fresh.messageId, retained.messageId]);
  assert.equal(f.db.topicById(newTopic.id)?.ended_at, null);
  assert.equal(calls, 2, "一次摘要和一次事实提取，不因清理重复提取");
});

test("原文清理：等待已开始的收尾，同一话题不重复调用模型", async (t) => {
  const entered = deferred<void>();
  const waiting = deferred<ChatResult>();
  let calls = 0;
  const f = fixture(t, { async chat() {
    if (++calls === 1) { entered.resolve(); return waiting.promise; }
    return result("[]");
  } }, 1);
  const old = Date.now() - 120_000;
  f.insert(old - 2000, "一段旧讨论");
  f.insert(old - 1000, "旧讨论的补充");
  f.insert(old, "旧讨论的结论");
  const topicId = f.db.openTopics(ACCOUNT, GROUP)[0]!.id;
  const ticking = f.memory.tick();
  await entered.promise;
  let finished = false;
  const preparing = f.memory.prepareForMessagePurge(new Date(Date.now() - 60_000).toISOString()).then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(calls, 1);
  waiting.resolve(result("进行中的旧讨论摘要。"));
  await Promise.all([ticking, preparing]);
  assert.equal(calls, 2);
  assert.equal(f.db.topicById(topicId)?.summary, "进行中的旧讨论摘要。");
});

test("原文清理：保留已有摘要，仅补回已关闭话题缺失的摘要，遵守结束边界", async (t) => {
  let factCalls = 0;
  const f = fixture(t, { async chat(messages) {
    assert.match(String(messages[0]?.content), /提取值得记住的事实/, "只有缺失摘要的话题需要一次事实提取");
    factCalls++;
    return result("[]");
  } });
  const base = Date.now() - 100_000;
  const cutoff = new Date(base + 10_000).toISOString();
  f.insert(base, "有摘要的历史话题");
  const existing = f.db.openTopics(ACCOUNT, GROUP)[0]!.id;
  f.db.closeTopic(existing, new Date(base + 1000).toISOString());
  f.db.setTopicSummary(existing, "这份历史摘要保持原样。", [{ id: "123456789", name: "旧昵称", count: 1 }]);
  const before = f.db.topicById(existing);
  f.insert(base + 2000, "需要补回摘要的旧内容");
  const missing = f.db.openTopics(ACCOUNT, GROUP)[0]!.id;
  f.db.closeTopic(missing, new Date(base + 3000).toISOString());
  f.insert(base + 3000, "边界上的下一段内容不能混入上一话题");
  const last = f.db.openTopics(ACCOUNT, GROUP)[0]!.id;
  f.db.closeTopic(last, new Date(base + 4000).toISOString());
  f.db.setTopicSummary(last, "下一话题已有摘要。", []);
  await f.memory.prepareForMessagePurge(cutoff);
  assert.deepEqual(f.db.topicById(existing), before);
  const summary = f.db.topicById(missing)?.summary;
  assert.match(summary ?? "", /需要补回摘要的旧内容/);
  assert.doesNotMatch(summary ?? "", /下一段内容/);
  assert.equal(factCalls, 1, "已有摘要的话题不重新提取");
});

test("原文清理：摘要模型失败或空回复时先保存非空规则摘要", async (t) => {
  for (const empty of [false, true]) {
    const f = fixture(t, { async chat() {
      if (!empty) throw new Error("模型暂时不可用");
      return result("");
    } });
    const base = Date.now() - 10_000;
    for (let i = 0; i < 3; i++) f.insert(base + i * 1000, `必须留下的讨论片段 ${i}`);
    const topicId = f.db.openTopics(ACCOUNT, GROUP)[0]!.id;
    await f.memory.prepareForMessagePurge(new Date(Date.now() - 1000).toISOString());
    assert.match(f.db.topicById(topicId)?.summary ?? "", /3 条消息.*必须留下的讨论片段/);
  }
});

test("原文清理：摘要落库失败必须拒绝清理，原文仍保留", async (t) => {
  const f = fixture(t);
  f.insert(Date.now() - 10_000, "摘要保存失败也不能直接删除这条原文");
  const topicId = f.db.openTopics(ACCOUNT, GROUP)[0]!.id;
  const save = f.db.setTopicSummary;
  f.db.setTopicSummary = () => { throw new Error("模拟摘要落库失败"); };
  try {
    await assert.rejects(async () => {
      const cutoff = new Date(Date.now() - 1000).toISOString();
      await f.memory.prepareForMessagePurge(cutoff);
      f.db.db.prepare("DELETE FROM messages WHERE sent_at < ?").run(cutoff);
    }, /模拟摘要落库失败/);
  } finally { f.db.setTopicSummary = save; }
  assert.equal(f.db.recentMessages(`group_${GROUP}`, 10).length, 1);
  assert.equal(f.db.topicById(topicId)?.summary, null);
  await f.memory.prepareForMessagePurge(new Date(Date.now() - 1000).toISOString());
  assert.ok(f.db.topicById(topicId)?.summary, "失败后下一次清理可补回已关闭话题的摘要");
});
