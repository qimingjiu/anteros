import { openAsBlob } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { CapabilityMap, GatewayEvent, MessageSegment, Provider, ProviderHealth, SendResult } from "../types.js";
import { logger } from "../util/logger.js";
import { asRecord, numericId, TelegramApi, TelegramApiError } from "./api.js";
import { telegramMessage } from "./incoming.js";

const log = logger("telegram");
const OFFSET_LIFETIME_MS = 6 * 24 * 60 * 60_000;
const POLL_SECONDS = 25;
const MAX_TEXT_LENGTH = 4096;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

type Destination = { chat_id: string; message_thread_id?: number };
type MediaMethod = "sendPhoto" | "sendVoice" | "sendVideo" | "sendDocument";
type Request = { method: string; parameters: Record<string, unknown> | FormData };

export interface TelegramOffset { nextOffset: number; observedAt: number }

export interface TelegramProviderOptions {
  accountId: string;
  token: string;
  ownerIds: readonly string[];
  groupAllowlist: readonly string[];
  apiBaseUrl?: string;
  offsetStore?: { load(): TelegramOffset | undefined; save(offset: TelegramOffset): void };
  fetch?: typeof fetch;
}

const MEDIA_MIME: Record<string, string> = {
  ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg",
  ".m4a": "audio/mp4", ".mp4": "video/mp4", ".pdf": "application/pdf",
};

function target(id: string, group: boolean): Destination | undefined {
  const [chat, thread, extra] = id.split(":");
  const chatId = numericId(chat, group);
  if (!chatId || group !== chatId.startsWith("-") || extra !== undefined) return;
  if (thread === undefined) return { chat_id: chatId };
  const threadId = numericId(thread);
  if (group && threadId) return { chat_id: chatId, message_thread_id: Number(threadId) };
}

function splitText(value: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (chunk.length + char.length > MAX_TEXT_LENGTH) {
      if (chunk.trim()) chunks.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk.trim()) chunks.push(chunk);
  return chunks;
}

function safeFilename(value: string): string {
  return value.replace(/[\\/\x00-\x1f\x7f]/g, "_").slice(0, 180) || "attachment.bin";
}

async function localUpload(filePath: string, fileName: string): Promise<{ blob: Blob; name: string }> {
  const name = safeFilename(fileName);
  const blob = await openAsBlob(filePath, { type: MEDIA_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream" });
  return { blob, name };
}

async function mediaRequest(method: MediaMethod, field: string, destination: Destination, ref: string,
  replyTo?: string, suppliedName?: string): Promise<Request> {
  const metadata = replyTo ? { ...destination, reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } } : destination;
  const maxBytes = method === "sendPhoto" ? MAX_PHOTO_BYTES : MAX_MEDIA_BYTES;
  let upload: { blob: Blob; name: string };
  if (ref.startsWith("base64://")) {
    const encoded = ref.slice(9);
    if (!/^[A-Za-z0-9+/]+=*$/.test(encoded) || encoded.length > Math.ceil(maxBytes / 3) * 4) throw new Error("Telegram 媒体数据无效或超过体积上限");
    const bytes = Buffer.from(encoded, "base64");
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const ext = method === "sendPhoto" ? (png ? "png" : "jpg") : method === "sendVoice" ? "mp3" : "mp4";
    upload = { blob: new Blob([bytes], { type: MEDIA_MIME[`.${ext}`] }), name: `media.${ext}` };
  } else if (ref.startsWith("file://") || path.isAbsolute(ref)) {
    const filePath = ref.startsWith("file://") ? fileURLToPath(ref) : ref;
    upload = await localUpload(filePath, suppliedName ?? path.basename(filePath));
  } else if (!suppliedName) {
    const url = new URL(ref);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Telegram 仅支持本地媒体或 HTTPS 媒体地址");
    return { method, parameters: { ...metadata, [field]: url.href } };
  } else throw new Error("Telegram 文件必须使用本地绝对路径");
  if (upload.blob.size < 1 || upload.blob.size > maxBytes) throw new Error("Telegram 媒体为空或超过体积上限");
  if (method === "sendVoice" && !["audio/ogg", "audio/mpeg", "audio/mp4"].includes(upload.blob.type)) {
    throw new Error("Telegram 原生语音需要 Ogg/Opus、MP3 或 M4A");
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(metadata)) form.set(key, typeof value === "string" ? value : JSON.stringify(value));
  form.set(field, upload.blob, upload.name);
  return { method, parameters: form };
}

async function messageRequests(destination: Destination, segments: MessageSegment[]): Promise<Request[]> {
  const requests: Request[] = [];
  const reply = segments.find(segment => segment.type === "reply");
  const replyTo = reply ? numericId(reply.data.id) : undefined;
  let text = "";
  const flush = () => {
    for (const chunk of splitText(text)) {
      const parameters = { ...destination, text: chunk };
      requests.push({ method: "sendMessage", parameters: !requests.length && replyTo
        ? { ...parameters, reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } } : parameters });
    }
    text = "";
  };

  for (const segment of segments) {
    switch (segment.type) {
      case "text": text += segment.data.text; break;
      case "at": text += `@${segment.data.qq}`; break;
      case "share": text += [segment.data.title, segment.data.content, segment.data.url].filter(Boolean).join("\n"); break;
      case "image": case "record": case "video": {
        const file = segment.data.file ?? segment.data.url;
        if (!file) throw new Error("Telegram 媒体缺少内容");
        flush();
        const [method, field] = segment.type === "image" ? ["sendPhoto", "photo"] as const
          : segment.type === "record" ? ["sendVoice", "voice"] as const : ["sendVideo", "video"] as const;
        const request = await mediaRequest(method, field, destination, file, requests.length ? undefined : replyTo);
        requests.push(request);
        break;
      }
      default: break;
    }
  }
  flush();
  return requests;
}

export class TelegramProvider implements Provider {
  readonly providerId = "telegram";
  private readonly api: TelegramApi;
  private readonly subscribers: ((event: GatewayEvent) => void)[] = [];
  private state: ProviderHealth = { connection: "disconnected", login: "unknown", reconnectCount: 0 };
  private controller?: AbortController;
  private worker?: Promise<void>;
  private offset?: TelegramOffset;
  private username?: string;

  constructor(private readonly options: TelegramProviderOptions) {
    this.api = new TelegramApi(options.token, options.apiBaseUrl, options.fetch);
  }

  health(): ProviderHealth { return { ...this.state }; }

  capabilities(): CapabilityMap {
    return {
      receiveMessages: "supported", sendText: "supported", sendImage: "supported",
      sendPrivateFile: "supported", sendGroupFile: "supported", sendPoke: "unsupported", groupHistory: "unsupported",
    };
  }

  onEvent(listener: (event: GatewayEvent) => void): void { this.subscribers.push(listener); }

  private emit(event: GatewayEvent): void {
    for (const listener of this.subscribers) {
      try { listener(event); }
      catch {
        if (event.kind === "message") throw new Error("Telegram 消息未能持久化");
        log.warn("Telegram 状态订阅处理失败");
      }
    }
  }

  start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.state = { ...this.state, connection: "connecting", login: "unknown", selfId: undefined };
    this.username = undefined;
    this.worker = this.poll(controller.signal);
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.worker;
    this.controller = undefined;
    this.worker = undefined;
    this.state = { ...this.state, connection: "disconnected", login: "offline" };
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let backoff = 1000;
    let initialOffsetLoaded = false;
    while (!signal.aborted) {
      try {
        if (!initialOffsetLoaded) {
          this.offset = this.options.offsetStore?.load();
          initialOffsetLoaded = true;
        }
        if (!this.state.selfId) {
          const identity = asRecord(await this.api.call("getMe", {}, { signal }));
          const selfId = numericId(identity?.id);
          if (!selfId || identity?.is_bot !== true) throw new TelegramApiError("Telegram 未返回机器人身份");
          this.username = typeof identity.username === "string" ? identity.username : undefined;
          this.state.selfId = selfId;
        }
        const offset = this.offset;
        const age = offset ? Date.now() - offset.observedAt : Infinity;
        const nextOffset = offset && Number.isSafeInteger(offset.nextOffset) && offset.nextOffset > 0
          && age >= 0 && age < OFFSET_LIFETIME_MS ? offset.nextOffset : undefined;
        const updates = await this.api.call("getUpdates", {
          offset: nextOffset, limit: 20, timeout: POLL_SECONDS, allowed_updates: ["message"],
        }, { signal, timeoutMs: (POLL_SECONDS + 10) * 1000 });
        if (!Array.isArray(updates)) throw new TelegramApiError("Telegram 返回的更新列表无效");
        if (signal.aborted) return;
        const previousState = this.state;
        const at = new Date().toISOString();
        this.state = { ...previousState, connection: "connected", login: "online", lastHeartbeatAt: at, lastError: undefined };
        if (previousState.connection !== "connected") this.emit({ kind: "connection", state: "connected", at });
        if (previousState.login !== "online") this.emit({ kind: "login", state: "online", at });
        const entries = updates.flatMap(update => {
          const id = asRecord(update)?.update_id;
          return typeof id === "number" && Number.isSafeInteger(id) && id > 0 && id < Number.MAX_SAFE_INTEGER ? [{ id, update }] : [];
        }).sort((a, b) => a.id - b.id);
        let minimum = nextOffset ?? 1;
        for (const { id, update } of entries) {
          if (signal.aborted) return;
          if (id < minimum) continue;
          const { accountId, ownerIds, groupAllowlist } = this.options;
          const message = telegramMessage(update, { accountId, ownerIds, groupAllowlist, selfId: this.state.selfId, username: this.username });
          if (message) this.emit({ kind: "message", message });
          const checkpoint = { nextOffset: id + 1, observedAt: Date.now() };
          this.options.offsetStore?.save(checkpoint);
          this.offset = checkpoint;
          minimum = checkpoint.nextOffset;
        }
        backoff = 1000;
        if (!entries.length) await delay(200, undefined, { signal });
      } catch (error) {
        if (signal.aborted) return;
        const apiError = error instanceof TelegramApiError ? error : undefined;
        const detail = apiError?.message ?? "Telegram 更新处理失败";
        const at = new Date().toISOString();
        if (apiError?.code === 401 || apiError?.code === 404) {
          this.state = { ...this.state, connection: "disconnected", login: "offline", lastError: detail };
          this.emit({ kind: "login", state: "offline", at, detail });
          this.emit({ kind: "connection", state: "disconnected", at, detail });
          return;
        }
        const firstFailure = this.state.lastError === undefined;
        this.state = { ...this.state, connection: "connecting", login: "unknown",
          reconnectCount: this.state.reconnectCount + 1, lastError: detail };
        if (firstFailure) this.emit({ kind: "connection", state: "reconnecting", at, detail });
        try { await delay(Math.min(300_000, apiError?.retryAfterMs ?? backoff), undefined, { signal }); }
        catch { return; }
        backoff = Math.min(30_000, backoff * 2);
      }
    }
  }

  async downloadIncomingFile(options: { fileId: string; maxBytes: number; timeoutMs: number }): Promise<Uint8Array> {
    return this.api.download(options.fileId, options.maxBytes, options.timeoutMs);
  }

  async deleteMessage(targetInfo: { groupId?: string; userId?: string; messageId: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    const destination = target(targetInfo.groupId ?? targetInfo.userId ?? "", targetInfo.groupId !== undefined);
    const messageId = numericId(targetInfo.messageId);
    if (!destination || !messageId) return { ok: false, error: "Telegram 会话或消息 ID 无效" };
    try {
      const result = await this.api.call("deleteMessage", { chat_id: destination.chat_id, message_id: Number(messageId) });
      return result === true ? { ok: true } : { ok: false, error: "Telegram 未确认撤回" };
    } catch (error) {
      return { ok: false, error: error instanceof TelegramApiError ? error.message : "Telegram 撤回结果未确认" };
    }
  }

  sendPrivateMsg(userId: string, segments: MessageSegment[]): Promise<SendResult> {
    return this.sendTo(userId, false, destination => messageRequests(destination, segments));
  }

  sendGroupMsg(groupId: string, segments: MessageSegment[]): Promise<SendResult> {
    return this.sendTo(groupId, true, destination => messageRequests(destination, segments));
  }

  sendPrivateFile(userId: string, filePath: string, fileName: string): Promise<SendResult> {
    return this.sendFile(userId, false, filePath, fileName);
  }

  sendGroupFile(groupId: string, filePath: string, fileName: string): Promise<SendResult> {
    return this.sendFile(groupId, true, filePath, fileName);
  }

  private sendFile(id: string, group: boolean, filePath: string, fileName: string): Promise<SendResult> {
    return this.sendTo(id, group, async destination => [
      await mediaRequest("sendDocument", "document", destination, filePath, undefined, fileName),
    ]);
  }

  private async sendTo(id: string, group: boolean, prepare: (destination: Destination) => Promise<Request[]>): Promise<SendResult> {
    const destination = target(id, group);
    if (!destination) return { status: "failed", error: "Telegram 会话 ID 无效" };
    let requests: Request[];
    try { requests = await prepare(destination); }
    catch { return { status: "failed", error: "Telegram 消息内容或本地媒体无效" }; }
    if (!requests.length) return { status: "failed", error: "Telegram 没有可发送的内容" };
    let messageId: string | undefined;
    try {
      for (const { method, parameters } of requests) {
        const result = asRecord(await this.api.call(method, parameters, { timeoutMs: parameters instanceof FormData ? 60_000 : undefined }));
        const id = numericId(result?.message_id);
        if (!id) throw new TelegramApiError("Telegram 未返回消息 ID");
        messageId = id;
        if (method === "sendVoice" && !asRecord(result?.voice)) {
          return { status: "unknown", messageId, error: "Telegram 返回了消息 ID，但未确认原生语音" };
        }
      }
      return { status: "confirmed", messageId };
    } catch (error) {
      const rejected = error instanceof TelegramApiError && error.rejected;
      const reason = error instanceof TelegramApiError ? error.message : "Telegram 未确认消息发送结果";
      if (messageId) return { status: "unknown", messageId, error: `Telegram 只确认了部分消息，${reason}` };
      return { status: rejected ? "failed" : "unknown", error: reason };
    }
  }
}
