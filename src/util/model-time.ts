/**
 * Model-facing time formatting. Storage keeps ISO UTC; everything the model reads
 * (context, tool results, memories) is shown in the bot's local timezone,
 * e.g. "10-28 16:54" (year prefixed when it is not the current local year).
 */
let modelTimezone = "Asia/Shanghai";

export function setModelTimezone(tz: string | undefined): void {
  if (!tz) return;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }).format(0); modelTimezone = tz; } catch { /* keep default */ }
}

export function getModelTimezone(): string { return modelTimezone; }

function parts(ms: number, tz: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

/** "MM-DD HH:mm" in local time; "YYYY-MM-DD HH:mm" when not the current local year. Empty for invalid input. */
export function localTime(value: string | number | Date | null | undefined, tz = modelTimezone): string {
  if (value === null || value === undefined || value === "") return "";
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return typeof value === "string" ? value : "";
  const p = parts(ms, tz), nowYear = parts(Date.now(), tz).year;
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${p.year === nowYear ? "" : `${p.year}-`}${p.month}-${p.day} ${hour}:${p.minute}`;
}

/** Local calendar date "YYYY-MM-DD". */
export function localDate(value: string | number | Date | null | undefined, tz = modelTimezone): string {
  if (value === null || value === undefined || value === "") return "";
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return typeof value === "string" ? value.slice(0, 10) : "";
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

// ISO-8601 instants that carry a zone (Z or ±hh:mm); bare dates and zone-less times are left alone.
const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})(?![\d:])/g;

/** Rewrites every zoned ISO timestamp in a string to local "MM-DD HH:mm". */
export function localizeTimestamps(text: string, tz = modelTimezone): string {
  if (!text || !text.includes("T")) return text;
  return text.replace(ISO_INSTANT, match => {
    const ms = Date.parse(match);
    return Number.isFinite(ms) ? localTime(ms, tz) : match;
  });
}

/** Copy of chat messages with timestamps in all text content localized (tool-call arguments untouched). */
export function localizeMessages<T extends { content?: unknown }>(messages: T[], tz = modelTimezone): T[] {
  return messages.map(message => {
    const content = message.content;
    if (typeof content === "string") {
      const next = localizeTimestamps(content, tz);
      return next === content ? message : { ...message, content: next };
    }
    if (Array.isArray(content)) {
      let changed = false;
      const next = content.map(part => {
        if (part && typeof part === "object" && (part as { type?: unknown }).type === "text"
          && typeof (part as { text?: unknown }).text === "string") {
          const text = (part as { text: string }).text, local = localizeTimestamps(text, tz);
          if (local !== text) { changed = true; return { ...part, text: local }; }
        }
        return part;
      });
      return changed ? { ...message, content: next } : message;
    }
    return message;
  });
}
