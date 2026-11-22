export type Schedule =
  | { type: "once"; at: string }
  | { type: "interval"; everyMs: number; startAt: string }
  | { type: "calendar"; time: string; timeZone: string; weekdays?: number[] };

const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function wallParts(time: number, zone: string): number[] {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    if (formatters.size >= 100) formatters.clear();
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(time).map(p => [p.type, p.value]));
  return [Number(parts.year), Number(parts.month), Number(parts.day), Number(parts.hour), Number(parts.minute)];
}

function wallInstant(year: number, month: number, day: number, hour: number, minute: number, zone: string): number | null {
  const target = [year, month, day, hour, minute];
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const candidates = [-36, -12, 0, 12, 36].map(hours => {
    const sample = naive + hours * 3_600_000;
    const [y = 0, m = 0, d = 0, h = 0, min = 0] = wallParts(sample, zone);
    return naive - (Date.UTC(y, m - 1, d, h, min) - sample);
  });
  // A spring gap is skipped. A repeated fall-back time fires at its first occurrence.
  return candidates.filter(time => wallParts(time, zone).every((n, i) => n === target[i]))
    .sort((a, b) => a - b)[0] ?? null;
}

export function instant(value: unknown): number {
  const at = typeof value === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
    ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) throw new Error("请给出带时区的 ISO 时间。");
  return at;
}

export function scheduleFromInput(input: unknown, now: number, timeZone: string, intervalAnchor = now): Schedule {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请选择一次、间隔或日历计划。");
  const data = input as Record<string, unknown>;
  if (data.type === "once") {
    const at = instant(data.at);
    if (at <= now) throw new Error("提醒时间需要在未来。");
    return { type: "once", at: new Date(at).toISOString() };
  }
  if (data.type === "interval") {
    const everyMs = Number(data.everyMs);
    if (!Number.isSafeInteger(everyMs) || everyMs < 60_000 || everyMs > 366 * DAY) {
      throw new Error("间隔需在一分钟和 366 天之间。");
    }
    return {
      type: "interval", everyMs,
      startAt: new Date(data.startAt === undefined ? intervalAnchor + everyMs : instant(data.startAt)).toISOString(),
    };
  }
  if (data.type !== "calendar" || typeof data.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(data.time)) {
    throw new Error("日历计划需要 HH:mm。");
  }
  const zone = data.timeZone ?? timeZone;
  if (typeof zone !== "string") throw new Error("请给出有效的时区。");
  wallParts(now, zone);
  const weekdays = data.weekdays;
  if (weekdays !== undefined && (!Array.isArray(weekdays) || !weekdays.length || weekdays.length > 7
    || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7))) {
    throw new Error("星期用数字 1–7 表示，星期一为 1。");
  }
  return { type: "calendar", time: data.time, timeZone: zone, ...(weekdays ? { weekdays: [...new Set<number>(weekdays)] } : {}) };
}

export function nextOccurrence(schedule: Schedule, after: number): number | null {
  if (schedule.type === "once") {
    const at = instant(schedule.at);
    return at > after ? at : null;
  }
  if (schedule.type === "interval") {
    const start = instant(schedule.startAt);
    return start > after ? start : start + (Math.floor((after - start) / schedule.everyMs) + 1) * schedule.everyMs;
  }
  const [year = 0, month = 0, date = 0] = wallParts(after, schedule.timeZone);
  const [hour = 0, minute = 0] = schedule.time.split(":").map(Number);
  for (let day = 0; day <= 15; day++) {
    const candidate = new Date(Date.UTC(year, month - 1, date + day));
    if (schedule.weekdays && !schedule.weekdays.includes(candidate.getUTCDay() || 7)) continue;
    const at = wallInstant(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1,
      candidate.getUTCDate(), hour, minute, schedule.timeZone);
    if (at !== null && at > after) return at;
  }
  return null;
}

export function localDate(time: number, zone: string): string {
  return wallParts(time, zone).slice(0, 3).map((part, i) => String(part).padStart(i === 0 ? 4 : 2, "0")).join("-");
}

export function dayBounds(date: string, zone: string): { start: string; end: string } {
  if (!/^\d{4}-\d\d-\d\d$/.test(date) || !Number.isFinite(Date.parse(date))
    || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("日记日期需是有效的 YYYY-MM-DD。");
  const midnight = Date.parse(date);
  const boundary = (offset: number): string => {
    const value = new Date(midnight + offset * DAY);
    for (let minute = 0; minute < 180; minute++) {
      const at = wallInstant(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(),
        Math.floor(minute / 60), minute % 60, zone);
      if (at !== null) return new Date(at).toISOString();
    }
    throw new Error("该日期在所选时区没有可识别的日界。");
  };
  return { start: boundary(0), end: boundary(1) };
}
