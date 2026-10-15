import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/db/index.js";
import { GroupKnowledge, extractGroupLinks, firstReadSentence, groupLinkIdentity } from "../src/group-knowledge/index.js";
import type { MessageRecord } from "../src/types.js";

let temporary: string;
let db: Database;
let serial = 0;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "group-knowledge-"));
  db = new Database(path.join(temporary, "state.db"));
  serial = 0;
});
afterEach(() => { db.db.close(); fs.rmSync(temporary, { recursive: true, force: true }); });

function insert(text: string, changes: Partial<MessageRecord> = {}): MessageRecord {
  const id = String(++serial);
  const message: MessageRecord = { eventKey: `acct:g:message:${id}`, accountId: "acct", providerId: "onebot",
    conversationId: "group_g", groupId: "g", messageId: id, senderId: "person", displayNameAtTime: "小明",
    sentAt: "2026-10-01T10:00:00.000Z", receivedAt: "2026-10-01T10:00:01.000Z", segments: [{ type: "text", data: { text } }],
    textContent: text, status: "active", origin: "live", ...changes };
  db.insertMessage(message);
  return message;
}

test("首次回填已有中文消息，支持单字、双字、长词和英文词", () => {
  const original = insert("最近在用浏览器自动化库 Playwright，特别好用。");
  const knowledge = new GroupKnowledge(db);
  for (const query of ["库", "浏览", "浏览器自动化", "Playwright", "浏览器 Playwright"]) {
    const hits = knowledge.search("acct", "g", query);
    assert.equal(hits.length, 1, query);
    assert.equal(hits[0]!.messageId, original.messageId);
    assert.equal(hits[0]!.senderName, "小明");
    assert.equal(hits[0]!.sentAt, original.sentAt);
    assert.match(hits[0]!.excerpt, /Playwright/);
  }
  assert.equal(knowledge.search("acct", "g", "并不存在的库").length, 0);
});

test("SQL触发器实时维护新消息、修改和撤回", () => {
  const knowledge = new GroupKnowledge(db);
  const message = insert("前端 React 组件");
  assert.equal(knowledge.search("acct", "g", "组件").length, 1);
  db.db.prepare("UPDATE messages SET text_content=? WHERE message_id=?").run("改用 Vue 组件", message.messageId);
  assert.equal(knowledge.search("acct", "g", "React").length, 0);
  assert.equal(knowledge.search("acct", "g", "Vue").length, 1);
  db.markRecalled("group_g", message.messageId);
  assert.equal(knowledge.search("acct", "g", "组件").length, 0);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM group_message_fts").get() as { n: number }).n, 0);
});

test("FTS严格按账号群隔离，私聊不入索引", () => {
  insert("共同关键词");
  insert("共同关键词", { accountId: "other", eventKey: "other:g:2" });
  insert("共同关键词", { groupId: "other", conversationId: "group_other" });
  insert("私密关键词", { groupId: undefined, conversationId: "private_person" });
  const knowledge = new GroupKnowledge(db);
  assert.equal(knowledge.search("acct", "g", "关键词").length, 1);
  assert.equal(knowledge.search("other", "g", "关键词").length, 1);
  assert.equal(knowledge.search("acct", "other", "关键词").length, 1);
  assert.equal(knowledge.search("acct", "g", "私密").length, 0);
});

test("屏蔽、直接删除和记忆清理不会留下可搜索副本", () => {
  const knowledge = new GroupKnowledge(db);
  insert("屏蔽的关键词");
  db.blockUser("acct", "person", "test");
  assert.equal(knowledge.search("acct", "g", "关键词").length, 0);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM group_message_fts").get() as { n: number }).n, 0);
  db.unblockUser("acct", "person");
  insert("清理的关键词");
  db.clearConversationMemory();
  assert.equal(knowledge.search("acct", "g", "关键词").length, 0);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM group_message_fts").get() as { n: number }).n, 0);
});

test("搜索字符串不能注入MATCH操作符或SQL，且结果数有上限", () => {
  const knowledge = new GroupKnowledge(db);
  for (let index = 0; index < 16; index++) insert("苹果香蕉");
  assert.doesNotThrow(() => knowledge.search("acct", "g", '" OR * ( ) NEAR(x) - { [ : \' ; --'));
  assert.equal(knowledge.search("acct", "g", "不存在 OR 香蕉").length, 0);
  assert.equal(knowledge.search("acct", "g", "香蕉", 999).length, 10);
  assert.equal(knowledge.search("acct", "g", "香蕉", Number.NaN).length, 5);
  assert.equal(knowledge.search("acct", "g", " ").length, 0);
});

test("重开数据库连接后持久化触发器依然可写，避免缺少tokenizer函数", () => {
  new GroupKnowledge(db);
  db.db.close();
  db = new Database(path.join(temporary, "state.db"));
  insert("重启后索引");
  assert.equal(new GroupKnowledge(db).search("acct", "g", "索引").length, 1);
});

test("复用研究URL清理：移除追踪参数、普通锚点与参数排序，保留SPA路径和业务参数", () => {
  const one = groupLinkIdentity("https://EXAMPLE.com/page?b=2&utm_source=qq&a=1#section");
  const two = groupLinkIdentity("https://example.com/page?a=1&b=2");
  assert.deepEqual(one, two);
  assert.notEqual(one?.fingerprint, groupLinkIdentity("https://example.com/page?a=2&b=2")?.fingerprint);
  assert.notEqual(groupLinkIdentity("https://example.com/#/a")?.fingerprint, groupLinkIdentity("https://example.com/#/b")?.fingerprint);
  for (const unsafe of ["file:///etc/passwd", "https://user:pass@example.com", "http://localhost/a", "http://127.0.0.1/a", "http://192.168.1.1/a"]) {
    assert.equal(groupLinkIdentity(unsafe), null, unsafe);
  }
});

test("链接抽取支持分享卡片，去标点、去重并限制每条消息记录数量", () => {
  assert.deepEqual(extractGroupLinks("看看 https://example.com/a?utm_source=qq。 https://example.com/a", [
    { type: "share", data: { url: "https://example.com/b" } },
  ]), ["https://example.com/a", "https://example.com/b"]);
  assert.equal(extractGroupLinks(Array.from({ length: 30 }, (_, index) => `https://example.com/${index}`).join(" ")).length, 20);
});

test("7天冷却按上次分享计算，近距离重复静默但不消耗未来提醒", () => {
  const first = insert("https://example.com/article", { origin: "backfill" });
  const knowledge = new GroupKnowledge(db);
  const near = insert("https://example.com/article", { sentAt: "2026-10-02T10:00:00.000Z" });
  assert.deepEqual(knowledge.prepareDuplicates(near), []);
  const stillNear = insert("https://example.com/article", { sentAt: "2026-10-08T10:00:00.000Z" });
  assert.deepEqual(knowledge.prepareDuplicates(stillNear), []);
  const old = insert("https://example.com/article?utm_source=qq", { sentAt: "2026-10-15T10:00:00.000Z" });
  const notice = knowledge.prepareDuplicates(old)[0]!;
  assert.ok(notice);
  assert.equal(notice.previousMessageId, stillNear.messageId);
  assert.equal(notice.text, "这个上次小明发过。");
  assert.deepEqual(notice.segments[0], { type: "reply", data: { id: stillNear.messageId } });
  assert.notEqual(notice.previousMessageId, first.messageId);
});

test("prepare不消耗提醒，commit之后重启和以后重复都静默，同URL只提醒一次", () => {
  insert("https://example.com/article");
  let knowledge = new GroupKnowledge(db);
  const current = insert("https://example.com/article", { sentAt: "2026-10-10T10:00:00.000Z" });
  const first = knowledge.prepareDuplicates(current)[0]!;
  assert.equal(knowledge.prepareDuplicates(current).length, 1, "被配额拒绝后仍可再准备");
  assert.equal(knowledge.commitDuplicate(first), true);
  assert.equal(knowledge.commitDuplicate(first), false);
  db.db.close();
  db = new Database(path.join(temporary, "state.db"));
  knowledge = new GroupKnowledge(db);
  const later = insert("https://example.com/article", { sentAt: "2026-11-01T10:00:00.000Z" });
  assert.deepEqual(knowledge.prepareDuplicates(later), []);
});

test("摘要只使用原分享消息在本账号本群读过的页面第一句", () => {
  const source = insert("https://example.com/article");
  const knowledge = new GroupKnowledge(db);
  db.insertLinkRead({ accountId: "acct", groupId: "g", url: "https://example.com/article?utm_source=qq", status: "ok",
    sharedMessageId: source.messageId, summary: "这个库支持离线解析。下一句不应该出现在提醒里。" });
  db.db.prepare("UPDATE link_reads SET created_at=?").run("2026-10-01T11:00:00.000Z");
  const current = insert("https://example.com/article", { sentAt: "2026-10-10T10:00:00.000Z" });
  const notice = knowledge.prepareDuplicates(current)[0]!;
  assert.equal(notice.text, "这个小明发过了，当时的结论是：这个库支持离线解析。");
});

test("失败读取、别的群或账号的摘要不能被借用", () => {
  const source = insert("https://example.com/article");
  const knowledge = new GroupKnowledge(db);
  for (const [accountId, groupId, status] of [["acct", "other", "ok"], ["other", "g", "ok"], ["acct", "g", "failed"]] as const) {
    db.insertLinkRead({ accountId, groupId, status, url: "https://example.com/article", sharedMessageId: source.messageId, summary: "秘密结论。" });
  }
  db.db.prepare("UPDATE link_reads SET created_at=?").run("2026-10-01T11:00:00.000Z");
  const current = insert("https://example.com/article", { sentAt: "2026-10-10T10:00:00.000Z" });
  assert.equal(knowledge.prepareDuplicates(current)[0]?.text, "这个上次小明发过。");
});

test("链接观察按账号群隔离，私聊不查重，补历史消息不触发提醒", () => {
  insert("https://example.com/article");
  const knowledge = new GroupKnowledge(db);
  const changes = [
    { accountId: "other", eventKey: "other:new", sentAt: "2026-10-10T10:00:00.000Z" },
    { groupId: "other", conversationId: "group_other", sentAt: "2026-10-10T10:00:00.000Z" },
    { groupId: undefined, conversationId: "private_person", sentAt: "2026-10-10T10:00:00.000Z" },
    { origin: "backfill" as const, sentAt: "2026-10-10T10:00:00.000Z" },
  ];
  for (const change of changes) assert.deepEqual(knowledge.prepareDuplicates(insert("https://example.com/article", change)), []);
});

test("原消息撤回或发送者被屏蔽后不再引用，也不保留链接索引", () => {
  const source = insert("https://example.com/article");
  const knowledge = new GroupKnowledge(db);
  const current = insert("https://example.com/article", { sentAt: "2026-10-10T10:00:00.000Z", senderId: "other" });
  const notice = knowledge.prepareDuplicates(current)[0]!;
  db.markRecalled("group_g", source.messageId);
  assert.equal(knowledge.commitDuplicate(notice), false);
  assert.deepEqual(knowledge.prepareDuplicates(current), []);
  db.blockUser("acct", "other", "test");
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM group_link_shares").get() as { n: number }).n, 0);
});

test("全文和链接索引跟随保留期物理清理，不积存幽灵消息", () => {
  insert("旧链接 https://example.com/article", { sentAt: "2020-01-01T00:00:00.000Z" });
  const knowledge = new GroupKnowledge(db);
  assert.equal(knowledge.search("acct", "g", "旧链接").length, 1);
  db.purgeOldMessages(1);
  assert.equal(knowledge.search("acct", "g", "旧链接").length, 0);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM group_link_shares").get() as { n: number }).n, 0);
});

test("摘要清洗去除CQ控制段，长度受限且不生成第二句话", () => {
  assert.equal(firstReadSentence("[CQ:at,qq=123] 第一条结论！第二句话。"), "第一条结论！");
  assert.equal(firstReadSentence("English sentence. Next sentence."), "English sentence.");
  assert.ok(firstReadSentence("字".repeat(1000)).length <= 180);
});

test("长中文词必须实际连续出现，不能仅靠分散bigram命中", () => {
  insert("浏览工具和览器片段碰巧都有，不代表同一个词。");
  const correct = insert("这个浏览器自动化项目支持 Playwright。");
  const knowledge = new GroupKnowledge(db);
  assert.deepEqual(knowledge.search("acct", "g", "浏览器").map(hit => hit.messageId), [correct.messageId]);
  assert.equal(knowledge.search("acct", "g", "浏览器 Playwright").length, 1);
});

test("全文搜索NFKC归一，跨账号撤回和屏蔽不影响当前账号同ID结果", () => {
  const one = insert("ＡＰＩ工具支持中文索引", { messageId: "shared-id" });
  insert("ＡＰＩ工具支持中文索引", { accountId: "other", conversationId: "other-group_g", messageId: "shared-id", eventKey: "other:shared" });
  const knowledge = new GroupKnowledge(db);
  db.markRecalled("other-group_g", "shared-id"); db.blockUser("other", "person", "fixture");
  assert.equal(knowledge.search("acct", "g", "api")[0]?.messageId, one.messageId);
  assert.equal(knowledge.search("other", "g", "api").length, 0);
});

test("首句跳过Markdown/Setext标题和已知页面标题，只有标题时不给结论", () => {
  assert.equal(firstReadSentence("# 项目首页\n\n## 简介\n这个库支持离线解析。第二句话。", "项目首页"), "这个库支持离线解析。");
  assert.equal(firstReadSentence("项目首页\n====\n\n这个库支持离线解析。第二句话。"), "这个库支持离线解析。");
  assert.equal(firstReadSentence("项目首页\n\n这个库支持离线解析。第二句话。", "项目首页"), "这个库支持离线解析。");
  assert.equal(firstReadSentence("# 项目首页", "项目首页"), "");
  assert.equal(firstReadSentence("项目首页", "项目首页"), "");
  assert.equal(firstReadSentence("# 项目首页 这个库支持离线解析。第二句话。", "项目首页"), "这个库支持离线解析。");
});

test("读过但仅抽取到标题时退化为发过提醒，不把标题称为结论", () => {
  const source = insert("https://example.com/article"); const knowledge = new GroupKnowledge(db);
  db.insertLinkRead({ accountId: "acct", groupId: "g", url: "https://example.com/article", status: "ok", sharedMessageId: source.messageId,
    title: "这个项目的名字", summary: "# 这个项目的名字" });
  db.db.prepare("UPDATE link_reads SET created_at=?").run("2026-10-01T11:00:00.000Z");
  const current = insert("https://example.com/article", { sentAt: "2026-10-10T10:00:00.000Z" });
  assert.equal(knowledge.prepareDuplicates(current)[0]?.text, "这个上次小明发过。");
});

test("旧摘要可去掉已压平的已知页面标题后取正文第一句", () => {
  const source = insert("https://example.com/article"); const knowledge = new GroupKnowledge(db);
  db.insertLinkRead({ accountId: "acct", groupId: "g", url: "https://example.com/article", status: "ok", sharedMessageId: source.messageId,
    title: "项目首页", summary: "# 项目首页 这个库支持离线解析。第二句。" });
  db.db.prepare("UPDATE link_reads SET created_at=?").run("2026-10-01T11:00:00.000Z");
  const current = insert("https://example.com/article", { sentAt: "2026-10-10T10:00:00.000Z" });
  assert.equal(knowledge.prepareDuplicates(current)[0]?.text, "这个小明发过了，当时的结论是：这个库支持离线解析。");
});

test("prepare后原文或当前文移除URL不能再commit旧提醒", () => {
  const source = insert("https://example.com/article"); const knowledge = new GroupKnowledge(db);
  const current = insert("https://example.com/article", { sentAt: "2026-10-10T10:00:00.000Z" });
  const notice = knowledge.prepareDuplicates(current)[0]!;
  db.db.prepare("UPDATE messages SET text_content='已编辑为无链接' WHERE message_id=?").run(source.messageId);
  assert.equal(knowledge.commitDuplicate(notice), false);
  const source2 = insert("https://example.com/other", { sentAt: "2026-10-01T10:00:00.000Z" }); knowledge.prepareDuplicates(source2);
  const current2 = insert("https://example.com/other", { sentAt: "2026-10-10T10:00:00.000Z" });
  const notice2 = knowledge.prepareDuplicates(current2)[0]!;
  db.db.prepare("UPDATE messages SET text_content='当前链接也已移除' WHERE message_id=?").run(current2.messageId);
  assert.equal(knowledge.commitDuplicate(notice2), false);
});

test("prepare后补到更近的历史分享时不引用过时的较早消息", () => {
  insert("https://example.com/article"); const knowledge = new GroupKnowledge(db);
  const current = insert("https://example.com/article", { sentAt: "2026-10-10T10:00:00.000Z" });
  const notice = knowledge.prepareDuplicates(current)[0]!;
  const backfill = insert("https://example.com/article", { sentAt: "2026-10-09T10:00:00.000Z", origin: "backfill" }); knowledge.prepareDuplicates(backfill);
  assert.equal(knowledge.commitDuplicate(notice), false);
  assert.deepEqual(knowledge.prepareDuplicates(current), []);
});

test("链接抽取容忍坏分享卡片，移除包裹括号但保留URL内成对括号", () => {
  assert.deepEqual(extractGroupLinks("看看 (https://example.com/a)。 https://example.com/wiki/Thing_(name)", [null, { type: "share" }, { type: "share", data: { url: 123 } }] as any),
    ["https://example.com/a", "https://example.com/wiki/Thing_(name)"]);
});

test("once墓碑在撤回和保留期删除后保留，原文与链接索引依然及时移除", () => {
  const source = insert("https://example.com/once", { sentAt: "2020-01-01T10:00:00.000Z" });
  const knowledge = new GroupKnowledge(db);
  const current = insert("https://example.com/once", { sentAt: "2020-01-10T10:00:00.000Z" });
  assert.equal(knowledge.commitDuplicate(knowledge.prepareDuplicates(current)[0]!), true);
  db.markRecalled("group_g", source.messageId, "acct");
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM group_link_notices").get() as { n: number }).n, 1);
  db.purgeOldMessages(1);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 0);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM group_link_shares").get() as { n: number }).n, 0);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM group_message_fts").get() as { n: number }).n, 0);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM group_link_notices").get() as { n: number }).n, 1);
  const restarted = new GroupKnowledge(db);
  const newSource = insert("https://example.com/once", { sentAt: "2026-10-01T10:00:00.000Z" });
  restarted.prepareDuplicates(newSource);
  const newRepeat = insert("https://example.com/once", { sentAt: "2026-10-10T10:00:00.000Z" });
  assert.deepEqual(restarted.prepareDuplicates(newRepeat), []);
  const tombstone = db.db.prepare("SELECT * FROM group_link_notices").get()!;
  assert.doesNotMatch(JSON.stringify(tombstone), /example\.com|小明|https:/);
});

test("显式清除记忆会删除once墓碑，使同URL在全新记忆里能重新提醒", () => {
  insert("https://example.com/reset");
  const knowledge = new GroupKnowledge(db);
  const repeat = insert("https://example.com/reset", { sentAt: "2026-10-10T10:00:00.000Z" });
  assert.equal(knowledge.commitDuplicate(knowledge.prepareDuplicates(repeat)[0]!), true);
  assert.equal(db.clearConversationMemory().group_link_notices, 1);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM group_link_notices").get() as { n: number }).n, 0);
  const clean = new GroupKnowledge(db);
  const fresh = insert("https://example.com/reset"); clean.prepareDuplicates(fresh);
  const later = insert("https://example.com/reset", { sentAt: "2026-10-10T10:00:00.000Z" });
  assert.equal(clean.prepareDuplicates(later).length, 1);
});

test("旧版本已安装的删除触发器会升级，避免重启仍误删once墓碑", () => {
  insert("https://example.com/upgrade");
  let knowledge = new GroupKnowledge(db);
  const current = insert("https://example.com/upgrade", { sentAt: "2026-10-10T10:00:00.000Z" });
  assert.equal(knowledge.commitDuplicate(knowledge.prepareDuplicates(current)[0]!), true);
  db.db.exec(`DROP TRIGGER group_knowledge_message_delete;
    CREATE TRIGGER group_knowledge_message_delete AFTER DELETE ON messages BEGIN
      DELETE FROM group_link_notices WHERE source_row_id=old.id OR duplicate_row_id=old.id; END;`);
  db.kvDelete("group_knowledge_trigger_version");
  knowledge = new GroupKnowledge(db);
  db.db.exec("DELETE FROM messages");
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM group_link_notices").get() as { n: number }).n, 1);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM group_message_fts").get() as { n: number }).n, 0);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM group_link_shares").get() as { n: number }).n, 0);
});

test("同群同消息ID跨账号撤回严格隔离，未指定账号且歧义时拒绝修改", () => {
  insert("当前账号索引", { messageId: "collision" });
  insert("另外账号索引", { messageId: "collision", accountId: "other", eventKey: "other:collision" });
  const knowledge = new GroupKnowledge(db);
  assert.equal(db.markRecalled("group_g", "collision"), false);
  assert.equal(knowledge.search("acct", "g", "索引").length, 1);
  assert.equal(knowledge.search("other", "g", "索引").length, 1);
  assert.equal(db.markRecalled("group_g", "collision", "other"), true);
  assert.equal(knowledge.search("other", "g", "索引").length, 0);
  assert.equal(knowledge.search("acct", "g", "索引").length, 1);
});
