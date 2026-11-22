import type { Database } from "../db/index.js";
import type { MessageRecord, Provider, ToolDef } from "../types.js";
import { logger } from "../util/logger.js";

const log = logger("recall");

/** recall_message: let the owner have the bot take back messages (OneBot delete_msg / Discord delete). */
export class RecallTools {
  constructor(private deps: { provider: Provider; db: Database; ownerIds: string[] }) {}

  toolsFor(m: MessageRecord): ToolDef[] {
    const p = this.deps.provider;
    if (!p.deleteMessage || !this.deps.ownerIds.includes(m.senderId)) return [];
    return [{
      name: "recall_message",
      description: "撤回消息（仅主人可用）。target=last 撤回你自己在当前会话最近发的 count 条（默认1条）；target=replied 撤回主人这条消息引用的那条（你的或群友的，群友的需要你是管理员）；也可以直接给 message_id。QQ 普通成员只能撤回2分钟内自己的消息。撤回后不要再复述被撤回的内容。",
      inputSchema: { type: "object", properties: {
        target: { type: "string", enum: ["last", "replied"] },
        count: { type: "integer", minimum: 1, maximum: 5 },
        message_id: { type: "string", maxLength: 40 },
      }, additionalProperties: false },
      execute: async (args) => JSON.stringify(await this.run(m, args)),
    }];
  }

  private async run(m: MessageRecord, args: Record<string, unknown>): Promise<object> {
    const { db, provider } = this.deps;
    const selfId = provider.health().selfId;
    let ids: string[] = [];
    if (typeof args.message_id === "string" && args.message_id.trim()) ids = [args.message_id.trim()];
    else if (args.target === "replied") {
      if (!m.replyToMessageId) return { ok: false, reason: "这条消息没有引用任何消息" };
      ids = [m.replyToMessageId];
    } else {
      const n = Math.min(5, Math.max(1, Number(args.count ?? 1) || 1));
      ids = db.recentMessages(m.conversationId, 60, new Date().toISOString(), m.accountId)
        .filter(r => r.sender_id === selfId && r.status === "active" && r.account_id === m.accountId && !r.message_id.startsWith("call-"))
        .slice(0, n).map(r => r.message_id);
      if (!ids.length) return { ok: false, reason: "当前会话里找不到你最近发的消息" };
    }
    const done: string[] = [], failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      const r = await provider.deleteMessage!({ conversationId: m.conversationId, groupId: m.groupId, userId: m.groupId ? undefined : m.senderId, messageId: id })
        .catch((e: Error) => ({ ok: false as const, error: e.message }));
      if (r.ok) { done.push(id); try { db.markRecalled(m.conversationId, id, m.accountId); } catch { /* ignore */ } }
      else failed.push({ id, error: r.error });
    }
    log.info(`撤回 ${done.length}/${ids.length}`, { conversationId: m.conversationId, failed });
    return { ok: failed.length === 0, recalled: done.length, failed };
  }
}
