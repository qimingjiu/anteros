/**
 * Discord Provider：把 Discord 网关事件规范化成和 OneBot 一样的 GatewayEvent，
 * 让同一套 Agent / 记忆 / 工具跑在 Discord 上。
 * - 文字频道（含线程）当作“群”：groupId = 频道 ID；私信当作私聊：private_<userId>。
 * - @机器人 → at 段（qq = 机器人用户 ID）；回复 → reply 段；附件图片 → image 段（url）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AttachmentBuilder,
  MessageFlags,
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type MessageCreateOptions,
  type PartialMessage,
} from "discord.js";
import { ActivityType } from "discord.js";
import type {
  CapabilityMap,
  GatewayEvent,
  MessageRecord,
  MessageSegment,
  NormalizedIncomingMessage,
  Provider,
  ProviderHealth,
  SendResult,
} from "../types.js";
import { segmentsText } from "../onebot/provider.js";
import { logger } from "../util/logger.js";

import { buildVoiceAttachment } from "./voice.js";
const log = logger("discord");
const MAX_LEN = 2000;

export interface DiscordProviderOptions {
  accountId: string;
  token: string;
  /** 自动把这些用户拥有的服务器里的文字频道加入白名单（直接改写传入的数组）。 */
  autoAllow?: { ownerIds: string[]; allowlist: string[] };
}

export class DiscordProvider implements Provider {
  readonly providerId = "discord";
  private client: Client | null = null;
  private subscribers: ((ev: GatewayEvent) => void)[] = [];
  private state: ProviderHealth = { connection: "disconnected", login: "unknown", reconnectCount: 0 };
  private selfId: string | undefined;

  constructor(private opts: DiscordProviderOptions) {}

  getClient(): Client | null { return this.client?.isReady() ? this.client : null; }

  onEvent(cb: (ev: GatewayEvent) => void): void {
    this.subscribers.push(cb);
  }

  private emit(ev: GatewayEvent): void {
    for (const cb of this.subscribers) {
      try { cb(ev); } catch (e) { log.error("订阅者异常", e); }
    }
  }

  health(): ProviderHealth {
    return { ...this.state, selfId: this.selfId };
  }

  capabilities(): CapabilityMap {
    return {
      receiveMessages: "supported",
      sendText: "supported",
      sendImage: "supported",
      sendPrivateFile: "supported",
      sendGroupFile: "supported",
      sendPoke: "unsupported",
      groupHistory: "supported",
    };
  }

  start(): void {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
    this.client = client;
    this.state.connection = "connecting";

    client.on("clientReady", (c) => {
      this.selfId = c.user.id;
      this.state = { ...this.state, connection: "connected", login: "online", lastHeartbeatAt: new Date().toISOString() };
      log.info(`Discord 已登录: ${c.user.tag} (${c.user.id})，所在服务器 ${c.guilds.cache.size} 个`);
      for (const g of c.guilds.cache.values()) {
        const chans = g.channels.cache.filter((ch) => ch.type === ChannelType.GuildText).map((ch) => `${ch.name}=${ch.id}`);
        log.info(`服务器 ${g.name} (${g.id}) 文字频道: ${chans.join(", ")}`);
      }
      for (const g of c.guilds.cache.values()) this.allowGuild(g);
      this.emit({ kind: "connection", state: "connected", at: new Date().toISOString() });
      this.emit({ kind: "login", state: "online", at: new Date().toISOString(), detail: c.user.tag });
    });
    client.on("shardDisconnect", (_e, id) => {
      this.state.connection = "disconnected";
      this.emit({ kind: "connection", state: "disconnected", at: new Date().toISOString(), detail: `shard ${id}` });
    });
    client.on("shardReconnecting", () => {
      this.state.reconnectCount++;
      this.state.connection = "connecting";
      this.emit({ kind: "connection", state: "reconnecting", at: new Date().toISOString() });
    });
    client.on("shardResume", () => {
      this.state.connection = "connected";
      this.emit({ kind: "connection", state: "connected", at: new Date().toISOString() });
    });
    client.on("guildCreate", (g) => { log.info(`加入服务器 ${g.name} (${g.id})`); this.allowGuild(g); });
    client.on("channelCreate", (ch) => { if (ch.guild) this.allowGuild(ch.guild); });
    client.on("error", (e) => { this.state.lastError = e.message; log.warn("Discord 错误:", e.message); });

    client.on("messageCreate", (m) => {
      this.state.lastHeartbeatAt = new Date().toISOString();
      if (m.author.id === this.selfId) return; // 自己发的不回灌
      if (m.author.bot) return;
      const rec = this.toRecord(m);
      if (rec) this.emit({ kind: "message", message: rec });
    });
    client.on("messageDelete", (m: Message | PartialMessage) => {
      const groupId = m.guildId ? m.channelId : undefined;
      this.emit({
        kind: "recall", accountId: this.opts.accountId,
        conversationId: groupId ? `group_${groupId}` : `private_${m.author?.id ?? ""}`,
        groupId, messageId: m.id, recalledAt: new Date().toISOString(),
      });
    });

    client.login(this.opts.token).catch((e) => {
      this.state.lastError = (e as Error).message;
      this.state.login = "offline";
      log.error("Discord 登录失败:", (e as Error).message);
      this.emit({ kind: "login", state: "offline", at: new Date().toISOString(), detail: (e as Error).message });
    });
  }

  private allowGuild(g: import("discord.js").Guild): void {
    const a = this.opts.autoAllow;
    if (!a || !a.ownerIds.includes(g.ownerId)) return;
    const added: string[] = [];
    for (const ch of g.channels.cache.values()) {
      if ((ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) && !a.allowlist.includes(ch.id)) {
        a.allowlist.push(ch.id); added.push(`${ch.name}=${ch.id}`);
      }
    }
    if (added.length) log.info(`白名单自动加入（${g.name}）: ${added.join(", ")}`);
  }

  async stop(): Promise<void> {
    await this.client?.destroy();
    this.client = null;
  }

  // ---------- 接收 ----------

  private segmentsOf(m: Message): MessageSegment[] {
    const segs: MessageSegment[] = [];
    if (m.reference?.messageId) segs.push({ type: "reply", data: { id: m.reference.messageId } });
    let text = m.content ?? "";
    // <@id> / <@!id> → at 段；其余文字保留
    const re = /<@!?(\d+)>/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const before = text.slice(last, match.index);
      if (before) segs.push({ type: "text", data: { text: before } });
      segs.push({ type: "at", data: { qq: match[1]! } });
      last = match.index + match[0].length;
    }
    text = text.slice(last);
    // 频道/角色提及、自定义表情转成可读文字
    text = text.replace(/<#(\d+)>/g, (_s, id) => `#${this.client?.channels.cache.get(id)?.toString() ?? id}`)
      .replace(/<a?:(\w+):\d+>/g, ":$1:");
    if (text) segs.push({ type: "text", data: { text } });
    for (const a of m.attachments.values()) {
      const ct = a.contentType ?? "";
      if (ct.startsWith("image/")) segs.push({ type: "image", data: { url: a.url, file: a.name } });
      else if (ct.startsWith("audio/")) segs.push({ type: "record", data: { url: a.url, file: a.name } });
      else if (ct.startsWith("video/")) segs.push({ type: "video", data: { url: a.url, file: a.name } });
      else segs.push({ type: "share", data: { url: a.url, title: a.name, content: `附件 ${a.name}（${a.size} 字节）` } });
    }
    for (const s of m.stickers.values()) segs.push({ type: "text", data: { text: `[贴纸:${s.name}]` } });
    if (segs.length === 0) segs.push({ type: "text", data: { text: "" } });
    return segs;
  }

  private toNormalized(m: Message): NormalizedIncomingMessage {
    const groupId = m.guildId ? m.channelId : undefined;
    return {
      accountId: this.opts.accountId, providerId: this.providerId, messageId: m.id,
      groupId, privateUserId: groupId ? undefined : m.author.id,
      senderId: m.author.id,
      senderName: m.member?.displayName || m.author.globalName || m.author.username,
      sentAt: m.createdAt, replyToMessageId: m.reference?.messageId ?? undefined,
      segments: this.segmentsOf(m),
    };
  }

  private toRecord(m: Message): MessageRecord | null {
    const n = this.toNormalized(m);
    const conversationId = n.groupId ? `group_${n.groupId}` : `private_${n.senderId}`;
    return {
      eventKey: `${this.opts.accountId}:${n.groupId ? conversationId : "private"}:message:${n.messageId}`,
      accountId: n.accountId, providerId: n.providerId, conversationId, groupId: n.groupId,
      messageId: n.messageId, senderId: n.senderId, displayNameAtTime: n.senderName,
      sentAt: n.sentAt.toISOString(), receivedAt: new Date().toISOString(),
      replyToMessageId: n.replyToMessageId, segments: n.segments,
      textContent: segmentsText(n.segments), status: "active", origin: "live",
    };
  }

  // ---------- 发送 ----------

  private localPath(ref: string | undefined): string | undefined {
    if (!ref) return undefined;
    if (ref.startsWith("file://")) return fileURLToPath(ref);
    if (path.isAbsolute(ref) && fs.existsSync(ref)) return ref;
    return undefined;
  }

  private build(segments: MessageSegment[]): { parts: string[]; files: AttachmentBuilder[]; voices: string[]; replyTo?: string } {
    let text = "";
    const files: AttachmentBuilder[] = [];
    const voices: string[] = [];
    let replyTo: string | undefined;
    for (const s of segments) {
      switch (s.type) {
        case "text": text += s.data.text; break;
        case "at": text += `<@${s.data.qq}>`; break;
        case "reply": replyTo = s.data.id; break;
        case "record": {
          const ref = s.data.file ?? s.data.url;
          const lp = this.localPath(ref);
          if (lp) voices.push(lp);
          else if (ref && /^https?:/i.test(ref)) voices.push(ref);
          break;
        }
        case "image": case "video": {
          const ref = s.data.file ?? s.data.url;
          const lp = this.localPath(ref);
          if (lp) files.push(new AttachmentBuilder(fs.readFileSync(lp), { name: path.basename(lp) }));
          else if (ref?.startsWith("base64://")) files.push(new AttachmentBuilder(Buffer.from(ref.slice(9), "base64"), { name: s.type === "image" ? "image.png" : "media.bin" }));
          else if (ref && /^https?:/i.test(ref)) files.push(new AttachmentBuilder(ref));
          break;
        }
        case "share": text += s.data.url ? `\n${s.data.title ?? ""} ${s.data.url}` : ""; break;
        default: break;
      }
    }
    return { parts: splitText(text), files, voices, replyTo };
  }

  private async sendTo(channelId: string | undefined, userId: string | undefined, segments: MessageSegment[]): Promise<SendResult> {
    const client = this.client;
    if (!client?.isReady()) return { status: "failed", error: "Discord 未连接" };
    try {
      const channel = channelId
        ? await client.channels.fetch(channelId)
        : await (await client.users.fetch(userId!)).createDM();
      if (!channel || !("send" in channel) || typeof channel.send !== "function") return { status: "failed", error: "频道不可发送" };
      const { parts, files, voices, replyTo } = this.build(segments);
      if (parts.length === 0 && files.length === 0 && voices.length === 0) return { status: "failed", error: "空消息" };
      let lastId: string | undefined;
      const chunks = parts.length ? parts : (files.length ? [""] : []);
      for (let i = 0; i < chunks.length; i++) {
        const opts: MessageCreateOptions = { allowedMentions: { parse: ["users"], repliedUser: false } };
        if (chunks[i]) opts.content = chunks[i];
        if (i === chunks.length - 1 && files.length) opts.files = files;
        if (i === 0 && replyTo) opts.reply = { messageReference: replyTo, failIfNotExists: false };
        const sent = await (channel as { send(o: MessageCreateOptions): Promise<Message> }).send(opts);
        lastId = sent.id;
      }
      for (const v of voices) {
        const send = (channel as { send(o: MessageCreateOptions): Promise<Message> }).send.bind(channel);
        try {
          const att = await buildVoiceAttachment(v);
          const sent = await send({ files: [att], flags: MessageFlags.IsVoiceMessage } as MessageCreateOptions);
          lastId = sent.id;
        } catch (e) {
          log.warn(`语音消息发送失败，改为附件: ${(e as Error).message}`);
          const sent = await send({ files: [new AttachmentBuilder(/^https?:/i.test(v) ? v : fs.readFileSync(v), { name: path.basename(v.split("?")[0]!) || "audio" })] });
          lastId = sent.id;
        }
      }
      return { status: "confirmed", messageId: lastId };
    } catch (e) {
      return { status: "failed", error: (e as Error).message };
    }
  }

  sendPrivateMsg(userId: string, segments: MessageSegment[]): Promise<SendResult> {
    return this.sendTo(undefined, userId, segments);
  }

  sendGroupMsg(groupId: string, segments: MessageSegment[]): Promise<SendResult> {
    return this.sendTo(groupId, undefined, segments);
  }

  async deleteMessage(t: { groupId?: string; userId?: string; messageId: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const c = this.getClient();
      if (!c) return { ok: false, error: "Discord 未连接" };
      const ch: any = t.groupId ? await c.channels.fetch(t.groupId) : await (await c.users.fetch(t.userId!)).createDM();
      await ch.messages.delete(t.messageId);
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  sendPrivateFile(userId: string, filePath: string, fileName: string): Promise<SendResult> {
    return this.sendFile(undefined, userId, filePath, fileName);
  }

  sendGroupFile(groupId: string, filePath: string, fileName: string): Promise<SendResult> {
    return this.sendFile(groupId, undefined, filePath, fileName);
  }

  private async sendFile(channelId: string | undefined, userId: string | undefined, filePath: string, fileName: string): Promise<SendResult> {
    const lp = this.localPath(filePath) ?? filePath;
    const client = this.client;
    if (!client?.isReady()) return { status: "failed", error: "Discord 未连接" };
    try {
      const channel = channelId ? await client.channels.fetch(channelId) : await (await client.users.fetch(userId!)).createDM();
      if (!channel || !("send" in channel) || typeof channel.send !== "function") return { status: "failed", error: "频道不可发送" };
      const sent = await (channel as { send(o: MessageCreateOptions): Promise<Message> }).send({ files: [new AttachmentBuilder(await fs.promises.readFile(lp), { name: fileName })] });
      return { status: "confirmed", messageId: sent.id };
    } catch (e) {
      return { status: "failed", error: (e as Error).message };
    }
  }

  async resolveIncomingFile(file: { fileId: string }): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    return /^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(file.fileId) ? { ok: true, url: file.fileId } : { ok: false, error: "文件标识无效" };
  }

  async getGroupMsgHistory(groupId: string, anchor?: string, limit = 50): Promise<
    { ok: true; messages: NormalizedIncomingMessage[]; hasMore: boolean } | { ok: false; error: string }
  > {
    const client = this.client;
    if (!client?.isReady()) return { ok: false, error: "Discord 未连接" };
    try {
      const ch = await client.channels.fetch(groupId);
      if (!ch || !("messages" in ch)) return { ok: false, error: "不是文字频道" };
      const n = Math.max(1, Math.min(100, limit));
      const got = await ch.messages.fetch(anchor ? { limit: n, after: anchor } : { limit: n });
      const messages = [...got.values()].filter((m) => !m.author.bot).sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map((m) => this.toNormalized(m));
      return { ok: true, messages, hasMore: got.size >= n };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

function splitText(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const out: string[] = [];
  let rest = t;
  while (rest.length > MAX_LEN) {
    let cut = rest.lastIndexOf("\n", MAX_LEN);
    if (cut < MAX_LEN / 2) cut = MAX_LEN;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}
