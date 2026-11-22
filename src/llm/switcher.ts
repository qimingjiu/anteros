import type { ModelProfile } from "../config.js";
import type { Database } from "../db/index.js";
import { randomUUID } from "node:crypto";
import { createLLMClient, type ChatMessage, type ChatOptions, type ChatResult, type LLMClient } from "./index.js";
import { logger } from "../util/logger.js";
import { modelDisplayName } from "./catalog.js";
import { MemberRouteError, checkMemberResult, memberRouteCompatible, memberRouteIdentity, messagesForMemberRoute,
  type MemberModelFailoverPolicy } from "./member-routing.js";

export type { MemberModelFailoverPolicy } from "./member-routing.js";
import { readFileSync } from "node:fs";

/** 网关路由：默认 base_url 指向 Labrys /v1/raw 时，切换的模型也走网关（按上游模型名找路由 id）。找不到路由才直连。 */
function labrysRoute(model: string, service: string, profileName = ""): string | undefined {
  try {
    const cfg = JSON.parse(readFileSync(process.env.LABRYS_MODELS_PATH || "/opt/labrys/models.local.json", "utf8"));
    const hits = (cfg.routes ?? []).filter((r: any) => r.model === model);
    const svc = service.toLowerCase();
    const byName = profileName ? hits.find((r: any) => String(r.name) === profileName.replace("/", " ")) : undefined; // 2026-11-10 同模型多服务商（天翼云1/2）按档位名区分
    return (byName ?? hits.find((r: any) => String(r.providerId).toLowerCase() === svc) ?? hits[0])?.id;
  } catch { return undefined; }
}

const log = logger("llm-switch");
const KV_KEY = "active_model_profile";

type FailoverPolicy = Required<Omit<MemberModelFailoverPolicy, "primaryProfile">> & Pick<MemberModelFailoverPolicy, "primaryProfile">;
interface MemberScope {
  key: string;
  name: string;
  fallback: ModelSwitcher;
  failover?: FailoverPolicy;
}

interface ActiveRoute {
  key: string;
  name?: string;
  model: string;
  profile?: ModelProfile;
  client: LLMClient;
  available: boolean;
}

function normalizeFailover(policy: MemberModelFailoverPolicy): FailoverPolicy {
  return { primaryProfile: policy.primaryProfile, fallbackProfiles: [...new Set(policy.fallbackProfiles)],
    maxAttempts: policy.maxAttempts ?? 3, attemptTimeoutMs: policy.attemptTimeoutMs ?? 45_000,
    totalTimeoutMs: policy.totalTimeoutMs ?? 60_000, cooldownMs: policy.cooldownMs ?? 60_000 };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error && signal.reason.name === "AbortError"
      ? signal.reason : new DOMException("模型请求已取消", "AbortError");
  }
}

function serviceName(profile: ModelProfile): string {
  if (profile.serviceName) return profile.serviceName;
  try {
    const host = new URL(profile.baseUrl).hostname;
    if (host === "api.deepseek.com" || host === "deepseek.com") return "DeepSeek";
    return host.replace(/^api\./, "");
  } catch {
    return "默认";
  }
}

function displayName(profile: ModelProfile): string {
  return profile.displayName ?? modelDisplayName(profile.model);
}

/**
 * 可切换模型：管理员在私聊里先选服务商，再选择该服务商的模型。
 * 选择持久化在数据库 kv 里，重启后保留。切换全局生效（群聊+私聊+摘要）。
 */
export class ModelSwitcher implements LLMClient {
  private current!: LLMClient;
  private currentName!: string;
  private readonly profileClients = new Map<string, LLMClient>();

  constructor(
    private profiles: ModelProfile[],
    private defaultCfg: import("../config.js").AppConfig["model"],
    private db: Database,
    private scope?: MemberScope,
  ) {
    const saved = db.kvGet(scope?.key ?? KV_KEY);
    const savedProfile = profiles.find((p) => p.name === saved);
    if (savedProfile && (savedProfile.provider === "mock" || savedProfile.apiKey)) {
      this.apply(savedProfile.name);
    } else {
      if (saved) log.warn(`持久化的模型档位 "${saved}" 不可用，回退默认`);
      this.current = scope?.fallback ?? createLLMClient(defaultCfg);
      this.currentName = scope ? "" : `默认（${defaultCfg.model}）`;
    }
  }

  forMember(room: string, id: string, name: string, failover?: MemberModelFailoverPolicy): ModelSwitcher {
    return new ModelSwitcher(this.profiles, this.defaultCfg, this.db, {
      key: `member_model:${JSON.stringify([room, id])}`, name, fallback: this, failover: failover && normalizeFailover(failover),
    });
  }

  private clientFor(p: ModelProfile): LLMClient {
    const existing = this.profileClients.get(p.name);
    if (existing) return existing;
    const client = this.createProfileClient(p);
    this.profileClients.set(p.name, client);
    return client;
  }

  private createProfileClient(p: ModelProfile): LLMClient {
    const viaGateway = this.defaultCfg.baseUrl.includes("/v1/raw") && p.provider !== "mock";
    const route = viaGateway && !/127\.0\.0\.1:3018|volces\.com/.test(p.baseUrl) ? labrysRoute(p.model, serviceName(p), p.name) : undefined; // 2026-11-17 GPT官方/火山直连
    if (viaGateway) log.info(route ? `模型经网关: ${p.name} → route ${route}` : `网关无此模型路由，直连: ${p.name}`);
    return createLLMClient({
      provider: p.provider,
      baseUrl: route ? this.defaultCfg.baseUrl : p.baseUrl,
      apiKey: route ? this.defaultCfg.apiKey : p.apiKey,
      model: route ?? p.model,
      fallbackModel: "",
      summaryModel: "",
      temperature: p.temperature ?? this.defaultCfg.temperature,
      maxContextChars: this.defaultCfg.maxContextChars,
      maxOutputChars: this.defaultCfg.maxOutputChars,
      requestTimeoutMs: this.defaultCfg.requestTimeoutMs,
      profiles: [],
    });
  }

  private apply(name: string): void {
    this.current = this.createProfileClient(this.profiles.find(x => x.name === name)!);
    this.currentName = name;
  }

  private routeFor(profile: ModelProfile): ActiveRoute {
    return { name: profile.name, key: memberRouteIdentity(profile), model: profile.model,
      profile, client: this.clientFor(profile), available: profile.provider === "mock" || Boolean(profile.apiKey) };
  }

  private memberRoute(saved?: string): ActiveRoute {
    const scope = this.scope!;
    const selected = this.profiles.find(profile => profile.name === saved)
      ?? this.profiles.find(profile => profile.name === scope.failover?.primaryProfile);
    if (selected) return this.routeFor(selected);
    const inherited = this.profiles.find(profile => profile.name === scope.fallback.currentName);
    return inherited ? this.routeFor(inherited) : { key: memberRouteIdentity(this.defaultCfg),
      model: this.defaultCfg.model, client: scope.fallback.current, available: Boolean(this.defaultCfg.model) || this.defaultCfg.provider === "mock" };
  }

  private get revisionKey(): string { return `${this.scope!.key}:revision`; }
  private get overrideKey(): string { return `${this.scope!.key}:override`; }

  private saveMemberRoute(name: string, forceOnce: boolean): void {
    const revision = randomUUID();
    this.db.db.exec("SAVEPOINT member_model_selection");
    try {
      this.db.kvSet(this.scope!.key, name);
      this.db.kvSet(this.revisionKey, revision);
      if (forceOnce) this.db.kvSet(this.overrideKey, revision);
      else this.db.kvDelete(this.overrideKey);
      this.db.db.exec("RELEASE member_model_selection");
    } catch (error) {
      this.db.db.exec("ROLLBACK TO member_model_selection; RELEASE member_model_selection");
      throw error;
    }
  }

  profileNames(): string[] {
    return this.profiles.map((p) => p.name);
  }

  providerNames(): string[] {
    return [...new Set([
      ...this.profiles.map(serviceName),
      ...(this.defaultCfg.providers ?? []).map((p) => p.name),
    ])];
  }

  modelsFor(provider: string): ModelProfile[] {
    return this.profiles.filter((p) => serviceName(p) === provider);
  }

  activeName(): string {
    if (this.scope?.failover) return this.memberRoute(this.db.kvGet(this.scope.key)).name || this.scope.fallback.activeName();
    return this.currentName || this.scope?.fallback.activeName() || "";
  }

  activeDisplayName(): string {
    const active = this.scope?.failover ? this.activeName() : this.currentName;
    const profile = this.profiles.find((p) => p.name === active);
    return profile ? `${serviceName(profile)} / ${displayName(profile)}`
      : this.currentName || this.scope?.fallback.activeDisplayName() || "";
  }

  switchTo(name: string): { ok: boolean; message: string } {
    const p = this.profiles.find((x) => x.name === name);
    if (!p) {
      return {
        ok: false,
        message: `没有叫 "${name}" 的模型档位。请先选择模型商：${this.providerNames().join("、")}（当前仍是 ${this.activeDisplayName()}）`,
      };
    }
    if (p.provider !== "mock" && !p.apiKey) {
      return { ok: false, message: `${serviceName(p)} 的 API key 未配置，不能切换；当前仍是 ${this.activeDisplayName()}。` };
    }
    if (!this.scope?.failover && p.name === this.currentName) {
      return { ok: true, message: `当前已经在用 ${serviceName(p)} / ${displayName(p)} 了。` };
    }
    if (this.scope?.failover) {
      this.saveMemberRoute(p.name, true);
    } else {
      this.apply(p.name);
      this.db.kvSet(this.scope?.key ?? KV_KEY, p.name);
    }
    log.info(`模型已切换: ${serviceName(p)} / ${displayName(p)}`);
    return {
      ok: true,
      message: this.scope
        ? `${this.scope.name}已切换到 ${serviceName(p)} / ${displayName(p)}。此成员在已绑定私聊和后台任务中使用该模型。`
        : `已切换到 ${serviceName(p)} / ${displayName(p)}。之后所有对话、群聊和记忆摘要都使用它；重启后保持。`,
    };
  }

  listProviders(): string {
    const lines = this.providerNames().map((name, i) => {
      const profiles = this.modelsFor(name);
      const mark = profiles.some((p) => p.name === this.activeName()) ? " ← 当前" : "";
      return `${i + 1}. ${name}（${profiles.length ? `${profiles.length} 个模型` : "目录暂不可用"}）${mark}`;
    });
    return ["先选择模型商：", ...lines, "", "回复模型商名称或序号，然后选择具体模型。", `当前：${this.activeDisplayName()}`].join("\n");
  }

  list(provider?: string): string {
    if (!provider) return this.listProviders();
    if (!this.providerNames().includes(provider)) return `没有叫 "${provider}" 的模型商。\n${this.listProviders()}`;
    const models = this.modelsFor(provider);
    const lines = models.map((p, i) => {
      const mark = p.name === this.activeName() ? " ← 当前" : "";
      const unavailable = p.provider !== "mock" && !p.apiKey ? "（API key 未配置）" : "";
      return `${i + 1}. ${displayName(p)}${unavailable}${mark}`;
    });
    return [`${provider} 的可选模型：`, ...(lines.length ? lines : ["暂时没有可用模型，请检查模型列表或配置。"]), "", "回复模型名称或序号即可切换；也可以回复“返回”重选模型商。", `当前：${this.activeDisplayName()}`].join("\n");
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    const scope = this.scope;
    const policy = scope?.failover;
    if (!scope || !policy) return this.current.chat(messages, opts);
    throwIfAborted(opts?.signal);

    const saved = this.db.kvGet(scope.key);
    const revision = this.db.kvGet(this.revisionKey);
    const inherited = scope.fallback.current;
    const active = this.memberRoute(saved);
    // An enabled member policy owns the upstream model identifier. Only the
    // current profile and its explicitly configured backups receive messages.
    if (opts?.model !== undefined && opts.model !== active.model) throw new MemberRouteError("request");
    const backups = policy.fallbackProfiles.flatMap(name => {
      const profile = this.profiles.find(candidate => candidate.name === name);
      return profile ? [this.routeFor(profile)] : [];
    });
    let lastError: MemberRouteError | undefined;
    const attempted = new Set<string>();
    const started = performance.now();
    for (const route of [active, ...backups]) {
      throwIfAborted(opts?.signal);
      const remaining = Math.floor(policy.totalTimeoutMs - (performance.now() - started));
      if (remaining <= 0 || attempted.size >= policy.maxAttempts) break;
      if (!route.available || attempted.has(route.key) || !memberRouteCompatible(route.profile, messages, opts)) continue;
      const healthKey = `${scope.key}:cooldown:${route.key}`;
      const cooldown = this.db.kvGet(healthKey);
      const forced = route === active && revision !== undefined && revision === this.db.kvGet(this.overrideKey);
      if (!forced && Number(cooldown) > Date.now()) continue;
      if (forced) this.db.kvDelete(this.overrideKey);
      attempted.add(route.key);

      const timeout = AbortSignal.timeout(Math.min(policy.attemptTimeoutMs, remaining));
      const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      let result: ChatResult;
      try {
        result = await route.client.chat(messagesForMemberRoute(messages, route.key),
          { ...opts, model: route.model, memberRoute: true, signal });
        throwIfAborted(opts?.signal);
        if (timeout.aborted) throw new MemberRouteError("timeout");
        checkMemberResult(result, opts);
      } catch (error) {
        throwIfAborted(opts?.signal);
        const failure = timeout.aborted ? new MemberRouteError("timeout") : error;
        if (!(failure instanceof MemberRouteError) || !failure.recoverable) throw failure;
        lastError = failure;
        this.db.kvSet(healthKey, String(Math.max(Number(this.db.kvGet(healthKey)) || 0,
          Date.now() + Math.max(policy.cooldownMs, failure.retryAfterMs))));
        continue;
      }

      if (this.db.kvGet(healthKey) === cooldown) this.db.kvDelete(healthKey);
      if (route !== active && route.name && this.db.kvGet(scope.key) === saved
        && this.db.kvGet(this.revisionKey) === revision && scope.fallback.current === inherited) {
        this.saveMemberRoute(route.name, false);
        log.info("成员已启用备用模型", { profile: route.name });
      }
      return { ...result, reasoningScope: route.key };
    }
    throw lastError ?? new MemberRouteError("unavailable");
  }
}
