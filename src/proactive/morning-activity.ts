import type { Database } from "../db/index.js";
import type { PhonePresenceSnapshot } from "../presence/schema.js";
import { localClock } from "./time.js";

const FRESH_UNLOCK_MS = 2 * 60_000;
const NEAR_UNPLUG_MS = 30 * 60_000;
const BASELINE_MAX_AGE_MS = 24 * 3600_000;
interface ActivityState {
  version: 1;
  deviceId: string;
  charging?: { value: boolean; at: number };
  unpluggedAt?: number;
  firstUnlockDate?: string;
  firstUnlockAt?: number;
}
export interface MorningActivity { date: string; unlockedAt: string; unpluggedAt: string }

/** A phone activity trigger, not sleep detection. Only unlock + observed true→false charging qualifies. */
export class MorningActivityDetector {
  constructor(private readonly db: Database, private readonly key: string, private readonly timezone: string) {}

  evaluate(snapshot: PhonePresenceSnapshot | null, now: number): MorningActivity | null {
    if (snapshot?.source !== "device_events" || !snapshot.activity) return null;
    let state: ActivityState = { version: 1, deviceId: snapshot.deviceId };
    try {
      const saved = JSON.parse(this.db.kvGet(this.key) ?? "null") as ActivityState | null;
      if (saved?.version === 1 && saved.deviceId === snapshot.deviceId) {
        if (saved.charging && typeof saved.charging.value === "boolean" && Number.isFinite(saved.charging.at)
          && saved.charging.at <= now) state.charging = saved.charging;
        if (typeof saved.unpluggedAt === "number" && Number.isFinite(saved.unpluggedAt) && saved.unpluggedAt <= now) state.unpluggedAt = saved.unpluggedAt;
        if (typeof saved.firstUnlockDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(saved.firstUnlockDate)
          && typeof saved.firstUnlockAt === "number" && Number.isFinite(saved.firstUnlockAt) && saved.firstUnlockAt <= now) {
          state.firstUnlockDate = saved.firstUnlockDate; state.firstUnlockAt = saved.firstUnlockAt;
        }
      }
    } catch { /* An absent/corrupt baseline never establishes that a charger was disconnected. */ }
    const before = JSON.stringify(state);
    const charging = snapshot.activity.charging.map(sample => ({ value: sample.value, at: Date.parse(sample.observedAt) }))
      .filter(sample => typeof sample.value === "boolean" && Number.isFinite(sample.at) && sample.at <= now && now - sample.at <= BASELINE_MAX_AGE_MS)
      .sort((one, two) => one.at - two.at);
    for (const sample of charging) {
      if (state.charging && sample.at <= state.charging.at) continue;
      if (state.charging?.value === true && sample.value === false && sample.at - state.charging.at <= BASELINE_MAX_AGE_MS) state.unpluggedAt = sample.at;
      state.charging = sample;
    }
    const clock = localClock(now, this.timezone);
    const unlocks = snapshot.activity.unlocks.map(value => Date.parse(value))
      .filter(value => Number.isFinite(value) && value <= now && now - value <= BASELINE_MAX_AGE_MS).sort((one, two) => one - two);
    for (const unlockedAt of unlocks) {
      const eventClock = localClock(unlockedAt, this.timezone);
      if (eventClock.date !== clock.date || eventClock.minutes < 300 || eventClock.minutes >= 720) continue;
      if (state.firstUnlockDate !== clock.date || state.firstUnlockAt === undefined || unlockedAt < state.firstUnlockAt) {
        state.firstUnlockDate = clock.date;
        state.firstUnlockAt = unlockedAt;
      }
    }
    if (JSON.stringify(state) !== before) this.db.kvSet(this.key, JSON.stringify(state));
    if (clock.minutes < 300 || clock.minutes >= 720 || state.firstUnlockDate !== clock.date
      || state.firstUnlockAt === undefined || now - state.firstUnlockAt > NEAR_UNPLUG_MS
      || state.unpluggedAt === undefined || now - state.unpluggedAt > NEAR_UNPLUG_MS
      || Math.abs(state.firstUnlockAt - state.unpluggedAt) > NEAR_UNPLUG_MS
      || now - Math.max(state.firstUnlockAt, state.unpluggedAt) > FRESH_UNLOCK_MS
      || state.charging?.value !== false) return null;
    return { date: clock.date, unlockedAt: new Date(state.firstUnlockAt).toISOString(), unpluggedAt: new Date(state.unpluggedAt).toISOString() };
  }
}
