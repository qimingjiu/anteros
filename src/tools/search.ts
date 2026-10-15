import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";
import { logger } from "../util/logger.js";
import { ResearchRuntime, WebAccessError } from "./research.js";
import { createSearchBackend, mergeSearchResults, SearchBackendError, type SearchBackend, type SearchResult } from "./search-providers.js";

export type { SearchResult } from "./search-providers.js";

const log = logger("search");

export interface SearchProvider {
  readonly name: string;
  search(query: string, maxResults: number): Promise<SearchResult[]>;
  getReceipt?(): unknown;
}

type SearchSettings = Omit<AppConfig["tools"]["search"], "provider"> & {
  provider: string;
  searxngUrl?: string;
  exaApiKey?: string;
  fallbackProviders?: string[];
  minResultsBeforeFallback?: number;
  cacheTtlMs?: number;
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeProviderError(error: unknown): WebAccessError {
  if (error instanceof WebAccessError) return error;
  if (!(error instanceof SearchBackendError)) return new WebAccessError("network", { fallbackAllowed: true });
  const status = error.status;
  const reason = status === 401 || status === 403 ? "authentication"
    : status === 402 || status === 432 || status === 433 ? "quota"
    : status === 429 ? "rate_limit"
    : status !== undefined && status >= 500 ? "upstream_error"
    : error.code === "invalid_response" || status !== undefined ? "invalid_response" : "network";
  return new WebAccessError(reason, { httpStatus: status, fallbackAllowed: true });
}

export function createSearchProvider(
  cfg: SearchSettings,
  runtime = new ResearchRuntime(),
  fetchImpl: typeof fetch = fetch,
): SearchProvider | null {
  if (cfg.provider === "none") return null;
  const primary = createSearchBackend(cfg.provider, cfg, fetchImpl);
  const alternatives = [...new Set(cfg.fallbackProviders ?? [])]
    .filter(name => name !== cfg.provider)
    .map(name => createSearchBackend(name, cfg, fetchImpl))
    .filter((backend): backend is SearchBackend => backend !== null);
  // Missing credentials are not an HTTP attempt; select the first explicitly configured backup.
  const first = primary ?? alternatives.shift();
  if (!first) {
    log.warn("搜索不可用：搜索后端未配置或缺少凭据");
    return null;
  }
  const ttlMs = cfg.cacheTtlMs ?? 10 * 60_000;
  // Credentials influence cache isolation through a digest; neither keys nor queries are stored in cache keys.
  const cacheIdentity = hash({ provider: cfg.provider, searxngUrl: cfg.searxngUrl,
    tavilyApiKey: cfg.tavilyApiKey, exaApiKey: cfg.exaApiKey, googleCse: cfg.googleCse });

  async function request(backend: SearchBackend, query: string, maxResults: number): Promise<SearchResult[]> {
    const key = `${cacheIdentity}:${backend.name}:${maxResults}:${hash(query)}`;
    const result = await runtime.cached<SearchResult[]>("search", key, ttlMs, async () => {
      // Shared budgets must be reserved only on a real cache miss, immediately before the request.
      runtime.beforeProvider(backend.name, "search");
      try {
        return await backend.search(query, maxResults, runtime.signal(cfg.timeoutMs));
      } catch (error) {
        throw safeProviderError(error);
      }
    });
    return result.value.map(item => ({ ...item }));
  }

  return {
    name: first.name,
    getReceipt: () => runtime.receipt(),
    search(query, maxResults) {
      return runtime.run(async () => {
        const normalized = query.normalize("NFKC").trim().replace(/\s+/g, " ");
        if (!normalized) return [];
        runtime.session.visitQuery(normalized);
        const requested = Number.isFinite(maxResults) ? Math.floor(maxResults) : cfg.maxResults;
        const count = Math.max(1, Math.min(10, cfg.maxResults, requested));
        const configuredMinimum = cfg.minResultsBeforeFallback ?? 2;
        const minimum = Math.max(1, Math.min(count, Number.isFinite(configuredMinimum) ? Math.floor(configuredMinimum) : 2));
        let primaryResults: SearchResult[] = [];
        let primaryFailure: WebAccessError | undefined;
        try {
          primaryResults = await request(first, normalized, count);
          if (primaryResults.length >= minimum) return primaryResults;
        } catch (error) {
          // A turn-wide budget or policy stop must never trigger another backend.
          if (!(error instanceof WebAccessError) || !error.fallbackAllowed) throw error;
          primaryFailure = error;
        }
        // Availability only checks local provider health/quota and never consumes a request.
        const fallback = primary ? alternatives.find(backend => runtime.providerAvailable(backend.name)) : undefined;
        if (!fallback) {
          if (primaryFailure) throw primaryFailure;
          return primaryResults;
        }
        if (primaryFailure) log.warn("搜索主后端失败，尝试一次已配置的备用后端", primaryFailure);
        try {
          const additional = await request(fallback, normalized, count);
          return mergeSearchResults([primaryResults, additional], count);
        } catch (error) {
          const failure = safeProviderError(error);
          runtime.noteFailure(failure, fallback.name);
          if (!primaryResults.length) throw failure;
          // Keep useful primary evidence if supplementation fails or the shared budget stops it.
          log.warn("搜索备用后端未补充成功，保留已有结果", failure);
          return primaryResults;
        }
      });
    },
  };
}
