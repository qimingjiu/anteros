import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { OneBotProvider, type OneBotOptions } from "../src/onebot/provider.js";
import { Database } from "../src/db/index.js";
import { Gateway } from "../src/gateway/index.js";
import type { Provider, SendResult } from "../src/types.js";

interface Request {
  action: string;
  params: Record<string, unknown>;
  echo: string;
}

function options(endpoint: string): OneBotOptions {
  return {
    accountId: "acct", endpoint, accessToken: "", reconnectBaseMs: 20,
    reconnectMaxMs: 20, heartbeatTimeoutFactor: 2, requestTimeoutMs: 100,
    privateFileAction: "upload_private_file", historyAction: "get_group_msg_history",
  };
}

async function protocol(
  t: TestContext,
  handler: (request: Request, socket: WebSocket) => void,
  overrides: Partial<OneBotOptions> = {},
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const requests: Request[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(String(data)) as Request;
      if (request.action === "get_login_info") {
        socket.send(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: "123456" }, echo: request.echo }));
      } else {
        requests.push(request);
        handler(request, socket);
      }
    });
  });
  const provider = new OneBotProvider({ ...options(`ws://127.0.0.1:${address.port}`), ...overrides });
  t.after(async () => {
    await provider.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  });
  const online = new Promise<void>((resolve) => provider.onEvent((e) => {
    if (e.kind === "login" && e.state === "online") resolve();
  }));
  provider.start();
  await online;
  return { provider, requests };
}

function response(socket: WebSocket, request: Request, data: Record<string, unknown>) {
  socket.send(JSON.stringify({ data: null, ...data, echo: request.echo }));
}

test("文件传输：群与私聊动作、QQ 字符串与中文文件名保持准确", async (t) => {
  const { provider, requests } = await protocol(t, (r, ws) => response(ws, r, { status: "ok", retcode: 0 }));
  assert.equal(provider.capabilities().sendGroupFile, "unverified");
  const file = "/srv/qq-group-bot/documents/周报.pdf";
  assert.deepEqual(await provider.sendGroupFile("12345678901234567", file, "周报.pdf"), { status: "confirmed", messageId: undefined });
  assert.equal(provider.capabilities().sendGroupFile, "supported");
  assert.equal(provider.capabilities().sendPrivateFile, "unverified");
  assert.equal((await provider.sendPrivateFile("2345678", file, "周报.pdf")).status, "confirmed");
  assert.equal(provider.capabilities().sendPrivateFile, "supported");
  assert.deepEqual(requests.map(({ action, params }) => ({ action, params })), [
    { action: "upload_group_file", params: { group_id: "12345678901234567", file, name: "周报.pdf" } },
    { action: "upload_private_file", params: { user_id: "2345678", file, name: "周报.pdf" } },
  ]);
});

test("文件传输：允许自定义群/私聊动作名", async (t) => {
  const { provider, requests } = await protocol(t, (r, ws) => response(ws, r, { status: "ok", retcode: 0 }), {
    privateFileAction: "custom_private_upload", groupFileAction: "custom_group_upload",
  });
  await provider.sendPrivateFile("123456", "/srv/a.docx", "a.docx");
  await provider.sendGroupFile("234567", "/srv/a.docx", "a.docx");
  assert.deepEqual(requests.map((r) => r.action), ["custom_private_upload", "custom_group_upload"]);
});

test("文件传输：真实失败响应标记不支持，不把参数错误当成能力缺失", async (t) => {
  const { provider } = await protocol(t, (r, ws) => response(ws, r,
    r.action === "upload_group_file"
      ? { status: "failed", retcode: 1404, wording: "unknown action" }
      : { status: "failed", retcode: 1400, wording: "file does not exist" }));
  const group = await provider.sendGroupFile("123456", "/srv/a.pdf", "a.pdf");
  assert.equal(group.status, "failed");
  assert.match(group.error!, /协议端不支持 upload_group_file/);
  assert.equal(provider.capabilities().sendGroupFile, "unsupported");
  const privateResult = await provider.sendPrivateFile("123456", "/srv/a.pdf", "a.pdf");
  assert.equal(privateResult.status, "failed");
  assert.equal(privateResult.error, "file does not exist");
  assert.equal(provider.capabilities().sendPrivateFile, "unverified");
});

test("文件传输：兼容 message 错误字段及 method not found 响应", async (t) => {
  const { provider } = await protocol(t, (r, ws) => response(ws, r, { status: "failed", retcode: -32601, message: "Method not found" }));
  const result = await provider.sendPrivateFile("123456", "/srv/a.pdf", "a.pdf");
  assert.equal(result.status, "failed");
  assert.match(result.error!, /Method not found/);
  assert.equal(provider.capabilities().sendPrivateFile, "unsupported");
});

test("文件传输：async 即使 retcode=0 仍为 unknown", async (t) => {
  const { provider } = await protocol(t, (r, ws) => response(ws, r, { status: "async", retcode: 0 }));
  const result = await provider.sendGroupFile("123456", "/srv/a.pdf", "a.pdf");
  assert.equal(result.status, "unknown");
  assert.equal(provider.capabilities().sendGroupFile, "unverified");
});

test("文件传输：failed 状态不会因 retcode=0 被错误确认为成功", async (t) => {
  const { provider } = await protocol(t, (r, ws) => response(ws, r, { status: "failed", retcode: 0, wording: "upload rejected" }));
  const result = await provider.sendGroupFile("123456", "/srv/a.pdf", "a.pdf");
  assert.equal(result.status, "failed");
  assert.equal(result.error, "upload rejected");
  assert.equal(provider.capabilities().sendGroupFile, "unverified");
});

test("文件传输：请求超时的投递结果不明，不自动补发", async (t) => {
  const { provider, requests } = await protocol(t, () => {});
  const result = await provider.sendGroupFile("123456", "/srv/a.pdf", "a.pdf");
  assert.equal(result.status, "unknown");
  assert.match(result.error!, /超时/);
  assert.equal(requests.length, 1);
  assert.equal(provider.capabilities().sendGroupFile, "unverified");
});

test("文件传输：提交后断线保持 unknown", async (t) => {
  const { provider, requests } = await protocol(t, (_r, ws) => ws.close(1000));
  const result = await provider.sendPrivateFile("123456", "/srv/a.pdf", "a.pdf");
  assert.equal(result.status, "unknown");
  assert.match(result.error!, /连接断开/);
  assert.equal(requests.length, 1);
  assert.equal(provider.capabilities().sendPrivateFile, "unverified");
});

test("文件传输：离线与非法参数确定为 failed，不提交、不改变能力", async () => {
  const provider = new OneBotProvider(options("ws://127.0.0.1:1"));
  for (const [id, file, name] of [
    ["123456", "/srv/a.pdf", "a.pdf"], ["0", "/srv/a.pdf", "a.pdf"],
    ["abc", "/srv/a.pdf", "a.pdf"], ["123456", "", "a.pdf"],
    ["123456", "/srv/a\0.pdf", "a.pdf"], ["123456", "/srv/a.pdf", "../a.pdf"],
    ["123456", "/srv/a.pdf", ""], ["123456", "/srv/a.pdf", "a\n.pdf"],
  ]) {
    assert.equal((await provider.sendGroupFile(id!, file!, name!)).status, "failed");
    assert.equal((await provider.sendPrivateFile(id!, file!, name!)).status, "failed");
  }
  assert.equal(provider.capabilities().sendPrivateFile, "unverified");
  assert.equal(provider.capabilities().sendGroupFile, "unverified");
});

function gatewayFixture(t: TestContext, fileResult: SendResult | Error = { status: "confirmed" }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qq-files-"));
  const db = new Database(path.join(directory, "test.db"));
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const uploads: { targetType: string; targetId: string; filePath: string; fileName: string }[] = [];
  const upload = async (targetType: string, targetId: string, filePath: string, fileName: string): Promise<SendResult> => {
    uploads.push({ targetType, targetId, filePath, fileName });
    if (fileResult instanceof Error) throw fileResult;
    return fileResult;
  };
  const provider: Provider = {
    providerId: "test", start() {}, async stop() {}, onEvent() {},
    health: () => ({ connection: "connected", login: "online", reconnectCount: 0 }),
    capabilities: () => ({ receiveMessages: "supported", sendText: "supported", sendImage: "unverified", sendPrivateFile: "supported", sendGroupFile: "supported", groupHistory: "unsupported" }),
    async sendPrivateMsg() { assert.fail("文件不能走文本发送"); },
    async sendGroupMsg() { assert.fail("文件不能走文本发送"); },
    sendPrivateFile: (id, file, name) => upload("private", id, file, name),
    sendGroupFile: (id, file, name) => upload("group", id, file, name),
  };
  const gateway = new Gateway(db, provider, { accountId: "acct", backfillMaxPages: 0, backfillPageLimit: 100 });
  const execute = (id: number) => (gateway as unknown as { executeSendTask(id: number): Promise<void> }).executeSendTask(id);
  return { db, gateway, provider, uploads, execute };
}

test("文件队列：群与私聊各走对应文件 API，确认与幂等落库", async (t) => {
  const { db, gateway, uploads, execute } = gatewayFixture(t);
  for (const targetType of ["group", "private"] as const) {
    const task = {
      taskKey: `document:${targetType}:1`, kind: "document_file", conversationType: targetType,
      targetId: "123456", payload: { kind: "file" as const, filePath: "/srv/a.pdf", fileName: "a.pdf" },
    };
    const queued = gateway.enqueueSend(task);
    assert.equal(gateway.enqueueSend(task).reused, true);
    await execute(queued.id);
    await execute(queued.id);
    assert.equal(db.sendTaskById(queued.id)?.status, "confirmed");
    assert.equal(db.sendTaskById(queued.id)?.attempts, 1);
  }
  assert.deepEqual(uploads.map((u) => u.targetType), ["group", "private"]);
  assert.equal(gateway.getStats().sentConfirmed, 2);
});

test("文件队列：缺失上传接口明确 failed", async (t) => {
  const { db, gateway, provider, uploads, execute } = gatewayFixture(t);
  delete provider.sendGroupFile;
  delete provider.sendPrivateFile;
  for (const targetType of ["group", "private"] as const) {
    const queued = gateway.enqueueSend({ kind: "document_file", conversationType: targetType, targetId: "123456", payload: { kind: "file", filePath: "/srv/a.pdf", fileName: "a.pdf" } });
    await execute(queued.id);
    assert.equal(db.sendTaskById(queued.id)?.status, "failed");
    assert.match(db.sendTaskById(queued.id)?.last_error ?? "", /未实现/);
  }
  assert.equal(uploads.length, 0);
  assert.equal(gateway.getStats().sentFailed, 2);
});

test("文件队列：未知或异常结果落库后不再次执行", async (t) => {
  for (const result of [{ status: "unknown" as const, error: "已提交异步上传" }, new Error("connection dropped")]) {
    const { db, gateway, uploads, execute } = gatewayFixture(t, result);
    const queued = gateway.enqueueSend({ kind: "document_file", conversationType: "group", targetId: "123456", payload: { kind: "file", filePath: "/srv/a.pdf", fileName: "a.pdf" } });
    await execute(queued.id);
    await execute(queued.id);
    assert.equal(db.sendTaskById(queued.id)?.status, "unknown");
    assert.equal(uploads.length, 1);
    assert.equal(gateway.getStats().sentUnknown, 1);
  }
});

test("文件队列：无效文件载荷及破损 JSON 不会卡在 in_flight", async (t) => {
  const { db, uploads, execute } = gatewayFixture(t);
  for (const payload of [
    { kind: "file", filePath: "", fileName: "a.pdf" },
    { kind: "file", filePath: "/srv/a.pdf", fileName: "../a.pdf" },
    { kind: "file", filePath: "/srv/a.pdf", fileName: "" }, null,
  ]) {
    const queued = db.enqueueSendTask({ kind: "document_file", conversationType: "group", targetId: "123456", payload });
    await execute(queued.id);
    assert.equal(db.sendTaskById(queued.id)?.status, "failed");
    assert.equal(db.sendTaskById(queued.id)?.attempts, 0);
  }
  const broken = db.enqueueSendTask({ kind: "document_file", conversationType: "private", targetId: "123456", payload: {} });
  db.db.prepare("UPDATE send_tasks SET payload = ? WHERE id = ?").run("{bad-json", broken.id);
  await execute(broken.id);
  assert.equal(db.sendTaskById(broken.id)?.status, "failed");
  assert.equal(uploads.length, 0);
});

test("崩溃恢复：所有文件与 document 类任务标 unknown，普通回复重新排队", (t) => {
  const { db } = gatewayFixture(t);
  const file = { kind: "file", filePath: "/srv/a.pdf", fileName: "a.pdf" };
  const cases = [
    { kind: "document_file", target: "group" as const, payload: file, status: "unknown" },
    { kind: "document_file", target: "private" as const, payload: file, status: "unknown" },
    { kind: "export", target: "group" as const, payload: file, status: "unknown" },
    { kind: "custom_upload", target: "private" as const, payload: file, status: "unknown" },
    { kind: "document_reply", target: "private" as const, payload: { kind: "segments", segments: [] }, status: "unknown" },
    { kind: "report_file", target: "private" as const, payload: {}, status: "unknown" },
    { kind: "proactive_private", target: "private" as const, payload: {}, status: "unknown" },
    { kind: "reply", target: "group" as const, payload: { kind: "segments", segments: [] }, status: "queued" },
  ];
  const tasks = cases.map((item) => {
    const task = db.enqueueSendTask({ kind: item.kind, conversationType: item.target, targetId: "123456", payload: item.payload });
    db.claimSendTask(task.id);
    db.bumpSendTaskAttempt(task.id);
    return { ...item, id: task.id };
  });
  assert.deepEqual(db.resetInFlightTasks(), { unknowned: 7, requeued: 1 });
  for (const task of tasks) {
    assert.equal(db.sendTaskById(task.id)?.status, task.status, task.kind);
    assert.equal(db.sendTaskById(task.id)?.attempts, 1, "恢复不能增加发送次数");
  }
  assert.deepEqual(db.resetInFlightTasks(), { unknowned: 0, requeued: 0 }, "重复恢复不修改已经恢复的任务");
  assert.equal(db.pendingSendTasks(100).length, 1, "结果不明的文件不会进入待发送队列");
});

test("崩溃恢复：破损或非对象 JSON 不影响其他任务，保留既有终态", (t) => {
  const { db } = gatewayFixture(t);
  const cases = [
    { kind: "document_file", raw: "{broken", status: "unknown" },
    { kind: "report_file", raw: "{broken", status: "unknown" },
    { kind: "proactive_group", raw: "{broken", status: "unknown" },
    { kind: "reply", raw: "{broken", status: "queued" },
    { kind: "reply", raw: "null", status: "queued" },
    { kind: "reply", raw: "42", status: "queued" },
    { kind: "reply", raw: "[]", status: "queued" },
  ];
  const tasks = cases.map((item) => {
    const task = db.enqueueSendTask({ kind: item.kind, conversationType: "group", targetId: "123456", payload: {} });
    db.claimSendTask(task.id);
    db.db.prepare("UPDATE send_tasks SET payload = ? WHERE id = ?").run(item.raw, task.id);
    return { ...item, id: task.id };
  });
  const terminalTasks = ["confirmed", "failed", "unknown"] as const;
  const terminalIds = terminalTasks.map((status) => {
    const task = db.enqueueSendTask({ kind: "document_file", conversationType: "private", targetId: "123456", payload: { kind: "file" } });
    db.finishSendTask(task.id, status, "original result");
    return task.id;
  });
  const queued = db.enqueueSendTask({ kind: "document_file", conversationType: "private", targetId: "123456", payload: { kind: "file" } });
  assert.deepEqual(db.resetInFlightTasks(), { unknowned: 3, requeued: 4 });
  for (const task of tasks) assert.equal(db.sendTaskById(task.id)?.status, task.status);
  terminalIds.forEach((id, index) => {
    assert.equal(db.sendTaskById(id)?.status, terminalTasks[index]);
    assert.equal(db.sendTaskById(id)?.last_error, "original result");
  });
  assert.equal(db.sendTaskById(queued.id)?.status, "queued", "尚未认领的文件仍应正常排队");
});
