import type { Database, DBRow_Message } from "../db/index.js";
import type { MessageRecord } from "../types.js";
import { messageImageUrls } from "./image-context.js";
import type { RecentGroupReply } from "./reply-limits.js";

const faceIds = (record: MessageRecord): string[] => record.segments
  .flatMap(segment => segment.type === "face" ? [String(segment.data.id).slice(0, 40)] : []).slice(0, 10);

/** 所有回复路径共用近期原文，补足 @、私聊与自动接话中的指代和追问。 */
export function conversationContext(db: Database, message: MessageRecord, selfId: string | undefined, maxChars = 6000, includeQueuedBotReplies = false): string {
  const budget = Math.floor(Math.max(512, Math.min(20_000, Number.isFinite(maxChars) ? maxChars : 6000)));
  const pastRows = db.recentMessages(message.conversationId, 80, message.sentAt);
  const newerBotRows = includeQueuedBotReplies && selfId ? db.recentMessages(message.conversationId, 20, new Date().toISOString())
    .filter(row => row.sender_id === selfId && row.sent_at > message.sentAt) : [];
  const rows = [...new Map([...pastRows,...newerBotRows].map(row=>[row.id,row])).values()]
    .sort((a,b)=>b.sent_at.localeCompare(a.sent_at)||b.id-a.id)
    .filter(row => row.account_id === message.accountId && row.conversation_id === message.conversationId
      && (row.group_id ?? undefined) === message.groupId && row.message_id !== message.messageId
      && row.status === "active" && (Boolean(row.text_content.trim())
        || messageImageUrls(db.rowToRecord(row)).length > 0 || faceIds(db.rowToRecord(row)).length > 0))
    .slice(0, 24);
  const parts: string[] = [];
  let used = 2;
  for (const row of rows) {
    const record = db.rowToRecord(row);
    const entry = {
      messageId: record.messageId.slice(0, 100),
      at: record.sentAt,
      senderId: record.senderId.slice(0, 100),
      name: record.senderId === selfId ? "（你自己）" : record.displayNameAtTime.slice(0, 100),
      mentions: record.segments.filter(s => s.type === "at").map(s => String(s.data.qq)).slice(0, 10),
      replyTo: record.replyToMessageId,
      imageCount: messageImageUrls(record).length,
      faceIds: faceIds(record),
      text: record.textContent.slice(0, 1600),
    };
    const available = budget - used - (parts.length ? 1 : 0);
    let encoded = JSON.stringify(entry);
    while (encoded.length > available && entry.text.length) {
      entry.text = entry.text.slice(0, Math.max(0, entry.text.length - (encoded.length - available)));
      encoded = JSON.stringify(entry);
    }
    if ((!entry.text && !entry.imageCount && !entry.faceIds.length) || encoded.length > available) break;
    parts.push(encoded);
    used += encoded.length + (parts.length > 1 ? 1 : 0);
  }
  return parts.length ? `[${parts.reverse().join(",")}]` : "";
}

/** Keep the active sender's request visible when a busy group fills the shared transcript. */
export function senderConversationContext(db: Database, message: MessageRecord, replies: RecentGroupReply[], maxChars = 3000): string {
  const budget = Math.max(512, Math.min(4000, Math.floor(maxChars)));
  const cutoff = Date.parse(message.sentAt) - 10 * 60_000;
  const current = db.getMessageByEventKey(message.eventKey);
  const currentId = current?.account_id === message.accountId && current.conversation_id === message.conversationId
    && current.sender_id === message.senderId ? current.id : null;
  // Filter identity in SQL before LIMIT, so hundreds of intervening messages
  // from other people cannot evict this sender's unfinished request.
  const rows = db.db.prepare(`SELECT * FROM messages WHERE account_id = ? AND conversation_id = ?
    AND group_id IS ? AND sender_id = ? AND status = 'active' AND message_id != ?
    AND sent_at >= ? AND (sent_at < ? OR (sent_at = ? AND (? IS NULL OR id < ?)))
    ORDER BY sent_at DESC, id DESC LIMIT 8`).all(message.accountId, message.conversationId, message.groupId ?? null,
    message.senderId, message.messageId, new Date(cutoff).toISOString(), message.sentAt, message.sentAt, currentId, currentId) as unknown as DBRow_Message[];
  const turns = rows
    .map(row => ({ at: row.sent_at, role: "user", text: row.text_content.slice(0, 1200),
      imageCount: messageImageUrls(db.rowToRecord(row)).length, replySubmittedAfterCurrentMessage: false }));
  turns.push(...replies.filter(reply => reply.senderId === message.senderId && reply.sentAt >= cutoff).slice(0, 5)
    .map(reply => ({ at: new Date(reply.sentAt).toISOString(), role: "assistant", text: reply.text.slice(0, 1200),
      imageCount: 0, replySubmittedAfterCurrentMessage: reply.sentAt > Date.parse(message.receivedAt) })));
  turns.sort((a, b) => b.at.localeCompare(a.at));
  const kept: typeof turns = [];
  for (const turn of turns) {
    const available = budget - JSON.stringify(kept).length - 1;
    const entry = { ...turn };
    while (JSON.stringify(entry).length > available && entry.text.length) {
      entry.text = entry.text.slice(0, Math.max(0, entry.text.length - (JSON.stringify(entry).length - available)));
    }
    if (JSON.stringify(entry).length > available) break;
    if (!entry.text && !entry.imageCount) continue;
    kept.push(entry);
  }
  return kept.length ? JSON.stringify(kept.reverse()) : "";
}
