import type { AppConfig } from "../config.js";
import { logger } from "../util/logger.js";
import { sleep } from "../util/misc.js";
import type { PhoneContextReceipt } from "../presence/index.js";

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
}

export interface ChatOptions {
  tools?: ToolSpec[];
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
  phoneContextReceipt?: PhoneContextReceipt;
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
  choices?: { message?: { content?: string | null; reasoning_content?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenAICompatibleClient implements LLMClient {
  private phoneReceiptModels = new WeakMap<PhoneContextReceipt, Set<string>>();
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
        const usage: ChatUsage = {
          promptTokens: resp.usage?.prompt_tokens,
          completionTokens: resp.usage?.completion_tokens,
          durationMs: Date.now() - started,
          model,
        };
        log.info(
          `模型调用完成 model=${model} ${usage.durationMs}ms` +
            ` finish=${choice.finish_reason ?? "unknown"} tools=${choice.message?.tool_calls?.length ?? 0} text=${choice.message?.content?.length ?? 0}` +
            (usage.promptTokens ? ` in=${usage.promptTokens} out=${usage.completionTokens ?? "?"}` : ""),
        );
        return {
          content: choice.message?.content ?? "",
          ...(typeof choice.message?.reasoning_content === "string" ? { reasoningContent: choice.message.reasoning_content } : {}),
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
    const timer = setTimeout(() => ctrl.abort(), this.cfg.requestTimeoutMs);
    try {
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: opts?.temperature ?? this.cfg.temperature,
      };
      if (opts?.tools && opts.tools.length > 0) {
        body.tools = opts.tools;
        body.tool_choice = "auto";
      } else if (opts?.tools) {
        // Omitting tools does not reliably disable calls inferred from earlier
        // assistant/tool history on compatible providers.
        body.tool_choice = "none";
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
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
      const resp = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: payload,
        signal: ctrl.signal,
      });
      const text = await resp.text();
      let json: OpenAIResp;
      try {
        json = JSON.parse(text) as OpenAIResp;
      } catch {
        throw new Error(`模型返回非 JSON (HTTP ${resp.status}): ${text.slice(0, 200)}`);
      }
      if (!resp.ok || json.error) {
        throw new Error(`HTTP ${resp.status}: ${json.error?.message ?? text.slice(0, 200)}`);
      }
      return json;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
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
