export type GroupReplyKind = "observation" | "owner_mention" | "direct";

export interface GroupReplyRequest {
  accountId: string;
  conversationId: string;
  senderId: string;
  kind: GroupReplyKind;
  /** 使用本机收到消息的时间，避免 QQ 秒级时间戳把刚收到的新追问当成旧消息。 */
  receivedAt: number;
  text?: string;
}

export type ReplyLimitReason = "stale_observation" | "cooldown" | "window_limit"
  | "repeated_owner_mention" | "repeated_reply";
export type ReplyLimitDecision = { allowed: true } | { allowed: false; reason: ReplyLimitReason };

export interface ConversationReplyLimitsOptions {
  now?: () => number;
  cooldownMs?: number;
  windowMs?: number;
  maxRepliesPerWindow?: number;
  ownerMentionDedupeMs?: number;
  repeatedReplyWindowMs?: number;
  seenEventTtlMs?: number;
}

interface SentReply {
  at: number;
  kind: GroupReplyKind;
  text: string;
  senderId: string;
}
export interface RecentGroupReply {
  text: string;
  sentAt: number;
  kind: GroupReplyKind;
  senderId: string;
}
interface ConversationState {
  latestReplyAt: number;
  replies: SentReply[];
  /** 配额时间与正文快照分离，显式问答不能挤掉窗口内自动接话的计数。 */
  automaticReplyTimes: number[];
  ownerMentions: Map<string, { text: string; at: number }>;
  touchedAt: number;
}

const ALLOW: ReplyLimitDecision = { allowed: true };
const duration = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;

/** 标点/空白差异不能让同一段回答绕过去重；保留数字、汉字与英文字母。 */
export function normalizeReplyText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/\[CQ:[^\]]*\]/giu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function trigrams(text: string): Map<string, number> {
  const points = [...text];
  const result = new Map<string, number>();
  for (let index = 0; index + 2 < points.length; index++) {
    const key = points.slice(index, index + 3).join("");
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

/**
 * 仅拦足够长且高度相似的已发送内容。短确认、新数值和明显新增的信息保留。
 * 多重三字片段避免一段大量重复词将相似度虚抬，也不需要再调用判断模型。
 */
export function isRepeatedReply(candidate: string, previous: string): boolean {
  const next = normalizeReplyText(candidate);
  const old = normalizeReplyText(previous);
  const nextLength = [...next].length;
  const oldLength = [...old].length;
  if (Math.min(nextLength, oldLength) < 12) return false;
  const numbers = (text: string): string => text.normalize("NFKC").replace(/\[CQ:[^\]]*\]/giu, "")
    .match(/[-+]?\d+(?:[.,]\d+)?/gu)?.join("|") ?? "";
  // 小数点等标点也是数值的一部分，先于归一化后的完全相等检查。
  if (numbers(candidate) !== numbers(previous)) return false;
  if (next === old) return true;
  if (Math.min(nextLength, oldLength) < 24) return false;
  if (Math.min(nextLength, oldLength) / Math.max(nextLength, oldLength) < 0.75) return false;

  // 天气温度、报价、日期、统计数量有变化时，不凭相似措辞抑制事实更新。
  const nextNumbers = next.match(/\p{N}+/gu)?.join("|") ?? "";
  const oldNumbers = old.match(/\p{N}+/gu)?.join("|") ?? "";
  if (nextNumbers !== oldNumbers) return false;

  const nextParts = trigrams(next);
  const oldParts = trigrams(old);
  let overlap = 0;
  for (const [key, count] of nextParts) overlap += Math.min(count, oldParts.get(key) ?? 0);
  return 2 * overlap / (nextLength + oldLength - 4) >= 0.88;
}

/**
 * 群聊自动接话的本地刹车。主模型继续决定内容；明确 @、引用追问和私聊不受正文去重。
 * canStart 在串行队列真正开始时调用，canSend 在发出前调用。
 * recordReply 在新发送任务成功接受排队时调用，立刻阻止后续插话重复生成，不等待 QQ 协议确认。
 * 可将数据库近期已发消息和待发送任务通过 recordReply 载入，以恢复重启前的冷却和正文去重。
 */
export class ConversationReplyLimits {
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly windowMs: number;
  private readonly maxRepliesPerWindow: number;
  private readonly ownerMentionDedupeMs: number;
  private readonly repeatedReplyWindowMs: number;
  private readonly seenEventTtlMs: number;
  private readonly conversations = new Map<string, ConversationState>();
  private readonly seenEvents = new Map<string, number>();

  constructor(options: ConversationReplyLimitsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.cooldownMs = duration(options.cooldownMs, 30_000);
    this.windowMs = duration(options.windowMs, 10 * 60_000);
    this.maxRepliesPerWindow = Math.max(1, Math.floor(duration(options.maxRepliesPerWindow, 3)));
    this.ownerMentionDedupeMs = duration(options.ownerMentionDedupeMs, 45_000);
    this.repeatedReplyWindowMs = duration(options.repeatedReplyWindowMs, 15 * 60_000);
    this.seenEventTtlMs = duration(options.seenEventTtlMs, 2 * 60 * 60_000);
  }

  /** 同一平台事件只处理一次；账号及会话隔离，绝不只按 QQ 消息编号全局去重。 */
  claimEvent(accountId: string, conversationId: string, eventKey: string): boolean {
    const now = this.now();
    this.prune(now);
    const key = JSON.stringify([accountId, conversationId, eventKey]);
    const seenAt = this.seenEvents.get(key);
    if (seenAt !== undefined && now - seenAt < this.seenEventTtlMs) return false;
    this.seenEvents.set(key, now);
    while (this.seenEvents.size > 10_000) this.seenEvents.delete(this.seenEvents.keys().next().value!);
    return true;
  }

  /** 供提示词补齐最新机器人答复；返回独立对象，调用方不能改写内部限流状态。 */
  recentReplies(accountId: string, conversationId: string): RecentGroupReply[] {
    const now = this.now();
    this.prune(now);
    const state = this.conversations.get(JSON.stringify([accountId, conversationId]));
    if (!state) return [];
    this.trimState(state, now);
    return state.replies.filter(reply => now - reply.at < this.repeatedReplyWindowMs)
      .map(reply => ({ text: reply.text, sentAt: reply.at, kind: reply.kind, senderId: reply.senderId }));
  }

  canStart(request: GroupReplyRequest): ReplyLimitDecision {
    if (request.kind === "direct") return ALLOW;
    const now = this.now();
    const state = this.state(request, now);
    if (request.kind === "owner_mention") {
      const last = state.ownerMentions.get(request.senderId);
      const text = normalizeReplyText(request.text ?? "");
      if (last && now - last.at < this.ownerMentionDedupeMs && text === last.text) {
        return { allowed: false, reason: "repeated_owner_mention" };
      }
    }
    if (Number.isFinite(request.receivedAt) && request.receivedAt < state.latestReplyAt) {
      return { allowed: false, reason: "stale_observation" };
    }
    if (now - state.latestReplyAt < this.cooldownMs) return { allowed: false, reason: "cooldown" };
    if (state.automaticReplyTimes.length >= this.maxRepliesPerWindow) return { allowed: false, reason: "window_limit" };
    return ALLOW;
  }

  canSend(request: GroupReplyRequest, text: string): ReplyLimitDecision {
    if (request.kind === "direct") return ALLOW;
    const now = this.now();
    const state = this.state(request, now);
    if (state.replies.some(reply => now - reply.at < this.repeatedReplyWindowMs && isRepeatedReply(text, reply.text))) {
      return { allowed: false, reason: "repeated_reply" };
    }
    return ALLOW;
  }

  recordReply(request: GroupReplyRequest, text: string, options: { sentAt?: number } = {}): void {
    const now = this.now();
    const at = options.sentAt !== undefined && Number.isFinite(options.sentAt) ? options.sentAt : now;
    const state = this.state(request, now);
    state.latestReplyAt = Math.max(state.latestReplyAt, at);
    state.replies.push({ at, kind: request.kind, text: text.slice(0, 8000), senderId: request.senderId });
    state.replies.sort((a, b) => b.at - a.at);
    state.replies = state.replies.slice(0, 20);
    if (request.kind !== "direct" && now - at < this.windowMs) {
      state.automaticReplyTimes.push(at);
      // 保留最新的配额数量即可判定是否已满；旧配额到期后不会被正文容量影响。
      state.automaticReplyTimes.sort((a, b) => b - a);
      state.automaticReplyTimes = state.automaticReplyTimes.slice(0, this.maxRepliesPerWindow);
    }
    if (request.kind === "owner_mention") {
      const previous = state.ownerMentions.get(request.senderId);
      if (!previous || previous.at <= at) {
        state.ownerMentions.set(request.senderId, { at, text: normalizeReplyText(request.text ?? "") });
        while (state.ownerMentions.size > 256) state.ownerMentions.delete(state.ownerMentions.keys().next().value!);
      }
    }
  }

  private state(request: GroupReplyRequest, now: number): ConversationState {
    this.prune(now);
    const key = JSON.stringify([request.accountId, request.conversationId]);
    let state = this.conversations.get(key);
    if (!state) {
      state = { latestReplyAt: -Infinity, replies: [], automaticReplyTimes: [], ownerMentions: new Map(), touchedAt: now };
    }
    state.touchedAt = now;
    // Map 顺序用作 LRU：固定限额不会把仍活跃的老群优先丢掉。
    this.conversations.delete(key);
    this.conversations.set(key, state);
    while (this.conversations.size > 128) this.conversations.delete(this.conversations.keys().next().value!);
    this.trimState(state, now);
    return state;
  }

  private trimState(state: ConversationState, now: number): void {
    const retention = Math.max(this.windowMs, this.repeatedReplyWindowMs, this.cooldownMs);
    state.replies = state.replies.filter(reply => now - reply.at < retention);
    state.automaticReplyTimes = state.automaticReplyTimes.filter(at => now - at < this.windowMs);
    for (const [senderId, mention] of state.ownerMentions) {
      if (now - mention.at >= this.ownerMentionDedupeMs) state.ownerMentions.delete(senderId);
    }
  }

  private prune(now: number): void {
    for (const [key, seenAt] of this.seenEvents) {
      if (now - seenAt >= this.seenEventTtlMs) this.seenEvents.delete(key);
    }
    const retention = Math.max(this.windowMs, this.repeatedReplyWindowMs, this.cooldownMs, this.ownerMentionDedupeMs);
    for (const [key, state] of this.conversations) {
      if (now - Math.max(state.touchedAt, state.latestReplyAt) > retention) this.conversations.delete(key);
    }
  }
}
