import { spawn, type ChildProcess } from "node:child_process";
import type { McpServerConfig } from "../config.js";
import type { ToolDef, ToolParamSchema, ToolContext } from "../types.js";
import { logger } from "../util/logger.js";

const log = logger("mcp");
const PROTOCOL_VERSION = "2024-11-05";

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
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "qq-group-bot", version: "0.1.0" },
    };
  }

  protected acceptInitialization(resp: JsonRpcResp): void {
    if (resp.error) throw new Error(`initialize 失败: ${resp.error.message}`);
    const negotiated = resp.result?.protocolVersion;
    if (typeof negotiated === "string") this.protocolVersion = negotiated;
    const info = resp.result?.serverInfo as { name?: string; version?: string } | undefined;
    this.serverInfo = info ? `${info.name ?? "?"} ${info.version ?? ""}` : "?";
  }

  async listTools(timeoutMs: number): Promise<McpTool[]> {
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

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const resp = await this.rpc("tools/call", { name, arguments: args }, timeoutMs);
    if (resp.error) throw new Error(`工具 ${name} 调用失败: ${resp.error.message}`);
    const result = resp.result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
    const texts = (result?.content ?? [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);
    const joined = texts.join("\n") || "(工具无文本输出)";
    if (result?.isError) throw new Error(joined);
    return joined;
  }

  abstract close(): Promise<void>;
}

class StdioMcpConnection extends McpConnection {
  private child: ChildProcess;
  private buffer = "";
  private waiters = new Map<number, { resolve: (r: JsonRpcResp) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private cfg: McpServerConfig, private rootLog = log) {
    super();
    if (!cfg.command) throw new Error(`MCP 服务器 ${cfg.name} 缺少 command`);
    this.child = spawn(cfg.command, cfg.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.setEncoding("utf-8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
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
    this.child.on("exit", (code) => {
      this.connected = false;
      for (const [, w] of this.waiters) {
        clearTimeout(w.timer);
        w.reject(new Error(`MCP ${cfg.name} 进程退出 code=${code}`));
      }
      this.waiters.clear();
    });
  }

  protected async send(body: object): Promise<void> {
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

function safeMcpError(error: unknown, cfg: McpServerConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  if (cfg.url) {
    message = message.replaceAll(cfg.url, "[MCP endpoint]");
    try {
      for (const value of new URL(cfg.url).searchParams.values()) {
        if (value) message = message.replaceAll(value, "[redacted]");
      }
    } catch { /* invalid URLs are reported without exposing them */ }
  }
  for (const value of Object.values(cfg.headers ?? {})) {
    if (value) message = message.replaceAll(value, "[redacted]");
    const credential = value.match(/^(?:Bearer|Basic)\s+(.+)$/i)?.[1];
    if (credential) message = message.replaceAll(credential, "[redacted]");
  }
  return message.slice(0, 300);
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
      "dianping_search", "dianping_shop", "dianping_reviews"].includes(String(body.params?.name));
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
  constructor(private cfg: McpServerConfig) {
    super();
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
    const response = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (signal.aborted) { await response.body?.cancel(); throw new Error("MCP 请求已中止"); }
    if (!response.ok) {
      const text = await response.text();
      if (response.status === 404 && sentSession && explicitSessionMissing(text)) throw new SessionExpiredError(sentSession);
      throw new McpHttpError(response.status, `MCP HTTP ${response.status}: ${text.slice(0, 150)}`);
    }
    const assignedSession = response.headers.get("mcp-session-id");
    if (body.method === "initialize" && assignedSession) this.sessionId = assignedSession;
    if (body.id === undefined) { await response.body?.cancel(); return; }
    return this.readResponse(response, body.id);
  }

  private async renew(signal: AbortSignal, deadline: number, expiredSession?: string): Promise<void> {
    if (signal.aborted || this.closed) throw new Error("MCP 请求已中止");
    if (expiredSession && this.connected && this.sessionId && this.sessionId !== expiredSession) return;
    if (!this.renewal) {
      this.connected = false;
      this.sessionId = undefined;
      this.protocolVersion = PROTOCOL_VERSION;
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
      const text = await response.text();
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
  private tools: ToolDef[] = [];
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
        tools: conn ? this.tools.filter((t) => t.name.startsWith(`mcp__${s.name}__`)).length : 0,
        serverInfo: conn?.serverInfo,
      };
    });
  }

  async start(): Promise<void> {
    if (!this.cfg.enabled) return;
    for (const s of this.cfg.servers) {
      let conn: McpConnection | undefined;
      try {
        conn = s.transport === "stdio" ? new StdioMcpConnection(s) : new HttpMcpConnection(s);
        await conn.initialize(this.cfg.connectTimeoutMs);
        const mcpTools = await conn.listTools(this.cfg.connectTimeoutMs);
        this.connections.set(s.name, conn);
        this.errors.delete(s.name);
        const denied = (this.cfg.denyTools ?? []).map((d) => d.toLowerCase());
        for (const t of mcpTools) {
          if (s.allowTools !== undefined && !s.allowTools.includes(t.name)) continue;
          const fullName = `mcp__${s.name}__${t.name}`.toLowerCase();
          if (denied.some((d) => fullName.includes(d))) {
            log.info(`MCP 工具被 deny_tools 排除: ${s.name}/${t.name}`);
            continue;
          }
          const def: ToolDef = {
            name: `mcp__${s.name}__${t.name}`,
            description: `[MCP:${s.name}] ${s.name === 'cn-scraper' && t.name === 'dianping_search'
              ? '搜索大众点评商户。city是真正的城市筛选，长沙/长沙市=344、上海/上海市=1，也接受有效数字城市ID。查某城市必须显式传city；不传默认上海，未知城市名称明确报错。keyword为店名、菜品或关键词，limit为数量。仅返回商户名、ID和链接，不能据此声称已核实评分、包厢或其他未返回信息。'
              : t.description ?? t.name}`,
            inputSchema: t.inputSchema ?? { type: "object" },
            execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
              if (this.toolAllowed(def) === false) throw new Error("该工具当前不可用");
              const c = this.connections.get(s.name);
              if (!c || !c.canRequest()) throw new Error(`MCP 服务器 ${s.name} 未连接`);
              const output = await c.callTool(t.name, args, this.cfg.callTimeoutMs);
              if (s.name === "cn-scraper" && cnScraperFailure(output)) {
                // A website failure is not a broken MCP connection and must never trigger replay.
                throw new Error(`cn-scraper 网站工具失败: ${safeMcpError(output, s)}`);
              }
              return output;
            },
          };
          if (this.toolAllowed(def)) this.tools.push(def);
        }
        log.info(`MCP ${s.name}: ${mcpTools.length} 个工具`);
      } catch (e) {
        await conn?.close();
        const message = safeMcpError(e, s);
        this.errors.set(s.name, message);
        log.warn(`MCP ${s.name} 连接失败:`, message);
      }
    }
  }

  getTools(): ToolDef[] {
    return this.tools;
  }

  async stop(): Promise<void> {
    for (const c of this.connections.values()) await c.close();
    this.connections.clear();
    this.errors.clear();
    this.tools = [];
  }
}
