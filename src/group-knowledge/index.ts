import type { Database, DBRow_Message } from "../db/index.js";
import type { MessageRecord, MessageSegment } from "../types.js";
import { canonicalUrl } from "../tools/research.js";
import { normalizeSearchUrl } from "../tools/search-providers.js";
import { stableHash } from "../util/misc.js";
import { groupSearchMatch } from "./tokens.js";

export interface GroupSearchHit {
  messageId: string;
  senderId: string;
  senderName: string;
  sentAt: string;
  excerpt: string;
}

export interface LinkDuplicateNotice {
  accountId: string;
  groupId: string;
  fingerprint: string;
  url: string;
  previousMessageId: string;
  previousSenderName: string;
  previousSentAt: string;
  currentMessageId: string;
  text: string;
  segments: MessageSegment[];
  taskKey: string;
}

interface LinkShare {
  message_row_id: number;
  url: string;
  fingerprint: string;
  message_id: string;
  sender_name: string;
  sent_at: string;
}

export interface GroupKnowledgeOptions { duplicateCooldownMs?: number; now?: () => number }

/** URL identity reuses research cleaning and result filtering, with query order ignored. No network requests. */
export function groupLinkIdentity(value: string): { url: string; fingerprint: string } | null {
  try {
    const cleaned = normalizeSearchUrl(canonicalUrl(value));
    if (!cleaned) return null;
    const url = new URL(cleaned);
    url.searchParams.sort();
    const canonical = url.toString();
    return { url: canonical, fingerprint: stableHash(canonical) };
  } catch { return null; }
}

export function extractGroupLinks(text: string, segments: readonly MessageSegment[] = []): string[] {
  const values = [...text.slice(0, 64_000).matchAll(/https?:\/\/[^\s<>"'，。；：！？、（）【】「」\]]+/gi)]
    .map(match => match[0].replace(/[.,;:!?。，；：！？]+$/u, ""));
  for (const segment of segments) if (segment && segment.type === "share" && typeof segment.data?.url === "string") values.push(segment.data.url);
  const found = new Map<string, string>();
  for (let value of values) {
    // A prose wrapper ')' is punctuation, while balanced URL parentheses (for
    // example Wikipedia article names) remain part of the address.
    while (value.endsWith(")") && (value.match(/\)/g)?.length ?? 0) > (value.match(/\(/g)?.length ?? 0)) value = value.slice(0, -1);
    if (value.length > 4096) continue;
    const identity = groupLinkIdentity(value);
    if (identity) found.set(identity.fingerprint, identity.url);
    if (found.size >= 20) break;
  }
  return [...found.values()];
}

function plain(value: string, limit: number): string {
  return value.replace(/\[CQ:[^\]]*\]/giu, "").replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ").trim().slice(0, limit);
}

/** The first extracted sentence only; never generates a conclusion that was not read. */
export function firstReadSentence(summary: string, title = ""): string {
  const heading = (value: string) => plain(value, 1200).replace(/^#{1,6}\s*/u, "").replace(/^[*_*]+|[*_*]+$/gu, "").normalize("NFKC").toLocaleLowerCase("en-US");
  const expectedTitle = heading(title);
  let raw = summary.slice(0, 16_000);
  if (expectedTitle && !/[\r\n]/u.test(raw)) {
    const flattened = plain(raw, 1200).replace(/^#{1,6}\s*/u, "");
    const originalTitle = plain(title, 1200).replace(/^#{1,6}\s*/u, "");
    if (flattened.toLocaleLowerCase("en-US") === originalTitle.toLocaleLowerCase("en-US")) return "";
    if (flattened.toLocaleLowerCase("en-US").startsWith(originalTitle.toLocaleLowerCase("en-US") + " ")) raw = flattened.slice(originalTitle.length).trim();
  }
  const lines = raw.split(/\r?\n/u).map(line => plain(line, 1200));
  while (lines.length) {
    const line = lines[0]!;
    if (!line || /^#{1,6}(?:\s|$)/u.test(line) || /^(?:标题|title|来源|source|url)\s*[:：]/iu.test(line)
      || (expectedTitle && heading(line) === expectedTitle)) { lines.shift(); continue; }
    if (lines.length > 1 && /^(?:={2,}|-{2,})$/u.test(lines[1]!)) { lines.splice(0, 2); continue; }
    break;
  }
  let text = plain(lines.join(" "), 1200).replace(/^[*•>-]\s*/u, "");
  if (!text || /^#{1,6}(?:\s|$)/u.test(text)) return "";
  const sentence = text.match(/^.*?[。！？!?](?:[”’"']|$|\s)?/u)?.[0]
    ?? text.match(/^.*?\.(?=\s|$)/u)?.[0] ?? text;
  return sentence.slice(0, 180).trim();
}

function excerpt(text: string, query: string): string {
  const cleaned = plain(text, 64_000);
  const terms = query.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_]+/gu) ?? [];
  const searchable = cleaned.normalize("NFKC").toLocaleLowerCase("en-US");
  let position = terms.map(term => searchable.indexOf(term)).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  position = Math.max(0, position - 45);
  return `${position ? "…" : ""}${cleaned.slice(position, position + 220)}${cleaned.length > position + 220 ? "…" : ""}`;
}

/** Group-only archive search and URL observations. It never reads a URL or sends a message. */
export class GroupKnowledge {
  private readonly cooldown: number;
  private readonly now: () => number;
  constructor(private readonly storage: Database, options: GroupKnowledgeOptions = {}) {
    this.cooldown = options.duplicateCooldownMs ?? 7 * 86400_000;
    this.now = options.now ?? Date.now;
    this.install();
  }

  private install(): void {
    const db = this.storage.db;
    // Upgrade installed triggers as well as fresh databases: notice hashes are
    // durable once-only tombstones, independent of raw-message retention.
    if (this.storage.kvGet("group_knowledge_trigger_version") !== "2") {
      db.exec("DROP TRIGGER IF EXISTS group_knowledge_message_delete; DROP TRIGGER IF EXISTS group_knowledge_message_update");
    }
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS group_message_fts USING fts5(tokens, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS group_link_shares (
        account_id TEXT NOT NULL, group_id TEXT NOT NULL, fingerprint TEXT NOT NULL, url TEXT NOT NULL,
        message_row_id INTEGER NOT NULL, PRIMARY KEY(account_id,group_id,fingerprint,message_row_id));
      CREATE INDEX IF NOT EXISTS idx_group_link_shares_source ON group_link_shares(message_row_id);
      CREATE TABLE IF NOT EXISTS group_link_notices (
        account_id TEXT NOT NULL, group_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        source_row_id INTEGER NOT NULL, duplicate_row_id INTEGER NOT NULL, reminded_at TEXT NOT NULL,
        PRIMARY KEY(account_id,group_id,fingerprint));
      CREATE TRIGGER IF NOT EXISTS group_knowledge_message_insert AFTER INSERT ON messages
        WHEN new.group_id IS NOT NULL AND new.status='active'
        AND NOT EXISTS(SELECT 1 FROM blocked_users b WHERE b.account_id=new.account_id AND b.user_id=new.sender_id)
        BEGIN INSERT INTO group_message_fts(rowid,tokens) VALUES(new.id,group_search_tokens(new.text_content)); END;
      CREATE TRIGGER IF NOT EXISTS group_knowledge_message_delete AFTER DELETE ON messages BEGIN
        DELETE FROM group_message_fts WHERE rowid=old.id;
        DELETE FROM group_link_shares WHERE message_row_id=old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS group_knowledge_message_update AFTER UPDATE ON messages BEGIN
        DELETE FROM group_message_fts WHERE rowid=old.id;
        INSERT INTO group_message_fts(rowid,tokens) SELECT new.id,group_search_tokens(new.text_content)
          WHERE new.group_id IS NOT NULL AND new.status='active'
          AND NOT EXISTS(SELECT 1 FROM blocked_users b WHERE b.account_id=new.account_id AND b.user_id=new.sender_id);
        DELETE FROM group_link_shares WHERE message_row_id=old.id AND (new.status!='active'
          OR old.text_content!=new.text_content OR old.segments!=new.segments OR old.account_id!=new.account_id OR old.group_id IS NOT new.group_id);
      END;`);
    this.storage.kvSet("group_knowledge_trigger_version", "2");
    if (this.storage.kvGet("group_knowledge_index_version") !== "1") {
      db.exec("SAVEPOINT group_knowledge_backfill");
      try {
        db.exec(`DELETE FROM group_message_fts;
          INSERT INTO group_message_fts(rowid,tokens) SELECT m.id,group_search_tokens(m.text_content) FROM messages m
          WHERE m.group_id IS NOT NULL AND m.status='active'
          AND NOT EXISTS(SELECT 1 FROM blocked_users b WHERE b.account_id=m.account_id AND b.user_id=m.sender_id);`);
        let after = 0;
        for (;;) {
          const rows = db.prepare(`SELECT * FROM messages m WHERE m.id>? AND m.group_id IS NOT NULL AND m.status='active'
            AND NOT EXISTS(SELECT 1 FROM blocked_users b WHERE b.account_id=m.account_id AND b.user_id=m.sender_id)
            ORDER BY m.id LIMIT 500`).all(after) as unknown as DBRow_Message[];
          if (!rows.length) break;
          for (const row of rows) { this.recordLinks(row); after = row.id; }
        }
        this.storage.kvSet("group_knowledge_index_version", "1");
        db.exec("RELEASE group_knowledge_backfill");
      } catch (error) { db.exec("ROLLBACK TO group_knowledge_backfill; RELEASE group_knowledge_backfill"); throw error; }
    }
  }

  search(accountId: string, groupId: string, query: string, limit = 5): GroupSearchHit[] {
    const match = groupSearchMatch(query);
    if (!match || !accountId || !groupId) return [];
    const count = Number.isFinite(limit) ? Math.max(1, Math.min(10, Math.floor(limit))) : 5;
    const terms = [...query.trim().normalize("NFKC")].slice(0, 120).join("").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_]+/gu) ?? [];
    const rows = this.storage.db.prepare(`SELECT m.* FROM group_message_fts f JOIN messages m ON m.id=f.rowid
      WHERE group_message_fts MATCH ? AND m.account_id=? AND m.group_id=? AND m.status='active'
      AND NOT EXISTS(SELECT 1 FROM blocked_users b WHERE b.account_id=m.account_id AND b.user_id=m.sender_id)
      AND m.text_content NOT LIKE '/搜 %' AND m.text_content NOT LIKE '/搜　%'
      ORDER BY bm25(group_message_fts), m.sent_at DESC, m.id DESC LIMIT ?`)
      .all(match, accountId, groupId, Math.max(100, count * 20)) as unknown as DBRow_Message[];
    // N-grams narrow the candidates, but their order is not evidence of a
    // contiguous Chinese phrase. Check the original normalized text as well.
    return rows.filter(row => { const text = row.text_content.normalize("NFKC").toLocaleLowerCase("en-US"); return terms.every(term => text.includes(term)); }).slice(0, count).map(row => ({ messageId: row.message_id, senderId: row.sender_id,
      senderName: plain(row.sender_name, 60), sentAt: row.sent_at, excerpt: excerpt(row.text_content, query) }));
  }

  private message(accountId: string, groupId: string, messageId: string): DBRow_Message | undefined {
    return this.storage.db.prepare(`SELECT * FROM messages m WHERE account_id=? AND group_id=? AND message_id=? AND status='active'
      AND NOT EXISTS(SELECT 1 FROM blocked_users b WHERE b.account_id=m.account_id AND b.user_id=m.sender_id)`).get(accountId, groupId, messageId) as DBRow_Message | undefined;
  }

  private recordLinks(row: DBRow_Message): string[] {
    let segments: MessageSegment[] = [];
    try { const parsed: unknown = JSON.parse(row.segments); if (Array.isArray(parsed)) segments = parsed as MessageSegment[]; } catch { /* Text links remain usable. */ }
    const urls = extractGroupLinks(row.text_content, segments);
    const insert = this.storage.db.prepare(`INSERT OR IGNORE INTO group_link_shares(account_id,group_id,fingerprint,url,message_row_id) VALUES(?,?,?,?,?)`);
    for (const url of urls) insert.run(row.account_id, row.group_id!, stableHash(url), url, row.id);
    return urls;
  }

  /** Observe all group links; only live messages can prepare a reminder. Calling this does not consume the once-only notice. */
  prepareDuplicates(message: MessageRecord): LinkDuplicateNotice[] {
    if (!message.groupId || message.status !== "active") return [];
    const row = this.message(message.accountId, message.groupId, message.messageId);
    if (!row) return [];
    const urls = this.recordLinks(row);
    if (message.origin !== "live" || row.origin !== "live" || urls.length > 3) return [];
    const notices: LinkDuplicateNotice[] = [];
    for (const url of urls) {
      const fingerprint = stableHash(url);
      if (this.storage.db.prepare("SELECT 1 FROM group_link_notices WHERE account_id=? AND group_id=? AND fingerprint=?")
        .get(message.accountId, message.groupId, fingerprint)) continue;
      const previous = this.storage.db.prepare(`SELECT s.*,m.message_id,m.sender_name,m.sent_at FROM group_link_shares s
        JOIN messages m ON m.id=s.message_row_id WHERE s.account_id=? AND s.group_id=? AND s.fingerprint=?
        AND m.status='active' AND m.id!=? AND (m.sent_at<? OR (m.sent_at=? AND m.id<?))
        AND NOT EXISTS(SELECT 1 FROM blocked_users b WHERE b.account_id=m.account_id AND b.user_id=m.sender_id)
        ORDER BY m.sent_at DESC,m.id DESC LIMIT 1`)
        .get(message.accountId, message.groupId, fingerprint, row.id, row.sent_at, row.sent_at, row.id) as LinkShare | undefined;
      if (!previous || Date.parse(row.sent_at) - Date.parse(previous.sent_at) < this.cooldown) continue;
      const summary = this.readSummary(message.accountId, message.groupId, fingerprint, previous.message_id, row.sent_at);
      const name = plain(previous.sender_name, 60) || "群友";
      const text = summary ? `这个${name}发过了，当时的结论是：${summary}` : `这个上次${name}发过。`;
      notices.push({ accountId: message.accountId, groupId: message.groupId, fingerprint, url,
        previousMessageId: previous.message_id, previousSenderName: name, previousSentAt: previous.sent_at,
        currentMessageId: row.message_id, text, segments: [{ type: "reply", data: { id: previous.message_id } }, { type: "text", data: { text } }],
        taskKey: `link_duplicate:${stableHash(JSON.stringify([message.accountId, message.groupId, fingerprint]))}` });
    }
    return notices;
  }

  private readSummary(accountId: string, groupId: string, fingerprint: string, sourceMessageId: string, before: string): string {
    const reads = this.storage.db.prepare(`SELECT url,final_url,title,summary FROM link_reads WHERE account_id=? AND group_id=?
      AND shared_message_id=? AND status='ok' AND summary IS NOT NULL AND created_at<=? ORDER BY id DESC LIMIT 30`)
      .all(accountId, groupId, sourceMessageId, before) as unknown as { url: string; final_url: string | null; title: string | null; summary: string }[];
    for (const read of reads) {
      if (groupLinkIdentity(read.url)?.fingerprint === fingerprint || (read.final_url && groupLinkIdentity(read.final_url)?.fingerprint === fingerprint)) {
        const sentence = firstReadSentence(read.summary, read.title ?? "");
        if (sentence) return sentence;
      }
    }
    return "";
  }

  /** Commit only after the shared automatic-reply quota permits and enqueue accepts the notice. */
  commitDuplicate(notice: LinkDuplicateNotice): boolean {
    const source = this.message(notice.accountId, notice.groupId, notice.previousMessageId);
    const current = this.message(notice.accountId, notice.groupId, notice.currentMessageId);
    if (!source || !current) return false;
    if (current.origin !== "live" || !Number.isFinite(Date.parse(source.sent_at)) || !Number.isFinite(Date.parse(current.sent_at))
      || Date.parse(current.sent_at) - Date.parse(source.sent_at) < this.cooldown) return false;
    const fingerprint = groupLinkIdentity(notice.url)?.fingerprint;
    if (fingerprint !== notice.fingerprint) return false;
    for (const row of [source, current]) {
      const share = this.storage.db.prepare("SELECT 1 FROM group_link_shares WHERE account_id=? AND group_id=? AND fingerprint=? AND message_row_id=?")
        .get(notice.accountId, notice.groupId, fingerprint, row.id);
      if (!share) return false;
    }
    // A nearer historical share may have arrived while quota checks ran.
    const latest = this.storage.db.prepare(`SELECT m.id FROM group_link_shares s JOIN messages m ON m.id=s.message_row_id
      WHERE s.account_id=? AND s.group_id=? AND s.fingerprint=? AND m.status='active'
      AND (m.sent_at<? OR (m.sent_at=? AND m.id<?))
      AND NOT EXISTS(SELECT 1 FROM blocked_users b WHERE b.account_id=m.account_id AND b.user_id=m.sender_id)
      ORDER BY m.sent_at DESC,m.id DESC LIMIT 1`).get(notice.accountId, notice.groupId, fingerprint, current.sent_at, current.sent_at, current.id) as { id: number } | undefined;
    if (latest?.id !== source.id) return false;
    const result = this.storage.db.prepare(`INSERT OR IGNORE INTO group_link_notices(account_id,group_id,fingerprint,source_row_id,duplicate_row_id,reminded_at)
      VALUES(?,?,?,?,?,?)`).run(notice.accountId, notice.groupId, notice.fingerprint, source.id, current.id, new Date(this.now()).toISOString());
    return Number(result.changes) > 0;
  }
}
