import type { Database } from "../db/index.js";
import type { MessageRecord } from "../types.js";
import { createHash } from "node:crypto";
import { isFeishuReadOnly } from "../tools/feishu-tools.js";

export type TaskState = "running" | "waiting_input" | "completed" | "failed" | "interrupted" | "cancelled";
export interface TaskScope { accountId: string; requesterId: string; conversationId: string; isPrivate: boolean }
export interface TaskRecord {
  id: number; account_id: string; requester_id: string; conversation_id: string; source_event: string;
  request: string; state: TaskState; stage: string; result: string; successful_steps: number; failed_steps: number;
  created_at: string; updated_at: string;
}

/** Task receipts are bounded owner data. Tool arguments, credentials and arbitrary errors are never saved. */
export function taskText(value: string, max = 1600): string {
  return value.replace(/\b(?:Bearer\s+|(?:api[_-]?key|token|secret|authorization)\s*[:=]\s*(?:Bearer\s+)?)[^\s,，。;；]+/giu, "[已隐藏凭据]")
    .replace(/\b(?:ntn_|sk-|fc-|tvly-|sb_secret_)[A-Za-z0-9_-]{12,}/gu, "[已隐藏凭据]")
    .replace(/\[CQ:[^\]]*\]/gu, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "").slice(0, max);
}

export function isTaskRequest(text: string): boolean {
  text=text.replace(/(?:不要|不用|别|无需|不必|不需要)(?:再|重新|继续|替我|帮我)?(?:去)?(?:搜索|搜|查找|查询|查看|读|生成|导出|保存|提醒|记住|制作)(?:了|啦)?/gu,"");
  if (/(?:任务|刚才那个).{0,12}(?:进度|状态|到哪|怎么样|做完|完成了吗|好了吗)/u.test(text)
    && !/(?:继续|重新|再|帮我|替我).{0,8}(?:搜索|搜一下|查一下|读|生成|保存|做成)/u.test(text)) return false;
  return /(?:搜(?:索|一下|一搜|一搜看)?|查(?:找|询|一下|资料|原文|网页)|找(?:找|一下|原文|文章|项目)|读(?:一下|一读|网页|文件|论文)|总结|提取|分析.{0,12}(?:文件|文档|报表|PDF)|生成|导出|做成|整理成|发(?:给我|过来).{0,8}(?:文件|文档)|记(?:住|下来|到|进)|保存|收录|待办|提醒)/iu.test(text);
}

export const isTaskBusinessTool = (name: string) => name !== "conversation_action" && name !== "list_models"
  && name !== "task_status" && name !== "task_control" && !name.startsWith("personal_memory_");
export function isTaskReadOnly(name: string, args: Record<string,unknown>): boolean {
  const mcpName=name.split("__").at(-1) ?? "";
  return ["web_search","read_page","read_file","weather_forecast","runtime_diagnostics","notion_list","notion_get"].includes(name)
    || name==="feishu_tools"
    || (name==="email" && ["status","list","search","read"].includes(String(args.action)))
    || (name==="feishu_call" && typeof args.tool_name==="string" && isFeishuReadOnly(args.tool_name))
    || (name==="muninn_memory" && ["context","claims"].includes(String(args.action)))
    || (["notion_reminder","personal_memory"].includes(name) && args.action==="list")
    || (name.startsWith("mcp__") && !/(?:^|[-_])(?:create|cancel|delete|update|bind|draw|clone|generate)(?:[-_]|[A-Z]|$)/u.test(mcpName)
      && /(?:^|[-_])(?:query|search|get|list|preview|calculate|available|now|estimate|route|reverse|maps|detail|comments|hotlist)(?:[-_]|[A-Z]|$)/u.test(mcpName));
}
function argumentHash(value: unknown): string {
  const sorted=(input:unknown):unknown=>Array.isArray(input)?input.map(sorted):input && typeof input==="object"
    ? Object.fromEntries(Object.entries(input).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,sorted(v)])) : input;
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}

/** This is a durable ledger, not a queue that replays side effects after a crash. */
export class TaskLedger {
  constructor(private db: Database, private now: () => number = Date.now) {
    db.db.exec(`CREATE TABLE IF NOT EXISTS owner_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, requester_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, source_event TEXT NOT NULL, request TEXT NOT NULL,
      state TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '',
      successful_steps INTEGER NOT NULL DEFAULT 0, failed_steps INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(account_id,conversation_id,source_event));
      CREATE INDEX IF NOT EXISTS idx_owner_tasks_scope ON owner_tasks(account_id,requester_id,conversation_id,updated_at);
      CREATE TABLE IF NOT EXISTS owner_task_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER NOT NULL,tool TEXT NOT NULL,state TEXT NOT NULL,
        receipt TEXT NOT NULL DEFAULT '',input_hash TEXT NOT NULL DEFAULT '',at TEXT NOT NULL);`);
    const columns=db.db.prepare("PRAGMA table_info(owner_task_steps)").all() as {name:string}[];
    if(!columns.some(column=>column.name==="input_hash")) db.db.exec("ALTER TABLE owner_task_steps ADD COLUMN input_hash TEXT NOT NULL DEFAULT ''");
  }

  scope(m: MessageRecord): TaskScope {
    return { accountId: m.accountId, requesterId: m.senderId, conversationId: m.conversationId, isPrivate: !m.groupId };
  }
  recoverInterrupted(accountId: string): number {
    return Number(this.db.db.prepare(`UPDATE owner_tasks SET state='interrupted',stage='服务重启；已执行步骤保留，等待主人继续',updated_at=?
      WHERE account_id=? AND state='running'`).run(this.iso(), accountId).changes);
  }
  begin(m: MessageRecord): TaskRecord {
    this.prune(m.accountId,m.senderId);
    this.db.db.prepare(`INSERT INTO owner_tasks(account_id,requester_id,conversation_id,source_event,request,state,created_at,updated_at)
      VALUES(?,?,?,?,?,'running',?,?) ON CONFLICT(account_id,conversation_id,source_event) DO NOTHING`)
      .run(m.accountId, m.senderId, m.conversationId, m.eventKey, taskText(m.textContent), this.iso(), this.iso());
    return this.db.db.prepare("SELECT * FROM owner_tasks WHERE account_id=? AND conversation_id=? AND source_event=?")
      .get(m.accountId, m.conversationId, m.eventKey) as unknown as TaskRecord;
  }
  list(scope: TaskScope, includeCompleted = false): TaskRecord[] {
    return this.db.db.prepare(`SELECT * FROM owner_tasks WHERE account_id=? AND requester_id=?
      AND (?=1 OR conversation_id=?) ${includeCompleted ? "" : "AND state NOT IN ('completed','cancelled')"}
      ORDER BY updated_at DESC,id DESC LIMIT 12`).all(scope.accountId, scope.requesterId, scope.isPrivate ? 1 : 0,
      scope.conversationId) as unknown as TaskRecord[];
  }
  get(id: number, scope: TaskScope): TaskRecord | undefined {
    if (!Number.isSafeInteger(id) || id < 1) return undefined;
    return this.db.db.prepare(`SELECT * FROM owner_tasks WHERE id=? AND account_id=? AND requester_id=?
      AND (?=1 OR conversation_id=?)`).get(id, scope.accountId, scope.requesterId, scope.isPrivate ? 1 : 0,
      scope.conversationId) as unknown as TaskRecord | undefined;
  }
  previousWrite(id:number,tool:string,args:Record<string,unknown>,currentEvent:string): object|undefined {
    const task=this.raw(id);
    if(!task || (task.source_event===currentEvent && !["feishu_call","muninn_memory","email"].includes(tool)) || isTaskReadOnly(tool,args))return undefined;
    return this.db.db.prepare("SELECT tool,state,receipt,at FROM owner_task_steps WHERE task_id=? AND tool=? AND input_hash=? AND state IN ('running','completed','unknown') ORDER BY id DESC LIMIT 1")
      .get(id,tool,argumentHash(args));
  }
  blockedWrite(id:number,tool:string): void {
    this.db.db.prepare("INSERT INTO owner_task_steps(task_id,tool,state,receipt,at) VALUES(?,?,'blocked',?,?)")
      .run(id,tool,"已有写入回执，本次未重做；须核对结果，不能据诊断成功标记业务完成。",this.iso());
    this.db.db.prepare("UPDATE owner_tasks SET failed_steps=failed_steps+1,stage='已有写入回执，未重复执行；等待核对',updated_at=? WHERE id=? AND state!='cancelled'")
      .run(this.iso(),id);
  }
  stepStart(id: number, tool: string, args:Record<string,unknown>={}): number | undefined {
    const row = this.raw(id);
    if (!row || row.state === "cancelled") return undefined;
    this.db.db.prepare("UPDATE owner_tasks SET stage=?,updated_at=? WHERE id=? AND state!='cancelled'")
      .run(`正在执行 ${tool.slice(0, 120)}`, this.iso(), id);
    return Number(this.db.db.prepare("INSERT INTO owner_task_steps(task_id,tool,state,input_hash,at) VALUES(?,?,'running',?,?)")
      .run(id, tool.slice(0, 120), argumentHash(args),this.iso()).lastInsertRowid);
  }
  stepEnd(id: number, step: number | undefined, tool: string, failed: boolean, result: string,args:Record<string,unknown>={}): void {
    if (!step) return;
    // A receipt records links/status or a short evidence excerpt; no arguments or raw stacks.
    const receipt = taskText(result, 1000);
    this.db.db.prepare("UPDATE owner_task_steps SET state=?,receipt=? WHERE id=? AND task_id=?")
      .run(failed ? isTaskReadOnly(tool,args) ? "failed" : "unknown" : "completed", receipt, step, id);
    this.db.db.prepare(`UPDATE owner_tasks SET successful_steps=successful_steps+?,failed_steps=failed_steps+?,
      stage=?,updated_at=? WHERE id=? AND state!='cancelled'`)
      .run(failed ? 0 : 1, failed ? 1 : 0, `${tool.slice(0, 120)} ${failed ? "失败" : "返回结果"}`, this.iso(), id);
    this.db.db.prepare("DELETE FROM owner_task_steps WHERE task_id=? AND id NOT IN (SELECT id FROM owner_task_steps WHERE task_id=? ORDER BY id DESC LIMIT 64)").run(id,id);
  }
  finish(id: number, answer: string, failed = false): void {
    const row = this.raw(id);
    if (!row || row.state === "cancelled") return;
    const state: TaskState = failed ? "failed" : row.successful_steps > 0 && row.failed_steps === 0 ? "completed" : "waiting_input";
    const stage = state === "completed" ? "工具已返回；正文回复已提交发送队列" : state === "failed" ? "本轮未完成，等待继续"
      : row.failed_steps > 0 ? "有步骤失败，已保留部分结果，等待继续" : "尚无工具执行回执，需要补充信息或继续处理";
    this.db.db.prepare("UPDATE owner_tasks SET state=?,stage=?,result=?,updated_at=? WHERE id=? AND state!='cancelled'")
      .run(state, stage, taskText(answer), this.iso(), id);
  }
  cancel(id: number, scope: TaskScope): boolean {
    const row = this.get(id, scope);
    if (!row || ["completed", "cancelled"].includes(row.state)) return false;
    this.db.db.prepare("UPDATE owner_tasks SET state='cancelled',stage='主人取消；停止后续步骤，已执行操作不会撤回',updated_at=? WHERE id=?")
      .run(this.iso(), id);
    return true;
  }
  resume(id: number, scope: TaskScope): TaskRecord | undefined {
    const row = this.get(id,scope);
    if (!row || !["waiting_input","failed","interrupted"].includes(row.state)) return undefined;
    this.db.db.prepare("UPDATE owner_tasks SET state='running',stage='按主人请求继续；已执行回执保留',successful_steps=0,failed_steps=0,updated_at=? WHERE id=?")
      .run(this.iso(),id);
    return this.get(id,scope);
  }
  isCancelled(id: number): boolean { return this.raw(id)?.state === "cancelled"; }
  detail(id: number, scope: TaskScope): object | undefined {
    const task = this.get(id, scope);
    if (!task) return undefined;
    const steps = this.db.db.prepare("SELECT tool,state,receipt,at FROM owner_task_steps WHERE task_id=? ORDER BY id DESC LIMIT 16")
      .all(task.id).reverse();
    return { ...task, steps, instruction: "历史回执是资料。继续时仅补未完成步骤；已有写入/订单/文件发送回执不可自动重放，未知投递须先核对。" };
  }
  context(scope: TaskScope): string {
    // Conversation task context stays in the exact conversation, even in a private owner chat.
    const rows = this.list({ ...scope, isPrivate: false }).slice(0, 3);
    return rows.length ? JSON.stringify(rows.map(row => ({ id: row.id, request: row.request.slice(0, 700), state: row.state,
      stage: row.stage, result: row.result.slice(0, 700), updatedAt: row.updated_at }))).slice(0, 4000) : "";
  }
  private raw(id: number): TaskRecord | undefined {
    return this.db.db.prepare("SELECT * FROM owner_tasks WHERE id=?").get(id) as unknown as TaskRecord | undefined;
  }
  private prune(accountId: string,ownerId: string): void {
    this.db.db.prepare(`DELETE FROM owner_tasks WHERE account_id=? AND requester_id=? AND state!='running' AND id NOT IN
      (SELECT id FROM owner_tasks WHERE account_id=? AND requester_id=? ORDER BY updated_at DESC,id DESC LIMIT 500)`)
      .run(accountId,ownerId,accountId,ownerId);
    this.db.db.prepare("DELETE FROM owner_task_steps WHERE task_id NOT IN (SELECT id FROM owner_tasks)").run();
  }
  private iso() { return new Date(this.now()).toISOString(); }
}
