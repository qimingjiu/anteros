import { createHash } from "node:crypto";
import type { Database } from "../db/index.js";
import type { Gateway } from "../gateway/index.js";
import type { MessageSegment } from "../types.js";
import { NotionError, notionDueAt, notionId, type NotionNotebook, type NotionScope } from "./notion.js";
import { checkedRecurrence, nextReminderOccurrence, type ReminderRecurrence } from "./notion-reminder-time.js";
import { logger } from "../util/logger.js";
export { nextReminderOccurrence, type ReminderRecurrence } from "./notion-reminder-time.js";
const log = logger("notion-reminders");
const POLL_INTERVAL = 300_000, SYNC_RETRY = 30_000, SYNC_GRACE = 120_000;

export interface NotionReminderInput {
  entryId: string; title: string; notionUrl: string; dueAt: string;
  requesterId: string; conversationType: "private" | "group"; targetId: string;
}
export interface NotionReminderReceipt { entryId: string; dueAt: string; status: "scheduled" | "queued" | "cancelled"; delivery: "qq_server_scheduler" }
export interface NotionReminderManageInput {
  action: "list" | "repeat" | "snooze" | "skip_next" | "cancel";
  entryId?: string; recurrence?: ReminderRecurrence; until?: string;
}
export interface NotionReminderDeps {
  db: Database; gateway: Pick<Gateway, "enqueueSend">; accountId: string;
  ownerIds: string[]; allowedGroupIds: string[]; now?: () => number;
  notebook?: Pick<NotionNotebook, "completionStatus">;
}
interface ReminderRow { account_id: string; entry_id: string; requester_id: string; conversation_type: "private" | "group";
  target_id: string; title: string; notion_url: string; due_at: string; status: "scheduled" | "queued" | "cancelled"; send_task_id: number | null;
  recurrence: string | null; snooze_at: string | null; snooze_replaces_due: number; revision: number;
  sync_checked_at: string | null; sync_failure_since: string | null; sync_retry_at: string | null }

/** Each occurrence's insertion and schedule advance share a write transaction.
 * Unknown QQ delivery never retries that occurrence or blocks future cycles. */
export class NotionReminderScheduler {
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private working?: Promise<void>;
  private lastFailure?: { reason: "storage_error" | "outbox_error"; at: string; retryAt: string };
  private lastSuccessAt?: string;
  private retryAt = 0;
  private failures = 0;
  private lastLogAt = -Infinity;
  private lastLogReason = "";
  constructor(private readonly deps: NotionReminderDeps) {
    this.now = deps.now ?? Date.now;
    deps.db.db.exec(`CREATE TABLE IF NOT EXISTS notion_reminders (
      account_id TEXT NOT NULL,entry_id TEXT NOT NULL,requester_id TEXT NOT NULL,conversation_type TEXT NOT NULL,
      target_id TEXT NOT NULL,title TEXT NOT NULL,notion_url TEXT NOT NULL,due_at TEXT NOT NULL,status TEXT NOT NULL,
      send_task_id INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(account_id,entry_id));
      CREATE INDEX IF NOT EXISTS notion_reminders_due ON notion_reminders(account_id,status,due_at);
      CREATE TABLE IF NOT EXISTS notion_reminder_occurrences (
        account_id TEXT NOT NULL,entry_id TEXT NOT NULL,occurrence_key TEXT NOT NULL,due_at TEXT NOT NULL,
        send_task_id INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(account_id,entry_id,occurrence_key));
      CREATE TABLE IF NOT EXISTS notion_reminder_actions (
        action_key TEXT PRIMARY KEY,result TEXT NOT NULL,created_at TEXT NOT NULL);`);
    const columns = new Set((deps.db.db.prepare("PRAGMA table_info(notion_reminders)").all() as unknown as { name: string }[]).map(c => c.name));
    for (const [name, definition] of Object.entries({ recurrence: "TEXT", snooze_at: "TEXT", snooze_replaces_due: "INTEGER NOT NULL DEFAULT 0", revision: "INTEGER NOT NULL DEFAULT 0", sync_checked_at: "TEXT", sync_failure_since: "TEXT", sync_retry_at: "TEXT" })) {
      if (!columns.has(name)) deps.db.db.exec(`ALTER TABLE notion_reminders ADD COLUMN ${name} ${definition}`);
    }
  }
  private iso(ms = this.now()): string { return new Date(ms).toISOString(); }
  private row(id: string): ReminderRow | undefined {
    return this.deps.db.db.prepare("SELECT * FROM notion_reminders WHERE account_id=? AND entry_id=?").get(this.deps.accountId, id) as ReminderRow | undefined;
  }
  private checkTarget(requesterId: string, type: string, targetId: string): void {
    if (!this.deps.ownerIds.includes(requesterId) || this.deps.db.isUserBlocked(this.deps.accountId, requesterId)
      || (type !== "private" && type !== "group") || (type === "private" && targetId !== requesterId)
      || (type === "group" && !this.deps.allowedGroupIds.includes(targetId))) throw new NotionError("forbidden");
  }
  private item(id: string, scope: NotionScope): { title: string; dueAt?: string; kind: string } {
    this.checkTarget(scope.requesterId, scope.conversationType, scope.targetId);
    const row = this.deps.db.db.prepare("SELECT owner_id,conversation_type,target_id,entry,completed FROM notion_items WHERE page_id=?")
      .get(id) as { owner_id: string; conversation_type: string; target_id: string; entry: string; completed: number } | undefined;
    if (!row || row.owner_id !== scope.requesterId || row.completed) throw new NotionError("forbidden");
    const entry = JSON.parse(row.entry) as { title: string; dueAt?: string; kind: string };
    if (!["todo", "reminder"].includes(entry.kind)) throw new NotionError("invalid_input");
    return entry;
  }
  private scoped(id: string, scope: NotionScope): ReminderRow {
    this.checkTarget(scope.requesterId, scope.conversationType, scope.targetId);
    const row = this.row(id);
    if (!row || row.requester_id !== scope.requesterId) throw new NotionError("not_found");
    return row;
  }
  private roomForReminder(): void {
    const count = this.deps.db.db.prepare("SELECT COUNT(*) AS n FROM notion_reminders WHERE account_id=? AND status='scheduled'").get(this.deps.accountId) as { n: number };
    if (count.n >= 500) throw new NotionError("too_large");
  }
  schedule(input: NotionReminderInput): NotionReminderReceipt {
    const id = notionId(input.entryId), dueAt = notionDueAt(input.dueAt, this.now()), entry = this.item(id, input);
    const expectedUrl = `https://www.notion.so/${id.replaceAll("-", "")}`;
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200 || input.notionUrl !== expectedUrl
      || entry.dueAt !== dueAt || entry.title !== input.title) throw new NotionError("invalid_input");
    const previous = this.row(id);
    if (previous) {
      if (previous.requester_id !== input.requesterId || previous.conversation_type !== input.conversationType || previous.target_id !== input.targetId || previous.due_at !== dueAt || previous.status === "cancelled") throw new NotionError("invalid_input");
      return { entryId: id, dueAt, status: previous.status, delivery: "qq_server_scheduler" };
    }
    this.roomForReminder(); const now = this.iso();
    this.deps.db.db.prepare(`INSERT INTO notion_reminders(account_id,entry_id,requester_id,conversation_type,target_id,title,notion_url,due_at,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'scheduled',?,?)`).run(this.deps.accountId, id, input.requesterId, input.conversationType, input.targetId, input.title, expectedUrl, dueAt, now, now);
    return { entryId: id, dueAt, status: "scheduled", delivery: "qq_server_scheduler" };
  }
  /** requestKey identifies the originating message and prevents a repeated
   * skip_next tool call from accidentally skipping a second week. */
  async manage(input: NotionReminderManageInput, scope: NotionScope, requestKey?: string): Promise<Record<string, unknown>> {
    this.checkTarget(scope.requesterId, scope.conversationType, scope.targetId);
    if (!input || !["list", "repeat", "snooze", "skip_next", "cancel"].includes(input.action)) throw new NotionError("invalid_input");
    if (input.action === "list") {
      const rows = this.deps.db.db.prepare(`SELECT * FROM notion_reminders WHERE account_id=? AND requester_id=? ORDER BY CASE status WHEN 'scheduled' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,due_at LIMIT 100`)
        .all(this.deps.accountId, scope.requesterId) as unknown as ReminderRow[];
      return { reminders: rows.map(row => this.receipt(row)), limit: 100 };
    }
    const id = notionId(input.entryId!);
    if (requestKey !== undefined && (typeof requestKey !== "string" || !requestKey || requestKey.length > 1500)) throw new NotionError("invalid_input");
    const key = requestKey ? createHash("sha256").update(JSON.stringify([this.deps.accountId, scope, requestKey, input])).digest("hex") : undefined;
    this.deps.db.db.exec("BEGIN IMMEDIATE");
    try {
      if (key) {
        const saved = this.deps.db.db.prepare("SELECT result FROM notion_reminder_actions WHERE action_key=?").get(key) as { result: string } | undefined;
        if (saved) { this.deps.db.db.exec("COMMIT"); return JSON.parse(saved.result) as Record<string, unknown>; }
      }
      let row = this.row(id);
      if (input.action === "repeat") {
        const rule = checkedRecurrence(input.recurrence!), entry = this.item(id, scope), serialized = JSON.stringify(rule);
        if (row) {
          row = this.scoped(id, scope);
          if (row.status !== "cancelled" && row.recurrence === serialized) { /* idempotent rule assignment */ }
          else {
            if (row.status !== "scheduled") this.roomForReminder();
            this.cancelQueued(id);
            this.deps.db.db.prepare("UPDATE notion_reminders SET recurrence=?,due_at=?,snooze_at=NULL,snooze_replaces_due=0,status='scheduled',revision=revision+1,updated_at=? WHERE account_id=? AND entry_id=?")
              .run(serialized, nextReminderOccurrence(rule, this.now()), this.iso(), this.deps.accountId, id);
          }
        } else {
          this.roomForReminder(); const now = this.iso();
          this.deps.db.db.prepare(`INSERT INTO notion_reminders(account_id,entry_id,requester_id,conversation_type,target_id,title,notion_url,due_at,status,recurrence,revision,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,'scheduled',?,1,?,?)`).run(this.deps.accountId, id, scope.requesterId, scope.conversationType, scope.targetId, entry.title,
              `https://www.notion.so/${id.replaceAll("-", "")}`, nextReminderOccurrence(rule, this.now()), serialized, now, now);
        }
      } else {
        row = this.scoped(id, scope);
        if (input.action === "cancel") { this.cancelQueued(id); this.deps.db.db.prepare("UPDATE notion_reminders SET status='cancelled',snooze_at=NULL,updated_at=? WHERE account_id=? AND entry_id=?").run(this.iso(), this.deps.accountId, id); }
        else {
          this.item(id, scope);
          if (row.status === "cancelled") throw new NotionError("invalid_input");
          if (input.action === "skip_next") {
            if (!row.recurrence) throw new NotionError("invalid_input");
            this.cancelQueued(id);
            this.deps.db.db.prepare("UPDATE notion_reminders SET due_at=?,snooze_at=NULL,snooze_replaces_due=0,revision=revision+1,updated_at=? WHERE account_id=? AND entry_id=?")
              .run(nextReminderOccurrence(JSON.parse(row.recurrence), Math.max(this.now(), Date.parse(row.due_at))), this.iso(), this.deps.accountId, id);
          } else {
            const until = notionDueAt(input.until!, this.now());
            if (Date.parse(until) > this.now() + 31 * 86400_000) throw new NotionError("invalid_input");
            if (row.snooze_at !== until) {
              if (row.status !== "scheduled") this.roomForReminder();
              this.cancelQueued(id);
              this.deps.db.db.prepare("UPDATE notion_reminders SET snooze_at=?,snooze_replaces_due=?,status='scheduled',revision=revision+1,updated_at=? WHERE account_id=? AND entry_id=?")
                .run(until, !row.recurrence || Date.parse(until) >= Date.parse(row.due_at) ? 1 : 0, this.iso(), this.deps.accountId, id);
            }
          }
        }
      }
      const result = this.receipt(this.row(id)!);
      if (key) this.deps.db.db.prepare("INSERT INTO notion_reminder_actions(action_key,result,created_at) VALUES(?,?,?)").run(key, JSON.stringify(result), this.iso());
      this.deps.db.db.exec("COMMIT"); return result;
    } catch (error) { this.deps.db.db.exec("ROLLBACK"); throw error; }
  }
  private receipt(row: ReminderRow): Record<string, unknown> {
    const task = row.send_task_id ? this.deps.db.sendTaskById(row.send_task_id) : undefined;
    return { entryId: row.entry_id, title: row.title, notionUrl: row.notion_url, status: row.status,
      dueAt: row.due_at, nextAt: this.effectiveDue(row), recurrence: row.recurrence ? JSON.parse(row.recurrence) : null, snoozeAt: row.snooze_at, latestDelivery: task?.status ?? null,
      conversationType: row.conversation_type, targetId: row.target_id, delivery: "qq_server_scheduler" };
  }
  private cancelQueued(id: string): void {
    this.deps.db.db.prepare(`UPDATE send_tasks SET status='failed',last_error='提醒已取消',updated_at=? WHERE status='queued' AND id IN (
      SELECT send_task_id FROM notion_reminder_occurrences WHERE account_id=? AND entry_id=? UNION SELECT send_task_id FROM notion_reminders WHERE account_id=? AND entry_id=?)`)
      .run(this.iso(), this.deps.accountId, id, this.deps.accountId, id);
  }
  cancel(entryId: string): boolean {
    const id = notionId(entryId), row = this.row(id);
    if (!row || row.status === "cancelled") return false;
    this.deps.db.db.exec("BEGIN IMMEDIATE");
    try { this.cancelQueued(id); this.deps.db.db.prepare("UPDATE notion_reminders SET status='cancelled',snooze_at=NULL,updated_at=? WHERE account_id=? AND entry_id=?").run(this.iso(), this.deps.accountId, id); this.deps.db.db.exec("COMMIT"); }
    catch (error) { this.deps.db.db.exec("ROLLBACK"); throw error; }
    return true;
  }
  status(): Record<string, unknown> {
    const counts = this.deps.db.db.prepare("SELECT status,COUNT(*) AS n FROM notion_reminders WHERE account_id=? GROUP BY status").all(this.deps.accountId) as unknown as { status: string; n: number }[];
    const deliveries = this.deps.db.db.prepare(`SELECT s.status,COUNT(*) AS n FROM send_tasks s WHERE COALESCE(s.last_error,'')!='提醒已取消' AND s.id IN (
      SELECT send_task_id FROM notion_reminder_occurrences WHERE account_id=? UNION SELECT send_task_id FROM notion_reminders WHERE account_id=?) GROUP BY s.status`)
      .all(this.deps.accountId, this.deps.accountId) as unknown as { status: string; n: number }[];
    const deliveryCounts = Object.fromEntries(["queued", "in_flight", "confirmed", "failed", "unknown"].map(status => [status, deliveries.find(x => x.status === status)?.n ?? 0]));
    const sync = this.deps.db.db.prepare("SELECT COUNT(*) AS n FROM notion_reminders WHERE account_id=? AND status!='cancelled' AND sync_failure_since IS NOT NULL").get(this.deps.accountId) as { n: number };
    return { enabled: true, schedulerRunning: !!this.timer && !this.stopped, delivery: "qq_server_scheduler", counts: Object.fromEntries(counts.map(x => [x.status, x.n])),
      deliveryCounts, healthy: !this.lastFailure && !deliveryCounts.failed && !deliveryCounts.unknown && !sync.n,
      completionSync: { enabled: !!this.deps.notebook, pollIntervalMs: POLL_INTERVAL, maximumBatch: 30, failures: sync.n, dueFailureGraceMs: SYNC_GRACE },
      lastFailure: this.lastFailure ?? null, lastSuccessAt: this.lastSuccessAt ?? null };
  }
  start(): void { if (this.timer || this.stopped) return; this.timer = setInterval(() => void this.tick().catch(() => {}), 5000); this.timer.unref?.(); void this.tick().catch(() => {}); }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.working; }
  async tick(): Promise<void> {
    if (this.stopped || this.now() < this.retryAt) return;
    if (this.working) return this.working;
    this.working = (async () => {
      try {
        if (await this.deliverDue()) { this.lastFailure = undefined; this.lastSuccessAt = this.iso(); this.failures = 0; this.retryAt = 0; }
        if (!this.stopped) await this.pollCompletion();
      } catch { this.recordFailure("storage_error"); }
    })();
    try { await this.working; } finally { this.working = undefined; }
  }
  private recordFailure(reason: "storage_error" | "outbox_error"): void {
    this.retryAt = this.now() + Math.min(300_000, 5000 * 2 ** Math.min(6, this.failures++));
    this.lastFailure = { reason, at: this.iso(), retryAt: this.iso(this.retryAt) };
    this.logFailure(reason);
  }
  private logFailure(reason: string): void {
    if (reason !== this.lastLogReason || this.now() - this.lastLogAt >= 300_000) {
      log.warn("Notion 提醒暂时失败，任务已保留。", { reason, operation: "notion_reminder" });
      this.lastLogAt = this.now(); this.lastLogReason = reason;
    }
  }
  private async refreshCompletion(row: ReminderRow): Promise<"active" | "completed" | "unavailable"> {
    const item = this.deps.db.db.prepare("SELECT completed FROM notion_items WHERE page_id=?").get(row.entry_id) as { completed: number } | undefined;
    if (!item || item.completed) { this.cancel(row.entry_id); return "completed"; }
    if (!this.deps.notebook) return "active";
    if (row.sync_retry_at && row.sync_retry_at > this.iso()) return "unavailable";
    try {
      const complete = await this.deps.notebook.completionStatus(row.entry_id, { requesterId: row.requester_id, conversationType: row.conversation_type, targetId: row.target_id });
      this.deps.db.db.prepare("UPDATE notion_reminders SET sync_checked_at=?,sync_failure_since=NULL,sync_retry_at=NULL WHERE account_id=? AND entry_id=?").run(this.iso(), this.deps.accountId, row.entry_id);
      if (complete) { this.deps.db.db.prepare("UPDATE notion_items SET completed=1 WHERE page_id=?").run(row.entry_id); this.cancel(row.entry_id); return "completed"; }
      return "active";
    } catch {
      this.deps.db.db.prepare("UPDATE notion_reminders SET sync_checked_at=?,sync_failure_since=COALESCE(sync_failure_since,?),sync_retry_at=? WHERE account_id=? AND entry_id=?")
        .run(this.iso(), this.iso(), this.iso(this.now() + SYNC_RETRY), this.deps.accountId, row.entry_id);
      this.logFailure("completion_sync_error"); return "unavailable";
    }
  }
  private async pollCompletion(): Promise<void> {
    if (!this.deps.notebook) return;
    // One bounded sweep per five minutes per account, persisted across restart.
    // A second process cannot double the background polling quota.
    const pollKey = `notion:reminder-poll:${this.deps.accountId}`;
    const acquired = this.deps.db.db.prepare(`INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value
      WHERE CAST(kv.value AS INTEGER)<=? RETURNING key`).get(pollKey, String(this.now() + POLL_INTERVAL), this.now());
    if (!acquired) return;
    const started = Date.now();
    const rows = this.deps.db.db.prepare(`SELECT n.* FROM notion_reminders n WHERE n.account_id=? AND (n.status='scheduled' OR (n.status='queued' AND EXISTS (SELECT 1 FROM send_tasks s WHERE s.id=n.send_task_id AND s.status='queued')))
      AND (n.sync_checked_at IS NULL OR n.sync_checked_at<=?) AND (n.sync_retry_at IS NULL OR n.sync_retry_at<=?) ORDER BY COALESCE(n.sync_checked_at,''),n.due_at LIMIT 30`)
      .all(this.deps.accountId, this.iso(this.now() - POLL_INTERVAL), this.iso()) as unknown as ReminderRow[];
    for (const row of rows) {
      if (this.stopped || Date.now() - started >= 10_000) break;
      try { this.checkTarget(row.requester_id, row.conversation_type, row.target_id); } catch { this.cancel(row.entry_id); continue; }
      await this.refreshCompletion(row);
    }
  }
  private effectiveDue(row: ReminderRow): string {
    return row.snooze_at && (row.snooze_replaces_due || row.snooze_at < row.due_at) ? row.snooze_at : row.due_at;
  }
  private async deliverDue(): Promise<boolean> {
    const started = Date.now();
    const rows = this.deps.db.db.prepare(`SELECT * FROM notion_reminders WHERE account_id=? AND status='scheduled'
      AND (CASE WHEN snooze_at IS NOT NULL AND (snooze_replaces_due=1 OR snooze_at<due_at) THEN snooze_at ELSE due_at END)<=? ORDER BY due_at LIMIT 20`)
      .all(this.deps.accountId, this.iso()) as unknown as ReminderRow[];
    let succeeded = true;
    for (const observed of rows) {
      if (this.stopped || Date.now() - started >= 10_000) break;
      try { this.checkTarget(observed.requester_id, observed.conversation_type, observed.target_id); } catch { this.cancel(observed.entry_id); continue; }
      const sync = await this.refreshCompletion(observed);
      if (sync === "completed") continue;
      const refreshed = this.row(observed.entry_id);
      if (!refreshed || refreshed.status !== "scheduled") continue;
      if (sync === "unavailable" && this.now() - Date.parse(refreshed.sync_failure_since ?? this.iso()) < SYNC_GRACE) continue;
      this.deps.db.db.exec("BEGIN IMMEDIATE");
      try {
        // Notion I/O yielded: re-read under the write lock before enqueue.
        const row = this.row(observed.entry_id);
        if (!row || row.status !== "scheduled" || row.revision !== observed.revision || this.effectiveDue(row) > this.iso()) { this.deps.db.db.exec("COMMIT"); continue; }
        let permitted = true;
        try { this.item(row.entry_id, { requesterId: row.requester_id, conversationType: row.conversation_type, targetId: row.target_id }); } catch { permitted = false; }
        if (!permitted) {
          this.cancelQueued(row.entry_id);
          this.deps.db.db.prepare("UPDATE notion_reminders SET status='cancelled',snooze_at=NULL,updated_at=? WHERE account_id=? AND entry_id=?").run(this.iso(), this.deps.accountId, row.entry_id);
          this.deps.db.db.exec("COMMIT"); continue;
        }
        const dueAt = this.effectiveDue(row), isSnooze = dueAt === row.snooze_at;
        const late = this.now() - Date.parse(dueAt) > 60_000 ? "（服务器恢复后补送）" : "";
        const unverified = sync === "unavailable" ? "\n（Notion完成状态暂未同步；如已完成可忽略。）" : "";
        const segments: MessageSegment[] = [...(row.conversation_type === "group" ? [{ type: "at" as const, data: { qq: row.requester_id } }] : []),
          { type: "text", data: { text: `提醒${late}：${row.title}\n${row.notion_url}${unverified}` } }];
        const key = row.revision === 0 && !row.recurrence && !isSnooze ? `notion-reminder:${this.deps.accountId}:${row.entry_id}`
          : `notion-reminder:${this.deps.accountId}:${row.entry_id}:${row.revision}:${isSnooze ? "snooze" : "regular"}:${dueAt}`;
        const queued = this.deps.gateway.enqueueSend({ taskKey: key, kind: "proactive_notion_reminder", conversationType: row.conversation_type, targetId: row.target_id,
          payload: { kind: "segments", requesterId: row.requester_id, accountId: this.deps.accountId, segments } });
        this.deps.db.db.prepare("INSERT OR IGNORE INTO notion_reminder_occurrences(account_id,entry_id,occurrence_key,due_at,send_task_id,created_at) VALUES(?,?,?,?,?,?)")
          .run(this.deps.accountId, row.entry_id, key, dueAt, queued.id, this.iso());
        if (row.recurrence) {
          const next = isSnooze && !row.snooze_replaces_due && row.due_at > this.iso() ? row.due_at
            : nextReminderOccurrence(JSON.parse(row.recurrence), Math.max(this.now(), Date.parse(row.due_at)));
          this.deps.db.db.prepare("UPDATE notion_reminders SET due_at=?,snooze_at=NULL,snooze_replaces_due=0,send_task_id=?,updated_at=? WHERE account_id=? AND entry_id=?")
            .run(next, queued.id, this.iso(), this.deps.accountId, row.entry_id);
        } else this.deps.db.db.prepare("UPDATE notion_reminders SET status='queued',snooze_at=NULL,snooze_replaces_due=0,send_task_id=?,updated_at=? WHERE account_id=? AND entry_id=?")
          .run(queued.id, this.iso(), this.deps.accountId, row.entry_id);
        this.deps.db.db.exec("COMMIT");
      } catch {
        try { this.deps.db.db.exec("ROLLBACK"); } catch { /* fixed diagnostic */ }
        this.recordFailure("outbox_error"); succeeded = false; break;
      }
    }
    return succeeded;
  }
}
