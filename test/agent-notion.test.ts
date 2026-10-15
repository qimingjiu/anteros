import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { Database } from "../src/db/index.js";
import { loadConfig } from "../src/config.js";
import type { Gateway } from "../src/gateway/index.js";
import type { LLMClient } from "../src/llm/index.js";
import type { McpManager } from "../src/tools/mcp.js";
import { NotionError, type NotionEntry, type NotionNotebook, type NotionScope } from "../src/tools/notion.js";
import type { NotionReminderInput, NotionReminderScheduler } from "../src/tools/notion-reminders.js";
import type { MessageRecord } from "../src/types.js";

const OWNER = "10001", GROUP = "40001";
const ID = "10000000-0000-4000-8000-000000000001";
const ENTRY_URL = `https://www.notion.so/${ID.replaceAll("-", "")}`;
function fixture(t: TestContext) {
  const db = new Database(":memory:"); t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "acct"; cfg.groups.allowlist = [GROUP]; cfg.tools.enabled = true; cfg.tools.ownerIds = [OWNER];
  const calls: { method: string; scope?: NotionScope; key?: string; input?: unknown }[] = [];
  const entry: NotionEntry = { id: ID, url: ENTRY_URL, kind: "note", title: "实际条目", content: "正文", completed: false, createdAt: new Date().toISOString() };
  let serviceError: Error | undefined, scheduleError: Error | undefined;
  const notion = {
    async save(input: {kind:NotionEntry["kind"];title:string;content:string;dueAt?:string}, scope: NotionScope, key?: string) {
      calls.push({ method: "save", input, scope, key }); if (serviceError) throw serviceError;
      return { ...entry, kind: input.kind, title: input.title, content: input.content, dueAt: input.dueAt };
    },
    list(input: unknown, scope: NotionScope) { calls.push({ method: "list", input, scope }); return [{ ...entry, content: "正文".repeat(400) }]; },
    async get(id: string, scope: NotionScope) { calls.push({ method: "get", input: id, scope }); return entry; },
    async complete(id: string, scope: NotionScope) { calls.push({ method: "complete", input: id, scope }); if (serviceError) throw serviceError; return { ...entry, completed: true }; },
  } as unknown as NotionNotebook;
  const scheduler = { schedule(input: NotionReminderInput) {
    calls.push({ method: "schedule", input }); if (scheduleError) throw scheduleError;
    return { entryId: input.entryId, dueAt: input.dueAt, status: "scheduled", delivery: "qq_server_scheduler" };
  }, cancel(id: string) { calls.push({ method: "cancel", input: id }); return true; } } as unknown as NotionReminderScheduler;
  const agent = new Agent({ db, cfg, gateway: { getProvider: () => ({ health: () => ({ selfId: "90001" }) }) } as unknown as Gateway,
    llm: { async chat() { return { content: "完成", toolCalls: [], finishReason: "stop" }; } } as LLMClient,
    memory: null, search: null, reader: null, mcp: { getTools: () => [] } as unknown as McpManager,
    notion, notionReminders: scheduler, timezone: cfg.timezone });
  let serial = 0;
  const message = (patch: Partial<MessageRecord> = {}): MessageRecord => ({ eventKey: `notion-fixture:${++serial}`, accountId: "acct", providerId: "onebot",
    conversationId: `group_${GROUP}`, groupId: GROUP, messageId: String(serial), senderId: OWNER, displayNameAtTime: "主人",
    textContent: "帮我记到Notion", segments: [{ type: "text", data: { text: "帮我记到Notion" } }], origin: "live", status: "active",
    sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(), ...patch });
  const execute = async (name: string, args: Record<string, unknown>, m = message()) => {
    const text = await agent.executeTool(name, JSON.stringify(args), m);
    try { return JSON.parse(text); } catch { return { error: text }; }
  };
  return { agent, cfg, calls, entry, message, execute,
    serviceError(error: Error) { serviceError = error; }, scheduleError(error: Error) { scheduleError = error; } };
}

test("Notion Agent：仅真实主人有效实时会话可调用，伪造scope参数与戳一戳无权", async t => {
  const f = fixture(t);
  const names = (m: MessageRecord) => f.agent.buildToolSpecs(m).map(t => t.function.name);
  assert.equal(names(f.message()).filter(name => name.startsWith("notion_")).length, 5);
  for (const patch of [{ senderId: "12345678" }, { groupId: "123456789", conversationId: "group_123456789" },
    { origin: "backfill" as const }, { status: "recalled" as const }, { accountId: "other" }, { interaction: "poke" as const }]) {
    const m = f.message(patch);
    assert.equal(names(m).some(name => name.startsWith("notion_")), false);
    assert.ok((await f.execute("notion_save", { kind: "note", title: "假记录", content: "假正文", requesterId: OWNER }, m)).error);
  }
  assert.equal(f.calls.length, 0);
  const forged = await f.execute("notion_save", { kind: "note", title: "伪造目标", content: "正文", targetId: "12345678" });
  assert.equal(forged.status, "failed"); assert.equal(f.calls.length, 0);
  f.cfg.tools.enabled = false;
  assert.equal(names(f.message()).some(name => name.startsWith("notion_")), false);
});

test("Notion Agent：保存身份和稳定请求键来自消息，列表仅预览且读取/完成沿用真实scope", async t => {
  const f = fixture(t), m = f.message();
  const input = { kind: "website", title: "实用网站", content: "用途", url: "https://example.org" };
  const saved = await f.execute("notion_save", input, m);
  await f.execute("notion_save", input, m);
  assert.equal(saved.status, "saved"); assert.equal(saved.entry.url, ENTRY_URL); assert.equal(saved.qqReminder.status, "not_requested");
  assert.equal(f.calls[0]!.key, f.calls[1]!.key);
  const expected = { requesterId: OWNER, conversationType: "group", targetId: GROUP };
  assert.deepEqual(f.calls[0]!.scope, expected);
  const listed = await f.execute("notion_list", { query: "网站", limit: 5 }, m);
  assert.equal(listed.entries[0].contentPreview.length, 300); assert.equal(listed.entries[0].contentTruncated, true);
  assert.equal(listed.entries[0].content, undefined);
  await f.execute("notion_get", { id: ID }, m);
  const done = await f.execute("notion_complete", { id: ID }, m);
  assert.equal(done.status, "completed"); assert.equal(done.reminderCancelled, true);
  for (const call of f.calls.filter(c => c.scope)) assert.deepEqual(call.scope, expected);
  assert.equal(f.calls.at(-1)!.method, "cancel");
  const privateMessage = f.message({ groupId: undefined, conversationId: `private_${OWNER}` });
  await f.execute("notion_list", {}, privateMessage);
  assert.deepEqual(f.calls.at(-1)!.scope, { requesterId: OWNER, conversationType: "private", targetId: OWNER });
});

test("Notion Agent：QQ提醒只投当前群或主人本人，保存与安排回执分开", async t => {
  const f = fixture(t);
  const dueAt = new Date(Date.now() + 3600_000).toISOString();
  for (const delivery of ["current", "private"] as const) {
    const result = await f.execute("notion_save", { kind: "reminder", title: "喝水", content: "记得喝水", dueAt, delivery });
    assert.equal(result.status, "saved"); assert.equal(result.qqReminder.status, "scheduled");
    assert.deepEqual(f.calls.at(-1)!.input, { entryId: ID, title: "喝水", notionUrl: ENTRY_URL, dueAt, requesterId: OWNER,
      conversationType: delivery === "current" ? "group" : "private", targetId: delivery === "current" ? GROUP : OWNER });
  }
  f.scheduleError(new NotionError("not_configured"));
  const partial = await f.execute("notion_save", { kind: "reminder", title: "喝水", content: "记得喝水", dueAt });
  assert.equal(partial.status, "saved"); assert.equal(partial.entry.url, ENTRY_URL); assert.equal(partial.qqReminder.status, "failed");
  assert.match(partial.qqReminder.message, /已保存.*尚未安排成功/);
});

test("Notion Agent：不明写入不声称成功且不回传原始异常，完成失败不能取消其他提醒", async t => {
  const f = fixture(t); f.serviceError(new NotionError("write_unknown"));
  const unknown = await f.execute("notion_save", { kind: "note", title: "任务", content: "正文" });
  assert.equal(unknown.status, "unknown"); assert.equal(unknown.reason, "write_unknown");
  f.serviceError(new Error("private credential and upstream request body"));
  const failed = await f.execute("notion_complete", { id: ID });
  assert.equal(failed.status, "failed"); assert.doesNotMatch(JSON.stringify(failed), /credential|upstream/);
  assert.equal(f.calls.some(call => call.method === "cancel"), false);
});

test("Notion Agent：保存、列表和读取仅向待办及提醒提供完成状态", async t => {
  const f = fixture(t);
  for (const kind of ["note", "website", "project", "todo", "reminder"] as const) {
    f.entry.kind = kind;
    const saved = await f.execute("notion_save", { kind, title: "测试内容", content: "正文" });
    const listed = await f.execute("notion_list", {});
    const read = await f.execute("notion_get", { id: ID });
    const isTask = kind === "todo" || kind === "reminder";
    for (const entry of [saved.entry, listed.entries[0], read.entry]) {
      assert.equal(Object.hasOwn(entry, "completed"), isTask, `${kind}的完成状态不应出现在普通内容回执里`);
      if (isTask) assert.equal(entry.completed, false);
      assert.equal(entry.url, ENTRY_URL);
    }
  }
});
