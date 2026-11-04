import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Database, type DBRow_Message } from "../src/db/index.js";
import type { AppConfig } from "../src/config.js";
import type { ChatResult, LLMClient } from "../src/llm/index.js";
import { SqliteMemory } from "../src/memory/index.js";
import { conservativeRuleCandidates, isNearDuplicateMemory, parseMemoryCandidates,
  validateMemoryCandidate } from "../src/memory/policy.js";
import type { MessageRecord } from "../src/types.js";

const ACCOUNT = "strict-memory-test";
const GROUP = "100";
const FIRST = "123456789";
const SECOND = "234567890";
const BOT = "999999999";
const PREFERENCE = "我喜欢《蔷薇色世界の扉》";
const SUMMARY = "这份话题摘要保留所有讨论的概况。";
const result = (content: string): ChatResult => ({ content, toolCalls: [], finishReason: "stop" });
const config: AppConfig["memory"] = { enabled: true, rawRetentionDays: 30, isolateByGroup: true,
  topicGapMinutes: 60, extraction: "llm", maxFactsPerTopic: 20 };

function fixture(t: TestContext, llm: LLMClient | null = null, extraction = config.extraction, selfId: () => string | undefined = () => BOT) {
  const db = new Database(":memory:");
  const memory = new SqliteMemory(db, { ...config, extraction }, llm, undefined, { selfId });
  t.after(() => { memory.stop(); db.close(); });
  let sequence = 0;
  const insert = (text: string, changes: Partial<MessageRecord> = {}): DBRow_Message => {
    const id = String(++sequence);
    const record: MessageRecord = { eventKey: `${ACCOUNT}:group_${GROUP}:message:${id}`, accountId: ACCOUNT,
      providerId: "fixture", conversationId: `group_${GROUP}`, groupId: GROUP, messageId: id,
      senderId: FIRST, displayNameAtTime: "同名成员", sentAt: new Date(Date.now() - 10_000 + sequence * 100).toISOString(),
      receivedAt: new Date().toISOString(), segments: [{ type: "text", data: { text } }],
      textContent: text, status: "active", origin: "live", ...changes };
    assert.equal(db.insertMessage(record).inserted, true);
    return db.getMessageByEventKey(record.eventKey)!;
  };
  const finalize = async (sources: DBRow_Message[]) => {
    const topicSources = [...sources];
    // 三条起使用模型摘要，让摘要与事实两次调用在所有集成场景中保持可观测。
    while (topicSources.length < 3) topicSources.push(insert("这是一条没有长期信息的普通聊天。"));
    for (const source of topicSources) memory.ingest(db.rowToRecord(source));
    const topic = db.openTopics(ACCOUNT, GROUP)[0];
    assert.ok(topic, "有效的群消息需要建立话题");
    db.closeTopic(topic.id, new Date().toISOString());
    await (memory as unknown as { finalizeTopic(id: number): Promise<void> }).finalizeTopic(topic.id);
    return topic.id;
  };
  return { db, memory, insert, finalize };
}

function candidate(source: DBRow_Message, changes: Record<string, unknown> = {}) {
  return { sourceMessageId: source.message_id, subjectUserId: source.sender_id, kind: "fact",
    category: "preference", evidence: source.text_content, confidence: 0.98, ...changes };
}

test("严格记忆解析：JSON 数组才是合法结果，空数组与解析失败有区别", () => {
  assert.deepEqual(parseMemoryCandidates("[]"), []);
  assert.deepEqual(parseMemoryCandidates('[{"sourceMessageId":"1"}]'), [{ sourceMessageId: "1" }]);
  for (const text of ["", "null", "{}", "我认为值得记住", "说明：[]", '[{"sourceMessageId":']) {
    assert.equal(parseMemoryCandidates(text), null, text);
  }
});

test("严格记忆类别：明确的长期偏好、稳定背景、持续项目、重复约定和长期计划均可留下", t => {
  const f = fixture(t);
  for (const [text, category, kind] of [
    [PREFERENCE, "preference", "fact"],
    ["我住宿舍，宿舍没有冰箱", "stable_context", "fact"],
    ["我维护的开源项目使用TypeScript开发", "project", "fact"],
    ["本群约定每周固定讨论开源项目", "recurring_agreement", "convention"],
    ["我计划今年持续学习西班牙语", "long_term_plan", "plan"],
  ] as const) {
    const source = f.insert(text);
    const validated = validateMemoryCandidate(candidate(source, { category, kind }), [source], BOT);
    assert.ok(validated, category);
    assert.equal(validated.category, category);
    assert.equal(validated.kind, kind);
    assert.ok(validated.statement.includes(text));
  }
});

test("严格记忆证据：用消息的真实发送者、昵称和逐字证据生成记忆，忽略模型编造的 statement", t => {
  const f = fixture(t);
  const first = f.insert("今天讨论了很多话题", { senderId: SECOND, displayNameAtTime: "同名成员" });
  const source = f.insert(PREFERENCE);
  const validated = validateMemoryCandidate(candidate(source, { statement: "他是这本书的作者。", subject: "错误昵称" }), [first, source], BOT);
  assert.ok(validated);
  assert.equal(validated.source.message_id, source.message_id);
  assert.equal(validated.subjectUserId, FIRST);
  assert.equal(validated.subjectName, source.sender_name);
  assert.equal(validated.evidence, PREFERENCE);
  assert.ok(validated.statement.includes(PREFERENCE));
  assert.ok(validated.statement.includes(source.sender_name));
  assert.ok(!validated.statement.includes("作者"));
});

test("严格记忆证据：无来源、证据不实、错误 QQ、弱置信度和未知 schema 均拒绝", t => {
  const f = fixture(t);
  const source = f.insert(PREFERENCE);
  const invalid: unknown[] = [null, [], "一条记忆", {},
    candidate(source, { sourceMessageId: undefined }),
    candidate(source, { sourceMessageId: "并不存在的消息" }),
    candidate(source, { evidence: undefined }),
    candidate(source, { evidence: "我喜欢《别的作品》" }),
    candidate(source, { subjectUserId: SECOND }),
    candidate(source, { subjectUserId: undefined }),
    candidate(source, { category: "weather" }),
    candidate(source, { category: undefined }),
    candidate(source, { kind: "joke" }),
    candidate(source, { kind: "unknown" }),
    candidate(source, { confidence: 0.89 }),
    candidate(source, { confidence: Number.NaN }),
    candidate(source, { confidence: "0.99" }),
  ];
  for (const raw of invalid) assert.equal(validateMemoryCandidate(raw, [source], BOT), undefined, JSON.stringify(raw));
});

test("严格记忆证据：只信真实 text segments，卡片、转发或 text_content 注入不能成为来源", t => {
  const f = fixture(t);
  const plain = f.insert(PREFERENCE, { segments: [{ type: "text", data: { text: "普通聊天内容" } }] });
  const card = f.insert(PREFERENCE, { segments: [{ type: "json", data: { data: JSON.stringify({ text: PREFERENCE }) } }] });
  const forwarded = f.insert(PREFERENCE, { segments: [{ type: "forward", data: { id: "forward-1" } }] });
  for (const source of [plain, card, forwarded]) {
    assert.equal(validateMemoryCandidate(candidate(source), [source], BOT), undefined, source.message_id);
    assert.deepEqual(conservativeRuleCandidates(source), []);
  }
});

test("严格记忆内容：引用、转述、代码和机器人自述不能变成本人长期偏好", t => {
  const f = fixture(t);
  for (const text of [`> ${PREFERENCE}`, `小明说：${PREFERENCE}`, `他说“${PREFERENCE}”`, `\`\`\`\n${PREFERENCE}\n\`\`\``]) {
    const source = f.insert(text);
    assert.equal(validateMemoryCandidate(candidate(source), [source], BOT), undefined, text);
    assert.deepEqual(conservativeRuleCandidates(source), [], text);
  }
  const bot = f.insert(PREFERENCE, { senderId: BOT });
  assert.equal(validateMemoryCandidate(candidate(bot), [bot], BOT), undefined);
});

test("严格记忆证据：不能截掉否定、条件或时间限制伪造长期偏好", t => {
  const f = fixture(t);
  for (const [text, evidence] of [
    ["我不喜欢爵士音乐", "喜欢爵士音乐"],
    ["如果我喜欢爵士音乐，我会告诉你", "我喜欢爵士音乐"],
    ["我喜欢爵士音乐只是今天的心情", "我喜欢爵士音乐"],
  ]) {
    const source = f.insert(text!);
    assert.equal(validateMemoryCandidate(candidate(source, { evidence }), [source], BOT), undefined, text);
  }
});

test("严格记忆证据：清除代码或引用不允许把否定片段两侧拼成肯定证据", t => {
  const f = fixture(t);
  for (const text of [
    "我`不`喜欢爵士音乐",
    "我```不```喜欢爵士音乐",
    "我~~~不~~~喜欢爵士音乐",
    "我<blockquote>不</blockquote>喜欢爵士音乐",
    "我[CQ:json,data=不]喜欢爵士音乐",
  ]) {
    const source = f.insert(text);
    const fabricated = candidate(source, { evidence: "我喜欢爵士音乐" });
    assert.equal(validateMemoryCandidate(fabricated, [source], BOT), undefined, text);
    assert.deepEqual(conservativeRuleCandidates(source), [], text);
  }
});

test("严格记忆内容：本人项目归属、早晚习惯与固定每周安排不被误判为临时状态", t => {
  const f = fixture(t);
  for (const [text, category, kind] of [
    ["我自己维护一个开源项目", "project", "fact"],
    ["我习惯早上听爵士音乐", "preference", "fact"],
    ["我习惯每天早上阅读", "preference", "fact"],
    ["我习惯每周日早上去跑步", "preference", "fact"],
    ["我习惯每周六去爬山", "preference", "fact"],
    ["本群约定每周日下午固定讨论开源项目", "recurring_agreement", "convention"],
  ] as const) {
    const source = f.insert(text);
    const validated = validateMemoryCandidate(candidate(source, { category, kind }), [source], BOT);
    assert.ok(validated, text);
    assert.equal(validated.evidence, text);
  }
  for (const text of ["我今天喜欢听爵士音乐", "我明天喜欢听爵士音乐", "我习惯每周六去爬山，今天也去"]) {
    const source = f.insert(text);
    assert.equal(validateMemoryCandidate(candidate(source), [source], BOT), undefined, text);
  }
});

test("严格记忆内容：天气、玩笑、当前状态和随口短期计划均拒绝", t => {
  const f = fixture(t);
  for (const text of ["今天好冷啊", "哈哈哈我是乌鸦", "我现在有点困", "我准备周六去爬山", "我明天要考试", "我打算带水"]) {
    const source = f.insert(text);
    assert.equal(validateMemoryCandidate(candidate(source), [source], BOT), undefined, text);
    assert.deepEqual(conservativeRuleCandidates(source), [], text);
  }
  const source = f.insert(PREFERENCE);
  assert.equal(conservativeRuleCandidates(source).length, 1, "明确的长期喜好可以通过保守规则");
});

test("严格记忆去重：同一 QQ 的标点近重复合并，同名不同 QQ 和不同 kind 分开", t => {
  const f = fixture(t);
  const source = f.insert(PREFERENCE);
  const validated = validateMemoryCandidate(candidate(source), [source], BOT)!;
  assert.ok(validated);
  const id = f.db.insertMemory({ accountId: ACCOUNT, groupId: GROUP, kind: validated.kind,
    subjectUserId: FIRST, subjectName: source.sender_name, statement: `${validated.statement}。`,
    narratorId: FIRST, status: "candidate", confidence: 0.98 });
  const existing = f.db.memoryById(id)!;
  assert.equal(isNearDuplicateMemory(validated, existing), true);
  assert.equal(isNearDuplicateMemory(validated, { ...existing, subject_user_id: SECOND, narrator_id: SECOND }), false);
  assert.equal(isNearDuplicateMemory(validated, { ...existing, kind: "plan" }), false);
  const opposite = f.insert("我不喜欢《蔷薇色世界の扉》");
  const corrected = validateMemoryCandidate(candidate(opposite), [opposite], BOT)!;
  assert.ok(corrected);
  assert.equal(isNearDuplicateMemory(corrected, existing), false, "含否定的新喜好不能被当成重复吞掉");
});

test("严格记忆去重：保留完整否定序列，无糖和讨厌等词不能掩盖相反喜好", t => {
  const f = fixture(t);
  for (const [original, opposite] of [
    ["我喜欢无糖可乐", "我不喜欢无糖可乐"],
    ["我讨厌每天下雨的天气", "我不讨厌每天下雨的天气"],
  ] as const) {
    const firstSource = f.insert(original);
    const first = validateMemoryCandidate(candidate(firstSource), [firstSource], BOT)!;
    assert.ok(first, original);
    const id = f.db.insertMemory({ accountId: ACCOUNT, groupId: GROUP, kind: "fact", subjectUserId: FIRST,
      subjectName: firstSource.sender_name, statement: first.statement, narratorId: FIRST,
      status: "candidate", confidence: 0.98 });
    const secondSource = f.insert(opposite);
    const second = validateMemoryCandidate(candidate(secondSource), [secondSource], BOT)!;
    assert.ok(second, opposite);
    assert.equal(isNearDuplicateMemory(second, f.db.memoryById(id)!), false, `${original} / ${opposite}`);
  }
});

test("严格记忆集成：模型返回 [] 或无效候选后不改走规则，摘要继续保存", async t => {
  for (const answer of ["[]", '[{"statement":"我准备周六去爬山","kind":"plan"}]']) {
    let calls = 0;
    const f = fixture(t, { async chat() { return result(++calls === 1 ? SUMMARY : answer); } });
    const source = f.insert(PREFERENCE);
    const topic = await f.finalize([source]);
    assert.equal(calls, 2);
    assert.equal(f.db.topicById(topic)?.summary, SUMMARY);
    assert.equal(f.db.recentMemories(ACCOUNT, GROUP, 10).length, 0, answer);
  }
});

test("严格记忆集成：模型调用失败仅回退保守长期偏好，临时计划仍只在摘要中", async t => {
  let calls = 0;
  const f = fixture(t, { async chat() {
    if (++calls === 1) return result(SUMMARY);
    throw new Error("模拟事实模型不可用");
  } });
  const plan = f.insert("我准备周六去爬山", { senderId: SECOND });
  const source = f.insert(PREFERENCE);
  const topic = await f.finalize([plan, source]);
  const memories = f.db.recentMemories(ACCOUNT, GROUP, 10);
  assert.equal(f.db.topicById(topic)?.summary, SUMMARY);
  assert.equal(memories.length, 1);
  assert.equal(memories[0]!.narrator_id, FIRST);
  assert.equal(memories[0]!.source_message_id, source.message_id);
  assert.ok(memories[0]!.statement.includes(PREFERENCE));
});

test("严格记忆集成：明确关闭提取或尚未确认机器人 QQ 时只保存摘要", async t => {
  for (const mode of ["off", "unknown-self"] as const) {
    let calls = 0;
    const f = fixture(t, { async chat() { calls++; return result(SUMMARY); } }, mode === "off" ? "off" : "llm",
      mode === "unknown-self" ? () => undefined : () => BOT);
    const topic = await f.finalize([f.insert(PREFERENCE)]);
    assert.ok(f.db.topicById(topic)?.summary);
    assert.equal(f.db.recentMemories(ACCOUNT, GROUP, 10).length, 0, mode);
    assert.equal(calls, mode === "off" ? 0 : 1, "关闭事实提取不应继续调用事实模型");
  }
});

test("严格记忆集成：模型等待期间来源被撤回，旧候选不能落库", async t => {
  let enter!: () => void;
  let release!: (value: ChatResult) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<ChatResult>(resolve => { release = resolve; });
  t.after(() => release(result("[]")));
  let calls = 0;
  const f = fixture(t, { async chat() {
    if (++calls === 1) return result(SUMMARY);
    enter();
    return pending;
  } });
  const source = f.insert(PREFERENCE);
  const finalizing = f.finalize([source]);
  await entered;
  assert.equal(f.db.markRecalled("group_100", source.message_id), true);
  release(result(JSON.stringify([candidate(source)])));
  await finalizing;
  assert.equal(f.db.recentMemories(ACCOUNT, GROUP, 10).length, 0);
});

test("严格记忆集成：按证据来源归因，同名不同 QQ 分别保存，同一人近重复跨话题合并", async t => {
  let candidates: unknown[] = [];
  let calls = 0;
  const f = fixture(t, { async chat() { return result(++calls % 2 === 1 ? SUMMARY : JSON.stringify(candidates)); } });
  const unrelated = f.insert("只是先说了一句话", { senderId: SECOND });
  const source = f.insert(PREFERENCE);
  candidates = [candidate(source)];
  await f.finalize([unrelated, source]);
  const first = f.db.recentMemories(ACCOUNT, GROUP, 10)[0]!;
  assert.equal(first.narrator_id, FIRST);
  assert.equal(first.subject_user_id, FIRST);
  assert.equal(first.source_message_id, source.message_id);
  assert.equal(first.source_sent_at, source.sent_at);

  const repeated = f.insert(`${PREFERENCE}。`);
  candidates = [candidate(repeated)];
  await f.finalize([repeated]);
  assert.equal(f.db.recentMemories(ACCOUNT, GROUP, 10).length, 1);

  const namesake = f.insert(PREFERENCE, { senderId: SECOND });
  candidates = [candidate(namesake)];
  await f.finalize([namesake]);
  const memories = f.db.recentMemories(ACCOUNT, GROUP, 10);
  assert.equal(memories.length, 2, "同名和相同喜好不能让另一个 QQ 的记忆被吞掉");
  assert.deepEqual(new Set(memories.map(row => row.subject_user_id)), new Set([FIRST, SECOND]));
});

test("严格记忆集成：每话题最多新增 3 条，机器人发言不进入自动提取", async t => {
  let candidates: unknown[] = [];
  let calls = 0;
  const f = fixture(t, { async chat(messages) {
    if (++calls % 2 === 1) return result(SUMMARY);
    const transcript = JSON.parse(String(messages[1]?.content)) as { senderId: string }[];
    assert.ok(transcript.every(source => source.senderId !== BOT), "机器人发言不进入事实提取模型输入");
    return result(JSON.stringify(candidates));
  } });
  const bot = f.insert("我喜欢古典音乐", { senderId: BOT });
  f.memory.ingest(f.db.rowToRecord(bot));
  const sources = ["我喜欢阅读科幻小说", "我喜欢在周末画水彩画", "我喜欢听爵士音乐", "我喜欢研究天文摄影"].map(text => f.insert(text));
  candidates = [candidate(bot), ...sources.map(source => candidate(source))];
  const topic = await f.finalize(sources);
  assert.equal(f.db.topicById(topic)?.summary, SUMMARY);
  const memories = f.db.recentMemories(ACCOUNT, GROUP, 20);
  assert.equal(memories.length, 3);
  assert.ok(memories.every(row => row.narrator_id !== BOT));
});

test("严格记忆集成：新过滤规则不改写或删除已有历史记忆与摘要", async t => {
  let calls = 0;
  const f = fixture(t, { async chat() { return result(++calls % 2 === 1 ? SUMMARY : "[]"); } });
  const oldId = f.db.insertMemory({ accountId: ACCOUNT, groupId: GROUP, kind: "joke", statement: "从前保留下来的群内玩笑",
    narratorId: FIRST, status: "candidate", confidence: 0.5 });
  const historical = f.db.upsertOpenTopic(ACCOUNT, GROUP, { id: "old-1", sentAt: "2026-09-01T00:00:00.000Z" });
  f.db.closeTopic(historical, "2026-09-01T00:10:00.000Z");
  f.db.setTopicSummary(historical, "原有历史摘要", [{ id: FIRST, count: 1 }]);
  const before = { memory: f.db.memoryById(oldId), topic: f.db.topicById(historical) };
  await f.finalize([f.insert("我准备周六去爬山")]);
  assert.deepEqual(f.db.memoryById(oldId), before.memory);
  assert.deepEqual(f.db.topicById(historical), before.topic);
});
