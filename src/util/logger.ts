import fs from "node:fs";
import path from "node:path";
import { classifyDiagnosticLog, type SafeDiagnosticLogEvent } from "../diagnostics/schema.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = "info";
let logDir: string | null = null;
let logStream: fs.WriteStream | null = null;
let logDate = "";
const diagnosticSubscribers = new Set<(event: SafeDiagnosticLogEvent) => void>();

/** Subscribers receive only a fixed diagnostic projection, never log text, arguments or stacks. */
export function subscribeDiagnosticLogs(listener: (event: SafeDiagnosticLogEvent) => void): () => void {
  diagnosticSubscribers.add(listener);
  return () => { diagnosticSubscribers.delete(listener); };
}

export function initLogging(level: LogLevel, dir?: string): void {
  minLevel = level;
  if (dir) {
    logDir = path.resolve(dir);
    fs.mkdirSync(logDir, { recursive: true });
  }
}

function openStream(): fs.WriteStream | null {
  if (!logDir) return null;
  const d = localDateStr(new Date());
  if (!logStream || d !== logDate) {
    logStream?.end();
    logDate = d;
    logStream = fs.createWriteStream(path.join(logDir, `bot_${d}.log`), { flags: "a" });
  }
  return logStream;
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function fmt(v: unknown): string {
  if (v instanceof Error) return `${v.message}\n${v.stack ?? ""}`;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 脱敏：日志里不输出令牌/密钥类字段 */
function redact(line: string): string {
  return line
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&\s"<>]+/gi, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1***")
    .replace(/("(?:api_key|access_token|token|secret|password)"\s*:\s*")[^"]*(")/gi, "$1***$2");
}

function write(level: LogLevel, scope: string, parts: unknown[]): void {
  const time = new Date().toISOString();
  if (level === "warn" || level === "error") {
    try {
      const event = classifyDiagnosticLog(scope, level, parts, time);
      for (const listener of diagnosticSubscribers) {
        // A broken diagnostics store must never suppress operational logging or normal replies.
        try { listener({ ...event }); } catch { /* Diagnostic observers are best-effort. */ }
      }
    } catch { /* Malformed third-party log values cannot break ordinary logging. */ }
  }
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const line = redact(`${time} [${level.toUpperCase()}] [${scope}] ${parts.map(fmt).join(" ")}`);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  const s = openStream();
  if (s) s.write(line + "\n");
}

export function logger(scope: string) {
  return {
    debug: (...p: unknown[]) => write("debug", scope, p),
    info: (...p: unknown[]) => write("info", scope, p),
    warn: (...p: unknown[]) => write("warn", scope, p),
    error: (...p: unknown[]) => write("error", scope, p),
  };
}

export function localDateStr(d: Date, tz = "Asia/Shanghai"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function localTimeParts(d: Date, tz = "Asia/Shanghai") {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(d)) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}
