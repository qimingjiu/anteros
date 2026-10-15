import { createHash } from "node:crypto";
import type { ModelProfile, ModelService } from "../config.js";
import type { Database } from "../db/index.js";

export interface CatalogReport {
  provider: string;
  source: "live" | "cache" | "configured" | "unavailable";
  count: number;
  warnings: string[];
}

export interface CatalogOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

interface CachedCatalog {
  version: 1;
  fingerprint: string;
  fetchedAt: string;
  modelIds: string[];
}

/** 服务商返回的计价标签可隐藏，但绝不能修改发送到 API 的模型 ID。 */
export function modelDisplayName(modelId: string): string {
  return modelId.replace(/^\[[^\]]*\/次\]\s*/, "");
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

function completeId(id: string): boolean {
  return Boolean(id.trim()) && !/(?:…|\.{3})$/.test(id);
}

function isChatModel(item: Record<string, unknown>, id: string): boolean {
  const kind = String(item.type ?? item.model_type ?? item.task ?? "").toLowerCase();
  if (/^(?:embedding|embeddings|rerank|reranker|image|image_generation|audio|speech|tts|asr)$/.test(kind)) return false;
  const modalities = item.output_modalities ?? (item.modalities as Record<string, unknown> | undefined)?.output;
  if (Array.isArray(modalities) && modalities.length > 0 && !modalities.some((v) => v === "text")) return false;
  // 一些兼容端点没有类型字段，排除名称明确指向非对话用途的模型。
  return !/(?:^|[\/_-])(?:embedding|embeddings|rerank|reranker|whisper|tts|dall-e)(?:$|[\/_-])/i.test(id);
}

function parseModels(value: unknown): string[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).data)) {
    throw new Error("模型列表格式不符合 OpenAI /models 协议");
  }
  const items = (value as { data: unknown[] }).data;
  const ids: string[] = [];
  let validIds = 0;
  for (const value of items) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== "string" || !completeId(id)) continue;
    validIds++;
    if (isChatModel(item, id)) ids.push(id);
  }
  if (items.length > 0 && validIds === 0) throw new Error("模型列表没有有效的完整模型 ID");
  return unique(ids);
}

function identity(service: ModelService): string {
  return createHash("sha256").update(JSON.stringify([
    service.provider,
    service.baseUrl,
    service.modelsUrl ?? `${service.baseUrl.replace(/\/+$/, "")}/models`,
  ])).digest("hex");
}

function cacheKey(service: ModelService): string {
  return `model_catalog:${service.name}`;
}

function readCache(service: ModelService, db: Database): string[] | undefined {
  const raw = db.kvGet(cacheKey(service));
  if (!raw) return undefined;
  try {
    const cache = JSON.parse(raw) as CachedCatalog;
    if (cache.version !== 1 || cache.fingerprint !== identity(service) || !Array.isArray(cache.modelIds)) return undefined;
    if (!cache.modelIds.every((id) => typeof id === "string" && completeId(id))) return undefined;
    return unique(cache.modelIds);
  } catch {
    return undefined;
  }
}

async function fetchModels(service: ModelService, options: CatalogOptions): Promise<string[]> {
  if (service.provider === "mock") return service.models ?? [];
  if (!service.apiKey) throw new Error("API key 未配置，未请求模型列表");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(
        service.modelsUrl ?? `${service.baseUrl.replace(/\/+$/, "")}/models`,
        { headers: { Authorization: `Bearer ${service.apiKey}` }, signal: controller.signal },
      );
    } catch {
      // 不转发异常文本或响应正文，避免服务商把凭据回显到日志。
      throw new Error(controller.signal.aborted ? "模型列表请求超时" : "模型列表请求失败");
    }
    if (!response.ok) throw new Error(`模型列表请求返回 HTTP ${response.status}`);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error(controller.signal.aborted ? "模型列表请求超时" : "模型列表不是有效 JSON");
    }
    return parseModels(value);
  } finally {
    clearTimeout(timer);
  }
}

function selectModels(service: ModelService, available: string[], warnings: string[], fallback: boolean): string[] {
  const configured = service.models ?? [];
  const prefixes = service.modelPrefixes ?? [];
  const filtered = configured.length > 0 || prefixes.length > 0;
  const selected = filtered ? [] : [...available];
  for (const id of configured) {
    if (!completeId(id)) {
      warnings.push(`配置的模型 ID 被截断，未加入：${id}`);
    } else if (available.includes(id)) {
      selected.push(id);
    } else if (fallback) {
      selected.push(id);
      warnings.push(`未能通过模型列表确认，保留已配置的完整 ID：${modelDisplayName(id)}`);
    } else {
      warnings.push(`模型列表中未找到已选模型：${modelDisplayName(id)}`);
    }
  }
  for (const rawPrefix of prefixes) {
    const prefix = rawPrefix.replace(/(?:…|\.{3})$/, "");
    const matches = available.filter((id) => id.startsWith(prefix) || modelDisplayName(id).startsWith(prefix));
    if (matches.length === 1) selected.push(matches[0]!);
    else if (matches.length === 0) warnings.push(`未找到完整模型 ID，未加入前缀：${rawPrefix}`);
    else warnings.push(`模型前缀匹配到多个 ID，需指定完整名称：${rawPrefix}（${matches.map(modelDisplayName).join("、")}）`);
  }
  return unique(selected);
}

/** 每次启动拉取目录；服务暂时不可用时使用不含密钥的缓存或显式完整 ID。 */
export async function discoverModelProfiles(
  services: ModelService[],
  db: Database,
  options: CatalogOptions = {},
): Promise<{ profiles: ModelProfile[]; reports: CatalogReport[] }> {
  const results = await Promise.all(services.map(async (service) => {
    const warnings: string[] = [];
    let available: string[];
    let source: CatalogReport["source"];
    let fallback = false;
    try {
      available = await fetchModels(service, options);
      source = "live";
      const cache: CachedCatalog = {
        version: 1,
        fingerprint: identity(service),
        fetchedAt: new Date().toISOString(),
        modelIds: available,
      };
      db.kvSet(cacheKey(service), JSON.stringify(cache));
    } catch (error) {
      warnings.push((error as Error).message);
      const cache = readCache(service, db);
      available = cache ?? [];
      source = cache !== undefined ? "cache" : (service.models?.some(completeId) ? "configured" : "unavailable");
      fallback = true;
    }
    const selected = selectModels(service, available, warnings, fallback);
    const profiles: ModelProfile[] = selected.map((model) => ({
      name: `${service.name}/${model}`,
      serviceName: service.name,
      displayName: modelDisplayName(model),
      provider: service.provider,
      baseUrl: service.baseUrl,
      apiKey: service.apiKey,
      model,
      temperature: service.temperature,
    }));
    return { profiles, report: { provider: service.name, source, count: profiles.length, warnings } satisfies CatalogReport };
  }));
  return { profiles: results.flatMap((r) => r.profiles), reports: results.map((r) => r.report) };
}
