import fs from "node:fs";
import { validateHeaderName, validateHeaderValue } from "node:http";
import path from "node:path";
import YAML from "yaml";
import { parseCron } from "./util/misc.js";
import type { ResearchLimits, ProviderQuota } from "./tools/research.js";

export interface ModelProfile {
  name: string;
  /** 配置的服务商分组，不按模型品牌推断。 */
  serviceName?: string;
  /** 仅供展示；实际请求始终使用 model 的完整 ID。 */
  displayName?: string;
  provider: "openai_compatible" | "mock";
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
}

export interface ModelService {
  name: string;
  provider: "openai_compatible" | "mock";
  baseUrl: string;
  apiKey: string;
  modelsUrl?: string;
  /** 空列表或省略时引入服务商提供的全部对话模型。 */
  models?: string[];
  /** 仅用于找回被界面截断的 ID；必须唯一匹配。 */
  modelPrefixes?: string[];
  temperature?: number;
}

export interface GroupReplyJudgeConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  debounceMs: number;
  minIntervalMs: number;
  cooldownMs: number;
  requestTimeoutMs: number;
  maxTokens: number;
  maxContextMessages: number;
  maxContextChars: number;
  confidenceThreshold: number;
  thinking?: "enabled" | "disabled";
  jsonMode?: boolean;
  fallback?: {
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens: number;
    thinking?: "enabled" | "disabled";
    jsonMode?: boolean;
  };
}

/** 专属唤醒词仅认平台事件中的真实发送者 QQ。 */
export interface OwnerWakeAliases {
  userId: string;
  aliases: string[];
}

export interface AppConfig {
  timezone: string;
  persona: { name: string; prompt: string; file: string };
  database: { path: string };
  gateway: {
    provider: "onebot";
    accountId: string;
    onebot: {
      endpoint: string;
      tokenEnv: string;
      accessToken: string;
      reconnectBaseMs: number;
      reconnectMaxMs: number;
      heartbeatTimeoutFactor: number;
      requestTimeoutMs: number;
      privateFileAction: string;
      groupFileAction?: string;
      historyAction: string;
      backfillMaxPages: number;
      backfillPageLimit: number;
    };
  };
  groups: {
    allowlist: string[];
    replyMode: "mention_or_reply";
    linkPreview: boolean;
    linkPreviewCooldownMinutes: number;
    maxReplyChars: number;
    autoReply?: GroupReplyJudgeConfig;
    conversation?: { enabled: boolean; ownerAliases: string[]; wakeAliases?: string[]; ownerWakeAliases?: OwnerWakeAliases[];
      observerCooldownMs?: number; observerWindowMs?: number;
      observerMaxReplies?: number; repeatWindowMs?: number; ownerMentionRepeatMs?: number };
  };
  model: {
    provider: "openai_compatible" | "mock";
    baseUrl: string;
    apiKey: string;
    model: string;
    fallbackModel: string;
    summaryModel: string;
    temperature: number;
    maxContextChars: number;
    maxOutputChars: number;
    requestTimeoutMs: number;
    profiles: ModelProfile[];
    providers?: ModelService[];
  };
  memory: {
    enabled: boolean;
    rawRetentionDays: number;
    isolateByGroup: boolean;
    topicGapMinutes: number;
    extraction: "llm" | "rules" | "off";
    maxFactsPerTopic: number;
  };
  reports: {
    enabled: boolean;
    schedule: string;
    period: "today_until_run" | "full_day";
    outputDir: string;
    recipientIds: string[];
    maxDeliveryAttempts: number;
    groups: string[];
  };
  tools: {
    enabled: boolean;
    search: {
      provider: "none" | "tavily" | "google_cse" | "searxng" | "exa";
      tavilyApiKey: string;
      exaApiKey?: string;
      searxngUrl?: string;
      fallbackProviders?: string[];
      minResultsBeforeFallback?: number;
      cacheTtlMs?: number;
      googleCse: { apiKey: string; cx: string };
      maxResults: number;
      timeoutMs: number;
    };
    reader: { enabled: boolean; timeoutMs: number; maxBytes: number; maxChars: number;
      crawl4aiUrl?: string; extractorUrl?: string; firecrawlApiKey?: string; cacheTtlMs?: number };
    research?: { limits: ResearchLimits; quotas: Record<string, ProviderQuota>; blockedDomains: string[] };
    browserConcurrency: number;
    privateToolsOwnerOnly: boolean;
    /** 完整工具的所有者；未配置时兼容 admins，显式空列表表示无人可用。 */
    ownerIds?: string[];
    minimax?: { enabled: boolean };
    muninn?: { enabled: boolean };
    feishu?: { enabled: boolean };
    email?: { enabled: boolean };
    mcp: {
      enabled: boolean;
      connectTimeoutMs: number;
      callTimeoutMs: number;
      servers: McpServerConfig[];
      /** 工具名（含服务器前缀）命中任意子串即不注册，用于排除登录态管理等危险工具 */
      denyTools: string[];
    };
  };
  web: { enabled: boolean; host: string; port: number; token: string };
  admins: string[];
  logging: { level: "debug" | "info" | "warn" | "error"; dir: string };
  weather?: {
    enabled: boolean;
    defaultLocation: string;
    latitude?: number;
    longitude?: number;
    timezone: string;
    requestTimeoutMs: number;
    cacheTtlMs: number;
  };
  proactive?: ProactiveConfig;
  documents?: DocumentConfig;
  presence?: PhonePresenceConfig;
  notion?: NotionConfig;
  features?: { tasks: boolean; personalMemory: boolean; groupSearch: boolean; linkDedup: boolean; incomingFiles: boolean };
}

export interface NotionConfig {
  enabled: boolean;
  apiKey: string;
  rootPageId: string;
  requestTimeoutMs: number;
  remindersEnabled: boolean;
}

/** Temporary phone context for the owner, with optional explicitly allowed groups. */
export interface PhonePresenceConfig {
  enabled: boolean;
  allowedGroupIds?: string[];
  /** Preserve the original latest-state source while supporting EventTap's existing event table. */
  source?: "phone_presence_state" | "device_events";
  /** The event table's owner label, separate from the real QQ owner used for access checks. */
  sourceOwner?: string;
  supabaseUrl: string;
  serverKey: string;
  ownerId: string;
  deviceId: string;
  requestTimeoutMs: number;
  cacheTtlMs: number;
  staleRetentionMs: number;
}

export interface DocumentConfig {
  enabled: boolean;
  outputDir: string;
  /** Same document directory as seen by a containerized OneBot provider. */
  providerOutputDir: string;
  maxInputChars: number;
  maxFileBytes: number;
  maxRetainedFiles: number;
  retentionHours: number;
}

export interface ProactiveConfig {
  enabled: boolean;
  recipientId: string;
  groupId?: string;
  randomEnabled: boolean;
  morningEnabled: boolean;
  morningTime: string;
  morningMode?: "clock" | "phone_activity";
  activeStart: string;
  activeEnd: string;
  includeDraw: boolean;
  weatherAlertsEnabled: boolean;
  weatherCheckMinutes: number;
  weatherAlertCooldownMinutes: number;
  coolingThresholdC: number;
  maxMessageChars: number;
}

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  /** Exact upstream tool names; an empty list exposes no tools. */
  allowTools?: string[];
}

function envValue(name: string | undefined): string {
  if (!name) return "";
  return process.env[name] ?? "";
}

function pick(raw: Record<string, unknown>, key: string): unknown {
  return raw[key];
}

function reqString(raw: Record<string, unknown>, key: string, ctx: string): string {
  const v = pick(raw, key);
  if (typeof v !== "string" || v.length === 0) throw new Error(`配置错误: ${ctx}${key} 必须是非空字符串`);
  return v;
}

function optString(raw: Record<string, unknown>, key: string, def = ""): string {
  const v = pick(raw, key);
  return typeof v === "string" ? v : def;
}

function num(raw: Record<string, unknown>, key: string, def: number): number {
  const v = pick(raw, key);
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(raw: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = pick(raw, key);
  return typeof v === "boolean" ? v : def;
}

function strList(raw: Record<string, unknown>, key: string): string[] {
  const v = pick(raw, key);
  if (!Array.isArray(v)) return [];
  return v.map(String).filter((s) => s.length > 0);
}

/** Resolve private HTTP credentials without retaining environment names or exposing values in errors. */
function mcpHttpHeaders(raw: Record<string, unknown>, context: string): Record<string, string> {
  const headers = new Map<string, [string, string]>();
  for (const key of ["headers", "headers_env"] as const) {
    const configured = pick(raw, key);
    if (configured === undefined) continue;
    if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
      throw new Error(`配置错误: ${context}${key} 必须是字符串映射`);
    }
    for (const [name, source] of Object.entries(configured)) {
      if (typeof source !== "string") throw new Error(`配置错误: ${context}${key} 必须是字符串映射`);
      try { validateHeaderName(name); }
      catch { throw new Error(`配置错误: ${context}${key} 包含非法 HTTP 请求头名称`); }
      const value = key === "headers_env" ? envValue(source) : source;
      if (key === "headers_env" && (!source || !value)) {
        throw new Error(`配置错误: ${context}headers_env 引用的环境变量未设置或为空`);
      }
      try { validateHeaderValue(name, value); }
      catch { throw new Error(`配置错误: ${context}${key} 包含非法 HTTP 请求头值`); }
      // Header names are case-insensitive; an environment credential replaces any inline value.
      headers.set(name.toLowerCase(), [name, value]);
    }
  }
  return Object.fromEntries(headers.values());
}

function wakeAliasList(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some(alias => typeof alias !== "string")) {
    throw new Error(`配置错误: ${context} 必须是至多 100 个非空唤醒词的字符串列表`);
  }
  const aliases = value.map(alias => (alias as string).normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "").trim());
  if (aliases.some(alias => [...alias].length < 2 || [...alias].length > 100
    || /[\x00-\x1f]/u.test(alias) || !/[\p{L}\p{N}]/u.test(alias))) {
    throw new Error(`配置错误: ${context} 的每个唤醒词必须为 2 到 100 个字符，包含文字或数字且无控制字符`);
  }
  return [...new Map(aliases.map(alias => [alias.toLocaleLowerCase("en-US"), alias])).values()];
}

function ownerWakeAliasList(value: unknown): OwnerWakeAliases[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("配置错误: groups.conversation.owner_wake_aliases 必须是至多 100 个绑定的列表");
  }
  const seenUsers = new Set<string>();
  return value.map(binding => {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      throw new Error("配置错误: groups.conversation.owner_wake_aliases[] 必须是配置对象");
    }
    const { user_id: userId, aliases: rawAliases } = binding as Record<string, unknown>;
    if (typeof userId !== "string" || !/^\d{5,20}$/u.test(userId) || seenUsers.has(userId)) {
      throw new Error("配置错误: groups.conversation.owner_wake_aliases[].user_id 必须是唯一的 QQ 字符串");
    }
    const aliases = wakeAliasList(rawAliases, "groups.conversation.owner_wake_aliases[].aliases");
    if (!aliases.length) throw new Error("配置错误: groups.conversation.owner_wake_aliases[].aliases 不得为空");
    seenUsers.add(userId);
    return { userId, aliases };
  });
}

export function loadConfig(configPath: string): AppConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `找不到配置文件: ${configPath}\n请复制 config.example.yaml 为 config.yaml 并按需修改。`,
    );
  }
  const raw = YAML.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error("配置文件为空或格式错误");

  const persona = (pick(raw, "persona") ?? {}) as Record<string, unknown>;
  const personaFile = optString(persona, "file", "");
  let personaPrompt = optString(persona, "prompt", "");
  if (personaFile) {
    const p = path.isAbsolute(personaFile) ? personaFile : path.resolve(path.dirname(configPath), personaFile);
    if (!fs.existsSync(p)) throw new Error(`配置错误: persona.file 指向的文件不存在: ${p}`);
    personaPrompt = fs.readFileSync(p, "utf-8");
  }

  const gw = (pick(raw, "gateway") ?? {}) as Record<string, unknown>;
  const ob = (pick(gw, "onebot") ?? {}) as Record<string, unknown>;
  const groups = (pick(raw, "groups") ?? {}) as Record<string, unknown>;
  const autoReply = (pick(groups, "auto_reply") ?? {}) as Record<string, unknown>;
  const conversation = (pick(groups, "conversation") ?? {}) as Record<string, unknown>;
  const autoReplyFallback = (pick(autoReply, "fallback") ?? {}) as Record<string, unknown>;
  const model = (pick(raw, "model") ?? {}) as Record<string, unknown>;
  const memory = (pick(raw, "memory") ?? {}) as Record<string, unknown>;
  const reports = (pick(raw, "reports") ?? {}) as Record<string, unknown>;
  const tools = (pick(raw, "tools") ?? {}) as Record<string, unknown>;
  const minimax = (pick(tools, "minimax") ?? {}) as Record<string, unknown>;
  const muninn = (pick(tools, "muninn") ?? {}) as Record<string, unknown>;
  const feishu = (pick(tools, "feishu") ?? {}) as Record<string, unknown>;
  const email = (pick(tools, "email") ?? {}) as Record<string, unknown>;
  if (pick(tools, "owner_ids") !== undefined && !Array.isArray(pick(tools, "owner_ids"))) {
    throw new Error("配置错误: tools.owner_ids 必须是列表");
  }
  const search = (pick(tools, "search") ?? {}) as Record<string, unknown>;
  const reader = (pick(tools, "reader") ?? {}) as Record<string, unknown>;
  const research = (pick(tools, "research") ?? {}) as Record<string, unknown>;
  const gcse = (pick(search, "google_cse") ?? {}) as Record<string, unknown>;
  const mcp = (pick(tools, "mcp") ?? {}) as Record<string, unknown>;
  const web = (pick(raw, "web") ?? {}) as Record<string, unknown>;
  const logging = (pick(raw, "logging") ?? {}) as Record<string, unknown>;
  const database = (pick(raw, "database") ?? {}) as Record<string, unknown>;
  const weather = (pick(raw, "weather") ?? {}) as Record<string, unknown>;
  const proactive = (pick(raw, "proactive") ?? {}) as Record<string, unknown>;
  const featuresRaw = pick(raw, "features");
  if (featuresRaw !== undefined && (!featuresRaw || typeof featuresRaw !== "object" || Array.isArray(featuresRaw))) throw new Error("配置错误: features 必须为对象");
  const features = (featuresRaw ?? {}) as Record<string, unknown>;
  const presenceRaw = pick(raw, "presence");
  if (presenceRaw !== undefined && (!presenceRaw || typeof presenceRaw !== "object" || Array.isArray(presenceRaw))) {
    throw new Error("配置错误: presence 必须是配置对象");
  }
  const presence = (presenceRaw ?? {}) as Record<string, unknown>;
  const allowedPresenceGroups = presence.allowed_group_ids ?? [];
  if (!Array.isArray(allowedPresenceGroups) || allowedPresenceGroups.length > 100
    || allowedPresenceGroups.some(value => typeof value !== "string" || !/^\d{5,20}$/u.test(value))) {
    throw new Error("配置错误: presence.allowed_group_ids 必须是至多 100 个群号字符串的列表");
  }
  const notionRaw = pick(raw, "notion");
  if (notionRaw !== undefined && (!notionRaw || typeof notionRaw !== "object" || Array.isArray(notionRaw))) {
    throw new Error("配置错误: notion 必须是配置对象");
  }
  const notion = (notionRaw ?? {}) as Record<string, unknown>;
  const notionTimeout = notion.request_timeout_ms ?? 10000;
  if (typeof notionTimeout !== "number" || !Number.isSafeInteger(notionTimeout) || notionTimeout < 100 || notionTimeout > 30000) {
    throw new Error("配置错误: notion.request_timeout_ms 必须是 100 到 30000 的整数");
  }
  const presenceLimit = (key: string, fallback: number, minimum: number, maximum: number): number => {
    const value = presence[key] ?? fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`配置错误: presence.${key} 必须是 ${minimum} 到 ${maximum} 的整数`);
    }
    return value;
  };
  const documentsRaw = pick(raw, "documents");
  if (documentsRaw !== undefined && (!documentsRaw || typeof documentsRaw !== "object" || Array.isArray(documentsRaw))) {
    throw new Error("配置错误: documents 必须是配置对象");
  }
  const documents = (documentsRaw ?? {}) as Record<string, unknown>;
  const documentLimit = (key: string, fallback: number, maximum: number): number => {
    const value = documents[key] ?? fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`配置错误: documents.${key} 必须是 1 到 ${maximum} 的整数`);
    }
    return value;
  };

  const provider = optString(gw, "provider", "onebot");
  if (provider !== "onebot") throw new Error(`配置错误: gateway.provider 暂只支持 onebot（收到 ${provider}）`);
  const modelProvider = optString(model, "provider", "openai_compatible");
  if (modelProvider !== "openai_compatible" && modelProvider !== "mock") {
    throw new Error(`配置错误: model.provider 只支持 openai_compatible 或 mock（收到 ${modelProvider}）`);
  }

  // 可切换的模型档位（管理员私聊"换模型"用）；name 必填，其余缺省继承顶层 model
  const resolvedProfiles: ModelProfile[] = [];
  if (Array.isArray(pick(model, "profiles"))) {
    for (const p of pick(model, "profiles") as Record<string, unknown>[]) {
      const name = optString(p, "name", "");
      if (!name) throw new Error("配置错误: model.profiles[].name 必填");
      const prov = optString(p, "provider", modelProvider) === "mock" ? "mock" : "openai_compatible";
      const baseUrl = optString(p, "base_url", optString(model, "base_url", "https://api.openai.com/v1")).replace(/\/+$/, "");
      const keyEnv = optString(p, "api_key_env");
      const apiKey = optString(p, "api_key") || (keyEnv
        ? envValue(keyEnv)
        : (optString(model, "api_key") || envValue(optString(model, "api_key_env") || undefined)));
      const mdl = optString(p, "model", optString(model, "model", ""));
      const temperature = pick(p, "temperature");
      resolvedProfiles.push({
        name,
        serviceName: optString(p, "service_name") || undefined,
        displayName: optString(p, "display_name") || undefined,
        provider: prov,
        baseUrl,
        apiKey,
        model: mdl,
        temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : undefined,
      });
    }
    const names = new Set<string>();
    for (const p of resolvedProfiles) {
      if (names.has(p.name)) throw new Error(`配置错误: model.profiles 里模型名重复: ${p.name}`);
      names.add(p.name);
    }
  }

  const resolvedServices: ModelService[] = [];
  if (Array.isArray(pick(model, "providers"))) {
    const names = new Set<string>();
    for (const service of pick(model, "providers") as Record<string, unknown>[]) {
      if (!service || typeof service !== "object") throw new Error("配置错误: model.providers[] 必须是对象");
      const name = reqString(service, "name", "model.providers[].");
      if (names.has(name)) throw new Error(`配置错误: model.providers 里服务商名重复: ${name}`);
      names.add(name);
      const prov = optString(service, "provider", "openai_compatible");
      if (prov !== "openai_compatible" && prov !== "mock") {
        throw new Error(`配置错误: model.providers[${name}].provider 只支持 openai_compatible 或 mock`);
      }
      const baseUrl = reqString(service, "base_url", `model.providers[${name}].`).replace(/\/+$/, "");
      const temperature = pick(service, "temperature");
      for (const key of ["models", "model_prefixes"] as const) {
        const values = pick(service, key);
        if (values !== undefined && (!Array.isArray(values) || values.some((v) => typeof v !== "string" || !v.trim()))) {
          throw new Error(`配置错误: model.providers[${name}].${key} 必须是非空字符串列表`);
        }
      }
      resolvedServices.push({
        name,
        provider: prov,
        baseUrl,
        apiKey: optString(service, "api_key") || envValue(optString(service, "api_key_env") || undefined),
        modelsUrl: optString(service, "models_url") || undefined,
        models: strList(service, "models"),
        modelPrefixes: strList(service, "model_prefixes"),
        temperature: temperature !== undefined && Number.isFinite(Number(temperature)) ? Number(temperature) : undefined,
      });
    }
  }

  const resolvedModel: AppConfig["model"] = {
    provider: modelProvider,
    baseUrl: optString(model, "base_url", "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: optString(model, "api_key") || envValue(optString(model, "api_key_env") || undefined),
    model: optString(model, "model", ""),
    fallbackModel: optString(model, "fallback_model", ""),
    summaryModel: optString(model, "summary_model", ""),
    temperature: num(model, "temperature", 0.7),
    maxContextChars: num(model, "max_context_chars", 6000),
    maxOutputChars: num(model, "max_output_chars", 2000),
    requestTimeoutMs: num(model, "request_timeout_ms", 60_000),
    profiles: resolvedProfiles,
    providers: resolvedServices,
  };
  if (modelProvider === "openai_compatible" && (!resolvedModel.baseUrl || !resolvedModel.model)) {
    throw new Error("配置错误: model.base_url 与 model.model 在 provider=openai_compatible 时必填");
  }

  const searchProvider = optString(search, "provider", "none");
  if (!["none", "tavily", "google_cse", "searxng", "exa"].includes(searchProvider)) {
    throw new Error(`配置错误: tools.search.provider 不支持 ${searchProvider}`);
  }
  function webNumber(object: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number, context: string, integer = true): number {
    const value = object[key] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || integer && !Number.isSafeInteger(value)) {
      throw new Error(`配置错误: ${context}.${key} 必须是 ${minimum} 到 ${maximum} 的${integer ? "整数" : "数字"}`);
    }
    return value;
  }
  function localWebService(object: Record<string, unknown>, key: string, context: string): string {
    const value = optString(object, key, "");
    if (!value) return "";
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password
        || url.pathname !== "/" || url.search || url.hash) throw new Error();
      return url.origin;
    } catch { throw new Error(`配置错误: ${context}.${key} 必须是仅监听本机的服务根地址`); }
  }
  const fallbackProviders = strList(search, "fallback_providers");
  if (fallbackProviders.some(value => !["searxng", "tavily", "exa", "google_cse"].includes(value))) throw new Error("配置错误: tools.search.fallback_providers 含不支持的后端");
  if (research.free_only !== undefined && research.free_only !== true) throw new Error("配置错误: tools.research.free_only 必须保持 true");
  const budget = (research.budget ?? {}) as Record<string, unknown>;
  const quotaSettings = (research.quotas ?? {}) as Record<string, unknown>;
  const webLimits: ResearchLimits = {
    maxQueries: webNumber(budget, "max_queries", 3, 1, 10, "tools.research.budget"),
    maxSearchRequests: webNumber(budget, "max_search_requests", 3, 1, 12, "tools.research.budget"),
    maxPages: webNumber(budget, "max_pages", 6, 1, 20, "tools.research.budget"),
    maxBrowserRenders: webNumber(budget, "max_browser_renders", 2, 0, 4, "tools.research.budget"),
    maxCloudExtractions: webNumber(budget, "max_cloud_extractions", 2, 0, 4, "tools.research.budget"),
    maxHttpRequests: webNumber(budget, "max_http_requests", 24, 1, 60, "tools.research.budget"),
    maxOutputChars: webNumber(budget, "max_output_chars", 48000, 1000, 120000, "tools.research.budget"),
    totalTimeoutMs: webNumber(budget, "total_timeout_ms", 45000, 5000, 90000, "tools.research.budget"),
  };
  const webQuotas: Record<string, ProviderQuota> = {};
  for (const [provider, daily, monthly, maximum] of [["tavily", 20, 600, 1000], ["firecrawl", 30, 800, 1000], ["exa", 0.15, 4, 10], ["google_cse", 30, 500, 1000]] as const) {
    const entry = (quotaSettings[provider] ?? {}) as Record<string, unknown>;
    webQuotas[provider] = { daily: webNumber(entry, "daily", daily, 0, provider === "google_cse" ? 100 : maximum, `tools.research.quotas.${provider}`, provider !== "exa"),
      monthly: webNumber(entry, "monthly", monthly, 0, maximum, `tools.research.quotas.${provider}`, provider !== "exa") };
  }
  const blockedDomains = strList(research, "blocked_domains").map(value => value.toLowerCase().replace(/\.$/, ""));
  if (blockedDomains.some(value => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value))) throw new Error("配置错误: tools.research.blocked_domains 必须为域名列表");

  const mcpServers: McpServerConfig[] = [];
  if (Array.isArray(pick(mcp, "servers"))) {
    for (const s of pick(mcp, "servers") as Record<string, unknown>[]) {
      const name = reqString(s, "name", "tools.mcp.servers[].");
      const transport = optString(s, "transport", "stdio");
      if (transport === "stdio") {
        mcpServers.push({
          name,
          transport: "stdio",
          command: reqString(s, "command", `tools.mcp.servers[${name}].`),
          args: strList(s, "args"),
          ...(pick(s,"allow_tools") === undefined ? {} : { allowTools: strList(s,"allow_tools") }),
        });
      } else if (transport === "http") {
        const configuredUrl = optString(s, "url") || envValue(optString(s, "url_env") || undefined);
        if (!configuredUrl) throw new Error(`配置错误: tools.mcp.servers[${name}].url 或 url_env 必须配置`);
        mcpServers.push({
          name,
          transport: "http",
          url: configuredUrl,
          headers: mcpHttpHeaders(s, `tools.mcp.servers[${name}].`),
          ...(pick(s,"allow_tools") === undefined ? {} : { allowTools: strList(s,"allow_tools") }),
        });
      } else {
        throw new Error(`配置错误: tools.mcp.servers[${name}].transport 只支持 stdio | http`);
      }
    }
  }

  const reportsCfg: AppConfig["reports"] = {
    enabled: bool(reports, "enabled", false),
    schedule: optString(reports, "schedule", "30 23 * * *"),
    period: optString(reports, "period", "today_until_run") === "full_day" ? "full_day" : "today_until_run",
    outputDir: optString(reports, "output_dir", "data/reports"),
    recipientIds: strList(reports, "recipient_ids"),
    maxDeliveryAttempts: num(reports, "max_delivery_attempts", 5),
    groups: strList(reports, "groups"),
  };

  const cfg: AppConfig = {
    timezone: optString(raw, "timezone", "Asia/Shanghai"),
    persona: { name: optString(persona, "name", ""), prompt: personaPrompt, file: personaFile },
    database: { path: optString(database, "path", "data/bot.db") },
    gateway: {
      provider: "onebot",
      accountId: optString(gw, "account_id", "default"),
      onebot: {
        endpoint: reqString(ob, "endpoint", "gateway.onebot."),
        tokenEnv: optString(ob, "token_env", ""),
        accessToken: optString(ob, "access_token") || envValue(optString(ob, "token_env") || undefined),
        reconnectBaseMs: num(ob, "reconnect_base_ms", 1000),
        reconnectMaxMs: num(ob, "reconnect_max_ms", 60_000),
        heartbeatTimeoutFactor: num(ob, "heartbeat_timeout_factor", 2.5),
        requestTimeoutMs: num(ob, "request_timeout_ms", 20_000),
        privateFileAction: optString(ob, "private_file_action", "upload_private_file"),
        groupFileAction: optString(ob, "group_file_action", "upload_group_file"),
        historyAction: optString(ob, "history_action", "get_group_msg_history"),
        backfillMaxPages: num(ob, "backfill_max_pages", 5),
        backfillPageLimit: num(ob, "backfill_page_limit", 100),
      },
    },
    groups: {
      allowlist: strList(groups, "allowlist"),
      replyMode: "mention_or_reply",
      linkPreview: bool(groups, "link_preview", true),
      linkPreviewCooldownMinutes: num(groups, "link_preview_cooldown_minutes", 120),
      maxReplyChars: num(groups, "max_reply_chars", 1200),
      conversation: { enabled: bool(conversation, "enabled", true), ownerAliases: strList(conversation, "owner_aliases"),
        wakeAliases: wakeAliasList(pick(conversation, "wake_aliases"), "groups.conversation.wake_aliases"),
        ownerWakeAliases: ownerWakeAliasList(pick(conversation, "owner_wake_aliases")),
        observerCooldownMs: num(conversation, "observer_cooldown_ms", 30000), observerWindowMs: num(conversation, "observer_window_ms", 600000),
        observerMaxReplies: num(conversation, "observer_max_replies", 3), repeatWindowMs: num(conversation, "repeat_window_ms", 900000),
        ownerMentionRepeatMs: num(conversation, "owner_mention_repeat_ms", 45000) },
      autoReply: {
        enabled: bool(autoReply, "enabled", false),
        baseUrl: optString(autoReply, "base_url", "https://open.bigmodel.cn/api/paas/v4").replace(/\/+$/, ""),
        apiKey: optString(autoReply, "api_key") || envValue(optString(autoReply, "api_key_env") || undefined),
        model: optString(autoReply, "model", "glm-4.5-air"),
        debounceMs: num(autoReply, "debounce_ms", 1500),
        minIntervalMs: num(autoReply, "min_interval_ms", 10000),
        cooldownMs: num(autoReply, "cooldown_ms", 60000),
        requestTimeoutMs: num(autoReply, "request_timeout_ms", 6000),
        maxTokens: num(autoReply, "max_tokens", 128),
        maxContextMessages: num(autoReply, "max_context_messages", 12),
        maxContextChars: num(autoReply, "max_context_chars", 2400),
        confidenceThreshold: num(autoReply, "confidence_threshold", 0.9),
        thinking: optString(autoReply, "thinking", "disabled") === "enabled" ? "enabled" : "disabled",
        jsonMode: bool(autoReply, "json_mode", true),
        fallback: pick(autoReply, "fallback") !== undefined && bool(autoReplyFallback, "enabled", true) ? {
          baseUrl: optString(autoReplyFallback, "base_url", "https://open.bigmodel.cn/api/paas/v4").replace(/\/+$/, ""),
          apiKey: optString(autoReplyFallback, "api_key") || envValue(optString(autoReplyFallback, "api_key_env") || undefined),
          model: optString(autoReplyFallback, "model", "glm-4.5-air"),
          maxTokens: num(autoReplyFallback, "max_tokens", 128),
          thinking: optString(autoReplyFallback, "thinking", "disabled") === "enabled" ? "enabled" : "disabled",
          jsonMode: bool(autoReplyFallback, "json_mode", true),
        } : undefined,
      },
    },
    model: resolvedModel,
    memory: {
      enabled: bool(memory, "enabled", true),
      rawRetentionDays: num(memory, "raw_retention_days", 30),
      isolateByGroup: bool(memory, "isolate_by_group", true),
      topicGapMinutes: num(memory, "topic_gap_minutes", 30),
      extraction: (["llm", "rules", "off"].includes(optString(memory, "extraction", "llm"))
        ? optString(memory, "extraction", "llm")
        : "llm") as AppConfig["memory"]["extraction"],
      maxFactsPerTopic: num(memory, "max_facts_per_topic", 6),
    },
    reports: reportsCfg,
    documents: {
      enabled: bool(documents, "enabled", true),
      outputDir: optString(documents, "output_dir", "data/documents"),
      providerOutputDir: optString(documents, "provider_output_dir", ""),
      maxInputChars: documentLimit("max_input_chars", 100000, 200000),
      maxFileBytes: documentLimit("max_file_bytes", 10 * 1024 * 1024, 20 * 1024 * 1024),
      maxRetainedFiles: documentLimit("max_retained_files", 100, 1000),
      retentionHours: documentLimit("retention_hours", 72, 720),
    },
    tools: {
      enabled: bool(tools, "enabled", true),
      search: {
        provider: searchProvider as AppConfig["tools"]["search"]["provider"],
        tavilyApiKey: optString(search, "tavily_api_key") || envValue(optString(search, "tavily_api_key_env") || undefined),
        exaApiKey: optString(search, "exa_api_key") || envValue(optString(search, "exa_api_key_env") || undefined),
        searxngUrl: localWebService(search, "searxng_url", "tools.search"),
        fallbackProviders,
        minResultsBeforeFallback: webNumber(search, "min_results_before_fallback", 2, 0, 10, "tools.search"),
        cacheTtlMs: webNumber(search, "cache_ttl_ms", 900000, 0, 3600000, "tools.search"),
        googleCse: {
          apiKey: optString(gcse, "api_key") || envValue(optString(gcse, "api_key_env") || undefined),
          cx: optString(gcse, "cx", ""),
        },
        maxResults: webNumber(search, "max_results", 5, 1, 10, "tools.search"),
        timeoutMs: webNumber(search, "timeout_ms", 15_000, 1000, 30000, "tools.search"),
      },
      reader: {
        enabled: bool(reader, "enabled", true),
        timeoutMs: num(reader, "timeout_ms", 15_000),
        maxBytes: num(reader, "max_bytes", 2_000_000),
        maxChars: num(reader, "max_chars", 8000),
        crawl4aiUrl: localWebService(reader, "crawl4ai_url", "tools.reader"),
        extractorUrl: localWebService(reader, "extractor_url", "tools.reader"),
        firecrawlApiKey: optString(reader, "firecrawl_api_key") || envValue(optString(reader, "firecrawl_api_key_env") || undefined),
        cacheTtlMs: webNumber(reader, "cache_ttl_ms", 21600000, 0, 86400000, "tools.reader"),
      },
      research: { limits: webLimits, quotas: webQuotas, blockedDomains },
      browserConcurrency: num(tools, "browser_concurrency", 1),
      privateToolsOwnerOnly: bool(tools, "private_tools_owner_only", true),
      ownerIds: pick(tools, "owner_ids") === undefined ? undefined : strList(tools, "owner_ids"),
      minimax: { enabled: bool(minimax, "enabled", false) },
      muninn: { enabled: bool(muninn, "enabled", false) },
      feishu: { enabled: bool(feishu, "enabled", false) },
      email: { enabled: bool(email, "enabled", false) },
      mcp: {
        enabled: bool(mcp, "enabled", false),
        connectTimeoutMs: num(mcp, "connect_timeout_ms", 15_000),
        callTimeoutMs: num(mcp, "call_timeout_ms", 120_000),
        servers: mcpServers,
        denyTools: strList(mcp, "deny_tools"),
      },
    },
    web: {
      enabled: bool(web, "enabled", true),
      host: optString(web, "host", "127.0.0.1"),
      port: num(web, "port", 8642),
      token: optString(web, "token", ""),
    },
    admins: strList(raw, "admins"),
    logging: {
      level: (["debug", "info", "warn", "error"].includes(optString(logging, "level", "info"))
        ? optString(logging, "level", "info")
        : "info") as AppConfig["logging"]["level"],
      dir: optString(logging, "dir", "data/logs"),
    },
    weather: {
      enabled: bool(weather, "enabled", false),
      defaultLocation: optString(weather, "default_location", ""),
      latitude: pick(weather, "latitude") === undefined ? undefined : num(weather, "latitude", NaN),
      longitude: pick(weather, "longitude") === undefined ? undefined : num(weather, "longitude", NaN),
      timezone: optString(weather, "timezone", optString(raw, "timezone", "Asia/Shanghai")),
      requestTimeoutMs: num(weather, "request_timeout_ms", 15000),
      cacheTtlMs: num(weather, "cache_ttl_ms", 600000),
    },
    proactive: {
      enabled: bool(proactive, "enabled", false),
      recipientId: optString(proactive, "recipient_id", ""),
      groupId: optString(proactive, "group_id", "") || undefined,
      randomEnabled: bool(proactive, "random_enabled", true),
      morningEnabled: bool(proactive, "morning_enabled", true),
      morningTime: optString(proactive, "morning_time", "07:00"),
      morningMode: optString(proactive, "morning_mode", "clock") === "phone_activity" ? "phone_activity" : "clock",
      activeStart: optString(proactive, "active_start", "08:00"),
      activeEnd: optString(proactive, "active_end", "23:00"),
      includeDraw: bool(proactive, "include_draw", false),
      weatherAlertsEnabled: bool(proactive, "weather_alerts_enabled", true),
      weatherCheckMinutes: num(proactive, "weather_check_minutes", 15),
      weatherAlertCooldownMinutes: num(proactive, "weather_alert_cooldown_minutes", 120),
      coolingThresholdC: num(proactive, "cooling_threshold_c", 5),
      maxMessageChars: num(proactive, "max_message_chars", 800),
    },
    presence: {
      enabled: bool(presence, "enabled", false),
      allowedGroupIds: [...new Set(allowedPresenceGroups as string[])],
      source: optString(presence, "source", "phone_presence_state") as "phone_presence_state" | "device_events",
      sourceOwner: optString(presence, "source_owner", ""),
      supabaseUrl: (optString(presence, "supabase_url") || envValue(optString(presence, "supabase_url_env", "SUPABASE_URL"))).replace(/\/+$/, ""),
      serverKey: optString(presence, "server_key") || envValue(optString(presence, "server_key_env", "SUPABASE_SERVER_KEY")),
      ownerId: optString(presence, "owner_id", ""),
      deviceId: optString(presence, "device_id", ""),
      requestTimeoutMs: presenceLimit("request_timeout_ms", 1500, 100, 10000),
      cacheTtlMs: presenceLimit("cache_ttl_ms", 30000, 1000, 300000),
      staleRetentionMs: presenceLimit("stale_retention_ms", 86400000, 300000, 604800000),
    },
    features: {
      tasks: bool(features, "tasks", true),
      personalMemory: bool(features, "personal_memory", true),
      groupSearch: bool(features, "group_search", true),
      linkDedup: bool(features, "link_dedup", true),
      incomingFiles: bool(features, "incoming_files", true),
    },
    notion: {
      enabled: bool(notion, "enabled", false),
      apiKey: optString(notion, "api_key") || envValue(optString(notion, "api_key_env", "NOTION_API_KEY")),
      rootPageId: optString(notion, "root_page_id", "").trim(),
      requestTimeoutMs: notionTimeout,
      remindersEnabled: bool(notion, "reminders_enabled", true),
    },
  };

  if (cfg.presence?.allowedGroupIds?.some(groupId => !cfg.groups.allowlist.includes(groupId))) {
    throw new Error("配置错误: presence.allowed_group_ids 必须是 groups.allowlist 中已授权的群");
  }
  if (cfg.notion?.enabled) {
    if (!cfg.notion.apiKey || /[\r\n\x00]/u.test(cfg.notion.apiKey)) {
      throw new Error("配置错误: notion.api_key_env 必须提供有效的私有集成令牌");
    }
    if (!/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/iu.test(cfg.notion.rootPageId)) {
      throw new Error("配置错误: notion.root_page_id 必须是专用记事本的页面 ID");
    }
  }
  if (cfg.presence?.enabled) {
    const p = cfg.presence;
    if (p.source !== "phone_presence_state" && p.source !== "device_events") {
      throw new Error("配置错误: presence.source 必须为 phone_presence_state 或 device_events");
    }
    if (p.source === "device_events" && !/^[A-Za-z0-9_-]{1,64}$/u.test(p.sourceOwner ?? "")) {
      throw new Error("配置错误: presence.source_owner 必须是 EventTap 的 owner 标识");
    }
    let url: URL;
    try { url = new URL(p.supabaseUrl); } catch { throw new Error("配置错误: presence.supabase_url 必须是有效的 HTTPS 项目地址"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("配置错误: presence.supabase_url 必须是无账号、路径或查询参数的 HTTPS 项目地址");
    }
    if (!p.serverKey || /^sb_publishable_/u.test(p.serverKey)) {
      throw new Error("配置错误: presence.server_key 必须是仅服务器持有的 Supabase secret 或 legacy service_role key");
    }
    // A phone's legacy anon JWT grants upload capability, not a private reader identity.
    const jwtParts = p.serverKey.split(".");
    if (jwtParts.length === 3) {
      try {
        const claims: unknown = JSON.parse(Buffer.from(jwtParts[1]!, "base64url").toString("utf8"));
        if (claims && typeof claims === "object" && ["anon", "authenticated"].includes(String((claims as Record<string, unknown>).role))) {
          throw new Error("public Supabase key");
        }
      } catch {
        throw new Error("配置错误: presence.server_key 不能使用手机的 anon key 或用户登录令牌");
      }
    }
    if (!/^\d{5,20}$/u.test(p.ownerId) || !(cfg.tools.ownerIds ?? cfg.admins).includes(p.ownerId)) {
      throw new Error("配置错误: presence.owner_id 必须是完整工具所有者的真实 QQ");
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(p.deviceId)) {
      throw new Error("配置错误: presence.device_id 必须为 1 到 64 位字母、数字、下划线或连字符");
    }
  }
  if (cfg.documents && (!cfg.documents.outputDir.trim() || /[\x00-\x1f]/.test(cfg.documents.outputDir)
    || /[\x00-\x1f]/.test(cfg.documents.providerOutputDir))) {
    throw new Error("配置错误: documents 文件目录不能为空或包含控制字符");
  }
  if (cfg.groups.conversation) {
    const c = cfg.groups.conversation;
    for (const value of [c.observerCooldownMs, c.observerWindowMs, c.repeatWindowMs, c.ownerMentionRepeatMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 86400000)) {
        throw new Error("配置错误: groups.conversation 的时间限制必须为 0 到 86400000 毫秒的整数");
      }
    }
    if (c.observerMaxReplies !== undefined && (!Number.isSafeInteger(c.observerMaxReplies) || c.observerMaxReplies < 1 || c.observerMaxReplies > 100)) {
      throw new Error("配置错误: groups.conversation.observer_max_replies 必须为 1 到 100 的整数");
    }
  }
  if (cfg.weather?.enabled) {
    const w = cfg.weather;
    const hasCoordinates = w.latitude !== undefined || w.longitude !== undefined;
    if (hasCoordinates && (!Number.isFinite(w.latitude) || !Number.isFinite(w.longitude)
      || w.latitude! < -90 || w.latitude! > 90 || w.longitude! < -180 || w.longitude! > 180)) {
      throw new Error("配置错误: weather.latitude/longitude 必须同时提供有效经纬度");
    }
    if (!hasCoordinates && !w.defaultLocation.trim()) throw new Error("配置错误: weather.default_location 必须配置");
  }
  if (cfg.proactive?.enabled) {
    const p = cfg.proactive;
    if (!/^\d{5,20}$/.test(p.recipientId) || !(cfg.tools.ownerIds ?? cfg.admins).includes(p.recipientId)) {
      throw new Error("配置错误: proactive.recipient_id 必须是完整工具所有者的 QQ");
    }
    if (p.groupId && !cfg.groups.allowlist.includes(p.groupId)) throw new Error("配置错误: proactive.group_id 必须在群白名单中");
    for (const value of [p.morningTime, p.activeStart, p.activeEnd]) {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("配置错误: 主动消息时间必须使用 HH:mm 格式");
    }
    if ((p.morningEnabled || p.weatherAlertsEnabled) && !cfg.weather?.enabled) throw new Error("配置错误: 主动天气播报需要启用 weather");
    if (p.weatherCheckMinutes < 5 || p.weatherAlertCooldownMinutes < 15 || p.coolingThresholdC <= 0
      || p.maxMessageChars < 200 || p.maxMessageChars > 2000) throw new Error("配置错误: 主动消息间隔/降温阈值/长度超出范围");
  }

  if (cfg.reports.enabled && cfg.reports.schedule) {
    try {
      parseCron(cfg.reports.schedule);
    } catch (e) {
      throw new Error(`配置错误: reports.schedule 无效 — ${(e as Error).message}`);
    }
  }
  return cfg;
}

/** 解析相对路径到项目根（config 文件所在目录） */
export function resolveDataPath(baseDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
}
