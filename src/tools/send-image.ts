import dns from "node:dns";
import net from "node:net";
import { Agent as HttpAgent } from "undici";
import type { Database } from "../db/index.js";
import type { Gateway } from "../gateway/index.js";
import type { CrossPlatformDelivery, CrossPlatformDestination } from "../cross-platform/index.js";
import type { MessageRecord, MessageSegment, SendStatus, ToolDef, ToolImage } from "../types.js";
import { sleep, stableHash } from "../util/misc.js";
import { isPrivateAddress, readBounded } from "./web-http.js";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 4;
const DOWNLOAD_TIMEOUT_MS = 15000;

export interface NumberedToolImage extends ToolImage { id: string }

/** Images live only in the object owned by one model reply flow. */
export class ReplyImageStore {
  private nextId = 1;
  private images = new Map<string, ToolImage>();

  add(images: ToolImage[]): NumberedToolImage[] {
    return images.map(image => {
      const id = `img${this.nextId++}`;
      const copy = { data: image.data, mimeType: image.mimeType };
      this.images.set(id, copy);
      return { id, ...copy };
    });
  }

  get(id: string): ToolImage | undefined {
    return this.images.get(id);
  }

  get size(): number {
    return this.images.size;
  }

  ids(): string[] {
    return [...this.images.keys()];
  }
}

export function validateSendImageUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("图片 URL 无效"); }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (value.length > 8192 || url.protocol !== "https:" || url.username || url.password
    || (url.port && url.port !== "443") || !host || host.includes("%") || host === "localhost"
    || /\.(?:localhost|local|internal|onion)$/.test(host) || (net.isIP(host) && isPrivateAddress(host))) {
    throw new Error("图片 URL 只允许公开 HTTPS 地址");
  }
  return url;
}

export function detectSendImageMime(bytes: Buffer): ToolImage["mimeType"] | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return "image/gif";
  return undefined;
}

/** Every DNS answer and redirect hop is validated; connections use the validated addresses. */
export async function downloadSendImage(value: string): Promise<ToolImage> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  let url = validateSendImageUrl(value);
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const records = await Promise.race([
        dns.promises.lookup(url.hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("图片下载超时")), { once: true })),
      ]);
      signal.throwIfAborted();
      if (!records.length || records.some(record => isPrivateAddress(record.address))) throw new Error("图片地址不是公开网络");
      const lookup = ((_host: string, options: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => {
        const selected = records.filter(record => !options.family || record.family === options.family);
        if (options.all) callback(null, selected);
        else { const chosen = selected[0] ?? records[0]!; callback(null, chosen.address, chosen.family); }
      }) as typeof dns.lookup;
      const dispatcher = new HttpAgent({ connect: { lookup, timeout: 10000 } });
      try {
        const response = await fetch(url, {
          redirect: "manual", signal, dispatcher,
          headers: { Accept: "image/png,image/jpeg,image/webp,image/gif", "User-Agent": "QQImageSender/1.0" },
        } as RequestInit);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || hop === 5) throw new Error("图片下载重定向无效");
          url = validateSendImageUrl(new URL(location, url).toString());
          continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error("图片下载失败"); }
        const length = Number(response.headers.get("content-length"));
        if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) { await response.body?.cancel(); throw new Error("图片超过大小上限"); }
        const data = await readBounded(response, MAX_IMAGE_BYTES);
        if (data.truncated || !data.bytes.length) throw new Error("图片为空或超过大小上限");
        const bytes = Buffer.from(data.bytes);
        const mimeType = detectSendImageMime(bytes);
        if (!mimeType) throw new Error("图片格式不受支持");
        return { data: bytes.toString("base64"), mimeType };
      } finally { await dispatcher.close(); }
    }
    throw new Error("图片下载失败");
  } catch {
    throw new Error("图片 URL 下载失败、超时或地址、格式、大小不符合要求");
  }
}

export type SendImageStatus = SendStatus;
export interface SendImageResult {
  status: SendImageStatus;
  imageCount: number;
  taskId?: number;
  reused: boolean;
  reason?: string;
  detail: string;
  destination?: string;
}
export interface SendImageDeps {
  db: Database;
  gateway: Gateway;
  accountId: string;
  ownerIds: string[];
  waitTimeoutMs?: number;
  crossPlatform?: CrossPlatformDelivery;
  downloadImage?: typeof downloadSendImage;
}

export class SendImageService {
  constructor(private deps: SendImageDeps) {}

  toolsFor(message: MessageRecord, images: ReplyImageStore): ToolDef[] {
    if (!this.allowed(message)) return [];
    return [{
      name: "send_image",
      description: "主人要截图或图片时，用它把图片真正发到当前 QQ 会话，不要只甩链接。image_ids 引用本轮工具图片说明中列出的编号（如 img1），image_urls 可传公开 HTTPS 图片直链；两者可混用，一次总共最多 4 张。text 可选，和图片来自同一条消息，最多 1000 字；省略 text 就只发图片。只发当前群或私聊，不能指定其他收件人。返回 JSON 仅 confirmed 表示协议确认成功，unknown 禁止重试。发过图后，最终文字回复不要重复图片内容，也不要再次贴图片链接。",
      private: true,
      inputSchema: {
        type: "object",
        properties: {
          image_ids: { type: "array", items: { type: "string", pattern: "^img[1-9]\\d*$" }, maxItems: MAX_IMAGES,
            description: "本次回复流程中的工具图片编号，例如 [\"img1\",\"img2\"]" },
          image_urls: { type: "array", items: { type: "string", maxLength: 8192 }, maxItems: MAX_IMAGES,
            description: "公开 HTTPS 的 png/jpeg/webp/gif 直链，每张不超过 4MB" },
          text: { type: "string", minLength: 1, maxLength: 1000, description: "可选；与图片同一条消息发送的文字" },
          ...(this.deps.crossPlatform ? { destination: { type: "string", description: "主人本条原话明确要求跨端发送时，填写已绑定的目的地别名。" } } : {}),
        },
        additionalProperties: false,
      },
      execute: async args => {
        try { return JSON.stringify(await this.createAndSend(args, message, images)); }
        catch { return JSON.stringify({ status: "unknown", imageCount: 0, reused: false, reason: "delivery_unknown",
          detail: "图片发送回执不明；禁止重试，以免重复发送。" }); }
      },
    }];
  }

  private allowed(message: MessageRecord): boolean {
    return message.accountId === this.deps.accountId && message.origin === "live" && message.status === "active" && !message.interaction
      && this.deps.ownerIds.includes(message.senderId) && !this.deps.db.isUserBlocked(message.accountId, message.senderId);
  }

  async createAndSend(args: Record<string, unknown>, message: MessageRecord, store: ReplyImageStore): Promise<SendImageResult> {
    if (!this.allowed(message)) return failure("forbidden", "只允许由当前账号主人的有效实时消息发送图片");
    const allowed = ["image_ids", "image_urls", "text", ...(this.deps.crossPlatform ? ["destination"] : [])];
    if (Object.keys(args).some(key => !allowed.includes(key))) {
      return failure("invalid_input", "send_image 只接受 image_ids、image_urls 和 text");
    }
    if (args.destination !== undefined && typeof args.destination !== "string") {
      return failure("invalid_input", "跨端目的地必须是已绑定的别名");
    }
    let route: CrossPlatformDestination | undefined;
    try { route = this.deps.crossPlatform?.authorize(message, args.destination, "image"); }
    catch { return failure("forbidden", "本条原始消息没有授权向这个目的地发送图片"); }
    const ids = args.image_ids ?? [];
    const urls = args.image_urls ?? [];
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")
      || !Array.isArray(urls) || urls.some(url => typeof url !== "string")) {
      return failure("invalid_input", "image_ids 和 image_urls 必须是字符串数组");
    }
    if (ids.length + urls.length < 1 || ids.length + urls.length > MAX_IMAGES) {
      return failure("invalid_input", "每次必须提供 1 到 4 张图片（编号和 URL 合计）");
    }
    if (args.text !== undefined && (typeof args.text !== "string" || !args.text.trim() || args.text.length > 1000)) {
      return failure("invalid_input", "text 必须是 1 到 1000 字的非空字符串");
    }
    const selected = ids.map(id => ({ id, image: store.get(id) }));
    if (selected.some(entry => !entry.image)) return failure("invalid_image_id", "图片编号不存在或不属于本次回复流程");
    let normalizedUrls: string[];
    try { normalizedUrls = urls.map(url => validateSendImageUrl(url).toString()); }
    catch { return failure("invalid_url", "图片 URL 只允许公开 HTTPS 地址"); }
    const conversationType = message.groupId ? "group" : "private";
    const targetId = message.groupId ?? message.senderId;
    const validTarget = message.providerId === "telegram" ? /^-?[1-9]\d*(?::[1-9]\d*)?$/u : /^[1-9]\d*$/u;
    if (!validTarget.test(targetId)
      || message.conversationId !== (message.groupId ? `group_${message.groupId}` : `private_${message.senderId}`)) {
      return failure("invalid_conversation", "图片请求的真实会话无效");
    }
    const imageCount = ids.length + urls.length;
    const taskKey = `send_image:v1:${stableHash(JSON.stringify([
      message.accountId, message.conversationId, message.senderId, message.eventKey, ids, normalizedUrls, args.text ?? null,
    ]))}`;
    const prior = this.deps.db.db.prepare("SELECT id FROM send_tasks WHERE task_key = ?").get(taskKey) as { id: number } | undefined;
    if (prior) return this.waitForTask(prior.id, imageCount, true);
    let downloaded: ToolImage[];
    try { downloaded = await Promise.all(normalizedUrls.map(url => (this.deps.downloadImage ?? downloadSendImage)(url))); }
    catch { return failure("image_unavailable", "图片 URL 下载失败、超时或地址、格式、大小不符合要求；本次未入队发送", imageCount); }
    const images = [...selected.map(entry => entry.image!), ...downloaded];
    if (route) {
      const extensions: Record<ToolImage["mimeType"], string> = {
        "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
      };
      const files = images.map((image, i) => ({ filename: `image-${i + 1}.${extensions[image.mimeType]}`,
        bytes: Buffer.from(image.data, "base64") }));
      const receipt = await this.deps.crossPlatform!.enqueue(message, route, {
        kind: "image", files, caption: typeof args.text === "string" ? args.text : undefined,
      }, { waitTimeoutMs: this.deps.waitTimeoutMs ?? 21500 });
      return { ...receipt, imageCount };
    }
    const segments: MessageSegment[] = [];
    if (typeof args.text === "string") segments.push({ type: "text", data: { text: args.text } });
    for (const image of images) {
      segments.push({ type: "image", data: { file: `base64://${image.data}` } });
    }
    let task: { id: number; reused: boolean };
    try {
      task = this.deps.gateway.enqueueSend({ taskKey, kind: "tool_image", conversationType, targetId,
        payload: { kind: "segments", requesterId: message.senderId, accountId: message.accountId, segments } });
    } catch { return failure("enqueue_failed", "图片未能进入发送队列", imageCount); }
    return this.waitForTask(task.id, imageCount, task.reused);
  }

  private async waitForTask(taskId: number, imageCount: number, reused: boolean): Promise<SendImageResult> {
    const deadline = Date.now() + Math.max(0, Math.min(60000, this.deps.waitTimeoutMs ?? 21500));
    let receipt = this.deps.db.sendTaskById(taskId);
    while (receipt && (receipt.status === "queued" || receipt.status === "in_flight") && Date.now() < deadline) {
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
      receipt = this.deps.db.sendTaskById(taskId);
    }
    if (receipt?.status === "confirmed") {
      return { status: "confirmed", imageCount, taskId, reused, detail: "图片已发到当前会话，协议端已确认发送成功。" };
    }
    if (receipt?.status === "failed") {
      return { status: "failed", imageCount, taskId, reused, reason: "send_failed", detail: "图片发送失败；没有自动重发。" };
    }
    return { status: "unknown", imageCount, taskId, reused, reason: "delivery_unknown",
      detail: "图片已排队、正在发送或回执不明；禁止重试，以免重复发送。" };
  }
}

function failure(reason: string, detail: string, imageCount = 0): SendImageResult {
  return { status: "failed", imageCount, reused: false, reason, detail };
}
