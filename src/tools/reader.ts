import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import * as cheerio from "cheerio";
import { WebAccessError, ResearchRuntime, canonicalUrl, type WebFailureReason } from "./research.js";
import { assertPublicUrl, fetchPublic, parseRetryAfter, normalizeRetryAfterMs } from "./web-http.js";
import { logger } from "../util/logger.js";

export { assertPublicUrl, isPrivateAddress } from "./web-http.js";

const log = logger("reader");

export interface PageQuality {
  score: number;
  usable: boolean;
  reason: "article" | "short_answer" | "empty" | "shell" | "low_content" | "blocked";
}

export interface ReaderAttempt {
  provider: string;
  action: "fetch" | "extract" | "render";
  outcome: "ok" | "failed" | "skipped";
  reason?: string;
  httpStatus?: number;
}

export interface PageContent {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  status: "ok" | "failed";
  error?: string;
  fetchedAt: string;
  contentType?: string;
  provider?: string;
  extractor?: string;
  cacheHit?: boolean;
  quality?: PageQuality;
  contentHash?: string;
  duplicateOf?: string;
  remoteCacheOnly?: boolean;
  /** Source crawl time is unknown for a remote cached copy; fetchedAt is local read time. */
  sourceFetchedAt?: string | null;
  reason?: string;
  attempts?: ReaderAttempt[];
}

export interface ReaderOptions {
  timeoutMs: number;
  maxBytes: number;
  maxChars: number;
  runtime?: ResearchRuntime;
  crawl4aiUrl?: string;
  extractorUrl?: string;
  firecrawlApiKey?: string;
  tavilyApiKey?: string;
  cacheTtlMs?: number;
  /** Injectable transports keep fixture tests away from external services. */
  transport?: typeof fetchPublic;
  serviceFetch?: typeof fetch;
}

interface Extraction {
  title: string;
  text: string;
  extractor: string;
  quality: PageQuality;
}

interface ServicePage {
  title?: string;
  text?: string;
  markdown?: string;
  finalUrl?: string;
  final_url?: string;
  extractor?: string;
  reason?: string;
  status?: string;
  httpStatus?: number;
  statusCode?: number;
  retryAfterMs?: number;
}

class ReaderFailure extends WebAccessError {
  readonly detail: string;
  constructor(detail: string, httpStatus?: number, fallbackAllowed = false, retryAfterMs?: number) {
    super(sharedReason(detail), { httpStatus, fallbackAllowed, retryAfterMs });
    this.detail = detail;
    this.name = "ReaderFailure";
  }
}

function sharedReason(detail: string): WebFailureReason {
  const aliases: Record<string, WebFailureReason> = {
    empty: "low_quality", shell: "low_quality", low_content: "low_quality",
    login_required: "restricted", paywall: "restricted", challenge: "restricted", forbidden: "restricted", unauthorized: "restricted",
    rate_limited: "rate_limit", network_error: "network", service_error: "upstream_error",
    unsupported_content: "unsupported", invalid_service_response: "invalid_response",
    url_blocked: "invalid_url", dns_blocked: "invalid_url", private_address: "invalid_url",
    cross_origin_blocked: "site_policy", redirect_blocked: "site_policy", blocked_domain: "site_policy", site_restricted: "restricted",
    remote_cache_miss: "low_quality",
    dom_limit: "unsupported",
  };
  if (aliases[detail]) return aliases[detail];
  if (/^http_\d{3}$/.test(detail)) return "http_error";
  const known = ["invalid_url", "robots_denied", "robots_unavailable", "site_policy", "restricted", "rate_limit", "http_error", "timeout", "network", "too_large", "unsupported", "budget", "quota", "low_quality", "invalid_response", "upstream_error", "authentication", "storage"];
  return known.includes(detail) ? detail as WebFailureReason : "network";
}

const REASONS: Record<string, string> = {
  empty: "未能提取正文",
  shell: "页面只返回动态加载外壳",
  low_content: "页面正文不足且缺少有效内容结构",
  login_required: "页面需要登录，已停止读取",
  paywall: "页面需要订阅或付费，已停止读取",
  challenge: "页面要求验证码或访问验证，已停止读取",
  forbidden: "站点拒绝访问，已停止读取",
  unauthorized: "站点需要授权，已停止读取",
  rate_limited: "站点限制请求频率，已停止读取",
  robots_denied: "站点 robots 规则禁止读取",
  timeout: "网页读取超过本次时间预算",
  network_error: "网页连接失败",
  service_error: "正文提取服务暂不可用",
  unsupported_content: "该内容类型暂不支持网页正文提取",
  invalid_service_response: "正文提取服务返回的数据无效",
  remote_cache_miss: "云端只读缓存没有可用副本，已停止，未新抓取源站",
  dom_limit: "网页结构超过安全解析上限，已停止读取",
};

function compact(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\t\u00a0 ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_HTML_ELEMENTS = 20_000;
const MAX_HTML_DEPTH = 128;

/** Network caps alone do not prevent a tiny but deeply nested document from blocking the event loop. */
function parseHtml(html: string): cheerio.CheerioAPI {
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) throw new ReaderFailure("dom_limit");
  let tags = 0;
  for (const _match of html.matchAll(/<[a-z][\w:-]*(?:\s|>|\/)/gi)) {
    if (++tags > MAX_HTML_ELEMENTS) throw new ReaderFailure("dom_limit");
  }
  const $ = cheerio.load(html);
  type BudgetNode = { readonly type: unknown; readonly children?: readonly BudgetNode[] };
  const pending: Array<{ node: BudgetNode; depth: number }> = $.root().toArray().map(node => ({ node, depth: 0 }));
  let visited = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++visited > MAX_HTML_ELEMENTS * 3 || depth > MAX_HTML_DEPTH) throw new ReaderFailure("dom_limit");
    for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
  }
  return $;
}

/** Match directive tokens, not ordinary words such as "noarchiveguide" or article prose. */
function restrictedDirectives(value: string): boolean {
  return /(?:^|[\s,;:])(?:noai|noarchive|nosnippet)(?=$|[\s,;])/i.test(value);
}

function protectedPage(html: string, title: string, text: string): string | undefined {
  const $ = parseHtml(html);
  for (const meta of $("meta[name]").toArray()) {
    const name = ($(meta).attr("name") ?? "").trim().toLowerCase();
    if (["robots", "qqresearchbot"].includes(name) && restrictedDirectives($(meta).attr("content") ?? "")) return "site_policy";
  }
  $("script,style,noscript,template,nav,header,footer,[hidden],[aria-hidden='true'],[style*='display:none'],[style*='display: none']").remove();
  const visible = compact($("body").text()) || compact(text);
  const heading = compact($("h1").first().text());
  const gateText = title + "\n" + heading + "\n" + visible.slice(0, 1800);
  const short = text.replace(/\s/g, "").length < 700;
  if ($("[id='paywall'],[class~='paywall'],[data-testid='paywall']").length > 0) return "paywall";
  if (short && (/cf-chl-|challenge-platform|__cf_chl_|<[^>]+(?:id|class)=["'][^"']*(?:g-recaptcha|h-captcha|cf-turnstile)/i.test(html)
    || /(?:verify (?:that )?you are human|checking your browser|security verification|unusual traffic|请完成.{0,12}验证|人机验证|安全验证|访问验证|滑动.{0,8}验证)/i.test(gateText))) {
    return "challenge";
  }
  if (short && (/(?:subscribe to (?:continue|read|unlock)|subscription required|unlock (?:this|the) (?:article|content)|订阅后.{0,6}阅读|付费后.{0,6}阅读|购买后.{0,6}阅读|会员专享.{0,6}内容)/i.test(gateText)
    || $("[id='paywall'],[class~='paywall'],[data-testid='paywall']").length > 0)) {
    return "paywall";
  }
  if (short && (/^(?:sign in|log in|login|登录|登陆|用户登录|账户登录|会员登录)(?:\b|\s|[-—|：:]|$)/i.test(title)
    || /(?:sign in to (?:continue|read|view)|log in to (?:continue|read|view)|登录后.{0,8}(?:查看|阅读|访问)|请先登录|需要登录才能)/i.test(gateText)
    || ($("input[type='password']").length > 0 && text.replace(/\s/g, "").length < 250))) {
    return "login_required";
  }
  if (short && /^(?:access denied|forbidden|403\b|访问被拒绝|拒绝访问)/i.test(title || heading)) return "forbidden";
  return undefined;
}

function qualityOf(text: string, html: string, semantic: boolean): PageQuality {
  const chars = text.replace(/\s/g, "").length;
  if (!chars) return { score: 0, usable: false, reason: "empty" };
  const $ = parseHtml(html);
  $("script,style,noscript,template,nav,header,footer").remove();
  const linkChars = $("a").text().replace(/\s/g, "").length;
  const paragraphCount = $("article p,main p,[role='main'] p,article li,main li,article pre,main pre,dd").length;
  const shell = /(?:enable javascript|javascript (?:is required|must be enabled)|please (?:wait|enable javascript)|正在加载|加载中|请开启\s*javascript)/i.test(text)
    && chars < 320;
  if (shell) return { score: 0.1, usable: false, reason: "shell" };
  // Concise official answers and FAQs can be useful without reaching a word-count threshold.
  if (semantic && chars >= 8 && (paragraphCount > 0 || $("h1,h2,dt").length > 0)) {
    return { score: chars < 180 ? 0.72 : 0.95, usable: true, reason: chars < 180 ? "short_answer" : "article" };
  }
  if (chars >= 100 && linkChars < chars * 0.65) return { score: 0.8, usable: true, reason: "article" };
  if (chars >= 18 && /[。！？.!?：:]/.test(text) && linkChars < chars * 0.35) {
    return { score: 0.62, usable: true, reason: "short_answer" };
  }
  return { score: 0.2, usable: false, reason: "low_content" };
}

function markdownFrom(html: string): string {
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  turndown.remove(["script", "style", "noscript", "template", "form", "button", "iframe"]);
  return compact(turndown.turndown(html));
}

function extractHtml(html: string, maxChars: number, url = "https://reader.invalid/"): Extraction {
  const $ = parseHtml(html);
  const title = compact($("title").first().text() || $("h1").first().text());
  $("script,style,noscript,template,nav,header,footer,form,button,iframe,[hidden],[aria-hidden='true']").remove();
  const semanticNodes = $("article,main,[role='main']").filter((_index, node) => $(node).parents("article,main,[role='main']").length === 0).toArray();
  const candidateNodes = semanticNodes.length ? semanticNodes : $("body").toArray();
  let candidate = "";
  let candidateSize = -1;
  for (const node of candidateNodes) {
    const size = $(node).text().replace(/\s/g, "").length;
    if (size > candidateSize) {
      candidate = $.html(node);
      candidateSize = size;
    }
  }
  let text = markdownFrom(candidate || $.html());
  let extractor = "semantic-dom";
  // No resources/scripts are enabled. Suppress jsdom's default diagnostic forwarding,
  // which could otherwise copy untrusted CSS or URL text into application logs.
  const dom = new JSDOM($.html(), { url, contentType: "text/html", virtualConsole: new VirtualConsole() });
  try {
    for (const node of dom.window.document.querySelectorAll("script,style,noscript,template,nav,header,footer,form,iframe,[hidden],[aria-hidden='true']")) node.remove();
    const article = new Readability(dom.window.document, { charThreshold: 80, maxElemsToParse: MAX_HTML_ELEMENTS }).parse();
    if (article?.content) {
      const readable = markdownFrom(article.content);
      // Readability can discard short reference answers; retain the semantic candidate then.
      if (readable.replace(/\s/g, "").length >= text.replace(/\s/g, "").length * 0.65) {
        text = readable;
        extractor = "readability";
      }
    }
  } catch {
    // The semantic DOM remains a useful fallback for malformed HTML.
  } finally {
    dom.window.close();
  }
  text = text.slice(0, maxChars);
  return { title, text, extractor, quality: qualityOf(text, html, semanticNodes.length > 0) };
}

/** Preserved API, now backed by a DOM parser, Readability and Markdown conversion. */
export function extractReadable(html: string, maxChars: number): { title: string; text: string } {
  const { title, text } = extractHtml(html, maxChars);
  return { title, text };
}

function safeFailure(error: unknown): ReaderFailure {
  if (error instanceof ReaderFailure) return error;
  if (error && typeof error === "object") {
    const value = error as { reason?: unknown; httpStatus?: unknown; fallbackAllowed?: unknown; name?: unknown };
    const known = ["invalid_url", "robots_denied", "robots_unavailable", "site_policy", "restricted", "rate_limit", "http_error", "timeout", "network", "too_large", "unsupported", "budget", "quota", "low_quality", "invalid_response", "upstream_error", "authentication", "storage"];
    const reason = typeof value.reason === "string" && known.includes(value.reason)
      ? value.reason : value.name === "AbortError" || value.name === "TimeoutError" ? "timeout" : "network_error";
    const httpStatus = typeof value.httpStatus === "number" ? value.httpStatus : undefined;
    const allowed = value.fallbackAllowed === true || (value.fallbackAllowed === undefined && reason === "network_error");
    return new ReaderFailure(reason, httpStatus, allowed);
  }
  return new ReaderFailure("network_error", undefined, true);
}

function statusFailure(status: number): ReaderFailure | undefined {
  if (status < 400) return undefined;
  if (status === 401) return new ReaderFailure("unauthorized", status);
  if (status === 403) return new ReaderFailure("forbidden", status);
  if (status === 429) return new ReaderFailure("rate_limited", status);
  return new ReaderFailure("http_" + status, status, status >= 500);
}

export class PageReader {
  private cacheIdentity: string;
  constructor(private opts: ReaderOptions) {
    this.opts = { ...opts, runtime: opts.runtime ?? new ResearchRuntime() };
    this.cacheIdentity = createHash("sha256").update(JSON.stringify({
      version: 3, maxChars: opts.maxChars, maxBytes: opts.maxBytes,
      crawl4aiUrl: opts.crawl4aiUrl, extractorUrl: opts.extractorUrl,
      firecrawlApiKey: opts.firecrawlApiKey, tavilyApiKey: opts.tavilyApiKey,
    })).digest("hex");
  }

  async read(urlStr: string): Promise<PageContent> {
    const runtime = this.opts.runtime;
    const deadline = Date.now() + this.opts.timeoutMs;
    const action = async (): Promise<PageContent> => {
      const attempts: ReaderAttempt[] = [];
      const base: PageContent = {
        url: urlStr, finalUrl: urlStr, title: "", text: "", status: "failed",
        fetchedAt: new Date().toISOString(), cacheHit: false, attempts,
      };
      try {
        const url = runtime ? await runtime.assertAllowed(urlStr, { countRequest: false }) : await assertPublicUrl(urlStr);
        await runtime?.session.visitUrl(url.toString());
        const execute = async (): Promise<PageContent> => {
          try {
            return await this.readUncached(url.toString(), { ...base, finalUrl: url.toString() }, attempts, deadline);
          } catch (error) {
            const failure = safeFailure(error);
            runtime?.noteFailure(failure);
            if (["budget", "quota", "storage"].includes(failure.reason)) throw failure;
            return this.failed(base, failure);
          }
        };
        const ttl = this.opts.cacheTtlMs ?? 30 * 60_000;
        const cached = runtime
          ? await runtime.cached<PageContent>("page", canonicalUrl(url.toString()) + "\0" + this.cacheIdentity, ttl, execute, value => value.status === "ok" ? ttl : Math.min(ttl, 60_000))
          : { value: await execute(), cacheHit: false };
        const result = { ...cached.value, url: urlStr, cacheHit: cached.cacheHit };
        if (result.status === "ok") {
          runtime?.session.reserve("outputChars", result.text.length);
          const identity = runtime
            ? await runtime.contentIdentity(result.text, result.finalUrl)
            : { contentHash: createHash("sha256").update(result.text).digest("hex") };
          Object.assign(result, identity);
        }
        log.info("读取完成 provider=" + (result.provider ?? "none") + " status=" + result.status + " cache=" + (result.cacheHit ? "hit" : "miss") + " chars=" + result.text.length);
        return result;
      } catch (error) {
        const failure = safeFailure(error);
        log.info("读取失败 reason=" + failure.detail);
        return this.failed(base, failure);
      }
    };
    return runtime ? runtime.run(action) : action();
  }

  private async readUncached(url: string, base: PageContent, attempts: ReaderAttempt[], deadline: number): Promise<PageContent> {
    const remaining = (): number => {
      const value = deadline - Date.now();
      if (value <= 0) throw new ReaderFailure("timeout");
      return value;
    };
    let currentFailure = new ReaderFailure("empty", undefined, true);
    let finalUrl = url;
    let contentType = "";
    let body = "";
    let extracted: Extraction | undefined;
    try {
      const response = await (this.opts.transport ?? fetchPublic)(url, {
        timeoutMs: remaining(), maxBytes: this.opts.maxBytes,
        signal: this.opts.runtime?.signal(remaining()),
        beforeRequest: this.opts.runtime ? async (target) => { await this.opts.runtime!.assertAllowed(target); } : undefined,
        requestLease: this.opts.runtime ? target => this.opts.runtime!.acquireHost(target) : undefined,
        headers: {
          "User-Agent": "QQResearchBot/1.0",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.9",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
        },
      });
      const blocked = statusFailure(response.status);
      if (response.status === 429) this.opts.runtime?.markCooldown(response.finalUrl, parseRetryAfter(response.headers.get("retry-after")));
      if (blocked) throw blocked;
      if (restrictedDirectives(response.headers.get("x-robots-tag") ?? "")) throw new ReaderFailure("site_policy");
      body = response.body;
      finalUrl = response.finalUrl;
      contentType = response.contentType;
      if (contentType && !/text\/|application\/xhtml\+xml/i.test(contentType)) throw new ReaderFailure("unsupported_content");
      const isHtml = /html/i.test(contentType) || /<(?:html|body|main|article|div|p|h1)\b/i.test(body);
      extracted = isHtml ? extractHtml(body, this.opts.maxChars, finalUrl) : {
        title: "", text: compact(body).slice(0, this.opts.maxChars), extractor: "plain-text",
        quality: { score: body.trim() ? 0.8 : 0, usable: !!body.trim(), reason: body.trim() ? "article" : "empty" },
      };
      const protection = protectedPage(isHtml ? body : "", extracted.title, extracted.text);
      if (protection) throw new ReaderFailure(protection);
      remaining();
      attempts.push({ provider: "http", action: "fetch", outcome: "ok", httpStatus: response.status });
      if (extracted.quality.usable) {
        return this.success(base, finalUrl, contentType, extracted, "http", attempts, response.truncated ? "content_truncated" : undefined);
      }
      currentFailure = new ReaderFailure(extracted.quality.reason, undefined, true);
    } catch (error) {
      currentFailure = safeFailure(error);
      attempts.push({ provider: "http", action: "fetch", outcome: "failed", reason: currentFailure.detail, httpStatus: currentFailure.httpStatus });
      if (!currentFailure.fallbackAllowed) throw currentFailure;
    }

    // CPU extraction reuses downloaded HTML and never opens a browser.
    const extractorUrl = this.opts.extractorUrl ?? this.opts.crawl4aiUrl;
    if (body && extractorUrl) {
      try {
        const candidate = await this.sidecar(extractorUrl, "extract", finalUrl, remaining(), body);
        const result = await this.serviceExtraction(candidate, finalUrl);
        remaining();
        attempts.push({ provider: "trafilatura", action: "extract", outcome: result.quality.usable ? "ok" : "failed", reason: result.quality.usable ? undefined : result.quality.reason });
        if (result.quality.usable) return this.success(base, candidate.finalUrl ?? candidate.final_url ?? finalUrl, contentType, result, "http", attempts);
      } catch (error) {
        const failure = safeFailure(error);
        attempts.push({ provider: "trafilatura", action: "extract", outcome: "failed", reason: failure.detail });
        if (!failure.fallbackAllowed) throw failure;
      }
    }

    if (this.opts.crawl4aiUrl) {
      try {
        await this.opts.runtime?.assertAllowed(finalUrl, { countRequest: false });
        remaining();
        await this.opts.runtime?.beforeProvider("crawl4ai", "render");
        const allocation = this.opts.runtime
          ? Math.min(12, this.opts.runtime.limits.maxHttpRequests - this.opts.runtime.session.used.httpRequests) : 12;
        if (allocation < 1) throw new ReaderFailure("budget");
        this.opts.runtime?.session.reserve("httpRequests", allocation);
        const candidate = await this.sidecar(this.opts.crawl4aiUrl, "render", finalUrl, remaining(), undefined, allocation);
        const result = await this.serviceExtraction(candidate, finalUrl);
        remaining();
        attempts.push({ provider: "crawl4ai", action: "render", outcome: result.quality.usable ? "ok" : "failed", reason: result.quality.usable ? undefined : result.quality.reason });
        if (result.quality.usable) return this.success(base, candidate.finalUrl ?? candidate.final_url ?? finalUrl, "text/markdown", result, "crawl4ai", attempts);
        currentFailure = new ReaderFailure(result.quality.reason, undefined, true);
      } catch (error) {
        const failure = safeFailure(error);
        attempts.push({ provider: "crawl4ai", action: "render", outcome: "failed", reason: failure.detail });
        if (!failure.fallbackAllowed) throw failure;
        currentFailure = failure;
      }
    }

    if (this.opts.firecrawlApiKey) {
      try {
        await this.opts.runtime?.assertAllowed(finalUrl, { countRequest: false });
        remaining();
        await this.opts.runtime?.beforeProvider("firecrawl", "extract");
        const candidate = await this.firecrawl(finalUrl, remaining());
        const result = await this.serviceExtraction(candidate, finalUrl);
        remaining();
        attempts.push({ provider: "firecrawl", action: "extract", outcome: result.quality.usable ? "ok" : "failed", reason: result.quality.usable ? undefined : result.quality.reason });
        if (result.quality.usable) return this.success(base, candidate.finalUrl ?? candidate.final_url ?? finalUrl, "text/markdown", result, "firecrawl", attempts);
        currentFailure = new ReaderFailure(result.quality.reason);
      } catch (error) {
        currentFailure = safeFailure(error);
        attempts.push({ provider: "firecrawl", action: "extract", outcome: "failed", reason: currentFailure.detail });
      }
    }
    throw currentFailure;
  }

  private success(base: PageContent, finalUrl: string, contentType: string, result: Extraction, provider: string, attempts: ReaderAttempt[], reason?: string): PageContent {
    return {
      ...base, finalUrl, contentType, title: result.title, text: result.text, status: "ok", provider,
      extractor: result.extractor, quality: result.quality, attempts, reason,
      ...(provider === "firecrawl" ? { remoteCacheOnly: true, sourceFetchedAt: null } : {}),
    };
  }

  private failed(base: PageContent, failure: ReaderFailure): PageContent {
    return { ...base, reason: failure.detail, error: REASONS[failure.detail] ?? failure.message };
  }

  private async serviceExtraction(page: ServicePage, originalUrl: string): Promise<Extraction> {
    const finalUrl = typeof page.finalUrl === "string" && page.finalUrl.trim()
      ? page.finalUrl : typeof page.final_url === "string" && page.final_url.trim() ? page.final_url : originalUrl;
    const reason = typeof page.reason === "string"
      && /^(?:robots_denied|robots_unavailable|site_policy|restricted|invalid_url|rate_limit|login_required|paywall|challenge|forbidden|unauthorized|rate_limited|private_address|blocked_domain|url_blocked|dns_blocked|cross_origin_blocked|site_restricted|redirect_blocked)$/.test(page.reason)
      ? page.reason : undefined;
    const status = page.httpStatus ?? page.statusCode ?? 200;
    // A terminal signal is authoritative even if a failed renderer leaves finalUrl empty.
    // Never reinterpret it as a URL/network error and try a different provider.
    if (reason === "rate_limited" || reason === "rate_limit" || status === 429) {
      const retryAfterMs = normalizeRetryAfterMs(page.retryAfterMs);
      this.opts.runtime?.markCooldown(originalUrl, retryAfterMs);
      this.opts.runtime?.markCooldown(finalUrl, retryAfterMs);
      throw new ReaderFailure(reason ?? "rate_limited", 429, false, retryAfterMs);
    }
    if (reason) throw new ReaderFailure(reason);
    const blocked = statusFailure(status);
    if (blocked) throw blocked;
    // Providers may render a page, but may never select a private or disallowed redirect target.
    await assertPublicUrl(finalUrl);
    await this.opts.runtime?.assertAllowed(finalUrl, { countRequest: false });
    page.finalUrl = finalUrl;
    const title = compact(page.title ?? "");
    const text = compact(page.text ?? page.markdown ?? "").slice(0, this.opts.maxChars);
    const protection = protectedPage("", title, text);
    if (protection) throw new ReaderFailure(protection);
    const chars = text.replace(/\s/g, "").length;
    const shell = /(?:enable javascript|javascript (?:is required|must be enabled)|正在加载|加载中)/i.test(text) && chars < 320;
    const quality: PageQuality = {
      score: chars >= 8 && !shell ? 0.8 : 0,
      usable: chars >= 8 && !shell,
      reason: shell ? "shell" : chars >= 8 ? chars < 180 ? "short_answer" : "article" : "empty",
    };
    return { title, text, extractor: page.extractor ?? "markdown", quality };
  }

  private async sidecar(origin: string, action: "extract" | "render", url: string, timeoutMs: number, html?: string, maxRequests = 1): Promise<ServicePage> {
    let endpoint: URL;
    try {
      const base = new URL(origin);
      if (!/^https?:$/.test(base.protocol) || base.username || base.password
        || !["127.0.0.1", "::1"].includes(base.hostname.replace(/^\[|\]$/g, ""))) throw new Error();
      endpoint = new URL("/" + action, base.origin);
    } catch {
      throw new ReaderFailure("service_error", undefined, true);
    }
    const data = await this.serviceJson(endpoint.toString(), {
      url, html, max_chars: this.opts.maxChars, timeout_ms: timeoutMs,
      max_bytes: Math.min(this.opts.maxBytes, 4 * 1024 * 1024), max_requests: maxRequests,
    }, timeoutMs);
    if (!data || typeof data !== "object") throw new ReaderFailure("invalid_service_response", undefined, true);
    return data as ServicePage;
  }

  private async firecrawl(url: string, timeoutMs: number): Promise<ServicePage> {
    let response: unknown;
    try {
      response = await this.serviceJson("https://api.firecrawl.dev/v2/scrape", {
        url, formats: ["markdown"], onlyMainContent: true, proxy: "basic",
        // A positive minAge is Firecrawl's cache-only operation: a miss returns 404,
        // never a fresh scrape outside the local per-hop robots controller.
        minAge: 1, maxAge: 21_600_000, storeInCache: false,
        skipTlsVerification: false, onlyCleanContent: false, parsers: [], timeout: timeoutMs,
      }, timeoutMs, this.opts.firecrawlApiKey);
    } catch (error) {
      const failure = safeFailure(error);
      if (failure.httpStatus === 404) throw new ReaderFailure("remote_cache_miss", 404);
      throw failure;
    }
    const json = response as { success?: boolean; data?: { markdown?: string; metadata?: { title?: string; sourceURL?: string; url?: string; statusCode?: number } } };
    if (json.success === false || !json.data) throw new ReaderFailure("service_error", undefined, true);
    return {
      text: json.data.markdown, title: json.data.metadata?.title,
      finalUrl: json.data.metadata?.sourceURL ?? json.data.metadata?.url ?? url,
      httpStatus: json.data.metadata?.statusCode,
      extractor: "firecrawl-markdown",
    };
  }

  private async serviceJson(url: string, body: unknown, timeoutMs: number, bearer?: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const runtimeSignal = this.opts.runtime?.signal(timeoutMs);
    const signal = runtimeSignal ? AbortSignal.any([controller.signal, runtimeSignal]) : controller.signal;
    try {
      const response = await (this.opts.serviceFetch ?? fetch)(url, {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: "Bearer " + bearer } : {}) },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* Preserve the fixed terminal failure when cancellation itself fails. */ }
        if (response.status === 429) {
          const retryAfterMs = normalizeRetryAfterMs(parseRetryAfter(response.headers.get("retry-after")));
          const target = body && typeof body === "object" && "url" in body && typeof body.url === "string" ? body.url : undefined;
          if (target) this.opts.runtime?.markCooldown(target, retryAfterMs);
          throw new ReaderFailure("rate_limited", 429, false, retryAfterMs);
        }
        if (response.status < 500) throw statusFailure(response.status) ?? new ReaderFailure("service_error", response.status);
        throw new ReaderFailure("service_error", response.status, true);
      }
      if (!response.body) throw new ReaderFailure("invalid_service_response", undefined, true);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > Math.min(this.opts.maxBytes * 2, 1024 * 1024)) {
            await reader.cancel();
            throw new ReaderFailure("invalid_service_response", undefined, true);
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        throw new ReaderFailure("invalid_service_response", undefined, true);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 两三句简介（用于链接预览，不做全文搬运） */
export function summarizePage(p: PageContent, maxLen = 220): string {
  if (p.status !== "ok") return "";
  const first = p.text.replace(/\n+/g, " ").trim();
  return first.length > maxLen ? first.slice(0, maxLen) + "…" : first;
}
