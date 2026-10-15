import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { assertPublicUrl, fetchPublic, parseRetryAfter, normalizeRetryAfterMs, MAX_COOLDOWN_TIMESTAMP, WebAccessError, type WebFailureReason, type PublicFetchOptions, type PublicResponse } from "./web-http.js";
export { WebAccessError, type WebFailureReason } from "./web-http.js";
interface RobotsRules { isAllowed(url: string, agent: string): boolean | undefined; getCrawlDelay(agent: string): number | undefined }
const robotsParser = createRequire(import.meta.url)("robots-parser") as (url: string, text: string) => RobotsRules;

export interface ResearchLimits {
  maxQueries: number;
  maxSearchRequests: number;
  maxPages: number;
  maxBrowserRenders: number;
  maxCloudExtractions: number;
  maxHttpRequests: number;
  maxOutputChars: number;
  totalTimeoutMs: number;
}
export const DEFAULT_RESEARCH_LIMITS: ResearchLimits = {
  maxQueries: 3, maxSearchRequests: 3, maxPages: 6, maxBrowserRenders: 2, maxCloudExtractions: 2,
  maxHttpRequests: 24, maxOutputChars: 48000, totalTimeoutMs: 45000,
};
export type ResearchProvider = "searxng" | "tavily" | "exa" | "google_cse" | "firecrawl" | "jina" | "crawl4ai";
export type ResearchOperation = "search" | "extract" | "render";
export interface ProviderQuota { daily: number; monthly: number }
export const DEFAULT_QUOTAS: Record<string, ProviderQuota> = {
  tavily: { daily: 20, monthly: 600 }, firecrawl: { daily: 30, monthly: 800 },
  exa: { daily: 0.15, monthly: 4 }, google_cse: { daily: 30, monthly: 500 },
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const normalizeQuery = (query: string) => query.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

export function canonicalUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new WebAccessError("invalid_url"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new WebAccessError("invalid_url");
  if (!/^#(?:\/|!)/.test(url.hash)) url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key) || /^(?:fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
  return url.toString();
}

export class ResearchSession {
  readonly scope: string;
  readonly signal?: AbortSignal;
  private started: number | undefined;
  readonly queries = new Set<string>();
  readonly urls = new Set<string>();
  readonly contents = new Map<string, string>();
  readonly used = { queries: 0, searchRequests: 0, pages: 0, browserRenders: 0, cloudExtractions: 0, httpRequests: 0, outputChars: 0 };
  cacheHits = 0;
  constructor(scope: string, readonly limits: ResearchLimits, private now: () => number, signal?: AbortSignal) { this.scope = hash(scope); this.signal = signal; }
  check(): void {
    if (this.signal?.aborted) throw new WebAccessError("timeout");
    if (this.started === undefined) this.started = this.now();
    if (this.now() - this.started >= this.limits.totalTimeoutMs) throw new WebAccessError("budget");
  }
  remainingMs(): number { this.check(); return Math.max(1, this.timeLeft()); }
  timeLeft(): number { return this.started === undefined ? this.limits.totalTimeoutMs : Math.max(0, this.limits.totalTimeoutMs - (this.now() - this.started)); }
  reserve(key: keyof ResearchSession["used"], count = 1): void {
    this.check();
    const maximum: Record<keyof ResearchSession["used"], number> = { queries: this.limits.maxQueries, searchRequests: this.limits.maxSearchRequests,
      pages: this.limits.maxPages, browserRenders: this.limits.maxBrowserRenders, cloudExtractions: this.limits.maxCloudExtractions,
      httpRequests: this.limits.maxHttpRequests, outputChars: this.limits.maxOutputChars };
    if (this.used[key] + count > maximum[key]) throw new WebAccessError("budget");
    this.used[key] += count;
  }
  visitQuery(value: string): void { const key = normalizeQuery(value); if (!key || key.length > 1000) throw new WebAccessError("invalid_response"); if (!this.queries.has(key)) { this.reserve("queries"); this.queries.add(key); } else this.check(); }
  visitUrl(value: string): void { const key = canonicalUrl(value); if (!this.urls.has(key)) { this.reserve("pages"); this.urls.add(key); } else this.check(); }
}

interface CacheEntry { expires: number; value?: unknown; error?: { reason: WebFailureReason; httpStatus?: number; fallbackAllowed: boolean; retryAfterMs?: number } }
interface QuotaState { version: 1; periods: Record<string, Record<string, number>> }
export interface ResearchRuntimeOptions {
  limits?: Partial<ResearchLimits>;
  quotaFile?: string;
  quotas?: Record<string, ProviderQuota>;
  blockedDomains?: string[];
  robotsTtlMs?: number;
  cacheEntries?: number;
  perHostDelayMs?: number;
  now?: () => number;
  publicFetch?: (url: string, options: PublicFetchOptions) => Promise<PublicResponse>;
  publicUrl?: (url: string) => Promise<URL>;
}

/** One controller is shared by search, direct reads, renderers and provider fallbacks. */
export class ResearchRuntime {
  readonly limits: ResearchLimits;
  private context = new AsyncLocalStorage<ResearchSession>();
  private cache = new Map<string, CacheEntry>();
  private flights = new Map<string, Promise<unknown>>();
  private robots = new Map<string, { expires: number; value?: ReturnType<typeof robotsParser>; denied?: boolean; unavailable?: boolean }>();
  private robotsFlights = new Map<string, Promise<void>>();
  private cooldown = new Map<string, number>();
  private hosts = new Map<string, { next: number; chain: Promise<void> }>();
  private hostLeases = new Map<string, Promise<void>>();
  private quotaState: QuotaState = { version: 1, periods: {} };
  private storageFailed = false;
  private lastFailure?: { reason: WebFailureReason; at: string; provider?: ResearchProvider };
  private now: () => number;
  private http: NonNullable<ResearchRuntimeOptions["publicFetch"]>;
  private validateUrl: NonNullable<ResearchRuntimeOptions["publicUrl"]>;
  constructor(private options: ResearchRuntimeOptions = {}) {
    this.limits = { ...DEFAULT_RESEARCH_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.http = options.publicFetch ?? fetchPublic;
    this.validateUrl = options.publicUrl ?? assertPublicUrl;
    if (options.quotaFile) {
      try {
        if (fs.existsSync(options.quotaFile)) {
          const stat = fs.lstatSync(options.quotaFile);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error();
          const raw = JSON.parse(fs.readFileSync(options.quotaFile, "utf8")) as QuotaState;
          if (raw.version !== 1 || !raw.periods || typeof raw.periods !== "object" || Array.isArray(raw.periods)) throw new Error();
          for (const [period, values] of Object.entries(raw.periods)) {
            if (!/^(?:day:\d{4}-\d\d-\d\d|month:\d{4}-\d\d)$/.test(period) || !values || typeof values !== "object" || Array.isArray(values)) throw new Error();
            for (const [provider, count] of Object.entries(values)) if (!Object.hasOwn(DEFAULT_QUOTAS, provider) || !Number.isFinite(count) || count < 0) throw new Error();
          }
          this.quotaState = raw;
        }
      } catch { this.storageFailed = true; }
    }
  }
  get session(): ResearchSession { const session = this.context.getStore(); if (!session) throw new Error("Research session is required"); return session; }
  withSession<T>(scope: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.context.run(new ResearchSession(scope, this.limits, this.now, signal), action);
  }
  run<T>(action: () => Promise<T>): Promise<T> {
    return this.context.getStore() ? action() : this.withSession(`isolated:${randomUUID()}`, action);
  }
  signal(timeoutMs: number): AbortSignal {
    const session = this.session;
    return AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.floor(Math.min(timeoutMs, session.remainingMs())))), ...(session.signal ? [session.signal] : [])]);
  }
  beforeProvider(provider: ResearchProvider, operation: ResearchOperation, units?: number): void {
    const session = this.session;
    if (operation === "search") session.reserve("searchRequests");
    if (operation === "render") session.reserve("browserRenders");
    if (operation === "extract" && ["firecrawl", "tavily", "jina"].includes(provider)) session.reserve("cloudExtractions");
    session.reserve("httpRequests");
    const configured = this.options.quotas?.[provider] ?? DEFAULT_QUOTAS[provider];
    if (!configured) return;
    if (this.storageFailed) throw new WebAccessError("storage");
    const cost = units ?? (provider === "exa" ? 0.007 : 1);
    if (!(cost > 0) || !Number.isFinite(cost)) throw new WebAccessError("quota");
    const date = new Date(this.now()).toISOString();
    const periods = [`month:${date.slice(0, 7)}`, `day:${date.slice(0, 10)}`];
    for (const period of periods) {
      const current = this.quotaState.periods[period]?.[provider] ?? 0;
      const limit = period.startsWith("day:") ? configured.daily : configured.monthly;
      if (current + cost > limit + 1e-9) { this.noteFailure(new WebAccessError("quota"), provider); throw new WebAccessError("quota", { fallbackAllowed: operation === "search" }); }
    }
    for (const period of periods) {
      const entry = this.quotaState.periods[period] ??= {};
      entry[provider] = Math.round(((entry[provider] ?? 0) + cost) * 1e6) / 1e6;
    }
    // No query, URL, account, credentials or page text is ever persisted here.
    for (const period of Object.keys(this.quotaState.periods)) if (!periods.includes(period)) delete this.quotaState.periods[period];
    if (this.options.quotaFile) {
      const temporary = `${this.options.quotaFile}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(path.dirname(this.options.quotaFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(temporary, JSON.stringify(this.quotaState), { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, this.options.quotaFile);
      } catch { this.storageFailed = true; try { fs.unlinkSync(temporary); } catch {} throw new WebAccessError("storage"); }
    }
  }
  providerAvailable(provider: string): boolean {
    const limit = this.options.quotas?.[provider] ?? DEFAULT_QUOTAS[provider];
    if (!limit) return true;
    if (this.storageFailed) return false;
    const date = new Date(this.now()).toISOString();
    const cost = provider === "exa" ? 0.007 : 1;
    return (this.quotaState.periods[`day:${date.slice(0, 10)}`]?.[provider] ?? 0) + cost <= limit.daily + 1e-9
      && (this.quotaState.periods[`month:${date.slice(0, 7)}`]?.[provider] ?? 0) + cost <= limit.monthly + 1e-9;
  }
  async cached<T>(kind: "search" | "page", key: string, ttlMs: number, action: () => Promise<T>, ttlForValue?: (value: T) => number): Promise<{ value: T; cacheHit: boolean }> {
    const session = this.session; session.check();
    const id = hash(`${session.scope}\0${kind}\0${key}`);
    const cached = this.cache.get(id);
    if (cached && cached.expires > this.now()) {
      session.cacheHits++;
      if (cached.error) throw new WebAccessError(cached.error.reason, cached.error);
      return { value: structuredClone(cached.value as T), cacheHit: true };
    }
    const existing = this.flights.get(id) as Promise<T> | undefined;
    if (existing) { session.cacheHits++; return { value: structuredClone(await this.wait(existing)), cacheHit: true }; }
    const task = Promise.resolve().then(async () => {
      try {
        const value = await action();
        this.setCache(id, { value: structuredClone(value), expires: this.now() + Math.max(0, ttlForValue ? ttlForValue(value) : ttlMs) });
        return value;
      } catch (error) {
        if (error instanceof WebAccessError) {
          this.noteFailure(error);
          if (!["budget", "quota", "storage"].includes(error.reason)) this.setCache(id, { expires: this.now() + Math.min(60000, ttlMs),
            error: { reason: error.reason, httpStatus: error.httpStatus, fallbackAllowed: error.fallbackAllowed, retryAfterMs: error.retryAfterMs } });
        }
        throw error;
      } finally { this.flights.delete(id); }
    });
    this.flights.set(id, task);
    return { value: structuredClone(await this.wait(task)), cacheHit: false };
  }
  private async wait<T>(promise: Promise<T>): Promise<T> {
    const signal = this.signal(this.limits.totalTimeoutMs);
    return new Promise<T>((resolve, reject) => {
      const stopped = () => reject(new WebAccessError("timeout"));
      if (signal.aborted) { stopped(); return; }
      signal.addEventListener("abort", stopped, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stopped));
    });
  }
  private setCache(key: string, value: CacheEntry): void {
    this.cache.delete(key); this.cache.set(key, value);
    const maximum = this.options.cacheEntries ?? 256;
    while (this.cache.size > maximum) this.cache.delete(this.cache.keys().next().value!);
  }
  async assertAllowed(value: string, options: { countRequest?: boolean } = {}): Promise<URL> {
    const url = await this.validateUrl(value);
    const blocked = this.options.blockedDomains ?? [];
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (blocked.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) throw new WebAccessError("site_policy");
    const cooldown = this.cooldown.get(url.origin) ?? 0;
    if (cooldown > this.now()) throw new WebAccessError("rate_limit", { httpStatus: 429, retryAfterMs: cooldown - this.now() });
    const session = this.session;
    session.check();
    let rule = this.robots.get(url.origin);
    if (!rule || rule.expires <= this.now()) {
      let flight = this.robotsFlights.get(url.origin);
      if (!flight) {
        flight = this.loadRobots(url.origin).finally(() => this.robotsFlights.delete(url.origin));
        this.robotsFlights.set(url.origin, flight);
      }
      await this.wait(flight);
      rule = this.robots.get(url.origin);
    }
    if (!rule || rule.denied || rule.unavailable) throw new WebAccessError(rule?.denied ? "robots_denied" : "robots_unavailable");
    if (rule.value && rule.value.isAllowed(url.toString(), "QQResearchBot") === false) throw new WebAccessError("robots_denied");
    if (options.countRequest === false) return url;
    // Per-host starts are serialized with a minimum delay. In-flight page reads
    // are additionally limited by the reader and the isolated browser gateway.
    let host = this.hosts.get(url.origin);
    if (!host) { host = { next: 0, chain: Promise.resolve() }; this.hosts.set(url.origin, host); }
    const prior = host.chain;
    let release!: () => void;
    host.chain = new Promise<void>(resolve => { release = resolve; });
    try {
      await this.wait(prior);
      const delay = Math.max(0, host.next - this.now());
      if (delay > session.remainingMs()) throw new WebAccessError("budget");
      if (delay > 0) await this.wait(new Promise<void>(resolve => { setTimeout(resolve, delay); }));
      const robotDelay = (rule.value?.getCrawlDelay("QQResearchBot") ?? 0) * 1000;
      host.next = this.now() + Math.max(this.options.perHostDelayMs ?? 1000, robotDelay);
      session.reserve("httpRequests");
      return url;
    } finally { release(); }
  }
  async acquireHost(value: string): Promise<() => void> {
    const origin = new URL(value).origin;
    const prior = this.hostLeases.get(origin) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.hostLeases.set(origin, current);
    try { await this.wait(prior); }
    catch (error) { void prior.finally(release); throw error; }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (this.hostLeases.get(origin) === current) this.hostLeases.delete(origin);
    };
  }
  private async loadRobots(origin: string): Promise<void> {
    try {
      const result = await this.http(`${origin}/robots.txt`, { timeoutMs: Math.min(5000, this.session.remainingMs()), maxBytes: 128000,
        signal: this.signal(5000), onRequest: () => this.session.reserve("httpRequests") });
      if (result.status === 429) {
        const after = parseRetryAfter(result.headers.get("retry-after"), this.now());
        this.markCooldown(origin, after);
        throw new WebAccessError("rate_limit", { httpStatus: 429, retryAfterMs: after });
      }
      if ([401, 403].includes(result.status)) { this.robots.set(origin, { expires: this.now() + 300000, denied: true }); return; }
      if ([404, 410].includes(result.status)) { this.robots.set(origin, { expires: this.now() + (this.options.robotsTtlMs ?? 3600000) }); return; }
      const rules = result.body.replace(/^\uFEFF/, "");
      const nonComments = rules.replace(/^\s*#.*$/gm, "").trim();
      if (result.status >= 400 || result.truncated || /html|json|javascript/i.test(result.contentType) || /<html|<!doctype/i.test(rules)
        || nonComments && !/^\s*(?:user-agent|sitemap|allow|disallow|crawl-delay)\s*:/im.test(nonComments)) throw new WebAccessError("robots_unavailable");
      this.robots.set(origin, { expires: this.now() + (this.options.robotsTtlMs ?? 3600000), value: robotsParser(`${origin}/robots.txt`, result.body) });
      if (this.robots.size > 256) this.robots.delete(this.robots.keys().next().value!);
    } catch (error) {
      if (error instanceof WebAccessError && ["rate_limit", "budget"].includes(error.reason)) throw error;
      this.robots.set(origin, { expires: this.now() + 60000, unavailable: true });
      throw new WebAccessError("robots_unavailable");
    }
  }
  noteFailure(error: WebAccessError, provider?: ResearchProvider): void { this.lastFailure = { reason: error.reason, at: new Date(this.now()).toISOString(), ...(provider ? { provider } : {}) }; }
  markCooldown(value: string, retryAfterMs?: number): void {
    try {
      const origin = new URL(value).origin;
      const now = this.now();
      const delay = normalizeRetryAfterMs(retryAfterMs);
      const until = !Number.isFinite(now) || now < 0 || now >= MAX_COOLDOWN_TIMESTAMP || delay >= MAX_COOLDOWN_TIMESTAMP - now
        ? MAX_COOLDOWN_TIMESTAMP : Math.ceil(now + delay);
      // A later short response must never shorten an already-active long cooldown.
      this.cooldown.set(origin, Math.max(this.cooldown.get(origin) ?? 0, until));
    } catch { /* An invalid target cannot create a usable public-origin cooldown. */ }
  }
  contentIdentity(text: string, url: string): { contentHash: string; duplicateOf?: string } {
    const contentHash = hash(text.normalize("NFKC").replace(/\s+/g, " ").trim());
    const previous = this.session.contents.get(contentHash);
    if (!previous) this.session.contents.set(contentHash, url);
    return { contentHash, ...(previous && previous !== url ? { duplicateOf: previous } : {}) };
  }
  receipt(): Record<string, unknown> {
    const session = this.context.getStore();
    if (!session) return { mode: "free_only", cache: "memory_only" };
    return { mode: "free_only", used: { ...session.used }, limits: { ...this.limits }, cacheHits: session.cacheHits,
      remainingMs: session.timeLeft(), ...(this.lastFailure ? { lastFailure: this.lastFailure.reason } : {}) };
  }
  status(): { storageReady: boolean; lastFailure?: { reason: WebFailureReason; at: string; provider?: ResearchProvider }; quotas: Record<string, { dailyUsed: number; monthlyUsed: number; dailyLimit: number; monthlyLimit: number }> } {
    const date = new Date(this.now()).toISOString();
    const quotas: ReturnType<ResearchRuntime["status"]>["quotas"] = {};
    for (const [provider, defaults] of Object.entries(DEFAULT_QUOTAS)) {
      const limits = this.options.quotas?.[provider] ?? defaults;
      quotas[provider] = { dailyUsed: this.quotaState.periods[`day:${date.slice(0, 10)}`]?.[provider] ?? 0,
        monthlyUsed: this.quotaState.periods[`month:${date.slice(0, 7)}`]?.[provider] ?? 0, dailyLimit: limits.daily, monthlyLimit: limits.monthly };
    }
    return { storageReady: !this.storageFailed, ...(this.lastFailure ? { lastFailure: { ...this.lastFailure } } : {}), quotas };
  }
  clearCache(): void { this.cache.clear(); this.robots.clear(); this.flights.clear(); }
}
