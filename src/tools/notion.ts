import { createHash } from "node:crypto";
import type { Database } from "../db/index.js";
import { MAX_COOLDOWN_TIMESTAMP, parseRetryAfter } from "./web-http.js";

export const NOTION_API_VERSION = "2026-03-11";
export type NotionKind = "note" | "todo" | "reminder" | "website" | "project";
export interface NotionScope { requesterId: string; conversationType: "private" | "group"; targetId: string }
export interface NotionSaveInput { kind: NotionKind; title: string; content: string; url?: string; dueAt?: string }
export interface NotionEntry {
  id: string; url: string; kind: NotionKind; title: string; content: string; sourceUrl?: string;
  dueAt?: string; completed: boolean; createdAt: string;
}
export type NotionFailure = "not_configured" | "invalid_input" | "forbidden" | "not_found" | "rate_limited"
  | "timeout" | "unavailable" | "invalid_response" | "write_unknown" | "too_large";
const ERRORS: Record<NotionFailure, string> = {
  not_configured: "Notion 笔记本尚未配置完成。", invalid_input: "Notion 参数无效，请检查标题、内容、链接和带时区的时间。",
  forbidden: "没有操作这个 Notion 条目的权限，或连接没有所需权限。", not_found: "没有找到当前范围内的 Notion 条目。",
  rate_limited: "Notion 正在限流，请等待回执中的冷却时间后再试。", timeout: "Notion 请求超时。",
  unavailable: "Notion 服务暂时不可用。", invalid_response: "Notion 返回的数据无法安全读取。",
  write_unknown: "Notion 写入结果不明，已停止重复写入；请先检查笔记本，避免重复记录。",
  too_large: "Notion 请求或返回内容超出大小限制。",
};
export class NotionError extends Error {
  constructor(readonly reason: NotionFailure, readonly status?: number, readonly retryAfterMs?: number) { super(ERRORS[reason]); this.name = "NotionError"; }
}
interface EntryRow { root_id: string; page_id: string; owner_id: string; conversation_type: string; target_id: string; entry: string; completed: number }
export interface NotionNotebookOptions { apiKey: string; rootPageId: string; requestTimeoutMs?: number }
export interface NotionNotebookDeps { db: Database; fetch?: typeof fetch; now?: () => number; minRequestIntervalMs?: number }
const KINDS = new Set<NotionKind>(["note", "todo", "reminder", "website", "project"]);
const LABELS: Record<NotionKind, string> = { note: "笔记", todo: "待办", reminder: "提醒", website: "网站", project: "开源项目" };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export function notionId(v: string): string {
  const value = typeof v === "string" ? v.replaceAll("-", "").toLowerCase() : "";
  if (!/^[a-f0-9]{32}$/.test(value)) throw new NotionError("invalid_input");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export function notionDueAt(v: string, now: number): string {
  if (typeof v !== "string" || v.length > 40) throw new NotionError("invalid_input");
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.exec(v);
  if (!match) throw new NotionError("invalid_input");
  const time = Date.parse(v);
  const [year, month, day, hour, minute, second] = match.slice(1).map(value => value === undefined ? undefined : Number(value));
  const calendar = new Date(Date.UTC(year!, month! - 1, day!));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day
    || hour! > 23 || minute! > 59 || (second !== undefined && second > 59)) throw new NotionError("invalid_input");
  if (!Number.isFinite(time) || time <= now || time > now + 5 * 366 * 86400_000) throw new NotionError("invalid_input");
  return new Date(time).toISOString();
}
function checkedScope(scope: NotionScope): NotionScope {
  if (!scope || !/^[0-9]{5,20}$/.test(scope.requesterId) || !/^[0-9]{5,20}$/.test(scope.targetId)
    || !["private", "group"].includes(scope.conversationType) || (scope.conversationType === "private" && scope.targetId !== scope.requesterId)) throw new NotionError("forbidden");
  return scope;
}
function plain(v: unknown, max: number, required = false): string {
  if (typeof v !== "string" || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw new NotionError("invalid_input");
  const value = v.trim();
  if (required && !value) throw new NotionError("invalid_input");
  return value;
}
function richText(content: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []; let part = "";
  for (const point of content) {
    if (part.length + point.length > 1900) { out.push({ type: "text", text: { content: part } }); part = ""; }
    part += point;
  }
  if (part) out.push({ type: "text", text: { content: part } });
  return out;
}
function paragraph(content: string) { return { object: "block", type: "paragraph", paragraph: { rich_text: richText(content) } }; }
function richPlain(v: unknown): string {
  if (!Array.isArray(v)) return "";
  return v.map(x => object(x) ? typeof x.plain_text === "string" ? x.plain_text : object(x.text) && typeof x.text.content === "string" ? x.text.content : "" : "").join("");
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new NotionError("timeout"));
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new NotionError("timeout"));
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel)).catch(() => {});
  });
}

/** Writes only direct child pages of a dedicated notebook. The durable index is
 * also the access boundary: a broad Notion integration token is never exposed as
 * a workspace-wide search tool. External page text remains untrusted content. */
export class NotionNotebook {
  private readonly root: string;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly timeout: number;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private nextRequestAt = 0;
  private cooldownUntil = 0;
  private readonly cooldownKey: string;
  private readonly inFlight = new Map<string, Promise<NotionEntry>>();

  constructor(private readonly options: NotionNotebookOptions, private readonly deps: NotionNotebookDeps) {
    if (!options.apiKey?.trim() || !options.rootPageId) throw new NotionError("not_configured");
    this.root = notionId(options.rootPageId);
    this.now = deps.now ?? Date.now; this.fetcher = deps.fetch ?? fetch;
    this.cooldownKey = `notion:cooldown:${hash(JSON.stringify([this.root, hash(options.apiKey)]))}`;
    const savedCooldown = deps.db.kvGet(this.cooldownKey);
    if (savedCooldown !== undefined) {
      const until = Number(savedCooldown);
      this.cooldownUntil = Number.isSafeInteger(until) && until >= 0 && until <= MAX_COOLDOWN_TIMESTAMP ? until : MAX_COOLDOWN_TIMESTAMP;
    }
    this.timeout = Math.max(1000, Math.min(options.requestTimeoutMs ?? 12_000, 30_000));
    deps.db.db.exec(`CREATE TABLE IF NOT EXISTS notion_items (
      root_id TEXT NOT NULL, page_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
      conversation_type TEXT NOT NULL, target_id TEXT NOT NULL, entry TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS notion_items_scope ON notion_items(root_id,owner_id,conversation_type,target_id);
      CREATE TABLE IF NOT EXISTS notion_operations (operation_key TEXT PRIMARY KEY, root_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, status TEXT NOT NULL, page_id TEXT, updated_at TEXT NOT NULL);`);
    deps.db.db.prepare("UPDATE notion_operations SET status='unknown' WHERE root_id=? AND status='pending'").run(this.root);
  }

  status(): Record<string, unknown> { return { enabled: true, configured: true, apiVersion: NOTION_API_VERSION, cooldownMs: Math.max(0, this.cooldownUntil - this.now()) }; }

  async save(input: NotionSaveInput, scope: NotionScope, requestKey?: string): Promise<NotionEntry> {
    checkedScope(scope);
    if (!input || !KINDS.has(input.kind)) throw new NotionError("invalid_input");
    const title = plain(input.title, 200, true), content = plain(input.content, 16_000);
    if (`${title}\n${content}\n${input.url ?? ""}`.includes(this.options.apiKey)) throw new NotionError("invalid_input");
    let sourceUrl: string | undefined;
    if (input.url !== undefined) {
      try {
        const value = new URL(plain(input.url, 2048, true));
        if (!["https:", "http:"].includes(value.protocol) || value.username || value.password) throw new Error();
        sourceUrl = value.href;
      } catch { throw new NotionError("invalid_input"); }
    }
    const dueAt = input.dueAt ? notionDueAt(input.dueAt, this.now()) : undefined;
    if (input.kind === "reminder" && !dueAt) throw new NotionError("invalid_input");
    const data = { kind: input.kind, title, content, sourceUrl, dueAt };
    const fingerprint = hash(JSON.stringify([scope, data]));
    // An explicit request key survives retries/restarts. Without one, dedup only
    // within a ten-minute window, allowing an intentional later repeated note.
    const key = hash(JSON.stringify([this.root, scope, requestKey ? plain(requestKey, 1000, true) : Math.floor(this.now() / 600_000), fingerprint]));
    const previous = this.deps.db.db.prepare("SELECT status,page_id FROM notion_operations WHERE operation_key=?").get(key) as { status: string; page_id: string | null } | undefined;
    if (previous?.status === "complete" && previous.page_id) return this.local(previous.page_id, scope);
    const running = this.inFlight.get(key); if (running) return running;
    if (previous && ["unknown", "pending"].includes(previous.status)) throw new NotionError("write_unknown");
    const work = this.createEntry(data, scope, key, fingerprint);
    this.inFlight.set(key, work);
    try { return await work; } finally { this.inFlight.delete(key); }
  }

  private async createEntry(data: Omit<NotionEntry, "id" | "url" | "completed" | "createdAt">, scope: NotionScope, key: string, fingerprint: string): Promise<NotionEntry> {
    const createdAt = new Date(this.now()).toISOString();
    const children: Record<string, unknown>[] = [paragraph(`分类：${LABELS[data.kind]}\n记录时间：${createdAt}`)];
    if (data.kind === "todo" || data.kind === "reminder") children.push({ object: "block", type: "to_do", to_do: { rich_text: richText(data.title), checked: false } });
    if (data.dueAt) children.push(paragraph(`提醒时间：${data.dueAt}（QQ 定时投递由机器人服务器负责）`));
    if (data.sourceUrl) children.push(paragraph(`来源：${data.sourceUrl}`));
    if (data.content) children.push(paragraph(data.content));
    this.deps.db.db.prepare("INSERT OR REPLACE INTO notion_operations(operation_key,root_id,fingerprint,status,updated_at) VALUES(?,?,?,'pending',?)").run(key, this.root, fingerprint, createdAt);
    try {
      const response = await this.request("POST", "/pages", { parent: { type: "page_id", page_id: this.root }, properties: { title: { type: "title", title: richText(data.title) } }, children });
      const id = typeof response.id === "string" ? notionId(response.id) : (() => { throw new NotionError("invalid_response"); })();
      if (!this.correctParent(response)) throw new NotionError("invalid_response");
      const entry: NotionEntry = { ...data, id, url: `https://www.notion.so/${id.replaceAll("-", "")}`, completed: false, createdAt };
      this.deps.db.db.exec("BEGIN IMMEDIATE");
      try {
        this.deps.db.db.prepare("INSERT INTO notion_items(root_id,page_id,owner_id,conversation_type,target_id,entry,completed,created_at) VALUES(?,?,?,?,?,?,0,?)")
          .run(this.root, id, scope.requesterId, scope.conversationType, scope.targetId, JSON.stringify(entry), createdAt);
        this.deps.db.db.prepare("UPDATE notion_operations SET status='complete',page_id=?,updated_at=? WHERE operation_key=?").run(id, createdAt, key);
        this.deps.db.db.exec("COMMIT");
      } catch (error) { this.deps.db.db.exec("ROLLBACK"); throw error; }
      return entry;
    } catch (error) {
      const definite = error instanceof NotionError && ["invalid_input", "forbidden", "not_found", "rate_limited"].includes(error.reason);
      this.deps.db.db.prepare("UPDATE notion_operations SET status=?,updated_at=? WHERE operation_key=?").run(definite ? "failed" : "unknown", new Date(this.now()).toISOString(), key);
      if (!definite) throw new NotionError("write_unknown", error instanceof NotionError ? error.status : undefined);
      throw error;
    }
  }

  list(filter: { kind?: NotionKind; query?: string; limit?: number } = {}, scope: NotionScope): NotionEntry[] {
    checkedScope(scope);
    if (filter.kind !== undefined && !KINDS.has(filter.kind)) throw new NotionError("invalid_input");
    const query = filter.query === undefined ? "" : plain(filter.query, 200).normalize("NFKC").toLocaleLowerCase();
    const limit = Math.max(1, Math.min(30, Math.floor(filter.limit ?? 15)));
    if (!Number.isFinite(limit)) throw new NotionError("invalid_input");
    const params: (string | number)[] = [this.root, scope.requesterId];
    const groupClause = scope.conversationType === "group" ? " AND conversation_type='group' AND target_id=?" : "";
    if (scope.conversationType === "group") params.push(scope.targetId);
    const rows = this.deps.db.db.prepare(`SELECT * FROM notion_items WHERE root_id=? AND owner_id=?${groupClause} ORDER BY created_at DESC LIMIT 500`).all(...params) as unknown as EntryRow[];
    return rows.map(r => ({ ...JSON.parse(r.entry) as NotionEntry, completed: !!r.completed }))
      .filter(e => (!filter.kind || e.kind === filter.kind) && (!query || `${e.title}\n${e.content}\n${e.sourceUrl ?? ""}`.normalize("NFKC").toLocaleLowerCase().includes(query))).slice(0, limit);
  }

  private local(id: string, scope: NotionScope): NotionEntry {
    checkedScope(scope); const pageId = notionId(id);
    const row = this.deps.db.db.prepare("SELECT * FROM notion_items WHERE root_id=? AND page_id=? AND owner_id=?").get(this.root, pageId, scope.requesterId) as EntryRow | undefined;
    if (!row || (scope.conversationType === "group" && (row.conversation_type !== "group" || row.target_id !== scope.targetId))) throw new NotionError("not_found");
    return { ...JSON.parse(row.entry) as NotionEntry, completed: !!row.completed };
  }

  private correctParent(page: Record<string, unknown>): boolean {
    try { return object(page.parent) && page.parent.type === "page_id" && typeof page.parent.page_id === "string" && notionId(page.parent.page_id) === this.root; } catch { return false; }
  }

  private async remote(id: string): Promise<{ page: Record<string, unknown>; blocks: Record<string, unknown>[]; truncated: boolean }> {
    const page = await this.request("GET", `/pages/${id}`);
    if (!this.correctParent(page) || page.in_trash === true || page.archived === true) throw new NotionError("forbidden");
    const blocks: Record<string, unknown>[] = []; let cursor: string | undefined;
    for (let n = 0; n < 3; n++) {
      const query = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
      const response = await this.request("GET", `/blocks/${id}/children?${query}`);
      if (!Array.isArray(response.results) || !response.results.every(object)) throw new NotionError("invalid_response");
      blocks.push(...response.results);
      if (response.has_more !== true) return { page, blocks, truncated: false };
      if (typeof response.next_cursor !== "string" || response.next_cursor.length > 200 || response.next_cursor === cursor) throw new NotionError("invalid_response");
      cursor = response.next_cursor;
    }
    return { page, blocks, truncated: true };
  }

  async get(id: string, scope: NotionScope): Promise<NotionEntry & { truncated?: boolean }> {
    const local = this.local(id, scope); const { page, blocks, truncated } = await this.remote(local.id);
    const content: string[] = [];
    for (const block of blocks) {
      const value = typeof block.type === "string" ? block[block.type] : undefined;
      if (object(value)) { const text = richPlain(value.rich_text); if (text) content.push(text); }
    }
    const text = content.join("\n\n");
    const title = object(page.properties) && object(page.properties.title) ? richPlain(page.properties.title.title) || local.title : local.title;
    const todo = blocks.find(b => b.type === "to_do" && object(b.to_do));
    const completed = todo && object(todo.to_do) ? todo.to_do.checked === true : local.completed;
    if (completed) this.deps.db.db.prepare("UPDATE notion_items SET completed=1 WHERE root_id=? AND page_id=?").run(this.root, local.id);
    return { ...local, title: title.slice(0, 200), content: text.slice(0, 20_000), completed, truncated: truncated || text.length > 20_000 };
  }

  /** Bounded, read-only refresh for the reminder scheduler. It shares the
   * notebook's rate limiter and persists observed completion. Missing/moved
   * pages are failures, never an invented 'unchecked' result. */
  async completionStatus(id: string, scope: NotionScope): Promise<boolean> {
    const local = this.local(id, scope);
    if (local.kind !== "todo" && local.kind !== "reminder") throw new NotionError("invalid_input");
    if (local.completed) return true;
    // The canonical checkbox is written near the beginning. A scheduler check
    // spends at most two short requests rather than downloading a long note.
    const page = await this.request("GET", `/pages/${local.id}`, undefined, 3000);
    if (!this.correctParent(page) || page.in_trash === true || page.archived === true) throw new NotionError("forbidden");
    const children = await this.request("GET", `/blocks/${local.id}/children?page_size=100`, undefined, 3000);
    if (!Array.isArray(children.results) || !children.results.every(object)) throw new NotionError("invalid_response");
    const blocks = children.results, truncated = children.has_more === true;
    const todo = blocks.find(b => b.type === "to_do" && object(b.to_do));
    if (!todo || !object(todo.to_do) || typeof todo.to_do.checked !== "boolean") throw new NotionError(truncated ? "too_large" : "invalid_response");
    const completed = todo.to_do.checked;
    if (completed) this.deps.db.db.prepare("UPDATE notion_items SET completed=1 WHERE root_id=? AND page_id=?").run(this.root, local.id);
    return completed;
  }

  async complete(id: string, scope: NotionScope): Promise<NotionEntry> {
    const local = this.local(id, scope);
    if (local.kind !== "todo" && local.kind !== "reminder") throw new NotionError("invalid_input");
    const { blocks, truncated } = await this.remote(local.id);
    if (truncated) throw new NotionError("too_large");
    const todo = blocks.find(b => b.type === "to_do" && object(b.to_do));
    if (!todo || typeof todo.id !== "string") throw new NotionError("invalid_response");
    if (!object(todo.to_do) || todo.to_do.checked !== true) await this.request("PATCH", `/blocks/${notionId(todo.id)}`, { to_do: { checked: true } });
    this.deps.db.db.prepare("UPDATE notion_items SET completed=1 WHERE root_id=? AND page_id=?").run(this.root, local.id);
    return { ...local, completed: true };
  }

  private async request(method: "GET" | "POST" | "PATCH", endpoint: string, body?: unknown, timeoutMs = this.timeout): Promise<Record<string, unknown>> {
    if (this.queued >= 20) throw new NotionError("unavailable");
    const started = this.now(), signal = AbortSignal.timeout(Math.min(this.timeout, timeoutMs));
    const run = async () => {
      if (this.now() < this.cooldownUntil) throw new NotionError("rate_limited", 429, this.cooldownUntil - this.now());
      if (signal.aborted || this.now() - started >= this.timeout) throw new NotionError("timeout");
      const wait = Math.max(0, this.nextRequestAt - this.now());
      if (wait) await abortable(new Promise<void>(resolve => setTimeout(resolve, wait)), signal);
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload && Buffer.byteLength(payload) > 96 * 1024) throw new NotionError("too_large");
      this.nextRequestAt = this.now() + (this.deps.minRequestIntervalMs ?? 350);
      let response: Response;
      try {
        response = await abortable(this.fetcher(`https://api.notion.com/v1${endpoint}`, { method, redirect: "error", signal,
          headers: { Authorization: `Bearer ${this.options.apiKey}`, "Notion-Version": NOTION_API_VERSION, "Content-Type": "application/json", Accept: "application/json" }, body: payload }), signal);
      } catch (error) { if (error instanceof NotionError) throw error; throw new NotionError(signal.aborted ? "timeout" : "unavailable"); }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if ([429, 529].includes(response.status)) {
          const delay = Math.max(1000, parseRetryAfter(response.headers.get("retry-after"), this.now()));
          const now = this.now();
          const until = !Number.isFinite(now) || now < 0 || now >= MAX_COOLDOWN_TIMESTAMP || delay >= MAX_COOLDOWN_TIMESTAMP - now
            ? MAX_COOLDOWN_TIMESTAMP : Math.ceil(now + delay);
          this.cooldownUntil = Math.max(this.cooldownUntil, until);
          this.deps.db.kvSet(this.cooldownKey, String(this.cooldownUntil));
          throw new NotionError("rate_limited", response.status, this.cooldownUntil - this.now());
        }
        if ([401, 403].includes(response.status)) throw new NotionError("forbidden", response.status);
        if (response.status === 404) throw new NotionError("not_found", 404);
        if ([400, 422].includes(response.status)) throw new NotionError("invalid_input", response.status);
        throw new NotionError("unavailable", response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new NotionError("invalid_response");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const next = await abortable(reader.read(), signal); if (next.done) break; size += next.value.length;
          if (size > 1024 * 1024) throw new NotionError("too_large"); chunks.push(next.value); }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!object(value)) throw new NotionError("invalid_response");
        return value;
      } catch (error) { if (error instanceof NotionError) throw error; throw new NotionError(signal.aborted ? "timeout" : "invalid_response"); }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    };
    this.queued++;
    const work = this.tail.then(run, run); this.tail = work.catch(() => {});
    try { return await work; } finally { this.queued--; }
  }
}
