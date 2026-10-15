import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import { RuntimeDiagnostics, type RuntimeDiagnosticsReadRequest } from "../src/diagnostics/index.js";
import type { DocumentDelivery } from "../src/documents/delivery.js";
import type { Gateway } from "../src/gateway/index.js";
import type { ChatMessage, ChatResult, LLMClient, ToolSpec } from "../src/llm/index.js";
import type { McpManager } from "../src/tools/mcp.js";
import type { SearchProvider } from "../src/tools/search.js";
import type { PageReader } from "../src/tools/reader.js";
import type { OpenMeteoWeather } from "../src/tools/weather.js";
import type { MessageRecord, ToolDef } from "../src/types.js";

const OWNER = "10001";
const GUEST = "4455667788";
const answer = (content = "依据诊断记录，故障原因仍待确认，没有修复或重发。 "): ChatResult => ({ content: content.trim(), toolCalls: [], finishReason: "stop" });
const call = (name: string, id: string, args: Record<string, unknown> = {}): ChatResult => ({
  content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }], finishReason: "tool_calls",
});
interface InspectedAgent {
  buildToolSpecs(message: MessageRecord): ToolSpec[];
  executeTool(name: string, args: string, message: MessageRecord): Promise<string>;
  generateReply(message: MessageRecord, merged: MessageRecord[]): Promise<string | null>;
  replyFlow(message: MessageRecord, flightKey: string): Promise<void>;
}
interface FixtureOptions {
  diagnostics?: boolean;
  readFails?: boolean;
  collectorFails?: boolean;
  lookupFailsAt?: number;
  lookupBody?: string;
  documentStatus?: "confirmed" | "failed" | "unknown";
  searchError?: unknown;
  pageError?: string;
  weatherError?: unknown;
  presenceError?: Error;
}
function fixture(t: TestContext, options: FixtureOptions = {}) {
  const db = new Database(":memory:");
  const service = new RuntimeDiagnostics({ subscribeLogs: false });
  t.after(() => { service.close(); db.close(); });
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "acct";
  cfg.admins = [OWNER, "other-admin"];
  cfg.tools.ownerIds = [OWNER];
  cfg.tools.enabled = true;
  cfg.groups.allowlist = ["100"];
  cfg.memory.enabled = false;
  cfg.groups.linkPreview = false;
  const reads: RuntimeDiagnosticsReadRequest[] = [];
  const diagnostics = options.diagnostics === false ? null : {
    async read(request: RuntimeDiagnosticsReadRequest) {
      reads.push(structuredClone(request));
      if (options.readFails) throw new Error("secret diagnostic exception /srv/private/key sk-secret");
      return service.read(request);
    },
    recordFailure: (...args: Parameters<RuntimeDiagnostics["recordFailure"]>) => {
      if (options.collectorFails) throw new Error("collector unavailable");
      service.recordFailure(...args);
    },
  };
  const calls: { messages: ChatMessage[]; tools: ToolSpec[] | undefined }[] = [];
  const steps: (ChatResult | Error)[] = [];
  const llm: LLMClient = { async chat(messages, options) {
    calls.push({ messages: structuredClone(messages), tools: options?.tools ? structuredClone(options.tools) : undefined });
    const step = steps.shift();
    if (!step) throw new Error("unexpected model request");
    if (step instanceof Error) throw step;
    return structuredClone(step);
  } };
  const lookedUp: number[] = [];
  const lookup: ToolDef = { name: "mcp__fixture__lookup", description: "local isolated lookup", inputSchema: { type: "object" },
    execute: async args => {
      const stage = Number(args.stage); lookedUp.push(stage);
      if (stage === options.lookupFailsAt) throw Object.assign(new Error("HTTP 503 private text sk-secret /srv/private/file"), { status: 503 });
      return options.lookupBody ?? `research-${stage}`;
    } };
  const search: SearchProvider = { name: "fixture", async search() {
    if (options.searchError) throw options.searchError;
    return [{ title: "讨论搜索失败的文章", url: "https://example.invalid/article", snippet: "搜索失败: 是文章内容", source: "fixture" }];
  } };
  const reader = { async read(url: string) {
    return { url, finalUrl: url, status: options.pageError ? "failed" : "ok", error: options.pageError,
      title: "错误信息参考", text: "读取失败: 是正常网页讨论内容", fetchedAt: new Date().toISOString() };
  } } as unknown as PageReader;
  const weather = options.weatherError ? { async getForecast() { throw options.weatherError; } } as unknown as OpenMeteoWeather : null;
  const documents: Record<string, unknown>[] = [];
  const documentDelivery = { async createAndSend(args: Record<string, unknown>) {
    documents.push(args);
    return { status: options.documentStatus ?? "confirmed", format: "md", detail: "隔离投递状态" };
  } } as unknown as DocumentDelivery;
  const sent: Parameters<Gateway["enqueueSend"]>[0][] = [];
  const gateway = { getProvider: () => ({ health: () => ({ selfId: "bot" }) }),
    enqueueSend(task: Parameters<Gateway["enqueueSend"]>[0]) { sent.push(task); return { id: sent.length, reused: false }; },
  } as unknown as Gateway;
  const presence = options.presenceError ? { async context() { throw options.presenceError; } } : null;
  const mcp = { getTools: () => [lookup] } as unknown as McpManager;
  const agent = new Agent({ db, cfg, gateway, llm, memory: null, search, reader, mcp, weather,
    documentDelivery, diagnostics, presence, timezone: cfg.timezone }) as unknown as InspectedAgent;
  const message = (overrides: Partial<MessageRecord> = {}): MessageRecord => ({
    eventKey: "acct:fixture:1", accountId: "acct", providerId: "onebot", conversationId: `private_${OWNER}`,
    messageId: "1", senderId: OWNER, displayNameAtTime: "主人", sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
    segments: [{ type: "text", data: { text: "请检查刚才的功能故障" } }], textContent: "请检查刚才的功能故障", status: "active", origin: "live", ...overrides,
  });
  const names = (m: MessageRecord) => agent.buildToolSpecs(m).map(spec => spec.function.name);
  const toolNames = (index: number) => calls[index]!.tools?.map(spec => spec.function.name).sort();
  const events = () => service.snapshot({ scope: "global", accountId: "acct", conversationId: `private_${OWNER}` }).events;
  return { agent, cfg, db, service, reads, calls, steps, lookedUp, documents, lookup, message, names, toolNames, events, sent };
}

test("运行诊断权限：主人私聊和启用群可用，其他管理员及普通用户不能借身份参数越权", async t => {
  const f = fixture(t);
  for (const m of [f.message(), f.message({ groupId: "100", conversationId: "group_100" })]) {
    assert.ok(f.names(m).includes("runtime_diagnostics"));
  }
  for (const senderId of [GUEST, "other-admin"]) {
    for (const groupId of [undefined, "100"]) {
      const m = f.message({ senderId, groupId, conversationId: groupId ? "group_100" : `private_${senderId}` });
      assert.ok(!f.names(m).includes("runtime_diagnostics"));
      assert.match(await f.agent.executeTool("runtime_diagnostics", JSON.stringify({ scope: "global", senderId: OWNER, isOwner: true }), m), /不存在或当前不可用/);
    }
  }
  assert.equal(f.reads.length, 0);
});

test("运行诊断权限：关闭工具、未启用群、历史或撤回事件、其他账号、戳一戳都不暴露能力", t => {
  const f = fixture(t);
  for (const overrides of [{ groupId: "999", conversationId: "group_999" }, { accountId: "foreign" },
    { origin: "backfill" as const }, { status: "recalled" as const }, { interaction: "poke" as const }]) {
    assert.ok(!f.names(f.message(overrides)).includes("runtime_diagnostics"));
  }
  f.cfg.tools.enabled = false;
  assert.ok(!f.names(f.message()).includes("runtime_diagnostics"));
  assert.ok(!fixture(t, { diagnostics: false }).names(f.message()).includes("runtime_diagnostics"));
});

test("运行诊断范围：请求来自真实消息，群里只能看到当前账号当前会话关联记录", async t => {
  const f = fixture(t);
  f.service.recordFailure("search", "HTTP 429", { accountId: "acct", conversationId: "group_100", operation: "web_search" });
  f.service.recordFailure("presence", "HTTP 401", { accountId: "acct", conversationId: `private_${OWNER}` });
  f.service.recordFailure("weather", "HTTP 503", { accountId: "other-account", conversationId: "group_100" });
  const group = JSON.parse(await f.agent.executeTool("runtime_diagnostics", '{"limit":4}', f.message({ groupId: "100", conversationId: "group_100" })));
  assert.equal(group.scope, "conversation");
  assert.deepEqual(group.events.map((event: { component: string }) => event.component), ["search"]);
  assert.deepEqual(f.reads[0], { scope: "conversation", accountId: "acct", conversationId: "group_100", component: undefined, limit: 4 });
  const global = JSON.parse(await f.agent.executeTool("runtime_diagnostics", "{}", f.message()));
  assert.equal(global.events.length, 3);
  assert.equal(f.reads[1]!.scope, "global");
  assert.doesNotMatch(JSON.stringify(group), /10001|private_|other-account|group_100/);
});

test("运行诊断参数：路径、范围、身份注入及非法组件和数量都被拒绝", async t => {
  const f = fixture(t);
  for (const args of [{ path: "C:\\secret" }, { scope: "global" }, { accountId: "fake" }, { conversationId: "other" },
    { component: "all" }, { component: 1 }, { component: null }, { limit: 0 }, { limit: 21 }, { limit: 1.5 }, { limit: "20" }]) {
    assert.match(await f.agent.executeTool("runtime_diagnostics", JSON.stringify(args), f.message()), /错误：诊断参数/);
  }
  assert.equal(f.reads.length, 0);
  await f.agent.executeTool("runtime_diagnostics", '{"component":"gateway","limit":1}', f.message());
  assert.equal(f.reads[0]!.component, "gateway");
  assert.equal(f.reads[0]!.limit, 1);
});

test("运行诊断故障采集：内部吞掉的搜索、网页、天气错误保留分类和数值，不泄露异常正文", async t => {
  const f = fixture(t, { searchError: Object.assign(new Error("HTTP 429 secret sk-secret"), { status: 429 }),
    pageError: "HTTP 401 /srv/private/secret", weatherError: new Error("HTTP 403 bearer SECRET") });
  for (const [name, args, prefix] of [["web_search", '{"query":"fixture"}', "搜索失败"],
    ["read_page", '{"url":"https://example.invalid"}', "读取失败"], ["weather_forecast", "{}", "天气查询失败"]]) {
    const result = await f.agent.executeTool(name!, args!, f.message());
    assert.match(result, new RegExp(prefix!));
    assert.match(result, /runtime_diagnostics/);
    assert.doesNotMatch(result, /sk-secret|srv\/private|SECRET/);
  }
  assert.deepEqual(f.events().map(event => [event.component, event.reason, event.httpStatus]).sort(),
    [["reader", "authentication", 401], ["search", "rate_limit", 429], ["weather", "permission", 403]].sort());
});

test("运行诊断故障采集：网页和搜索正文中的错误字样及正常MCP正文不会被误判", async t => {
  const f = fixture(t, { lookupBody: "工具执行失败: 这是一段教程，搜索失败说明也是正文" });
  await f.agent.executeTool("web_search", '{"query":"fixture"}', f.message());
  await f.agent.executeTool("read_page", '{"url":"https://example.invalid"}', f.message());
  await f.agent.executeTool(f.lookup.name, '{"stage":1}', f.message());
  assert.equal(f.events().length, 0);
  for (let stage = 1; stage <= 3; stage++) f.steps.push(call(f.lookup.name, `lookup-${stage}`, { stage }));
  f.steps.push(answer());
  await f.agent.generateReply(f.message(), []);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.toolNames(3), ["conversation_action"]);
});

test("运行诊断循环：普通工具故障后模型先读取诊断再正常回答，异常不会造成模型服务错误", async t => {
  const f = fixture(t, { lookupFailsAt: 1 });
  f.steps.push(call(f.lookup.name, "failed", { stage: 1 }), call("runtime_diagnostics", "diag", { component: "mcp" }), answer());
  assert.equal(await f.agent.generateReply(f.message(), []), answer().content);
  assert.equal(f.calls.length, 3);
  assert.equal(f.reads.length, 1);
  const result = JSON.parse(String(f.calls[2]!.messages.find(message => message.tool_call_id === "diag")?.content));
  assert.equal(result.events[0].httpStatus, 503);
  assert.doesNotMatch(JSON.stringify(f.calls), /sk-secret|srv\/private/);
  assert.match(String(f.calls[0]!.messages[0]!.content), /只读工具.*初判说成已经修复/);
});

test("运行诊断预算：第三轮业务故障后仅预留一次诊断，不重新开放研究或文件交付", async t => {
  const f = fixture(t, { lookupFailsAt: 3 });
  for (let stage = 1; stage <= 3; stage++) f.steps.push(call(f.lookup.name, `lookup-${stage}`, { stage }));
  const diag = call("runtime_diagnostics", "diag", { component: "mcp" });
  diag.toolCalls.push(...call(f.lookup.name, "forged-lookup", { stage: 4 }).toolCalls,
    ...call("generate_document", "forged-document", { format: "md", markdown: "不可生成" }).toolCalls);
  f.steps.push(diag, answer());
  await f.agent.generateReply(f.message(), []);
  assert.equal(f.calls.length, 5);
  assert.deepEqual(f.toolNames(3), ["conversation_action", "runtime_diagnostics"]);
  assert.deepEqual(f.toolNames(4), ["conversation_action"]);
  assert.deepEqual(f.lookedUp, [1, 2, 3]);
  assert.equal(f.documents.length, 0);
  for (const id of ["forged-lookup", "forged-document"]) {
    assert.match(String(f.calls[4]!.messages.find(message => message.tool_call_id === id)?.content), /已经关闭.*没有执行/);
  }
});

test("运行诊断预算：前三轮正常时保持原有最终回复预算，不增加诊断请求", async t => {
  const f = fixture(t);
  for (let stage = 1; stage <= 3; stage++) f.steps.push(call(f.lookup.name, `lookup-${stage}`, { stage }));
  f.steps.push(answer());
  await f.agent.generateReply(f.message(), []);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.toolNames(3), ["conversation_action"]);
  assert.equal(f.reads.length, 0);
});

test("运行诊断预算：诊断自身故障仍允许最终回复，仅一次额外诊断且不泄露错误内容", async t => {
  const f = fixture(t, { lookupFailsAt: 3, readFails: true });
  for (let stage = 1; stage <= 3; stage++) f.steps.push(call(f.lookup.name, `lookup-${stage}`, { stage }));
  f.steps.push(call("runtime_diagnostics", "diag"), answer("业务和诊断都出错了，暂时无法确认原因。"));
  assert.equal(await f.agent.generateReply(f.message(), []), "业务和诊断都出错了，暂时无法确认原因。");
  assert.equal(f.calls.length, 5);
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.toolNames(4), ["conversation_action"]);
  assert.doesNotMatch(JSON.stringify(f.calls), /secret diagnostic exception|sk-secret|srv\/private/);
  assert.ok(f.events().some(event => event.errorCode === "TOOL_DIAGNOSTICS_FAILED"));
});

test("运行诊断预算：已诊断过的失败和未授权发送者不获得额外诊断轮", async t => {
  const f = fixture(t, { lookupFailsAt: 1 });
  f.steps.push(call(f.lookup.name, "failed", { stage: 1 }), call("runtime_diagnostics", "diag"), call(f.lookup.name, "lookup", { stage: 2 }), answer());
  await f.agent.generateReply(f.message(), []);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.toolNames(3), ["conversation_action"]);
  const guest = fixture(t, { searchError: new Error("timeout") });
  guest.steps.push(call("web_search", "s1", { query: "q" }), call("web_search", "s2", { query: "q" }), call("web_search", "s3", { query: "q" }), answer());
  await guest.agent.generateReply(guest.message({ senderId: GUEST, conversationId: `private_${GUEST}` }), []);
  assert.equal(guest.calls.length, 4);
  assert.ok(guest.calls.every(call => !call.tools?.some(tool => tool.function.name === "runtime_diagnostics")));
  assert.equal(guest.reads.length, 0);
});

test("运行诊断文档边界：专门交付轮只允许文档，failed及unknown随后允许诊断并保留原状态不重发", async t => {
  for (const documentStatus of ["failed", "unknown"] as const) {
    const f = fixture(t, { documentStatus });
    for (let stage = 1; stage <= 3; stage++) f.steps.push(call(f.lookup.name, `lookup-${stage}`, { stage }));
    f.steps.push(call("generate_document", "doc", { format: "md", markdown: "# 完整研究正文" }),
      call("runtime_diagnostics", "diag", { component: "documents" }), answer());
    const text = "查资料整理成文档发给我";
    await f.agent.generateReply(f.message({ textContent: text, segments: [{ type: "text", data: { text } }] }), []);
    assert.equal(f.calls.length, 6);
    assert.deepEqual(f.toolNames(3), ["conversation_action", "generate_document"]);
    assert.deepEqual(f.toolNames(4), ["conversation_action", "runtime_diagnostics"]);
    assert.deepEqual(f.toolNames(5), ["conversation_action"]);
    assert.equal(f.documents.length, 1);
    const result = JSON.parse(String(f.calls[5]!.messages.find(message => message.tool_call_id === "doc")?.content));
    assert.equal(result.status, documentStatus);
    assert.match(result.diagnosticHint, /runtime_diagnostics/);
    assert.equal(f.events()[0]!.errorCode, documentStatus === "failed" ? "DOCUMENT_DELIVERY_FAILED" : "DOCUMENT_DELIVERY_UNKNOWN");
  }
});

test("运行诊断降级：可选采集器异常和未接入诊断均不能破坏普通回复", async t => {
  for (const options of [{ collectorFails: true }, { diagnostics: false }]) {
    const f = fixture(t, { ...options, lookupFailsAt: 1 });
    f.steps.push(call(f.lookup.name, "failed", { stage: 1 }), answer("已知工具执行失败，原因待确认。"));
    assert.equal(await f.agent.generateReply(f.message(), []), "已知工具执行失败，原因待确认。");
    assert.equal(f.calls.length, 2);
  }
});

test("运行诊断手机故障：可选上下文读取失败仍回复并记录当前私聊关联故障", async t => {
  const f = fixture(t, { presenceError: new Error("HTTP 401 sk-secret /srv/private/phone") });
  f.steps.push(answer("手机状态暂时取不到，普通聊天还能继续。"));
  assert.equal(await f.agent.generateReply(f.message(), []), "手机状态暂时取不到，普通聊天还能继续。");
  assert.deepEqual(f.events().map(event => [event.component, event.operation, event.reason, event.httpStatus]),
    [["presence", "phone_fetch", "authentication", 401]]);
  const group = f.service.snapshot({ scope: "conversation", accountId: "acct", conversationId: "group_100" });
  assert.equal(group.events.length, 0);
  assert.doesNotMatch(JSON.stringify(f.calls), /sk-secret|srv\/private/);
});

test("运行诊断模型故障：模型暂时不可用时仍发通知，恢复后当前会话能查看该故障", async t => {
  const f = fixture(t);
  f.steps.push(new Error("HTTP 503 sk-secret upstream body"));
  await f.agent.replyFlow(f.message(), `private:${OWNER}`);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.kind, "notice");
  const result = JSON.parse(await f.agent.executeTool("runtime_diagnostics", '{"component":"model"}', f.message()));
  assert.equal(result.events[0].operation, "model_reply");
  assert.equal(result.events[0].httpStatus, 503);
  assert.doesNotMatch(JSON.stringify(result), /sk-secret|upstream body/);
});
