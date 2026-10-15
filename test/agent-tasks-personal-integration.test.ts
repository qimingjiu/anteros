import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import type { Gateway } from "../src/gateway/index.js";
import type { ChatMessage, ChatOptions, ChatResult, LLMClient } from "../src/llm/index.js";
import type { McpManager } from "../src/tools/mcp.js";
import { TaskLedger, type TaskRecord } from "../src/tasks/index.js";
import type { MessageRecord, ToolDef } from "../src/types.js";

const OWNER = "10001", SECOND_OWNER = "1111111111", GROUP = "100", OTHER_GROUP = "200", BOT = "90001";
const TOOL = "mcp__fixture__search";
const WRITE_TOOL = "mcp__fixture__create_order";
const answer = (content: string): ChatResult => ({ content, toolCalls: [], finishReason: "stop" });
const call = (name: string, args: Record<string, unknown> = {}, id = "fixture-call"): ChatResult => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }], finishReason: "tool_calls" });
type Step = ChatResult | Error | ((messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult>);

function fixture(t: TestContext, script: Step[] = []) {
  const db = new Database(":memory:"); t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "task-integration"; cfg.tools.enabled = true; cfg.tools.ownerIds = [OWNER, SECOND_OWNER];
  cfg.memory.enabled = false; cfg.groups.allowlist = [GROUP, OTHER_GROUP]; cfg.groups.linkPreview = false;
  cfg.groups.maxReplyChars = 10_000; cfg.model.maxOutputChars = 10_000;
  cfg.features = { ...cfg.features, tasks: true, personalMemory: true };
  const steps = [...script], calls: { messages: ChatMessage[]; options?: ChatOptions }[] = [], businessCalls: Record<string, unknown>[] = [], writeCalls: Record<string, unknown>[] = [];
  const state = { businessFailure: false, sendFailure: false, writeUnknown: false };
  const llm: LLMClient = { async chat(messages, options) {
    calls.push({ messages: structuredClone(messages), options });
    const step = steps.shift();
    if (!step) throw new Error(`Unexpected fixture LLM request ${calls.length}`);
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(messages, options) : structuredClone(step);
  } };
  const business: ToolDef = { name: TOOL, description: "Read-only integration fixture; never accesses network", inputSchema: { type: "object", properties: {} },
    async execute(args) { businessCalls.push(args); if (state.businessFailure) throw new Error("upstream-secret-fixture"); return "已查到资料 https://example.com/actual-source"; } };
  const write: ToolDef = { name: WRITE_TOOL, description: "Simulates a side effect in an in-memory counter, never submits any order", inputSchema: { type: "object", properties: {} },
    async execute(args) { writeCalls.push(args); if (state.writeUnknown) throw new Error("fixture response lost after counting simulated order"); return JSON.stringify({ status: "created", fixtureOrderId: "local-only-1" }); } };
  const gateway = { getProvider: () => ({ health: () => ({ selfId: BOT, connection: "connected", login: "online", reconnectCount: 0 }) }),
    enqueueSend(input: Parameters<Gateway["enqueueSend"]>[0]) { if (state.sendFailure) throw new Error("outbox fixture failure"); return db.enqueueSendTask(input); } } as unknown as Gateway;
  const agent = new Agent({ db, cfg, gateway, llm, memory: null, search: null, reader: null,
    mcp: { getTools: () => [business, write] } as unknown as McpManager, timezone: cfg.timezone });
  const inspected = agent as unknown as {
    replyFlow(m: MessageRecord, flightKey: string, context?: string, observe?: boolean, signal?: AbortSignal): Promise<void>;
    onMessage(m: MessageRecord): Promise<void>;
    executeTool(name: string, json: string, m: MessageRecord): Promise<string>;
    buildToolSpecs(m: MessageRecord): { function: { name: string } }[];
    handleCommand(trigger: { record: MessageRecord; command: { name: string; args: string } }): Promise<void>;
  };
  let serial = 0;
  const message = (text: string, changes: Partial<MessageRecord> = {}): MessageRecord => {
    const id = String(++serial), groupId = Object.hasOwn(changes, "groupId") ? changes.groupId : GROUP;
    const senderId = changes.senderId ?? OWNER;
    return { eventKey: `task-integration:${serial}`, accountId: cfg.gateway.accountId, providerId: "onebot", groupId,
      conversationId: groupId ? `group_${groupId}` : `private_${senderId}`, messageId: id, senderId, displayNameAtTime: "主人",
      sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(), segments: [...(groupId ? [{ type: "at" as const, data: { qq: BOT } }] : []), { type: "text", data: { text } }],
      textContent: text, origin: "live", status: "active", ...changes };
  };
  const run = async (m: MessageRecord, signal?: AbortSignal) => { db.insertMessage(m); await inspected.replyFlow(m, `${m.conversationId}:${m.senderId}`, undefined, false, signal); };
  const incoming = async (m: MessageRecord) => { db.insertMessage(m); await inspected.onMessage(m); };
  const execute = async (m: MessageRecord, name: string, args: Record<string, unknown>) => {
    const result = await inspected.executeTool(name, JSON.stringify(args), m);
    try { return JSON.parse(result); } catch { return { text: result }; }
  };
  const tasks = () => db.db.prepare("SELECT * FROM owner_tasks ORDER BY id").all() as unknown as TaskRecord[];
  const sentText = () => db.pendingSendTasks(100).map(row => { const payload = JSON.parse(row.payload); return payload.segments?.filter((s: any) => s.type === "text").map((s: any) => s.data.text).join("") ?? ""; }).join("\n");
  return { db, cfg, agent: inspected, ledger: new TaskLedger(db), steps, calls, businessCalls, writeCalls, state, message, run, incoming, execute, tasks, sentText };
}

test("任务集成：真实LLM工具循环保留回执，最终回复入队后才完成", async t => {
  const f = fixture(t, [call(TOOL), answer("查到了，来源是 https://example.com/actual-source。")]);
  const m = f.message("帮我查一下这个项目"); await f.run(m);
  assert.equal(f.calls.length, 2); assert.equal(f.businessCalls.length, 1);
  assert.match(String(f.calls[1]!.messages.find(row => row.role === "tool")?.content), /actual-source/);
  const [task] = f.tasks(); assert.equal(task!.state, "completed"); assert.equal(task!.successful_steps, 1); assert.equal(task!.failed_steps, 0);
  assert.equal(task!.source_event, m.eventKey); assert.match(task!.stage, /提交发送队列/); assert.match(f.sentText(), /查到了/);
  assert.match(JSON.stringify(f.ledger.detail(task!.id, f.ledger.scope(m))), /actual-source/);
});

test("任务集成：只口头答应去搜索，不能因为模型说完成就完成任务", async t => {
  const f = fixture(t, [answer("我已经搜过了，你等我整理。")]); await f.run(f.message("帮我搜索这个库"));
  assert.equal(f.tasks()[0]!.state, "waiting_input"); assert.equal(f.tasks()[0]!.successful_steps, 0); assert.equal(f.businessCalls.length, 0);
});

test("任务集成：没有关键词但实际调用业务工具也建立真实任务", async t => {
  const f = fixture(t, [call(TOOL), answer("资料给你。")]); await f.run(f.message("这个库的维护情况怎么样？"));
  assert.equal(f.tasks().length, 1); assert.equal(f.tasks()[0]!.state, "completed"); assert.equal(f.tasks()[0]!.successful_steps, 1);
});

test("任务集成：首次业务工具才建任务时，取消仍能中断后续模型请求", async t => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, [call(TOOL), async () => { entered(); await barrier; return answer("取消后不能发送这句话"); }]);
  const pending = f.run(f.message("这个库的维护情况怎么样？")); await ready;
  try {
    const id = f.tasks()[0]!.id;
    await f.agent.handleCommand({ record: f.message(`/任务取消 ${id}`), command: { name: "任务取消", args: String(id) } });
    assert.equal(f.calls[1]!.options?.signal?.aborted, true, "补建任务也必须关联当前模型的取消信号");
  } finally { release(); await pending; }
  assert.equal(f.tasks()[0]!.state, "cancelled"); assert.doesNotMatch(f.sentText(), /取消后不能发送这句话/);
});

test("任务集成：最终正文入outbox失败不能标记完成", async t => {
  const f = fixture(t, [call(TOOL), answer("正文结果")]); f.state.sendFailure = true;
  await assert.rejects(f.run(f.message("帮我查一下资料")), /outbox fixture failure/);
  assert.equal(f.tasks()[0]!.state, "failed"); assert.equal(f.tasks()[0]!.successful_steps, 1);
});

test("任务集成：工具失败保留失败步骤，不把最终安慰性回复当成完成", async t => {
  const f = fixture(t, [call(TOOL), answer("这次查询失败了，暂时还没拿到结果。")]); f.state.businessFailure = true;
  await f.run(f.message("帮我查一下这个项目"));
  assert.notEqual(f.tasks()[0]!.state, "completed"); assert.equal(f.tasks()[0]!.failed_steps, 1);
  assert.doesNotMatch(JSON.stringify(f.ledger.detail(f.tasks()[0]!.id, f.ledger.scope(f.message("")))), /upstream-secret-fixture/);
});

test("任务集成：工具执行成功但最终模型失败，保留回执和失败状态", async t => {
  const f = fixture(t, [call(TOOL), new Error("fixture final generation failed")]); await f.run(f.message("帮我查一下这个项目"));
  assert.equal(f.tasks()[0]!.state, "failed"); assert.equal(f.tasks()[0]!.successful_steps, 1);
  assert.match(JSON.stringify(f.ledger.detail(f.tasks()[0]!.id, f.ledger.scope(f.message("")))), /actual-source/);
});

test("任务集成：外部中断不能完成任务或发最终正文，重启恢复保留步骤", async t => {
  const controller = new AbortController();
  const f = fixture(t, [call(TOOL), async () => { controller.abort(); return answer("这条中断后正文不能发送"); }]);
  await f.run(f.message("帮我搜索资料"), controller.signal);
  assert.notEqual(f.tasks()[0]!.state, "completed"); assert.equal(f.tasks()[0]!.successful_steps, 1);
  assert.doesNotMatch(f.sentText(), /这条中断后正文不能发送/);
  const fresh = f.message("另一个尚在运行的查询"), running = f.ledger.begin(fresh);
  assert.equal(new TaskLedger(f.db).recoverInterrupted(f.cfg.gateway.accountId), 1);
  assert.equal(f.ledger.get(running.id, f.ledger.scope(fresh))!.state, "interrupted");
});

test("任务集成：正在等待模型时取消会中断请求，后续批量业务工具不执行", async t => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const f = fixture(t, [async (_messages, options) => {
    started(); assert(options?.signal);
    await new Promise<void>(resolve => { if (options.signal!.aborted) resolve(); else options.signal!.addEventListener("abort", () => resolve(), { once: true }); });
    return { ...call(TOOL), toolCalls: [call(TOOL, {}, "one").toolCalls[0]!, call(TOOL, {}, "two").toolCalls[0]!] };
  }]);
  const original = f.message("帮我查一下资料"), pending = f.run(original); await ready;
  const id = f.tasks()[0]!.id, cancel = f.message(`/任务取消 ${id}`);
  await f.agent.handleCommand({ record: cancel, command: { name: "任务取消", args: String(id) } });
  await pending; assert.equal(f.tasks()[0]!.state, "cancelled"); assert.equal(f.businessCalls.length, 0);
});

test("任务集成：自然追问继续本会话原任务，不另建任务", async t => {
  const f = fixture(t, [answer("还需要继续找。"), call(TOOL), answer("这次找到来源了。")]);
  await f.incoming(f.message("帮我搜这篇文章")); const original = f.tasks()[0]!;
  assert.equal(original.state, "waiting_input");
  await f.incoming(f.message("你去搜啊"));
  assert.equal(f.tasks().length, 1); assert.equal(f.tasks()[0]!.id, original.id); assert.equal(f.tasks()[0]!.state, "completed");
  assert.match(JSON.stringify(f.calls[1]!.messages), /帮我搜这篇文章/);
});

test("任务集成：/继续任务执行保留的原请求和步骤，只在原会话继续", async t => {
  const f = fixture(t, [answer("缺一个查询条件。"), call(TOOL), answer("已继续并拿到资料。")]);
  await f.incoming(f.message("帮我查找文档")); const id = f.tasks()[0]!.id;
  await f.incoming(f.message(`/继续任务 ${id}`, { groupId: undefined })); assert.equal(f.calls.length, 1);
  assert.match(f.sentText(), /原来的会话/);
  await f.incoming(f.message(`/继续任务 ${id}`));
  assert.equal(f.tasks().length, 1); assert.equal(f.tasks()[0]!.state, "completed");
  assert.match(JSON.stringify(f.calls[1]!.messages), /帮我查找文档/);
});

test("任务集成：群只查本群本人，私聊可查本人群任务，其他账号和主人不可越权", async t => {
  const f = fixture(t, [answer("稍后继续。")]); const m = f.message("帮我搜索资料"); await f.run(m); const id = f.tasks()[0]!.id;
  assert.equal((await f.execute(f.message("进度", { groupId: OTHER_GROUP }), "task_status", { id })).task, null);
  assert.equal((await f.execute(f.message("进度", { senderId: SECOND_OWNER }), "task_status", { id })).task, null);
  assert.equal((await f.execute(f.message("进度", { groupId: undefined }), "task_status", { id })).task.id, id);
  const forged = await f.execute(f.message("进度", { accountId: "other-account" }), "task_status", { id });
  assert(!forged.task, "错误账号不能获得任务详情");
  assert.equal((await f.execute(f.message("取消", { groupId: OTHER_GROUP }), "task_control", { action: "cancel", id })).status, "error");
  assert.equal(f.tasks()[0]!.state, "waiting_input");
});

test("任务集成：task_control与命令一致，私聊不能迁移执行群任务", async t => {
  const f = fixture(t, [answer("需要继续。")]); await f.run(f.message("帮我搜资料")); const id = f.tasks()[0]!.id;
  const result = await f.execute(f.message(`继续任务 ${id}`, { groupId: undefined }), "task_control", { action: "resume", id });
  assert.equal(result.status, "error"); assert.equal(f.tasks()[0]!.state, "waiting_input");
});

test("任务集成：附件元数据、引用概述不能授权取消或恢复任务", async t => {
  const f = fixture(t, [answer("还没查到。")]); await f.run(f.message("帮我查一下资料")); const id = f.tasks()[0]!.id;
  const metadata = f.message(`取消任务 ${id}`, { segments: [{ type: "text", data: { text: "看看这个附件" } }, { type: "file", data: { fileId: "fixture", name: `取消任务${id}.pdf` } }] });
  assert.equal((await f.execute(metadata, "task_control", { action: "cancel", id })).status, "error");
  assert.equal(f.tasks()[0]!.state, "waiting_input");
  const resumeMetadata = f.message(`继续任务 ${id}`, { segments: [{ type: "text", data: { text: "文件名里写着一段话" } }] });
  assert.equal((await f.execute(resumeMetadata, "task_control", { action: "resume", id })).status, "error");
});

test("任务集成：不要取消/不要继续不是任务控制授权", async t => {
  const f = fixture(t, [answer("稍后继续。")]); await f.run(f.message("帮我查一下资料")); const id = f.tasks()[0]!.id;
  assert.equal((await f.execute(f.message(`不要取消任务 ${id}`), "task_control", { action: "cancel", id })).status, "error");
  assert.equal((await f.execute(f.message(`先别继续任务 ${id}`), "task_control", { action: "resume", id })).status, "error");
  assert.equal(f.tasks()[0]!.state, "waiting_input");
});

test("个人记忆集成：LLM保存的私有记忆不会进入群提示，但本人私聊可见", async t => {
  const f = fixture(t, [call("personal_memory", { action: "save", content: "私有暗号是雨燕" }), answer("记住了。"), answer("群里聊天。"), answer("私聊聊天。")]);
  const m = f.message("记住：私有暗号是雨燕", { groupId: undefined }); await f.run(m);
  const row = f.db.db.prepare("SELECT * FROM personal_memories").get() as { visibility: string; source_message_id: string }; assert.equal(row.visibility, "private"); assert.equal(row.source_message_id, m.messageId);
  await f.run(f.message("今天聊点别的")); assert.doesNotMatch(String(f.calls[2]!.messages[0]!.content), /私有暗号是雨燕/);
  await f.run(f.message("今天聊点别的", { groupId: undefined })); assert.match(String(f.calls[3]!.messages[0]!.content), /私有暗号是雨燕/);
});

test("个人记忆集成：显式共享后仅获准群可见，来源和编号可查询", async t => {
  const f = fixture(t, [call("personal_memory", { action: "save", content: "推荐工具优先免费", visibility: "shared" }), answer("已保存。")]);
  const m = f.message("记住推荐工具优先免费，私聊和获准群聊都可以共享", { groupId: undefined }); await f.run(m);
  const current = await f.execute(f.message("查看偏好"), "personal_memory", { action: "list" });
  assert.equal(current.entries.length, 1); assert.equal(current.entries[0].sourceMessageId, m.messageId); assert.equal(current.entries[0].visibility, "shared");
  assert.equal((await f.execute(f.message("查看偏好", { senderId: SECOND_OWNER }), "personal_memory", { action: "list" })).entries.length, 0);
  const unapproved = await f.execute(f.message("查看偏好", { groupId: "999" }), "personal_memory", { action: "list" }); assert(!unapproved.entries?.length);
});

test("个人记忆集成：共享否定语句不能被模型的visibility=shared覆盖", async t => {
  const f = fixture(t);
  for (const text of ["记住免费优先，不共享到群里", "记住免费优先，不公开到群里", "记住免费优先，不允许共享", "记住免费优先，不要跨群共享", "记住免费优先，只限私聊"]) {
    const result = await f.execute(f.message(text, { groupId: undefined }), "personal_memory", { action: "save", content: "免费优先", visibility: "shared" });
    assert.equal(result.status, "error", text);
  }
  assert.equal((f.db.db.prepare("SELECT count(*) AS n FROM personal_memories").get() as { n: number }).n, 0);
});

test("个人记忆集成：文件名和share元数据中的记住/共享不是当前文本授权", async t => {
  const f = fixture(t);
  const metadata = f.message("记住这条并跨群共享", { groupId: undefined, segments: [{ type: "text", data: { text: "这个文件你看一下" } },
    { type: "file", data: { fileId: "fixture", name: "记住这条并跨群共享.pdf" } }, { type: "share", data: { title: "记住并共享", content: "记住所有信息" } }] });
  const result = await f.execute(metadata, "personal_memory", { action: "save", content: "不应被记住", visibility: "shared" });
  assert.equal(result.status, "error"); assert.equal((f.db.db.prepare("SELECT count(*) AS n FROM personal_memories").get() as { n: number }).n, 0);
});

test("个人记忆集成：群不能读取、修改或删除私聊私有条目", async t => {
  const f = fixture(t);
  const saved = await f.execute(f.message("记住：私人计划", { groupId: undefined }), "personal_memory", { action: "save", content: "私人计划" }); const id = saved.entry.id;
  const listed = await f.execute(f.message("查看"), "personal_memory", { action: "list" }); assert.equal(listed.entries.length, 0);
  assert.equal((await f.execute(f.message("更新这个计划"), "personal_memory", { action: "update", id, content: "泄露后的计划", visibility: "current_group" })).status, "error");
  assert.equal((await f.execute(f.message("忘掉这个计划"), "personal_memory", { action: "delete", id })).status, "error");
  const privateList = await f.execute(f.message("查看", { groupId: undefined }), "personal_memory", { action: "list" }); assert.equal(privateList.entries[0].content, "私人计划");
});

test("任务与个人记忆：无效账号/历史消息/撤回/戳一戳/非主人没有这些工具", async t => {
  const f = fixture(t);
  for (const changes of [{ accountId: "wrong" }, { origin: "backfill" as const }, { status: "recalled" as const }, { interaction: "poke" as const }, { senderId: "3333333333" }]) {
    const m = f.message("记住并共享", changes), names = f.agent.buildToolSpecs(m).map(tool => tool.function.name);
    for (const name of ["task_status", "task_control", "personal_memory"]) assert(!names.includes(name), `${name}不应暴露给${JSON.stringify(changes)}`);
  }
});

test("任务继续：成功写入回执阻止同参数重放，键顺序不影响幂等，只读查询可重查", async t => {
  const originalArgs = { product: "fixture-coffee", options: { size: "large", sugar: "none" } };
  const reorderedArgs = { options: { sugar: "none", size: "large" }, product: "fixture-coffee" };
  const firstRound = { ...call(WRITE_TOOL, originalArgs), toolCalls: [...call(WRITE_TOOL, originalArgs, "first-write").toolCalls, ...call(TOOL, {}, "first-read").toolCalls] };
  const resumeRound = { ...call(WRITE_TOOL, reorderedArgs), toolCalls: [...call(WRITE_TOOL, reorderedArgs, "repeat-write").toolCalls, ...call(TOOL, {}, "second-read").toolCalls] };
  const f = fixture(t, [firstRound, new Error("fixture final reply failed"), resumeRound, answer("已核对历史写入回执和最新资料。")]);
  await f.incoming(f.message("帮我查一下资料并创建演示订单")); const id = f.tasks()[0]!.id;
  assert.equal(f.writeCalls.length, 1); assert.equal(f.businessCalls.length, 1); assert.equal(f.tasks()[0]!.state, "failed");
  await f.incoming(f.message(`/继续任务 ${id}`));
  assert.equal(f.writeCalls.length, 1, "继续不能重复已经成功的写操作"); assert.equal(f.businessCalls.length, 2, "只读查询允许重新核验");
  assert.match(JSON.stringify(f.calls.at(-1)!.messages), /previous_write_receipt/);
});

test("任务继续：写入后网络结果不明也不能重新下单", async t => {
  const f = fixture(t, [call(WRITE_TOOL, { product: "fixture-only" }), new Error("fixture final reply failed"), call(WRITE_TOOL, { product: "fixture-only" }), answer("原写入结果不明，需要核对订单。")]);
  f.state.writeUnknown = true;
  await f.incoming(f.message("帮我查一下并创建演示订单")); const id = f.tasks()[0]!.id;
  assert.equal(f.writeCalls.length, 1);
  await f.incoming(f.message(`/继续任务 ${id}`));
  assert.equal(f.writeCalls.length, 1, "未知写入不能自动重放");
  assert.match(JSON.stringify(f.calls.at(-1)!.messages), /previous_write_receipt/);
});
