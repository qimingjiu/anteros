import type { AppConfig } from "../config.js";
import { createLLMClient, type LLMClient } from "./index.js";

/** Resolve an explicit image reader without changing the active conversation model. */
export function createImageReaderClient(modelCfg: AppConfig["model"]): LLMClient | undefined {
  const selected = modelCfg.imageReader;
  if (selected === undefined) return undefined;
  if (!selected || typeof selected.providerName !== "string" || !selected.providerName.trim()
    || typeof selected.model !== "string" || !selected.model.trim()) {
    throw new Error("配置错误: model.image_reader 必须指定服务商名称与完整模型 ID");
  }
  const service = modelCfg.providers?.find(candidate => candidate.name === selected.providerName);
  if (!service) {
    throw new Error("配置错误: model.image_reader.provider 必须匹配 model.providers 中已有服务商名称");
  }
  if (service.provider !== "mock" && !service.apiKey.trim()) {
    throw new Error("配置错误: model.image_reader 所选服务商 API key 未配置");
  }
  return createLLMClient({
    provider: service.provider,
    baseUrl: service.baseUrl,
    apiKey: service.apiKey,
    model: selected.model,
    fallbackModel: "",
    summaryModel: "",
    temperature: modelCfg.temperature,
    maxContextChars: modelCfg.maxContextChars,
    maxOutputChars: modelCfg.maxOutputChars,
    requestTimeoutMs: modelCfg.requestTimeoutMs,
    profiles: [],
  });
}
