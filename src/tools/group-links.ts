import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import type { Database } from "../db/index.js";
import type { MessageRecord, ToolDef } from "../types.js";
import { logger } from "../util/logger.js";

const log = logger("group-links");
const LINKS_DB = process.env.GROUP_LINKS_DB || "/opt/group-links/links.db";
// 2026-11-22 主人要求：私聊查群里发过的链接（卡网/中转站/干什么的），自己决定收不收进工具箱。账本由 group-links.service 写。
/** 群号 → 别名，环境变量 GROUP_LINK_ALIASES（JSON，如 {"40001":["测试群","测试"]}）。 */
const GROUP_ALIASES: Record<string, string[]> = (() => {
  try { return JSON.parse(process.env.GROUP_LINK_ALIASES || "{}"); } catch { return {}; }
})();
const KINDS = ["卡网", "中转站", "AI工具", "开源项目", "教程文章", "优惠活动", "资源下载", "社交帖子", "视频", "其他"];

function resolveGroup(q: unknown): string | undefined {
  const s = typeof q === "string" ? q.trim() : "";
  if (!s) return undefined;
  if (/^\d{5,}$/.test(s)) return s;
  for (const [id, names] of Object.entries(GROUP_ALIASES)) if (names.some(n => s.includes(n) || n.includes(s))) return id;
  return "__none__";
}

function local(iso: string): string {
  const t = new Date(iso);
  if (isNaN(t.getTime())) return iso;
  const d = new Date(t.getTime() + 8 * 3600_000).toISOString();
  return `${d.slice(5, 10)} ${d.slice(11, 16)}`;
}

export class GroupLinkTools {
  constructor(private deps: { db: Database; ownerIds: string[] }) {}

  private open(): DatabaseSync | null {
    if (!fs.existsSync(LINKS_DB)) return null;
    return new DatabaseSync(LINKS_DB, { readOnly: true });
  }

  toolsFor(m: MessageRecord): ToolDef[] {
    if (m.groupId || !this.deps.ownerIds.includes(m.senderId)) return []; // 只在主人私聊里用
    return [
      {
        name: "group_links",
        description: "查群链接账本（仅主人私聊）：群里有人发过的每个链接都长期记着，带发链接的人、时间、类型（" + KINDS.join("/") + "）、一句话用途。" +
          "主人问「某群发了什么链接」「有没有新的中转站/卡网」「谁发过 xx」时用。group 可写群名关键词（见 GROUP_LINK_ALIASES）或群号；keyword 匹配网址、标题、用途、原消息、发送人。" +
          "回她时按条列：编号、时间、谁发的、类型、用途、链接；不要省略链接。她说「收第N条」「把#N放工具箱」时，用 toolbox_save 存那条链接，note 写用途和来源群。",
        inputSchema: { type: "object", properties: {
          group: { type: "string", maxLength: 40 },
          keyword: { type: "string", maxLength: 60 },
          kind: { type: "string", enum: KINDS },
          days: { type: "integer", minimum: 1, maximum: 365 },
          limit: { type: "integer", minimum: 1, maximum: 40 },
        }, additionalProperties: false },
        execute: async (args) => JSON.stringify(this.search(args)),
      },
      {
        name: "group_link_detail",
        description: "看群链接账本里某一条的完整信息（仅主人私聊）：原消息全文、发之前群里在聊什么。参数 id 是 group_links 返回的编号。",
        inputSchema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
        execute: async (args) => JSON.stringify(this.detail(Number(args.id))),
      },
      {
        name: "group_chat_search",
        description: "按关键词搜群聊原始消息（仅主人私聊）。原始消息只保留最近一天左右（每天凌晨清理），更早的链接请用 group_links。",
        inputSchema: { type: "object", properties: {
          keyword: { type: "string", minLength: 1, maxLength: 60 },
          group: { type: "string", maxLength: 40 },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        }, required: ["keyword"], additionalProperties: false },
        execute: async (args) => JSON.stringify(this.chat(args)),
      },
    ];
  }

  private search(a: Record<string, unknown>): object {
    const db = this.open();
    if (!db) return { ok: false, reason: "链接账本还没建好" };
    try {
      const gid = resolveGroup(a.group);
      if (gid === "__none__") return { ok: false, reason: `认不出群「${a.group}」`, groups: GROUP_ALIASES };
      const days = Math.min(365, Math.max(1, Number(a.days ?? 7) || 7));
      const limit = Math.min(40, Math.max(1, Number(a.limit ?? 15) || 15));
      const where = ["sent_at >= ?"]; const params: (string | number)[] = [new Date(Date.now() - days * 86400_000).toISOString()];
      if (gid) { where.push("group_id = ?"); params.push(gid); }
      if (typeof a.kind === "string" && a.kind) { where.push("kind = ?"); params.push(a.kind); }
      const kw = typeof a.keyword === "string" ? a.keyword.trim() : "";
      if (kw) {
        where.push("(url LIKE ? OR IFNULL(title,'') LIKE ? OR IFNULL(purpose,'') LIKE ? OR IFNULL(msg_text,'') LIKE ? OR IFNULL(sender_name,'') LIKE ? OR IFNULL(tags,'') LIKE ?)");
        for (let i = 0; i < 6; i++) params.push(`%${kw}%`);
      }
      const rows = db.prepare(`SELECT id, group_name, url, sender_name, sent_at, kind, purpose, title, status, msg_text
        FROM links WHERE ${where.join(" AND ")} ORDER BY sent_at DESC LIMIT ${limit}`).all(...params) as Record<string, string | number>[];
      const total = (db.prepare(`SELECT COUNT(*) n FROM links WHERE ${where.join(" AND ")}`).get(...params) as { n: number }).n;
      return { ok: true, total, shown: rows.length, days, rows: rows.map(r => ({
        id: r.id, 群: r.group_name, 时间: local(String(r.sent_at)), 谁发的: r.sender_name, 类型: r.kind ?? (r.status === "new" ? "还在识别" : "未识别"),
        用途: r.purpose ?? "", 标题: r.title ?? "", 链接: r.url, 原话: String(r.msg_text ?? "").slice(0, 80) })) };
    } catch (e) {
      log.warn("查询失败", { error: (e as Error).message });
      return { ok: false, reason: (e as Error).message };
    } finally { db.close(); }
  }

  private detail(id: number): object {
    const db = this.open();
    if (!db) return { ok: false, reason: "链接账本还没建好" };
    try {
      const r = db.prepare("SELECT * FROM links WHERE id = ?").get(id) as any;
      if (!r) return { ok: false, reason: `没有 #${id}` };
      const same = db.prepare("SELECT COUNT(*) n FROM links WHERE url = ?").get(r.url) as { n: number };
      return { ok: true, id, 群: r.group_name, 时间: local(r.sent_at), 谁发的: r.sender_name, 类型: r.kind, 用途: r.purpose, 标签: r.tags,
        标题: r.title, 链接: r.url, 原消息: r.msg_text, 之前在聊: r.context, 被发过几次: same.n, 抓取问题: r.error ?? undefined };
    } finally { db.close(); }
  }

  private chat(a: Record<string, unknown>): object {
    const gid = resolveGroup(a.group);
    if (gid === "__none__") return { ok: false, reason: `认不出群「${a.group}」` };
    const kw = String(a.keyword ?? "").trim();
    const limit = Math.min(50, Math.max(1, Number(a.limit ?? 20) || 20));
    const params: string[] = [`%${kw}%`];
    let sql = "SELECT group_id, sender_name, sent_at, text_content FROM messages WHERE group_id IS NOT NULL AND status='active' AND text_content LIKE ?";
    if (gid) { sql += " AND group_id = ?"; params.push(gid); }
    sql += ` ORDER BY sent_at DESC LIMIT ${limit}`;
    const rows = this.deps.db.db.prepare(sql).all(...params) as any[];
    const oldest = this.deps.db.db.prepare("SELECT MIN(sent_at) t FROM messages WHERE group_id IS NOT NULL").get() as { t: string | null };
    return { ok: true, 记录从: oldest.t ? local(oldest.t) : "无", rows: rows.map((r: any) => ({ 群: r.group_id, 时间: local(r.sent_at), 谁: r.sender_name, 内容: r.text_content.slice(0, 200) })) };
  }
}
