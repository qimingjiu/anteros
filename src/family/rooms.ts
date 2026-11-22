import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import type { MessageRecord } from "../types.js";
import type { PersonaCard, PersonaState, PersonaStateStore } from "../agent/persona-switch.js";

export interface FamilyRoom {
  id: string;
  name: string;
  memberIds: string[];
  home: boolean;
}

export interface FamilyRoomsOptions {
  homeId: string;
  isOwner: (message: MessageRecord) => boolean;
  catalog: () => readonly PersonaCard[];
}

interface RoomRow {
  id: string;
  name: string;
  member_ids: string;
}

interface RoomCommand {
  kind: "list" | "enter" | "create" | "members" | "help";
  input: string;
}

interface RoomReply { roomId: string; reply: string }

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

const HOME_ALIASES = new Set(["客厅", "家", "默认", "客厅房间", "home", "family"]);

export class FamilyRooms {
  readonly homeId: string;

  constructor(private readonly db: Database, private readonly options: FamilyRoomsOptions) {
    this.homeId = options.homeId;
    db.db.exec(`
      CREATE TABLE IF NOT EXISTS family_rooms (
        id TEXT PRIMARY KEY, home_id TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
        member_ids TEXT NOT NULL, persona_state TEXT, UNIQUE(home_id, name_key)
      );
      CREATE TABLE IF NOT EXISTS family_room_selections (
        home_id TEXT PRIMARY KEY, room_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS family_room_sources (
        home_id TEXT NOT NULL, event_key TEXT NOT NULL, room_id TEXT NOT NULL, turn_event_key TEXT,
        PRIMARY KEY(home_id, event_key)
      );
      CREATE INDEX IF NOT EXISTS family_room_sources_room ON family_room_sources(home_id, room_id);
      CREATE TABLE IF NOT EXISTS family_room_commands (
        home_id TEXT NOT NULL, event_key TEXT NOT NULL, room_id TEXT NOT NULL, reply TEXT NOT NULL,
        PRIMARY KEY(home_id, event_key)
      );
      CREATE TRIGGER IF NOT EXISTS family_room_cleanup_command AFTER DELETE ON messages
      BEGIN DELETE FROM family_room_commands WHERE event_key = old.event_key; END;
    `);
    const columns = db.db.prepare("PRAGMA table_info(family_room_sources)").all();
    if (!columns.some(column => column.name === "turn_event_key")) db.db.exec("ALTER TABLE family_room_sources ADD COLUMN turn_event_key TEXT");
    db.db.exec(`
      CREATE INDEX IF NOT EXISTS family_room_sources_turn ON family_room_sources(home_id, room_id, turn_event_key);
      DROP TRIGGER IF EXISTS family_room_cleanup_source;
    `);
  }

  private owner(message: MessageRecord): boolean {
    return !message.groupId && !message.interaction && message.status === "active"
      && message.origin === "live" && message.conversationId === "private_" + message.senderId
      && this.options.isOwner(message);
  }

  private home(): FamilyRoom {
    return { id: this.homeId, name: "客厅", memberIds: this.options.catalog().map(card => card.id), home: true };
  }

  private rowToRoom(row: RoomRow): FamilyRoom {
    const present = new Set(this.options.catalog().map(card => card.id));
    const ids = (JSON.parse(row.member_ids) as string[]).filter(id => present.has(id));
    return { id: row.id, name: row.name, memberIds: ids, home: false };
  }

  list(): FamilyRoom[] {
    const rows = this.db.db.prepare("SELECT id,name,member_ids FROM family_rooms WHERE home_id=? ORDER BY rowid")
      .all(this.homeId) as unknown as RoomRow[];
    return [this.home(), ...rows.map(row => this.rowToRoom(row))];
  }

  get(id: string): FamilyRoom | undefined {
    if (id === this.homeId) return this.home();
    const row = this.db.db.prepare("SELECT id,name,member_ids FROM family_rooms WHERE home_id=? AND id=?")
      .get(this.homeId, id) as unknown as RoomRow | undefined;
    return row ? this.rowToRoom(row) : undefined;
  }

  current(): FamilyRoom {
    const picked = this.db.db.prepare("SELECT room_id FROM family_room_selections WHERE home_id=?").get(this.homeId);
    const current = picked && this.get(String(picked.room_id));
    return current?.memberIds.length ? current : this.home();
  }

  assign(source: MessageRecord): string | undefined {
    if (!this.owner(source)) return undefined;
    const assigned = this.assigned(source.eventKey);
    if (assigned) return assigned;
    const room = this.current().id;
    this.recordMessage(source.eventKey, room, source.eventKey);
    return room;
  }

  private assigned(eventKey: string): string | undefined {
    const row = this.db.db.prepare("SELECT room_id FROM family_room_sources WHERE home_id=? AND event_key=?")
      .get(this.homeId, eventKey);
    return row ? String(row.room_id) : undefined;
  }

  roomFor(source: MessageRecord): string | undefined {
    if (!this.owner(source)) return undefined;
    return this.assigned(source.eventKey) ?? this.homeId;
  }

  messageInRoom(source: MessageRecord, eventKey: string): boolean {
    const room = this.roomFor(source);
    return !!room && room === (this.assigned(eventKey) ?? this.homeId);
  }

  turnFor(eventKey: string): string | undefined {
    const row = this.db.db.prepare("SELECT turn_event_key FROM family_room_sources WHERE home_id=? AND event_key=?")
      .get(this.homeId, eventKey);
    return typeof row?.turn_event_key === "string" ? row.turn_event_key : undefined;
  }

  recordMessage(eventKey: string, roomId: string, turnEventKey?: string): void {
    if (!eventKey || !this.get(roomId)) throw new Error("家庭房间不存在。");
    this.db.db.prepare(`
      INSERT INTO family_room_sources(home_id,event_key,room_id,turn_event_key) VALUES (?,?,?,?)
      ON CONFLICT(home_id,event_key) DO UPDATE SET turn_event_key=excluded.turn_event_key
      WHERE family_room_sources.room_id=excluded.room_id AND family_room_sources.turn_event_key IS NULL
    `).run(this.homeId, eventKey, roomId, turnEventKey ?? null);
  }

  personaState(roomId: string): PersonaStateStore {
    if (roomId === this.homeId || !this.get(roomId)) throw new Error("自定义房间不存在。");
    return {
      load: () => {
        const row = this.db.db.prepare("SELECT persona_state FROM family_rooms WHERE home_id=? AND id=?")
          .get(this.homeId, roomId);
        return row && typeof row.persona_state === "string" ? JSON.parse(row.persona_state) as PersonaState : undefined;
      },
      save: state => {
        this.db.db.prepare("UPDATE family_rooms SET persona_state=? WHERE home_id=? AND id=?")
          .run(JSON.stringify(state), this.homeId, roomId);
      },
    };
  }

  /** Natural phrasing without a leading slash also works for the same small command grammar. */
  handle(source: MessageRecord): RoomReply | null {
    const text = source.textContent.trim().replace(/[。！!]+$/u, "");
    const command = this.command(text);
    if (!command || !this.owner(source)) return null;
    const room = this.assign(source)!;
    const earlier = this.db.db.prepare(
      "SELECT room_id AS roomId,reply FROM family_room_commands WHERE home_id=? AND event_key=?",
    ).get(this.homeId, source.eventKey) as unknown as RoomReply | undefined;
    if (earlier) return earlier;
    this.db.db.exec("SAVEPOINT family_room_command");
    try {
      const result = this.runCommand(command, room);
      this.db.db.prepare("INSERT INTO family_room_commands(home_id,event_key,room_id,reply) VALUES (?,?,?,?)")
        .run(this.homeId, source.eventKey, result.roomId, result.reply);
      this.db.db.exec("RELEASE family_room_command");
      return result;
    } catch (error) {
      this.db.db.exec("ROLLBACK TO family_room_command; RELEASE family_room_command");
      return { roomId: room, reply: error instanceof Error ? error.message : "房间操作失败。" };
    }
  }

  private runCommand(command: RoomCommand, room: string): RoomReply {
    switch (command.kind) {
      case "list": {
        const current = this.current();
        const lines = this.list().map(entry => "· " + entry.name + (entry.id === current.id ? "（当前）" : "")
          + (entry.home ? "" : " · " + entry.id));
        return { roomId: room, reply: [
          "家庭房间", ...lines, "",
          "创建：/房间 创建 书房 | 成员名、成员名",
          "进入：/房间 进入 书房",
          "修改当前房间成员：/房间 成员 成员名、成员名",
        ].join("\n") };
      }
      case "enter": {
        const target = this.find(command.input);
        if (!target) throw new Error("找不到这个房间。");
        if (!target.memberIds.length) throw new Error("房间成员卡已移除。请用 /房间 成员 房间名 | 成员名 重新指定。");
        this.select(target.id);
        return { roomId: target.id, reply: "已进入「" + target.name + "」。" };
      }
      case "create": {
        const [name, participants, ...rest] = command.input.split(/[|｜]/u);
        if (rest.length) throw new Error("房间名和成员名单之间只需一个 |。");
        const label = name?.trim() ?? "";
        const key = normalize(label);
        if (!key || label.length > 40 || /[\u0000-\u001f\u007f]/u.test(label) || HOME_ALIASES.has(key)) {
          throw new Error("请为新房间取一个不同于客厅的短名字。");
        }
        if (this.find(label)) throw new Error("这个名字已被另一个房间使用。");
        const ids = participants?.trim() ? this.resolveMembers(participants) : this.home().memberIds;
        if (!ids.length) throw new Error("请先配置至少一位成员。");
        const id = "room:" + randomUUID();
        this.db.db.prepare("INSERT INTO family_rooms(id,home_id,name,name_key,member_ids) VALUES (?,?,?,?,?)")
          .run(id, this.homeId, label, key, JSON.stringify(ids));
        this.select(id);
        return { roomId: id, reply: "已创建并进入「" + label + "」。成员有 " + this.names(ids) + "。" };
      }
      case "members": {
        const [names, explicit, ...rest] = command.input.split(/[|｜]/u);
        if (rest.length) throw new Error("修改其他房间请写 /房间 成员 房间名 | 成员名、成员名。");
        const target = explicit === undefined ? this.current() : this.find(names ?? "");
        if (!target) throw new Error("找不到这个房间。");
        if (target.home) throw new Error("客厅使用配置中完整的家庭成员名册。");
        const ids = this.resolveMembers(explicit ?? names ?? "");
        this.db.db.prepare("UPDATE family_rooms SET member_ids=? WHERE home_id=? AND id=?")
          .run(JSON.stringify(ids), this.homeId, target.id);
        return { roomId: room, reply: "「" + target.name + "」的成员现在是 " + this.names(ids) + "。" };
      }
      case "help":
        return { roomId: room, reply: "请说 /房间 查看房间用法。" };
    }
  }

  private command(text: string): RoomCommand | undefined {
    if (/^(?:\/房间|\/rooms?|房间列表|有哪些房间)$/iu.test(text)) return { kind: "list", input: "" };
    const match = /^(?:\/房间\s+|\/rooms?\s+)?(创建房间|新建房间|进入房间|切换房间|创建|新建|进入|切换|成员)\s+(.+)$/u.exec(text);
    if (!match) return /^(?:\/房间|\/rooms?)(?:\s|$)/iu.test(text) ? { kind: "help", input: "" } : undefined;
    if (!text.startsWith("/") && !match[1]!.endsWith("房间")) return undefined;
    const kind = /^(?:创建|新建)/u.test(match[1]!) ? "create" : /^(?:进入|切换)/u.test(match[1]!) ? "enter" : "members";
    return { kind, input: match[2]! };
  }

  private find(name: string): FamilyRoom | undefined {
    const key = normalize(name);
    if (HOME_ALIASES.has(key) || key === this.homeId) return this.home();
    const row = this.db.db.prepare("SELECT id,name,member_ids FROM family_rooms WHERE home_id=? AND (name_key=? OR id=?)")
      .get(this.homeId, key, name.trim()) as unknown as RoomRow | undefined;
    return row ? this.rowToRoom(row) : undefined;
  }

  private select(roomId: string): void {
    this.db.db.prepare(`
      INSERT INTO family_room_selections(home_id,room_id) VALUES (?,?)
      ON CONFLICT(home_id) DO UPDATE SET room_id=excluded.room_id
    `).run(this.homeId, roomId);
  }

  private resolveMembers(value: string): string[] {
    const words = value.split(/[,，、]/u).map(normalize).filter(Boolean);
    if (!words.length) throw new Error("每个房间至少需要一位成员。");
    const ids = words.map(word => {
      const matches = this.options.catalog().filter(card => [card.id, card.name, ...card.aliases]
        .some(alias => normalize(alias) === word));
      if (matches.length !== 1) throw new Error("没有唯一匹配的成员「" + word.slice(0, 40) + "」，可改用成员 ID。");
      return matches[0]!.id;
    });
    return [...new Set(ids)];
  }

  private names(ids: readonly string[]): string {
    const catalog = new Map(this.options.catalog().map(card => [card.id, card.name]));
    return ids.map(id => catalog.get(id) ?? id).join("、");
  }
}
