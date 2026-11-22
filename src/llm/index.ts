import type { AppConfig } from "../config.js";
import { randomUUID } from "node:crypto";
import { logger } from "../util/logger.js";
import { sleep } from "../util/misc.js";
import type { PhoneContextReceipt } from "../presence/index.js";
import { ImageInputCache } from "./image-input.js";
import { acquireOfficialRequestSlot } from "./request-queue.js";
import { stripLeadingThinkBlocks } from "./reply-content.js";
import { localizeMessages } from "../util/model-time.js";

const log = logger("llm");

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImageUrlPart {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextPart | ImageUrlPart;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | ContentPart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  /** Provider-required replay metadata, never user-facing reply content. */
  reasoning_content?: string;
  reasoning_details?: unknown[];
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  durationMs: number;
  model: string;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage?: ChatUsage;
  reasoningContent?: string;
  /** Exact assistant content for tool-protocol replay; never display or persist as a reply. */
  replayContent?: string;
  reasoningDetails?: unknown[];
}

export interface ChatOptions {
  tools?: ToolSpec[];
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
  /** Local request intent; never serialized as a provider parameter. */
  purpose?: "image_reading";
  phoneContextReceipt?: PhoneContextReceipt;
  /** Local image-selection correlation only; never sent to the model provider. */
  imageContextId?: string;
}

export interface LLMClient {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason : new DOMException("模型请求已取消", "AbortError");
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError(signal);
}

function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(cancellationError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface OpenAIResp {
  choices?: { message?: { content?: string | null; reasoning_content?: unknown; reasoning_details?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

interface ImageRequestReceipt {
  receiptId: string;
  imageContextId?: string;
  model: string;
  imageCount: number;
  remoteUrlCount: number;
  inlineDataCount: number;
}

type ImageFailureCode = "SERIALIZATION_ERROR" | "REQUEST_QUEUE_ERROR" | "IMAGE_INPUT_ERROR" | "NETWORK_ERROR" | "RESPONSE_READ_ERROR" | "INVALID_JSON"
  | "INVALID_RESPONSE" | "HTTP_ERROR" | "PROVIDER_ERROR" | "EMPTY_CHOICES" | "CANCELLED" | "TIMEOUT";

/** Never retain provider bodies or network error strings in image-request failures. */
class ImageRequestError extends Error {
  override name = "ImageRequestError";
  constructor(readonly code: ImageFailureCode, receiptId: string, httpStatus?: number) {
    super(`模型图片请求失败 code=${code} receiptId=${receiptId}` + (httpStatus === undefined ? "" : ` HTTP ${httpStatus}`));
  }
}

function imageRequestReceipt(messages: ChatMessage[], model: string, imageContextId?: string): ImageRequestReceipt | undefined {
  let imageCount = 0;
  let inlineDataCount = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "image_url" || typeof part.image_url?.url !== "string") continue;
      imageCount++;
      if (/^data:/i.test(part.image_url.url)) inlineDataCount++;
    }
  }
  if (!imageCount) return undefined;
  // UUIDs are generated locally. Do not turn arbitrary caller strings into log fields.
  const validContextId = typeof imageContextId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(imageContextId);
  return { receiptId: randomUUID(), ...(validContextId ? { imageContextId } : {}),
    model, imageCount, remoteUrlCount: imageCount - inlineDataCount, inlineDataCount };
}

function safeFinishReason(value: unknown): string {
  return typeof value === "string" && ["stop", "length", "tool_calls", "content_filter", "function_call"].includes(value)
    ? value : "unknown";
}

function officialMiniMaxEndpoint(baseUrl: string): boolean {
  try {
    const endpoint = new URL(baseUrl);
    return endpoint.protocol === "https:"
      && ["api.minimaxi.com", "api.minimax.io"].includes(endpoint.hostname.toLowerCase());
  } catch { return false; }
}

function miniMaxResponse(baseUrl: string, model: string): boolean {
  return officialMiniMaxEndpoint(baseUrl) || /(?:^|\/|\])minimax(?:-|\/|$)/i.test(model.trim());
}

export class OpenAICompatibleClient implements LLMClient {
  private phoneReceiptModels = new WeakMap<PhoneContextReceipt, Set<string>>();
  private imageInputs = new ImageInputCache();
  constructor(private cfg: AppConfig["model"]) {}

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    throwIfCancelled(opts?.signal);
    const models = [opts?.model ?? this.cfg.model];
    if (opts?.model === this.cfg.model && this.cfg.fallbackModel) models.push(this.cfg.fallbackModel);
    let lastErr: Error | null = null;

    for (const model of models) {
      throwIfCancelled(opts?.signal);
      const started = Date.now();
      try {
        const resp = await this.requestOnce(messages, model, opts);
        throwIfCancelled(opts?.signal);
        const choice = resp.choices?.[0];
        if (!choice) throw new Error("模型返回空 choices");
        const rawContent = choice.message?.content ?? "";
        const content = miniMaxResponse(this.cfg.baseUrl, model) ? stripLeadingThinkBlocks(rawContent) : rawContent;
        const usage: ChatUsage = {
          promptTokens: resp.usage?.prompt_tokens,
          completionTokens: resp.usage?.completion_tokens,
          durationMs: Date.now() - started,
          model,
        };
        log.info(
          `模型调用完成 model=${model} ${usage.durationMs}ms` +
            ` finish=${safeFinishReason(choice.finish_reason)} tools=${Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls.length : 0}` +
            ` text=${content.length}` +
            (usage.promptTokens ? ` in=${usage.promptTokens} out=${usage.completionTokens ?? "?"}` : ""),
        );
        return {
          content,
          ...(content !== rawContent ? { replayContent: rawContent } : {}),
          ...(typeof choice.message?.reasoning_content === "string" ? { reasoningContent: choice.message.reasoning_content } : {}),
          ...(Array.isArray(choice.message?.reasoning_details) ? { reasoningDetails: choice.message.reasoning_details } : {}),
          toolCalls: (choice.message?.tool_calls ?? []).map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          })),
          finishReason: choice.finish_reason ?? null,
          usage,
        };
      } catch (e) {
        throwIfCancelled(opts?.signal);
        lastErr = e as Error;
        log.warn(`模型调用失败 model=${model}: ${lastErr.message}`);
        await cancellableSleep(500, opts?.signal);
      }
    }
    throw lastErr ?? new Error("模型调用失败");
  }

  private async requestOnce(messages: ChatMessage[], model: string, opts?: ChatOptions): Promise<OpenAIResp> {
    throwIfCancelled(opts?.signal);
    const ctrl = new AbortController();
    const externalSignal = opts?.signal;
    const onAbort = () => { if (externalSignal) ctrl.abort(cancellationError(externalSignal)); };
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let releaseRequestSlot: (() => void) | undefined;
    let imageReceipt = imageRequestReceipt(messages, model, opts?.imageContextId);
    const started = Date.now();
    let failureCode: ImageFailureCode = "SERIALIZATION_ERROR";
    let httpStatus: number | undefined;
    try {
      const endpoint = new URL(this.cfg.baseUrl);
      const moonshot = endpoint.protocol === "https:"
        && ["api.moonshot.cn", "api.moonshot.ai"].includes(endpoint.hostname.toLowerCase());
      // 2026-11-17 火山方舟 Agent Plan：取不到 QQ 图片外链，需内联；kimi 只允许 temperature=1
      const volcArk = endpoint.hostname.toLowerCase() === "ark.cn-beijing.volces.com";
      if (moonshot) {
        failureCode = "REQUEST_QUEUE_ERROR";
        releaseRequestSlot = await acquireOfficialRequestSlot(this.cfg.baseUrl, this.cfg.apiKey, externalSignal);
        throwIfCancelled(externalSignal);
      }
      // Queue waiting has its own bounded deadline; preserve the full network
      // timeout for the request after this credential becomes available.
      timer = setTimeout(() => ctrl.abort(), this.cfg.requestTimeoutMs);
      // Model-facing times are local (e.g. "10-28 16:54"); DB keeps ISO UTC.
      let prepared = localizeMessages(messages);
      if ((moonshot || volcArk || this.cfg.baseUrl.includes("127.0.0.1:3018")) && imageReceipt) {
        failureCode = "IMAGE_INPUT_ERROR";
        prepared = await this.imageInputs.inlineMessages(prepared, ctrl.signal);
        const actual = imageRequestReceipt(prepared, model, opts?.imageContextId)!;
        imageReceipt = { ...actual, receiptId: imageReceipt.receiptId };
      }
      failureCode = "SERIALIZATION_ERROR";
      const body: Record<string, unknown> = {
        model,
        messages: prepared,
      };
      // Official Kimi models have fixed sampling parameters. Let the provider
      // choose its documented defaults instead of forwarding generic overrides.
      const fixedSampling = (volcArk && /^kimi-/i.test(model)) || (this.cfg.baseUrl.includes("127.0.0.1:3018") && /^(?:gpt-[56]|o\d)/i.test(model)) || moonshot && /^kimi-k(?:3|2\.(?:5|6)|2\.7-code(?:-highspeed)?)$/i.test(model);
      if (!fixedSampling) body.temperature = opts?.temperature ?? this.cfg.temperature;
      // MiniMax's default OpenAI format embeds private thinking in content.
      // Keep thinking enabled, but ask for its dedicated non-display fields.
      if (officialMiniMaxEndpoint(this.cfg.baseUrl)) body.reasoning_split = true;
      if (moonshot && imageReceipt && opts?.purpose === "image_reading") {
        body.response_format = { type: "json_object" };
        if (/^kimi-k2\.(?:5|6)$/i.test(model)) body.thinking = { type: "disabled" };
      }
      if (opts?.tools && opts.tools.length > 0) {
        // 2026-11-07 同名工具去重（DeepSeek 遇重名直接 400）
        { const seen = new Set<string>(); body.tools = opts.tools.filter((t: any) => { const n = t?.function?.name ?? t?.name; if (!n || seen.has(n)) return false; seen.add(n); return true; }); }
        body.tool_choice = "auto";
        // 2026-11-17 OpenAI 官方：顶层 schema 必须是纯 object（无 oneOf/anyOf/allOf/enum/not），且 tools 上限 128；内置工具优先，MCP 其次
        if (this.cfg.baseUrl.includes("127.0.0.1:3018") && Array.isArray(body.tools)) {
          const all = body.tools as any[];
          const okSchema = (t: any) => { const s = t?.function?.parameters; return !s || (s.type === "object" && !["oneOf","anyOf","allOf","enum","not","const"].some(k => k in s)); };
          const valid = all.filter(okSchema);
          const ordered = [...valid.filter(t => !String(t?.function?.name ?? "").startsWith("mcp")), ...valid.filter(t => String(t?.function?.name ?? "").startsWith("mcp"))];
          if (all.length !== valid.length || ordered.length > 128) log.warn("GPT官方 tools 过滤", { model, total: all.length, badSchema: all.length - valid.length, kept: Math.min(128, ordered.length) });
          body.tools = ordered.slice(0, 128);
        }
      } else if (opts?.tools) {
        // Omitting tools does not reliably disable calls inferred from earlier
        // assistant/tool history on compatible providers.
        if (!this.cfg.baseUrl.includes("127.0.0.1:3018")) body.tool_choice = "none"; // OpenAI 官方不接受无 tools 的 tool_choice
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
      if (this.cfg.baseUrl.includes("/v1/raw")) headers["X-Client-Id"] = process.argv.some(a => a.includes("discord")) ? "discord" : "qqbot";
      const payload = JSON.stringify(body);
      const receipt = opts?.phoneContextReceipt;
      if (receipt) {
        const loggedModels = this.phoneReceiptModels.get(receipt) ?? new Set<string>();
        if (!loggedModels.has(model)) {
          loggedModels.add(model);
          this.phoneReceiptModels.set(receipt, loggedModels);
          log.info("手机上下文已附加到模型请求", { model, source: receipt.source, purpose: receipt.purpose,
            contextChars: receipt.contextChars, fieldCount: receipt.fieldCount, newestObservedAt: receipt.newestObservedAt,
            oldestObservedAt: receipt.oldestObservedAt, freshFieldCount: receipt.freshFieldCount, staleFieldCount: receipt.staleFieldCount });
        }
      }
      failureCode = "NETWORK_ERROR";
      if (imageReceipt) log.info("模型图片请求已发送", imageReceipt);
      const resp = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: payload,
        signal: ctrl.signal,
      });
      httpStatus = resp.status;
      failureCode = "RESPONSE_READ_ERROR";
      const text = await resp.text();
      let json: OpenAIResp;
      try {
        json = JSON.parse(text) as OpenAIResp;
      } catch {
        failureCode = "INVALID_JSON";
        throw new Error(`模型返回非 JSON (HTTP ${resp.status}): ${text.slice(0, 200)}`);
      }
      if (imageReceipt && (!json || typeof json !== "object" || Array.isArray(json))) {
        failureCode = "INVALID_RESPONSE";
        throw new Error("模型返回无效响应结构");
      }
      if (!resp.ok || json.error) {
        failureCode = resp.ok ? "PROVIDER_ERROR" : "HTTP_ERROR";
        throw new Error(`HTTP ${resp.status}: ${json.error?.message ?? text.slice(0, 200)}`);
      }
      if (imageReceipt) {
        if (!json.choices?.[0]) {
          failureCode = "EMPTY_CHOICES";
          throw new Error("模型返回空 choices");
        }
        throwIfCancelled(externalSignal);
        const choice = json.choices[0];
        log.info("模型图片请求已完成", { ...imageReceipt, httpStatus, durationMs: Date.now() - started,
          finishReason: safeFinishReason(choice.finish_reason),
          contentPresent: typeof choice.message?.content === "string" && choice.message.content.trim().length > 0 });
      }
      return json;
    } catch (error) {
      if (!imageReceipt) throw error;
      if (externalSignal?.aborted) failureCode = "CANCELLED";
      else if (ctrl.signal.aborted) failureCode = "TIMEOUT";
      const errorClass = failureCode === "CANCELLED" || failureCode === "TIMEOUT" ? "abort"
        : failureCode === "NETWORK_ERROR" ? "network"
          : failureCode === "REQUEST_QUEUE_ERROR" ? "queue"
          : failureCode === "SERIALIZATION_ERROR" ? "serialization" : "response";
      log.warn("模型图片请求失败", { ...imageReceipt, ...(httpStatus === undefined ? {} : { httpStatus }),
        durationMs: Date.now() - started, errorClass, code: failureCode });
      throw new ImageRequestError(failureCode, imageReceipt.receiptId, httpStatus);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
      releaseRequestSlot?.();
    }
  }
}

/** 开发联调用的 mock 模型：把最近一条用户消息回显为固定回复。 */
export class MockLLMClient implements LLMClient {
  constructor(private replyTemplate: string = "（mock 回复）收到: {text}") {}

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    throwIfCancelled(opts?.signal);
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    let text = "";
    if (typeof lastUser?.content === "string") text = lastUser.content;
    else if (Array.isArray(lastUser?.content)) {
      text = lastUser.content.filter((p): p is TextPart => p.type === "text").map((p) => p.text).join(" ");
    }
    // Agent 将近期原文放在当前消息之前；模拟回复仍应回显这次的触发内容。
    const currentMessageHeading = "当前需要回复的消息：\n";
    const currentMessageAt = text.indexOf(currentMessageHeading);
    if (currentMessageAt >= 0) text = text.slice(currentMessageAt + currentMessageHeading.length).trim();
    const content = this.replyTemplate.replace("{text}", text.slice(0, 120));
    await cancellableSleep(50, opts?.signal);
    return {
      content,
      toolCalls: [],
      finishReason: "stop",
      usage: { durationMs: 50, model: "mock" },
    };
  }
}

export function createLLMClient(cfg: AppConfig["model"]): LLMClient {
  if (cfg.provider === "mock") return new MockLLMClient();
  return new OpenAICompatibleClient(cfg);
}
