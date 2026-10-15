import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { Database } from "../src/db/index.js";
import { loadConfig } from "../src/config.js";
import { GroupKnowledge, groupLinkIdentity, type LinkDuplicateNotice } from "../src/group-knowledge/index.js";
import { IncomingDocumentService } from "../src/documents/incoming.js";
import { ResearchRuntime } from "../src/tools/research.js";
import type { PageReader } from "../src/tools/reader.js";
import type { McpManager } from "../src/tools/mcp.js";
import type { NotionNotebook } from "../src/tools/notion.js";
import type { NotionReminderScheduler } from "../src/tools/notion-reminders.js";
import type { Gateway } from "../src/gateway/index.js";
import type { LLMClient } from "../src/llm/index.js";
import type { MessageRecord, MessageSegment, Provider } from "../src/types.js";

const BASE = Date.parse("2026-10-15T02:00:00.000Z");
const OWNER = "10001", MEMBER = "12345678", BOT = "90001", GROUP = "40001";
type SendTask = Parameters<Gateway["enqueueSend"]>[0];
interface InspectAgent {
  onMessage(message: MessageRecord): Promise<void>;
  executeTool(name: string, args: string, message: MessageRecord): Promise<string>;
  buildToolSpecs(message: MessageRecord): { function: { name: string } }[];
  groupKnowledge: GroupKnowledge;
  sendLinkDuplicate(message: MessageRecord, notice: LinkDuplicateNotice): boolean;
}
async function flush() { for (let count = 0; count < 20; count++) await Promise.resolve(); }

function fixture(t: TestContext, options: { conversation?: boolean; features?: boolean; seed?: boolean } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: BASE });
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "acct"; cfg.groups.allowlist = [GROUP, "200"];
  cfg.groups.linkPreview = false;
  cfg.groups.conversation = { enabled: options.conversation ?? false, ownerAliases: ["主人"] };
  cfg.tools.enabled = true; cfg.tools.ownerIds = [OWNER]; cfg.admins = [OWNER];
  cfg.features = { tasks: options.features ?? false, personalMemory: options.features ?? false,
    groupSearch: true, linkDedup: true, incomingFiles: true };
  let serial = 0, modelCalls = 0, readerCalls = 0, resolves = 0, downloads = 0, parses = 0;
  const make = (text: string, patch: Partial<MessageRecord> = {}): MessageRecord => {
    const id = String(++serial);
    return { eventKey: `knowledge-test:${id}`, accountId: "acct", providerId: "onebot", conversationId: `group_${GROUP}`,
      groupId: GROUP, messageId: id, senderId: MEMBER, displayNameAtTime: "小明", textContent: text,
      segments: [{ type: "text", data: { text } }], sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
      origin: "live", status: "active", ...patch };
  };
  const seed = options.seed ? make("老消息推荐中文检索库 Tantivy", { sentAt: "2026-10-01T09:00:00.000Z", origin: "backfill" }) : null;
  if (seed) db.insertMessage(seed);
  const provider = { health: () => ({ selfId: BOT, connection: "connected", login: "online", reconnectCount: 0 }),
    resolveIncomingFile: async () => { resolves++; return { ok: true, url: "https://files.qq.com/test.pdf" }; } } as unknown as Provider;
  const incoming = new IncomingDocumentService({ db: db.db, ownerIds: [OWNER], provider,
    download: async () => { downloads++; return new Uint8Array([1]); },
    parse: async () => { parses++; return { format: "pdf", truncated: false, notices: [], chunks: [{ index: 0, source: "第1页", text: "论文内容" }] }; } });
  const gateway = { getProvider: () => provider, enqueueSend: (task: SendTask) => db.enqueueSendTask(task) } as unknown as Gateway;
  const llm = { chat: async () => { modelCalls++; return { content: "这是模型回复。", toolCalls: [], finishReason: "stop" }; } } as unknown as LLMClient;
  const runtime = new ResearchRuntime();
  const reader = { read: async (url: string) => { readerCalls++; return { url, finalUrl: url, title: "文档页面",
    text: "这个项目支持本地全文检索。它还有第二个特点。", status: "ok", fetchedAt: new Date().toISOString() }; } } as unknown as PageReader;
  const restart = () => new Agent({ db, cfg, gateway, llm, memory: null, search: null, reader,
    mcp: { getTools: () => [] } as unknown as McpManager, research: runtime,
    notion: {} as NotionNotebook, notionReminders: {} as NotionReminderScheduler,
    incomingDocuments: incoming, timezone: cfg.timezone }) as unknown as InspectAgent;
  let agent = restart();
  const run = async (message: MessageRecord) => {
    db.insertMessage(message);
    const pending = agent.onMessage(message);
    await flush(); t.mock.timers.tick(1200); await pending; await flush();
  };
  const execute = (name: string, args: Record<string, unknown>, message: MessageRecord) => runtime.withSession("knowledge-test",
    () => agent.executeTool(name, JSON.stringify(args), message));
  const tasks = (kind?: string) => db.recentSendTasks(100).reverse().filter(row => !kind || row.kind === kind);
  return { db, cfg, make, seed, incoming, run, execute, tasks, get agent() { return agent; },
    restart() { agent = restart(); return agent; },
    get modelCalls() { return modelCalls; }, get readerCalls() { return readerCalls; },
    get resolves() { return resolves; }, get downloads() { return downloads; }, get parses() { return parses; } };
}

function segments(task: { payload: string }): MessageSegment[] { return JSON.parse(task.payload).segments; }
function text(task: { payload: string }): string {
  return segments(task).filter(segment => segment.type === "text").map(segment => segment.data.text).join("");
}

test("Agent本群/搜：历史回填和新消息可查，结果含谁/时间/原文并真实引用，其他群账号私聊隔离", async t => {
  const f = fixture(t, { seed: true });
  const recent = f.make("新消息也推荐中文检索库 Meilisearch", { displayNameAtTime: "小红" });
  await f.run(recent);
  await f.run(f.make("秘密中文检索库", { groupId: "200", conversationId: "group_200" }));
  f.db.insertMessage(f.make("另一个账号中文检索库", { accountId: "other", eventKey: "other-event" }));
  f.db.insertMessage(f.make("私人中文检索库", { groupId: undefined, conversationId: `private_${OWNER}`, senderId: OWNER }));
  await f.run(f.make("/搜 中文检索库"));
  const results = f.tasks("command_reply");
  assert.ok(results.length);
  const combined = results.map(text).join("\n");
  assert.match(combined, /Tantivy/); assert.match(combined, /Meilisearch/);
  assert.match(combined, /小明/); assert.match(combined, /小红/); assert.match(combined, /2026[-/]10[-/]0?1/);
  assert.doesNotMatch(combined, /秘密|另一个账号|私人/);
  const quoted = results.flatMap(segments).filter(segment => segment.type === "reply").map(segment => segment.data.id);
  assert.ok(quoted.includes(f.seed!.messageId) || quoted.includes(recent.messageId));
  assert.equal(f.modelCalls, 0); assert.equal(f.readerCalls, 0);
  await f.run(f.make("/搜 中文检索库", { groupId: undefined, conversationId: `private_${OWNER}`, senderId: OWNER }));
  assert.doesNotMatch(text(f.tasks("command_reply").at(-1)!), /Tantivy|Meilisearch/);
});

test("Agent链接查重：7天前原链接被引用，提醒占自动插话冷却且不主动读取，重启后同URL不重发", async t => {
  const f = fixture(t);
  const original = f.make("https://example.com/original", { sentAt: new Date(BASE - 8 * 86400_000).toISOString() });
  await f.run(original);
  const repeat = f.make("https://example.com/original?utm_source=qq");
  await f.run(repeat);
  const notice = f.tasks("proactive_link_duplicate")[0]!;
  assert.ok(notice);
  assert.deepEqual(segments(notice)[0], { type: "reply", data: { id: original.messageId } });
  assert.match(text(notice), /小明.*发过/);
  assert.equal(f.readerCalls, 0); assert.equal(f.modelCalls, 0);
  const secondSource = f.make("https://example.com/second", { sentAt: new Date(BASE - 8 * 86400_000).toISOString() });
  await f.run(secondSource);
  const secondRepeat = f.make("https://example.com/second");
  await f.run(secondRepeat);
  assert.equal(f.tasks("proactive_link_duplicate").length, 1, "自动冷却内不连发第二次提醒");
  const fingerprint = groupLinkIdentity("https://example.com/second")!.fingerprint;
  assert.equal(f.db.db.prepare("SELECT 1 FROM group_link_notices WHERE fingerprint=?").get(fingerprint), undefined);
  const prepared = f.agent.groupKnowledge.prepareDuplicates(secondRepeat)[0]!;
  assert.ok(prepared, "冷却拒绝没有消耗once标记");
  t.mock.timers.tick(31_000);
  assert.equal(f.agent.sendLinkDuplicate(secondRepeat, prepared), true);
  assert.equal(f.tasks("proactive_link_duplicate").length, 2);
  t.mock.timers.tick(8 * 86400_000);
  f.restart();
  await f.run(f.make("https://example.com/original"));
  assert.equal(f.tasks("proactive_link_duplicate").length, 2, "持久化once覆盖重启与7天后的再次分享");
});

test("Agent读网页：成功摘要保存在当前或明确引用的历史分享消息，后续查重只用已读首句", async t => {
  const f = fixture(t);
  const current = f.make("读这个 https://example.com/current", { senderId: OWNER, displayNameAtTime: "主人" });
  await f.run(current);
  assert.match(await f.execute("read_page", { url: "https://example.com/current" }, current), /外部网页资料/);
  const old = f.make("https://example.com/old", { sentAt: new Date(BASE - 8 * 86400_000).toISOString(), displayNameAtTime: "老分享者" });
  await f.run(old);
  const request = f.make("读一下引用的链接", { senderId: OWNER, replyToMessageId: old.messageId });
  await f.run(request);
  await f.execute("read_page", { url: "https://example.com/old" }, request);
  const reads = f.db.db.prepare("SELECT shared_message_id,shared_by_name,summary FROM link_reads ORDER BY id").all() as unknown as
    { shared_message_id: string; shared_by_name: string; summary: string }[];
  assert.equal(reads[0]!.shared_message_id, current.messageId);
  assert.equal(reads[1]!.shared_message_id, old.messageId);
  assert.equal(reads[1]!.shared_by_name, "老分享者");
  assert.match(reads[1]!.summary, /支持本地全文检索/);
  t.mock.timers.tick(31_000);
  await f.run(f.make("https://example.com/old"));
  const notice = f.tasks("proactive_link_duplicate").at(-1)!;
  assert.ok(notice);
  assert.match(text(notice), /当时的结论是：这个项目支持本地全文检索。/);
  assert.doesNotMatch(text(notice), /第二个特点/);
});

test("Agent群友附件：只登记元数据，不触发模型/地址解析/下载/解析器", async t => {
  const f = fixture(t, { conversation: true });
  const attachment = f.make("[文件] 垃圾附件.pdf", { segments: [{ type: "file", data: { fileId: "protocol-file-1", name: "垃圾附件.pdf", size: 1024 } }] });
  await f.run(attachment);
  assert.equal((f.db.db.prepare("SELECT count(*) AS n FROM incoming_documents").get() as { n: number }).n, 1);
  assert.equal(f.modelCalls, 0); assert.equal(f.resolves, 0); assert.equal(f.downloads, 0); assert.equal(f.parses, 0);
  assert.equal(f.tasks().length, 0);
});

test("Agent新增主人工具：普通群友看不到也不能调用任务、个人记忆、文件读取和提醒管理", async t => {
  const f = fixture(t, { features: true });
  const member = f.make("普通群友提问");
  const owner = f.make("主人提问", { senderId: OWNER });
  const ownerNames = f.agent.buildToolSpecs(owner).map(spec => spec.function.name);
  const memberNames = f.agent.buildToolSpecs(member).map(spec => spec.function.name);
  for (const name of ["task_status", "task_control", "personal_memory", "read_file", "notion_reminder"]) {
    assert.ok(ownerNames.includes(name), `主人应有${name}`);
    assert.equal(memberNames.includes(name), false, `普通群友不应有${name}`);
    assert.match(await f.execute(name, {}, member), /不存在或当前不可用/);
  }
  assert.equal(f.resolves, 0); assert.equal(f.downloads, 0);
});
