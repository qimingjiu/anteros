import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeDiagnostics, classifyDiagnosticFailure, sanitizeDiagnosticStatus, type RuntimeDiagnosticsReadRequest } from "../src/diagnostics/index.js";
import { logger, setLogLevel, subscribeDiagnosticLogs } from "../src/util/logger.js";
import { Database } from "../src/db/index.js";
import { Gateway } from "../src/gateway/index.js";
import { IncomingFileError } from "../src/documents/incoming-errors.js";
import type { Provider, SendResult } from "../src/types.js";

const NOW = Date.parse("2026-10-14T11:00:00.000Z");
const globalRequest: RuntimeDiagnosticsReadRequest = { scope: "global", accountId: "123456789", conversationId: "private_111111111" };
const groupRequest: RuntimeDiagnosticsReadRequest = { scope: "conversation", accountId: "123456789", conversationId: "group_987654321" };
const forbidden = /my-secret|sk-super|sb_secret|private-chat|raw-arguments|reasoning_content|111111111|123456789|987654321|file-private|secret-url|nested-sensitive/;

test("文件诊断：区分授权、选择、下载与解析，不把所有失败误报为上游故障", () => {
  const cases=[
    [new IncomingFileError("authorization","not_authorized","my-secret"),"permission","authorization",undefined],
    [new IncomingFileError("selection","not_found","file-private"),"invalid_response","selection",undefined],
    [new IncomingFileError("download","download_failed","secret-url",403),"permission","download",403],
    [new IncomingFileError("download","download_failed","my-secret",503),"upstream_error","download",503],
    [new IncomingFileError("parse","parse_timeout","nested-sensitive"),"timeout","parse",undefined],
  ] as const;
  for(const [error,reason,fileStage,httpStatus] of cases){
    const result=classifyDiagnosticFailure(error);
    assert.equal(result.reason,reason);assert.equal(result.fileStage,fileStage);assert.equal(result.httpStatus,httpStatus);
    assert.doesNotMatch(JSON.stringify(result),forbidden);
  }
  const service=new RuntimeDiagnostics({subscribeLogs:false});
  try{
    service.recordFailure("documents",cases[0][0],{...globalRequest,operation:"read_file"});
    assert.equal(service.snapshot(globalRequest).events[0]!.fileStage,"authorization");
    assert.doesNotMatch(service.read(globalRequest),forbidden);
  }finally{service.close();}
});

test("诊断分类只返回固定故障类别和安全代码，不返回异常文本和原始参数", () => {
  const cases = [
    [new Error("HTTP 401 https://secret-url?api_key=my-secret private-chat"), "authentication", 401],
    [new Error("HTTP 403 sb_secret_nested-sensitive"), "permission", 403],
    [new Error("HTTP 429 too many requests raw-arguments"), "rate_limit", 429],
    [new Error("HTTP 503 reasoning_content: nested-sensitive"), "upstream_error", 503],
    [new DOMException("file-private", "TimeoutError"), "timeout", undefined],
    [Object.assign(new Error("secret-url"), { code: "ENOTFOUND" }), "network", undefined],
    [new Error("retcode=-32601 secret-url"), "unsupported", undefined],
  ] as const;
  for (const [error, reason, status] of cases) {
    const result = classifyDiagnosticFailure(error);
    assert.equal(result.reason, reason);
    assert.equal(result.httpStatus, status);
    assert.doesNotMatch(JSON.stringify(result), forbidden);
  }
  assert.deepEqual(classifyDiagnosticFailure({ code: "my-secret", message: "private-chat", details: { status: 403 } }), { reason: "internal" });
  assert.deepEqual(classifyDiagnosticFailure({ get message() { throw new Error("my-secret"); } }), { reason: "internal" });
});

test("logger订阅出口没有日志原文、聊天内容、密钥、工具参数或推理字段，独立于打印级别", () => {
  const observed: unknown[] = [];
  const unsubscribe = subscribeDiagnosticLogs(event => observed.push(event));
  setLogLevel("error");
  try {
    logger("llm").warn("模型调用失败 model=private-chat", new Error("HTTP 429 my-secret"), {
      api_key: "sk-super", reasoning_content: "nested-sensitive", arguments: "raw-arguments", accountId: "123456789",
    });
    logger("agent").info("private-chat my-secret");
    assert.equal(observed.length, 1);
    assert.equal((observed[0] as any).component, "model");
    assert.equal((observed[0] as any).httpStatus, 429);
    assert.doesNotMatch(JSON.stringify(observed), forbidden);
  } finally { unsubscribe(); setLogLevel("info"); }
});

test("失败的logger诊断订阅不会阻断其他订阅或普通日志", () => {
  let observed = 0;
  const stopBroken = subscribeDiagnosticLogs(() => { throw new Error("broken observer"); });
  const stopGood = subscribeDiagnosticLogs(() => { observed++; });
  setLogLevel("error");
  try { assert.doesNotThrow(() => logger("mcp").warn("固定错误", new Error("HTTP 503"))); assert.equal(observed, 1); }
  finally { stopBroken(); stopGood(); setLogLevel("info"); }
});

test("诊断按真实账号和会话隔离，群聊不读取全局、其他群或私聊事件", () => {
  const service = new RuntimeDiagnostics({ now: () => NOW, subscribeLogs: false });
  service.recordFailure("mcp", new Error("HTTP 503 private-chat"));
  service.recordFailure("documents", new Error("retcode=1404 my-secret"), { ...groupRequest, operation: "generate_document" });
  service.recordFailure("search", new Error("timeout private-chat"), { ...globalRequest, operation: "web_search" });
  service.recordFailure("reader", new Error("HTTP 403"), { accountId: "another-account", conversationId: groupRequest.conversationId });
  service.recordFailure("weather", new Error("HTTP 503"), { accountId: groupRequest.accountId, conversationId: "group_another" });
  const snapshot = service.snapshot(groupRequest);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]!.component, "documents");
  assert.equal(snapshot.events[0]!.retcode, 1404);
  assert.equal(service.snapshot(globalRequest).events.length, 5);
  assert.doesNotMatch(service.read(globalRequest), forbidden);
  assert.equal(service.snapshot({ ...groupRequest, accountId: "" }).events.length, 0);
  service.close();
});

test("gateway固定失败模板附带会话hash和安全操作，unknown结果不转换为failed", () => {
  const service = new RuntimeDiagnostics({ subscribeLogs: true });
  setLogLevel("error");
  try {
    logger("gateway").warn("投递回执不明", "timeout private-chat", { ...groupRequest, operation: "generate_document", status: "unknown", raw: "my-secret" });
    const snapshot = service.snapshot(groupRequest);
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0]!.reason, "delivery_unknown");
    assert.equal(snapshot.events[0]!.operation, "generate_document");
    assert.doesNotMatch(service.read(groupRequest), forbidden);
  } finally { service.close(); setLogLevel("info"); }
});

test("真实Gateway文件失败与unknown回执进入当前群诊断，并保持不自动重发和正文脱敏", async () => {
  const db = new Database(":memory:");
  const diagnostics = new RuntimeDiagnostics();
  let calls = 0;
  const provider: Provider = {
    providerId: "isolated-diagnostic-provider", start() {}, async stop() {}, onEvent() {},
    health: () => ({ connection: "connected", login: "online", reconnectCount: 0 }),
    capabilities: () => ({ receiveMessages: "supported", sendText: "supported", sendImage: "unsupported", sendPrivateFile: "supported", sendGroupFile: "supported", groupHistory: "unsupported" }),
    async sendPrivateMsg() { assert.fail("该验收只允许隔离文件接口"); },
    async sendGroupMsg() { assert.fail("该验收只允许隔离文件接口"); },
    async sendGroupFile(): Promise<SendResult> {
      calls++;
      return calls === 1 ? { status: "failed", error: "HTTP 403 file-private my-secret" }
        : { status: "unknown", error: "timeout private-chat raw-arguments reasoning_content" };
    },
    async sendPrivateFile() { calls++; return { status: "failed", error: "HTTP 503 private-chat my-secret" }; },
  };
  const gateway = new Gateway(db, provider, { accountId: groupRequest.accountId, backfillMaxPages: 0, backfillPageLimit: 10 });
  const execute = (id: number) => (gateway as unknown as { executeSendTask(id: number): Promise<void> }).executeSendTask(id);
  setLogLevel("error");
  try {
    const targetId = groupRequest.conversationId.slice("group_".length);
    for (let i = 0; i < 2; i++) {
      const task = gateway.enqueueSend({ kind: "document_file", taskKey: `isolated-file-${i}`, conversationType: "group", targetId,
        payload: { kind: "file", filePath: "/work/file-private.docx", fileName: "file-private.docx" } });
      await execute(task.id);
      assert.equal(db.sendTaskById(task.id)!.status, i === 0 ? "failed" : "unknown");
      assert.equal(db.sendTaskById(task.id)!.attempts, 1);
      await execute(task.id);
    }
    const privateTask = gateway.enqueueSend({ kind: "document_file", conversationType: "private", targetId: "111111111",
      payload: { kind: "file", filePath: "/work/file-private.docx", fileName: "file-private.docx" } });
    await execute(privateTask.id);
    const group = diagnostics.snapshot(groupRequest);
    assert.equal(group.events.length, 2);
    assert.equal(group.events[0]!.reason, "delivery_unknown");
    assert.equal(group.events[1]!.reason, "permission");
    assert.equal(group.events[1]!.httpStatus, 403);
    assert.ok(group.events.every(event => event.component === "gateway" && event.operation === "send_file"));
    assert.equal(diagnostics.snapshot(globalRequest).events.length, 3);
    assert.equal(calls, 3, "已失败和结果不明的发送不能因诊断或重复执行自动重发");
    assert.equal(db.pendingSendTasks(10).length, 0);
    assert.doesNotMatch(diagnostics.read(groupRequest), forbidden);
  } finally { diagnostics.close(); db.close(); setLogLevel("info"); }
});

test("只保留最近24小时，最多20条返回，并允许固定组件筛选", () => {
  let now = NOW;
  const service = new RuntimeDiagnostics({ now: () => now, maxEvents: 30, subscribeLogs: false });
  service.recordFailure("gateway", new Error("timeout"));
  now += 86400001;
  for (let i = 0; i < 40; i++) { service.recordFailure(i % 2 ? "mcp" : "search", new Error("HTTP 503")); now++; }
  const snapshot = service.snapshot(globalRequest);
  assert.equal(snapshot.windowHours, 24);
  assert.equal(snapshot.events.length, 20);
  assert.equal(snapshot.matchedEvents, 30);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.events.some(event => event.component === "gateway"), false);
  assert.ok(snapshot.events[0]!.at >= snapshot.events.at(-1)!.at);
  const filtered = service.snapshot({ ...globalRequest, component: "mcp", limit: 3 });
  assert.equal(filtered.events.length, 3);
  assert.equal(filtered.matchedEvents, 15);
  assert.ok(filtered.events.every(event => event.component === "mcp"));
  service.close();
});

test("安全诊断单独持久化、重启可读，日志正文和QQ身份不落盘", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qq-diagnostic-"));
  try {
    const first = new RuntimeDiagnostics({ directory, now: () => NOW, subscribeLogs: false });
    first.recordFailure("documents", new Error("HTTP 503 file-private my-secret"), { ...groupRequest, operation: "send_file" });
    first.close();
    const body = fs.readFileSync(path.join(directory, "events.jsonl"), "utf8");
    assert.doesNotMatch(body, forbidden);
    assert.match(body, /"scopeHash":"[a-f0-9]{64}"/);
    const second = new RuntimeDiagnostics({ directory, now: () => NOW + 1000, subscribeLogs: false });
    assert.equal(second.snapshot(groupRequest).events.length, 1);
    assert.equal(second.snapshot(groupRequest).storage, "persistent");
    second.close();
    const expired = new RuntimeDiagnostics({ directory, now: () => NOW + 86400001, subscribeLogs: false });
    assert.equal(expired.snapshot(globalRequest).events.length, 0);
    assert.equal(fs.readFileSync(path.join(directory, "events.jsonl"), "utf8"), "");
    expired.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("重启加载不信任持久化内容，重新做白名单投射且不读取旁边raw logs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qq-diagnostic-"));
  try {
    fs.writeFileSync(path.join(directory, "bot_2026-10-14.log"), "private-chat my-secret");
    fs.writeFileSync(path.join(directory, "events.jsonl"), [
      JSON.stringify({ at: new Date(NOW).toISOString(), component: "gateway", reason: "timeout", level: "warn", message: "private-chat", api_key: "my-secret", accountId: "123456789", errorCode: "sb_secret", httpStatus: 503 }),
      JSON.stringify({ at: new Date(NOW).toISOString(), component: "secret-url", reason: "timeout", level: "warn" }),
      "incomplete-json private-chat",
      JSON.stringify({ at: "private-chat", component: "gateway", reason: "timeout", level: "warn" }),
    ].join("\n"));
    const service = new RuntimeDiagnostics({ directory, now: () => NOW, subscribeLogs: false });
    assert.equal(service.snapshot(globalRequest).events.length, 1);
    assert.doesNotMatch(service.read(globalRequest), forbidden);
    assert.doesNotMatch(fs.readFileSync(path.join(directory, "events.jsonl"), "utf8"), forbidden);
    service.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("诊断写盘失败保留内存事件，oversized旧journal不读取", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qq-diagnostic-"));
  try {
    const invalidDirectory = path.join(directory, "not-a-directory");
    fs.writeFileSync(invalidDirectory, "private-chat my-secret");
    const service = new RuntimeDiagnostics({ directory: invalidDirectory, now: () => NOW, subscribeLogs: false });
    assert.doesNotThrow(() => service.recordFailure("search", new Error("HTTP 503 my-secret")));
    assert.equal(service.snapshot(globalRequest).storage, "unavailable");
    assert.equal(service.snapshot(globalRequest).events.length, 1);
    service.close();
    fs.writeFileSync(path.join(directory, "events.jsonl"), "private-chat".repeat(60000));
    const oversized = new RuntimeDiagnostics({ directory, now: () => NOW, subscribeLogs: false });
    assert.equal(oversized.snapshot(globalRequest).events.length, 0);
    assert.equal(oversized.snapshot(globalRequest).storage, "unavailable");
    oversized.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("状态白名单拒绝密钥、URL、应用名、传感器读数、任意嵌套文本和自定义代码", () => {
  const status = sanitizeDiagnosticStatus({ component: "mcp", name: "sb_secret", configured: true, count: -1, failure: "my-secret",
    details: { service: "cn-scraper", transport: "http", model: "deepseek-v4-flash", provider: "openai_compatible", toolCount: 5,
      endpoint: "secret-url", api_key: "my-secret", foreground_app: "private-chat", battery_level: 42,
      capabilities: { sendGroupFile: "supported", raw: "nested-sensitive" }, arbitrary: { key: "nested-sensitive" } } });
  assert.deepEqual(status, { component: "mcp", configured: true, details: { service: "cn-scraper", model: "deepseek-v4-flash", provider: "openai_compatible", transport: "http", toolCount: 5, capabilities: { sendGroupFile: "supported" } } });
  assert.doesNotMatch(JSON.stringify(status), forbidden);
});

test("群聊状态快照不展示手机、记忆或定时私聊聚合，返回预算小于6000字符", () => {
  const service = new RuntimeDiagnostics({ now: () => NOW, subscribeLogs: false,
    currentStatus: () => [
      { component: "presence", configured: true, details: { currentFieldCount: 8 } },
      { component: "memory", count: 42 }, { component: "proactive", enabled: true },
      ...Array.from({ length: 24 }, () => ({ component: "mcp" as const, details: { service: "mcp-safe-long-name-service", model: "deepseek-long-model-name", toolCount: 100, failedTasks: 1, unknownTasks: 4, capabilities: { receiveMessages: "supported" as const, sendText: "supported" as const, sendGroupFile: "unsupported" as const, sendImage: "supported" as const } } })),
    ] });
  for (let i = 0; i < 20; i++) service.record({ component: "documents", level: "warn", reason: "delivery_unknown", errorCode: "DOCUMENT_DELIVERY_UNKNOWN", operation: "generate_document", httpStatus: 503, retcode: 1200, ...groupRequest });
  const snapshot = JSON.parse(service.read(groupRequest));
  assert.ok(service.read(groupRequest).length < 6000);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.current.some((entry: any) => ["presence", "memory", "proactive"].includes(entry.component)), false);
  assert.equal(snapshot.scope, "conversation");
  assert.equal(snapshot.windowHours, 24);
  assert.doesNotMatch(service.read(groupRequest), forbidden);
  service.close();
});

test("停止服务会移除logger订阅，不持续采集后续警告", () => {
  const service = new RuntimeDiagnostics();
  setLogLevel("error");
  try {
    logger("reader").warn("HTTP 503");
    assert.equal(service.snapshot(globalRequest).events.length, 1);
    service.close();
    logger("reader").warn("HTTP 503");
    assert.equal(service.snapshot(globalRequest).events.length, 1);
  } finally { service.close(); setLogLevel("info"); }
});
