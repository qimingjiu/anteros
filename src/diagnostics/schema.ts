import { createHash } from "node:crypto";
import { INCOMING_FILE_STAGES, INCOMING_FILE_REASONS, type IncomingFileStage } from "../documents/incoming-errors.js";
/** The only data permitted to cross from operational logging into model diagnostics. */
export const DIAGNOSTIC_COMPONENTS = ["model", "gateway", "documents", "mcp", "search", "reader", "weather", "presence", "proactive", "notion", "email", "agent", "memory", "system"] as const;
export type DiagnosticComponent = typeof DIAGNOSTIC_COMPONENTS[number];
export type DiagnosticsComponent = DiagnosticComponent;
export const DIAGNOSTIC_REASONS = ["timeout", "authentication", "permission", "rate_limit", "upstream_error", "network", "disconnected", "unsupported", "invalid_response", "invalid_arguments", "configuration", "storage", "quota", "delivery_unknown", "tool_budget", "internal"] as const;
export type DiagnosticReason = typeof DIAGNOSTIC_REASONS[number];
export const DIAGNOSTIC_OPERATIONS = ["web_search", "read_page", "read_file", "task_status", "task_control", "personal_memory", "generate_document", "weather_forecast", "runtime_diagnostics", "mcp_tool", "email", "tool_permissions", "tool_arguments", "model_reply", "send_file", "send_message", "phone_fetch", "proactive_reply", "notion_save", "notion_list", "notion_get", "notion_read", "notion_complete", "notion_reminder", "startup", "shutdown", "memory_update"] as const;
export type DiagnosticOperation = typeof DIAGNOSTIC_OPERATIONS[number];
export const DIAGNOSTIC_ERROR_CODES = ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ENOENT", "EACCES", "EPERM", "ENOSPC", "TimeoutError", "AbortError", "TOOL_SEARCH_FAILED", "TOOL_PAGE_READ_FAILED", "TOOL_FILE_READ_FAILED", "TOOL_WEATHER_FAILED", "DOCUMENT_DELIVERY_FAILED", "DOCUMENT_DELIVERY_UNKNOWN", "TOOL_PERMISSION_DENIED", "TOOL_ARGUMENTS_INVALID", "TOOL_DIAGNOSTICS_FAILED", "TOOL_MCP_FAILED", "TOOL_NOTION_FAILED", "TOOL_EMAIL_FAILED", "EMAIL_DELIVERY_UNKNOWN", "MEDIA_GENERATION_FAILED", "MEDIA_DELIVERY_FAILED", "MEDIA_DELIVERY_UNKNOWN"] as const;
export type DiagnosticErrorCode = typeof DIAGNOSTIC_ERROR_CODES[number];

export interface SafeDiagnosticEvent {
  at: string;
  level: "warn" | "error";
  component: DiagnosticComponent;
  reason: DiagnosticReason;
  operation?: DiagnosticOperation;
  httpStatus?: number;
  retcode?: number;
  errorCode?: DiagnosticErrorCode;
  fileStage?: IncomingFileStage;
}
export interface SafeDiagnosticLogEvent extends SafeDiagnosticEvent { scopeHash?: string }
export interface DiagnosticEventInput extends Omit<SafeDiagnosticEvent, "at"> {
  accountId?: string;
  conversationId?: string;
}
export interface DiagnosticFailureContext {
  accountId?: string;
  conversationId?: string;
  operation?: DiagnosticOperation;
}

const scopeComponents: Record<string, DiagnosticComponent> = { llm: "model", "llm-switch": "model", gateway: "gateway", onebot: "gateway", documents: "documents", mcp: "mcp", search: "search", reader: "reader", weather: "weather", presence: "presence", proactive: "proactive", agent: "agent", memory: "memory", main: "system", web: "system", report: "documents", "group-reply-judge": "model" };
export function diagnosticComponent(scope: string): DiagnosticComponent {
  if (scope === "notion" || scope === "notion-reminders") return "notion";
  return Object.hasOwn(scopeComponents, scope) ? scopeComponents[scope]! : "system";
}

function member<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
  return typeof value === "string" && choices.includes(value as T) ? value as T : undefined;
}
function integer(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}
/** No object spread, raw string, stack, arbitrary code, identifiers or metadata survive this projection. */
export function sanitizeDiagnosticEvent(value: unknown): SafeDiagnosticEvent | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const component = member(input.component, DIAGNOSTIC_COMPONENTS);
  const reason = member(input.reason, DIAGNOSTIC_REASONS);
  const level = member(input.level, ["warn", "error"]);
  const at = typeof input.at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.at) && Number.isFinite(Date.parse(input.at)) ? input.at : undefined;
  if (!component || !reason || !level || !at) return null;
  const event: SafeDiagnosticEvent = { at, level, component, reason };
  const operation = member(input.operation, DIAGNOSTIC_OPERATIONS);
  const httpStatus = integer(input.httpStatus, 100, 599);
  const retcode = integer(input.retcode, -99999, 99999);
  const errorCode = member(input.errorCode, DIAGNOSTIC_ERROR_CODES);
  if (operation) event.operation = operation;
  if (httpStatus !== undefined) event.httpStatus = httpStatus;
  if (retcode !== undefined) event.retcode = retcode;
  if (errorCode) event.errorCode = errorCode;
  const fileStage=member(input.fileStage,INCOMING_FILE_STAGES);
  if(fileStage)event.fileStage=fileStage;
  return event;
}

/** Inspect an exception only long enough to map it to fixed categories; never return the source text. */
export function classifyDiagnosticFailure(error: unknown): Pick<SafeDiagnosticEvent, "reason" | "httpStatus" | "retcode" | "errorCode" | "fileStage"> {
  try {
    if (error && typeof error === "object" && (error as Record<string, unknown>).name === "EmailToolError") {
      const reasons: Record<string, DiagnosticReason> = {
        not_configured: "configuration", forbidden: "permission", invalid_input: "invalid_arguments",
        explicit_instruction_required: "permission", recipient_not_authorized: "permission",
        authentication: "authentication", timeout: "timeout", network: "network", unavailable: "upstream_error",
        not_found: "invalid_response", mailbox_changed: "invalid_response", too_large: "quota",
        delivery_unknown: "delivery_unknown", storage: "storage",
      };
      const value = (error as Record<string, unknown>).reason;
      const reason = typeof value === "string" && Object.hasOwn(reasons, value) ? reasons[value]! : "internal";
      return { reason, errorCode: reason === "delivery_unknown" ? "EMAIL_DELIVERY_UNKNOWN" : "TOOL_EMAIL_FAILED" };
    }
    if(error && typeof error==="object" && (error as Record<string,unknown>).name==="ScopedToolError") {
      const reasons:Record<string,DiagnosticReason>={permission:"permission",forbidden:"permission",explicit_instruction_required:"permission",
        authentication:"authentication",quota:"quota",invalid_input:"invalid_arguments",invalid_response:"invalid_response",
        schema_too_large:"quota",not_found_in_current_scope:"invalid_arguments",unavailable:"disconnected"};
      const reason=(error as Record<string,unknown>).reason;
      return {reason:typeof reason==="string" && Object.hasOwn(reasons,reason)?reasons[reason]!:"internal",errorCode:"TOOL_MCP_FAILED"};
    }
    if(error && typeof error==="object" && (error as Record<string,unknown>).name==="IncomingFileError") {
      const raw=error as Record<string,unknown>,fileReason=member(raw.reason,INCOMING_FILE_REASONS),fileStage=member(raw.stage,INCOMING_FILE_STAGES);
      const httpStatus=integer(raw.httpStatus,100,599);
      const mapping:Record<string,DiagnosticReason>={forbidden:"permission",not_authorized:"permission",invalid_input:"invalid_arguments",
        not_found:"invalid_response",unsupported:"unsupported",too_large:"quota",busy:"quota",invalid_cache:"storage",
        protocol_unavailable:"unsupported",download_timeout:"timeout",download_rejected:"permission",parse_failed:"invalid_response",parse_timeout:"timeout",
        read_failed:"internal",download_failed:httpStatus && httpStatus>=500?"upstream_error":httpStatus===401?"authentication":httpStatus===403?"permission":httpStatus===429?"rate_limit":"network"};
      return {reason:fileReason?mapping[fileReason] ?? "internal":"internal",errorCode:"TOOL_FILE_READ_FAILED",
        ...(fileStage?{fileStage}:{}),...(httpStatus?{httpStatus}:{})};
    }
    if (error && typeof error === "object" && (error as Record<string, unknown>).name === "NotionError") {
      const raw = error as Record<string, unknown>;
      const reasons: Record<string, DiagnosticReason> = {not_configured:"configuration",invalid_input:"invalid_arguments",forbidden:"permission",
        not_found:"invalid_response",rate_limited:"rate_limit",timeout:"timeout",unavailable:"upstream_error",invalid_response:"invalid_response",
        write_unknown:"delivery_unknown",too_large:"quota"};
      const reason = typeof raw.reason === "string" && Object.hasOwn(reasons,raw.reason) ? reasons[raw.reason]! : "internal";
      const httpStatus = integer(raw.status,100,599);
      return {reason,...(httpStatus === undefined ? {} : {httpStatus})};
    }
    if (error && typeof error === "object" && ["WebAccessError", "ReaderFailure"].includes(String((error as Record<string, unknown>).name))) {
      const raw = error as Record<string, unknown>;
      const mapping: Record<string, DiagnosticReason> = {invalid_url:"permission",robots_denied:"permission",robots_unavailable:"network",site_policy:"permission",
        restricted:"permission",rate_limit:"rate_limit",http_error:"upstream_error",timeout:"timeout",network:"network",too_large:"quota",unsupported:"unsupported",
        budget:"tool_budget",quota:"quota",low_quality:"invalid_response",invalid_response:"invalid_response",upstream_error:"upstream_error",authentication:"authentication",storage:"storage"};
      const reason = typeof raw.reason === "string" && Object.hasOwn(mapping,raw.reason) ? mapping[raw.reason] : undefined;
      if (reason) { const status = integer(raw.httpStatus,100,599); return {reason,...(status ? {httpStatus:status} : {})}; }
    }
  } catch { /* Unknown upstream objects still pass through the fixed classifier below. */ }
  let message = "", code: unknown, name: unknown, status: unknown, retcode: unknown;
  try {
    if (typeof error === "string") message = error.slice(0, 2048);
    else if (error && typeof error === "object") {
      const object = error as Record<string, unknown>;
      if (typeof object.message === "string") message = object.message.slice(0, 2048);
      code = object.code; name = object.name; status = object.status; retcode = object.retcode;
    }
  } catch { /* Hostile getters or malformed third-party exceptions do not interrupt replies. */ }
  const errorCode = member(code, DIAGNOSTIC_ERROR_CODES) ?? member(name, DIAGNOSTIC_ERROR_CODES);
  const httpStatus = integer(status, 100, 599) ?? integer(Number(/\bHTTP\s+(\d{3})\b/i.exec(message)?.[1]), 100, 599);
  const safeRetcode = integer(retcode, -99999, 99999) ?? integer(Number(/\bretcode\s*[=:]\s*(-?\d{1,5})\b/i.exec(message)?.[1]), -99999, 99999);
  let reason: DiagnosticReason = "internal";
  if (errorCode === "DOCUMENT_DELIVERY_UNKNOWN" || errorCode === "MEDIA_DELIVERY_UNKNOWN" || errorCode === "EMAIL_DELIVERY_UNKNOWN" || /结果不明|结果未知|未自动重试|已提交异步/.test(message)) reason = "delivery_unknown";
  else if (errorCode === "TimeoutError" || errorCode === "AbortError" || errorCode === "ETIMEDOUT" || /timeout|timed out|超时/i.test(message)) reason = "timeout";
  else if (httpStatus === 401 || /鉴权|认证失败|unauthorized|authentication/i.test(message)) reason = "authentication";
  else if (httpStatus === 403 || errorCode === "TOOL_PERMISSION_DENIED" || /权限|拒绝|forbidden|permission/i.test(message)) reason = "permission";
  else if (httpStatus === 429 || /rate.limit|限流|too many requests/i.test(message)) reason = "rate_limit";
  else if (httpStatus !== undefined && httpStatus >= 500) reason = "upstream_error";
  else if (errorCode === "EACCES" || errorCode === "EPERM" || errorCode === "ENOSPC" || errorCode === "ENOENT" || /文件路径|存储|字体|写入|disk|storage/i.test(message)) reason = "storage";
  else if (/上限|过大|oversized|quota|too large/i.test(message)) reason = "quota";
  else if (/不支持|unsupported|not supported/i.test(message) || safeRetcode === 1404 || safeRetcode === -32601) reason = "unsupported";
  else if (/未连接|已关闭|连接已关闭|offline|disconnected|not connected/i.test(message)) reason = "disconnected";
  else if (/缺少|未配置|配置无效|missing.*config/i.test(message)) reason = "configuration";
  else if (/非 JSON|无效.*响应|未返回.*响应|返回空|malformed|invalid.response|invalid.json/i.test(message)) reason = "invalid_response";
  else if (errorCode === "TOOL_ARGUMENTS_INVALID" || /参数|必须是|不能为空|只支持|invalid.argument/i.test(message)) reason = "invalid_arguments";
  else if (errorCode && ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EPIPE"].includes(errorCode) || /fetch failed|network|网络|域名解析失败|socket/i.test(message)) reason = "network";
  else if (/额度|轮数|tool.budget/i.test(message)) reason = "tool_budget";
  else if (httpStatus !== undefined && httpStatus >= 400 || errorCode?.startsWith("TOOL_") || ["DOCUMENT_DELIVERY_FAILED","MEDIA_GENERATION_FAILED","MEDIA_DELIVERY_FAILED"].includes(errorCode ?? "")) reason = "upstream_error";
  return { reason, ...(httpStatus === undefined ? {} : { httpStatus }), ...(safeRetcode === undefined ? {} : { retcode: safeRetcode }), ...(errorCode ? { errorCode } : {}) };
}

export function diagnosticConversationHash(accountId: unknown, conversationId: unknown): string | undefined {
  if (typeof accountId !== "string" || !accountId || accountId.length > 128 || typeof conversationId !== "string" || !conversationId || conversationId.length > 128) return undefined;
  return createHash("sha256").update(JSON.stringify([accountId, conversationId])).digest("hex");
}

export function classifyDiagnosticLog(scope: string, level: "warn" | "error", parts: unknown[], at: string): SafeDiagnosticLogEvent {
  // Do not stringify objects: logger arguments may include tool inputs, chat bodies or model reasoning.
  let failure: ReturnType<typeof classifyDiagnosticFailure> = { reason: "internal" };
  for (const part of parts.slice(0, 8)) {
    const candidate = classifyDiagnosticFailure(part);
    if (failure.reason === "internal" || candidate.reason !== "internal") failure = { ...failure, ...candidate };
  }
  const event: SafeDiagnosticLogEvent = { at, level, component: diagnosticComponent(scope), ...failure };
  // Only a known gateway template may attach routing metadata. Never copy its identities into diagnostics.
  if (scope === "gateway" && typeof parts[0] === "string" && ["投递失败", "投递回执不明"].includes(parts[0])) {
    const context = parts[2];
    if (context && typeof context === "object") {
      const input = context as Record<string, unknown>;
      const operation = member(input.operation, DIAGNOSTIC_OPERATIONS);
      const scopeHash = diagnosticConversationHash(input.accountId, input.conversationId);
      if (operation) event.operation = operation;
      if (scopeHash) event.scopeHash = scopeHash;
      if (input.status === "unknown") event.reason = "delivery_unknown";
    }
  }
  return event;
}

export interface RuntimeDiagnosticDetails {
  freeOnly?: boolean;
  quotaSource?: "local_reservations";
  quotaUnit?: "credits" | "usd_milli";
  dailyUsedUnits?: number;
  monthlyUsedUnits?: number;
  dailyLimitUnits?: number;
  monthlyLimitUnits?: number;
  service?: string;
  model?: string;
  provider?: "openai_compatible" | "mock";
  connection?: "connected" | "disconnected" | "connecting";
  login?: "online" | "offline" | "unknown";
  source?: "device_events" | "phone_presence_state";
  transport?: "stdio" | "http";
  toolCount?: number;
  currentFieldCount?: number;
  currentFreshFieldCount?: number;
  lastFetchStatus?: "ready" | "empty" | "failed";
  failedTasks?: number;
  unknownTasks?: number;
  queuedTasks?: number;
  supported?: boolean;
  capabilities?: Partial<Record<"receiveMessages" | "sendText" | "sendImage" | "sendPrivateFile" | "sendGroupFile" | "sendPoke" | "groupHistory", "supported" | "unsupported" | "unverified">>;
}
export interface RuntimeDiagnosticStatus {
  component: DiagnosticComponent;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  ready?: boolean;
  connected?: boolean;
  count?: number;
  lastAt?: string;
  failure?: DiagnosticReason;
  httpStatus?: number;
  details?: RuntimeDiagnosticDetails;
}
export function sanitizeDiagnosticStatus(value: unknown): RuntimeDiagnosticStatus | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const component = member(input.component, DIAGNOSTIC_COMPONENTS);
  if (!component) return null;
  const status: RuntimeDiagnosticStatus = { component };
  if (typeof input.name === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(input.name) && !/sk[-_]|sb_secret|bearer|password|token|apikey|api_key/i.test(input.name)) status.name = input.name;
  for (const key of ["enabled", "configured", "ready", "connected"] as const) if (typeof input[key] === "boolean") status[key] = input[key];
  const count = integer(input.count, 0, 10000000);
  const httpStatus = integer(input.httpStatus, 100, 599);
  const failure = member(input.failure, DIAGNOSTIC_REASONS);
  if (count !== undefined) status.count = count;
  if (httpStatus !== undefined) status.httpStatus = httpStatus;
  if (failure) status.failure = failure;
  if (typeof input.lastAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.lastAt) && Number.isFinite(Date.parse(input.lastAt))) status.lastAt = input.lastAt;
  if (input.details && typeof input.details === "object") {
    const raw = input.details as Record<string, unknown>;
    const details: RuntimeDiagnosticDetails = {};
    if (typeof raw.service === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(raw.service) && !/sk[-_]|sb_secret|bearer|password|token|apikey|api_key/i.test(raw.service)) details.service = raw.service;
    if (typeof raw.model === "string" && /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,100}$/.test(raw.model) && !/sk[-_]|sb_secret|bearer|password|token|apikey|api_key|:\/\//i.test(raw.model)) details.model = raw.model;
    const provider = member(raw.provider, ["openai_compatible", "mock"]);
    if (provider) details.provider = provider;
    const connection = member(raw.connection, ["connected", "disconnected", "connecting"]);
    const login = member(raw.login, ["online", "offline", "unknown"]);
    const source = member(raw.source, ["device_events", "phone_presence_state"]);
    const transport = member(raw.transport, ["stdio", "http"]);
    const lastFetchStatus = member(raw.lastFetchStatus, ["ready", "empty", "failed"]);
    if (connection) details.connection = connection;
    if (login) details.login = login;
    if (source) details.source = source;
    if (transport) details.transport = transport;
    if (lastFetchStatus) details.lastFetchStatus = lastFetchStatus;
    if (typeof raw.supported === "boolean") details.supported = raw.supported;
    if (typeof raw.freeOnly === "boolean") details.freeOnly = raw.freeOnly;
    if (raw.quotaSource === "local_reservations") details.quotaSource = raw.quotaSource;
    if (raw.quotaUnit === "credits" || raw.quotaUnit === "usd_milli") details.quotaUnit = raw.quotaUnit;
    for (const key of ["toolCount", "currentFieldCount", "currentFreshFieldCount", "failedTasks", "unknownTasks", "queuedTasks", "dailyUsedUnits", "monthlyUsedUnits", "dailyLimitUnits", "monthlyLimitUnits"] as const) {
      const value = integer(raw[key], 0, 10000000);
      if (value !== undefined) details[key] = value;
    }
    if (raw.capabilities && typeof raw.capabilities === "object") {
      const caps = raw.capabilities as Record<string, unknown>;
      details.capabilities = {};
      for (const key of ["receiveMessages", "sendText", "sendImage", "sendPrivateFile", "sendGroupFile", "sendPoke", "groupHistory"] as const) {
        const value = member(caps[key], ["supported", "unsupported", "unverified"]);
        if (value) details.capabilities[key] = value;
      }
    }
    status.details = details;
  }
  return status;
}
