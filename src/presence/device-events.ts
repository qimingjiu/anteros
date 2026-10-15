import { EVENTTAP_FIELDS, FIELD_TTL_MS, cleanPhoneText, isPhoneValue, parsePhoneSnapshot, type PhoneField, type PhonePresenceSnapshot } from "./schema.js";

/** Explicitly authorized EventTap state; notification, usage, health and location columns are excluded. */
export const DEVICE_EVENT_COLUMNS = "owner,device_id,timestamp,charging,battery_level,screen_state,network_type,foreground_app,ringer_mode,wifi_ssid,bluetooth_devices";
export const DEVICE_EVENT_LIMIT = 100;

function stateFields(row: Record<string, unknown>): Partial<Record<PhoneField, unknown>> {
  const fields: Partial<Record<PhoneField, unknown>> = {
    charging: row.charging,
    batteryLevel: row.battery_level,
    network: row.network_type,
    foregroundApp: cleanPhoneText(row.foreground_app, 200),
    wifiSsid: cleanPhoneText(row.wifi_ssid),
  };
  // "unlocked" is a real display event, but it does not establish who is holding the phone.
  if (row.screen_state === "on" || row.screen_state === "unlocked") fields.screenOn = true;
  else if (row.screen_state === "off") fields.screenOn = false;
  const ringerModes: Record<string, string> = { "静音": "silent", "震动": "vibrate", "振动": "vibrate", "响铃": "normal",
    silent: "silent", vibrate: "vibrate", normal: "normal" };
  if (typeof row.ringer_mode === "string") fields.ringerMode = ringerModes[row.ringer_mode];
  // UploadWorker encodes the original Android JSON string as a JSON array.
  // NULL is a missing reading; [] is an explicit empty collector result.
  if (Array.isArray(row.bluetooth_devices) && row.bluetooth_devices.length <= 16) {
    const cleaned = row.bluetooth_devices.map(item => cleanPhoneText(item));
    if (cleaned.every(item => item !== undefined)) fields.bluetoothDevices = [...new Set(cleaned)];
  }
  return fields;
}

/** Fold sparse events by actual observation time; late uploads never refresh an old event. */
export function parseDeviceEventsSnapshot(raw: unknown, ownerId: string, sourceOwner: string, deviceId: string,
  now: number, staleRetentionMs: number, fetchedAt = now): PhonePresenceSnapshot | null {
  if (!Array.isArray(raw) || raw.length > DEVICE_EVENT_LIMIT || !sourceOwner) return null;
  const fields: Partial<Record<PhoneField, { value: unknown; observedAt: string; ttlMs: number }>> = {};
  const latest: Partial<Record<PhoneField, number>> = {};
  const activity: NonNullable<PhonePresenceSnapshot["activity"]> = { unlocks: [], charging: [] };
  for (const event of raw) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const row = event as Record<string, unknown>;
    if (row.owner !== sourceOwner || row.device_id !== deviceId || typeof row.timestamp !== "string") continue;
    // EventTap and Postgres expose zoned ISO timestamps. Ambiguous local dates cannot be observations.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(row.timestamp)) continue;
    const timestamp = Date.parse(row.timestamp);
    if (!Number.isFinite(timestamp) || timestamp > now + 300000 || now - timestamp > staleRetentionMs) continue;
    const observedAt = new Date(timestamp).toISOString();
    if (row.screen_state === "unlocked") activity.unlocks.push(observedAt);
    if (typeof row.charging === "boolean") activity.charging.push({ value: row.charging, observedAt });
    const values = stateFields(row);
    for (const field of EVENTTAP_FIELDS) {
      const value = values[field];
      if (!isPhoneValue(field, value) || (latest[field] !== undefined && timestamp <= latest[field]!)) continue;
      latest[field] = timestamp;
      fields[field] = { value, observedAt: new Date(timestamp).toISOString(), ttlMs: FIELD_TTL_MS[field] };
    }
  }
  const parsed = parsePhoneSnapshot({ owner_id: ownerId, device_id: deviceId, fields }, ownerId, deviceId,
    now, staleRetentionMs, fetchedAt, EVENTTAP_FIELDS);
  return parsed ? { ...parsed, source: "device_events", activity: {
    unlocks: [...new Set(activity.unlocks)].sort(),
    charging: activity.charging.sort((one, two) => one.observedAt.localeCompare(two.observedAt)),
  } } : null;
}
