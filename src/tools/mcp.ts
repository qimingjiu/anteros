import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { McpServerConfig } from "../config.js";
import type { ToolDef, ToolParamSchema, ToolContext, ToolImage } from "../types.js";
import { logger } from "../util/logger.js";
import { openManagedMcpResponse } from "../mcp-admin/remote.js";
import { readBounded } from "./web-http.js";
import { noteDialogResult } from "../agent/dialog-confirm.js";

const log = logger("mcp");
const PROTOCOL_VERSION = "2024-11-05";
const MAX_MCP_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_MCP_IMAGES = 4;
const MCP_IMAGE_MIME_TYPES = new Set<string>(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_MANAGED_RPC_BYTES = 24 * 1024 * 1024;

export interface ManagedMcpRunConfig extends McpServerConfig {
  isolatedStdio?: { directory: string; env: Record<string, string> };
  secureRemote?: boolean;
  credentials?: string[];
  protocolVersion?: "2025-11-25";
}
type McpScope = (context: ToolContext) => boolean;

function isMcpImageMime(value: unknown): value is ToolImage["mimeType"] {
  return typeof value === "string" && MCP_IMAGE_MIME_TYPES.has(value);
}

/**
 * 最小 MCP 客户端（v1，实验性）：
 * - stdio：换行分隔 JSON-RPC 2.0
 * - http：Streamable HTTP（POST 单请求，兼容 JSON 或 SSE 响应）
 * 支持 initialize / tools/list / tools/call。服务器主动通知按忽略处理。
 */

interface JsonRpcReq {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}
interface JsonRpcResp {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: ToolParamSchema;
}

abstract class McpConnection {
  protected nextId = 1;
  protected protocolVersion = PROTOCOL_VERSION;
  serverInfo = "";
  connected = false;
  error?: string;
  protected sanitizedConfig?: ManagedMcpRunConfig;

  canRequest(): boolean { return this.connected; }

  protected abstract send(body: object, timeoutMs: number): Promise<void>;
  protected abstract rpc(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<JsonRpcResp>;

  protected makeRequest(method: string, params?: Record<string, unknown>): JsonRpcReq {
    return { jsonrpc: "2.0", id: this.nextId++, method, params };
  }

  async initialize(timeoutMs: number): Promise<void> {
    const resp = await this.rpc("initialize", this.initializationParams(), timeoutMs);
    this.acceptInitialization(resp);
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs);
    this.connected = true;
    this.error = undefined;
    log.info(`MCP 已连接: ${this.serverInfo}`);
  }

  protected initializationParams(): Record<string, unknown> {
    return {
      protocolVersion: this.sanitizedConfig?.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "qq-group-bot", version: "0.1.0" },
    };
  }

  protected acceptInitialization(resp: JsonRpcResp): void {
    if (resp.error) throw new Error(`initialize 失败: ${resp.error.message}`);
    const negotiated = resp.result?.protocolVersion;
    if (typeof negotiated === "string") this.protocolVersion = negotiated;
    const info = resp.result?.serverInfo as { name?: string; version?: string } | undefined;
    const serverInfo = info ? `${info.name ?? "?"} ${info.version ?? ""}` : "?";
    this.serverInfo = this.sanitizedConfig ? safeMcpError(serverInfo, this.sanitizedConfig) : serverInfo;
  }

  async listTools(timeoutMs: number, maxTools = Infinity): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const resp = await this.rpc("tools/list", cursor ? { cursor } : {}, timeoutMs);
      if (resp.error) throw new Error(`tools/list 失败: ${resp.error.message}`);
      const page = resp.result?.tools;
      if (!Array.isArray(page)) throw new Error("tools/list 未返回工具列表");
      for (const tool of page) {
        if (!tool || typeof tool.name !== "string" || !tool.name) throw new Error("tools/list 包含无效工具名称");
        tools.push(tool as McpTool);
        if (tools.length > maxTools) throw new Error("MCP 工具数量超过上限");
      }
      const next = resp.result?.nextCursor;
      cursor = typeof next === "string" && next ? next : undefined;
      if (cursor) {
        if (cursors.has(cursor) || cursors.size >= 100) throw new Error("tools/list 分页游标重复或页数过多");
        cursors.add(cursor);
      }
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ text: string; images: ToolImage[] }> {
    const resp = await this.rpc("tools/call", { name, arguments: args }, timeoutMs);
    if (resp.error) throw new Error(`工具 ${name} 调用失败: ${resp.error.message}`);
    const result = resp.result as { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean } | undefined;
    const content = result?.content ?? [];
    const texts = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);
    const images: ToolImage[] = [];
    let droppedImages = 0;
    for (const c of content) {
      if (c.type !== "image") continue;
      if (images.length >= MAX_MCP_IMAGES || !isMcpImageMime(c.mimeType) || typeof c.data !== "string" || !c.data.trim()) {
        droppedImages++;
        continue;
      }
      // 以解码后的字节数限制大小，不能用 base64 字符串长度代替。
      const bytes = Buffer.from(c.data, "base64");
      if (!bytes.byteLength || bytes.byteLength > MAX_MCP_IMAGE_BYTES) {
        droppedImages++;
        continue;
      }
      images.push({ data: c.data, mimeType: c.mimeType });
    }
    const joined = texts.join("\n") || "(工具无文本输出)";
    const text = droppedImages
      ? `${joined}\n（因格式不支持、解码失败、单张超过 4MB 或单次最多 4 张，已丢弃 ${droppedImages} 张图片）`
      : joined;
    if (result?.isError) throw new Error(text);
    return { text, images };
  }

  abstract close(): Promise<void>;
}

function spawnStdio(cfg: ManagedMcpRunConfig): ChildProcess {
  const options = {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    env: { ...(cfg.isolatedStdio?.env ?? process.env), ...(cfg.env ?? {}) },
    cwd: cfg.isolatedStdio?.directory,
  };
  // Windows 的 npx/npm/pnpm/yarn 是 .cmd 包装；直接 spawn 会 ENOENT/EINVAL。
  if (process.platform === "win32" && /^(?:npx|npm|pnpm|yarn)$/i.test(cfg.command!)) {
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", cfg.command!, ...(cfg.args ?? [])], options);
  }
  return spawn(cfg.command!, cfg.args ?? [], options);
}

class StdioMcpConnection extends McpConnection {
  private child: ChildProcess;
  private buffer = "";
  private failure?: Error;
  private waiters = new Map<number, { resolve: (r: JsonRpcResp) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private cfg: ManagedMcpRunConfig, private rootLog = log) {
    super();
    this.sanitizedConfig = cfg;
    if (!cfg.command) throw new Error(`MCP 服务器 ${cfg.name} 缺少 command`);
    this.child = spawnStdio(cfg);
    this.child.stdout!.setEncoding("utf-8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (cfg.isolatedStdio && this.buffer.length > MAX_MANAGED_RPC_BYTES) {
        this.failPending(new Error("托管 MCP 返回数据超过上限"));
        this.buffer = "";
        this.child.kill();
        return;
      }
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResp & { id?: number; method?: string };
          if (msg.id != null && this.waiters.has(msg.id)) {
            const w = this.waiters.get(msg.id)!;
            this.waiters.delete(msg.id);
            clearTimeout(w.timer);
            w.resolve(msg);
          }
        } catch (e) {
          this.rootLog.debug(`MCP ${cfg.name} 非JSON输出（${Buffer.byteLength(line)} 字节）`);
        }
      }
    });
    this.child.stderr!.setEncoding("utf-8");
    this.child.stderr!.on("data", (chunk: string) => {
      this.rootLog.debug(`MCP ${cfg.name} stderr（${Buffer.byteLength(String(chunk))} 字节）`);
    });
    this.child.on("error", () => this.failPending(new Error(`MCP ${cfg.name} 进程未能启动`)));
    this.child.stdin?.on("error", () => this.failPending(new Error(`MCP ${cfg.name} 输入通道已关闭`)));
    this.child.on("exit", (code) => this.failPending(new Error(`MCP ${cfg.name} 进程退出 code=${code}`)));
  }

  private failPending(error: Error): void {
    this.connected = false;
    this.failure = error;
    this.error = error.message;
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  protected async send(body: object): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.child.stdin || this.child.killed) throw new Error(`MCP ${this.cfg.name} 进程不可用`);
    this.child.stdin.write(JSON.stringify(body) + "\n");
  }

  protected async rpc(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<JsonRpcResp> {
    const req = this.makeRequest(method, params);
    // 先注册等待者，避免子进程迅速响应时消息被丢弃。
    const response = this.waitForResponse(req.id, timeoutMs);
    try {
      await this.send(req);
      return await response;
    } catch (error) {
      const waiter = this.waiters.get(req.id);
      if (waiter) {
        this.waiters.delete(req.id);
        clearTimeout(waiter.timer);
        waiter.reject(error as Error);
      }
      void response.catch(() => {});
      throw error;
    }
  }

  protected waitForResponse(id: number, timeoutMs: number): Promise<JsonRpcResp> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`MCP ${this.cfg.name} 请求超时(${timeoutMs}ms)`));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
    });
  }

  async close(): Promise<void> {
    try {
      this.child.stdin?.end();
      this.child.kill();
    } catch { /* ignore */ }
  }
}

interface SseEvent { event: string; data: string }

/** 逐块读取 SSE；遇到目标响应即可退出，不等待长连接关闭。 */
async function readSse(response: Response, receive: (event: SseEvent) => boolean | void): Promise<void> {
  if (!response.body) throw new Error("MCP SSE 响应没有正文");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let dataSize = 0;
  let keepReading = true;
  const dispatch = () => {
    if (data.length) keepReading = receive({ event, data: data.join("\n") }) !== false;
    event = "message";
    data = [];
    dataSize = 0;
  };
  const line = (value: string) => {
    if (!value) { dispatch(); return; }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon === -1 ? value : value.slice(0, colon);
    const raw = colon === -1 ? "" : value.slice(colon + 1);
    const content = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") event = content;
    if (field === "data") {
      dataSize += content.length + 1;
      if (dataSize > 4 * 1024 * 1024) throw new Error("MCP SSE 事件过大");
      data.push(content);
    }
  };
  const drain = (final = false) => {
    while (keepReading) {
      const end = buffer.search(/[\r\n]/);
      if (end === -1 || (!final && buffer[end] === "\r" && end === buffer.length - 1)) break;
      const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
      line(buffer.slice(0, end));
      buffer = buffer.slice(end + width);
    }
  };
  try {
    while (keepReading) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      drain(done);
      if (buffer.length > 4 * 1024 * 1024) {
        throw new Error("MCP SSE 事件过大");
      }
      if (done) {
        if (keepReading && buffer) line(buffer);
        if (keepReading) dispatch();
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function responseFor(value: unknown, id: number): value is JsonRpcResp {
  return !!value && typeof value === "object" && (value as JsonRpcResp).id === id &&
    ("result" in value || "error" in value);
}

function safeMcpError(error: unknown, cfg: ManagedMcpRunConfig): string {
  return redactMcpCredentials(error instanceof Error ? error.message : String(error), cfg).slice(0, 300);
}

function redactMcpCredentials(value: string, cfg: ManagedMcpRunConfig): string {
  let message = value;
  if (cfg.url) {
    message = message.replaceAll(cfg.url, "[MCP endpoint]");
    try {
      for (const value of new URL(cfg.url).searchParams.values()) {
        if (value) message = message.replaceAll(value, "[redacted]");
      }
    } catch { /* invalid URLs are reported without exposing them */ }
  }
  for (const value of [...Object.values(cfg.headers ?? {}), ...cfg.credentials ?? []]) {
    if (value) message = message.replaceAll(value, "[redacted]");
    const credential = value.match(/^(?:Bearer|Basic)\s+(.+)$/i)?.[1];
    if (credential) message = message.replaceAll(credential, "[redacted]");
  }
  return message;
}

class SessionExpiredError extends Error {
  constructor(readonly expiredSession: string) { super("MCP HTTP 404: Session not found（协议会话已过期）"); }
}

class McpHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function explicitSessionMissing(text: string): boolean {
  let message = text.trim();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown };
    const value = typeof parsed.error === "string" ? parsed.error
      : parsed.error?.message ?? parsed.message ?? parsed.detail;
    if (typeof value === "string") message = value.trim();
  } catch { /* text/plain is also used for expired transport sessions */ }
  return /^(?:bad request:\s*)?session (?:not found|expired|does not exist)[.!]?$/i.test(message);
}

function mayReplay(body: JsonRpcReq, serverName: string): boolean {
  if (["tools/list", "ping", "resources/list", "resources/read", "prompts/list", "prompts/get"].includes(body.method)) return true;
  // Explicitly reviewed readonly commerce tools; arbitrary mutations are never replayed.
  return serverName === "cn-scraper" && body.method === "tools/call"
    && ["taobao_search", "jd_search", "taobao_product", "jd_product",
      "dianping_search", "dianping_shop", "dianping_reviews", "bilibili_search"].includes(String(body.params?.name))
    // xnews is a read-only X reader; its sessions idle out, so replay after renewal.
    || serverName === "xnews" && body.method === "tools/call"
    && ["x_search", "x_user_tweets", "x_tweet", "x_list", "x_trends"].includes(String(body.params?.name))
    // amap (高德) tools are all read-only lookups.
    || serverName === "amap" && body.method === "tools/call"
    || serverName === "taobao" && body.method === "tools/call"
    && ["taobao_search", "taobao_product"].includes(String(body.params?.name));
}

/** cn-scraper returns application failures as JSON text without MCP isError. */
function cnScraperFailure(output: string): boolean {
  try {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const result = value as { ok?: unknown; error?: unknown };
    if (result.ok === false) return true;
    return typeof result.error === "string" && !!result.error.trim()
      || !!result.error && typeof result.error === "object";
  } catch { return false; }
}

function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error("MCP 请求已中止")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

class HttpMcpConnection extends McpConnection {
  private readonly url: string;
  private sessionId?: string;
  private active = new Set<AbortController>();
  private closed = false;
  private initializedOnce = false;
  private renewal?: Promise<void>;
  constructor(private cfg: ManagedMcpRunConfig) {
    super();
    this.sanitizedConfig = cfg;
    this.protocolVersion = cfg.protocolVersion ?? PROTOCOL_VERSION;
    if (!cfg.url) throw new Error(`MCP 服务器 ${cfg.name} 缺少 url`);
    this.url = cfg.url;
  }

  override canRequest(): boolean { return !this.closed && this.initializedOnce; }

  override async initialize(timeoutMs: number): Promise<void> {
    await super.initialize(timeoutMs);
    this.initializedOnce = true;
  }

  private headers(accept = "application/json, text/event-stream"): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: accept,
      ...(this.cfg.headers ?? {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    headers["mcp-protocol-version"] = this.protocolVersion;
    return headers;
  }

  protected async send(body: object, timeoutMs: number): Promise<void> {
    await this.request(body as JsonRpcReq, timeoutMs);
  }

  protected async rpc(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<JsonRpcResp> {
    const response = await this.request(this.makeRequest(method, params), timeoutMs);
    if (!response) throw new Error(`MCP ${this.cfg.name} 未返回 RPC 响应`);
    if (response.error) response.error.message = safeMcpError(response.error.message, this.cfg);
    return response;
  }

  private async request(body: JsonRpcReq, timeoutMs: number): Promise<JsonRpcResp | undefined> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    this.active.add(ctrl);
    const deadline = Date.now() + timeoutMs;
    try {
      if (this.closed) throw new Error(`MCP ${this.cfg.name} 已关闭`);
      const handshake = ["initialize", "notifications/initialized"].includes(body.method);
      if (!handshake && this.initializedOnce && (this.renewal || !this.connected)) {
        await this.renew(ctrl.signal, deadline);
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await untilAbort(this.perform(body, ctrl.signal), ctrl.signal);
          this.error = undefined;
          return response;
        } catch (error) {
          if (!(error instanceof SessionExpiredError) || handshake) throw error;
          // A late rejection from the previous generation must not invalidate a healthy replacement.
          if (!this.sessionId || this.sessionId === error.expiredSession) this.connected = false;
          if (attempt > 0) throw error;
          await this.renew(ctrl.signal, deadline, error.expiredSession);
          if (!mayReplay(body, this.cfg.name)) throw new Error("MCP 会话已更新；该工具未自动重试，请明确重新发起");
        }
      }
      throw new Error("MCP 会话恢复后仍未返回响应");
    } catch (error) {
      const message = ctrl.signal.aborted && !this.closed ? `MCP ${this.cfg.name} 请求超时(${timeoutMs}ms)` : safeMcpError(error, this.cfg);
      if (error instanceof SessionExpiredError && (!this.sessionId || this.sessionId === error.expiredSession)
        || error instanceof McpHttpError && error.status !== 400
        || ctrl.signal.aborted || error instanceof TypeError) this.connected = false;
      this.error = message;
      throw new Error(message);
    } finally {
      clearTimeout(timer);
      this.active.delete(ctrl);
    }
  }

  private async perform(body: JsonRpcReq, signal: AbortSignal): Promise<JsonRpcResp | undefined> {
    const sentSession = body.method === "initialize" ? undefined : this.sessionId;
    const headers = this.headers();
    if (body.method === "initialize") delete headers["mcp-session-id"];
    const init = { method: "POST", headers, body: JSON.stringify(body), signal };
    const managed = this.cfg.secureRemote ? await openManagedMcpResponse(this.url, init) : undefined;
    const response = managed?.response ?? await fetch(this.url, init);
    try {
      if (signal.aborted) { await response.body?.cancel(); throw new Error("MCP 请求已中止"); }
      if (!response.ok) {
        const text = managed ? new TextDecoder().decode((await readBounded(response, 4096)).bytes) : await response.text();
        if (response.status === 404 && sentSession && explicitSessionMissing(text)) throw new SessionExpiredError(sentSession);
        throw new McpHttpError(response.status, managed ? `MCP HTTP ${response.status}` : `MCP HTTP ${response.status}: ${text.slice(0, 150)}`);
      }
      const assignedSession = response.headers.get("mcp-session-id");
      if (body.method === "initialize" && assignedSession) this.sessionId = assignedSession;
      if (body.id === undefined) { await response.body?.cancel(); return; }
      return await this.readResponse(response, body.id);
    } finally {
      await managed?.close();
    }
  }

  private async renew(signal: AbortSignal, deadline: number, expiredSession?: string): Promise<void> {
    if (signal.aborted || this.closed) throw new Error("MCP 请求已中止");
    if (expiredSession && this.connected && this.sessionId && this.sessionId !== expiredSession) return;
    if (!this.renewal) {
      this.connected = false;
      this.sessionId = undefined;
      this.protocolVersion = this.cfg.protocolVersion ?? PROTOCOL_VERSION;
      const controller = new AbortController();
      this.active.add(controller);
      const remaining = Math.max(1, deadline - Date.now());
      const timer = setTimeout(() => controller.abort(), remaining);
      const handshake = (async () => {
        const initialized = await this.perform(this.makeRequest("initialize", this.initializationParams()), controller.signal);
        if (!initialized) throw new Error("MCP 会话初始化未返回响应");
        this.acceptInitialization(initialized);
        await this.perform({ jsonrpc: "2.0", method: "notifications/initialized" } as JsonRpcReq, controller.signal);
      })();
      this.renewal = untilAbort(handshake, controller.signal).then(() => {
        if (this.closed) throw new Error("MCP 连接已关闭");
        this.connected = true;
        this.error = undefined;
        log.info(`MCP ${this.cfg.name} 协议会话已恢复`);
      }).catch(error => {
        this.connected = false;
        this.sessionId = undefined;
        this.error = controller.signal.aborted && !this.closed
          ? `MCP ${this.cfg.name} 协议会话恢复超时` : safeMcpError(error, this.cfg);
        throw new Error(this.error);
      }).finally(() => {
        clearTimeout(timer);
        this.active.delete(controller);
        this.renewal = undefined;
      });
    }
    await untilAbort(this.renewal, signal);
  }

  private async readResponse(response: Response, id: number): Promise<JsonRpcResp> {
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      let result: JsonRpcResp | undefined;
      await readSse(response, ({ data }) => {
        try {
          const value: unknown = JSON.parse(data);
          if (responseFor(value, id)) { result = value; return false; }
        } catch { /* SSE notifications and unrelated events are ignored */ }
      });
      if (result) return result;
    } else {
      const managed = this.cfg.secureRemote ? await readBounded(response, MAX_MANAGED_RPC_BYTES) : undefined;
      if (managed?.truncated) throw new Error("托管 MCP 返回数据超过上限");
      const text = managed ? new TextDecoder().decode(managed.bytes) : await response.text();
      if (text.trim()) {
        const value: unknown = JSON.parse(text);
        if (responseFor(value, id)) return value;
      }
    }
    throw new Error(`MCP ${this.cfg.name} 响应缺少匹配的 RPC id`);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    for (const ctrl of this.active) ctrl.abort();
  }
}

export interface McpServerStatus {
  name: string;
  transport: string;
  connected: boolean;
  tools: number;
  error?: string;
  serverInfo?: string;
}

export class McpManager {
  private connections = new Map<string, McpConnection>();
  private tools = new Map<string, ToolDef[]>();
  private managed = new Map<string, McpScope>();
  private errors = new Map<string, string>();

  constructor(
    private cfg: { enabled: boolean; connectTimeoutMs: number; callTimeoutMs: number; servers: McpServerConfig[]; denyTools?: string[] },
    private toolAllowed: (tool: ToolDef) => boolean = () => true,
  ) {}

  statuses(): McpServerStatus[] {
    return this.cfg.servers.map((s) => {
      const conn = this.connections.get(s.name);
      return {
        name: s.name,
        transport: s.transport,
        connected: conn?.connected ?? false,
        error: this.errors.get(s.name) ?? conn?.error,
        tools: conn ? this.tools.get(s.name)?.length ?? 0 : 0,
        serverInfo: conn?.serverInfo,
      };
    });
  }

  async start(): Promise<void> {
    if (!this.cfg.enabled) return;
    for (const s of this.cfg.servers) {
      try {
        await this.connect(s);
        this.errors.delete(s.name);
      } catch (e) {
        const message = safeMcpError(e, s);
        this.errors.set(s.name, message);
        log.warn(`MCP ${s.name} 连接失败:`, message);
      }
    }
  }

  hasStaticServer(name: string): boolean { return this.cfg.servers.some(server => server.name === name); }

  async upsertManaged(server: ManagedMcpRunConfig, scope: McpScope): Promise<void> {
    if (!this.cfg.enabled) throw new Error("MCP 当前未启用");
    if (this.hasStaticServer(server.name)) throw new Error("服务名与已有 MCP 配置重复");
    // Keep the old connection available until the replacement handshake and tool listing succeed.
    await this.connect(server, scope);
  }

  async removeManaged(name: string): Promise<void> {
    if (!this.managed.delete(name)) return;
    const connection = this.connections.get(name);
    this.connections.delete(name);
    this.tools.delete(name);
    await connection?.close();
  }

  managedStatus(name: string): { connected: boolean; tools: number } {
    const conn = this.managed.has(name) ? this.connections.get(name) : undefined;
    return { connected: conn?.connected ?? false, tools: conn ? this.tools.get(name)?.length ?? 0 : 0 };
  }

  private async connect(server: ManagedMcpRunConfig, scope?: McpScope): Promise<void> {
    const connection = server.transport === "stdio" ? new StdioMcpConnection(server) : new HttpMcpConnection(server);
    let definitions: ToolDef[];
    try {
      await connection.initialize(this.cfg.connectTimeoutMs);
      const discovered = await connection.listTools(this.cfg.connectTimeoutMs, scope ? 500 : Infinity);
      definitions = this.buildTools(server, connection, discovered, scope);
      log.info(`MCP ${server.name}: ${discovered.length} 个工具`);
    } catch (error) {
      await connection.close();
      throw new Error(safeMcpError(error, server));
    }
    const previous = this.connections.get(server.name);
    if (scope) this.managed.set(server.name, scope);
    this.connections.set(server.name, connection);
    this.tools.set(server.name, definitions);
    await previous?.close();
  }

  private buildTools(server: ManagedMcpRunConfig, connection: McpConnection, tools: McpTool[], scope?: McpScope): ToolDef[] {
    const definitions: ToolDef[] = [];
    const denied = (this.cfg.denyTools ?? []).map(d => d.toLowerCase());
    for (const tool of tools) {
      if (server.allowTools !== undefined && !server.allowTools.includes(tool.name)) continue;
      const fullName = `mcp__${server.name}__${tool.name}`;
      if (denied.some(d => fullName.toLowerCase().includes(d))) continue;
      const usableName = /^[a-zA-Z0-9_-]{1,64}$/.test(fullName) && (!scope || redactMcpCredentials(fullName, server) === fullName);
      const name = !scope || usableName ? fullName : `mcp__${server.name}__${createHash("sha256").update(tool.name).digest("hex").slice(0, 16)}`;
      const description = server.name === "cn-scraper" && tool.name === "dianping_search"
        ? "搜索大众点评商户。city是真正的城市筛选，长沙/长沙市=344、上海/上海市=1，也接受有效数字城市ID。查某城市必须显式传city；不传默认上海，未知城市名称明确报错。keyword为店名、菜品或关键词，limit为数量。仅返回商户名、ID和链接，不能据此声称已核实评分、包厢或其他未返回信息。"
        : tool.description ?? tool.name;
      const definition: ToolDef = {
        name,
        description: `[MCP:${server.name}] ${scope ? redactMcpCredentials(description, server) : description}`,
        inputSchema: scope ? cleanManagedSchema(tool.inputSchema, server) : tool.inputSchema ?? { type: "object" },
        private: scope ? true : undefined,
        execute: async (args, context) => {
          if (!this.toolAllowed(definition) || (scope && !scope(context))) throw new Error("该工具当前不可用");
          const current = this.connections.get(server.name);
          if (!current || (scope && current !== connection) || !current.canRequest()) throw new Error(`MCP 服务器 ${server.name} 未连接`);
          let output: Awaited<ReturnType<McpConnection["callTool"]>>;
          try { output = await current.callTool(tool.name, args, this.cfg.callTimeoutMs); }
          catch (error) { if (scope) throw new Error(safeMcpError(error, server)); throw error; }
          if (server.name === "cn-scraper" && cnScraperFailure(output.text)) throw new Error(`cn-scraper 网站工具失败: ${safeMcpError(output.text, server)}`);
          // Revocation may occur while a network request is in flight.
          if (scope && (this.connections.get(server.name) !== connection || !scope(context))) throw new Error("该工具当前不可用");
          if (server.name === "phone" && tool.name === "dialog") { try { noteDialogResult(context, args, output.text); } catch {} }
          if (output.images.length) context.onImages?.(output.images);
          return scope ? redactMcpCredentials(output.text, server) : output.text;
        },
      };
      if (this.toolAllowed(definition)) definitions.push(definition);
    }
    return definitions;
  }

  getTools(context?: ToolContext): ToolDef[] {
    return [...this.tools].flatMap(([name, tools]) => {
      const scope = this.managed.get(name);
      return !scope || (context && scope(context) && this.connections.get(name)?.canRequest()) ? tools : [];
    });
  }

  async stop(): Promise<void> {
    for (const c of this.connections.values()) await c.close();
    this.connections.clear();
    this.errors.clear();
    this.tools.clear();
    this.managed.clear();
  }
}

function cleanManagedSchema(schema: ToolParamSchema | undefined, server: ManagedMcpRunConfig): ToolParamSchema {
  const clean = (value: unknown, depth: number): unknown => {
    if (depth > 24) throw new Error("MCP 工具参数结构过深");
    if (typeof value === "string") return redactMcpCredentials(value, server);
    if (Array.isArray(value)) return value.map(item => clean(item, depth + 1));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactMcpCredentials(key, server), clean(item, depth + 1)]));
    }
    return value;
  };
  return clean(schema ?? { type: "object" }, 0) as ToolParamSchema;
}
