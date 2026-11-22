import type { ModelProfile } from "../config.js";
import type { Database } from "../db/index.js";
import { createLLMClient, type LLMClient } from "./index.js";
import { logger } from "../util/logger.js";
import { modelDisplayName } from "./catalog.js";
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

  constructor(
    private profiles: ModelProfile[],
    private defaultCfg: import("../config.js").AppConfig["model"],
    private db: Database,
  ) {
    const saved = db.kvGet(KV_KEY);
    const savedProfile = profiles.find((p) => p.name === saved);
    if (savedProfile && (savedProfile.provider === "mock" || savedProfile.apiKey)) {
      this.apply(savedProfile.name);
    } else {
      if (saved) log.warn(`持久化的模型档位 "${saved}" 不可用，回退默认`);
      this.current = createLLMClient(defaultCfg);
      this.currentName = `默认（${defaultCfg.model}）`;
    }
  }

  private apply(name: string): void {
    const p = this.profiles.find((x) => x.name === name)!;
    const viaGateway = this.defaultCfg.baseUrl.includes("/v1/raw") && p.provider !== "mock";
    const route = viaGateway && !/127\.0\.0\.1:3018|volces\.com/.test(p.baseUrl) ? labrysRoute(p.model, serviceName(p), p.name) : undefined; // 2026-11-17 GPT官方/火山直连
    if (viaGateway) log.info(route ? `模型经网关: ${p.name} → route ${route}` : `网关无此模型路由，直连: ${p.name}`);
    this.current = createLLMClient({
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
    this.currentName = p.name;
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
    return this.currentName;
  }

  activeDisplayName(): string {
    const profile = this.profiles.find((p) => p.name === this.currentName);
    return profile ? `${serviceName(profile)} / ${displayName(profile)}` : this.currentName;
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
    if (p.name === this.currentName) {
      return { ok: true, message: `当前已经在用 ${serviceName(p)} / ${displayName(p)} 了。` };
    }
    this.apply(p.name);
    this.db.kvSet(KV_KEY, p.name);
    log.info(`模型已切换: ${serviceName(p)} / ${displayName(p)}`);
    return {
      ok: true,
      message: `已切换到 ${serviceName(p)} / ${displayName(p)}。之后所有对话、群聊和记忆摘要都使用它；重启后保持。`,
    };
  }

  listProviders(): string {
    const lines = this.providerNames().map((name, i) => {
      const profiles = this.modelsFor(name);
      const mark = profiles.some((p) => p.name === this.currentName) ? " ← 当前" : "";
      return `${i + 1}. ${name}（${profiles.length ? `${profiles.length} 个模型` : "目录暂不可用"}）${mark}`;
    });
    return ["先选择模型商：", ...lines, "", "回复模型商名称或序号，然后选择具体模型。", `当前：${this.activeDisplayName()}`].join("\n");
  }

  list(provider?: string): string {
    if (!provider) return this.listProviders();
    if (!this.providerNames().includes(provider)) return `没有叫 "${provider}" 的模型商。\n${this.listProviders()}`;
    const models = this.modelsFor(provider);
    const lines = models.map((p, i) => {
      const mark = p.name === this.currentName ? " ← 当前" : "";
      const unavailable = p.provider !== "mock" && !p.apiKey ? "（API key 未配置）" : "";
      return `${i + 1}. ${displayName(p)}${unavailable}${mark}`;
    });
    return [`${provider} 的可选模型：`, ...(lines.length ? lines : ["暂时没有可用模型，请检查模型列表或配置。"]), "", "回复模型名称或序号即可切换；也可以回复“返回”重选模型商。", `当前：${this.activeDisplayName()}`].join("\n");
  }

  async chat(messages: Parameters<LLMClient["chat"]>[0], opts?: Parameters<LLMClient["chat"]>[1]) {
    return this.current.chat(messages, opts);
  }
}
