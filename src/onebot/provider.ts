import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type {
  CapabilityMap,
  CapabilityState,
  GatewayEvent,
  MessageSegment,
  NormalizedIncomingMessage,
  Provider,
  ProviderHealth,
  SendResult,
} from "../types.js";
import { logger } from "../util/logger.js";
import { backoffDelay, sleep } from "../util/misc.js";

export interface OneBotOptions {
  accountId: string;
  endpoint: string;
  accessToken: string;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  heartbeatTimeoutFactor: number;
  requestTimeoutMs: number;
  privateFileAction: string;
  groupFileAction?: string;
  historyAction: string;
}

interface OBMessageEvent {
  post_type: "message";
  message_type: "private" | "group";
  sub_type?: string;
  message_id: number | string;
  user_id: number | string;
  group_id?: number | string;
  sender: { user_id?: number | string; nickname?: string; card?: string };
  time: number;
  message: Array<{ type: string; data: Record<string, unknown> }> | string;
  raw_message?: string;
}

interface OBNoticeEvent {
  post_type: "notice";
  notice_type: string;
  group_id?: number | string;
  user_id?: number | string;
  sender_id?: number | string;
  target_id?: number | string;
  self_id?: number | string;
  event_id?: number | string;
  id?: number | string;
  operator_id?: number | string;
  message_id?: number | string;
  time: number;
  sub_type?: string;
  file?: { id?: string; file_id?: string; name?: string; size?: number; busid?: number; bus_id?: number };
}

interface OBMetaEvent {
  post_type: "meta_event";
  meta_event_type: "heartbeat" | "lifecycle";
  time: number;
  interval?: number;
  self_id?: number | string;
}

type OBEvent = OBMessageEvent | OBNoticeEvent | OBMetaEvent;

interface OBActionResp {
  status: string | "failed" | "async";
  retcode: number;
  data: unknown;
  echo?: string;
  wording?: string;
  message?: string;
}

/** 请求未提交给协议端，可以确定没有发生投递。 */
class NotSubmittedError extends Error {}

const log = logger("onebot");

function seg(type: string, data: Record<string, unknown>): MessageSegment {
  switch (type) {
    case "text":
      return { type: "text", data: { text: String(data.text ?? "") } };
    case "image":
      return { type: "image", data: { url: data.url as string | undefined, file: data.file as string | undefined } };
    case "at":
      return { type: "at", data: { qq: String(data.qq ?? "") } };
    case "reply":
      return { type: "reply", data: { id: String(data.id ?? "") } };
    case "face":
      return { type: "face", data: { id: String(data.id ?? "") } };
    case "record":
      return { type: "record", data: { url: data.url as string | undefined, file: data.file as string | undefined } };
    case "video":
      return { type: "video", data: { url: data.url as string | undefined, file: data.file as string | undefined } };
    case "file": {
      const size = Number(data.file_size ?? data.size);
      const busId = Number(data.busid ?? data.bus_id);
      return { type: "file", data: {
        fileId: String(data.file_id ?? data.id ?? data.file ?? ""),
        name: String(data.name ?? data.file_name ?? "附件"),
        size: Number.isSafeInteger(size) && size >= 0 ? size : undefined,
        busId: Number.isSafeInteger(busId) && busId >= 0 ? busId : undefined,
      } };
    }
    case "json":
      return { type: "json", data: { data: String(data.data ?? "") } };
    case "forward":
      return { type: "forward", data: { id: String(data.id ?? "") } };
    case "share":
      return {
        type: "share",
        data: {
          url: data.url as string | undefined,
          title: data.title as string | undefined,
          content: data.content as string | undefined,
        },
      };
    default:
      return { type: "unknown", data };
  }
}

export function segmentsText(segments: MessageSegment[]): string {
  const parts: string[] = [];
  for (const s of segments) {
    if (s.type === "text") parts.push(s.data.text);
    else if (s.type === "json" || s.type === "share") {
      const raw = s.type === "json" ? s.data.data : JSON.stringify(s.data);
      try {
        const j = JSON.parse(raw) as Record<string, unknown>;
        const meta = (j.meta as Record<string, Record<string, { url?: string; title?: string; desc?: string }>> | undefined) ?? {};
        const news = meta.news ?? meta.detail_1 ?? {};
        if (news.url) parts.push(String(news.url));
        if (news.title) parts.push(String(news.title));
        if (news.desc) parts.push(String(news.desc));
      } catch {
        parts.push(raw);
      }
    } else if (s.type === "image") parts.push("[图片]");
    else if (s.type === "record") parts.push("[语音]");
    else if (s.type === "video") parts.push("[视频]");
    else if (s.type === "file") parts.push(`[文件: ${s.data.name}]`);
    else if (s.type === "forward") parts.push("[合并转发]");
    else if (s.type === "face") parts.push("[表情]");
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export class OneBotProvider implements Provider {
  readonly providerId = "onebot";
  private opts: OneBotOptions;
  private ws: WebSocket | null = null;
  private eventCbs: ((ev: GatewayEvent) => void)[] = [];
  private pending = new Map<string, { resolve: (r: OBActionResp) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private echoCounter = 0;
  private heartbeatIntervalMs = 0;
  private lastHeartbeatAt = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private everConnected = false;
  private stopping = false;
  private selfId: string | undefined;
  private healthState: ProviderHealth = { connection: "disconnected", login: "unknown", reconnectCount: 0 };
  private caps: CapabilityMap = {
    receiveMessages: "unverified",
    sendText: "unverified",
    sendImage: "unverified",
    sendPrivateFile: "unverified",
    sendGroupFile: "unverified",
    sendPoke: "unverified",
    groupHistory: "unverified",
  };

  constructor(opts: OneBotOptions) {
    this.opts = opts;
  }

  onEvent(cb: (ev: GatewayEvent) => void): void {
    this.eventCbs.push(cb);
  }

  private emit(ev: GatewayEvent): void {
    for (const cb of this.eventCbs) {
      try {
        cb(ev);
      } catch (e) {
        log.error("事件回调异常", e);
      }
    }
  }

  start(): void {
    this.stopping = false;
    void this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearHeartbeatWatch();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("provider stopping"));
    }
    this.pending.clear();
    await new Promise<void>((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return resolve();
      const ws = this.ws;
      const onClose = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        ws.off("close", onClose);
        resolve();
      }, 3000);
      ws.once("close", onClose);
      ws.close(1000, "bot stopping");
    });
    this.ws = null;
  }

  health(): ProviderHealth {
    return { ...this.healthState, selfId: this.selfId };
  }

  capabilities(): CapabilityMap {
    return { ...this.caps };
  }

  // ---------- 连接管理 ----------

  private async connectLoop(): Promise<void> {
    while (!this.stopping) {
      const attempt = this.reconnectAttempt + 1;
      try {
        // connectOnce 在连接打开期间保持等待，断开后才返回/抛错
        await this.connectOnce();
      } catch (e) {
        log.warn("连接失败:", (e as Error).message);
        this.healthState.lastError = (e as Error).message;
      }
      if (this.stopping) break;
      const delay = backoffDelay(attempt, this.opts.reconnectBaseMs, this.opts.reconnectMaxMs);
      this.healthState.connection = "connecting";
      this.emit({ kind: "connection", state: "reconnecting", at: new Date().toISOString(), detail: `第 ${attempt} 次重连，${delay}ms 后` });
      log.info(`${delay}ms 后第 ${attempt} 次重连`);
      await sleep(delay);
      this.reconnectAttempt = Math.min(attempt, 1000);
    }
  }

  /** 成功打开后保持挂起直到连接关闭（resolve）或初始连接失败（reject）。 */
  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      log.info(`连接 ${this.opts.endpoint}`);
      const headers: Record<string, string> = {};
      if (this.opts.accessToken) headers.Authorization = `Bearer ${this.opts.accessToken}`;
      const ws = new WebSocket(this.opts.endpoint, { headers });
      this.ws = ws;
      let opened = false;
      let settled = false;

      const failTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.terminate(); } catch { /* ignore */ }
          reject(new Error("连接超时"));
        }
      }, 10_000);

      ws.on("open", () => {
        clearTimeout(failTimer);
        opened = true;
        this.reconnectAttempt = 0;
        this.healthState.connection = "connected";
        if (this.everConnected) this.healthState.reconnectCount++;
        this.everConnected = true;
        log.info("WebSocket 已连接");
        this.emit({ kind: "connection", state: "connected", at: new Date().toISOString() });
        this.armHeartbeatWatch();
        void this.probeLogin();
      });

      ws.on("message", (data) => {
        try {
          this.handleRawMessage(String(data));
        } catch (e) {
          log.error("处理消息异常", e);
        }
      });

      ws.on("error", (err) => {
        log.warn("WebSocket 错误:", err.message);
        this.healthState.lastError = err.message;
        if (!settled) {
          settled = true;
          clearTimeout(failTimer);
          reject(err);
        }
      });

      ws.on("close", (code, reason) => {
        clearTimeout(failTimer);
        this.clearHeartbeatWatch();
        this.healthState.connection = "disconnected";
        this.healthState.login = "unknown";
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error(`连接断开(${code})`));
        }
        this.pending.clear();
        if (opened) {
          this.emit({ kind: "connection", state: "disconnected", at: new Date().toISOString(), detail: `code=${code} ${reason}` });
        }
        if (!settled) {
          settled = true;
          if (opened) resolve(); // 正常断开 → 由 connectLoop 安排重连
          else reject(new Error(`连接关闭 code=${code}`));
        }
      });
    });
  }

  private armHeartbeatWatch(): void {
    this.clearHeartbeatWatch();
    const check = () => {
      if (this.stopping || !this.heartbeatIntervalMs) return;
      const timeout = this.heartbeatIntervalMs * this.opts.heartbeatTimeoutFactor + 5000;
      if (Date.now() - this.lastHeartbeatAt > timeout) {
        log.warn(`心跳超时（>${Math.round(timeout / 1000)}s），判定断开`);
        try { this.ws?.terminate(); } catch { /* ignore */ }
      }
    };
    this.heartbeatTimer = setInterval(check, 10_000);
  }

  private clearHeartbeatWatch(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async probeLogin(): Promise<void> {
    try {
      const resp = await this.call("get_login_info", {}, 10_000);
      const data = resp.data as { user_id?: number | string; nickname?: string } | null;
      if (resp.retcode === 0 && data?.user_id != null) {
        this.selfId = String(data.user_id);
        this.healthState.login = "online";
        this.healthState.selfId = this.selfId;
        this.caps.receiveMessages = "supported";
        this.caps.sendText = "supported";
        log.info(`QQ 已登录: ${this.selfId} (${data.nickname ?? "?"})`);
        this.emit({ kind: "login", state: "online", at: new Date().toISOString(), detail: String(data.nickname ?? "") });
      } else {
        this.healthState.login = "offline";
        this.emit({ kind: "login", state: "offline", at: new Date().toISOString(), detail: resp.wording ?? `retcode=${resp.retcode}` });
      }
    } catch (e) {
      this.healthState.login = "unknown";
      this.healthState.lastError = (e as Error).message;
      log.warn("登录状态探测失败:", (e as Error).message);
    }
  }

  // ---------- 消息解析 ----------

  private handleRawMessage(raw: string): void {
    let msg: (OBActionResp & { post_type?: string }) | OBEvent;
    try {
      msg = JSON.parse(raw);
    } catch {
      log.debug("无法解析的帧:", raw.slice(0, 200));
      return;
    }

    if ("echo" in msg && msg.echo && "retcode" in msg) {
      const p = this.pending.get(msg.echo);
      if (p) {
        this.pending.delete(msg.echo);
        clearTimeout(p.timer);
        p.resolve(msg as OBActionResp);
      }
      return;
    }

    if (!("post_type" in msg)) return;

    if (msg.post_type === "meta_event") {
      const meta = msg as OBMetaEvent;
      if (meta.meta_event_type === "heartbeat") {
        this.lastHeartbeatAt = Date.now();
        this.healthState.lastHeartbeatAt = new Date().toISOString();
        if (!this.heartbeatIntervalMs && meta.interval) {
          this.heartbeatIntervalMs = meta.interval;
          this.armHeartbeatWatch();
        }
        if (meta.self_id && !this.selfId) this.selfId = String(meta.self_id);
      } else if (meta.meta_event_type === "lifecycle") {
        if (meta.self_id) this.selfId = String(meta.self_id);
      }
      return;
    }

    if (msg.post_type === "message") {
      const ev = msg as OBMessageEvent;
      const normalized = this.normalizeMessage(ev);
      if (normalized) this.emit({ kind: "message", message: normalized.record });
      return;
    }

    if (msg.post_type === "notice") {
      const notice = msg as OBNoticeEvent;
      if (notice.notice_type === "group_upload" && notice.group_id != null && notice.user_id != null && notice.file) {
        const fileId = String(notice.file.id ?? notice.file.file_id ?? "");
        if (!fileId || !/^[1-9]\d*$/.test(String(notice.user_id)) || !/^[1-9]\d*$/.test(String(notice.group_id))) return;
        const normalized = this.normalizeMessage({
          post_type: "message", message_type: "group", group_id: notice.group_id,
          message_id: notice.message_id ?? `upload:${fileId}`, user_id: notice.user_id,
          sender: { user_id: notice.user_id }, time: notice.time,
          message: [{ type: "file", data: { file_id: fileId, name: notice.file.name, size: notice.file.size,
            busid: notice.file.busid ?? notice.file.bus_id } }],
        });
        if (normalized) this.emit({ kind: "message", message: normalized.record });
      } else if (notice.notice_type === "notify" && notice.sub_type === "poke") {
        this.normalizePoke(notice);
      } else if (notice.notice_type === "group_recall" && notice.message_id != null && notice.group_id != null) {
        this.emit({
          kind: "recall",
          accountId: this.opts.accountId,
          conversationId: `group_${notice.group_id}`,
          groupId: String(notice.group_id),
          messageId: String(notice.message_id),
          operatorId: notice.operator_id != null ? String(notice.operator_id) : undefined,
          recalledAt: new Date((notice.time ?? Date.now() / 1000) * 1000).toISOString(),
        });
      } else if (notice.notice_type === "friend_recall" && notice.message_id != null && notice.user_id != null) {
        this.emit({
          kind: "recall",
          accountId: this.opts.accountId,
          conversationId: `private_${notice.user_id}`,
          messageId: String(notice.message_id),
          recalledAt: new Date((notice.time ?? Date.now() / 1000) * 1000).toISOString(),
        });
      }
    }
  }

  private normalizePoke(notice: OBNoticeEvent): void {
    const userId = String(notice.sender_id ?? notice.user_id ?? "");
    const targetId = String(notice.target_id ?? "");
    const groupId = notice.group_id != null ? String(notice.group_id) : undefined;
    if (!/^[1-9]\d*$/.test(userId) || !/^[1-9]\d*$/.test(targetId)
      || (groupId !== undefined && !/^[1-9]\d*$/.test(groupId))) return;
    const sentAt = new Date(notice.time * 1000);
    if (!Number.isFinite(sentAt.getTime())) return;
    if (notice.self_id != null) {
      const noticeSelfId = String(notice.self_id);
      if (!/^[1-9]\d*$/.test(noticeSelfId) || (this.selfId && this.selfId !== noticeSelfId)) return;
      this.selfId ??= noticeSelfId;
    }
    const conversationId = groupId ? `group_${groupId}` : `private_${userId}`;
    const eventId = notice.event_id ?? notice.id ?? notice.message_id;
    // SnowLuma emits no poke ID. Separate frames can be genuine consecutive
    // pokes in the same second, so a timestamp-based key would lose a summon.
    const identity = eventId == null ? `frame:${randomUUID()}` : `id:${String(eventId)}`;
    this.emit({
      kind: "poke", eventKey: `${this.opts.accountId}:${conversationId}:poke:${identity}`,
      accountId: this.opts.accountId, providerId: this.providerId, conversationId, groupId,
      userId, targetId, sentAt: sentAt.toISOString(), receivedAt: new Date().toISOString(), origin: "live",
    });
  }

  private normalizeMessage(ev: OBMessageEvent): { record: import("../types.js").MessageRecord } | null {
    const segments: MessageSegment[] = Array.isArray(ev.message)
      ? ev.message.map((s) => seg(s.type, s.data ?? {}))
      : [{ type: "text", data: { text: String(ev.message) } }];

    const groupId = ev.group_id != null ? String(ev.group_id) : undefined;
    const senderId = String(ev.sender?.user_id ?? ev.user_id ?? "");
    if (!senderId) return null;
    const sentAt = new Date((ev.time ?? Date.now() / 1000) * 1000);
    const replySeg = segments.find((s) => s.type === "reply");

    const record: import("../types.js").MessageRecord = {
      eventKey: this.eventKey(groupId, String(ev.message_id)),
      accountId: this.opts.accountId,
      providerId: this.providerId,
      conversationId: groupId ? `group_${groupId}` : `private_${senderId}`,
      groupId,
      messageId: String(ev.message_id),
      senderId,
      displayNameAtTime: String(ev.sender?.card || ev.sender?.nickname || senderId),
      sentAt: sentAt.toISOString(),
      receivedAt: new Date().toISOString(),
      replyToMessageId: replySeg?.type === "reply" ? replySeg.data.id : undefined,
      segments,
      textContent: segmentsText(segments),
      status: "active",
      origin: "live",
    };
    return { record };
  }

  private eventKey(groupId: string | undefined, messageId: string): string {
    return `${this.opts.accountId}:${groupId ? `group_${groupId}` : "private"}:message:${messageId}`;
  }

  // ---------- 动作调用 ----------

  private call(action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<OBActionResp> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return reject(new NotSubmittedError("未连接，请求未提交"));
      }
      const echo = `e${++this.echoCounter}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`动作 ${action} 超时(${timeoutMs ?? this.opts.requestTimeoutMs}ms)`));
      }, timeoutMs ?? this.opts.requestTimeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(new NotSubmittedError((e as Error).message));
      }
    });
  }

  private classifySend(resp: OBActionResp): SendResult {
    // async 表示仅提交成功；即使某些协议端同时给 retcode=0，也不能当作投递确认。
    if (resp.retcode === 1200 || resp.status === "async") {
      return { status: "unknown", error: "已提交异步发送，结果未知" };
    }
    if (resp.retcode === 0 && resp.status !== "failed") {
      const data = resp.data as { message_id?: number | string } | null;
      return { status: "confirmed", messageId: data?.message_id != null ? String(data.message_id) : undefined };
    }
    return { status: "failed", error: resp.wording || resp.message || `retcode=${resp.retcode}` };
  }

  async sendPrivateMsg(userId: string, segments: MessageSegment[]): Promise<SendResult> {
    try {
      const resp = await this.call("send_private_msg", { user_id: userId, message: segments });
      return this.classifySend(resp);
    } catch (e) {
      return { status: "unknown", error: (e as Error).message };
    }
  }

  async sendGroupMsg(groupId: string, segments: MessageSegment[]): Promise<SendResult> {
    try {
      const resp = await this.call("send_group_msg", { group_id: groupId, message: segments });
      return this.classifySend(resp);
    } catch (e) {
      return { status: "unknown", error: (e as Error).message };
    }
  }

  async sendPrivateFile(userId: string, filePath: string, fileName: string): Promise<SendResult> {
    return this.sendFile("sendPrivateFile", this.opts.privateFileAction, "user_id", userId, filePath, fileName);
  }

  async sendGroupFile(groupId: string, filePath: string, fileName: string): Promise<SendResult> {
    return this.sendFile("sendGroupFile", this.opts.groupFileAction ?? "upload_group_file", "group_id", groupId, filePath, fileName);
  }

  async resolveIncomingFile(file: { fileId: string; groupId?: string; userId?: string; busId?: number }): Promise<
    { ok: true; url: string } | { ok: false; error: string }
  > {
    if (!file.fileId || file.fileId.length > 1024 || /[\x00-\x20]/.test(file.fileId)
      || /^(?:file|https?|data):/i.test(file.fileId) || /[\\]/.test(file.fileId)
      || (file.groupId && !/^[1-9]\d*$/.test(file.groupId))
      || (!file.groupId && (!file.userId || !/^[1-9]\d*$/.test(file.userId)))) {
      return { ok: false, error: "文件标识无效" };
    }
    const actions = file.groupId
      ? [{ action: "get_group_file_url", params: { group_id: file.groupId, file_id: file.fileId, busid: file.busId ?? 0 } },
        { action: "get_file", params: { file_id: file.fileId } }]
      : [{ action: "get_private_file_url", params: { file_id: file.fileId, user_id: file.userId } },
        { action: "get_file", params: { file_id: file.fileId } }];
    for (const { action, params } of actions) {
      try {
        const response = await this.call(action, params);
        if (response.retcode !== 0 || response.status === "failed") continue;
        const data = response.data as { url?: unknown; file?: unknown; file_url?: unknown } | null;
        // Some bridges use `file` for a download URL, others use it for a local path.
        const url = data?.url ?? data?.file_url ?? data?.file;
        if (typeof url !== "string" || url.length > 4096) continue;
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) continue;
        return { ok: true, url: parsed.toString() };
      } catch { /* Try the documented bridge compatibility action, never local disk. */ }
    }
    return { ok: false, error: "协议端未返回可用的文件下载地址；不读取服务器本地路径" };
  }

  async sendPoke(userId: string, groupId?: string): Promise<SendResult> {
    if (!/^[1-9]\d*$/.test(userId) || (groupId !== undefined && !/^[1-9]\d*$/.test(groupId))) {
      return { status: "failed", error: "戳一戳目标必须是有效的 QQ 号码" };
    }
    try {
      // SnowLuma 1.14.22 supports this action for both group and friend pokes.
      const resp = await this.call("send_poke", { user_id: userId, ...(groupId ? { group_id: groupId } : {}) });
      const result = this.classifySend(resp);
      if (result.status === "confirmed") this.caps.sendPoke = "supported";
      else if (result.status === "failed" && (
        resp.retcode === 1404 || resp.retcode === -32601
        || /unknown action|unsupported (?:action|api)|(?:action|api).*not (?:found|supported)|不支持(?:的)?(?:动作|接口)|(?:动作|接口)不存在/i.test(result.error ?? "")
      )) this.caps.sendPoke = "unsupported";
      return result;
    } catch (e) {
      return { status: e instanceof NotSubmittedError ? "failed" : "unknown", error: (e as Error).message };
    }
  }

  private async sendFile(
    capability: "sendPrivateFile" | "sendGroupFile",
    action: string,
    targetParam: "user_id" | "group_id",
    targetId: string,
    filePath: string,
    fileName: string,
  ): Promise<SendResult> {
    if (typeof targetId !== "string" || !/^[1-9]\d*$/.test(targetId)) {
      return { status: "failed", error: `${targetParam} 必须是有效的 QQ 号码` };
    }
    if (typeof action !== "string" || !action.trim()) return { status: "failed", error: "文件上传动作未配置" };
    if (typeof filePath !== "string" || !filePath.trim() || /[\x00-\x1f]/.test(filePath)) {
      return { status: "failed", error: "文件路径无效" };
    }
    if (typeof fileName !== "string" || !fileName.trim() || /[\\/\x00-\x1f]/.test(fileName) || fileName === "." || fileName === "..") {
      return { status: "failed", error: "文件名无效" };
    }
    try {
      const resp = await this.call(action, { [targetParam]: targetId, file: filePath, name: fileName });
      const result = this.classifySend(resp);
      if (result.status === "confirmed") this.caps[capability] = "supported";
      else if (result.status === "failed" && (
        resp.retcode === 1404 || resp.retcode === -32601
        || /unknown action|unsupported (?:action|api)|(?:action|api).*not (?:found|supported)|不支持(?:的)?(?:动作|接口)|(?:动作|接口)不存在/i.test(result.error ?? "")
      )) {
        this.caps[capability] = "unsupported";
        return { status: "failed", error: `协议端不支持 ${action}: ${result.error}` };
      }
      return result;
    } catch (e) {
      return { status: e instanceof NotSubmittedError ? "failed" : "unknown", error: (e as Error).message };
    }
  }

  async getGroupMsgHistory(
    groupId: string,
    anchor?: string,
    limit?: number,
  ): Promise<{ ok: true; messages: NormalizedIncomingMessage[]; hasMore: boolean } | { ok: false; error: string }> {
    try {
      const params: Record<string, unknown> = { group_id: groupId };
      if (anchor) params.message_seq = /^\d+$/.test(anchor) ? Number(anchor) : anchor;
      if (limit) params.count = limit;
      const resp = await this.call(this.opts.historyAction, params);
      if (resp.retcode !== 0) {
        this.caps.groupHistory = "unsupported";
        return { ok: false, error: resp.wording ?? `retcode=${resp.retcode}` };
      }
      this.caps.groupHistory = "supported";
      const data = resp.data as { messages?: OBMessageEvent[] } | OBMessageEvent[] | null;
      const list = Array.isArray(data) ? data : (data?.messages ?? []);
      const messages: NormalizedIncomingMessage[] = [];
      for (const ev of list) {
        const segments = Array.isArray(ev.message)
          ? ev.message.map((s) => seg(s.type, s.data ?? {}))
          : [{ type: "text" as const, data: { text: String(ev.message ?? "") } }];
        messages.push({
          accountId: this.opts.accountId,
          providerId: this.providerId,
          messageId: String(ev.message_id),
          groupId: ev.group_id != null ? String(ev.group_id) : groupId,
          senderId: String(ev.sender?.user_id ?? ev.user_id ?? ""),
          senderName: String(ev.sender?.card || ev.sender?.nickname || (ev.user_id ?? "")),
          sentAt: new Date((ev.time ?? Date.now() / 1000) * 1000),
          replyToMessageId: undefined,
          segments,
        });
      }
      return { ok: true, messages, hasMore: list.length > 0 };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 首次使用私聊文件能力前的探测：发送一个不落库的轻量参数校验调用没有标准做法，
   *  这里改为“标记为未验证，以首次真实调用结果为准”。 */
  markUnverified(cap: keyof CapabilityMap): void {
    this.caps[cap] = "unverified";
  }
}
