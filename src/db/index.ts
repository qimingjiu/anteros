import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type {
  CapabilityMap,
  MessageRecord,
  MemoryFact,
  MessageSegment,
  PokeEvent,
  SendStatus,
} from "../types.js";
import { nowIso } from "../util/misc.js";
import { groupSearchTokens } from "../group-knowledge/tokens.js";

export interface DBRow_Message {
  id: number;
  event_key: string;
  account_id: string;
  provider_id: string;
  conversation_id: string;
  group_id: string | null;
  message_id: string;
  sender_id: string;
  sender_name: string;
  sent_at: string;
  received_at: string;
  reply_to_message_id: string | null;
  segments: string;
  text_content: string;
  status: "active" | "recalled";
  origin: "live" | "backfill";
}

export interface DBRow_SendTask {
  id: number;
  task_key: string | null;
  kind: string;
  conversation_type: "group" | "private";
  target_id: string;
  payload: string;
  status: SendStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DBRow_Memory {
  id: number;
  account_id: string;
  group_id: string;
  kind: MemoryFact["kind"];
  subject_user_id: string | null;
  subject_name: string | null;
  statement: string;
  narrator_id: string;
  narrator_name: string | null;
  source_message_id: string | null;
  source_sent_at: string | null;
  status: MemoryFact["status"];
  confidence: number;
  superseded_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface DBRow_Topic {
  id: number;
  account_id: string;
  group_id: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  participants: string | null; // JSON [{id,name,count}]
  message_count: number;
  first_message_id: string | null;
  last_message_id: string | null;
}

export interface DBRow_Report {
  report_key: string;
  account_id: string;
  group_id: string;
  report_date: string;
  period: string;
  range_start: string;
  range_end: string;
  file_path: string | null;
  summary: string | null;
  status: "pending" | "generating" | "generated" | "failed";
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface DBRow_Delivery {
  id: number;
  report_key: string;
  recipient_id: string;
  status: SendStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DBRow_Downtime {
  id: number;
  account_id: string;
  started_at: string;
  ended_at: string | null;
  reason: string | null;
}

const MIGRATIONS: string[] = [
  // v1 初始 schema
  `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    group_id TEXT,
    message_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    reply_to_message_id TEXT,
    segments TEXT NOT NULL,
    text_content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    origin TEXT NOT NULL DEFAULT 'live'
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(conversation_id, sent_at);
  CREATE INDEX IF NOT EXISTS idx_messages_group_date ON messages(group_id, sent_at);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, sent_at);

  CREATE TABLE IF NOT EXISTS send_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_key TEXT UNIQUE,
    kind TEXT NOT NULL,
    conversation_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_send_tasks_status ON send_tasks(status);

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject_user_id TEXT,
    subject_name TEXT,
    statement TEXT NOT NULL,
    narrator_id TEXT NOT NULL,
    narrator_name TEXT,
    source_message_id TEXT,
    source_sent_at TEXT,
    status TEXT NOT NULL DEFAULT 'candidate',
    confidence REAL NOT NULL DEFAULT 0.5,
    superseded_by INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memories_group ON memories(account_id, group_id, status);

  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    summary TEXT,
    participants TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    first_message_id TEXT,
    last_message_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_topics_group ON topics(account_id, group_id, started_at);

  CREATE TABLE IF NOT EXISTS reports (
    report_key TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    report_date TEXT NOT NULL,
    period TEXT NOT NULL,
    range_start TEXT NOT NULL,
    range_end TEXT NOT NULL,
    file_path TEXT,
    summary TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_key TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(report_key, recipient_id)
  );

  CREATE TABLE IF NOT EXISTS downtime (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    reason TEXT
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2: 链接阅读记录（日报“资源分享”与冷却判断）
  `
  CREATE TABLE IF NOT EXISTS link_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    url TEXT NOT NULL,
    final_url TEXT,
    title TEXT,
    summary TEXT,
    status TEXT NOT NULL,
    error TEXT,
    shared_by TEXT,
    shared_by_name TEXT,
    shared_message_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_link_reads_group ON link_reads(account_id, group_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_link_reads_url ON link_reads(group_id, url);
  `,
  // v3: 消息判重唯一索引（账号+会话+消息标识），live 与 backfill 同标识视为同一条
  `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_identity ON messages(account_id, conversation_id, message_id);
  `,
  // v4: Bot-local blacklist follows the real sender across chats and restarts.
  `
  CREATE TABLE IF NOT EXISTS blocked_users (
    account_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(account_id, user_id)
  );
  `,
];

export class Database {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // Persistent FTS triggers may run before GroupKnowledge is constructed on this connection.
    this.db.function("group_search_tokens", { deterministic: true }, groupSearchTokens);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv'")
      .get() as { name: string } | undefined;
    let version = 0;
    if (row) {
      const v = this.kvGet("schema_version");
      version = v ? Number(v) : 0;
    }
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec(MIGRATIONS[v]!);
      this.kvSet("schema_version", String(v + 1));
    }
  }

  kvGet(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  kvSet(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  kvDelete(key: string): void {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  /** Bounded durable identities also bind a poke-back task to its real actor. */
  registerPokeEvent(event: PokeEvent): boolean {
    const key = `poke_sources:v1:${event.accountId}`;
    const cutoff = Date.now() - 2 * 60 * 60_000;
    const entries = this.pokeSources(event.accountId).filter(item => Date.parse(item.receivedAt) > cutoff);
    if (entries.some(item => item.eventKey === event.eventKey)) return false;
    entries.push(event);
    this.kvSet(key, JSON.stringify(entries.slice(-2048)));
    return true;
  }

  pokeEventByKey(accountId: string, eventKey: string): PokeEvent | undefined {
    return this.pokeSources(accountId).find(item => item.eventKey === eventKey);
  }

  private pokeSources(accountId: string): PokeEvent[] {
    try {
      const entries: unknown = JSON.parse(this.kvGet(`poke_sources:v1:${accountId}`) ?? "[]");
      return Array.isArray(entries) ? entries.filter((item): item is PokeEvent => item?.kind === "poke"
        && item.accountId === accountId && typeof item.eventKey === "string"
        && typeof item.userId === "string" && typeof item.targetId === "string"
        && typeof item.receivedAt === "string" && typeof item.conversationId === "string") : [];
    } catch { return []; }
  }

  isUserBlocked(accountId: string, userId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM blocked_users WHERE account_id = ? AND user_id = ?").get(accountId, userId));
  }

  blockUser(accountId: string, userId: string, reason: string): void {
    this.db.prepare("INSERT INTO blocked_users(account_id,user_id,reason,created_at) VALUES(?,?,?,?) ON CONFLICT(account_id,user_id) DO NOTHING")
      .run(accountId, userId, reason.slice(0, 240), nowIso());
    this.db.prepare(`UPDATE topics SET summary = NULL, participants = NULL WHERE account_id = ? AND EXISTS (
      SELECT 1 FROM messages m WHERE m.account_id = topics.account_id AND m.group_id = topics.group_id
        AND m.sender_id = ? AND m.sent_at >= topics.started_at AND (topics.ended_at IS NULL OR m.sent_at <= topics.ended_at)
    )`).run(accountId, userId);
    this.db.prepare("DELETE FROM memories WHERE account_id = ? AND narrator_id = ?").run(accountId, userId);
    // Remove the attacker's raw text from context; future messages are dropped
    // at the gateway before persistence. No chat is sent to announce the ban.
    this.db.prepare("DELETE FROM messages WHERE account_id = ? AND sender_id = ?").run(accountId, userId);
    const pokeKey = `poke_sources:v1:${accountId}`;
    this.kvSet(pokeKey, JSON.stringify(this.pokeSources(accountId).filter(event => event.userId !== userId)));
    const queued = this.db.prepare("SELECT id,payload FROM send_tasks WHERE status = 'queued'").all() as { id: number; payload: string }[];
    for (const task of queued) {
      try {
        const payload = JSON.parse(task.payload);
        if (payload?.requesterId === userId && payload?.accountId === accountId) {
          this.finishSendTask(task.id, "failed", "发送者已被静默屏蔽，取消待发回复");
        }
      } catch { /* malformed payload will be handled by the queue */ }
    }
  }

  unblockUser(accountId: string, userId: string): boolean {
    return Number(this.db.prepare("DELETE FROM blocked_users WHERE account_id = ? AND user_id = ?").run(accountId, userId).changes) > 0;
  }

  blockedUsers(accountId: string): { user_id: string; reason: string; created_at: string }[] {
    return this.db.prepare("SELECT user_id,reason,created_at FROM blocked_users WHERE account_id=? ORDER BY created_at DESC").all(accountId) as { user_id: string; reason: string; created_at: string }[];
  }

  /** Explicit maintenance only: discard conversation data without making a backup. */
  clearConversationMemory(): Record<string, number> {
    const counts: Record<string, number> = {};
    const tables = ["messages", "memories", "topics", "link_reads", "reports", "deliveries", "send_tasks"];
    // Link notice tombstones intentionally outlive recalled/expired messages,
    // but an explicit memory reset must also forget the once-only URL hashes.
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get("group_link_notices")) {
      tables.push("group_link_notices");
    }
    this.db.exec("PRAGMA secure_delete = ON; BEGIN IMMEDIATE");
    try {
      for (const table of tables) {
        counts[table] = Number((this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
        this.db.exec(`DELETE FROM ${table}`);
      }
      // Configuration is the only durable state allowed to survive a reset.
      // New or unknown cache keys must not become a forgotten copy of a chat.
      this.db.prepare(`DELETE FROM kv WHERE key NOT IN ('schema_version','active_model_profile','memory_reset_at')
        AND key NOT GLOB 'model_catalog:*' AND key NOT GLOB 'proactive:v1:*'`).run();
      const schedules = this.db.prepare("SELECT key,value FROM kv WHERE key GLOB 'proactive:v1:*'").all() as { key: string; value: string }[];
      for (const schedule of schedules) {
        try {
          const saved = JSON.parse(schedule.value) as Record<string, unknown>;
          const safe: Record<string, unknown> = {};
          for (const key of ['version','nextRandomAt','routeIndex','nextWeatherCheckAt','lastWeatherAlertAt','rainEpisodeUntil','silenceUntil']) {
            if (typeof saved[key] === 'number' && Number.isFinite(saved[key])) safe[key] = saved[key];
          }
          for (const key of ['paused','skipNext']) if (typeof saved[key] === 'boolean') safe[key] = saved[key];
          for (const key of ['lastMorningDate','lastCoolingDate']) {
            if (saved[key] === '' || (typeof saved[key] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(saved[key]))) safe[key] = saved[key];
          }
          if (saved.pool && typeof saved.pool === 'object' && !Array.isArray(saved.pool)) {
            const pool = saved.pool as Record<string, unknown>;
            const id = pool.lastWinnerId;
            if (typeof pool.round === 'number' && Number.isSafeInteger(pool.round) && pool.round >= 0
              && [0, 1, 2].includes(Number(pool.consecutiveWins)) && typeof pool.consecutiveWins === 'number'
              && (id === null || ['impatient','chatterbox','slacker','monthly','ghost'].includes(String(id)))) {
              safe.pool = { round: pool.round, lastWinnerId: id, consecutiveWins: pool.consecutiveWins };
            }
          }
          if (Object.keys(saved).length !== Object.keys(safe).length
            || Object.entries(safe).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(saved[key]))) {
            this.kvSet(schedule.key, JSON.stringify(safe));
          }
        } catch { this.kvDelete(schedule.key); }
      }
      // Keep the blacklist itself, without retaining the model's free-form
      // reason, which may quote the conversation that is being erased.
      this.db.exec("UPDATE blocked_users SET reason = 'retained_after_memory_reset'; UPDATE downtime SET reason = NULL");
      this.db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${tables.map(() => '?').join(',')})`).run(...tables);
      this.kvSet("memory_reset_at", nowIso());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    const checkpoint = () => {
      const result = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (Number(result.busy) !== 0) throw new Error("Memory deletion could not truncate WAL; stop all database users before resetting");
    };
    checkpoint();
    this.db.exec("VACUUM");
    checkpoint();
    return counts;
  }

  // ---------- messages ----------

  insertMessage(m: MessageRecord): { inserted: boolean } {
    try {
      this.db
        .prepare(
          `INSERT INTO messages (event_key, account_id, provider_id, conversation_id, group_id,
            message_id, sender_id, sender_name, sent_at, received_at, reply_to_message_id,
            segments, text_content, status, origin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          m.eventKey,
          m.accountId,
          m.providerId,
          m.conversationId,
          m.groupId ?? null,
          m.messageId,
          m.senderId,
          m.displayNameAtTime,
          m.sentAt,
          m.receivedAt,
          m.replyToMessageId ?? null,
          JSON.stringify(m.segments),
          m.textContent,
          m.status,
          m.origin,
        );
      return { inserted: true };
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) return { inserted: false };
      throw e;
    }
  }

  getMessageByEventKey(eventKey: string): DBRow_Message | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE event_key = ?").get(eventKey) as
      | DBRow_Message
      | undefined;
  }

  getMessageById(conversationId: string, messageId: string): DBRow_Message | undefined {
    return this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?")
      .get(conversationId, messageId) as DBRow_Message | undefined;
  }

  markRecalled(conversationId: string, messageId: string, accountId?: string): boolean {
    // Legacy callers can omit the account only when this identity is unambiguous.
    // The gateway always supplies the actual protocol account.
    if (accountId === undefined) {
      const accounts = this.db.prepare("SELECT DISTINCT account_id FROM messages WHERE conversation_id=? AND message_id=? LIMIT 2")
        .all(conversationId, messageId) as { account_id: string }[];
      if (accounts.length !== 1) return false;
      accountId = accounts[0]!.account_id;
    }
    const r = this.db
      .prepare("UPDATE messages SET status = 'recalled' WHERE account_id = ? AND conversation_id = ? AND message_id = ? AND status = 'active'")
      .run(accountId, conversationId, messageId);
    return Number(r.changes) > 0;
  }

  recentMessages(conversationId: string, limit: number, beforeIso?: string): DBRow_Message[] {
    if (beforeIso) {
      return this.db
        .prepare(
          "SELECT * FROM messages WHERE conversation_id = ? AND sent_at <= ? AND status = 'active' ORDER BY sent_at DESC, id DESC LIMIT ?",
        )
        .all(conversationId, beforeIso, limit) as unknown as DBRow_Message[];
    }
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE conversation_id = ? AND status = 'active' ORDER BY sent_at DESC, id DESC LIMIT ?",
      )
      .all(conversationId, limit) as unknown as DBRow_Message[];
  }

  messagesInRange(groupId: string, startIso: string, endIso: string): DBRow_Message[] {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE group_id = ? AND sent_at >= ? AND sent_at < ? ORDER BY sent_at ASC, id ASC",
      )
      .all(groupId, startIso, endIso) as unknown as DBRow_Message[];
  }

  messageCountInRange(groupId: string, startIso: string, endIso: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE group_id = ? AND sent_at >= ? AND sent_at < ?")
      .get(groupId, startIso, endIso) as { c: number };
    return Number(r.c);
  }

  senderStatsInRange(groupId: string, startIso: string, endIso: string): { sender_id: string; sender_name: string; c: number }[] {
    return this.db
      .prepare(
        `SELECT sender_id, MAX(sender_name) AS sender_name, COUNT(*) AS c
         FROM messages WHERE group_id = ? AND sent_at >= ? AND sent_at < ? AND status = 'active'
         GROUP BY sender_id ORDER BY c DESC LIMIT 50`,
      )
      .all(groupId, startIso, endIso) as unknown as { sender_id: string; sender_name: string; c: number }[];
  }

  purgeOldMessages(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    const r = this.db.prepare("DELETE FROM messages WHERE sent_at < ?").run(cutoff);
    return Number(r.changes);
  }

  rowToRecord(r: DBRow_Message): MessageRecord {
    return {
      eventKey: r.event_key,
      accountId: r.account_id,
      providerId: r.provider_id,
      conversationId: r.conversation_id,
      groupId: r.group_id ?? undefined,
      messageId: r.message_id,
      senderId: r.sender_id,
      displayNameAtTime: r.sender_name,
      sentAt: r.sent_at,
      receivedAt: r.received_at,
      replyToMessageId: r.reply_to_message_id ?? undefined,
      segments: JSON.parse(r.segments) as MessageSegment[],
      textContent: r.text_content,
      status: r.status,
      origin: r.origin,
    };
  }

  // ---------- send tasks ----------

  enqueueSendTask(t: {
    taskKey?: string;
    kind: string;
    conversationType: "group" | "private";
    targetId: string;
    payload: unknown;
  }): { id: number; reused: boolean } {
    const now = nowIso();
    if (t.taskKey) {
      const existing = this.db
        .prepare("SELECT id FROM send_tasks WHERE task_key = ?")
        .get(t.taskKey) as { id: number } | undefined;
      if (existing) return { id: existing.id, reused: true };
    }
    const r = this.db
      .prepare(
        `INSERT INTO send_tasks (task_key, kind, conversation_type, target_id, payload, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
      )
      .run(t.taskKey ?? null, t.kind, t.conversationType, t.targetId, JSON.stringify(t.payload), now, now);
    return { id: Number(r.lastInsertRowid), reused: false };
  }

  claimSendTask(id: number): DBRow_SendTask | undefined {
    const now = nowIso();
    const r = this.db
      .prepare(
        "UPDATE send_tasks SET status = 'in_flight', updated_at = ? WHERE id = ? AND status = 'queued' RETURNING *",
      )
      .get(now, id) as DBRow_SendTask | undefined;
    return r;
  }

  finishSendTask(id: number, status: "confirmed" | "failed" | "unknown", error?: string, messageId?: string): void {
    const now = nowIso();
    const t = this.db.prepare("SELECT payload FROM send_tasks WHERE id = ?").get(id) as { payload: string } | undefined;
    let payload = t?.payload ?? "{}";
    if (messageId) {
      try {
        const p = JSON.parse(payload);
        p.sentMessageId = messageId;
        payload = JSON.stringify(p);
      } catch { /* keep */ }
    }
    this.db
      .prepare(
        "UPDATE send_tasks SET status = ?, last_error = ?, payload = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, error ?? null, payload, now, id);
  }

  bumpSendTaskAttempt(id: number): void {
    this.db
      .prepare("UPDATE send_tasks SET attempts = attempts + 1, updated_at = ? WHERE id = ?")
      .run(nowIso(), id);
  }

  resetInFlightTasks(): { requeued: number; unknowned: number } {
    // 文件、文档、报告、主动消息和反戳可能已成功，恢复时不自动重发。
    const tasks = this.db
      .prepare("SELECT id, kind, payload FROM send_tasks WHERE status = 'in_flight'")
      .all() as { id: number; kind: string; payload: string }[];
    let requeued = 0;
    let unknowned = 0;
    const now = nowIso();
    const reset = this.db.prepare("UPDATE send_tasks SET status = ?, updated_at = ? WHERE id = ?");
    for (const t of tasks) {
      let oneShotPayload = false;
      try {
        const payload = JSON.parse(t.payload) as { kind?: unknown } | null;
        oneShotPayload = payload !== null && typeof payload === "object" && (payload.kind === "file" || payload.kind === "poke");
      } catch { /* 坏载荷不能阻断其他任务恢复；普通任务下次执行时会明确失败。 */ }
      const uncertain = /^(?:report|proactive|document|poke|minimax_)/i.test(t.kind) || oneShotPayload;
      reset.run(uncertain ? "unknown" : "queued", now, t.id);
      if (uncertain) unknowned++;
      else requeued++;
    }
    return { requeued, unknowned };
  }

  pendingSendTasks(limit: number): DBRow_SendTask[] {
    return this.db
      .prepare("SELECT * FROM send_tasks WHERE status = 'queued' ORDER BY id ASC LIMIT ?")
      .all(limit) as unknown as DBRow_SendTask[];
  }

  sendTaskById(id: number): DBRow_SendTask | undefined {
    return this.db.prepare("SELECT * FROM send_tasks WHERE id = ?").get(id) as DBRow_SendTask | undefined;
  }

  retrySendTask(id: number): boolean {
    const task = this.sendTaskById(id);
    if (task?.status === "unknown") {
      let isPoke = /^poke/i.test(task.kind);
      try { isPoke ||= JSON.parse(task.payload)?.kind === "poke"; } catch { /* regular malformed tasks keep the existing repair path */ }
      // A poke has no message receipt to reconcile. Repeating an uncertain
      // action could start a feedback interaction; a new real poke gets a new task.
      if (isPoke) return false;
    }
    const r = this.db
      .prepare("UPDATE send_tasks SET status = 'queued', updated_at = ? WHERE id = ? AND status IN ('failed','unknown')")
      .run(nowIso(), id);
    return Number(r.changes) > 0;
  }

  recentSendTasks(limit: number): DBRow_SendTask[] {
    return this.db.prepare("SELECT * FROM send_tasks ORDER BY id DESC LIMIT ?").all(limit) as unknown as DBRow_SendTask[];
  }

  // ---------- memories ----------

  insertMemory(f: MemoryFact & { accountId: string }): number {
    const now = nowIso();
    const r = this.db
      .prepare(
        `INSERT INTO memories (account_id, group_id, kind, subject_user_id, subject_name, statement,
          narrator_id, narrator_name, source_message_id, source_sent_at, status, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.accountId,
        f.groupId,
        f.kind,
        f.subjectUserId ?? null,
        f.subjectName ?? null,
        f.statement,
        f.narratorId,
        f.narratorName ?? null,
        f.sourceMessageId ?? null,
        f.sourceSentAt ?? null,
        f.status,
        f.confidence,
        now,
        now,
      );
    return Number(r.lastInsertRowid);
  }

  searchMemories(accountId: string, groupId: string, keywords: string[], limit: number): DBRow_Memory[] {
    const active = "status IN ('candidate','confirmed') AND superseded_by IS NULL";
    if (keywords.length === 0) {
      return this.db
        .prepare(`SELECT * FROM memories WHERE account_id = ? AND group_id = ? AND ${active} ORDER BY updated_at DESC LIMIT ?`)
        .all(accountId, groupId, limit) as unknown as DBRow_Memory[];
    }
    const like = keywords.map(() => "(statement LIKE ? OR subject_name LIKE ? OR narrator_name LIKE ?)").join(" OR ");
    const params: string[] = [accountId, groupId];
    for (const k of keywords) {
      const p = `%${k}%`;
      params.push(p, p, p);
    }
    return this.db
      .prepare(
        `SELECT * FROM memories WHERE account_id = ? AND group_id = ? AND ${active} AND (${like})
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params, limit) as unknown as DBRow_Memory[];
  }

  recentMemories(accountId: string, groupId: string, limit: number): DBRow_Memory[] {
    return this.db
      .prepare(
        `SELECT * FROM memories WHERE account_id = ? AND group_id = ? AND status IN ('candidate','confirmed') AND superseded_by IS NULL
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(accountId, groupId, limit) as unknown as DBRow_Memory[];
  }

  memoriesInTimeRange(accountId: string, groupId: string, startIso: string, endIso: string): DBRow_Memory[] {
    return this.db
      .prepare(
        `SELECT * FROM memories WHERE account_id = ? AND group_id = ? AND superseded_by IS NULL AND status != 'invalid'
          AND COALESCE(source_sent_at, created_at) >= ? AND COALESCE(source_sent_at, created_at) < ?`,
      )
      .all(accountId, groupId, startIso, endIso) as unknown as DBRow_Memory[];
  }

  memoryById(id: number): DBRow_Memory | undefined {
    return this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as DBRow_Memory | undefined;
  }

  reviseMemory(id: number, newStatus: "confirmed" | "invalid", supersededBy?: number): boolean {
    const r = this.db
      .prepare("UPDATE memories SET status = ?, superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(newStatus, supersededBy ?? null, nowIso(), id);
    return Number(r.changes) > 0;
  }

  findMemoryByStatement(accountId: string, groupId: string, statement: string): DBRow_Memory | undefined {
    return this.db
      .prepare(
        "SELECT * FROM memories WHERE account_id = ? AND group_id = ? AND statement = ? AND superseded_by IS NULL AND status != 'invalid' LIMIT 1",
      )
      .get(accountId, groupId, statement) as DBRow_Memory | undefined;
  }

  // ---------- topics ----------

  upsertOpenTopic(accountId: string, groupId: string, firstMsg: { id: string; sentAt: string }): number {
    const existing = this.db
      .prepare(
        "SELECT id FROM topics WHERE account_id = ? AND group_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get(accountId, groupId) as { id: number } | undefined;
    if (existing) return existing.id;
    const r = this.db
      .prepare(
        "INSERT INTO topics (account_id, group_id, started_at, first_message_id, message_count) VALUES (?, ?, ?, ?, 0)",
      )
      .run(accountId, groupId, firstMsg.sentAt, firstMsg.id);
    return Number(r.lastInsertRowid);
  }

  appendTopicMessage(topicId: number, lastMessageId: string): void {
    this.db
      .prepare("UPDATE topics SET message_count = message_count + 1, last_message_id = ? WHERE id = ?")
      .run(lastMessageId, topicId);
  }

  closeTopic(topicId: number, endedAt: string): void {
    this.db.prepare("UPDATE topics SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(endedAt, topicId);
  }

  setTopicSummary(topicId: number, summary: string, participants: unknown): void {
    this.db
      .prepare("UPDATE topics SET summary = ?, participants = ? WHERE id = ?")
      .run(summary, JSON.stringify(participants), topicId);
  }

  openTopics(accountId: string, groupId: string): DBRow_Topic[] {
    return this.db
      .prepare("SELECT * FROM topics WHERE account_id = ? AND group_id = ? AND ended_at IS NULL ORDER BY started_at ASC")
      .all(accountId, groupId) as unknown as DBRow_Topic[];
  }

  staleOpenTopics(olderThanIso: string): DBRow_Topic[] {
    return this.db
      .prepare("SELECT * FROM topics WHERE ended_at IS NULL AND started_at < ?")
      .all(olderThanIso) as unknown as DBRow_Topic[];
  }

  topicById(id: number): DBRow_Topic | undefined {
    return this.db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as DBRow_Topic | undefined;
  }

  topicsInRange(accountId: string, groupId: string, startIso: string, endIso: string): DBRow_Topic[] {
    return this.db
      .prepare(
        "SELECT * FROM topics WHERE account_id = ? AND group_id = ? AND started_at < ? AND COALESCE(ended_at, '9999') >= ? ORDER BY started_at ASC",
      )
      .all(accountId, groupId, endIso, startIso) as unknown as DBRow_Topic[];
  }

  recentTopics(accountId: string, groupId: string, limit: number): DBRow_Topic[] {
    return this.db
      .prepare("SELECT * FROM topics WHERE account_id = ? AND group_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(accountId, groupId, limit) as unknown as DBRow_Topic[];
  }

  // ---------- reports ----------

  upsertReport(r: {
    reportKey: string;
    accountId: string;
    groupId: string;
    reportDate: string;
    period: string;
    rangeStart: string;
    rangeEnd: string;
    status: DBRow_Report["status"];
    filePath?: string;
    summary?: string;
    messageCount: number;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO reports (report_key, account_id, group_id, report_date, period, range_start, range_end,
           file_path, summary, status, message_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(report_key) DO UPDATE SET
           file_path = COALESCE(excluded.file_path, file_path),
           summary = COALESCE(excluded.summary, summary),
           status = excluded.status,
           message_count = excluded.message_count,
           range_end = excluded.range_end,
           updated_at = excluded.updated_at`,
      )
      .run(
        r.reportKey,
        r.accountId,
        r.groupId,
        r.reportDate,
        r.period,
        r.rangeStart,
        r.rangeEnd,
        r.filePath ?? null,
        r.summary ?? null,
        r.status,
        r.messageCount,
        now,
        now,
      );
  }

  reportByKey(reportKey: string): DBRow_Report | undefined {
    return this.db.prepare("SELECT * FROM reports WHERE report_key = ?").get(reportKey) as DBRow_Report | undefined;
  }

  recentReports(limit: number): DBRow_Report[] {
    return this.db.prepare("SELECT * FROM reports ORDER BY updated_at DESC LIMIT ?").all(limit) as unknown as DBRow_Report[];
  }

  // ---------- deliveries ----------

  ensureDelivery(reportKey: string, recipientId: string): { id: number; reused: boolean } {
    const existing = this.db
      .prepare("SELECT id FROM deliveries WHERE report_key = ? AND recipient_id = ?")
      .get(reportKey, recipientId) as { id: number } | undefined;
    if (existing) return { id: existing.id, reused: true };
    const now = nowIso();
    const r = this.db
      .prepare("INSERT INTO deliveries (report_key, recipient_id, status, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)")
      .run(reportKey, recipientId, now, now);
    return { id: Number(r.lastInsertRowid), reused: false };
  }

  updateDelivery(id: number, status: SendStatus, error?: string, bumpAttempt = false): void {
    if (bumpAttempt) this.db.prepare("UPDATE deliveries SET attempts = attempts + 1 WHERE id = ?").run(id);
    this.db
      .prepare("UPDATE deliveries SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(status, error ?? null, nowIso(), id);
  }

  pendingDeliveries(maxAttempts: number): DBRow_Delivery[] {
    return this.db
      .prepare(
        `SELECT d.* FROM deliveries d JOIN reports r ON r.report_key = d.report_key
         WHERE d.status = 'queued' AND r.status = 'generated' AND d.attempts < ?
         ORDER BY d.id ASC`,
      )
      .all(maxAttempts) as unknown as DBRow_Delivery[];
  }

  deliveryById(id: number): DBRow_Delivery | undefined {
    return this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as DBRow_Delivery | undefined;
  }

  recentDeliveries(limit: number): DBRow_Delivery[] {
    return this.db.prepare("SELECT * FROM deliveries ORDER BY id DESC LIMIT ?").all(limit) as unknown as DBRow_Delivery[];
  }

  retryDelivery(id: number): boolean {
    const r = this.db
      .prepare("UPDATE deliveries SET status = 'queued', updated_at = ? WHERE id = ? AND status IN ('failed','unknown')")
      .run(nowIso(), id);
    return Number(r.changes) > 0;
  }

  // ---------- link reads ----------

  insertLinkRead(r: {
    accountId: string;
    groupId: string;
    url: string;
    finalUrl?: string;
    title?: string;
    summary?: string;
    status: "ok" | "failed";
    error?: string;
    sharedBy?: string;
    sharedByName?: string;
    sharedMessageId?: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO link_reads (account_id, group_id, url, final_url, title, summary, status, error, shared_by, shared_by_name, shared_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        r.accountId,
        r.groupId,
        r.url,
        r.finalUrl ?? null,
        r.title ?? null,
        r.summary ?? null,
        r.status,
        r.error ?? null,
        r.sharedBy ?? null,
        r.sharedByName ?? null,
        r.sharedMessageId ?? null,
        nowIso(),
      );
  }

  lastLinkRead(groupId: string, url: string): { created_at: string; status: string } | undefined {
    return this.db
      .prepare("SELECT created_at, status FROM link_reads WHERE group_id = ? AND url = ? ORDER BY id DESC LIMIT 1")
      .get(groupId, url) as { created_at: string; status: string } | undefined;
  }

  linksInRange(groupId: string, startIso: string, endIso: string): {
    url: string;
    title: string | null;
    summary: string | null;
    status: string;
    error: string | null;
    shared_by_name: string | null;
    created_at: string;
  }[] {
    return this.db
      .prepare(
        "SELECT url, title, summary, status, error, shared_by_name, created_at FROM link_reads WHERE group_id = ? AND created_at >= ? AND created_at < ? ORDER BY id ASC",
      )
      .all(groupId, startIso, endIso) as {
      url: string;
      title: string | null;
      summary: string | null;
      status: string;
      error: string | null;
      shared_by_name: string | null;
      created_at: string;
    }[];
  }

  // ---------- downtime ----------

  markDowntimeStart(accountId: string, reason: string): void {
    const open = this.db
      .prepare("SELECT id FROM downtime WHERE account_id = ? AND ended_at IS NULL")
      .get(accountId) as { id: number } | undefined;
    if (open) return;
    this.db
      .prepare("INSERT INTO downtime (account_id, started_at, reason) VALUES (?, ?, ?)")
      .run(accountId, nowIso(), reason);
  }

  markDowntimeEnd(accountId: string): void {
    this.db
      .prepare("UPDATE downtime SET ended_at = ? WHERE account_id = ? AND ended_at IS NULL")
      .run(nowIso(), accountId);
  }

  downtimeInRange(accountId: string, startIso: string, endIso: string): { started_at: string; ended_at: string | null }[] {
    return this.db
      .prepare(
        `SELECT started_at, ended_at FROM downtime WHERE account_id = ?
          AND started_at < ? AND COALESCE(ended_at, '9999') > ?`,
      )
      .all(accountId, endIso, startIso) as { started_at: string; ended_at: string | null }[];
  }

  close(): void {
    this.db.close();
  }
}
