import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { subscribeDiagnosticLogs } from "../util/logger.js";
import { DIAGNOSTIC_COMPONENTS, classifyDiagnosticFailure, diagnosticConversationHash, sanitizeDiagnosticEvent, sanitizeDiagnosticStatus, type DiagnosticComponent, type DiagnosticEventInput, type DiagnosticFailureContext, type SafeDiagnosticEvent, type RuntimeDiagnosticStatus } from "./schema.js";
export * from "./schema.js";

export interface RuntimeDiagnosticsReadRequest {
  scope: "global" | "conversation";
  accountId: string;
  conversationId: string;
  component?: DiagnosticComponent;
  limit?: number;
}
export interface RuntimeDiagnosticsProvider {
  read(request: RuntimeDiagnosticsReadRequest): string | Promise<string>;
  recordFailure?(component: DiagnosticComponent, error: unknown, context?: DiagnosticFailureContext): void;
  record?(input: DiagnosticEventInput): void;
}
export interface RuntimeDiagnosticsOptions {
  directory?: string;
  now?: () => number;
  maxEvents?: number;
  subscribeLogs?: boolean;
  currentStatus?: (request: RuntimeDiagnosticsReadRequest) => readonly RuntimeDiagnosticStatus[];
}
interface StoredDiagnosticEvent extends SafeDiagnosticEvent { scopeHash?: string }
export interface RuntimeDiagnosticsSnapshot {
  observedAt: string;
  windowHours: 24;
  scope: "global" | "conversation";
  storage: "memory" | "persistent" | "unavailable";
  current: RuntimeDiagnosticStatus[];
  events: SafeDiagnosticEvent[];
  matchedEvents: number;
  truncated: boolean;
  assessment: "仅作初步判断；事件缺失不能证明功能正常，结果不明的发送不得据此自动重试。";
}

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_STORE_BYTES = 512 * 1024;
const MAX_RESPONSE_CHARS = 5999;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ASSESSMENT = "仅作初步判断；事件缺失不能证明功能正常，结果不明的发送不得据此自动重试。" as const;

/** Own bounded sanitized JSONL history. Does not read bot logs, chat storage or arbitrary paths. */
export class RuntimeDiagnostics implements RuntimeDiagnosticsProvider {
  private events: StoredDiagnosticEvent[] = [];
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly storePath?: string;
  private unsubscribe?: () => void;
  private storage: RuntimeDiagnosticsSnapshot["storage"] = "memory";
  private readonly currentStatus?: RuntimeDiagnosticsOptions["currentStatus"];

  constructor(options: RuntimeDiagnosticsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEvents = Math.max(20, Math.min(1000, Number.isSafeInteger(options.maxEvents) ? options.maxEvents! : 1000));
    this.currentStatus = options.currentStatus;
    if (options.directory) {
      this.storePath = path.join(path.resolve(options.directory), "events.jsonl");
      this.load();
    }
    if (options.subscribeLogs !== false) this.unsubscribe = subscribeDiagnosticLogs(event => this.store(event));
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  record(input: DiagnosticEventInput): void {
    let event: SafeDiagnosticEvent | null;
    let scopeHash: string | undefined;
    try {
      event = sanitizeDiagnosticEvent({ ...input, at: new Date(this.now()).toISOString() });
      scopeHash = diagnosticConversationHash(input.accountId, input.conversationId);
    } catch { return; }
    if (event) this.store({ ...event, ...(scopeHash ? { scopeHash } : {}) });
  }

  recordFailure(component: DiagnosticComponent, error: unknown, context: DiagnosticFailureContext = {}): void {
    this.record({ component, level: "warn", ...classifyDiagnosticFailure(error), operation: context.operation,
      accountId: context.accountId, conversationId: context.conversationId });
  }

  snapshot(request: RuntimeDiagnosticsReadRequest): RuntimeDiagnosticsSnapshot {
    const now = this.now();
    this.prune(now);
    const scopeHash = diagnosticConversationHash(request.accountId, request.conversationId);
    const scope = request.scope === "global" ? "global" : "conversation";
    const component = typeof request.component === "string" && DIAGNOSTIC_COMPONENTS.includes(request.component) ? request.component : undefined;
    const limit = typeof request.limit === "number" && Number.isSafeInteger(request.limit) ? Math.max(1, Math.min(20, request.limit)) : 20;
    const matches = this.events.filter(event => (!component || event.component === component)
      && (scope === "global" || !!scopeHash && event.scopeHash === scopeHash));
    // Current status providers must only use local safe aggregates; reads do not perform probes or retry work.
    const current: RuntimeDiagnosticStatus[] = [];
    try {
      for (const entry of (this.currentStatus?.({ ...request, scope }) ?? []).slice(0, 24)) {
        const status = sanitizeDiagnosticStatus(entry);
        if (status && (!component || status.component === component) && (scope === "global" || !["presence", "memory", "proactive", "notion"].includes(status.component))) current.push(status);
      }
    } catch { current.push({ component: "system", ready: false, failure: "internal" }); }
    return { observedAt: new Date(now).toISOString(), windowHours: 24, scope, storage: this.storage,
      current, events: matches.slice(-limit).reverse().map(event => sanitizeDiagnosticEvent(event)!),
      matchedEvents: matches.length, truncated: matches.length > limit, assessment: ASSESSMENT };
  }

  read(request: RuntimeDiagnosticsReadRequest): string {
    const snapshot = this.snapshot(request);
    let output = JSON.stringify(snapshot);
    // Both event count and serialized output are bounded, including unexpectedly numerous MCP statuses.
    while (output.length > MAX_RESPONSE_CHARS && snapshot.events.length > 0) {
      snapshot.events.pop(); snapshot.truncated = true; output = JSON.stringify(snapshot);
    }
    while (output.length > MAX_RESPONSE_CHARS && snapshot.current.length > 0) {
      snapshot.current.pop(); snapshot.truncated = true; output = JSON.stringify(snapshot);
    }
    return output;
  }

  private store(input: StoredDiagnosticEvent): void {
    const safe = sanitizeDiagnosticEvent(input);
    if (!safe) return;
    const at = Date.parse(safe.at), now = this.now();
    if (at < now - RETENTION_MS || at > now + 60000) return;
    const scopeHash = typeof input.scopeHash === "string" && HASH_PATTERN.test(input.scopeHash) ? input.scopeHash : undefined;
    this.events.push({ ...safe, ...(scopeHash ? { scopeHash } : {}) });
    this.prune(now);
    // Warning/error traffic is low. Rewriting the capped journal enforces retention on disk immediately.
    this.persist();
  }

  private prune(now: number): void {
    this.events = this.events.filter(event => Date.parse(event.at) >= now - RETENTION_MS && Date.parse(event.at) <= now + 60000)
      .sort((a, b) => a.at.localeCompare(b.at)).slice(-this.maxEvents);
  }

  private load(): void {
    try {
      fs.mkdirSync(path.dirname(this.storePath!), { recursive: true, mode: 0o700 });
      if (fs.existsSync(this.storePath!)) {
        const stat = fs.lstatSync(this.storePath!);
        // Never follow a symlink or read a journal larger than the hard storage budget.
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) throw new Error("diagnostics journal invalid");
        const lines = fs.readFileSync(this.storePath!, "utf8").split("\n").slice(-2001);
        for (const line of lines) {
          if (!line || line.length > 2048) continue;
          try {
            const input: unknown = JSON.parse(line);
            const safe = sanitizeDiagnosticEvent(input);
            if (!safe) continue;
            const rawScope = (input as Record<string, unknown>).scopeHash;
            this.events.push({ ...safe, ...(typeof rawScope === "string" && HASH_PATTERN.test(rawScope) ? { scopeHash: rawScope } : {}) });
          } catch { /* Ignore partial or untrusted records, without emitting their contents. */ }
        }
      }
      this.prune(this.now());
      this.persist();
    } catch { this.storage = "unavailable"; }
  }

  private persist(): void {
    if (!this.storePath) return;
    let temporary: string | undefined;
    try {
      const directory = path.dirname(this.storePath);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.existsSync(this.storePath) && fs.lstatSync(this.storePath).isSymbolicLink()) throw new Error("diagnostics journal invalid");
      temporary = path.join(directory, `events-${randomBytes(8).toString("hex")}.tmp`);
      let body = this.events.map(event => JSON.stringify(event)).join("\n");
      while (Buffer.byteLength(body, "utf8") > MAX_STORE_BYTES - 1 && this.events.length) {
        this.events.shift(); body = this.events.map(event => JSON.stringify(event)).join("\n");
      }
      fs.writeFileSync(temporary, body ? body + "\n" : "", { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.storePath);
      this.storage = "persistent";
    } catch { this.storage = "unavailable"; }
    finally { if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Already renamed or unavailable. */ } } }
  }
}
