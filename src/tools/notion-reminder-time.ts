import { NotionError } from "./notion.js";

/** ISO weekday: Monday=1, Sunday=7. A local wall-clock rule, not a fixed UTC
 * interval, so daylight-saving changes preserve the user's chosen local hour. */
export interface ReminderRecurrence {
  frequency: "daily" | "weekly";
  time: string;
  timezone: string;
  weekday?: number;
}
export function checkedRecurrence(input: ReminderRecurrence): ReminderRecurrence {
  if (!input || !["daily", "weekly"].includes(input.frequency) || typeof input.time !== "string"
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time) || typeof input.timezone !== "string" || input.timezone.length > 80
    || (input.frequency === "weekly" && (!Number.isInteger(input.weekday) || input.weekday! < 1 || input.weekday! > 7))
    || (input.frequency === "daily" && input.weekday !== undefined)) throw new NotionError("invalid_input");
  try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(0); } catch { throw new NotionError("invalid_input"); }
  return { frequency: input.frequency, time: input.time, timezone: input.timezone, ...(input.frequency === "weekly" ? { weekday: input.weekday } : {}) };
}

export function nextReminderOccurrence(input: ReminderRecurrence, afterMs: number): string {
  const rule = checkedRecurrence(input);
  if (!Number.isFinite(afterMs) || afterMs < 0) throw new NotionError("invalid_input");
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: rule.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = (ms: number) => Object.fromEntries(format.formatToParts(ms).filter(p => ["year", "month", "day", "hour", "minute"].includes(p.type)).map(p => [p.type, Number(p.value)]));
  const today = parts(afterMs), [hour, minute] = rule.time.split(":").map(Number);
  // Offset candidates on both sides of a transition handle repeated hours.
  // A nonexistent local hour (spring-forward) is skipped rather than shifted.
  for (let day = 0; day <= 9; day++) {
    const calendar = new Date(Date.UTC(today.year!, today.month! - 1, today.day! + day));
    if (rule.frequency === "weekly" && (calendar.getUTCDay() || 7) !== rule.weekday) continue;
    const wall = Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth(), calendar.getUTCDate(), hour!, minute!);
    const offsets = new Set<number>();
    for (const delta of [-36, -12, 0, 12, 36]) {
      const sample = wall + delta * 3600_000, local = parts(sample);
      offsets.add(Date.UTC(local.year!, local.month! - 1, local.day!, local.hour!, local.minute!) - sample);
    }
    const matches: number[] = [];
    for (const offset of offsets) {
      const candidate = wall - offset, local = parts(candidate);
      if (local.year === calendar.getUTCFullYear() && local.month === calendar.getUTCMonth() + 1
        && local.day === calendar.getUTCDate() && local.hour === hour && local.minute === minute) matches.push(candidate);
    }
    // A repeated hour still represents one daily occurrence. If its first
    // instant already passed, do not send again at the second wall-clock match.
    if (matches.length && Math.min(...matches) > afterMs) return new Date(Math.min(...matches)).toISOString();
  }
  throw new NotionError("invalid_input");
}
