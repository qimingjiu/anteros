import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { McpManager, ManagedMcpRunConfig } from "../tools/mcp.js";
import { readBounded } from "../tools/web-http.js";
import { logger } from "../util/logger.js";
import { asObject, MCP_ID, validateManagedManifest, type ManagedMcpManifest } from "./manifest.js";
import { deployManagedLocal, managedLocalLaunch, managedRuntimeEnv } from "./local.js";
import { McpCredentialVault, MissingMcpCredential } from "./vault.js";

const MAX_QUEUED_JOBS = 16;
const MAX_SERVICES = 64;
const REGISTRY_TTL = 60 * 60_000;
const log = logger("mcp-admin");
type JobAction = "install" | "update" | "enable" | "disable" | "restart" | "uninstall";
type JobState = "queued" | "running" | "succeeded" | "failed" | "awaiting_input" | "interrupted";
type ServiceRow = { id: string; manifest: string; deployment: string | null; enabled: number; updated_at: string };
interface Service { manifest: ManagedMcpManifest; deployment: string | null; enabled: boolean; updatedAt: string }
interface ManagedJob { id: string; service: string; action: JobAction; status: JobState; updatedAt: string; error?: string }
interface RegistryListing {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  packages: { kind: "npm" | "python"; package: string; version: string }[];
  remotes: { url: string; type: string }[];
}

export interface McpAdminOptions {
  db: DatabaseSync;
  manager: Pick<McpManager, "hasStaticServer" | "upsertManaged" | "removeManaged" | "managedStatus">;
  directory: string;
  isOwner(accountId: string, requesterId: string): boolean;
  fetch?: typeof fetch;
  deploy?: typeof deployManagedLocal;
  launch?: typeof managedLocalLaunch;
}

function serviceOf(row: ServiceRow): Service {
  return { manifest: validateManagedManifest(JSON.parse(row.manifest)), deployment: row.deployment,
    enabled: row.enabled === 1, updatedAt: row.updated_at };
}

export class McpAdmin {
  readonly vault: McpCredentialVault;
  private readonly directory: string;
  private readonly abort = new AbortController();
  private readonly forService = new Set<string>();
  private readonly restoreErrors = new Map<string, string>();
  private readonly cache = new Map<string, { at: number; results: RegistryListing[] }>();
  private queue = Promise.resolve();

  constructor(private readonly options: McpAdminOptions) {
    const { db } = options;
    this.directory = path.resolve(options.directory);
    this.vault = new McpCredentialVault(db, this.directory);
    db.exec(`
      CREATE TABLE IF NOT EXISTS managed_mcp_services (
        id TEXT PRIMARY KEY, manifest TEXT NOT NULL, deployment TEXT, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS managed_mcp_jobs (
        id TEXT PRIMARY KEY, service TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
        updatedAt TEXT NOT NULL, error TEXT, input_manifest TEXT
      );
      UPDATE managed_mcp_jobs SET status='interrupted', error='网关重启，中断的部署没有自动重跑'
      WHERE status IN ('queued','running');
    `);
    const columns = db.prepare("PRAGMA table_info(managed_mcp_jobs)").all() as { name: string }[];
    if (!columns.some(column => column.name === "input_manifest")) db.exec("ALTER TABLE managed_mcp_jobs ADD COLUMN input_manifest TEXT");
  }

  private service(id: string): Service | undefined {
    const row = this.options.db.prepare("SELECT * FROM managed_mcp_services WHERE id=?").get(id) as ServiceRow | undefined;
    return row ? serviceOf(row) : undefined;
  }

  private rows(): ServiceRow[] {
    return this.options.db.prepare("SELECT * FROM managed_mcp_services ORDER BY id").all() as ServiceRow[];
  }

  list(): Array<{ manifest: ManagedMcpManifest; enabled: boolean; updatedAt: string; connected: boolean; tools: number; error?: string }> {
    return this.rows().map(row => {
      const { manifest, enabled, updatedAt } = serviceOf(row);
      return { manifest, enabled, updatedAt, ...this.options.manager.managedStatus(manifest.id), error: this.restoreErrors.get(manifest.id) };
    });
  }

  jobs(): ManagedJob[] {
    return this.options.db.prepare("SELECT id,service,action,status,updatedAt,error FROM managed_mcp_jobs ORDER BY rowid DESC LIMIT 32").all() as unknown as ManagedJob[];
  }

  job(id: string): ManagedJob | undefined {
    return this.options.db.prepare("SELECT id,service,action,status,updatedAt,error FROM managed_mcp_jobs WHERE id=?").get(id) as unknown as ManagedJob | undefined;
  }

  restore(): Promise<void> {
    this.queue = this.queue.then(async () => {
      for (const row of this.rows()) {
        if (!row.enabled || this.abort.signal.aborted) continue;
        try {
          await this.mount(serviceOf(row));
          this.restoreErrors.delete(row.id);
        } catch (error) {
          this.restoreErrors.set(row.id, displayError(error));
        }
      }
    }).catch(() => { log.warn("托管 MCP 注册读取失败"); });
    return this.queue;
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.queue;
  }

  submit(action: unknown, input: { id?: unknown; manifest?: unknown }): ManagedJob {
    if (this.abort.signal.aborted) throw new Error("MCP 管理正在关闭");
    if (action !== "install" && action !== "update" && action !== "enable" && action !== "disable" && action !== "restart" && action !== "uninstall") {
      throw new Error("未知 MCP 管理操作");
    }
    const manifest = action === "install" || action === "update" ? validateManagedManifest(input.manifest) : undefined;
    const id = input.id ?? manifest?.id;
    if (typeof id !== "string" || !MCP_ID.test(id) || (manifest && manifest.id !== id)) throw new Error("MCP ID 无效或与清单不符");
    if (this.forService.has(id) || this.forService.size >= MAX_QUEUED_JOBS) throw new Error("该服务正在管理，或部署队列已满");
    if (this.options.manager.hasStaticServer(id)) throw new Error("MCP ID 与已有静态配置冲突");
    if (action === "install") {
      if (this.service(id)) throw new Error("服务已存在，请使用更新");
      if (this.rows().length + this.forService.size >= MAX_SERVICES) throw new Error("托管 MCP 数量已达上限");
    } else if (!this.service(id)) throw new Error("服务不存在");
    const job: ManagedJob = { id: randomUUID(), service: id, action, status: "queued", updatedAt: now() };
    this.options.db.prepare("INSERT INTO managed_mcp_jobs(id,service,action,status,updatedAt,input_manifest) VALUES(?,?,?,?,?,?)")
      .run(job.id, id, action, job.status, job.updatedAt, manifest ? JSON.stringify(manifest) : null);
    this.forService.add(id);
    this.queue = this.queue.then(async () => {
      if (this.abort.signal.aborted) { this.jobState(job.id, "interrupted"); return; }
      this.jobState(job.id, "running");
      try {
        await this.perform(action, id, manifest);
        this.jobState(job.id, "succeeded");
      } catch (error) {
        const status = this.abort.signal.aborted ? "interrupted" : error instanceof MissingMcpCredential ? "awaiting_input" : "failed";
        this.jobState(job.id, status, displayError(error));
      }
    }).catch(() => { log.warn("托管 MCP 作业状态写入失败"); }).finally(() => { this.forService.delete(id); });
    return job;
  }

  retry(id: string): ManagedJob {
    const statement = this.options.db.prepare("SELECT service,action,status,input_manifest FROM managed_mcp_jobs WHERE id=?");
    const row = statement.get(id) as { service: string; action: JobAction; status: JobState; input_manifest: string | null } | undefined;
    if (!row || !["failed", "awaiting_input", "interrupted"].includes(row.status)) throw new Error("该任务不可重试");
    return this.submit(row.action, { id: row.service, manifest: row.input_manifest ? JSON.parse(row.input_manifest) : undefined });
  }

  private jobState(id: string, state: JobState, error?: string): void {
    this.options.db.prepare("UPDATE managed_mcp_jobs SET status=?,updatedAt=?,error=? WHERE id=?")
      .run(state, now(), error ?? null, id);
    this.options.db.prepare(`DELETE FROM managed_mcp_jobs WHERE status NOT IN ('queued','running')
      AND id NOT IN (SELECT id FROM managed_mcp_jobs ORDER BY rowid DESC LIMIT 128)`).run();
  }

  private save(service: Service): void {
    this.options.db.prepare(`INSERT INTO managed_mcp_services VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest,deployment=excluded.deployment,enabled=excluded.enabled,updated_at=excluded.updated_at`)
      .run(service.manifest.id, JSON.stringify(service.manifest), service.deployment, Number(service.enabled), service.updatedAt);
  }

  private deploymentPath(manifest: ManagedMcpManifest, deployment: string): string {
    if (!MCP_ID.test(manifest.id) || !/^[a-f0-9-]{36}$/.test(deployment)) throw new Error("托管 MCP 部署标识无效");
    return path.join(this.directory, "installs", manifest.id, deployment);
  }

  private async cleanupDeployment(manifest: ManagedMcpManifest, deployment: string | null): Promise<void> {
    if (!deployment) return;
    try {
      const installs = path.join(this.directory, "installs");
      const root = await fs.realpath(installs);
      if (path.relative(await fs.realpath(this.directory), root) !== "installs") return;
      const candidate = this.deploymentPath(manifest, deployment);
      const resolved = await fs.realpath(candidate);
      // Windows junctions and symlinks must not move the deletion outside the managed install tree.
      if (path.relative(root, resolved) !== path.join(manifest.id, deployment)) return;
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 2 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("无法清理旧 MCP 部署");
    }
  }

  private async credentials(refs: Record<string, string>): Promise<Record<string, string>> {
    return Object.fromEntries(await Promise.all(Object.entries(refs).map(async ([name, ref]) => [name, await this.vault.resolve(ref)])));
  }

  private async config(service: Service): Promise<ManagedMcpRunConfig> {
    const { manifest } = service;
    const base = { name: manifest.id, allowTools: manifest.allowedTools, protocolVersion: "2025-11-25" as const };
    if (manifest.kind === "remote") {
      const headers = await this.credentials(manifest.secretHeaders);
      if (Object.values(headers).some(value => /[^\x09\x20-\x7e\x80-\xff]/.test(value))) throw new Error("MCP 请求头凭据值无效");
      return { ...base, transport: "http", url: manifest.url, headers, secureRemote: true };
    }
    if (!service.deployment) throw new Error("找不到本地 MCP 部署");
    const directory = this.deploymentPath(manifest, service.deployment);
    const launch = await (this.options.launch ?? managedLocalLaunch)(manifest, directory);
    const secrets = await this.credentials(manifest.secretEnv);
    return { ...base, ...launch, transport: "stdio",
      isolatedStdio: { directory, env: managedRuntimeEnv(directory) }, env: { ...manifest.env, ...secrets }, credentials: Object.values(secrets) };
  }

  private async mount(service: Service): Promise<void> {
    const config = await this.config(service);
    this.abort.signal.throwIfAborted();
    await this.options.manager.upsertManaged(config, ctx => !!(ctx.isPrivate && ctx.requesterId && ctx.personaId && ctx.roomId
      && this.options.isOwner(ctx.accountId, ctx.requesterId)
      && service.manifest.allowedAgents.includes(ctx.personaId) && service.manifest.allowedRooms.includes(ctx.roomId)));
  }

  private async perform(action: JobAction, id: string, manifest?: ManagedMcpManifest): Promise<void> {
    const previous = this.service(id);
    if (manifest) {
      // Resolve references before installing packages so missing input stays cheap to fix.
      await this.credentials(manifest.kind === "remote" ? manifest.secretHeaders : manifest.secretEnv);
      const deployment = manifest.kind === "remote" ? null : randomUUID();
      try {
        if (manifest.kind !== "remote" && deployment) {
          await (this.options.deploy ?? deployManagedLocal)(manifest, this.deploymentPath(manifest, deployment), this.abort.signal);
        }
        const current = { manifest, deployment, enabled: previous?.enabled ?? true, updatedAt: now() };
        await this.replace(previous, current);
      } catch (error) {
        await this.cleanupDeployment(manifest, deployment);
        throw error;
      }
      if (previous) await this.cleanupDeployment(previous.manifest, previous.deployment);
    } else {
      if (!previous) throw new Error("服务不存在");
      if (action === "uninstall") {
        this.options.db.prepare("DELETE FROM managed_mcp_services WHERE id=?").run(id);
        await this.options.manager.removeManaged(id);
        await this.cleanupDeployment(previous.manifest, previous.deployment);
      } else if (action === "disable") {
        this.save({ ...previous, enabled: false, updatedAt: now() });
        await this.options.manager.removeManaged(id);
      } else {
        await this.replace(previous, { ...previous, enabled: true, updatedAt: now() });
      }
    }
    this.restoreErrors.delete(id);
  }

  private async replace(previous: Service | undefined, current: Service): Promise<void> {
    if (current.enabled) await this.mount(current);
    try {
      this.abort.signal.throwIfAborted();
      this.save(current);
    } catch (error) {
      if (current.enabled) {
        if (previous?.enabled && !this.abort.signal.aborted) {
          await this.mount(previous).catch(() => this.options.manager.removeManaged(current.manifest.id));
        } else await this.options.manager.removeManaged(current.manifest.id);
      }
      throw error;
    }
  }

  async search(query: string): Promise<{ cached: boolean; results: RegistryListing[] }> {
    const key = query.trim().toLowerCase();
    if (!key || key.length > 100 || /[\x00-\x1f]/.test(key)) throw new Error("请填写 1 至 100 字的 MCP 搜索词");
    const cache = this.cache.get(key);
    if (cache && Date.now() - cache.at < REGISTRY_TTL) return { cached: true, results: cache.results };
    const url = new URL("https://registry.modelcontextprotocol.io/v0.1/servers");
    url.search = new URLSearchParams({ search: key, limit: "20", version: "latest" }).toString();
    let result: unknown;
    try {
      const request = this.options.fetch ?? fetch;
      const response = await request(url, { redirect: "error", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const data = await readBounded(response, 1024 * 1024);
      if (data.truncated) throw new Error();
      result = JSON.parse(new TextDecoder().decode(data.bytes));
    } catch { throw new Error("MCP Registry 暂时不可用"); }
    const entries = asObject(result)?.servers;
    if (!Array.isArray(entries)) throw new Error("MCP Registry 返回未知格式");
    const listings = entries.slice(0, 20).map(value => registryListing(asObject(value)?.server)).filter((entry): entry is RegistryListing => !!entry);
    if (this.cache.size >= 64 && !this.cache.has(key)) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { at: Date.now(), results: listings });
    return { cached: false, results: listings };
  }
}

const now = () => new Date().toISOString();
function displayError(error: unknown): string {
  // Package commands and credential values are never included in stored failures.
  return (error instanceof Error ? error.message : "MCP 操作未完成").replace(/[\r\n\0]/g, " ").slice(0, 250);
}

function registryListing(input: unknown): RegistryListing | undefined {
  const server = asObject(input);
  if (!server || typeof server.name !== "string") return;
  const packages: RegistryListing["packages"] = [];
  const remotes: RegistryListing["remotes"] = [];
  for (const value of Array.isArray(server.packages) ? server.packages.slice(0, 8) : []) {
    const item = asObject(value);
    if (!item || typeof item.identifier !== "string" || typeof item.version !== "string") continue;
    const kind = item.registryType === "npm" ? "npm" : item.registryType === "pypi" ? "python" : undefined;
    if (kind) packages.push({ kind, package: item.identifier.slice(0, 150), version: item.version.slice(0, 64) });
  }
  for (const value of Array.isArray(server.remotes) ? server.remotes.slice(0, 8) : []) {
    const item = asObject(value);
    if (!item || typeof item.url !== "string" || item.type !== "streamable-http") continue;
    remotes.push({ url: item.url.slice(0, 2048), type: item.type });
  }
  return { name: server.name.slice(0, 180), title: typeof server.title === "string" ? server.title.slice(0, 160) : undefined,
    description: typeof server.description === "string" ? server.description.slice(0, 300) : undefined,
    version: typeof server.version === "string" ? server.version.slice(0, 64) : undefined, packages, remotes };
}
