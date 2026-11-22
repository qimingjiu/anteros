import { createHash, randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";

export interface ArtifactInput { name: string; mime: string; bytes: Buffer }
export interface FamilyArtifact {
  id: string;
  owner: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  parentId: string | null;
  createdAt: string;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const SELECT_METADATA = "id, member AS owner, name, mime, size, sha256, parent_id AS parentId, created_at AS createdAt";

export class PrivateWorkspace {
  constructor(private readonly db: Database) {
    db.db.exec(`
      CREATE TABLE IF NOT EXISTS family_artifacts (
        id TEXT PRIMARY KEY, room TEXT NOT NULL, member TEXT NOT NULL, name TEXT NOT NULL,
        mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, parent_id TEXT,
        created_at TEXT NOT NULL, source_key TEXT NOT NULL, contents BLOB NOT NULL,
        UNIQUE (room, member, source_key)
      );
      CREATE INDEX IF NOT EXISTS family_artifacts_name
        ON family_artifacts (room, member, name, created_at DESC);
      CREATE TABLE IF NOT EXISTS family_artifact_grants (
        artifact_id TEXT NOT NULL REFERENCES family_artifacts(id),
        member TEXT NOT NULL, source_key TEXT NOT NULL, PRIMARY KEY (artifact_id, member)
      );
    `);
  }

  write(room: string, member: string, sourceKey: string, input: ArtifactInput): FamilyArtifact {
    const name = input.name.trim();
    if (!name || name.length > 160 || /[\\/\u0000-\u001f\u007f]/u.test(name) || name === "." || name === "..") {
      throw new Error("请给出文件名，文件名不能含路径。");
    }
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length > MAX_FILE_BYTES) throw new Error("单文件上限为 25 MiB。");
    if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(input.mime)) throw new Error("文件类型无效。");
    const bySource = this.db.db.prepare(
      "SELECT " + SELECT_METADATA + " FROM family_artifacts WHERE room = ? AND member = ? AND source_key = ?",
    );
    const existing = bySource.get(room, member, sourceKey) as unknown as FamilyArtifact | undefined;
    if (existing) return existing;
    const parent = this.db.db.prepare(
      "SELECT id FROM family_artifacts WHERE room = ? AND member = ? AND name = ? ORDER BY rowid DESC LIMIT 1",
    ).get(room, member, name);
    const id = randomUUID();
    this.db.db.prepare(`
      INSERT INTO family_artifacts (id, room, member, name, mime, size, sha256, parent_id, created_at, source_key, contents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (room, member, source_key) DO NOTHING
    `).run(id, room, member, name, input.mime, input.bytes.length,
      createHash("sha256").update(input.bytes).digest("hex"), parent ? String(parent.id) : null,
      new Date().toISOString(), sourceKey, input.bytes);
    return bySource.get(room, member, sourceKey) as unknown as FamilyArtifact;
  }

  list(room: string, member: string, query = ""): FamilyArtifact[] {
    return this.db.db.prepare(
      "SELECT " + SELECT_METADATA + " FROM family_artifacts WHERE room = ? "
        + "AND (member = ? OR id IN (SELECT artifact_id FROM family_artifact_grants WHERE member = ?)) "
        + "AND instr(lower(name), lower(?)) > 0 ORDER BY rowid DESC LIMIT 100",
    ).all(room, member, member, query.trim()) as unknown as FamilyArtifact[];
  }

  metadata(room: string, member: string, id: string): FamilyArtifact {
    const row = this.db.db.prepare(
      "SELECT " + SELECT_METADATA + " FROM family_artifacts WHERE room = ? AND id = ? "
        + "AND (member = ? OR id IN (SELECT artifact_id FROM family_artifact_grants WHERE member = ?))",
    ).get(room, id, member, member) as unknown as FamilyArtifact | undefined;
    if (!row) throw new Error("当前成员无法读取这个文件。");
    return row;
  }

  read(room: string, member: string, id: string): FamilyArtifact & { bytes: Buffer } {
    const row = this.db.db.prepare(
      "SELECT " + SELECT_METADATA + ", contents FROM family_artifacts WHERE room = ? AND id = ? "
        + "AND (member = ? OR id IN (SELECT artifact_id FROM family_artifact_grants WHERE member = ?))",
    ).get(room, id, member, member) as unknown as (FamilyArtifact & { contents: Uint8Array }) | undefined;
    if (!row) throw new Error("当前成员无法读取这个文件。");
    const { contents, ...metadata } = row;
    const bytes = Buffer.from(contents);
    if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw new Error("文件完整性校验失败。");
    return { ...metadata, bytes };
  }

  grant(room: string, owner: string, id: string, target: string, sourceKey: string): void {
    const current = this.db.db.prepare("SELECT id FROM family_artifacts WHERE room = ? AND member = ? AND id = ?")
      .get(room, owner, id);
    if (!current) throw new Error("仅原作者可以分享这个文件。");
    this.db.db.prepare(`
      INSERT INTO family_artifact_grants (artifact_id, member, source_key) VALUES (?, ?, ?)
      ON CONFLICT (artifact_id, member) DO NOTHING
    `).run(id, target, sourceKey);
  }
}
