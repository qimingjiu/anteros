import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import type { JobScope } from "./scheduler.js";

export type Category = "前端" | "工具" | "资源" | "其它";
const CATEGORIES: readonly Category[] = ["前端", "工具", "资源", "其它"];

type LibraryScope = Pick<JobScope, "room" | "member">;

interface Capture {
  key: string;
  name: string;
  url?: string;
  artifact?: string;
  note?: string;
  category?: Category;
}

interface LibraryItem extends Capture {
  id: string;
  version: number;
  sources: string[];
  description?: string;
  tags?: string[];
}

export function canonicalURL(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("网址格式无效。"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("只接受公开 HTTP(S) 网址。");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|fbclid$|gclid$|spm$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

function category(value?: Category): Category {
  if (value && !CATEGORIES.includes(value)) throw new Error("收藏分类无效。");
  return value ?? "其它";
}

export class Library {
  constructor(private readonly db: Database) {
    db.db.exec(`
      CREATE TABLE IF NOT EXISTS family_library (
        id TEXT PRIMARY KEY, room TEXT NOT NULL, member TEXT NOT NULL, item_key TEXT NOT NULL,
        category TEXT NOT NULL, searchable TEXT NOT NULL, body TEXT NOT NULL, UNIQUE (room, member, item_key)
      );
      CREATE INDEX IF NOT EXISTS family_library_scope ON family_library (room, member, category);
    `);
  }

  search(scope: LibraryScope, query: string, filter?: Category): LibraryItem[] {
    if (filter) category(filter);
    const terms = query.toLowerCase().trim().split(/\s+/u).filter(Boolean).slice(0, 12);
    const alias = (term: string) => term === "安卓" ? "android" : term === "android" ? "安卓" : term;
    const termFilter = terms.map(() => "AND (instr(searchable, ?) > 0 OR instr(searchable, ?) > 0)").join(" ");
    return this.db.db.prepare(`
      SELECT body FROM family_library WHERE room = ? AND member = ?
      AND (? IS NULL OR category = ?) ${termFilter} ORDER BY rowid DESC LIMIT 50
    `).all(scope.room, scope.member, filter ?? null, filter ?? null,
      ...terms.flatMap(term => [term, alias(term)])).map(row => JSON.parse(String(row.body)) as LibraryItem);
  }

  capture(scope: LibraryScope, sourceKey: string, input: Capture): LibraryItem {
    const row = this.db.db.prepare("SELECT body FROM family_library WHERE room=? AND member=? AND item_key=?")
      .get(scope.room, scope.member, input.key);
    const previous = row ? JSON.parse(String(row.body)) as LibraryItem : undefined;
    if (previous?.sources.includes(sourceKey)) return previous;
    const item = previous
      ? { ...previous, sources: [...previous.sources, sourceKey].slice(-100), note: previous.note ?? input.note }
      : { ...input, id: randomUUID(), version: 1, sources: [sourceKey], category: category(input.category) };
    this.save(scope, item);
    return item;
  }

  describe(scope: LibraryScope, id: string, version: number, title: string, text: string): LibraryItem {
    const item = this.get(scope, id);
    if (item.version !== version) return item;
    if (title.trim()) item.name = title.trim().slice(0, 200);
    item.description = text.trim().slice(0, 1400);
    this.save(scope, item);
    return item;
  }

  update(scope: LibraryScope, id: string, update: { note?: string; category?: Category; tags?: unknown }): LibraryItem {
    const item = this.get(scope, id);
    if (update.note !== undefined) item.note = update.note;
    if (update.category !== undefined) item.category = category(update.category);
    if (update.tags !== undefined) {
      const tags = update.tags;
      if (!Array.isArray(tags) || tags.length > 20
        || tags.some(tag => typeof tag !== "string" || !tag.trim() || tag.length > 60)) throw new Error("标签最多 20 个，每个最多 60 字。");
      item.tags = [...new Set<string>(tags.map(tag => tag.trim()))];
    }
    item.version++;
    this.save(scope, item);
    return item;
  }

  get(scope: LibraryScope, id: string): LibraryItem {
    const row = this.db.db.prepare("SELECT body FROM family_library WHERE room=? AND member=? AND id=?")
      .get(scope.room, scope.member, id);
    if (!row) throw new Error("当前成员没有这个收藏。");
    return JSON.parse(String(row.body)) as LibraryItem;
  }

  private save(scope: LibraryScope, item: LibraryItem): void {
    const searchable = [item.name, item.url, item.note, item.description, ...(item.tags ?? [])].filter(Boolean)
      .join("\n").toLowerCase();
    this.db.db.prepare(`
      INSERT INTO family_library (id,room,member,item_key,category,searchable,body) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET category=excluded.category, searchable=excluded.searchable, body=excluded.body
    `).run(item.id, scope.room, scope.member, item.key, item.category ?? "其它", searchable, JSON.stringify(item));
  }
}
