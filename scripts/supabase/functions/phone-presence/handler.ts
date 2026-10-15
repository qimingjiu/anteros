/** Portable handler, tested under Node and served by Deno. No SDK is required. */
export interface PresenceIngestDependencies {
  env(name: string): string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
}
const allowedFields = new Set(["charging", "batteryLevel", "screenOn", "network", "routine"]);
export function parsePresenceEvent(raw: unknown, now: number): { state: Record<string, boolean | number | string>; observedAt: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid payload");
  const event = raw as Record<string, unknown>;
  if (Object.keys(event).some(key => key !== "state" && key !== "observedAt")
    || !event.state || typeof event.state !== "object" || Array.isArray(event.state)) throw new Error("invalid payload");
  const source = event.state as Record<string, unknown>;
  if (!Object.keys(source).length || Object.keys(source).some(key => !allowedFields.has(key))) throw new Error("invalid state");
  const state: Record<string, boolean | number | string> = {};
  for (const [field, value] of Object.entries(source)) {
    const valid = (field === "charging" || field === "screenOn") ? typeof value === "boolean"
      : field === "batteryLevel" ? typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
      : field === "network" ? value === "wifi" || value === "mobile" || value === "offline"
      : value === "home" || value === "sleep" || value === "wakeup";
    if (!valid) throw new Error("invalid state field");
    state[field] = value as boolean | number | string;
  }
  const input = event.observedAt;
  // MacroDroid [system_time] is Unix seconds; milliseconds and ISO offsets work too.
  const timestamp = input === undefined ? now : typeof input === "number"
    ? (input < 100000000000 ? input * 1000 : input)
    : typeof input === "string" ? Date.parse(input) : NaN;
  if (!Number.isFinite(timestamp) || timestamp > now + 300000 || timestamp < now - 86400000) throw new Error("invalid observation time");
  return { state, observedAt: new Date(timestamp).toISOString() };
}
function serverKey(env: PresenceIngestDependencies["env"]): string {
  const named = env("SUPABASE_SECRET_KEYS");
  if (named) {
    const keys: unknown = JSON.parse(named);
    if (keys && typeof keys === "object" && typeof (keys as Record<string, unknown>).default === "string") {
      return (keys as Record<string, string>).default!;
    }
  }
  return env("SUPABASE_SECRET_KEY") || env("SUPABASE_SERVICE_ROLE_KEY") || "";
}
async function smallJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > 4096) throw new Error("payload too large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid payload");
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 4096) { await reader.cancel(); throw new Error("payload too large"); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally { reader.releaseLock(); }
}
export function createPresenceIngestHandler(dependencies: PresenceIngestDependencies): (request: Request) => Promise<Response> {
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => Date.now());
  const response = (status: number, error?: string) => Response.json(error ? { error } : { ok: true }, {
    status, headers: { "Cache-Control": "no-store" },
  });
  return async request => {
    if (request.method !== "POST") return response(405, "method not allowed");
    const token = request.headers.get("X-Device-Token") ?? "";
    if (!/^[0-9a-f]{64}$/u.test(token)) return response(401, "invalid device token");
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get("Content-Type") ?? "")) return response(415, "application/json required");
    let event: ReturnType<typeof parsePresenceEvent>;
    try { event = parsePresenceEvent(await smallJson(request), now()); }
    catch { return response(400, "invalid phone state"); }
    try {
      const url = dependencies.env("SUPABASE_URL");
      const key = serverKey(dependencies.env);
      if (!url || !key || key.startsWith("sb_publishable_")) return response(503, "service unavailable");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const tokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json" };
      if (!key.startsWith("sb_")) headers.Authorization = `Bearer ${key}`;
      const result = await fetcher(new URL("/rest/v1/rpc/phone_presence_ingest", url), {
        method: "POST", headers, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ p_token_hash: tokenHash, p_state: event.state, p_observed_at: event.observedAt }),
      });
      if (!result.ok) return response(503, "service unavailable");
      const accepted: unknown = await result.json();
      return accepted === true ? response(200) : response(401, "invalid device token");
    } catch { return response(503, "service unavailable"); }
  };
}
