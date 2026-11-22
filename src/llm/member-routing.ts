import { createHash } from "node:crypto";
import type { ModelProfile } from "../config.js";
import type { ChatMessage, ChatOptions, ChatResult } from "./index.js";
import { stripLeadingThinkBlocks } from "./reply-content.js";

export interface MemberModelFailoverPolicy {
  primaryProfile?: string;
  fallbackProfiles: string[];
  maxAttempts?: number;
  attemptTimeoutMs?: number;
  totalTimeoutMs?: number;
  cooldownMs?: number;
}

type RouteFailure = "network" | "timeout" | "response" | "http" | "request" | "unavailable" | "filtered";
const failureMessages: Record<RouteFailure, string> = {
  network: "模型连接失败",
  timeout: "模型请求超时",
  response: "模型返回了空白或无效的响应",
  http: "模型服务拒绝了请求",
  request: "模型请求无法提交",
  unavailable: "当前没有符合要求且可用的成员模型",
  filtered: "模型服务停止生成",
};

/** Only fixed descriptions, a numeric status and a bounded retry window escape a failed route. */
export class MemberRouteError extends Error {
  override name = "MemberRouteError";
  constructor(readonly category: RouteFailure, readonly status?: number, readonly retryAfterMs = 0) {
    super(failureMessages[category] + (status ? ` HTTP ${status}` : ""));
  }

  get recoverable(): boolean {
    if (this.category === "http") {
      return Boolean(this.status && ([401, 404, 408, 425, 429].includes(this.status) || this.status >= 500));
    }
    return ["network", "timeout", "response"].includes(this.category);
  }
}

export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const duration = /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(duration) ? Math.max(0, Math.min(86_400_000, duration)) : 0;
}

export function memberRouteIdentity(config: Pick<ModelProfile, "provider" | "baseUrl" | "apiKey" | "model">): string {
  return createHash("sha256").update(JSON.stringify([config.provider, config.baseUrl, config.apiKey, config.model])).digest("hex");
}

/** Preserve the tool call and its outputs when a model's private reasoning cannot be replayed. */
export function messagesForMemberRoute(messages: ChatMessage[], identity: string): ChatMessage[] {
  return messages.map(({ reasoning_scope, ...message }) => {
    if (reasoning_scope === identity || message.role !== "assistant") return message;
    const { reasoning_content: _privateContent, reasoning_details: _privateDetails, ...visible } = message;
    if (typeof visible.content !== "string") return visible;
    return { ...visible, content: stripLeadingThinkBlocks(visible.content) };
  });
}

export function memberRouteCompatible(profile: ModelProfile | undefined, messages: ChatMessage[], opts?: ChatOptions): boolean {
  const capabilities: { tools?: boolean; vision?: boolean } | undefined = profile?.capabilities;
  if (capabilities?.tools === false && (opts?.tools?.length || messages.some(m => m.role === "tool" || m.tool_calls?.length))) return false;
  return capabilities?.vision !== false || !messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === "image_url"));
}

export function checkMemberResult(result: ChatResult, opts?: ChatOptions): void {
  if (result.finishReason === "content_filter") throw new MemberRouteError("filtered");
  if (typeof result.content !== "string" || !Array.isArray(result.toolCalls) || result.toolCalls.length > 32
    || (!result.content.trim() && !result.toolCalls.length)) throw new MemberRouteError("response");
  const ids = new Set<string>();
  const allowedNames = new Set(opts?.tools?.map(tool => tool.function.name));
  for (const call of result.toolCalls) {
    if (!call || typeof call.id !== "string" || !call.id.trim() || ids.has(call.id)
      || typeof call.name !== "string" || !allowedNames.has(call.name) || typeof call.arguments !== "string") {
      throw new MemberRouteError("response");
    }
    try {
      const args: unknown = JSON.parse(call.arguments);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
    } catch { throw new MemberRouteError("response"); }
    ids.add(call.id);
  }
}
