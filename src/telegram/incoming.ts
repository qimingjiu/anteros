import type { MessageRecord, MessageSegment } from "../types.js";
import { segmentsText } from "../onebot/provider.js";
import { asRecord, numericId, telegramFileId, TELEGRAM_FILE_PROTOCOL } from "./api.js";

interface IncomingOptions {
  accountId: string;
  ownerIds: readonly string[];
  groupAllowlist: readonly string[];
  selfId?: string;
  username?: string;
}

function textSegments(text: string, entities: unknown, opts: IncomingOptions): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let position = 0;
  const mentions = Array.isArray(entities) ? entities : [];
  for (const value of mentions) {
    const entity = asRecord(value);
    if (entity?.type !== "mention" && entity?.type !== "text_mention") continue;
    const { offset, length } = entity;
    if (typeof offset !== "number" || typeof length !== "number" || !Number.isInteger(offset)
      || !Number.isInteger(length) || offset < position || length < 1 || offset + length > text.length) continue;
    const name = text.slice(offset, offset + length);
    const mentioned = entity.type === "text_mention"
      ? numericId(asRecord(entity.user)?.id)
      : opts.selfId && opts.username && name.toLowerCase() === `@${opts.username.toLowerCase()}` ? opts.selfId : undefined;
    if (!mentioned) continue;
    if (offset > position) segments.push({ type: "text", data: { text: text.slice(position, offset) } });
    segments.push({ type: "at", data: { qq: mentioned } });
    position = offset + length;
  }
  if (position < text.length) segments.push({ type: "text", data: { text: text.slice(position) } });
  return segments;
}

function mediaRef(value: unknown): string | undefined {
  const fileId = telegramFileId(asRecord(value)?.file_id);
  return fileId ? TELEGRAM_FILE_PROTOCOL + fileId : undefined;
}

export function telegramMessage(value: unknown, opts: IncomingOptions): MessageRecord | undefined {
  const message = asRecord(asRecord(value)?.message);
  const chat = asRecord(message?.chat);
  const from = asRecord(message?.from);
  const senderId = numericId(from?.id);
  const chatId = numericId(chat?.id, true);
  const messageId = numericId(message?.message_id);
  if (!message || !chat || !from || !senderId || !chatId || !messageId || from.is_bot !== false
    || senderId === opts.selfId || !opts.ownerIds.includes(senderId) || message.sender_chat) return;

  const isGroup = chat.type === "group" || chat.type === "supergroup";
  if (!(isGroup ? chatId.startsWith("-") : chat.type === "private" && chatId === senderId)) return;
  const thread = message.is_topic_message === true ? numericId(message.message_thread_id) : undefined;
  const groupId = isGroup ? thread ? `${chatId}:${thread}` : chatId : undefined;
  if (groupId && !opts.groupAllowlist.includes(groupId)) return;

  const date = message.date;
  if (typeof date !== "number" || !Number.isInteger(date) || date < 1 || date > 8_640_000_000_000) return;
  const conversationId = groupId ? `group_${groupId}` : `private_${senderId}`;
  const replyTo = asRecord(message.reply_to_message);
  const replyToMessageId = replyTo && numericId(asRecord(replyTo.chat)?.id, true) === chatId
    ? numericId(replyTo.message_id) : undefined;
  const segments: MessageSegment[] = [];
  if (replyToMessageId) segments.push({ type: "reply", data: { id: replyToMessageId } });
  const text = typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "";
  segments.push(...textSegments(text, typeof message.text === "string" ? message.entities : message.caption_entities, opts));
  const photo = mediaRef(Array.isArray(message.photo) ? message.photo.at(-1) : undefined);
  if (photo) segments.push({ type: "image", data: { url: photo } });
  const voice = mediaRef(message.voice ?? message.audio);
  if (voice) segments.push({ type: "record", data: { file: voice } });
  const video = mediaRef(message.video ?? message.video_note);
  if (video) segments.push({ type: "video", data: { file: video } });
  const document = asRecord(message.document);
  const fileId = telegramFileId(document?.file_id);
  if (document && fileId) {
    const name = typeof document.file_name === "string" ? document.file_name.replace(/[\\/\x00-\x1f\x7f]/g, "_").slice(0, 180) : "";
    const size = typeof document.file_size === "number" && Number.isSafeInteger(document.file_size) && document.file_size >= 0
      ? document.file_size : undefined;
    segments.push({ type: "file", data: { fileId, name: name || `telegram-${messageId}.bin`, size } });
  }
  if (segments.every(segment => segment.type === "reply")) return;
  const displayName = [from.first_name, from.last_name].filter(part => typeof part === "string").join(" ").trim();
  return {
    eventKey: `${opts.accountId}:${conversationId}:message:${messageId}`,
    accountId: opts.accountId,
    providerId: "telegram",
    conversationId,
    groupId,
    messageId,
    senderId,
    displayNameAtTime: (displayName || (typeof from.username === "string" ? from.username : senderId)).slice(0, 200),
    sentAt: new Date(date * 1000).toISOString(),
    receivedAt: new Date().toISOString(),
    replyToMessageId,
    segments,
    textContent: segmentsText(segments),
    status: "active",
    origin: "live",
  };
}
