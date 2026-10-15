export function localClock(timestamp: number, timezone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return {date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute'))};
}

export const clockMinutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export function isActiveAt(timestamp: number, timezone: string, start: string, end: string): boolean {
  const now = localClock(timestamp, timezone).minutes;
  const from = clockMinutes(start), until = clockMinutes(end);
  return from === until || (from < until ? now >= from && now < until : now >= from || now < until);
}

/** Preserve the draw's delay; a result falling in quiet hours waits until opening. */
export function nextActiveAt(timestamp: number, timezone: string, start: string, end: string): number {
  if (isActiveAt(timestamp, timezone, start, end)) return timestamp;
  let next = Math.ceil(timestamp / 60_000) * 60_000;
  for (let minute = 0; minute <= 2880; minute++, next += 60_000) {
    if (isActiveAt(next, timezone, start, end)) return next;
  }
  throw new Error('无法计算主动消息开放时间');
}

export function activeWindowEnd(timestamp: number, timezone: string, start: string, end: string): number {
  if (start === end) return timestamp + 24 * 3600_000;
  let next = Math.ceil(timestamp / 60_000) * 60_000;
  for (let minute = 0; minute <= 2880; minute++, next += 60_000) {
    if (!isActiveAt(next, timezone, start, end)) return next;
  }
  throw new Error('无法计算主动消息静默时间');
}
