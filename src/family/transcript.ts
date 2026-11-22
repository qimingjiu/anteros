import type { Database } from "../db/index.js";
import { groupSearchMatch } from "../group-knowledge/tokens.js";
import type { MessageRecord } from "../types.js";
import type { FamilyRooms } from "./rooms.js";

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
  excludeCurrent?: boolean;
  asOfSource?: boolean;
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
  exact: number;
  rank: number;
}

interface RankedEntry extends PrivateTranscriptEntry {
  id: number;
  exact: number;
  rank: number;
}

interface Selection extends TranscriptDateOptions {
  phrase?: string;
  match?: string;
  cursor?: { entry: RankedEntry; side: "before" | "after" };
  turnEventKey?: string;
}

export interface PrivateRecall {
  hit: PrivateTranscriptEntry;
  turn: PrivateTranscriptEntry[];
}

function rowOrder(a: RankedEntry, b: RankedEntry): number {
  return a.at.localeCompare(b.at) || a.id - b.id;
}

function entry({ id: _id, rank: _rank, exact: _exact, ...rest }: RankedEntry): PrivateTranscriptEntry {
  return rest;
}

function readLimit(value: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(max, Number.isFinite(value) ? Math.trunc(value!) : fallback));
}

export class PrivateTranscript {
  private readonly peers: readonly PrivatePeer[];

  constructor(private readonly db: Database, peers: readonly PrivatePeer[], private readonly options: { rooms?: FamilyRooms } = {}) {
    this.peers = peers.map(peer => ({ ...peer, ownerIds: [...new Set(peer.ownerIds)] }));
    if (!peers.length) return;
    const sqlite = this.db.db;
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS family_private_fts USING fts5(tokens, tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS family_private_fts_insert AFTER INSERT ON messages
      WHEN new.group_id IS NULL AND new.status='active' AND new.text_content!=''
      BEGIN
        INSERT INTO family_private_fts(rowid,tokens) VALUES (new.id,group_search_tokens(new.text_content));
      END;
      CREATE TRIGGER IF NOT EXISTS family_private_fts_update AFTER UPDATE OF text_content,group_id,status ON messages
      WHEN old.group_id IS NULL OR new.group_id IS NULL
      BEGIN
        DELETE FROM family_private_fts WHERE rowid=old.id;
        INSERT INTO family_private_fts(rowid,tokens) SELECT new.id,group_search_tokens(new.text_content)
          WHERE new.group_id IS NULL AND new.status='active' AND new.text_content!='';
      END;
      CREATE TRIGGER IF NOT EXISTS family_private_fts_delete AFTER DELETE ON messages WHEN old.group_id IS NULL
      BEGIN DELETE FROM family_private_fts WHERE rowid=old.id; END;
    `);
    const versionKey = "family_private_fts_index_version";
    if (this.db.kvGet(versionKey) !== "1") {
      sqlite.exec("SAVEPOINT family_private_fts_backfill");
      try {
        sqlite.exec(`
          DELETE FROM family_private_fts;
          INSERT INTO family_private_fts(rowid,tokens)
          SELECT id,group_search_tokens(text_content) FROM messages
          WHERE group_id IS NULL AND status='active' AND text_content!='';
        `);
        this.db.kvSet(versionKey, "1");
        sqlite.exec("RELEASE family_private_fts_backfill");
      } catch (error) {
        sqlite.exec("ROLLBACK TO family_private_fts_backfill; RELEASE family_private_fts_backfill");
        throw error;
      }
    }
  }

  has(message: MessageRecord): boolean {
    return !message.groupId && !message.interaction && message.status === "active"
      && message.conversationId === "private_" + message.senderId
      && this.peers.some(peer => peer.accountId === message.accountId && peer.ownerIds.includes(message.senderId));
  }

  read(message: MessageRecord, startIso: string, endIso: string, options: TranscriptOptions = {}): PrivateTranscriptEntry[] {
    return this.recent(message, { ...options, startIso, endIso });
  }

  recent(message: MessageRecord, options: TranscriptDateOptions = {}): PrivateTranscriptEntry[] {
    return this.select(message, options).map(entry);
  }

  search(message: MessageRecord, query: string, options: TranscriptDateOptions = {}): PrivateTranscriptEntry[] {
    return this.ranked(message, query, options).map(entry);
  }

  recall(message: MessageRecord, query: string, options: TranscriptDateOptions = {}): PrivateRecall[] {
    const limit = readLimit(options.limit, 8, 20);
    const hits = this.ranked(message, query, { ...options, limit: limit * 4 });
    const turns: PrivateRecall[] = [];
    const anchors = new Set<string>();
    for (const hit of hits) {
      const sourceKey = this.options.rooms?.turnFor(hit.eventKey);
      if (sourceKey && anchors.has(sourceKey)) continue;
      if (sourceKey) {
        const turn = this.select(message, { ...options, limit: 12, turnEventKey: sourceKey });
        if (!turn.some(row => row.eventKey === hit.eventKey)) turn.push(hit);
        anchors.add(sourceKey);
        turns.push({ hit: entry(hit), turn: turn.sort(rowOrder).map(entry) });
        if (turns.length >= limit) break;
        continue;
      }
      // Older rows have no exact turn identifier. Re-read a short span of
      // real neighboring messages before and after the matching row.
      const time = Date.parse(hit.at);
      const bounds = Number.isFinite(time) ? {
        startIso: new Date(time - 300_000).toISOString(), endIso: new Date(time + 300_000).toISOString(),
      } : {};
      const neighbors = {
        ...options,
        startIso: [options.startIso, bounds.startIso].filter(Boolean).sort().at(-1),
        endIso: [options.endIso, bounds.endIso].filter(Boolean).sort()[0],
        limit: 6,
      };
      const before = hit.role === "assistant" ? this.select(message, {
        ...neighbors, cursor: { entry: hit, side: "before" },
      }) : [];
      const previousUser = before.findLastIndex(row => row.role === "user");
      const after = this.select(message, { ...neighbors, cursor: { entry: hit, side: "after" } });
      const nextUser = after.findIndex(row => row.role === "user");
      const turn = [
        ...(previousUser < 0 ? [] : before.slice(previousUser)), hit, ...after.slice(0, nextUser < 0 ? undefined : nextUser),
      ];
      const anchor = turn[0]!.eventKey;
      if (anchors.has(anchor)) continue;
      anchors.add(anchor);
      turns.push({ hit: entry(hit), turn: turn.map(entry) });
      if (turns.length >= limit) break;
    }
    return turns;
  }

  private ranked(message: MessageRecord, query: string, options: TranscriptDateOptions): RankedEntry[] {
    const phrase = query.trim().normalize("NFKC").slice(0, 180);
    const match = groupSearchMatch(phrase).replaceAll(" AND ", " OR ");
    return match ? this.select(message, { ...options, phrase, match, limit: readLimit(options.limit, 20, 80) }) : [];
  }

  private select(message: MessageRecord, selection: Selection): RankedEntry[] {
    if (!this.has(message)) return [];
    const rooms = this.options.rooms;
    const room = rooms?.roomFor(message);
    if (rooms && !room) return [];
    const source = selection.asOfSource ? this.db.db.prepare(
      "SELECT id FROM messages WHERE event_key=? AND account_id=? AND conversation_id=? AND sender_id=? AND group_id IS NULL",
    ).get(message.eventKey, message.accountId, message.conversationId, message.senderId) : undefined;
    const fallback = selection.asOfSource && !source ? Date.parse(message.sentAt) : undefined;
    if (fallback !== undefined && !Number.isFinite(fallback)) return [];
    const limit = readLimit(selection.limit, 200, 2000);
    const ranked = Boolean(selection.match);
    const forward = selection.cursor?.side === "after";
    const direction = forward ? "ASC" : "DESC";
    const operator = forward ? ">" : "<";
    const columns = ranked
      ? "CASE WHEN instr(lower(m.text_content), lower(?)) > 0 THEN 1 ELSE 0 END AS exact, bm25(family_private_fts) AS rank"
      : "0 AS exact, 0 AS rank";
    const query = this.db.db.prepare(`
      SELECT m.id,m.sent_at,m.sender_id,m.sender_name,m.text_content,m.event_key,${columns}
      FROM messages m
      ${ranked ? "JOIN family_private_fts ON family_private_fts.rowid=m.id" : ""}
      ${rooms ? "LEFT JOIN family_room_sources room ON room.home_id=? AND room.event_key=m.event_key" : ""}
      WHERE m.account_id=? AND m.conversation_id=? AND m.group_id IS NULL
        AND (m.sender_id=? OR m.sender_id=?) AND m.status='active' AND m.text_content!=''
        AND m.sent_at>=? AND m.sent_at<?
        ${source ? "AND m.id<=?" : fallback !== undefined ? "AND m.sent_at<=?" : ""}
        ${rooms ? "AND coalesce(room.room_id,?)=?" : ""}
        ${rooms && selection.turnEventKey ? "AND (room.turn_event_key=? OR m.event_key=?)" : ""}
        ${ranked ? "AND family_private_fts MATCH ?" : ""}
        ${selection.excludeCurrent ? "AND m.event_key!=?" : ""}
        ${selection.cursor ? `AND (m.sent_at${operator}? OR (m.sent_at=? AND m.id${operator}?))` : ""}
      ORDER BY ${ranked ? "exact DESC, rank ASC," : ""} m.sent_at ${direction},m.id ${direction} LIMIT ?
    `);
    const rows = this.peers.flatMap(peer => {
      if (selection.otherAccountsOnly && peer.accountId === message.accountId) return [];
      const botId = peer.botId() ?? null;
      return peer.ownerIds.flatMap(ownerId => {
        const result = query.all(
          ...(ranked ? [selection.phrase!] : []),
          ...(rooms ? [rooms.homeId] : []),
          peer.accountId, "private_" + ownerId, ownerId, botId, selection.startIso ?? "0000", selection.endIso ?? "9999",
          ...(source ? [source.id!] : fallback !== undefined ? [new Date(fallback).toISOString()] : []),
          ...(rooms ? [rooms.homeId, room!] : []),
          ...(rooms && selection.turnEventKey ? [selection.turnEventKey, selection.turnEventKey] : []),
          ...(ranked ? [selection.match!] : []),
          ...(selection.excludeCurrent ? [message.eventKey] : []),
          ...(selection.cursor ? [selection.cursor.entry.at, selection.cursor.entry.at, selection.cursor.entry.id] : []),
          limit,
        ) as unknown as TranscriptRow[];
        return result.map(row => ({
          id: row.id,
          at: row.sent_at,
          author: row.sender_name || (row.sender_id === botId ? "助手" : "主人"),
          role: row.sender_id === botId ? "assistant" as const : "user" as const,
          text: row.text_content,
          accountId: peer.accountId,
          eventKey: row.event_key,
          exact: row.exact,
          rank: row.rank,
        }));
      });
    });
    if (ranked) return rows.sort((a, b) => b.exact - a.exact || a.rank - b.rank || rowOrder(b, a)).slice(0, limit);
    rows.sort(rowOrder);
    return forward ? rows.slice(0, limit) : rows.slice(-limit);
  }
}
