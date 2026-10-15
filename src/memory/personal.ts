import type { Database } from "../db/index.js";
import type { MessageRecord, ToolDef } from "../types.js";
import { taskText } from "../tasks/index.js";

type Visibility = "private" | "current_group" | "shared";
interface PersonalRow { id: number; account_id: string; owner_id: string; content: string; visibility: Visibility;
  group_ids: string; source_conversation: string; source_message_id: string; created_at: string; updated_at: string }

/** Explicit owner preferences. Private conversations never become public history by default. */
export class PersonalMemory {
  constructor(private db: Database, private allowedGroups: readonly string[]) {
    db.db.exec(`CREATE TABLE IF NOT EXISTS personal_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,owner_id TEXT NOT NULL,content TEXT NOT NULL,
      visibility TEXT NOT NULL,group_ids TEXT NOT NULL,source_conversation TEXT NOT NULL,source_message_id TEXT NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_personal_memories_owner ON personal_memories(account_id,owner_id,updated_at);`);
  }
  private visible(row: PersonalRow, m: MessageRecord): boolean {
    if (row.account_id !== m.accountId || row.owner_id !== m.senderId) return false;
    if (!m.groupId) return true;
    return this.allowedGroups.includes(m.groupId) && row.visibility !== "private"
      && (JSON.parse(row.group_ids) as string[]).includes(m.groupId);
  }
  list(m: MessageRecord, query = ""): object[] {
    return this.rows(m).filter(row => this.visible(row, m) && (!query || row.content.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
      .slice(0, 30).map(row => this.presentation(row));
  }
  context(m: MessageRecord): string {
    const visible = this.rows(m).filter(row => this.visible(row, m)).slice(0, 12);
    return visible.length ? JSON.stringify(visible.map(row => ({ id: row.id, content: row.content,
      visibility: row.visibility, sourceMessage: row.source_message_id }))).slice(0, 6000) : "";
  }
  tool(m: MessageRecord): ToolDef {
    return { name: "personal_memory", description: "管理主人明确要求长期保留的个人偏好、约定和计划。action=list/save/update/delete。私聊默认私有，群聊默认仅当前群；shared仅主人本条明确说可跨私聊和获准群共享时使用。群里不能查询或修改私有记忆。返回编号、来源和可见范围。普通资料收藏、网站和待办优先Notion；不自动把闲聊存为记忆。",
      inputSchema: { type: "object", properties: {
        action: { type: "string", enum: ["list", "save", "update", "delete"] }, id: { type: "integer", minimum: 1 },
        content: { type: "string", maxLength: 1200 }, query: { type: "string", maxLength: 100 },
        visibility: { type: "string", enum: ["private", "current_group", "shared"] },
      }, required: ["action"], additionalProperties: false },
      execute: async args => {
        if (Object.keys(args).some(k => !["action", "id", "content", "query", "visibility"].includes(k))) return JSON.stringify({status:"error",error:"invalid_input"});
        if (args.action === "list") return JSON.stringify({status:"ok",entries:this.list(m, typeof args.query === "string" ? args.query.slice(0,100) : "")});
        const currentText=m.segments.filter(segment=>segment.type==="text").map(segment=>segment.data.text).join(" ");
        const actionWords=args.action==="save" ? /(?:记住|记下|记着|长期记|保存)/u
          : args.action==="update" ? /(?:更新|修改|改成|改为|更正|纠正|替换)/u
          : /(?:忘掉|忘记|删除|删掉|清除|不要再记|不再记)/u;
        const negated=args.action==="delete" ? /(?:不要|不用|别|不许|不能|无需).{0,5}(?:删除|删掉|忘掉|忘记|清除)/u.test(currentText)
          : /(?:不要|不用|别|不许|不能|无需).{0,5}(?:记住|记下|保存|更新|修改|更正)/u.test(currentText);
        const explicit = actionWords.test(currentText) && !negated;
        if (!explicit) return JSON.stringify({status:"error",error:"需要主人本条明确要求保存、修改或删除个人记忆"});
        const id = typeof args.id === "number" && Number.isSafeInteger(args.id) ? args.id : 0;
        const row = id ? this.rows(m).find(item => item.id === id && this.visible(item,m)) : undefined;
        if (args.action === "delete") {
          if (!row) return JSON.stringify({status:"error",error:"没有可操作的该编号记忆"});
          this.db.db.prepare("DELETE FROM personal_memories WHERE id=? AND account_id=? AND owner_id=?").run(id,m.accountId,m.senderId);
          return JSON.stringify({status:"deleted",id});
        }
        if (args.action !== "save" && args.action !== "update") return JSON.stringify({status:"error",error:"invalid_action"});
        if (args.action === "update" && !row) return JSON.stringify({status:"error",error:"没有可操作的该编号记忆"});
        if (typeof args.content !== "string" || !args.content.trim() || args.content.length > 1200) return JSON.stringify({status:"error",error:"记忆内容必须为1至1200字符"});
        const visibility = args.visibility ?? row?.visibility ?? (m.groupId ? "current_group" : "private");
        if (!["private","current_group","shared"].includes(String(visibility))) return JSON.stringify({status:"error",error:"invalid_visibility"});
        const sharingDenied=/(?:不要|不用|别|不许|不能|不准|无需|不想|不).{0,12}(?:共享|公开|跨|群)|(?:仅|只|限).{0,6}(?:私聊|我和你|这里|这个群|本群)/u.test(currentText);
        if (visibility === "shared" && (sharingDenied || (row?.visibility !== "shared"
          && !/(?:群里也|群聊也|所有.{0,5}群|跨.{0,8}(?:会话|窗口|群)|私聊.{0,12}群|群.{0,12}私聊|共享|全局|所有会话|到哪里都记得)/u.test(currentText))))
          return JSON.stringify({status:"error",error:"跨会话共享需要主人明确授权；可以先按当前会话范围保存"});
        if (visibility === "current_group" && !m.groupId && row?.visibility !== "current_group") return JSON.stringify({status:"error",error:"私聊中不能猜测要共享到哪个群"});
        // A group request cannot turn a visible group preference into a hidden/private one that it can no longer inspect.
        const groups = visibility === "private" ? [] : visibility === "shared" ? [...this.allowedGroups]
          : m.groupId ? [m.groupId] : JSON.parse(row!.group_ids) as string[];
        if (m.groupId && visibility !== "private" && !this.allowedGroups.includes(m.groupId)) return JSON.stringify({status:"error",error:"group_not_allowed"});
        const content = taskText(args.content.trim(),1200), now = new Date().toISOString();
        if (row) this.db.db.prepare("UPDATE personal_memories SET content=?,visibility=?,group_ids=?,updated_at=? WHERE id=?")
          .run(content,String(visibility),JSON.stringify(groups),now,row.id);
        else {
          const existing = this.rows(m).find(item => item.content === content && item.visibility === visibility && item.group_ids === JSON.stringify(groups));
          if (existing) return JSON.stringify({status:"saved",entry:this.presentation(existing),reused:true});
          if (this.rows(m).length >= 200) return JSON.stringify({status:"error",error:"个人记忆已达200条，请先整理旧记忆"});
          const inserted = this.db.db.prepare(`INSERT INTO personal_memories(account_id,owner_id,content,visibility,group_ids,source_conversation,source_message_id,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(m.accountId,m.senderId,content,String(visibility),JSON.stringify(groups),m.conversationId,m.messageId,now,now);
          return JSON.stringify({status:"saved",entry:this.presentation(this.rows(m).find(item => item.id === Number(inserted.lastInsertRowid))!)});
        }
        return JSON.stringify({status:"updated",entry:this.presentation(this.rows(m).find(item => item.id === row.id)!)});
      } };
  }
  private presentation(row: PersonalRow): object {
    return { id:row.id,content:row.content,visibility:row.visibility,groupIds:JSON.parse(row.group_ids),
      sourceConversation:row.source_conversation,sourceMessageId:row.source_message_id,createdAt:row.created_at,updatedAt:row.updated_at };
  }
  private rows(m: MessageRecord): PersonalRow[] {
    return this.db.db.prepare("SELECT * FROM personal_memories WHERE account_id=? AND owner_id=? ORDER BY updated_at DESC,id DESC LIMIT 200")
      .all(m.accountId,m.senderId) as unknown as PersonalRow[];
  }
}
