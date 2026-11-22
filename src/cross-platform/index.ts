import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Database } from "../db/index.js";
import type { Gateway, SendPayload } from "../gateway/index.js";
import type { MessageRecord, MessageSegment, SendStatus } from "../types.js";
import { sleep } from "../util/misc.js";
import { normalizeAlias, type CrossPlatformConfig, type CrossPlatformDestination, type CrossPlatformKind } from "./config.js";
import { readDeliveryIntent } from "./intent.js";
import { telegramVoice } from "./voice.js";

export { parseCrossPlatformConfig, type CrossPlatformConfig, type CrossPlatformDestination, type CrossPlatformKind } from "./config.js";

export interface CrossPlatformAccount {
  gateway: Gateway;
  ownerIds: readonly string[];
  platform: "onebot" | "discord" | "telegram";
  providerFileRoot?: string;
}

export type CrossPlatformFile = { filename: string } & ({ bytes: Buffer } | { path: string });
export type CrossPlatformContent =
  | { kind: "text"; text: string }
  | { kind: "file" | "image" | "voice"; files: readonly CrossPlatformFile[]; caption?: string };

export interface CrossPlatformAttachment {
  name: string;
  mime: string;
  bytes: Buffer;
}

export interface CrossPlatformConsoleRequest {
  requestId: string;
  destination: string;
  resource: { name: string; url?: string; file?: CrossPlatformAttachment };
}

export interface CrossPlatformReceipt {
  taskId: number;
  status: SendStatus;
  destination: string;
  reused: boolean;
  detail: string;
}

interface DeliveryOptions {
  db: Database;
  config: CrossPlatformConfig;
  accounts: ReadonlyMap<string, CrossPlatformAccount>;
  artifactRoot: string;
}

interface SubmissionOptions {
  taskKey: string;
  waitTimeoutMs?: number;
  source?: MessageRecord;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const statusDescriptions: Record<SendStatus, string> = {
  queued: "已加入发送队列，尚未收到平台回执。",
  in_flight: "正在发送，尚未收到平台回执。",
  confirmed: "平台已确认发送成功。",
  failed: "平台发送失败。",
  unknown: "发送回执不明，禁止重复发送。",
};

export class CrossPlatformDelivery {
  private readonly aliases = new Map<string, CrossPlatformDestination>();

  constructor(private readonly options: DeliveryOptions) {
    for (const route of options.config.destinations) {
      const account = options.accounts.get(route.accountId);
      if (!account) throw new Error(`配置错误: 跨端目的地 ${route.id} 引用了未启用的平台账号 ${route.accountId}`);
      const groupTopic = account.platform === "telegram" && route.conversationType === "group";
      const validId = groupTopic ? /^-[1-9]\d*(?::[1-9]\d*)?$/u : /^[1-9]\d*$/u;
      if (!validId.test(route.targetId)) throw new Error(`配置错误: 跨端目的地 ${route.id} 的平台会话 ID 无效`);
      for (const name of [route.id, ...route.aliases]) this.aliases.set(name, route);
    }
  }

  private usableSource(message: MessageRecord): boolean {
    const account = this.options.accounts.get(message.accountId);
    const conversationId = message.groupId ? `group_${message.groupId}` : `private_${message.senderId}`;
    const stored = this.options.db.getMessageByEventKey(message.eventKey);
    return Boolean(account && account.gateway.getProvider().providerId === message.providerId
      && message.origin === "live" && message.status === "active" && !message.interaction
      && message.conversationId === conversationId && account.ownerIds.includes(message.senderId)
      && (!stored || (stored.status === "active" && stored.account_id === message.accountId
        && stored.sender_id === message.senderId && stored.conversation_id === conversationId))
      && !this.options.db.isUserBlocked(message.accountId, message.senderId));
  }

  authorize(message: MessageRecord, alias: string | undefined, kind: CrossPlatformKind): CrossPlatformDestination | undefined {
    const source = message.segments.filter(s => s.type === "text").map(s => s.data.text).join("\n");
    const { requests, mentions, denied } = readDeliveryIntent(source, this.aliases.keys());
    if (alias === undefined && !mentions.size && !requests.size) return undefined;
    if (!this.usableSource(message)) throw new Error("跨端发送需要已绑定主人的有效实时消息。");
    const target = alias === undefined ? undefined : this.aliases.get(normalizeAlias(alias));
    if (alias !== undefined && !target) throw new Error("这个跨端目的地尚未绑定。");
    const deniedRoutes = new Set([...denied].map(name => this.aliases.get(name)));

    const requested = new Map<CrossPlatformDestination, Set<CrossPlatformKind>>();
    for (const [name, kinds] of requests) {
      const route = this.aliases.get(name);
      if (!route) {
        if (!target) throw new Error(`跨端目的地 ${name} 尚未绑定。`);
        continue;
      }
      if (deniedRoutes.has(route)) continue;
      const previous = requested.get(route) ?? new Set<CrossPlatformKind>();
      for (const requestedKind of kinds) previous.add(requestedKind);
      requested.set(route, previous);
    }
    const matches = [...requested].filter(([, kinds]) => !kinds.size || kinds.has(kind)).map(([route]) => route);
    if (target) {
      if (!matches.includes(target)) throw new Error("本条原始消息没有明确要求把这种内容发到该目的地。");
    } else if (matches.length !== 1) {
      throw new Error(matches.length ? "本条消息有多个可用目的地，请指定实际发送的别名。" : "本条原始消息没有可用的跨端发送指令。");
    }
    const route = target ?? matches[0]!;
    if (!route.capabilities.includes(kind)) throw new Error(`目的地 ${route.id} 未启用 ${kind} 发送。`);
    return route;
  }

  async sendText(message: MessageRecord, args: Record<string, unknown>): Promise<CrossPlatformReceipt> {
    if (Object.keys(args).some(key => key !== "destination" && key !== "text")
      || typeof args.destination !== "string" || typeof args.text !== "string") {
      throw new Error("跨端文字只接受已绑定的目的地别名和文字。");
    }
    const route = this.authorize(message, args.destination, "text")!;
    return this.enqueue(message, route, { kind: "text", text: args.text });
  }

  async sendArtifact(message: MessageRecord, args: Record<string, unknown>, source: {
    readArtifact?: (id: string) => CrossPlatformAttachment | Promise<CrossPlatformAttachment>;
    currentAttachments?: () => Promise<CrossPlatformAttachment[]>;
  }): Promise<CrossPlatformReceipt> {
    const { destination, kind, artifact_id: artifactId, attachment_index: attachmentIndex } = args;
    const fields = ["destination", "kind", "artifact_id", "attachment_index"];
    if (Object.keys(args).some(key => !fields.includes(key)) || typeof destination !== "string"
      || (kind !== "file" && kind !== "image" && kind !== "voice")
      || (artifactId !== undefined && (typeof artifactId !== "string" || !artifactId.trim() || artifactId.length > 100))
      || (attachmentIndex !== undefined && (typeof attachmentIndex !== "number" || !Number.isSafeInteger(attachmentIndex)
        || attachmentIndex < 1 || artifactId !== undefined))) {
      throw new Error("请填写已绑定的目的地、媒体类型，以及所需的工作区文件 ID 或当前附件编号。");
    }
    const route = this.authorize(message, destination, kind)!;
    const attachments = artifactId !== undefined
      ? (source.readArtifact ? [await source.readArtifact(artifactId)] : [])
      : (await source.currentAttachments?.() ?? []);
    const matching = attachments.filter(attachment => {
      if (kind === "image") return /^image\//iu.test(attachment.mime);
      if (kind === "voice") return /^audio\//iu.test(attachment.mime);
      // Image and audio uploads require an explicit file order with an explicit index.
      return artifactId !== undefined || attachmentIndex !== undefined || !/^(?:image|audio)\//iu.test(attachment.mime);
    });
    const selected = attachmentIndex === undefined ? matching : matching.slice(attachmentIndex - 1, attachmentIndex);
    if (!selected.length) throw new Error("没有找到可发送的这种附件。");
    if (selected.length > (kind === "image" ? 4 : 1)) throw new Error("同类附件较多，请填写要发送的附件编号。");
    const files = selected.map(({ name, bytes }) => ({ filename: name, bytes }));
    return this.enqueue(message, route, { kind, files });
  }

  consoleDestinations(): string[] {
    return this.options.config.destinations.filter(route => route.capabilities.includes("file") || route.capabilities.includes("text"))
      .map(route => route.id);
  }

  /** The authenticated owner console grants authority with an explicit destination selection. */
  async sendFromConsole({ requestId, destination, resource }: CrossPlatformConsoleRequest): Promise<CrossPlatformReceipt> {
    if (typeof requestId !== "string" || !/^[a-z0-9_-]{1,100}$/iu.test(requestId) || typeof destination !== "string"
      || !resource || typeof resource.name !== "string" || !resource.name.trim() || resource.name.length > 200
      || /[\x00-\x1f\x7f]/u.test(resource.name)) {
      throw new Error("需要当前请求的标识、绑定的目的地和有效资源。");
    }
    const route = this.aliases.get(normalizeAlias(destination));
    if (!route) throw new Error("这个跨端目的地尚未绑定。");
    let content: CrossPlatformContent;
    if (resource.file) {
      if (!Buffer.isBuffer(resource.file.bytes)) throw new Error("收纳资源缺少文件内容。");
      content = { kind: "file", files: [{ filename: resource.file.name, bytes: resource.file.bytes }] };
    } else if (typeof resource.url === "string") {
      let url: URL;
      try { url = new URL(resource.url); }
      catch { throw new Error("资源地址无效。"); }
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
        throw new Error("资源地址需要使用无账号凭据的 HTTP 或 HTTPS。");
      }
      content = { kind: "text", text: resource.name === url.href ? url.href : `${resource.name.trim()}\n${url.href}` };
    } else {
      throw new Error("收纳资源需要提供链接或文件。");
    }
    if (!route.capabilities.includes(content.kind)) throw new Error(`目的地 ${route.id} 未启用 ${content.kind} 发送。`);
    return this.submit(route, content, { taskKey: `cross_platform_console:${digest(requestId)}` });
  }

  async enqueue(message: MessageRecord, route: CrossPlatformDestination, content: CrossPlatformContent,
    options: { key?: string; waitTimeoutMs?: number } = {}): Promise<CrossPlatformReceipt> {
    const destination = this.authorize(message, route.id, content.kind)!;
    const taskKey = `cross_platform:${digest(JSON.stringify([
      message.accountId, message.eventKey, message.senderId, destination.id, destination.accountId,
      destination.conversationType, destination.targetId, content.kind, options.key ?? "",
    ]))}`;
    return this.submit(destination, content, { taskKey, waitTimeoutMs: options.waitTimeoutMs, source: message });
  }

  private async submit(destination: CrossPlatformDestination, content: CrossPlatformContent,
    { taskKey, waitTimeoutMs, source }: SubmissionOptions): Promise<CrossPlatformReceipt> {
    const account = this.options.accounts.get(destination.accountId)!;
    const kind = source ? `cross_platform_${content.kind}` : `cross_platform_console_${content.kind}`;
    const existing = this.options.db.db.prepare("SELECT id FROM send_tasks WHERE task_key = ?").get(taskKey) as { id: number } | undefined;
    if (existing) return this.receipt(existing.id, destination, kind, true, waitTimeoutMs);
    const attribution = source ? { requesterId: source.senderId, accountId: source.accountId } : {};
    let payload: SendPayload;
    if (content.kind === "text") {
      if (!content.text.trim() || content.text.length > 1900 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(content.text)) {
        throw new Error("跨端文字需要 1 到 1900 字，不能包含控制字符。");
      }
      payload = { kind: "segments", segments: [{ type: "text", data: { text: content.text.trim() } }], ...attribution };
    } else {
      payload = await this.mediaPayload(account, destination, content, attribution);
    }
    // Downloading or staging can take time. Check the same account and command again before submission.
    if (source) this.authorize(source, destination.id, content.kind);
    const task = account.gateway.enqueueSend({
      taskKey,
      kind,
      conversationType: destination.conversationType,
      targetId: destination.targetId,
      payload,
    });
    return this.receipt(task.id, destination, kind, task.reused, waitTimeoutMs);
  }

  private async mediaPayload(account: CrossPlatformAccount, destination: CrossPlatformDestination,
    content: Exclude<CrossPlatformContent, { kind: "text" }>, attribution: { requesterId?: string; accountId?: string }): Promise<SendPayload> {
    if (!content.files.length || content.files.length > (content.kind === "image" ? 4 : 1)
      || (content.caption !== undefined && (content.kind !== "image" || !content.caption.trim() || content.caption.length > 1000))) {
      throw new Error("跨端投递支持单个文件或语音，图片每次最多 4 张。");
    }
    const provider = account.gateway.getProvider();
    const capability = provider.capabilities();
    if (content.kind === "file") {
      const group = destination.conversationType === "group";
      const unsupported = group ? !provider.sendGroupFile || capability.sendGroupFile === "unsupported"
        : !provider.sendPrivateFile || capability.sendPrivateFile === "unsupported";
      if (unsupported) throw new Error("当前平台账号不支持该会话的文件投递。");
    }
    if (content.kind === "image" && capability.sendImage === "unsupported") throw new Error("当前平台账号不支持图片投递。");

    const segments: MessageSegment[] = [];
    if (content.caption) segments.push({ type: "text", data: { text: content.caption.trim() } });
    let totalBytes = 0;
    for (const file of content.files) {
      const limit = destination.maxFileBytes - totalBytes;
      let bytes = "bytes" in file ? file.bytes : await this.readFile(file.path, limit);
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > limit) throw new Error("媒体为空或超过目的地大小限制。");
      let filename = file.filename;
      this.validateFilename(filename);
      if (content.kind === "voice" && account.platform === "telegram") {
        ({ filename, bytes } = await telegramVoice(bytes, filename, limit));
      }
      totalBytes += bytes.length;
      const stagedPath = await this.stageFile(filename, bytes, account.providerFileRoot);
      if (content.kind === "file") return { kind: "file", filePath: stagedPath, fileName: filename, ...attribution };
      const fileRef = pathToFileURL(stagedPath, account.providerFileRoot
        ? { windows: !account.providerFileRoot.startsWith("/") } : undefined).toString();
      if (content.kind === "image") segments.push({ type: "image", data: { file: fileRef } });
      else segments.push({ type: "record", data: { file: fileRef, nativeOnly: true } });
    }
    return { kind: "segments", segments, ...attribution };
  }

  private async readFile(filePath: string, limit: number): Promise<Buffer> {
    if (!path.isAbsolute(filePath)) throw new Error("找不到可发送的文件。");
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !stat.size || stat.size > limit) throw new Error("文件为空或超过目的地大小限制。");
      const buffer = Buffer.alloc(stat.size + 1);
      let position = 0;
      while (position < buffer.length) {
        const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position);
        if (!bytesRead) break;
        position += bytesRead;
      }
      if (position !== stat.size) throw new Error("发送前文件发生变化，请重新选择。");
      return buffer.subarray(0, position);
    } finally {
      await handle.close();
    }
  }

  private validateFilename(filename: string): void {
    if (typeof filename !== "string" || !filename.trim() || filename.length > 120 || /[\\/<>:"|?*\x00-\x1f]/u.test(filename)
      || filename.startsWith(".") || /[. ]$/u.test(filename) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(filename)) {
      throw new Error("文件名不适合跨端发送。");
    }
  }

  private async stageFile(filename: string, bytes: Buffer, providerRoot?: string): Promise<string> {
    this.validateFilename(filename);
    const key = digest(bytes);
    const privateMode = providerRoot ? 0o755 : 0o700;
    const root = path.resolve(this.options.artifactRoot);
    const directory = path.join(root, key);
    await fs.mkdir(directory, { recursive: true, mode: privateMode });
    if (providerRoot && process.platform !== "win32") {
      await fs.chmod(root, 0o755);
      await fs.chmod(directory, 0o755);
    }
    const local = path.join(directory, filename);
    // Publish atomically after writing, so concurrent identical calls never queue a partial file.
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, bytes, { flag: "wx", mode: providerRoot ? 0o644 : 0o600 });
      try { await fs.link(temporary, local); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (providerRoot && process.platform !== "win32") await fs.chmod(local, 0o644);
      }
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    if (!providerRoot) return local;
    return (providerRoot.startsWith("/") ? path.posix : path.win32).join(providerRoot, key, filename);
  }

  private async receipt(taskId: number, destination: CrossPlatformDestination, kind: string,
    reused: boolean, waitTimeoutMs = 0): Promise<CrossPlatformReceipt> {
    const deadline = Date.now() + Math.min(60_000, Math.max(0, waitTimeoutMs));
    let row = this.options.db.sendTaskById(taskId);
    if (row && (row.account_id !== destination.accountId || row.conversation_type !== destination.conversationType
      || row.target_id !== destination.targetId || row.kind !== kind)) {
      throw new Error("该请求标识已有不同的发送记录，请重新选择目的地后发起新请求。");
    }
    while (row && (row.status === "queued" || row.status === "in_flight") && Date.now() < deadline) {
      await sleep(Math.min(100, deadline - Date.now()));
      row = this.options.db.sendTaskById(taskId);
    }
    const status = row?.status ?? "unknown";
    return { taskId, status, destination: destination.id, reused, detail: statusDescriptions[status] };
  }
}
