import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 指数退避 + 随机抖动 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = exp * (0.5 + Math.random() * 0.5);
  return Math.min(maxMs, Math.max(baseMs, Math.floor(jitter)));
}

export function shortId(prefix = ""): string {
  return prefix + crypto.randomBytes(8).toString("hex");
}

export function stableHash(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 原子写文件：先写临时文件再 rename，避免中断留下半个文件。 */
export function atomicWriteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: "utf-8" });
  fs.renameSync(tmp, filePath);
}

/**
 * 最小 5 字段 cron 匹配器（分 时 日 月 星期），支持 * , - / 。
 * 只用于“每分钟轮询一次”的调度精度。
 */
export interface CronExpr {
  raw: string;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number> | null; // null = *
  months: Set<number> | null;
  daysOfWeek: Set<number> | null; // 0=周日
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseCron(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`无效的 cron 表达式（需要 5 个字段）: ${expr}`);
  const fields = parts.map((f) => parseCronField(f));
  const [min, hour, dom, mon, dow] = fields;
  if (!min || !hour || !dom || !mon || !dow) throw new Error(`无效的 cron 表达式: ${expr}`);
  return {
    raw: expr,
    minutes: min,
    hours: hour,
    daysOfMonth: dom.has(-1) ? null : dom,
    months: mon.has(-1) ? null : mon,
    daysOfWeek: dow.has(-1) ? null : dow,
    domRestricted: !dom.has(-1),
    dowRestricted: !dow.has(-1),
  };
}

function parseCronField(field: string): Set<number> {
  const out = new Set<number>();
  for (const piece of field.split(",")) {
    const m = /^(\*|-?\d+)(?:\/(\d+))?(?:-(\d+))?$/.exec(piece.trim());
    if (!m) throw new Error(`无法解析 cron 字段: ${piece}`);
    const [, aRaw, stepRaw, bRaw] = m;
    const step = stepRaw ? Number(stepRaw) : 1;
    if (aRaw === "*") {
      out.add(-1); // -1 = 无限制标记
      for (let i = 0; i <= 59; i++) if (i % step === 0) out.add(i);
      continue;
    }
    const a = Number(aRaw);
    const b = bRaw !== undefined ? Number(bRaw) : a;
    if (Number.isNaN(a) || Number.isNaN(b) || a > b) throw new Error(`无效的 cron 范围: ${piece}`);
    for (let i = a; i <= b; i++) if ((i - a) % step === 0) out.add(i);
  }
  if (out.size === 0) throw new Error(`cron 字段为空: ${field}`);
  return out;
}

export function cronMatches(expr: CronExpr, local: { minute: number; hour: number; day: number; month: number; weekday: number }): boolean {
  if (!expr.minutes.has(local.minute)) return false;
  if (!expr.hours.has(local.hour)) return false;
  if (expr.months && !expr.months.has(local.month)) return false;
  // POSIX cron 语义：dom 与 dow 都受限时，命中其一即可
  const domOk = expr.daysOfMonth ? expr.daysOfMonth.has(local.day) : true;
  const dowOk = expr.daysOfWeek ? expr.daysOfWeek.has(local.weekday) : true;
  if (expr.domRestricted && expr.dowRestricted) return domOk || dowOk;
  if (expr.domRestricted) return domOk;
  if (expr.dowRestricted) return dowOk;
  return true;
}

/** 从文本提取 URL（http/https），排除中文标点结尾 */
export function extractUrls(text: string): string[] {
  const re = /https?:\/\/[^\s<>"'，。；：！？、（）【】《》”’）】」\]]+/gi;
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const url = m[0].replace(/[.,;:!?。，；：！？]+$/u, "");
    if (url.length > 8) out.push(url);
  }
  return [...new Set(out)];
}

export function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf("。", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
