import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SECRET_REF } from "./manifest.js";

interface VaultRow { payload: string }
export class McpCredentialVault {
  private key?: Promise<Buffer>;

  constructor(private readonly db: DatabaseSync, private readonly directory: string) {
    db.exec("CREATE TABLE IF NOT EXISTS managed_mcp_credentials(ref TEXT PRIMARY KEY, payload TEXT NOT NULL)");
  }

  private getKey(): Promise<Buffer> {
    if (this.key) return this.key;
    this.key = this.loadKey().catch(error => { this.key = undefined; throw error; });
    return this.key;
  }

  private async loadKey(): Promise<Buffer> {
    const configured = process.env.ANTEROS_MCP_SECRET_KEY;
    if (configured !== undefined) {
      if (!/^[0-9a-f]{64}$/i.test(configured)) throw new Error("ANTEROS_MCP_SECRET_KEY 必须是 32 字节十六进制值");
      return Buffer.from(configured, "hex");
    }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const keyFile = path.join(this.directory, "vault.key");
    try {
      const existing = await fs.lstat(keyFile);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== 32) throw new Error("MCP 密钥文件无效");
      return await fs.readFile(keyFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (this.list().length) throw new Error("找不到已有凭据的加密密钥");
      const key = randomBytes(32);
      try { await fs.writeFile(keyFile, key, { mode: 0o600, flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return this.loadKey(); throw error; }
      return key;
    }
  }

  list(): string[] {
    return (this.db.prepare("SELECT ref FROM managed_mcp_credentials ORDER BY ref").all() as { ref: string }[]).map(row => row.ref);
  }

  async write(ref: string, value: string): Promise<void> {
    if (!SECRET_REF.test(ref) || !value || value.length > 4000 || /[\r\n\0]/.test(value)) throw new Error("凭据引用或值无效");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await this.getKey(), nonce);
    cipher.setAAD(Buffer.from(ref));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const payload = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
    this.db.prepare("INSERT INTO managed_mcp_credentials(ref,payload) VALUES(?,?) ON CONFLICT(ref) DO UPDATE SET payload=excluded.payload").run(ref, payload);
  }

  async resolve(ref: string): Promise<string> {
    const row = this.db.prepare("SELECT payload FROM managed_mcp_credentials WHERE ref=?").get(ref) as VaultRow | undefined;
    if (!row) throw new MissingMcpCredential(ref);
    const payload = Buffer.from(row.payload, "base64");
    try {
      const decipher = createDecipheriv("aes-256-gcm", await this.getKey(), payload.subarray(0, 12));
      decipher.setAAD(Buffer.from(ref));
      decipher.setAuthTag(payload.subarray(12, 28));
      return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
    } catch { throw new Error("MCP 凭据无法解密，请检查密钥后在面板重新填写"); }
  }
}

export class MissingMcpCredential extends Error {
  constructor(readonly ref: string) { super(`缺少凭据引用 ${ref}`); }
}
