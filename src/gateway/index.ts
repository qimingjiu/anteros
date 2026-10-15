import type {
  GatewayEvent,
  MessageRecord,
  MessageSegment,
  Provider,
  SendResult,
  PokeEvent,
} from "../types.js";
import type { Database, DBRow_Message } from "../db/index.js";
import { segmentsText } from "../onebot/provider.js";
import { logger } from "../util/logger.js";
import { sleep } from "../util/misc.js";

const log = logger("gateway");

export type { GatewayEvent, MessageRecord, MessageSegment } from "../types.js";

export type SendPayload =
  | { kind: "segments"; segments: MessageSegment[]; expiresAt?: string; requesterId?: string; accountId?: string;
      replyKind?: "observation" | "owner_mention" | "direct"; replyBatch?: string }
  | { kind: "file"; filePath: string; fileName: string }
  | { kind: "poke"; userId: string; requesterId: string; accountId: string; expiresAt: string; sourceEventKey: string };

export interface GatewayStats {
  receivedTotal: number;
  dedupSkipped: number;
  recalled: number;
  sentConfirmed: number;
  sentFailed: number;
  sentUnknown: number;
  backfilled: number;
  lastEventAt?: string;
}

export class Gateway {
  private db: Database;
  private provider: Provider;
  private accountId: string;
  private subscribers: ((ev: GatewayEvent) => void)[] = [];
  private queueRunning = false;
  private perTargetChains = new Map<string, Promise<void>>();
  private stats: GatewayStats = {
    receivedTotal: 0,
    dedupSkipped: 0,
    recalled: 0,
    sentConfirmed: 0,
    sentFailed: 0,
    sentUnknown: 0,
    backfilled: 0,
  };
  private backfillEnabled: boolean;
  private backfillMaxPages: number;
  private backfillPageLimit: number;
  private stopped = false;

  constructor(db: Database, provider: Provider, opts: { accountId: string; backfillMaxPages: number; backfillPageLimit: number }) {
    this.db = db;
    this.provider = provider;
    this.accountId = opts.accountId;
    this.backfillEnabled = opts.backfillMaxPages > 0;
    this.backfillMaxPages = opts.backfillMaxPages;
    this.backfillPageLimit = opts.backfillPageLimit;
  }

  start(): void {
    // 启动恢复：文件、报告、主动消息与反戳标 unknown，避免结果不明时重复投递。
    const r = this.db.resetInFlightTasks();
    if (r.requeued || r.unknowned) log.info(`启动恢复: 重新排队 ${r.requeued} 个任务，${r.unknowned} 个标记为结果不明`);

    this.provider.onEvent((ev) => {
      try {
        this.handleEvent(ev);
      } catch (e) {
        log.error("事件处理异常", e);
      }
    });
    this.provider.start();
    void this.runSendQueue();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.provider.stop();
  }

  onEvent(cb: (ev: GatewayEvent) => void): void {
    this.subscribers.push(cb);
  }

  getProvider(): Provider {
    return this.provider;
  }

  getStats(): GatewayStats {
    return { ...this.stats };
  }

  private dispatch(ev: GatewayEvent): void {
    for (const cb of this.subscribers) {
      try {
        cb(ev);
      } catch (e) {
        log.error("订阅者异常", e);
      }
    }
  }

  // ---------- 接收侧 ----------

  private handleEvent(ev: GatewayEvent): void {
    switch (ev.kind) {
      case "message":
        this.handleMessage(ev.message);
        break;
      case "recall":
        this.handleRecall(ev);
        break;
      case "poke":
        this.handlePoke(ev);
        break;
      case "connection":
        if (ev.state === "connected") {
          this.db.markDowntimeEnd(this.accountId);
          // 重连后补取（有锚点且能力支持时）
          void this.backfillAfterReconnect();
        } else if (ev.state === "disconnected") {
          this.db.markDowntimeStart(this.accountId, ev.detail ?? "connection lost");
        }
        this.dispatch(ev);
        break;
      case "login":
        this.dispatch(ev);
        break;
    }
  }

  private handleMessage(m: MessageRecord): void {
    this.stats.receivedTotal++;
    this.stats.lastEventAt = m.receivedAt;
    this.accountId = m.accountId;

    if (!this.shouldStoreMessage(m)) return;

    // 收到后先持久化（含去重）
    const r = this.db.insertMessage(m);
    if (!r.inserted) {
      this.stats.dedupSkipped++;
      log.debug(`重复事件，跳过派发: ${m.eventKey}`);
      return;
    }

    // 自己发的消息不入 Agent 流程（保留在日志里）
    this.dispatch({ kind: "message", message: m });
  }

  private handleRecall(ev: Extract<GatewayEvent, { kind: "recall" }>): void {
    const changed = this.db.markRecalled(ev.conversationId, ev.messageId, ev.accountId);
    if (changed) {
      this.stats.recalled++;
      this.dispatch(ev);
    }
  }

  private handlePoke(ev: PokeEvent): void {
    const selfId = this.provider.health().selfId;
    const sentAt = Date.parse(ev.sentAt);
    const receivedAt = Date.parse(ev.receivedAt);
    const now = Date.now();
    // An outgoing poke's notice is feedback, never another summon. Events
    // between other members also never enter the agent's reply channel.
    if (ev.accountId !== this.accountId || ev.providerId !== this.provider.providerId || ev.origin !== "live"
      || !selfId || ev.targetId !== selfId || ev.userId === selfId
      || !/^[1-9]\d*$/.test(ev.userId) || !/^[1-9]\d*$/.test(ev.targetId)
      || (ev.groupId !== undefined && !/^[1-9]\d*$/.test(ev.groupId))
      || ev.conversationId !== (ev.groupId ? `group_${ev.groupId}` : `private_${ev.userId}`)
      || !ev.eventKey || !Number.isFinite(sentAt) || !Number.isFinite(receivedAt)
      || sentAt < now - 120_000 || sentAt > now + 300_000 || receivedAt < now - 120_000 || receivedAt > now + 300_000
      || this.db.isUserBlocked(ev.accountId, ev.userId)) return;
    const resetAt = this.db.kvGet("memory_reset_at");
    if (resetAt && ev.sentAt <= resetAt) return;
    this.stats.receivedTotal++;
    this.stats.lastEventAt = ev.receivedAt;
    if (!this.db.registerPokeEvent(ev)) {
      this.stats.dedupSkipped++;
      return;
    }
    this.dispatch(ev);
  }

  private shouldStoreMessage(m: MessageRecord): boolean {
    if (this.db.isUserBlocked(m.accountId, m.senderId)) return false;
    const resetAt = this.db.kvGet("memory_reset_at");
    return !resetAt || m.sentAt > resetAt;
  }

  // ---------- 发送侧 ----------

  /** 排队发送（幂等：taskKey 相同不会重复入队） */
  enqueueSend(t: {
    taskKey?: string;
    kind: string;
    conversationType: "group" | "private";
    targetId: string;
    payload: SendPayload;
  }): { id: number; reused: boolean } {
    if (t.payload.kind === "poke") t = { ...t, taskKey: `poke:${t.payload.sourceEventKey}` };
    return this.db.enqueueSendTask({ ...t, payload: t.payload });
  }

  private async runSendQueue(): Promise<void> {
    this.queueRunning = true;
    const dispatched = new Set<number>();
    while (!this.stopped) {
      try {
        const tasks = this.db.pendingSendTasks(20);
        if (tasks.length === 0) {
          await sleep(500);
          continue;
        }
        for (const t of tasks) {
          if (dispatched.has(t.id)) continue; // 已在链上等待执行，不重复调度
          dispatched.add(t.id);
          const target = `${t.conversation_type}:${t.target_id}`;
          // 同一目标串行，不同目标并行
          const prev = this.perTargetChains.get(target) ?? Promise.resolve();
          const next = prev
            .then(() => {
              dispatched.delete(t.id);
              return this.executeSendTask(t.id);
            })
            .catch((e) => log.error("发送任务异常", e));
          this.perTargetChains.set(target, next);
          next.finally(() => {
            if (this.perTargetChains.get(target) === next) this.perTargetChains.delete(target);
          });
        }
        // 让出事件循环，链上的任务才能真正执行
        await sleep(200);
      } catch (e) {
        log.error("发送队列异常", e);
        await sleep(2000);
      }
    }
    this.queueRunning = false;
  }

  private async executeSendTask(taskId: number): Promise<void> {
    const t = this.db.claimSendTask(taskId);
    if (!t) return; // 已被并发取走
    let payload: SendPayload;
    try {
      const parsed = JSON.parse(t.payload) as SendPayload | null;
      if (!parsed || typeof parsed !== "object" || !["segments", "file", "poke"].includes(parsed.kind)) {
        throw new Error("发送载荷格式错误");
      }
      if (parsed.kind === "file" && (
        typeof parsed.filePath !== "string" || !parsed.filePath.trim() || /[\x00-\x1f]/.test(parsed.filePath)
        || typeof parsed.fileName !== "string" || !parsed.fileName.trim() || /[\\/\x00-\x1f]/.test(parsed.fileName)
        || parsed.fileName === "." || parsed.fileName === ".."
      )) throw new Error("文件路径或文件名无效");
      if (parsed.kind === "segments" && !Array.isArray(parsed.segments)) throw new Error("发送消息段格式错误");
      if (parsed.kind === "poke") {
        const source = this.db.pokeEventByKey(parsed.accountId, parsed.sourceEventKey);
        const selfId = this.provider.health().selfId;
        const expiresAt = Date.parse(parsed.expiresAt);
        if (typeof parsed.userId !== "string" || !/^[1-9]\d*$/.test(parsed.userId)
          || parsed.requesterId !== parsed.userId || parsed.accountId !== this.accountId
          || !Number.isFinite(expiresAt) || !source || source.targetId !== selfId || source.userId === selfId
          || source.userId !== parsed.userId || source.accountId !== parsed.accountId
          || source.conversationId !== `${t.conversation_type}_${t.target_id}`
          || source.providerId !== this.provider.providerId || source.origin !== "live"
          || expiresAt > Date.parse(source.receivedAt) + 120_000
          || Date.parse(source.receivedAt) < Date.now() - 120_000) {
          throw new Error("反戳必须绑定当前账号收到的真实戳一戳来源和发送者");
        }
      }
      payload = parsed;
    } catch (e) {
      this.db.finishSendTask(taskId, "failed", (e as Error).message);
      this.stats.sentFailed++;
      return;
    }
    if ((payload.kind === "segments" || payload.kind === "poke") && payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now()) {
      this.db.finishSendTask(taskId, "failed", "消息已过时，取消投递");
      log.info(`发送任务 #${taskId} 已过时，取消投递`);
      return;
    }
    this.db.bumpSendTaskAttempt(taskId);
    if ((payload.kind === "segments" || payload.kind === "poke") && payload.requesterId && this.db.isUserBlocked(payload.accountId ?? this.accountId, payload.requesterId)) {
      this.db.finishSendTask(taskId, "failed", "发送者已被静默屏蔽，取消待发回复");
      return;
    }
    let result: SendResult;
    try {
      if (payload.kind === "poke") {
        result = this.provider.sendPoke
          ? await this.provider.sendPoke(payload.userId, t.conversation_type === "group" ? t.target_id : undefined)
          : { status: "failed", error: "当前 Provider 未实现 sendPoke" };
      } else if (t.conversation_type === "group") {
        if (payload.kind === "file") {
          result = this.provider.sendGroupFile
            ? await this.provider.sendGroupFile(t.target_id, payload.filePath, payload.fileName)
            : { status: "failed", error: "当前 Provider 未实现 sendGroupFile" };
        } else {
          result = await this.provider.sendGroupMsg(t.target_id, payload.segments);
        }
      } else {
        if (payload.kind === "file") {
          if (!this.provider.sendPrivateFile) {
            result = { status: "failed", error: "当前 Provider 未实现 sendPrivateFile" };
          } else {
            result = await this.provider.sendPrivateFile(t.target_id, payload.filePath, payload.fileName);
          }
        } else {
          result = await this.provider.sendPrivateMsg(t.target_id, payload.segments);
        }
      }
    } catch (e) {
      result = { status: "unknown", error: (e as Error).message };
    }
    this.db.finishSendTask(taskId, result.status, result.error, result.messageId);
    // 已确认发送的文本消息回写消息库：下一轮对话的上下文里要能看到"自己说过什么"
    if (result.status === "confirmed" && result.messageId && payload.kind === "segments") {
      this.recordOutgoingMessage(t, payload.segments, result.messageId);
    }
    if (result.status === "confirmed") this.stats.sentConfirmed++;
    else if (result.status === "failed") this.stats.sentFailed++;
    else this.stats.sentUnknown++;
    if (result.status === "confirmed") {
      log.info(`发送任务 #${taskId} (${t.kind} → ${t.conversation_type}:${t.target_id}) = confirmed`);
    } else {
      log.warn(result.status === "unknown" ? "投递回执不明" : "投递失败", result.error ?? "", {
        accountId: this.accountId,
        conversationId: t.conversation_type === "group" ? `group_${t.target_id}` : `private_${t.target_id}`,
        status: result.status,
        operation: t.kind === "document_file" ? "send_file" : "send_message",
      });
    }
  }

  private recordOutgoingMessage(t: { conversation_type: "group" | "private"; target_id: string; kind: string }, segments: MessageSegment[], messageId: string): void {
    try {
      const groupId = t.conversation_type === "group" ? t.target_id : undefined;
      const conversationId = groupId ? `group_${groupId}` : `private_${t.target_id}`;
      const selfId = this.provider.health().selfId ?? "self";
      this.db.insertMessage({
        eventKey: `${this.accountId}:${conversationId}:message:${messageId}`,
        accountId: this.accountId,
        providerId: this.provider.providerId,
        conversationId,
        groupId,
        messageId,
        senderId: selfId,
        displayNameAtTime: "（你自己）",
        sentAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        segments,
        textContent: segmentsText(segments),
        status: "active",
        origin: "live",
      });
    } catch (e) {
      log.debug("回写已发送消息失败（不影响发送）:", (e as Error).message);
    }
  }

  // ---------- 重连补取 ----------

  private async backfillAfterReconnect(): Promise<void> {
    if (!this.backfillEnabled) return;
    const provider = this.provider;
    if (!provider.getGroupMsgHistory || !provider.capabilities) return;
    // 只对记录过锚点的群补取
    for (const g of this.enabledGroupsWithAnchor()) {
      try {
        await this.backfillGroup(g);
      } catch (e) {
        log.warn(`补取群 ${g} 失败:`, (e as Error).message);
      }
    }
  }

  private enabledGroupsWithAnchor(): string[] {
    const out: string[] = [];
    const raw = this.db.kvGet("backfill_anchors");
    if (raw) {
      try {
        const obj = JSON.parse(raw) as Record<string, string>;
        for (const [k, v] of Object.entries(obj)) if (k.startsWith("group_") && v) out.push(k.slice("group_".length));
      } catch { /* ignore */ }
    }
    return out;
  }

  updateAnchor(groupId: string, messageId: string): void {
    const raw = this.db.kvGet("backfill_anchors");
    const obj: Record<string, string> = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    obj[`group_${groupId}`] = messageId;
    this.db.kvSet("backfill_anchors", JSON.stringify(obj));
  }

  private async backfillGroup(groupId: string): Promise<void> {
    const raw = this.db.kvGet("backfill_anchors");
    const anchors: Record<string, string> = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    const anchor = anchors[`group_${groupId}`];
    if (!anchor) return;
    const provider = this.provider;
    if (!provider.getGroupMsgHistory) return;

    let cursor: string | undefined = anchor;
    let pages = 0;
    let inserted = 0;
    while (pages < this.backfillMaxPages) {
      const page = await provider.getGroupMsgHistory(groupId, cursor, this.backfillPageLimit);
      if (!page.ok) {
        log.debug(`群 ${groupId} 历史补取不可用: ${page.error}`);
        return;
      }
      if (page.messages.length === 0) break;
      for (const m of page.messages) {
        const record = this.normalizeBackfill(m);
        if (!this.shouldStoreMessage(record)) continue;
        const r = this.db.insertMessage(record);
        if (r.inserted) inserted++;
      }
      // 从新到旧翻页：取最早一条作为下一页锚点
      const oldest = page.messages[page.messages.length - 1];
      if (!oldest || oldest.messageId === cursor) break;
      cursor = oldest.messageId;
      pages++;
      if (inserted === 0 && pages > 1) break; // 已追上
    }
    if (inserted > 0) {
      this.stats.backfilled += inserted;
      log.info(`群 ${groupId} 补取 ${inserted} 条历史消息（${pages} 页）`);
    }
  }

  private normalizeBackfill(m: {
    accountId: string;
    providerId: string;
    messageId: string;
    groupId?: string;
    senderId: string;
    senderName: string;
    sentAt: Date;
    replyToMessageId?: string;
    segments: MessageSegment[];
  }): MessageRecord {
    const groupId = m.groupId;
    return {
      eventKey: `${m.accountId}:${groupId ? `group_${groupId}` : "private"}:message:${m.messageId}`,
      accountId: m.accountId,
      providerId: m.providerId,
      conversationId: groupId ? `group_${groupId}` : `private_${m.senderId}`,
      groupId,
      messageId: m.messageId,
      senderId: m.senderId,
      displayNameAtTime: m.senderName,
      sentAt: m.sentAt.toISOString(),
      receivedAt: new Date().toISOString(),
      replyToMessageId: m.replyToMessageId,
      segments: m.segments,
      textContent: segmentsText(m.segments),
      status: "active",
      origin: "backfill",
    };
  }
}

export function rowToMessageRecord(db: Database, r: DBRow_Message): MessageRecord {
  return db.rowToRecord(r);
}
