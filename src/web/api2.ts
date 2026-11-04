/**
 * /api/v2/* — read-only JSON data layer for the new dashboard front end.
 * Only GET. No secrets, keys, tokens or raw group-member message text.
 * Owner-only content (owner's own message previews, owner task requests) requires the panel token when one is set.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { WebDeps } from "./index.js";

const OWNER_FALLBACK = process.env.OWNER_QQ_ID?.trim() || "";
const DISCORD_DB = process.env.DISCORD_DB_PATH ?? "data/discord/bot.db";
const DISCORD_UNIT = "qq-discord-bot";
const UNITS = ["qq-group-bot", "qq-discord-bot", "ncm-api", "xnews-mcp", "docker", "tailscaled", "sing-box"];
const SIDECARS: { name: string; url: string; okCodes?: number[] }[] = [
  { name: "searxng", url: "http://127.0.0.1:8888/healthz" },
  { name: "research-gateway", url: "http://127.0.0.1:8787/health" },
  { name: "ncm-api", url: "http://127.0.0.1:3010/" },
  { name: "xnews-mcp", url: "http://127.0.0.1:8899/mcp", okCodes: [200, 405, 406] },
  { name: "snowluma-webui", url: "http://127.0.0.1:6081/" },
];

type Row = Record<string, unknown>;
type Json = (res: http.ServerResponse, code: number, body: unknown) => void;

// ---------- helpers ----------

/** "Fri 2026-10-30 12:35 AM CST (UTC+08:00)" -> ISO string; passes ISO through; null if unparseable. */
export function toIso(s: unknown): string | null {
  if (typeof s !== "string" || !s) return null;
  const m = /(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})(?::(\d{2}))? (AM|PM).*?\(UTC([+-]\d{2}):(\d{2})\)/.exec(s);
  if (m) {
    let h = Number(m[2]) % 12;
    if (m[5] === "PM") h += 12;
    const iso = `${m[1]}T${String(h).padStart(2, "0")}:${m[3]}:${m[4] ?? "00"}${m[6]}:${m[7]}`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function partsIn(tz: string, d: Date): Record<string, string> {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  return Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
}
/** Local calendar day (bot timezone) of a stored ISO timestamp. */
function dayOf(s: unknown, tz: string): string | null {
  if (typeof s !== "string") return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const p = partsIn(tz, d);
  return `${p.year}-${p.month}-${p.day}`;
}
function hourOf(s: unknown, tz: string): number | null {
  if (typeof s !== "string") return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return Number(partsIn(tz, d).hour) % 24;
}
function localDay(tz: string, offsetDays = 0): string {
  const p = partsIn(tz, new Date(Date.now() + offsetDays * 86400000));
  return `${p.year}-${p.month}-${p.day}`;
}
/** UTC ISO instant at which local day `day` (YYYY-MM-DD) starts in tz; stored timestamps are UTC ISO so string compare works. */
function dayStartIso(tz: string, day: string): string {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const p = partsIn(tz, new Date(guess));
  const asUtc = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  return new Date(guess - (asUtc - guess)).toISOString();
}
function clampInt(v: string | null, def: number, min: number, max: number): number {
  if (v === null || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : def;
}
/** Strip anything that looks like a credential from free-form error text. */
export function scrub(s: unknown, max = 200): string | null {
  if (s === undefined || s === null || s === "") return null;
  return String(s)
    .replace(/([?&](?:key|token|api[_-]?key|access_token|secret|sig|auth)[^=]*=)[^&\s"']+/gi, "$1***")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***")
    .replace(/\b(sk|pk|rk|ak)-[A-Za-z0-9_-]{8,}/g, "$1-***")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "***")
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//***@")
    .slice(0, max);
}
function hostOf(u: string | undefined): string | null {
  if (!u) return null;
  try { return new URL(u).host; } catch { return null; }
}
function safeJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string") return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
function run(cmd: string, args: string[], timeoutMs = 4000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout ?? "") });
    });
  });
}
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
async function probe(url: string, okCodes = [200], timeoutMs = 3000): Promise<{ ok: boolean; status: number | null; latencyMs: number | null; error: string | null }> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    await r.body?.cancel().catch(() => undefined);
    return { ok: okCodes.includes(r.status), status: r.status, latencyMs: Date.now() - t0, error: null };
  } catch (e) {
    return { ok: false, status: null, latencyMs: null, error: scrub((e as Error).message, 120) };
  }
}
function serviceNameOf(p: { serviceName?: string; baseUrl: string }): string {
  if (p.serviceName) return p.serviceName;
  try {
    const host = new URL(p.baseUrl).hostname;
    if (host === "api.deepseek.com" || host === "deepseek.com") return "DeepSeek";
    return host.replace(/^api\./, "");
  } catch { return "默认"; }
}

// ---------- the API ----------

export class ApiV2 {
  constructor(private deps: WebDeps, private authOk: (req: http.IncomingMessage, url: URL) => boolean) {}

  private get acct(): string { return this.deps.cfg.gateway.accountId; }
  private get tz(): string { return this.deps.cfg.timezone; }
  private get ownerId(): string {
    const c = this.deps.cfg;
    return (c.tools.ownerIds?.[0] ?? c.admins[0] ?? OWNER_FALLBACK);
  }
  private q<T = Row>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.deps.db.db.prepare(sql).all(...params) as T[];
  }
  private one<T = Row>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.deps.db.db.prepare(sql).get(...params) as T | undefined;
  }

  /** Returns true if the request was handled. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, json: Json): Promise<boolean> {
    if (!url.pathname.startsWith("/api/v2")) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "read-only: GET only" });
      return true;
    }
    const p = url.pathname.replace(/\/+$/, "") || "/api/v2";
    const routes: Record<string, () => Promise<unknown> | unknown> = {
      "/api/v2": () => this.index(),
      "/api/v2/overview": () => this.overview(),
      "/api/v2/groups": () => this.groups(),
      "/api/v2/activity": () => this.activity(url),
      "/api/v2/topics": () => this.topics(url),
      "/api/v2/memories": () => this.memories(url),
      "/api/v2/tasks": () => this.tasks(url),
      "/api/v2/blocked": () => this.blocked(),
      "/api/v2/models": () => this.models(),
      "/api/v2/mcp": () => this.mcp(),
      "/api/v2/proactive": () => this.proactive(),
      "/api/v2/presence": () => this.presence(),
      "/api/v2/discord": () => this.discord(),
      "/api/v2/sidecars": () => this.sidecars(),
      "/api/v2/system": () => this.system(),
      "/api/v2/diagnostics": () => this.diagnostics(url),
      "/api/v2/downtime": () => this.downtime(url),
      "/api/v2/links": () => this.links(url),
      "/api/v2/reports": () => this.reports(),
      "/api/v2/owner/recent": () => this.ownerRecent(url),
      "/api/v2/owner/tasks": () => this.ownerTasks(url),
    };
    const fn = routes[p];
    if (!fn) { json(res, 404, { error: "not found", routes: Object.keys(routes) }); return true; }
    if (p.startsWith("/api/v2/owner/") && !this.authOk(req, url)) {
      json(res, 401, { error: "owner routes need ?token= or Authorization: Bearer <web.token>" });
      return true;
    }
    const body = await fn();
    json(res, 200, { generatedAt: new Date().toISOString(), ...(body as object) });
    return true;
  }

  private index() {
    return {
      version: 2, readOnly: true, timezone: this.tz,
      timestamps: "All *At fields are ISO-8601 UTC (as stored); dates (YYYY-MM-DD) are local days in `timezone`.",
      routes: [
        "/api/v2/overview", "/api/v2/groups", "/api/v2/activity?days=7&group=", "/api/v2/topics?group=&limit=20",
        "/api/v2/memories?group=", "/api/v2/tasks?limit=30", "/api/v2/blocked", "/api/v2/models", "/api/v2/mcp",
        "/api/v2/proactive", "/api/v2/presence", "/api/v2/discord", "/api/v2/sidecars", "/api/v2/system",
        "/api/v2/diagnostics?limit=20", "/api/v2/downtime?limit=20", "/api/v2/links?limit=10", "/api/v2/reports",
        "/api/v2/owner/recent?limit=20 (token)", "/api/v2/owner/tasks?limit=15 (token)",
      ],
    };
  }

  private connection() {
    const prov = this.deps.gateway.getProvider();
    const h = prov.health();
    return {
      providerId: prov.providerId, connection: h.connection, login: h.login, selfId: h.selfId ?? null,
      lastHeartbeatAt: h.lastHeartbeatAt ?? null, lastError: scrub(h.lastError), reconnectCount: h.reconnectCount,
    };
  }

  private async overview() {
    const today = localDay(this.tz);
    const msgsToday = this.one<{ n: number }>(
      "SELECT count(*) n FROM messages WHERE account_id=? AND sent_at >= ?", this.acct, dayStartIso(this.tz, today))?.n ?? 0;
    const repliesToday = this.one<{ n: number }>(
      "SELECT count(*) n FROM send_tasks WHERE kind='reply' AND status='confirmed' AND created_at >= ?", dayStartIso(this.tz, today))?.n ?? 0;
    const queue = this.one<{ n: number }>("SELECT count(*) n FROM send_tasks WHERE status IN ('queued','in_flight')")?.n ?? 0;
    const mcp = this.deps.mcp.statuses();
    const services = await this.unitStates();
    return {
      persona: this.deps.cfg.persona.name,
      uptimeMs: Date.now() - this.deps.startedAt,
      startedAt: new Date(this.deps.startedAt).toISOString(),
      timezone: this.tz,
      today,
      connection: this.connection(),
      stats: this.deps.gateway.getStats(),
      queue,
      counts: {
        messagesToday: msgsToday, botRepliesToday: repliesToday,
        groupsEnabled: this.deps.cfg.groups.allowlist.length,
        memories: this.one<{ n: number }>("SELECT count(*) n FROM memories WHERE account_id=?", this.acct)?.n ?? 0,
        topics: this.one<{ n: number }>("SELECT count(*) n FROM topics WHERE account_id=?", this.acct)?.n ?? 0,
        blockedUsers: this.deps.db.blockedUsers(this.acct).length,
      },
      model: { active: this.deps.modelSwitcher?.activeDisplayName() ?? this.deps.cfg.model.model },
      mcp: { total: mcp.length, connected: mcp.filter((m) => m.connected).length },
      services,
      features: {
        memory: this.deps.cfg.memory.enabled, reports: this.deps.cfg.reports.enabled,
        proactive: Boolean((this.deps.proactiveEngine?.status() as Row | undefined)?.enabled),
        presence: this.deps.cfg.presence?.enabled ?? false, weather: this.deps.cfg.weather?.enabled ?? false,
        tools: this.deps.cfg.tools.enabled,
      },
    };
  }

  /** Group names via OneBot get_group_list (cached 10 min). Read-only action. */
  private async groupNames(): Promise<Map<string, { name: string; memberCount: number | null }>> {
    return cached("groupNames", 10 * 60_000, async () => {
      const out = new Map<string, { name: string; memberCount: number | null }>();
      const prov = this.deps.gateway.getProvider() as unknown as { providerId: string; call?: (a: string, p: Row, t?: number) => Promise<{ retcode: number; data: unknown }> };
      if (prov.providerId !== "onebot" || typeof prov.call !== "function") return out;
      try {
        const r = await prov.call.call(prov, "get_group_list", {}, 5000);
        if (r?.retcode === 0 && Array.isArray(r.data)) {
          for (const g of r.data as Row[]) {
            out.set(String(g.group_id), { name: String(g.group_name ?? ""), memberCount: typeof g.member_count === "number" ? g.member_count : null });
          }
        }
      } catch { /* not connected / unsupported: names stay null */ }
      return out;
    });
  }

  private async groups() {
    const names = await this.groupNames();
    const todayStart = dayStartIso(this.tz, localDay(this.tz));
    const known = safeJson<string[]>(this.deps.db.kvGet("known_groups"), []);
    const allow = this.deps.cfg.groups.allowlist.map(String);
    const mentionOnly = new Set((this.deps.cfg.groups.mentionOnly ?? []).map(String));
    const ids = [...new Set([...allow, ...known])];
    const groups = ids.map((gid) => {
      const agg = this.one<{ n: number; fid: number | null; recalled: number | null; senders: number }>(
        `SELECT count(*) n, min(id) fid, sum(status='recalled') recalled, count(DISTINCT sender_id) senders
         FROM messages WHERE account_id=? AND group_id=?`, this.acct, gid);
      const first = agg?.fid != null ? this.one<{ sent_at: string }>("SELECT sent_at FROM messages WHERE id=?", agg.fid)?.sent_at : undefined;
      const lastMsg = this.one<{ sender_name: string; sent_at: string }>(
        "SELECT sender_name, sent_at FROM messages WHERE account_id=? AND group_id=? ORDER BY id DESC LIMIT 1", this.acct, gid);
      const todayN = this.one<{ n: number }>(
        "SELECT count(*) n FROM messages WHERE account_id=? AND group_id=? AND sent_at >= ?", this.acct, gid, todayStart)?.n ?? 0;
      const replies = this.one<{ n: number; today: number }>(
        "SELECT count(*) n, sum(created_at >= ?) today FROM send_tasks WHERE conversation_type='group' AND target_id=? AND kind='reply' AND status='confirmed'",
        todayStart, gid);
      const topicN = this.one<{ n: number }>("SELECT count(*) n FROM topics WHERE account_id=? AND group_id=?", this.acct, gid)?.n ?? 0;
      const memN = this.one<{ n: number }>("SELECT count(*) n FROM memories WHERE account_id=? AND group_id=?", this.acct, gid)?.n ?? 0;
      const top = this.q<{ sender_id: string; sender_name: string; n: number }>(
        `SELECT sender_id, max(sender_name) sender_name, count(*) n FROM messages WHERE account_id=? AND group_id=? AND sent_at >= ?
         GROUP BY sender_id ORDER BY n DESC LIMIT 5`, this.acct, gid, todayStart);
      const info = names.get(gid);
      return {
        groupId: gid, name: info?.name ?? null, memberCount: info?.memberCount ?? null,
        enabled: allow.includes(gid), mentionOnly: mentionOnly.has(gid),
        messagesStored: agg?.n ?? 0, messagesToday: todayN, recalled: agg?.recalled ?? 0, distinctSenders: agg?.senders ?? 0,
        firstStoredAt: toIso(first), lastMessageAt: toIso(lastMsg?.sent_at), lastSenderName: lastMsg?.sender_name ?? null,
        botReplies: replies?.n ?? 0, botRepliesToday: replies?.today ?? 0,
        topics: topicN, memories: memN,
        topSendersToday: top.map((t) => ({ userId: t.sender_id, nickname: t.sender_name, messages: t.n })),
      };
    });
    return {
      groups,
      retention: {
        rawRetentionDays: this.deps.cfg.memory.rawRetentionDays,
        rawMessagesBeforeAt: toIso(this.deps.db.kvGet("raw_messages_before")),
        note: "Raw messages are purged daily; counts only cover what is still stored.",
      },
      namesSource: names.size ? "onebot get_group_list" : "unavailable",
    };
  }

  private activity(url: URL) {
    const days = clampInt(url.searchParams.get("days"), 7, 1, 60);
    const group = url.searchParams.get("group");
    const dayList = Array.from({ length: days }, (_, i) => localDay(this.tz, -(days - 1 - i)));
    const windowStart = dayStartIso(this.tz, dayList[0]!);
    const msgRows = this.q<{ group_id: string; sent_at: string }>(
      `SELECT group_id, sent_at FROM messages WHERE account_id=? AND group_id IS NOT NULL AND sent_at >= ? ${group ? "AND group_id=?" : ""}`,
      ...(group ? [this.acct, windowStart, group] : [this.acct, windowStart]));
    const replyRows = this.q<{ target_id: string; created_at: string; kind: string }>(
      `SELECT target_id, created_at, kind FROM send_tasks WHERE status='confirmed' AND created_at >= ? ${group ? "AND target_id=?" : ""}`,
      ...(group ? [windowStart, group] : [windowStart]));
    const daySet = new Set(dayList);
    const perDay: Record<string, Record<string, { messages: number; botSends: number }>> = {};
    const today = localDay(this.tz);
    const hourly: Record<string, number[]> = {};
    for (const r of msgRows) {
      const d = dayOf(r.sent_at, this.tz);
      if (!d || !daySet.has(d)) continue;
      ((perDay[d] ??= {})[r.group_id] ??= { messages: 0, botSends: 0 }).messages++;
      if (d === today) { const h = hourOf(r.sent_at, this.tz); if (h !== null) { const arr = (hourly[r.group_id] ??= Array<number>(24).fill(0)); arr[h] = (arr[h] ?? 0) + 1; } }
    }
    for (const r of replyRows) {
      const d = dayOf(r.created_at, this.tz);
      if (!d || !daySet.has(d)) continue;
      ((perDay[d] ??= {})[r.target_id] ??= { messages: 0, botSends: 0 }).botSends++;
    }
    return {
      days: dayList.map((d) => ({ date: d, groups: perDay[d] ?? {},
        totalMessages: Object.values(perDay[d] ?? {}).reduce((a, b) => a + b.messages, 0),
        totalBotSends: Object.values(perDay[d] ?? {}).reduce((a, b) => a + b.botSends, 0) })),
      todayHourly: hourly,
      note: "messages = stored incoming messages (raw history is purged after retention); botSends = confirmed send_tasks of any kind to that target (groups and private).",
    };
  }

  private topics(url: URL) {
    const group = url.searchParams.get("group");
    const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
    const rows = this.q<Row>(
      `SELECT id, group_id, started_at, ended_at, summary, participants, message_count FROM topics WHERE account_id=?
       ${group ? "AND group_id=?" : ""} ORDER BY id DESC LIMIT ?`, ...(group ? [this.acct, group, limit] : [this.acct, limit]));
    return {
      topics: rows.map((t) => ({
        id: t.id, groupId: t.group_id, startedAt: toIso(t.started_at), endedAt: toIso(t.ended_at),
        open: !t.ended_at, messageCount: t.message_count, summary: t.summary ?? null,
        participants: safeJson<{ id: string; name: string; count: number }[]>(t.participants, [])
          .map((p) => ({ userId: p.id, nickname: p.name, messages: p.count })),
      })),
    };
  }

  private memories(url: URL) {
    const group = url.searchParams.get("group");
    const where = group ? "account_id=? AND group_id=?" : "account_id=?";
    const args = group ? [this.acct, group] : [this.acct];
    return {
      byStatus: this.q(`SELECT status, count(*) n FROM memories WHERE ${where} GROUP BY status`, ...args),
      byKind: this.q(`SELECT kind, count(*) n FROM memories WHERE ${where} GROUP BY kind`, ...args),
      byGroup: this.q("SELECT group_id groupId, count(*) n FROM memories WHERE account_id=? GROUP BY group_id", this.acct),
      recent: this.q<Row>(`SELECT id, group_id, kind, subject_name, statement, narrator_name, status, confidence, created_at, updated_at
        FROM memories WHERE ${where} ORDER BY id DESC LIMIT 30`, ...args).map((m) => ({
        id: m.id, groupId: m.group_id, kind: m.kind, subjectName: m.subject_name, statement: m.statement,
        narratorName: m.narrator_name, status: m.status, confidence: m.confidence,
        createdAt: toIso(m.created_at), updatedAt: toIso(m.updated_at) })),
      personalMemories: this.one<{ n: number }>("SELECT count(*) n FROM personal_memories WHERE account_id=?", this.acct)?.n ?? 0,
      memoryResetAt: toIso(this.deps.db.kvGet("memory_reset_at")),
    };
  }

  private tasks(url: URL) {
    const limit = clampInt(url.searchParams.get("limit"), 30, 1, 200);
    const recent = this.q<Row>(`SELECT id, kind, conversation_type, target_id, status, attempts, last_error, created_at, updated_at
      FROM send_tasks ORDER BY id DESC LIMIT ?`, limit);
    return {
      byStatus: this.q("SELECT status, count(*) n FROM send_tasks GROUP BY status"),
      byKind: this.q("SELECT kind, status, count(*) n FROM send_tasks GROUP BY kind, status ORDER BY n DESC"),
      inFlight: this.one<{ n: number }>("SELECT count(*) n FROM send_tasks WHERE status IN ('queued','in_flight')")?.n ?? 0,
      recent: recent.map((t) => ({
        id: t.id, kind: t.kind, conversationType: t.conversation_type, targetId: t.target_id,
        status: t.status, attempts: t.attempts, lastError: scrub(t.last_error), createdAt: toIso(t.created_at), updatedAt: toIso(t.updated_at),
      })),
      ownerTasks: { byState: this.q("SELECT state, count(*) n FROM owner_tasks WHERE account_id=? GROUP BY state", this.acct) },
      reminders: { byStatus: this.q("SELECT status, count(*) n FROM notion_reminders WHERE account_id=? GROUP BY status", this.acct) },
    };
  }

  private blocked() {
    return { blocked: this.deps.db.blockedUsers(this.acct).map((b) => ({ userId: b.user_id, reason: b.reason, createdAt: toIso(b.created_at) })) };
  }

  private models() {
    const sw = this.deps.modelSwitcher;
    const profiles = this.deps.cfg.model.profiles ?? [];
    const activeName = sw?.activeName() ?? null;
    const providers = new Map<string, Row[]>();
    for (const p of profiles) {
      const svc = serviceNameOf(p);
      const list = providers.get(svc) ?? [];
      list.push({ profile: p.name, model: p.model, displayName: p.displayName ?? null, backend: p.provider,
        host: hostOf(p.baseUrl), keyConfigured: p.provider === "mock" || Boolean(p.apiKey), active: p.name === activeName });
      providers.set(svc, list);
    }
    for (const s of this.deps.cfg.model.providers ?? []) if (!providers.has(s.name)) providers.set(s.name, []);
    const catalogs = this.q<{ key: string; value: string }>("SELECT key, value FROM kv WHERE key LIKE 'model_catalog:%'").map((r) => {
      const v = safeJson<{ fetchedAt?: string; modelIds?: string[] }>(r.value, {});
      return { provider: r.key.slice("model_catalog:".length), fetchedAt: toIso(v.fetchedAt), modelCount: v.modelIds?.length ?? 0, modelIds: v.modelIds ?? [] };
    });
    return {
      switchingEnabled: Boolean(sw), readOnly: true,
      active: { profile: activeName, display: sw?.activeDisplayName() ?? this.deps.cfg.model.model,
        persisted: this.deps.db.kvGet("active_model_profile") ?? null },
      default: { model: this.deps.cfg.model.model, host: hostOf(this.deps.cfg.model.baseUrl) },
      imageReader: this.deps.cfg.model.imageReader ?? null,
      providers: [...providers.entries()].map(([name, models]) => ({ name, modelCount: models.length, active: models.some((m) => m.active), models })),
      catalogs,
    };
  }

  private mcp() {
    const s = this.deps.mcp.statuses();
    return { total: s.length, connected: s.filter((x) => x.connected).length,
      servers: s.map((x) => ({ name: x.name, transport: x.transport, connected: x.connected, tools: x.tools, serverInfo: x.serverInfo ?? null, error: scrub(x.error) })) };
  }

  private proactive() {
    const st = (this.deps.proactiveEngine?.status() ?? { enabled: false }) as Row;
    return { proactive: { ...st, recipientId: st.recipientId ? "owner" : null } };
  }

  private presence() {
    const cfg = this.deps.cfg.presence;
    const rt = this.deps.presence?.status?.() as unknown as Row | undefined;
    return { presence: {
      enabled: cfg?.enabled ?? false, source: cfg?.source ?? "phone_presence_state",
      provider: cfg?.source === "device_events" ? "EventTap" : "MacroDroid",
      allowedGroupCount: cfg?.allowedGroupIds?.length ?? 0,
      runtime: rt ? { configured: rt.configured, supportedFields: rt.supportedFields, lastFetch: rt.lastFetch,
        cacheExpiresAt: rt.cacheExpiresAt, currentFieldCount: rt.currentFieldCount, currentFreshFieldCount: rt.currentFreshFieldCount } : null,
      note: "Field values (battery, location, apps) are not exposed; only fetch health and counts.",
    } };
  }

  private async discord() {
    const unit = (await this.unitStates()).find((u) => u.unit === DISCORD_UNIT) ?? null;
    let db: Row = { available: false };
    const file = path.resolve(process.cwd(), DISCORD_DB);
    if (fs.existsSync(file)) {
      let d: DatabaseSync | null = null;
      try {
        d = new DatabaseSync(file, { readOnly: true });
        const g = (sql: string) => d!.prepare(sql).get() as Row;
        const today = localDay(this.tz);
        db = {
          available: true,
          messagesStored: g("SELECT count(*) n FROM messages").n,
          messagesToday: (d.prepare("SELECT count(*) n FROM messages WHERE sent_at >= ?").get(dayStartIso(this.tz, today)) as Row).n,
          channels: (d.prepare(`SELECT conversation_id, group_id, count(*) n, max(id) lid FROM messages GROUP BY conversation_id ORDER BY lid DESC`).all() as Row[])
            .map((c) => ({ conversationId: c.conversation_id, channelId: c.group_id, messages: c.n,
              lastMessageAt: toIso((d!.prepare("SELECT sent_at FROM messages WHERE id=?").get(c.lid as number) as Row)?.sent_at) })),
          sendTasks: d.prepare("SELECT kind, status, count(*) n FROM send_tasks GROUP BY kind, status").all(),
          lastSendAt: toIso((g("SELECT created_at FROM send_tasks ORDER BY id DESC LIMIT 1") ?? {}).created_at),
          topics: g("SELECT count(*) n FROM topics").n,
          memories: g("SELECT count(*) n FROM memories").n,
          activeModelProfile: (d.prepare("SELECT value FROM kv WHERE key='active_model_profile'").get() as Row | undefined)?.value ?? null,
        };
      } catch (e) { db = { available: false, error: scrub((e as Error).message) }; }
      finally { try { d?.close(); } catch { /* ignore */ } }
    }
    const statusFile = path.resolve(process.cwd(), "data/discord/status.txt");
    let idleStatus: string | null = null;
    try { idleStatus = fs.readFileSync(statusFile, "utf8").trim() || null; } catch { /* default */ }
    const journal = await cached("discordJournal", 30_000, () => this.discordJournal());
    return { discord: { service: unit, database: db, idleStatusText: idleStatus, ...journal,
      note: "Discord runs in a separate process with its web panel disabled; live voice/music state is only inferred from its journal (best effort)." } };
  }

  private async discordJournal(): Promise<Row> {
    const r = await run("journalctl", ["-u", DISCORD_UNIT, "-n", "3000", "-o", "json", "--no-pager", "--output-fields=MESSAGE"], 6000);
    if (!r.ok && !r.stdout) return { journal: "unavailable" };
    let login: Row | null = null;
    const servers = new Map<string, Row>();
    let music: Row | null = null, player: Row | null = null, call: Row | null = null;
    let warnings = 0, lastWarnAt: string | null = null, lastActivityAt: string | null = null;
    for (const line of r.stdout.split("\n")) {
      if (!line) continue;
      const e = safeJson<{ MESSAGE?: unknown; __REALTIME_TIMESTAMP?: string }>(line, {});
      const msg = typeof e.MESSAGE === "string" ? e.MESSAGE : Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE as number[]).toString("utf8") : "";
      const at = e.__REALTIME_TIMESTAMP ? new Date(Number(e.__REALTIME_TIMESTAMP) / 1000).toISOString() : null;
      let m: RegExpExecArray | null;
      if ((m = /\[discord\] Discord 已登录: (.+?) \((\d+)\)，所在服务器 (\d+) 个/.exec(msg))) {
        login = { tag: m[1], userId: m[2], serverCount: Number(m[3]), at }; servers.clear();
      } else if ((m = /\[discord\] 服务器 (.+?) \((\d+)\) 文字频道: (.*)$/.exec(msg))) {
        servers.set(m[2]!, { serverId: m[2], name: m[1], textChannels: m[3]!.split(/,\s*/).filter(Boolean).map((c) => {
          const [name, id] = c.split("="); return { name: name ?? c, channelId: id ?? null }; }) });
      } else if ((m = /\[discord\] 加入服务器 (.+?) \((\d+)\)/.exec(msg))) {
        if (!servers.has(m[2]!)) servers.set(m[2]!, { serverId: m[2], name: m[1], textChannels: [] });
      } else if ((m = /\] 播放 (.+?) - (.*)$/.exec(msg)) && !/播放器|播放出错|播放卡片/.test(msg)) {
        music = { title: m[1], artists: m[2], startedAt: at };
      } else if ((m = /\] 播放器 (\w+) -> (\w+)/.exec(msg))) {
        player = { from: m[1], to: m[2], at };
      } else if ((m = /\] 通话开始 @ (.+)$/.exec(msg))) {
        call = { active: true, channel: m[1], startedAt: at, endedAt: null };
      } else if ((m = /\] 通话结束 \((.+?)\)/.exec(msg))) {
        call = { ...(call ?? {}), active: false, endReason: m[1], endedAt: at };
      }
      if (/\[WARN\]|\[ERROR\]/.test(msg)) { warnings++; lastWarnAt = at; }
      if (/\[(discord|music|call|voice|agent|reply)\]/.test(msg)) lastActivityAt = at;
    }
    const playing = player ? ["playing", "buffering"].includes(String(player.to)) : false;
    return {
      login, servers: [...servers.values()],
      music: music ? { lastTrack: music, playerState: player?.to ?? null, playerStateAt: player?.at ?? null, likelyPlaying: playing } : null,
      voiceCall: call,
      journalWindow: { lines: 3000, warnings, lastWarnAt, lastActivityAt },
    };
  }

  private async sidecars() {
    return cached("sidecars", 15_000, async () => {
      const probes = await Promise.all(SIDECARS.map(async (s) => ({ name: s.name, url: s.url, ...(await probe(s.url, s.okCodes)) })));
      const d = await run("docker", ["ps", "-a", "--format", "{{json .}}"], 5000);
      const containers = d.stdout.split("\n").filter(Boolean).map((l) => safeJson<Row>(l, {})).map((c) => ({
        name: c.Names, image: c.Image, state: c.State, status: c.Status,
        health: /\((healthy|unhealthy|health: starting)\)/.exec(String(c.Status ?? ""))?.[1] ?? null,
      }));
      const quotaFile = path.resolve(process.cwd(), "data/research-quota.json");
      let researchQuota: unknown = null;
      try { researchQuota = JSON.parse(fs.readFileSync(quotaFile, "utf8")); } catch { /* none */ }
      return { probes, containers, dockerAvailable: d.ok,
        search: { provider: this.deps.cfg.tools.search?.provider ?? null }, researchQuotaUsage: researchQuota };
    });
  }

  private async unitStates(): Promise<{ unit: string; active: string; sub: string | null; since: string | null; restarts: number | null }[]> {
    return cached("units", 15_000, async () => {
      const r = await run("systemctl", ["show", ...UNITS.map((u) => `${u}.service`), "-p", "Id,ActiveState,SubState,ActiveEnterTimestamp,NRestarts", "--timestamp=utc"], 4000);
      const blocks = r.stdout.trim().split(/\n\s*\n/);
      return blocks.filter(Boolean).map((b) => {
        const kv = Object.fromEntries(b.split("\n").map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
        const since = kv.ActiveEnterTimestamp ? toIsoUtc(kv.ActiveEnterTimestamp) : null;
        return { unit: String(kv.Id ?? "").replace(/\.service$/, ""), active: kv.ActiveState ?? "unknown", sub: kv.SubState ?? null,
          since, restarts: kv.NRestarts ? Number(kv.NRestarts) : null };
      });
    });
  }

  private async system() {
    const services = await this.unitStates();
    let disk: Row | null = null;
    try {
      const s = fs.statfsSync("/");
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      disk = { mount: "/", totalBytes: total, freeBytes: free, usedPct: total ? Math.round((1 - free / total) * 1000) / 10 : null };
    } catch { /* ignore */ }
    let memAvailable: number | null = null;
    try { const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync("/proc/meminfo", "utf8")); if (m) memAvailable = Number(m[1]) * 1024; } catch { /* ignore */ }
    const mu = process.memoryUsage();
    let dbBytes: number | null = null;
    try { dbBytes = fs.statSync(path.resolve(process.cwd(), this.deps.cfg.database.path)).size; } catch { /* ignore */ }
    return {
      host: { hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, uptimeSec: Math.round(os.uptime()),
        cpus: os.cpus().length, loadAvg: os.loadavg().map((x) => Math.round(x * 100) / 100),
        memory: { totalBytes: os.totalmem(), freeBytes: os.freemem(), availableBytes: memAvailable }, disk },
      process: { pid: process.pid, node: process.version, rssBytes: mu.rss, heapUsedBytes: mu.heapUsed, uptimeSec: Math.round(process.uptime()), dbBytes },
      services,
    };
  }

  private diagnostics(url: URL) {
    const d = this.deps.diagnostics as unknown as { snapshot?: (r: Row) => unknown } | null | undefined;
    if (!d || typeof d.snapshot !== "function") return { diagnostics: null, available: false };
    const limit = clampInt(url.searchParams.get("limit"), 20, 1, 20);
    return { available: true, diagnostics: d.snapshot({ scope: "global", accountId: this.acct, conversationId: "", limit }) };
  }

  private downtime(url: URL) {
    const limit = clampInt(url.searchParams.get("limit"), 20, 1, 200);
    const rows = this.q<Row>("SELECT id, started_at, ended_at, reason FROM downtime WHERE account_id=? ORDER BY id DESC LIMIT ?", this.acct, limit);
    return { total: this.one<{ n: number }>("SELECT count(*) n FROM downtime WHERE account_id=?", this.acct)?.n ?? 0,
      downtime: rows.map((r) => { const s = toIso(r.started_at), e = toIso(r.ended_at);
        return { id: r.id, startedAt: s, endedAt: e, durationSec: s && e ? Math.round((Date.parse(e) - Date.parse(s)) / 1000) : null, reason: scrub(r.reason) }; }) };
  }

  private links(url: URL) {
    const limit = clampInt(url.searchParams.get("limit"), 10, 1, 50);
    return {
      byStatus: this.q("SELECT status, count(*) n FROM link_reads WHERE account_id=? GROUP BY status", this.acct),
      recent: this.q<Row>(`SELECT id, group_id, url, final_url, title, status, shared_by_name, created_at FROM link_reads
        WHERE account_id=? ORDER BY id DESC LIMIT ?`, this.acct, limit).map((l) => ({
        id: l.id, groupId: l.group_id, host: hostOf(String(l.final_url ?? l.url)), title: l.title ?? null, status: l.status,
        sharedBy: l.shared_by_name ?? null, createdAt: toIso(l.created_at) })),
    };
  }

  private reports() {
    return {
      enabled: this.deps.cfg.reports.enabled, schedule: this.deps.cfg.reports.schedule,
      reports: this.q<Row>("SELECT report_key, group_id, report_date, period, status, message_count, created_at FROM reports ORDER BY created_at DESC LIMIT 20")
        .map((r) => ({ key: r.report_key, groupId: r.group_id, date: r.report_date, period: r.period, status: r.status, messageCount: r.message_count, createdAt: toIso(r.created_at),
          deliveries: this.q("SELECT id, status, attempts FROM deliveries WHERE report_key=?", String(r.report_key)) })),
    };
  }

  /** Owner's OWN recent group messages, text truncated. Token-gated. */
  private ownerRecent(url: URL) {
    const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
    const rows = this.q<Row>(`SELECT id, group_id, sender_name, sent_at, text_content, status FROM messages
      WHERE account_id=? AND sender_id=? ORDER BY id DESC LIMIT ?`, this.acct, this.ownerId, limit);
    return { ownerId: this.ownerId, messages: rows.map((m) => ({ id: m.id, groupId: m.group_id, nickname: m.sender_name, sentAt: toIso(m.sent_at),
      recalled: m.status === "recalled", preview: m.status === "recalled" ? null : String(m.text_content ?? "").slice(0, 120) })) };
  }

  /** Owner task queue (requests are the owner's own). Token-gated. */
  private ownerTasks(url: URL) {
    const limit = clampInt(url.searchParams.get("limit"), 15, 1, 100);
    const rows = this.q<Row>(`SELECT id, requester_id, request, state, stage, successful_steps, failed_steps, created_at, updated_at
      FROM owner_tasks WHERE account_id=? ORDER BY id DESC LIMIT ?`, this.acct, limit);
    const reminders = this.q<Row>(`SELECT entry_id, requester_id, title, due_at, status, recurrence FROM notion_reminders
      WHERE account_id=? ORDER BY due_at DESC LIMIT 20`, this.acct);
    const isOwner = (id: unknown) => String(id) === this.ownerId;
    return {
      tasks: rows.map((t) => ({ id: t.id, state: t.state, stage: t.stage, okSteps: t.successful_steps, failedSteps: t.failed_steps,
        request: isOwner(t.requester_id) ? String(t.request ?? "").slice(0, 160) : null,
        createdAt: toIso(t.created_at), updatedAt: toIso(t.updated_at),
        steps: this.q("SELECT tool, state, count(*) n FROM owner_task_steps WHERE task_id=? GROUP BY tool, state", t.id as number) })),
      reminders: reminders.map((r) => ({ id: r.entry_id, title: isOwner(r.requester_id) ? r.title : null, dueAt: toIso(r.due_at) ?? r.due_at,
        status: r.status, recurrence: r.recurrence ?? null })),
    };
  }
}

function toIsoUtc(s: string): string | null {
  // systemctl --timestamp=utc: "Wed 2026-10-28 09:11:16 UTC"
  const m = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC/.exec(s);
  if (!m) return null;
  return new Date(`${m[1]}T${m[2]}Z`).toISOString();
}
