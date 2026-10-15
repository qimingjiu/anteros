import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import { DocumentService } from "../src/documents/index.js";
import { DocumentDelivery } from "../src/documents/delivery.js";
import type { Gateway } from "../src/gateway/index.js";
import type { ChatMessage, ChatResult, LLMClient, ToolSpec } from "../src/llm/index.js";
import type { McpManager } from "../src/tools/mcp.js";
import type { MessageRecord, SendStatus, ToolDef } from "../src/types.js";

const OWNER = "10001";
const ADMIN = "3388990011";
const GUEST = "4455667788";
const GROUP = "123456";
const BODY = "# 完整工作计划\n\n" + "这是正文，不应该被聊天字数上限截断。".repeat(30);
type SendTask = Parameters<Gateway["enqueueSend"]>[0];
interface InspectedAgent {
  buildToolSpecs(message: MessageRecord): ToolSpec[];
  executeTool(name: string, argumentsJson: string, message: MessageRecord): Promise<string>;
  replyFlow(message: MessageRecord, flightKey: string): Promise<void>;
  generateReply(message: MessageRecord, merged: MessageRecord[]): Promise<string | null>;
}

async function fixture(t: TestContext, status: SendStatus = "confirmed", mcpTools: ToolDef[] = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qq-agent-documents-"));
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "sim";
  cfg.tools.enabled = true;
  cfg.tools.ownerIds = [OWNER];
  cfg.admins = [OWNER, ADMIN];
  cfg.groups.allowlist = [GROUP];
  cfg.groups.linkPreview = false;
  cfg.memory.enabled = false;
  cfg.model.maxOutputChars = 10000;
  cfg.groups.maxReplyChars = 10000;
  cfg.documents = { ...cfg.documents!, enabled: true, outputDir: directory };
  const sent: SendTask[] = [];
  const gateway = {
    getProvider: () => ({ health: () => ({ selfId: "987654321", connection: "connected", login: "online", reconnectCount: 0 }) }),
    enqueueSend(task: SendTask) {
      sent.push(task);
      const queued = db.enqueueSendTask(task);
      if (task.payload.kind === "file" && status !== "queued" && !queued.reused) {
        db.claimSendTask(queued.id);
        if (status !== "in_flight") db.finishSendTask(queued.id, status, "internal-only diagnostic");
      }
      return queued;
    },
  } as unknown as Gateway;
  const service = new DocumentService({ outputDir: directory });
  const documentDelivery = new DocumentDelivery({ db, gateway, service, accountId: "sim", waitTimeoutMs: 0 });
  const calls: { messages: ChatMessage[]; tools: ToolSpec[] | undefined }[] = [];
  const steps: ((messages: ChatMessage[]) => ChatResult)[] = [];
  const llm: LLMClient = { async chat(messages, opts) {
    calls.push({ messages: structuredClone(messages), tools: opts?.tools ? structuredClone(opts.tools) : undefined });
    const step = steps.shift();
    if (!step) throw new Error("缺少脚本模型步骤");
    return step(messages);
  } };
  const mcp = { getTools: () => mcpTools } as unknown as McpManager;
  const agent = new Agent({ db, cfg, gateway, llm, documentDelivery, memory: null, search: null, reader: null, mcp, timezone: cfg.timezone }) as unknown as InspectedAgent;
  let serial = 0;
  const message = (overrides: Partial<MessageRecord> = {}): MessageRecord => ({
    eventKey: `sim:private_${OWNER}:${++serial}`, accountId: "sim", providerId: "onebot", conversationId: `private_${OWNER}`,
    messageId: String(serial), senderId: OWNER, displayNameAtTime: "主人", sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
    textContent: "请把这些内容整理成文档发给我", segments: [{ type: "text", data: { text: "请把这些内容整理成文档发给我" } }],
    status: "active", origin: "live", ...overrides,
  });
  const documentNames = (m: MessageRecord) => agent.buildToolSpecs(m).map(s => s.function.name);
  const request = { format: "md", markdown: BODY, filename: "完整工作计划" };
  return { directory, db, cfg, sent, agent, message, documentNames, calls, steps, request };
}

test("Agent 文档权限：只有所有者在私聊或白名单群可生成文件，其他管理员没有继承权限", async (t) => {
  const f = await fixture(t);
  for (const groupId of [undefined, GROUP]) {
    const group = groupId ? { groupId, conversationId: `group_${groupId}` } : {};
    assert.ok(f.documentNames(f.message(group)).includes("generate_document"));
    for (const senderId of [ADMIN, GUEST]) {
      const message = f.message({ ...group, senderId });
      assert.ok(!f.documentNames(message).includes("generate_document"));
      const result = await f.agent.executeTool("generate_document", JSON.stringify({ ...f.request, isOwner: true, senderId: OWNER }), message);
      assert.match(result, /不存在或当前不可用|没有权限/);
    }
  }
  assert.equal(f.sent.length, 0);
  assert.equal((await fs.readdir(f.directory)).length, 0);
});

test("Agent 文档权限：禁用群、全局工具关闭、文档关闭和显式空 owner 都拒绝直接调用", async (t) => {
  const f = await fixture(t);
  const rejected = async (message: MessageRecord) => {
    assert.ok(!f.documentNames(message).includes("generate_document"));
    assert.match(await f.agent.executeTool("generate_document", JSON.stringify(f.request), message), /不存在或当前不可用/);
  };
  await rejected(f.message({ groupId: "999888", conversationId: "group_999888" }));
  f.cfg.tools.enabled = false;
  await rejected(f.message());
  f.cfg.tools.enabled = true;
  f.cfg.documents!.enabled = false;
  await rejected(f.message());
  f.cfg.documents!.enabled = true;
  f.cfg.tools.ownerIds = [];
  await rejected(f.message());
  assert.equal(f.sent.length, 0);
  assert.equal((await fs.readdir(f.directory)).length, 0);
});

test("Agent 文档权限：跨账号、历史回填和已撤回消息不会获得文件生成权限", async (t) => {
  const f = await fixture(t);
  for (const overrides of [{ accountId: "foreign-account" }, { origin: "backfill" as const }, { status: "recalled" as const }]) {
    const message = f.message(overrides);
    assert.ok(!f.documentNames(message).includes("generate_document"));
    assert.match(await f.agent.executeTool("generate_document", JSON.stringify(f.request), message), /不存在或当前不可用/);
  }
  assert.equal(f.sent.length, 0);
});

test("Agent 文档权限：旧配置缺省 owner 仍使用管理员，普通用户不被授权", async (t) => {
  const f = await fixture(t);
  delete f.cfg.tools.ownerIds;
  assert.ok(f.documentNames(f.message({ senderId: ADMIN })).includes("generate_document"));
  assert.ok(!f.documentNames(f.message({ senderId: GUEST })).includes("generate_document"));
});

test("Agent 文档工具：真实所有者也不能输入任意路径或伪造收件人", async (t) => {
  const f = await fixture(t);
  const message = f.message({ groupId: GROUP, conversationId: `group_${GROUP}` });
  for (const args of [{ ...f.request, filePath: "/etc/passwd" }, { ...f.request, recipientId: ADMIN }, { ...f.request, accountId: "foreign" }]) {
    assert.match(await f.agent.executeTool("generate_document", JSON.stringify(args), message), /不接受文件路径、收件人或其他额外字段/);
  }
  for (const args of ["null", "[]", "{broken", '"string"']) {
    assert.match(await f.agent.executeTool("generate_document", args, message), /JSON/);
  }
  assert.equal(f.sent.length, 0);
  assert.equal((await fs.readdir(f.directory)).length, 0);
});

test("Agent 文档工具：真实文件系统生成失败不能向模型泄露服务器路径", async (t) => {
  const f = await fixture(t);
  await fs.rm(f.directory, { recursive: true, force: true });
  await fs.writeFile(f.directory, "这是占用了输出目录路径的普通文件");
  const result = await f.agent.executeTool("generate_document", JSON.stringify(f.request), f.message());
  assert.match(result, /异常|失败/);
  assert.match(result, /状态尚未确认.*不要自动重复提交/);
  assert.ok(!result.includes(f.directory), "基础设施错误可以落日志，但模型结果不能含服务器绝对路径");
  assert.doesNotMatch(result, /qq-agent-documents-|mkdir|EEXIST/);
  assert.equal(f.sent.length, 0);
});

test("Agent 文档集成：脚本模型调用工具生成完整文件后，根据 confirmed 结果发送最终群回复", async (t) => {
  const f = await fixture(t);
  f.steps.push(() => ({ content: "", toolCalls: [{ id: "create-document", name: "generate_document", arguments: JSON.stringify({ ...f.request, delivery: "private" }) }], finishReason: "tool_calls" }));
  f.steps.push(messages => {
    const result = JSON.parse(String(messages.find(m => m.role === "tool")?.content));
    assert.equal(result.status, "confirmed");
    assert.equal(result.destination, "private");
    assert.equal(result.bytes, Buffer.byteLength(BODY));
    return { content: "完整工作计划已作为文件私发给你。", toolCalls: [], finishReason: "stop" };
  });
  const message = f.message({ groupId: GROUP, conversationId: `group_${GROUP}`, segments: [{ type: "at", data: { qq: "987654321" } }, { type: "text", data: { text: "整理文档并私发给我" } }] });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.agent.replyFlow(message, `${GROUP}:${OWNER}`);
  t.mock.timers.tick(1200);
  await pending;
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0]!.tools?.some(tool => tool.function.name === "generate_document"));
  assert.match(String(f.calls[0]!.messages[0]?.content), /confirmed.*已发送/);
  const files = f.sent.filter(task => task.payload.kind === "file");
  assert.equal(files.length, 1);
  assert.equal(files[0]?.targetId, OWNER);
  assert.equal(files[0]?.conversationType, "private");
  const payload = files[0]!.payload;
  if (payload.kind !== "file") assert.fail("必须发文件");
  assert.equal(await fs.readFile(payload.filePath, "utf8"), BODY, "聊天长度限制不能截掉文档内容");
  const replies = f.sent.filter(task => task.kind === "reply");
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.conversationType, "group");
  assert.equal(replies[0]?.targetId, GROUP);
  if (replies[0]!.payload.kind === "segments") {
    assert.deepEqual(replies[0]!.payload.segments[0], { type: "reply", data: { id: message.messageId } });
    assert.equal(replies[0]!.payload.segments.filter(s => s.type === "text").map(s => s.data.text).join(""), "完整工作计划已作为文件私发给你。");
  }
});

test("Agent 文档集成：未确认发送状态进入模型工具上下文，最终答复保留真实结果且不重试", async (t) => {
  for (const status of ["queued", "in_flight", "failed", "unknown"] as const) {
    const f = await fixture(t, status);
    f.steps.push(() => ({ content: "", toolCalls: [{ id: "create-document", name: "generate_document", arguments: JSON.stringify(f.request) }], finishReason: "tool_calls" }));
    f.steps.push(messages => {
      const result = JSON.parse(String(messages.find(m => m.role === "tool")?.content));
      assert.equal(result.status, status);
      assert.doesNotMatch(result.detail, /已确认文件发送成功/);
      return { content: result.detail, toolCalls: [], finishReason: "stop" };
    });
    const message = f.message();
    const result = await (f.agent as unknown as { generateReply(m: MessageRecord, merged: MessageRecord[]): Promise<string> }).generateReply(message, []);
    assert.match(result, status === "failed" ? /发送失败/ : status === "unknown" ? /回执不明/ : /尚未/);
    assert.doesNotMatch(result, /已确认文件发送成功/);
    assert.equal(f.sent.filter(task => task.payload.kind === "file").length, 1);
    const prompt = String(f.calls[0]!.messages[0]?.content);
    assert.match(prompt, /confirmed.*已发送/);
    assert.match(prompt, /unknown.*回执不明/);
    assert.match(prompt, /failed.*失败/);
    assert.equal(f.calls.length, 2);
  }
});

test("Agent 文档集成：三轮研究后仍保留一次真实文件交付，并如实报告发送状态", async t => {
  for (const status of ["confirmed", "unknown", "failed"] as const) {
    const researched: number[] = [];
    const research: ToolDef = { name: "mcp__fixture__research", description: "隔离研究工具，无网络请求",
      inputSchema: { type: "object" }, execute: async args => {
        researched.push(Number(args.stage)); return `第 ${args.stage} 轮已取得的官方文档资料`;
      } };
    const f = await fixture(t, status, [research]);
    for (let stage = 1; stage <= 3; stage++) f.steps.push(() => ({ content: "", toolCalls: [{
      id: `research-${stage}`, name: research.name, arguments: JSON.stringify({ stage }),
    }], finishReason: "tool_calls" }));
    f.steps.push(messages => {
      assert.equal(messages.filter(message => message.role === "tool").length, 3);
      assert.match(String(messages[0]!.content), /文件还没有生成/);
      return { content: "", toolCalls: [{ id: "reserved-document", name: "generate_document",
        arguments: JSON.stringify(f.request) }], finishReason: "tool_calls" };
    });
    f.steps.push(messages => {
      const result = JSON.parse(String(messages.find(message => message.tool_call_id === "reserved-document")?.content));
      assert.equal(result.status, status); return { content: result.detail, toolCalls: [], finishReason: "stop" };
    });
    const text = "κόραξ给我去搜瑞幸的MCP，官方有文档。梳理总结一下然后发文件给我。";
    const result = await f.agent.generateReply(f.message({ textContent: text, segments: [{ type: "text", data: { text } }] }), []);
    assert.equal(f.calls.length, 5);
    assert.deepEqual(researched, [1, 2, 3]);
    assert.deepEqual(f.calls[3]!.tools?.map(tool => tool.function.name).sort(), ["conversation_action", "generate_document"]);
    assert.deepEqual(f.calls[4]!.tools?.map(tool => tool.function.name), ["conversation_action"]);
    assert.match(result!, status === "confirmed" ? /确认文件发送成功/ : status === "unknown" ? /回执不明/ : /发送失败/);
    const files = f.sent.filter(task => task.payload.kind === "file");
    assert.equal(files.length, 1);
    const payload = files[0]!.payload;
    if (payload.kind !== "file") assert.fail("必须投递真实文件");
    assert.equal(await fs.readFile(payload.filePath, "utf8"), BODY);
  }
});

test("Agent 文档集成：交付轮拒绝过期研究调用，最终正文恢复也不会重复发送文件", async t => {
  const researched: number[] = [];
  const research: ToolDef = { name: "mcp__fixture__research", description: "隔离研究工具，无网络请求",
    inputSchema: { type: "object" }, execute: async args => { researched.push(Number(args.stage)); return `资料 ${args.stage}`; } };
  const f = await fixture(t, "confirmed", [research]);
  for (let stage = 1; stage <= 4; stage++) f.steps.push(() => ({ content: "", toolCalls: [{
    id: `research-${stage}`, name: research.name, arguments: JSON.stringify({ stage }),
  }], finishReason: "tool_calls" }));
  f.steps.push(messages => {
    assert.match(String(messages.find(message => message.tool_call_id === "research-4")?.content), /已经关闭.*没有执行/);
    return { content: "", toolCalls: [{ id: "create-document", name: "generate_document", arguments: JSON.stringify(f.request) }], finishReason: "tool_calls" };
  });
  f.steps.push(() => ({ content: "我还要再发一次", toolCalls: [{ id: "unexecuted-document", name: "generate_document",
    arguments: JSON.stringify({ ...f.request, filename: "不应该生成的新文件", markdown: "新的内容" }) }], finishReason: "tool_calls" }));
  f.steps.push(messages => {
    assert.match(String(messages.find(message => message.tool_call_id === "unexecuted-document")?.content), /没有执行/);
    const result = JSON.parse(String(messages.find(message => message.tool_call_id === "create-document")?.content));
    assert.equal(result.status, "confirmed"); return { content: result.detail, toolCalls: [], finishReason: "stop" };
  });
  const result = await f.agent.generateReply(f.message(), []);
  assert.equal(f.calls.length, 7);
  assert.deepEqual(researched, [1, 2, 3], "交付轮的第四次研究请求不执行");
  assert.deepEqual(f.calls[3]!.tools?.map(tool => tool.function.name).sort(), ["conversation_action", "generate_document"]);
  assert.deepEqual(f.calls[4]!.tools?.map(tool => tool.function.name).sort(), ["conversation_action", "generate_document"]);
  assert.deepEqual(f.calls[5]!.tools?.map(tool => tool.function.name), ["conversation_action"]);
  assert.deepEqual(f.calls[6]!.tools, []);
  assert.match(result!, /确认文件发送成功/);
  assert.equal(f.sent.filter(task => task.payload.kind === "file").length, 1);
  assert.equal((await fs.readdir(f.directory)).length, 1, "恢复正文不额外生成任何文件产物");
});

test("Agent 文档集成：明确召唤在研究后误静默时恢复尚未生成的文档，不重开研究工具", async t => {
  let researched = 0;
  const research: ToolDef = { name: "mcp__fixture__research", description: "隔离研究工具",
    inputSchema: { type: "object" }, execute: async () => { researched++; return "已有的官方资料"; } };
  const f = await fixture(t, "confirmed", [research]);
  f.steps.push(() => ({ content: "", toolCalls: [{ id: "research", name: research.name, arguments: "{}" }], finishReason: "tool_calls" }));
  f.steps.push(() => ({ content: "", toolCalls: [{ id: "silent", name: "conversation_action", arguments: '{"action":"silent"}' }], finishReason: "tool_calls" }));
  f.steps.push(messages => {
    assert.match(String(messages.at(-1)?.content), /仅使用 generate_document/);
    assert.doesNotMatch(String(messages.at(-1)?.content), /不再生成或发送文件/);
    return { content: "", toolCalls: [{ id: "document", name: "generate_document", arguments: JSON.stringify(f.request) }], finishReason: "tool_calls" };
  });
  f.steps.push(() => ({ content: "文件已根据已有资料生成并发送。", toolCalls: [], finishReason: "stop" }));
  const text = "κόραξ，查资料整理成文档发给我。";
  await f.agent.generateReply(f.message({ groupId: GROUP, conversationId: `group_${GROUP}`, textContent: text,
    segments: [{ type: "at", data: { qq: "987654321" } }, { type: "text", data: { text } }] }), []);
  assert.equal(f.calls.length, 4);
  assert.equal(researched, 1);
  assert.deepEqual(f.calls[2]!.tools?.map(tool => tool.function.name).sort(), ["conversation_action", "generate_document"]);
  assert.deepEqual(f.calls[3]!.tools?.map(tool => tool.function.name), ["conversation_action"]);
  assert.equal(f.sent.filter(task => task.payload.kind === "file").length, 1);
});

test("Agent 文档集成：研究预算结束前已生成文件时不追加交付轮", async t => {
  const research: ToolDef = { name: "mcp__fixture__research", description: "隔离研究工具",
    inputSchema: { type: "object" }, execute: async () => "补充资料" };
  const f = await fixture(t, "confirmed", [research]);
  f.steps.push(() => ({ content: "", toolCalls: [{ id: "early-document", name: "generate_document",
    arguments: JSON.stringify(f.request) }], finishReason: "tool_calls" }));
  for (let stage = 1; stage <= 2; stage++) f.steps.push(() => ({ content: "", toolCalls: [{
    id: `research-${stage}`, name: research.name, arguments: "{}",
  }], finishReason: "tool_calls" }));
  f.steps.push(() => ({ content: "文件已交付，补充资料也已核对。", toolCalls: [], finishReason: "stop" }));
  await f.agent.generateReply(f.message(), []);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls[3]!.tools?.map(tool => tool.function.name), ["conversation_action"]);
  assert.equal(f.sent.filter(task => task.payload.kind === "file").length, 1);
});

test("文档配置：限额边界、错误类型及目录控制字符在加载时检查", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qq-document-config-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.yaml");
  const load = async (documents: string) => {
    await fs.writeFile(configPath, `gateway:\n  onebot:\n    endpoint: ws://127.0.0.1:1\nmodel:\n  provider: mock\n  model: fixture\ndocuments:${documents}\n`);
    return loadConfig(configPath);
  };
  const valid = await load("\n  max_input_chars: 200000\n  max_file_bytes: 20971520\n  max_retained_files: 1000\n  retention_hours: 720\n  provider_output_dir: /app/documents");
  assert.equal(valid.documents?.maxInputChars, 200000);
  assert.equal(valid.documents?.maxFileBytes, 20971520);
  assert.equal(valid.documents?.providerOutputDir, "/app/documents");
  for (const value of [" []", " false", "\n  max_input_chars: 0", "\n  max_input_chars: 1.5", '\n  max_input_chars: "50"', "\n  max_input_chars: 200001", "\n  max_file_bytes: 20971521", "\n  max_retained_files: 1001", "\n  retention_hours: 721", ' \n  output_dir: " "', ' \n  provider_output_dir: "line\\npath"']) {
    await assert.rejects(() => load(value), /配置错误.*documents/);
  }
});
