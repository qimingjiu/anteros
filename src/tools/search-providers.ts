import { isIP } from "node:net";
import { canonicalUrl } from "./research.js";

export type SearchBackendName = "searxng" | "tavily" | "exa" | "google_cse";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface SearchBackendSettings {
  searxngUrl?: string;
  tavilyApiKey?: string;
  exaApiKey?: string;
  googleCse?: { apiKey: string; cx: string };
}

export interface SearchBackend {
  readonly name: SearchBackendName;
  search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult[]>;
}

/** Only fixed metadata is safe to pass to diagnostic logs or the model. */
export class SearchBackendError extends Error {
  constructor(
    readonly provider: SearchBackendName,
    readonly code: "http" | "network" | "timeout" | "invalid_response",
    readonly status?: number,
  ) {
    super(status === undefined ? `Search ${provider}: ${code}` : `Search ${provider} HTTP ${status}`);
    this.name = "SearchBackendError";
  }
}

const MAX_RESPONSE_BYTES = 1_048_576;

function isPrivateLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(host) === 6) {
    // Reject IPv4-mapped/compatible forms as well as loopback and link-local.
    return host.startsWith("::") || /^(?:fc|fd|ff|fe[89ab])/i.test(host);
  }
  return false;
}

/** This is result filtering, not a replacement for the reader's DNS/robots checks. */
export function normalizeSearchUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(canonicalUrl(value));
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || host === "localhost" || /\.(?:localhost|local|internal|lan|home)$/.test(host)) return null;
    if (isPrivateLiteral(host) || (!host.includes(".") && !isIP(host.replace(/^\[|\]$/g, "")))) return null;
    url.hostname = host;
    return url.toString();
  } catch {
    return null;
  }
}

function searchUrlKey(url: string): string {
  const canonical = new URL(url);
  canonical.searchParams.sort();
  return canonical.toString();
}

export function mergeSearchResults(groups: readonly SearchResult[][], maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const result of group) {
      const url = normalizeSearchUrl(result.url);
      if (!url) continue;
      const key = searchUrlKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ ...result, url });
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

function text(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.slice(0, maxChars) : "";
}

export function normalizeSearchResults(
  items: unknown[],
  source: SearchBackendName,
  maxResults: number,
  fields: { url?: string; snippet?: string } = {},
): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const url = normalizeSearchUrl(record[fields.url ?? "url"]);
    if (!url) continue;
    const key = searchUrlKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ title: text(record.title, 512), url,
      snippet: fields.snippet ? text(record[fields.snippet], 400) : "", source });
    if (results.length >= maxResults) break;
  }
  return results;
}

async function readJson(response: Response, provider: SearchBackendName): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new SearchBackendError(provider, "invalid_response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SearchBackendError(provider, "invalid_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new SearchBackendError(provider, "invalid_response");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const json: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error();
    return json as Record<string, unknown>;
  } catch {
    throw new SearchBackendError(provider, "invalid_response");
  }
}

function limit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(10, Math.floor(value))) : 5;
}

function searxngEndpoint(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    url.pathname = `${url.pathname.replace(/\/$/, "").replace(/\/search$/, "")}/search`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function createSearchBackend(
  provider: string,
  settings: SearchBackendSettings,
  fetchImpl: typeof fetch = fetch,
): SearchBackend | null {
  let endpoint: string;
  switch (provider) {
    case "searxng": {
      const configured = searxngEndpoint(settings.searxngUrl);
      if (!configured) return null;
      endpoint = configured;
      break;
    }
    case "tavily":
      if (!settings.tavilyApiKey) return null;
      endpoint = "https://api.tavily.com/search";
      break;
    case "exa":
      if (!settings.exaApiKey) return null;
      endpoint = "https://api.exa.ai/search";
      break;
    case "google_cse":
      if (!settings.googleCse?.apiKey || !settings.googleCse.cx) return null;
      endpoint = "https://www.googleapis.com/customsearch/v1";
      break;
    default:
      return null;
  }
  const name = provider as SearchBackendName;
  return {
    name,
    async search(query, maxResults, signal) {
      const count = limit(maxResults);
      const request: RequestInit = { signal, redirect: "error" };
      let url = endpoint;
      switch (name) {
        case "searxng":
          request.method = "POST";
          request.headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
          request.body = new URLSearchParams({ q: query, format: "json", pageno: "1" }).toString();
          break;
        case "tavily":
          request.method = "POST";
          request.headers = { "Content-Type": "application/json", Authorization: `Bearer ${settings.tavilyApiKey}` };
          request.body = JSON.stringify({ query, max_results: count, search_depth: "basic",
            auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false });
          break;
        case "exa":
          request.method = "POST";
          request.headers = { "Content-Type": "application/json", "x-api-key": settings.exaApiKey! };
          // Search metadata only. Do not request contents/livecrawl, synthesized output or research.
          request.body = JSON.stringify({ query, type: "auto", numResults: count });
          break;
        case "google_cse": {
          const googleUrl = new URL(endpoint);
          googleUrl.searchParams.set("key", settings.googleCse!.apiKey);
          googleUrl.searchParams.set("cx", settings.googleCse!.cx);
          googleUrl.searchParams.set("q", query);
          googleUrl.searchParams.set("num", String(count));
          url = googleUrl.toString();
          break;
        }
      }
      let json: Record<string, unknown>;
      try {
        const response = await fetchImpl(url, request);
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new SearchBackendError(name, "http", response.status);
        }
        json = await readJson(response, name);
      } catch (error) {
        if (error instanceof SearchBackendError) throw error;
        // Fetch/JSON errors may include full request URLs, query text or headers.
        throw new SearchBackendError(name, signal.aborted ? "timeout" : "network");
      }
      const items = name === "google_cse" ? (json.items ?? []) : json.results;
      if (!Array.isArray(items) || json.error) throw new SearchBackendError(name, "invalid_response");
      const fields = name === "google_cse" ? { url: "link", snippet: "snippet" }
        : name === "tavily" || name === "searxng" ? { snippet: "content" } : {};
      return normalizeSearchResults(items, name, count, fields);
    },
  };
}
