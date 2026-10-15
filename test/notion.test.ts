import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../src/db/index.js";
import { NOTION_API_VERSION, NotionError, NotionNotebook, notionDueAt, type NotionScope } from "../src/tools/notion.js";

const ROOT = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", OWNER = "1111111", GROUP = "3333333", TOKEN = "ntn_not_a_real_token_private_fixture";
const NOW = Date.parse("2026-10-15T00:00:00Z");
const privateScope: NotionScope = { requesterId: OWNER, conversationType: "private", targetId: OWNER };
const groupScope: NotionScope = { requesterId: OWNER, conversationType: "group", targetId: GROUP };
const note = { kind: "note" as const, title: "保存网页研究偏好", content: "只用免费额度，遵守 robots。" };
function fixture() {
  const db = new Database(":memory:"); const clock = { now: NOW };
  const calls: { url: URL; init?: RequestInit; body?: any }[] = [];
  const pages = new Map<string, { parent: any; properties: any; blocks: any[] }>();
  const state = { override: undefined as undefined | ((url: URL, init?: RequestInit) => Response | Promise<Response>) };
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)); const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init, body }); if (state.override) return state.override(url, init);
    if (url.pathname === "/v1/pages" && init?.method === "POST") {
      const id = `bbbbbbbb-bbbb-4bbb-bbbb-${String(pages.size + 1).padStart(12, "0")}`;
      pages.set(id, { parent: body.parent, properties: body.properties, blocks: body.children.map((b: any, n: number) => ({ ...b, id: `cccccccc-cccc-4ccc-cccc-${String(n + 1).padStart(12, "0")}` })) });
      return Response.json({ id, parent: body.parent, properties: body.properties });
    }
    const match = url.pathname.match(/^\/v1\/(pages|blocks)\/([^/]+)(\/children)?$/);
    if (match?.[1] === "pages") { const page = pages.get(match[2]!); return page ? Response.json({ id: match[2], ...page }) : Response.json({}, { status: 404 }); }
    if (match?.[3]) { const page = pages.get(match[2]!); return Response.json({ results: page?.blocks ?? [], has_more: false, next_cursor: null }); }
    if (init?.method === "PATCH") return Response.json({ object: "block", id: match?.[2] });
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const make = () => new NotionNotebook({ apiKey: TOKEN, rootPageId: ROOT }, { db, fetch: fetcher, now: () => clock.now, minRequestIntervalMs: 0 });
  return { db, clock, calls, pages, state, make, notebook: make() };
}
function failure(reason: string) { return (e: unknown) => e instanceof NotionError && e.reason === reason && !e.message.includes(TOKEN); }

test("Notion：固定主机/版本、专用父页、分段文本，凭据仅Authorization", async t => {
  const f = fixture(); t.after(() => f.db.close());
  const saved = await f.notebook.save({ ...note, kind: "project", url: "https://github.com/example/project", content: "长🌙".repeat(4000) }, groupScope, "event-1");
  assert.equal(saved.kind, "project"); assert.match(saved.url, /^https:\/\/www.notion.so\/[a-f0-9]{32}$/);
  assert.equal(f.calls.length, 1); const call = f.calls[0]!;
  assert.equal(call.url.origin, "https://api.notion.com"); assert.equal(call.init?.redirect, "error");
  assert.equal(new Headers(call.init?.headers).get("Notion-Version"), NOTION_API_VERSION);
  assert.equal(new Headers(call.init?.headers).get("Authorization"), `Bearer ${TOKEN}`);
  assert.equal(call.body.parent.page_id, ROOT); assert(!JSON.stringify(call.body).includes(TOKEN));
  const allText = call.body.children.flatMap((b: any) => b.paragraph?.rich_text ?? []);
  assert(allText.every((p: any) => p.text.content.length <= 2000));
});

test("Notion：重复工具调用、并发和重启使用同一条目，不重复写", async t => {
  const f = fixture(); t.after(() => f.db.close());
  const [first, second] = await Promise.all([f.notebook.save(note, privateScope, "same-event"), f.notebook.save(note, privateScope, "same-event")]);
  assert.equal(first.id, second.id); assert.equal(f.calls.length, 1);
  assert.equal((await f.make().save(note, privateScope, "same-event")).id, first.id); assert.equal(f.calls.length, 1);
});

test("Notion：私聊可查本人所有条目，群只查本人同群来源，跨范围get/complete不发请求", async t => {
  const f = fixture(); t.after(() => f.db.close());
  const priv = await f.notebook.save({ ...note, kind: "todo" }, privateScope, "private");
  await f.notebook.save(note, groupScope, "group");
  await f.notebook.save(note, { ...groupScope, targetId: "4444444" }, "other-group");
  await f.notebook.save(note, { requesterId: "5555555", conversationType: "private", targetId: "5555555" }, "other-owner");
  assert.equal(f.notebook.list({}, privateScope).length, 3); assert.equal(f.notebook.list({}, groupScope).length, 1);
  const count = f.calls.length;
  await assert.rejects(f.notebook.get(priv.id, groupScope), failure("not_found"));
  await assert.rejects(f.notebook.complete(priv.id, groupScope), failure("not_found"));
  assert.equal(f.calls.length, count);
});

test("Notion：本地查询按标题/内容/类型过滤，不调用工作区搜索", async t => {
  const f = fixture(); t.after(() => f.db.close());
  await f.notebook.save(note, groupScope, "1"); await f.notebook.save({ kind: "todo", title: "买面包", content: "明天早餐" }, groupScope, "2");
  assert.equal(f.notebook.list({ query: "robots" }, groupScope)[0]?.kind, "note");
  assert.equal(f.notebook.list({ kind: "todo", limit: 1 }, groupScope)[0]?.title, "买面包"); assert.equal(f.calls.length, 2);
});

test("Notion：URL凭据/非HTTP、超长内容、密钥文本、伪造私聊目标和无时区日期在本地拒绝", async t => {
  const f = fixture(); t.after(() => f.db.close());
  for (const input of [{ ...note, url: "file:///etc/passwd" }, { ...note, url: "https://a:b@example.com" }, { ...note, title: "t".repeat(201) }, { ...note, content: TOKEN }, { ...note, dueAt: "2026-10-16T12:00:00" }, { ...note, kind: "reminder" as const }]) await assert.rejects(f.notebook.save(input, privateScope), failure("invalid_input"));
  await assert.rejects(f.notebook.save(note, { ...privateScope, targetId: "9999999" }), failure("forbidden"));
  assert.equal(f.calls.length, 0);
});

test("Notion：提醒时间严格校验日历、未来、五年范围并规范化时区", () => {
  assert.equal(notionDueAt("2026-10-16T08:00:00+08:00", NOW), "2026-10-16T00:00:00.000Z");
  assert.equal(notionDueAt("2026-10-16T08:00+08:00", NOW), "2026-10-16T00:00:00.000Z");
  for (const value of ["2027-02-30T08:00:00+08:00", "2026-10-16T25:00:00Z", "2026-10-15T00:00:00Z", "2035-10-15T00:00:00Z", "2026-10-16"]) assert.throws(() => notionDueAt(value, NOW), failure("invalid_input"));
});

test("Notion：权限错误保持安全固定错误，不泄漏上游token/body", async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.state.override = () => new Response(TOKEN, { status: 403 });
  await assert.rejects(f.notebook.save(note, privateScope, "denied"), failure("forbidden"));
  assert.equal(f.calls.length, 1);
});

test("Notion：429长Retry-After冷却对后续操作生效，不自动重试写请求", async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.state.override = () => new Response(TOKEN, { status: 429, headers: { "Retry-After": "7200" } });
  await assert.rejects(f.notebook.save(note, privateScope, "rate"), (e: unknown) => failure("rate_limited")(e) && (e as NotionError).retryAfterMs === 7200_000);
  await assert.rejects(f.notebook.save({ ...note, title: "第二条" }, privateScope, "rate-2"), failure("rate_limited")); assert.equal(f.calls.length, 1);
  f.clock.now += 7200_001; f.state.override = undefined;
  await f.notebook.save(note, privateScope, "rate"); assert.equal(f.calls.length, 2);
});

test("Notion：网络/500写入结果不明持久化，重启后相同请求不再POST", async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.state.override = () => new Response(TOKEN, { status: 503 });
  await assert.rejects(f.notebook.save(note, privateScope, "uncertain"), failure("write_unknown"));
  await assert.rejects(f.make().save(note, privateScope, "uncertain"), failure("write_unknown")); assert.equal(f.calls.length, 1);
});

test("Notion：HTTP-date冷却完整保留，不按固定一分钟重试", async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.state.override = () => new Response("", { status: 429, headers: { "Retry-After": new Date(NOW + 3 * 86400_000).toUTCString() } });
  await assert.rejects(f.notebook.save(note, privateScope, "date"), (e: unknown) => failure("rate_limited")(e) && (e as NotionError).retryAfterMs === 3 * 86400_000);
  f.clock.now += 2 * 86400_000;
  await assert.rejects(f.notebook.save(note, privateScope, "date"), failure("rate_limited")); assert.equal(f.calls.length, 1);
});

test("Notion：超长delta冷却不会被366天截短或加法溢出", async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.state.override = () => new Response("", { status: 429, headers: { "Retry-After": "99999999999999999999999999999999999" } });
  await assert.rejects(f.notebook.save(note, privateScope, "long"), failure("rate_limited"));
  f.clock.now += 367 * 86400_000;
  await assert.rejects(f.make().save(note, privateScope, "long"), failure("rate_limited")); assert.equal(f.calls.length, 1);
  assert(Number.isFinite(f.notebook.status().cooldownMs)); assert(Number(f.notebook.status().cooldownMs) > 365 * 86400_000);
  const stored = f.db.db.prepare("SELECT key,value FROM kv WHERE key LIKE 'notion:cooldown:%'").all();
  assert.equal(stored.length, 1); assert(!JSON.stringify(stored).includes(TOKEN));
});

test("Notion：成功响应异常或超大不能作为安全重试的依据", async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.state.override = () => new Response("x".repeat(1024 * 1024 + 1));
  await assert.rejects(f.notebook.save(note, privateScope, "huge"), failure("write_unknown"));
  await assert.rejects(f.notebook.save(note, privateScope, "huge"), failure("write_unknown")); assert.equal(f.calls.length, 1);
});

test("Notion：外部移动或归档的条目不能继续读取/更新", async t => {
  const f = fixture(); t.after(() => f.db.close()); const saved = await f.notebook.save({ ...note, kind: "todo" }, groupScope, "move");
  f.pages.get(saved.id)!.parent = { type: "page_id", page_id: "dddddddd-dddd-4ddd-dddd-dddddddddddd" };
  await assert.rejects(f.notebook.complete(saved.id, groupScope), failure("forbidden"));
  assert.equal(f.calls.filter(x => x.init?.method === "PATCH").length, 0);
});

test("Notion：get读取真实正文/勾选状态，complete只更新本条目todo块", async t => {
  const f = fixture(); t.after(() => f.db.close()); const saved = await f.notebook.save({ ...note, kind: "todo" }, groupScope, "todo");
  const full = await f.notebook.get(saved.id, groupScope); assert.match(full.content, /免费额度/); assert.equal(full.completed, false);
  const done = await f.notebook.complete(saved.id, groupScope); assert.equal(done.completed, true);
  const patches = f.calls.filter(x => x.init?.method === "PATCH"); assert.equal(patches.length, 1);
  assert.deepEqual(patches[0]!.body, { to_do: { checked: true } });
  assert.equal(f.notebook.list({}, groupScope)[0]?.completed, true);
});

test("Notion：分页最多三页，重复游标停止，拒绝无界遍历", async t => {
  const f = fixture(); t.after(() => f.db.close()); const saved = await f.notebook.save(note, privateScope, "pages");
  f.state.override = url => url.pathname.startsWith("/v1/pages/") ? Response.json({ parent: { type: "page_id", page_id: ROOT } }) : Response.json({ results: [], has_more: true, next_cursor: "repeat" });
  await assert.rejects(f.notebook.get(saved.id, privateScope), failure("invalid_response")); assert.equal(f.calls.length, 4);
});

test("Notion：调度器完成同步只读两次请求并持久化手工勾选，跨范围不发请求", async t => {
  const f = fixture(); t.after(() => f.db.close());
  const saved = await f.notebook.save({ ...note, kind: "todo" }, privateScope, "sync-todo");
  const todo = f.pages.get(saved.id)!.blocks.find((b: any) => b.type === "to_do"); todo.to_do.checked = true;
  await assert.rejects(f.notebook.completionStatus(saved.id, groupScope), failure("not_found")); assert.equal(f.calls.length, 1);
  assert.equal(await f.notebook.completionStatus(saved.id, privateScope), true); assert.equal(f.calls.length, 3);
  assert(f.calls.every(c => c.init?.method !== "PATCH"));
  assert.equal(f.notebook.list({}, privateScope)[0]?.completed, true);
  assert.equal(await f.make().completionStatus(saved.id, privateScope), true); assert.equal(f.calls.length, 3);
});

test("Notion：调度器不把删掉/藏到后续分页的勾选框当成未完成", async t => {
  const f = fixture(); t.after(() => f.db.close());
  const saved = await f.notebook.save({ ...note, kind: "todo" }, privateScope, "sync-missing");
  f.state.override = url => url.pathname.startsWith("/v1/pages/") ? Response.json({ parent: { type: "page_id", page_id: ROOT } })
    : Response.json({ results: [], has_more: true, next_cursor: "later" });
  await assert.rejects(f.notebook.completionStatus(saved.id, privateScope), failure("too_large"));
  assert.equal(f.calls.length, 3);
});
