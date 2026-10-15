import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Agent } from "../src/agent/index.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import { DocumentService } from "../src/documents/index.js";
import { DocumentDelivery } from "../src/documents/delivery.js";
import type { Gateway } from "../src/gateway/index.js";
import type { ChatMessage, ChatResult, LLMClient, ToolSpec } from "../src/llm/index.js";
import type { McpManager } from "../src/tools/mcp.js";
import type { MessageRecord } from "../src/types.js";

const OWNER = "10001";
const GUEST = "4455667788";
const BODY = "# PDF 恢复验证\n\n完整的中文文档正文。";
const EMPTY: ChatResult = { content: "", toolCalls: [], finishReason: "stop" };
type SendTask = Parameters<Gateway["enqueueSend"]>[0];
interface InspectedAgent {
  generateReply(message: MessageRecord, merged: MessageRecord[]): Promise<string>;
}

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qq-agent-document-recovery-"));
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "sim";
  cfg.tools.enabled = true;
  cfg.tools.ownerIds = [OWNER];
  cfg.admins = [OWNER];
  cfg.memory.enabled = false;
  cfg.groups.linkPreview = false;
  cfg.documents = { ...cfg.documents!, enabled: true, outputDir: directory };
  const sent: SendTask[] = [];
  const gateway = {
    getProvider: () => ({ health: () => ({ selfId: "987654321", connection: "connected", login: "online", reconnectCount: 0 }) }),
    enqueueSend(task: SendTask) {
      sent.push(task);
      const queued = db.enqueueSendTask(task);
      if (task.payload.kind === "file" && !queued.reused) {
        db.claimSendTask(queued.id);
        db.finishSendTask(queued.id, "confirmed");
      }
      return queued;
    },
  } as unknown as Gateway;
  const service = new DocumentService({ outputDir: directory });
  const documentDelivery = new DocumentDelivery({ db, gateway, service, accountId: "sim", waitTimeoutMs: 0 });
  const calls: { messages: ChatMessage[]; tools: ToolSpec[] | undefined }[] = [];
  const steps: ((messages: ChatMessage[]) => ChatResult)[] = [];
  const llm: LLMClient = { async chat(messages, options) {
    calls.push({ messages: structuredClone(messages), tools: options?.tools ? structuredClone(options.tools) : undefined });
    const step = steps.shift();
    if (!step) throw new Error("主模型调用超出脚本步骤预算");
    return step(messages);
  } };
  const mcp = { getTools: () => [] } as unknown as McpManager;
  const agent = new Agent({ db, cfg, gateway, llm, documentDelivery, memory: null, search: null, reader: null, mcp, timezone: cfg.timezone }) as unknown as InspectedAgent;
  const message = (overrides: Partial<MessageRecord> = {}): MessageRecord => ({
    eventKey: `sim:private_${OWNER}:1`, accountId: "sim", providerId: "onebot", conversationId: `private_${OWNER}`,
    messageId: "1", senderId: OWNER, displayNameAtTime: "主人", sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
    textContent: "请把刚才的内容整理成 PDF 文档发给我", segments: [{ type: "text", data: { text: "请把刚才的内容整理成 PDF 文档发给我" } }],
    status: "active", origin: "live", ...overrides,
  });
  const toolResult: ChatResult = { content: "", toolCalls: [{ id: "create-pdf", name: "generate_document", arguments: JSON.stringify({ format: "pdf", markdown: BODY, filename: "恢复验证" }) }], finishReason: "tool_calls" };
  return { directory, db, cfg, sent, agent, calls, steps, message, toolResult };
}

test("文档空响应恢复：主模型空正文后重新获得文档工具，只生成并投递一份真实中文 PDF", async (t) => {
  const f = await fixture(t);
  f.steps.push(() => EMPTY, () => f.toolResult, messages => {
    const result = JSON.parse(String(messages.find(message => message.role === "tool")?.content));
    assert.equal(result.format, "pdf");
    assert.equal(result.status, "confirmed");
    return { content: "PDF 文档已经发给你了。", toolCalls: [], finishReason: "stop" };
  });
  assert.equal(await f.agent.generateReply(f.message(), []), "PDF 文档已经发给你了。");
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[1]!.tools, f.calls[0]!.tools);
  assert.match(JSON.stringify(f.calls[1]!.messages), /generate_document/);
  assert.notDeepEqual(f.calls[1]!.messages, f.calls[0]!.messages, "恢复请求应明确提示实际调用工具");
  const files = f.sent.filter(task => task.payload.kind === "file");
  assert.equal(files.length, 1);
  const payload = files[0]!.payload;
  if (payload.kind !== "file") assert.fail("必须发送文件");
  assert.equal(payload.fileName, "恢复验证.pdf");
  const data = await fs.readFile(payload.filePath);
  const pdf = await getDocument({ data: new Uint8Array(data), useSystemFonts: false }).promise;
  try {
    const content = await (await pdf.getPage(1)).getTextContent();
    const text = content.items.filter(item => "str" in item).map(item => "str" in item ? item.str : "").join("").replace(/\s/g, "");
    assert.ok(text.includes("PDF恢复验证") && text.includes("完整的中文文档正文。"));
  } finally { await pdf.destroy(); }
});

test("文档空响应恢复：连续两次 stop 空正文后结束，不进入无限重试或创建半成品", async (t) => {
  const f = await fixture(t);
  f.steps.push(() => EMPTY, () => EMPTY);
  await assert.rejects(() => f.agent.generateReply(f.message(), []), /未返回回复正文|未生成最终回复/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("文档空响应恢复：普通用户与关闭文档能力不会获得恢复调用或文件权限", async (t) => {
  for (const mode of ["guest", "disabled"] as const) {
    const f = await fixture(t);
    if (mode === "disabled") f.cfg.documents!.enabled = false;
    f.steps.push(() => EMPTY);
    await assert.rejects(() => f.agent.generateReply(f.message(mode === "guest" ? { senderId: GUEST, conversationId: `private_${GUEST}` } : {}), []), /未返回回复正文|未生成最终回复/);
    assert.equal(f.calls.length, 1);
    assert.ok(!f.calls[0]!.tools?.some(tool => tool.function.name === "generate_document"));
    assert.equal(f.sent.length, 0);
  }
});

test("文档空响应恢复：已执行文件工具后空正文不重新生成或重复发送", async (t) => {
  const f = await fixture(t);
  f.steps.push(() => f.toolResult, () => EMPTY);
  await assert.rejects(() => f.agent.generateReply(f.message(), []), /未返回回复正文|未生成最终回复/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.sent.filter(task => task.payload.kind === "file").length, 1);
  assert.equal((await fs.readdir(f.directory)).length, 1);
});

test("文档空响应恢复：询问 PDF 能力、普通聊天与输出截断不触发文档恢复", async (t) => {
  for (const [textContent, finishReason] of [["你支持 PDF 吗", "stop"], ["晚上好", "stop"], ["请生成 PDF 发给我", "length"]] as const) {
    const f = await fixture(t);
    f.steps.push(() => ({ ...EMPTY, finishReason }));
    await assert.rejects(() => f.agent.generateReply(f.message({ textContent, segments: [{ type: "text", data: { text: textContent } }] }), []), /未返回回复正文|未生成最终回复/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.sent.length, 0);
  }
});
