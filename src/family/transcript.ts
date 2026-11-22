import type { Database } from "../db/index.js";
import type { MessageRecord } from "../types.js";

export interface PrivatePeer {
  accountId: string;
  ownerIds: readonly string[];
  botId: () => string | undefined;
}

export interface PrivateTranscriptEntry {
  at: string;
  author: string;
  role: "user" | "assistant";
  text: string;
  accountId: string;
  eventKey: string;
}

export interface TranscriptOptions {
  limit?: number;
  otherAccountsOnly?: boolean;
}

interface TranscriptDateOptions extends TranscriptOptions {
  startIso?: string;
  endIso?: string;
}

interface TranscriptRow {
  id: number;
  sent_at: string;
  sender_id: string;
  sender_name: string;
  text_content: string;
  event_key: string;
}

export class PrivateTranscript {
  private readonly peers: readonly PrivatePeer[];

  constructor(private readonly db: Database, peers: readonly PrivatePeer[]) {
    this.peers = peers.map(peer => ({ ...peer, ownerIds: [...new Set(peer.ownerIds)] }));
  }

  has(message: MessageRecord): boolean {
    return !message.groupId && !message.interaction && message.status === "active"
      && message.conversationId === "private_" + message.senderId
      && this.peers.some(peer => peer.accountId === message.accountId && peer.ownerIds.includes(message.senderId));
  }

  read(
    message: MessageRecord,
    startIso: string,
    endIso: string,
    options: TranscriptOptions = {},
  ): PrivateTranscriptEntry[] {
    return this.select(message, startIso, endIso, options, []);
  }

  recent(message: MessageRecord, options: TranscriptDateOptions = {}): PrivateTranscriptEntry[] {
    return this.select(message, options.startIso ?? "0000", options.endIso ?? "9999", options, []);
  }

  search(message: MessageRecord, query: string, options: TranscriptDateOptions = {}): PrivateTranscriptEntry[] {
    const terms = [...new Set(query.trim().slice(0, 400).split(/\s+/u).filter(Boolean))].slice(0, 12);
    if (!terms.length) return [];
    return this.select(message, options.startIso ?? "0000", options.endIso ?? "9999", options, terms);
  }

  private select(
    message: MessageRecord, startIso: string, endIso: string, options: TranscriptOptions, terms: string[],
  ): PrivateTranscriptEntry[] {
    if (!this.has(message)) return [];
    const limit = Math.max(1, Math.min(2000, Number.isFinite(options.limit) ? Math.trunc(options.limit!) : 200));
    const predicates = terms.map(() => "AND instr(lower(text_content), lower(?)) > 0").join(" ");
    const read = this.db.db.prepare(`
      SELECT id, sent_at, sender_id, sender_name, text_content, event_key
      FROM messages
      WHERE account_id = ? AND conversation_id = ? AND group_id IS NULL
        AND (sender_id = ? OR sender_id = ?) AND status = 'active'
        AND text_content != '' AND sent_at >= ? AND sent_at < ? ${predicates}
      ORDER BY sent_at DESC, id DESC LIMIT ?
    `);
    const rows = this.peers.flatMap(peer => {
      if (options.otherAccountsOnly && peer.accountId === message.accountId) return [];
      const botId = peer.botId() ?? null;
      return peer.ownerIds.flatMap(ownerId => {
        const result = read.all(
          peer.accountId, "private_" + ownerId, ownerId, botId, startIso, endIso, ...terms, limit,
        ) as unknown as TranscriptRow[];
        return result.map(row => ({
          id: row.id,
          at: row.sent_at,
          author: row.sender_name || (row.sender_id === botId ? "助手" : "主人"),
          role: row.sender_id === botId ? "assistant" as const : "user" as const,
          text: row.text_content,
          accountId: peer.accountId,
          eventKey: row.event_key,
        }));
      });
    });
    return rows.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id)
      .slice(-limit).map(({ id: _id, ...entry }) => entry);
  }
}
