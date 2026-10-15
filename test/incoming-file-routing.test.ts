import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { Database } from "../src/db/index.js";
import { loadConfig } from "../src/config.js";
import { IncomingDocumentService } from "../src/documents/incoming.js";
import { RuntimeDiagnostics, type RuntimeDiagnosticsSnapshot } from "../src/diagnostics/index.js";
import { TaskLedger, type TaskRecord } from "../src/tasks/index.js";
import type { Gateway } from "../src/gateway/index.js";
import type { ChatMessage, ChatOptions, ChatResult, LLMClient } from "../src/llm/index.js";
import type { McpManager } from "../src/tools/mcp.js";
import type { MessageRecord, Provider } from "../src/types.js";

const OWNER = "10001", MEMBER = "12345678", BOT = "90001", GROUP = "40001";
const BASE = Date.parse("2026-10-15T14:50:00Z");
type SendTask = Parameters<Gateway["enqueueSend"]>[0];
interface InspectAgent {
  onMessage(message: MessageRecord): Promise<void>;
  executeTool(name: string, json: string, message: MessageRecord): Promise<string>;
}
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }

function fixture(t: TestContext, options: { conversation?: boolean; tasksEnabled?: boolean; parseFail?: boolean; providerFail?: boolean } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: BASE });
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "acct";
  cfg.groups.allowlist = [GROUP, "200"];
  cfg.groups.linkPreview = false;
  cfg.groups.conversation = { enabled: options.conversation ?? false, ownerAliases: ["主人"], observerCooldownMs: 30_000 };
  cfg.tools.enabled = true; cfg.tools.ownerIds = [OWNER]; cfg.admins = [OWNER];
  cfg.features = { tasks: options.tasksEnabled ?? false, personalMemory: false, groupSearch: false, linkDedup: false, incomingFiles: true };
  const diagnostics = new RuntimeDiagnostics({ subscribeLogs: false });
  t.after(() => diagnostics.close());
  let serial = 0, resolves = 0, downloads = 0, parses = 0;
  const provider = {
    health: () => ({ selfId: BOT, connection: "connected", login: "online", reconnectCount: 0 }),
    resolveIncomingFile: async () => {
      resolves++;
      if (options.providerFail) throw new Error("provider-secret-fixture");
      return { ok: true, url: "https://files.qq.com/current.pdf" };
    },
  } as unknown as Provider;
  const incoming = new IncomingDocumentService({ db: db.db, ownerIds: [OWNER], provider,
    download: async () => { downloads++; return new Uint8Array([1]); },
    parse: async () => { parses++; if (options.parseFail) throw new Error("parse-secret-fixture"); return { format: "pdf", truncated: false, notices: [],
      chunks: [{ index: 0, source: "第 1 页", text: "论文结论：实验收入为 240 万元。" }] }; },
  });
  const calls: { messages: ChatMessage[]; options?: ChatOptions }[] = [];
  const receipts: { status: string; file?: { name: string }; chunks?: { text: string }[] }[] = [];
  const llm: LLMClient = { async chat(messages, chatOptions): Promise<ChatResult> {
    calls.push({ messages: structuredClone(messages), options: chatOptions });
    const last = messages.at(-1);
    if (last?.role === "tool") {
      const receipt = JSON.parse(String(last.content));
      receipts.push(receipt);
      return { content: `文件已读取：${receipt.chunks?.[0]?.text ?? receipt.reason}`, toolCalls: [], finishReason: "stop" };
    }
    const prompt = messages.filter(message => message.role === "user").map(message => String(message.content)).join("\n");
    if (prompt.includes('"authorized":true') && chatOptions?.tools?.some(tool => tool.function.name === "read_file")) {
      return { content: "", toolCalls: [{ id: `read-${calls.length}`, name: "read_file", arguments: "{}" }], finishReason: "tool_calls" };
    }
    return { content: `第 ${calls.length} 次回答：有文件后我会按要求处理。`, toolCalls: [], finishReason: "stop" };
  } };
  const sent: SendTask[] = [];
  const gateway = { getProvider: () => provider, enqueueSend: (task: SendTask) => {
    const result = db.enqueueSendTask(task);
    if (!result.reused) sent.push(task);
    return result;
  } } as unknown as Gateway;
  const agent = new Agent({ db, cfg, gateway, llm, memory: null, search: null, reader: null,
    mcp: { getTools: () => [] } as unknown as McpManager, incomingDocuments: incoming, diagnostics, timezone: cfg.timezone,
  }) as unknown as InspectAgent;
  const make = (text: string, patch: Partial<MessageRecord> = {}): MessageRecord => {
    t.mock.timers.tick(1);
    const id = String(++serial);
    return { eventKey: `file-routing:${id}`, accountId: "acct", providerId: "onebot", conversationId: `group_${GROUP}`,
      groupId: GROUP, messageId: id, senderId: OWNER, displayNameAtTime: "主人", textContent: text,
      segments: [{ type: "text", data: { text } }], sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
      origin: "live", status: "active", ...patch };
  };
  const upload = (patch: Partial<MessageRecord> = {}) => make("[文件: 当前论文.pdf]", {
    segments: [{ type: "file", data: { fileId: `native-${serial + 1}`, name: "当前论文.pdf", size: 550_000 } }], ...patch,
  });
  const run = async (message: MessageRecord) => {
    db.insertMessage(message);
    const pending = agent.onMessage(message);
    await flush(); t.mock.timers.tick(1200); await pending; await flush();
  };
  const execute = async (message: MessageRecord, name: string, args: Record<string, unknown> = {}) =>
    JSON.parse(await agent.executeTool(name, JSON.stringify(args), message));
  const tasks = () => db.db.prepare("SELECT * FROM owner_tasks ORDER BY id").all() as unknown as TaskRecord[];
  return { db, cfg, incoming, diagnostics, calls, receipts, sent, make, upload, run, execute, tasks,
    counts: () => ({ resolves, downloads, parses }) };
}

test("文件路由：群里先上传再说读一下这个，无需同条发送或@，关闭自动接话也会读取", async t => {
  const f = fixture(t);
  await f.run(f.upload());
  assert.equal(f.calls.length, 0, "单独上传保持静默");
  assert.deepEqual(f.counts(), { resolves: 0, downloads: 0, parses: 0 });
  await f.run(f.make("读一下这个"));
  assert.equal(f.receipts.length, 1, "明确追问应真正执行 read_file");
  assert.equal(f.receipts[0]!.status, "ok");
  assert.equal(f.receipts[0]!.file?.name, "当前论文.pdf");
  assert.match(f.receipts[0]!.chunks![0]!.text, /240 万元/);
  assert.deepEqual(f.counts(), { resolves: 1, downloads: 1, parses: 1 });
  assert.ok(f.sent.length > 0);
});

test("文件路由：先说读文件后本人纯文件上传，承接原请求且后续附件不自动读取", async t => {
  const f = fixture(t);
  await f.run(f.make("读一下这个文件，概括主要结论"));
  assert.equal(f.receipts.length, 0);
  const uploaded = f.upload();
  await f.run(uploaded);
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0]!.status, "ok");
  const prompt = f.calls[0]!.messages.map(message => String(message.content)).join("\n");
  assert.match(prompt, /主人上传前的明确阅读请求/);
  assert.match(prompt, /概括主要结论/);
  const called = f.calls.length;
  await f.run(f.upload({ segments: [{ type: "file", data: { fileId: "second-upload", name: "第二份论文.pdf" } }] }));
  assert.equal(f.calls.length, called, "原请求只承接一次，其他单独上传不触发模型");
  assert.deepEqual(f.counts(), { resolves: 1, downloads: 1, parses: 1 });
});

test("文件路由：私聊先上传再短追问可以读取，且不会串用群附件", async t => {
  const f = fixture(t);
  await f.run(f.upload({ senderId: MEMBER, displayNameAtTime: "群友", segments: [{ type: "file", data: { fileId: "group-junk", name: "群友垃圾.pdf" } }] }));
  const privateScope = { groupId: undefined, conversationId: `private_${OWNER}` };
  await f.run(f.upload(privateScope));
  assert.equal(f.calls.length, 0);
  await f.run(f.make("这个呢", privateScope));
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0]!.status, "ok");
  assert.equal(f.receipts[0]!.file?.name, "当前论文.pdf");
});

test("文件路由：群友垃圾附件始终静默，不消费主人的待上传阅读请求", async t => {
  const f = fixture(t);
  await f.run(f.make("读一下这个文件"));
  await f.run(f.upload({ senderId: MEMBER, displayNameAtTime: "群友", segments: [{ type: "file", data: { fileId: "junk-first", name: "垃圾.pdf" } }] }));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.counts(), { resolves: 0, downloads: 0, parses: 0 });
  await f.run(f.upload());
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0]!.file?.name, "当前论文.pdf");
  assert.deepEqual(f.counts(), { resolves: 1, downloads: 1, parses: 1 });
});

test("文件路由：已授权的主人短追问不受群自动插话冷却限制", async t => {
  const f = fixture(t, { conversation: true });
  await f.run(f.make("群友讨论新话题", { senderId: MEMBER, displayNameAtTime: "群友" }));
  assert.equal(f.calls.length, 1, "先产生一次自动插话，启动30秒冷却");
  await f.run(f.upload());
  await f.run(f.make("这个呢"));
  assert.equal(f.receipts.length, 1, "冷却中的主人文件追问仍应进入直接对话并读取");
  assert.equal(f.receipts[0]!.status, "ok");
  const calls = f.calls.length;
  await f.run(f.make("概括一下", { senderId: MEMBER, displayNameAtTime: "群友" }));
  assert.equal(f.calls.length, calls, "普通群友仍受自动插话冷却限制");
});

test("文件路由：仅有群友附件时主人这个呢不能隐式授权，也不会下载", async t => {
  const f = fixture(t);
  const other = f.upload({ senderId: MEMBER, displayNameAtTime: "群友" });
  await f.run(other);
  await f.run(f.make("这个呢"));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.counts(), { resolves: 0, downloads: 0, parses: 0 });
  const request = f.make("总结一下", { replyToMessageId: other.messageId });
  await f.run(request);
  assert.equal(f.receipts.length, 1, "明确引用并要求阅读后可以读取群友文件");
  assert.equal(f.receipts[0]!.status, "ok");
});

test("文件诊断：Agent保留not_found和not_authorized具体回执，诊断区分选取与授权且不归上游故障", async t => {
  const f = fixture(t);
  const request = f.make("检查文件");
  const missing = await f.execute(request, "read_file");
  assert.equal(missing.status, "failed");
  assert.equal(missing.reason, "not_found");
  assert.equal(missing.stage, "selection");
  const [file] = f.incoming.register(f.upload());
  const denied = await f.execute(f.make("再检查文件"), "read_file", { file_id: file!.id });
  assert.equal(denied.status, "failed");
  assert.equal(denied.reason, "not_authorized");
  assert.equal(denied.stage, "authorization");
  const snapshot = await f.execute(request, "runtime_diagnostics", { component: "documents" }) as RuntimeDiagnosticsSnapshot;
  assert.equal(snapshot.events.length, 2);
  assert.deepEqual(snapshot.events.map(event => ({ operation: event.operation, reason: event.reason, fileStage: event.fileStage, errorCode: event.errorCode })), [
    { operation: "read_file", reason: "permission", fileStage: "authorization", errorCode: "TOOL_FILE_READ_FAILED" },
    { operation: "read_file", reason: "invalid_response", fileStage: "selection", errorCode: "TOOL_FILE_READ_FAILED" },
  ]);
  assert.ok(snapshot.events.every(event => event.reason !== "upstream_error"));
  assert.deepEqual(f.counts(), { resolves: 0, downloads: 0, parses: 0 });
});

test("文件诊断：真实工具循环把协议解析失败和文档解析失败记录在各自阶段，不伪装成下载故障", async t => {
  for (const failure of ["provider", "parse"] as const) await t.test(failure, async sub => {
    const f = fixture(sub, { providerFail: failure === "provider", parseFail: failure === "parse" });
    const uploaded = f.upload();
    await f.run(uploaded);
    const request = f.make("读一下这个");
    await f.run(request);
    const result = f.receipts[0] as unknown as { status: string; reason: string; stage: string };
    assert.equal(result.status, "failed");
    assert.equal(result.reason, failure === "provider" ? "protocol_unavailable" : "parse_failed");
    assert.equal(result.stage, failure === "provider" ? "resolve" : "parse");
    const snapshot = f.diagnostics.snapshot({ scope: "conversation", accountId: "acct", conversationId: request.conversationId, component: "documents" });
    assert.equal(snapshot.events[0]!.fileStage, result.stage);
    assert.equal(snapshot.events[0]!.reason, failure === "provider" ? "unsupported" : "invalid_response");
    assert.notEqual(snapshot.events[0]!.reason, "upstream_error");
    assert.deepEqual(f.counts(), failure === "provider" ? { resolves: 1, downloads: 0, parses: 0 } : { resolves: 1, downloads: 1, parses: 1 });
    assert.doesNotMatch(JSON.stringify({ snapshot, result }), /provider-secret-fixture|parse-secret-fixture/);
  });
});

test("文件任务：先请求阅读再上传，按源事件续接本次任务，不串联同内容旧任务或遗留孤儿", async t => {
  const f = fixture(t, { tasksEnabled: true });
  const privateScope = { groupId: undefined, conversationId: `private_${OWNER}` };
  const requestText = "读一下这个文件，概括主要结论";
  const ledger = new TaskLedger(f.db);
  const oldRequest = f.make(requestText, privateScope);
  f.db.insertMessage(oldRequest);
  const old = ledger.begin(oldRequest);
  ledger.finish(old.id, "旧文件尚未提供，保留等待状态。");
  const request = f.make(requestText, privateScope);
  await f.run(request);
  assert.equal(f.tasks().length, 2);
  const original = f.tasks().find(task => task.source_event === request.eventKey)!;
  assert.equal(original.state, "waiting_input");
  // Even if an older identical task was updated more recently, provenance must select this request's task.
  t.mock.timers.tick(1);
  ledger.finish(old.id, "旧任务状态仍在等待，不应被新上传续接。");
  const oldBefore = f.tasks().find(task => task.id === old.id)!;
  const uploaded = f.upload(privateScope);
  await f.run(uploaded);
  assert.equal(f.receipts[0]!.status, "ok");
  assert.equal(f.incoming.authorizedRequestSourceFor(uploaded), request.eventKey);
  assert.equal(f.tasks().length, 2, "上传应复用本次原任务，不能另建[文件]任务");
  assert.deepEqual(f.tasks().find(task => task.id === old.id), oldBefore, "同内容旧任务不应被修改");
  const completed = f.tasks().find(task => task.source_event === request.eventKey)!;
  assert.equal(completed.id, original.id);
  assert.equal(completed.source_event, request.eventKey);
  assert.equal(completed.request, request.textContent);
  assert.equal(completed.state, "completed");
  assert.equal(completed.successful_steps, 1);
  assert.equal(completed.failed_steps, 0);
  const step = f.db.db.prepare("SELECT task_id,tool,state,receipt FROM owner_task_steps WHERE tool='read_file'").get() as { task_id: number; tool: string; state: string; receipt: string };
  assert.equal(step.task_id, original.id);
  assert.equal(step.state, "completed");
  assert.match(step.receipt, /240 万元/);
});
