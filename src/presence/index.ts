import type { PhonePresenceConfig } from "../config.js";
import { EVENTTAP_FIELDS, PHONE_FIELDS, formatPhoneContext, parsePhoneSnapshot, type PhoneField, type PhonePresenceSnapshot } from "./schema.js";
import { DEVICE_EVENT_COLUMNS, DEVICE_EVENT_LIMIT, parseDeviceEventsSnapshot } from "./device-events.js";
export type { PhonePresenceSnapshot, PhoneSample, PhoneField } from "./schema.js";

export interface PhoneContextRequest {
  senderId: string;
  conversationType: "private" | "group";
  groupId?: string;
  purpose?: "chat" | "proactive";
}

/** The owner explicitly chooses which public rooms may use this device's observations. */
export function isPhoneContextAllowed(config: PhonePresenceConfig | undefined, request: PhoneContextRequest): boolean {
  if (!config?.enabled || request.senderId !== config.ownerId) return false;
  return request.conversationType === "private" || Boolean(request.conversationType === "group" && request.groupId
    && config.allowedGroupIds?.includes(request.groupId));
}
export interface PhoneContextProvider {
  context(request: PhoneContextRequest): Promise<string>;
  contextResult?(request: PhoneContextRequest): Promise<PhoneContextResult>;
  status?(): PhonePresenceStatus;
  /** Optional typed sensor feed for deterministic owner-only triggers. */
  snapshot?(): Promise<PhonePresenceSnapshot | null>;
}
/** A receipt contains times and counts, never state readings, identity or sensor strings. */
export interface PhoneContextReceipt {
  source: "phone_presence_state" | "device_events";
  purpose: "chat" | "proactive";
  contextChars: number;
  fieldCount: number;
  newestObservedAt: string;
  oldestObservedAt: string;
  freshFieldCount: number;
  staleFieldCount: number;
}
export interface PhoneContextResult {
  context: string;
  receipt: PhoneContextReceipt | null;
}
export type PhoneFetchFailure = "timeout" | "http" | "invalid_json" | "oversized" | "invalid_response" | "network";
export interface PhonePresenceStatus {
  enabled: boolean;
  configured: boolean;
  source: "phone_presence_state" | "device_events";
  supportedFields: readonly PhoneField[];
  lastFetch: { at: string; status: "ready" | "empty" | "failed"; httpStatus: number | null; failure?: PhoneFetchFailure } | null;
  cacheExpiresAt: string | null;
  currentFieldCount: number;
  currentFreshFieldCount: number;
}
interface Dependencies {
  fetch?: typeof fetch;
  now?: () => number;
}

/** A server-side pull of one owner's one device. No persistence, sensors-as-memory, or realtime subscriptions. */
export class PhonePresenceService implements PhoneContextProvider {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private cache: { raw: unknown; fetchedAt: number; expiresAt: number } | undefined;
  private inflight: Promise<void> | undefined;
  private lastFetch: PhonePresenceStatus["lastFetch"] = null;

  constructor(private readonly config?: PhonePresenceConfig, dependencies: Dependencies = {}) {
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => Date.now());
  }

  async context(request: PhoneContextRequest): Promise<string> {
    return (await this.contextResult(request)).context;
  }

  async contextResult(request: PhoneContextRequest): Promise<PhoneContextResult> {
    // Reject other people and unapproved rooms before reading even an already warm cache.
    if (!isPhoneContextAllowed(this.config, request)) return { context: "", receipt: null };
    const snapshot = await this.snapshot();
    const context = formatPhoneContext(snapshot);
    if (!snapshot || !context) return { context, receipt: null };
    const times = snapshot.fields.map(field => field.observedAt).sort();
    const freshFieldCount = snapshot.fields.filter(field => field.fresh).length;
    return { context, receipt: { source: snapshot.source ?? "phone_presence_state", purpose: request.purpose ?? "chat",
      contextChars: context.length, fieldCount: snapshot.fields.length,
      newestObservedAt: times.at(-1)!, oldestObservedAt: times[0]!, freshFieldCount,
      staleFieldCount: snapshot.fields.length - freshFieldCount } };
  }

  /** Synchronous diagnostics do not fetch, expose credentials or include owner/device identities. */
  status(): PhonePresenceStatus {
    const cfg = this.config;
    const snapshot = this.cachedSnapshot();
    const source = cfg?.source ?? "phone_presence_state";
    return { enabled: cfg?.enabled ?? false, configured: Boolean(cfg?.supabaseUrl && cfg.serverKey && cfg.ownerId && cfg.deviceId
      && (source !== "device_events" || cfg.sourceOwner)), source,
      supportedFields: [...(source === "device_events" ? EVENTTAP_FIELDS : PHONE_FIELDS)],
      lastFetch: this.lastFetch ? { ...this.lastFetch } : null,
      cacheExpiresAt: this.cache ? new Date(this.cache.expiresAt).toISOString() : null,
      currentFieldCount: snapshot?.fields.length ?? 0,
      currentFreshFieldCount: snapshot?.fields.filter(field => field.fresh).length ?? 0 };
  }

  async snapshot(): Promise<PhonePresenceSnapshot | null> {
    const cfg = this.config;
    if (!cfg?.enabled || !cfg.supabaseUrl || !cfg.serverKey || !cfg.ownerId || !cfg.deviceId) return null;
    if (!this.cache || this.now() >= this.cache.expiresAt) {
      if (!this.inflight) {
        this.inflight = this.refresh().finally(() => { this.inflight = undefined; });
      }
      await this.inflight;
    }
    return this.cachedSnapshot();
  }

  private cachedSnapshot(): PhonePresenceSnapshot | null {
    const cfg = this.config;
    if (!cfg?.enabled || !this.cache?.raw) return null;
    if (cfg.source === "device_events") {
      return parseDeviceEventsSnapshot(this.cache.raw, cfg.ownerId, cfg.sourceOwner ?? "", cfg.deviceId,
        this.now(), cfg.staleRetentionMs, this.cache.fetchedAt);
    }
    return parsePhoneSnapshot(this.cache.raw, cfg.ownerId, cfg.deviceId, this.now(), cfg.staleRetentionMs, this.cache.fetchedAt);
  }

  private async refresh(): Promise<void> {
    const cfg = this.config!;
    const timeout = Math.min(10000, Math.max(100, cfg.requestTimeoutMs));
    const cacheTtl = Math.min(300000, Math.max(1000, cfg.cacheTtlMs));
    let raw: unknown = null;
    let httpStatus: number | null = null;
    let failure: PhoneFetchFailure | undefined;
    try {
      const isEventTap = cfg.source === "device_events";
      const url = new URL(isEventTap ? "/rest/v1/device_events" : "/rest/v1/phone_presence_state", cfg.supabaseUrl);
      url.searchParams.set("select", isEventTap ? DEVICE_EVENT_COLUMNS : "owner_id,device_id,fields");
      url.searchParams.set(isEventTap ? "owner" : "owner_id", `eq.${isEventTap ? cfg.sourceOwner ?? "" : cfg.ownerId}`);
      url.searchParams.set("device_id", `eq.${cfg.deviceId}`);
      url.searchParams.set("limit", String(isEventTap ? DEVICE_EVENT_LIMIT : 1));
      if (isEventTap) {
        if (!cfg.sourceOwner) throw new Error("EventTap owner label missing");
        url.searchParams.set("timestamp", `gte.${new Date(this.now() - cfg.staleRetentionMs).toISOString()}`);
        url.searchParams.set("order", "timestamp.desc");
      }
      const headers: Record<string, string> = { apikey: cfg.serverKey, Accept: "application/json" };
      // The legacy service_role key is a JWT; new sb_secret_* keys belong only in apikey.
      if (!cfg.serverKey.startsWith("sb_")) headers.Authorization = `Bearer ${cfg.serverKey}`;
      const response = await this.fetcher(url, { method: "GET", headers, signal: AbortSignal.timeout(timeout) });
      httpStatus = response.status;
      if (!response.ok) { failure = "http"; throw new Error("phone context unavailable"); }
      const contentLength = Number(response.headers.get("content-length"));
      const maxResponseChars = isEventTap ? 65536 : 16384;
      if (contentLength > maxResponseChars) { failure = "oversized"; throw new Error("phone context too large"); }
      const body = await response.text();
      if (body.length > maxResponseChars) { failure = "oversized"; throw new Error("phone context too large"); }
      let rows: unknown;
      try { rows = JSON.parse(body); }
      catch { failure = "invalid_json"; throw new Error("phone context malformed"); }
      if (Array.isArray(rows) && rows.length <= (isEventTap ? DEVICE_EVENT_LIMIT : 1)) {
        raw = isEventTap ? rows : rows.length === 1 ? rows[0] : null;
      } else { failure = "invalid_response"; throw new Error("phone context malformed"); }
    } catch (error) {
      // Loss of telemetry supplies no context, rather than inventing that the owner is asleep/offline.
      // Do not log response bodies or keys, and do not block the chat on remote failures.
      failure ??= error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "network";
    }
    const fetchedAt = this.now();
    this.cache = { raw, fetchedAt, expiresAt: fetchedAt + cacheTtl };
    this.lastFetch = { at: new Date(fetchedAt).toISOString(), status: failure ? "failed" : this.cachedSnapshot() ? "ready" : "empty",
      httpStatus, ...(failure ? { failure } : {}) };
  }
}
