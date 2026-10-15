import dns from "node:dns";
import net from "node:net";
import ipaddr from "ipaddr.js";
import { Agent as HttpAgent } from "undici";

export type WebFailureReason = "invalid_url" | "robots_denied" | "robots_unavailable" | "site_policy" | "restricted"
  | "rate_limit" | "http_error" | "timeout" | "network" | "too_large" | "unsupported" | "budget" | "quota"
  | "low_quality" | "invalid_response" | "upstream_error" | "authentication" | "storage";

const MESSAGES: Record<WebFailureReason, string> = {
  invalid_url: "目标 URL 不属于允许的公开网页地址", robots_denied: "站点 robots 规则禁止读取，已停止",
  robots_unavailable: "未能确认站点 robots 规则，暂不读取", site_policy: "站点访问规则禁止读取，已停止",
  restricted: "页面需要登录、付费或通过访问挑战，已停止", rate_limit: "站点或服务正在限流，等待冷却",
  http_error: "网页返回 HTTP 错误", timeout: "网页研究请求超时", network: "网页研究网络请求失败",
  too_large: "网页响应超过体积限制", unsupported: "网页内容类型不受支持", budget: "本次网页研究预算已用完",
  quota: "免费服务调用额度已达本地上限", low_quality: "未能提取足够可靠的正文", invalid_response: "网页服务返回格式无效",
  upstream_error: "网页服务暂时失败", authentication: "网页服务身份验证失败", storage: "免费额度账本不可用，已停止云端调用",
};

/** Fixed, safe error messages only: never retain upstream bodies, URLs, keys or queries. */
export class WebAccessError extends Error {
  readonly reason: WebFailureReason;
  readonly httpStatus?: number;
  readonly fallbackAllowed: boolean;
  readonly retryAfterMs?: number;
  constructor(reason: WebFailureReason, options: { httpStatus?: number; fallbackAllowed?: boolean; retryAfterMs?: number } = {}) {
    super(MESSAGES[reason] + (options.httpStatus ? ` (HTTP ${options.httpStatus})` : ""));
    this.name = "WebAccessError";
    this.reason = reason;
    this.httpStatus = options.httpStatus;
    this.fallbackAllowed = options.fallbackAllowed ?? ["timeout", "network", "low_quality", "upstream_error", "invalid_response"].includes(reason);
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isPrivateAddress(value: string): boolean {
  try {
    let address = ipaddr.parse(value.replace(/^\[|\]$/g, ""));
    if (address.kind() === "ipv6" && (address as ipaddr.IPv6).isIPv4MappedAddress()) address = (address as ipaddr.IPv6).toIPv4Address();
    if (address.range() !== "unicast") return true;
    if (address.kind() === "ipv6") {
      const bytes = address.toByteArray();
      // Accept global unicast only. Tunnel, local, transition and reserved ranges fail closed.
      if ((bytes[0]! & 0xe0) !== 0x20) return true;
      if (address.match(ipaddr.parse("2001:db8::"), 32) || address.match(ipaddr.parse("2002::"), 16)) return true;
    }
    return false;
  } catch { return true; }
}

function publicUrlSyntax(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new WebAccessError("invalid_url"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || value.length > 4096
    || (url.port && !["80", "443"].includes(url.port))) throw new WebAccessError("invalid_url");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("%") || host === "localhost" || /\.(?:localhost|local|internal|onion)$/.test(host)) throw new WebAccessError("invalid_url");
  for (const key of url.searchParams.keys()) {
    if (/^(?:access_token|authorization|api[_-]?key|session(?:id)?|password)$/i.test(key)) throw new WebAccessError("invalid_url");
  }
  return url;
}

async function publicRecords(url: URL): Promise<dns.LookupAddress[]> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new WebAccessError("invalid_url");
    return [{ address: host, family: net.isIP(host) }];
  }
  let records: dns.LookupAddress[];
  try { records = await dns.promises.lookup(host, { all: true, verbatim: true }); }
  catch { throw new WebAccessError("network"); }
  if (!records.length || records.some(record => isPrivateAddress(record.address))) throw new WebAccessError("invalid_url");
  return records;
}

export async function assertPublicUrl(value: string): Promise<URL> {
  const url = publicUrlSyntax(value);
  await publicRecords(url);
  return url;
}

export interface PublicFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  beforeRequest?: (url: string) => Promise<unknown>;
  requestLease?: (url: string) => Promise<() => void>;
  onRequest?: () => void;
  headers?: Record<string, string>;
}
export interface PublicResponse {
  body: string;
  finalUrl: string;
  contentType: string;
  status: number;
  headers: Headers;
  truncated: boolean;
}

export async function readBounded(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const pieces: Uint8Array[] = [];
  let size = 0, truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - size;
      if (value.byteLength > remaining) {
        if (remaining > 0) pieces.push(value.subarray(0, remaining));
        size += Math.max(0, remaining);
        truncated = true;
        await reader.cancel();
        break;
      }
      pieces.push(value);
      size += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
  return { bytes, truncated };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new WebAccessError("timeout");
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new WebAccessError("timeout"));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** Validates every redirect and pins the actual connection to the validated DNS records. */
export async function fetchPublic(value: string, options: PublicFetchOptions): Promise<PublicResponse> {
  const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.floor(options.timeoutMs))), ...(options.signal ? [options.signal] : [])]);
  let current = publicUrlSyntax(value);
  try {
    for (let hop = 0; hop <= 5; hop++) {
      signal.throwIfAborted();
      if (options.beforeRequest) await abortable(options.beforeRequest(current.toString()), signal);
      const records = await abortable(publicRecords(current), signal);
      const pinnedLookup = ((_host: string, lookupOptions: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => {
        const selected = records.filter(record => !lookupOptions.family || lookupOptions.family === record.family);
        if (lookupOptions.all) callback(null, selected);
        else { const record = selected[0] ?? records[0]!; callback(null, record.address, record.family); }
      }) as typeof dns.lookup;
      const dispatcher = new HttpAgent({ connect: { lookup: pinnedLookup, timeout: Math.min(10000, options.timeoutMs) } });
      let release: (() => void) | undefined;
      try {
        if (options.requestLease) release = await abortable(options.requestLease(current.toString()).then(lease => {
          if (signal.aborted) { lease(); throw new WebAccessError("timeout"); }
          return lease;
        }), signal);
        options.onRequest?.();
        const response = await fetch(current, {
          redirect: "manual", signal,
          headers: { "User-Agent": "QQResearchBot/1.0", Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6", ...options.headers },
          dispatcher,
        } as RequestInit);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || hop === 5) throw new WebAccessError("http_error", { httpStatus: response.status });
          current = publicUrlSyntax(new URL(location, current).toString());
          continue;
        }
        const { bytes, truncated } = await readBounded(response, options.maxBytes);
        const contentType = response.headers.get("content-type") ?? "";
        const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
        let body: string;
        try { body = new TextDecoder(charset).decode(bytes); } catch { body = new TextDecoder().decode(bytes); }
        return { body, finalUrl: current.toString(), contentType, status: response.status, headers: response.headers, truncated };
      } finally { release?.(); await dispatcher.close(); }
    }
    throw new WebAccessError("http_error");
  } catch (error) {
    if (error instanceof WebAccessError) throw error;
    if (signal.aborted) throw new WebAccessError("timeout");
    throw new WebAccessError("network");
  }
}

/** Latest finite timestamp supported by JavaScript Date, used to fail closed on absurd retry values. */
export const MAX_COOLDOWN_TIMESTAMP = 8_640_000_000_000_000;

/** Preserve long site-requested waits. Only an absent value uses the default delay. */
export function normalizeRetryAfterMs(value: unknown): number {
  if (value === undefined) return 60_000;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
    return Math.max(1000, Math.ceil(value));
  }
  // Malformed or unsafe values must not turn a potentially very long wait into an early retry.
  return MAX_COOLDOWN_TIMESTAMP;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number {
  if (value === null) return normalizeRetryAfterMs(undefined);
  const text = value.trim();
  if (/^\d+$/.test(text)) return normalizeRetryAfterMs(Number(text) * 1000);
  // All HTTP-date forms start with a weekday. Do not let Date.parse turn a
  // malformed numeric delay such as "-1" into an unrelated date in the past.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s/i.test(text)) return MAX_COOLDOWN_TIMESTAMP;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return MAX_COOLDOWN_TIMESTAMP;
  return normalizeRetryAfterMs(Math.max(0, timestamp - now));
}
