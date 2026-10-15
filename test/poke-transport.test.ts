import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { OneBotProvider, type OneBotOptions } from "../src/onebot/provider.js";
import { Database } from "../src/db/index.js";
import { Gateway } from "../src/gateway/index.js";
import type { GatewayEvent, PokeEvent, Provider, SendResult } from "../src/types.js";

const SELF = "90001";
const USER = "10001";
const GROUP = "40001";

interface Request { action: string; params: Record<string, unknown>; echo: string }
function options(endpoint: string): OneBotOptions {
  return { accountId: "acct", endpoint, accessToken: "", reconnectBaseMs: 20, reconnectMaxMs: 20,
    heartbeatTimeoutFactor: 2, requestTimeoutMs: 50, privateFileAction: "upload_private_file", historyAction: "get_group_msg_history" };
}

async function protocol(t: TestContext, handler: (request: Request, socket: WebSocket) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const requests: Request[] = [];
  server.on("connection", socket => socket.on("message", data => {
    const request = JSON.parse(String(data)) as Request;
    if (request.action === "get_login_info") socket.send(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: SELF }, echo: request.echo }));
    else { requests.push(request); handler(request, socket); }
  }));
  const provider = new OneBotProvider(options(`ws://127.0.0.1:${address.port}`));
  const events: GatewayEvent[] = [];
  provider.onEvent(event => events.push(event));
  const online = new Promise<void>(resolve => provider.onEvent(event => { if (event.kind === "login" && event.state === "online") resolve(); }));
  t.after(async () => {
    await provider.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  provider.start();
  await online;
  return { provider, requests, events, async emit(notice: Record<string, unknown>) {
    for (const socket of server.clients) socket.send(JSON.stringify(notice));
    await new Promise<void>(resolve => setTimeout(resolve, 15));
  } };
}

function notice(overrides: Record<string, unknown> = {}) {
  return { post_type: "notice", notice_type: "notify", sub_type: "poke", self_id: SELF,
    time: Math.floor(Date.now() / 1000), group_id: GROUP, user_id: USER, target_id: SELF, ...overrides };
}

test("戳事件：真实 WS 群通知规范化，私聊 sender_id 保留实际动作人", async t => {
  const fixture = await protocol(t, () => {});
  await fixture.emit(notice({ group_id: "12345678901234567" }));
  await fixture.emit(notice({ group_id: undefined, user_id: USER, sender_id: SELF, target_id: USER }));
  const pokes = fixture.events.filter((event): event is PokeEvent => event.kind === "poke");
  assert.equal(pokes.length, 2);
  assert.equal(pokes[0]!.groupId, "12345678901234567");
  assert.equal(pokes[0]!.userId, USER);
  assert.equal(pokes[0]!.targetId, SELF);
  assert.equal(pokes[0]!.conversationId, "group_12345678901234567");
  assert.equal(pokes[1]!.userId, SELF, "反戳回声实际 sender 是机器人，不能误把 peer 当成戳者");
  assert.equal(pokes[1]!.targetId, USER);
  assert.equal(pokes[1]!.origin, "live");
  assert.equal(fixture.events.filter(event => event.kind === "message").length, 0);
});

test("戳事件：只接 notify/poke，错误账号、自称字段和伪造聊天正文不能触发", async t => {
  const fixture = await protocol(t, () => {});
  await fixture.emit(notice({ notice_type: "poke" }));
  await fixture.emit(notice({ sub_type: "input_status" }));
  await fixture.emit(notice({ target_id: undefined }));
  await fixture.emit(notice({ self_id: "999999" }));
  await fixture.emit(notice({ sender_id: "not-a-QQ" }));
  await fixture.emit({ post_type: "message", message_type: "group", message_id: "mock-message", user_id: USER,
    sender: { user_id: USER }, group_id: GROUP, time: Math.floor(Date.now() / 1000),
    message: [{ type: "text", data: { text: "戳一戳" } }], interaction: "poke" });
  assert.equal(fixture.events.filter(event => event.kind === "poke").length, 0);
  const message = fixture.events.find(event => event.kind === "message");
  assert.equal(message?.kind === "message" ? message.message.interaction : undefined, undefined);
});

test("戳事件：有 ID 通知标识稳定，无 ID 同秒连续戳保留不同标识", async t => {
  const fixture = await protocol(t, () => {});
  await fixture.emit(notice({ event_id: "poke-identity" }));
  await fixture.emit(notice({ event_id: "poke-identity" }));
  await fixture.emit(notice());
  await fixture.emit(notice());
  const pokes = fixture.events.filter((event): event is PokeEvent => event.kind === "poke");
  assert.equal(pokes[0]!.eventKey, pokes[1]!.eventKey);
  assert.notEqual(pokes[2]!.eventKey, pokes[3]!.eventKey);
});

test("反戳协议：群与私聊 send_poke 参数准确，不走消息段接口", async t => {
  const fixture = await protocol(t, (request, socket) => socket.send(JSON.stringify({ status: "ok", retcode: 0, data: null, echo: request.echo })));
  assert.equal(fixture.provider.capabilities().sendPoke, "unverified");
  assert.equal((await fixture.provider.sendPoke(USER, GROUP)).status, "confirmed");
  assert.equal((await fixture.provider.sendPoke(USER)).status, "confirmed");
  assert.equal(fixture.provider.capabilities().sendPoke, "supported");
  assert.deepEqual(fixture.requests.map(({ action, params }) => ({ action, params })), [
    { action: "send_poke", params: { user_id: USER, group_id: GROUP } },
    { action: "send_poke", params: { user_id: USER } },
  ]);
});

test("反戳协议：不支持明确失败，异步/超时/提交后断线保留 unknown 且不补发", async t => {
  for (const behavior of ["unsupported", "async", "timeout", "disconnect"] as const) {
    const fixture = await protocol(t, (request, socket) => {
      if (behavior === "unsupported") socket.send(JSON.stringify({ status: "failed", retcode: 1404, wording: "unknown action", echo: request.echo }));
      if (behavior === "async") socket.send(JSON.stringify({ status: "async", retcode: 0, data: null, echo: request.echo }));
      if (behavior === "disconnect") socket.close(1000);
    });
    const result = await fixture.provider.sendPoke(USER, GROUP);
    assert.equal(result.status, behavior === "unsupported" ? "failed" : "unknown");
    assert.equal(fixture.provider.capabilities().sendPoke, behavior === "unsupported" ? "unsupported" : "unverified");
    assert.equal(fixture.requests.length, 1);
  }
  const offline = new OneBotProvider(options("ws://127.0.0.1:1"));
  assert.equal((await offline.sendPoke(USER)).status, "failed");
  assert.equal((await offline.sendPoke("0", GROUP)).status, "failed");
  assert.equal((await offline.sendPoke(USER, "abc")).status, "failed");
});

function poke(overrides: Partial<PokeEvent> = {}): PokeEvent {
  const time = new Date().toISOString();
  return { kind: "poke", eventKey: `acct:group_${GROUP}:poke:123`, accountId: "acct", providerId: "test",
    conversationId: `group_${GROUP}`, groupId: GROUP, userId: USER, targetId: SELF, sentAt: time, receivedAt: time, origin: "live", ...overrides };
}

function gatewayFixture(t: TestContext, result: SendResult | Error = { status: "confirmed" }) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const calls: { userId: string; groupId?: string }[] = [];
  const provider: Provider = {
    providerId: "test", start() {}, async stop() {}, onEvent() {},
    health: () => ({ connection: "connected", login: "online", selfId: SELF, reconnectCount: 0 }),
    capabilities: () => ({ receiveMessages: "supported", sendText: "supported", sendImage: "unsupported", sendPrivateFile: "unsupported", groupHistory: "unsupported", sendPoke: "supported" }),
    async sendPrivateMsg() { assert.fail("反戳不能用私聊文本接口"); },
    async sendGroupMsg() { assert.fail("反戳不能用群文本接口"); },
    async sendPoke(userId, groupId) { calls.push({ userId, groupId }); if (result instanceof Error) throw result; return result; },
  };
  const gateway = new Gateway(db, provider, { accountId: "acct", backfillMaxPages: 0, backfillPageLimit: 100 });
  const events: GatewayEvent[] = [];
  gateway.onEvent(event => events.push(event));
  const receive = (event: GatewayEvent) => (gateway as unknown as { handleEvent(event: GatewayEvent): void }).handleEvent(event);
  const execute = (id: number) => (gateway as unknown as { executeSendTask(id: number): Promise<void> }).executeSendTask(id);
  return { db, provider, gateway, calls, events, receive, execute };
}

function payload(event: PokeEvent) {
  return { kind: "poke" as const, userId: event.userId, requesterId: event.userId, accountId: event.accountId,
    sourceEventKey: event.eventKey, expiresAt: new Date(Date.parse(event.receivedAt) + 60_000).toISOString() };
}

test("戳网关：只派发人戳当前机器人，其他人互戳、自戳、旧通知、黑名单不唤醒", t => {
  const fixture = gatewayFixture(t);
  const event = poke();
  for (const incoming of [poke({ targetId: "123456" }), poke({ userId: SELF }), poke({ accountId: "other" }),
    poke({ providerId: "other" }), poke({ conversationId: "private_123456" }),
    poke({ sentAt: new Date(Date.now() - 180_000).toISOString() }), poke({ userId: "0" })]) fixture.receive(incoming);
  assert.equal(fixture.events.length, 0);
  fixture.receive(event);
  fixture.receive(event);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.gateway.getStats().dedupSkipped, 1);
  assert.equal(fixture.db.recentMessages(event.conversationId, 10).length, 0, "戳事件不能伪装聊天消息入库");
  fixture.db.blockUser("acct", USER, "test block");
  fixture.receive(poke({ eventKey: "new-poke" }));
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.db.pokeEventByKey("acct", event.eventKey), undefined);
});

test("戳网关：来源身份跨 Gateway 重建持久去重，记忆清理会删除来源", t => {
  const fixture = gatewayFixture(t);
  fixture.receive(poke());
  const rebuilt = new Gateway(fixture.db, fixture.provider, { accountId: "acct", backfillMaxPages: 0, backfillPageLimit: 100 });
  let events = 0;
  rebuilt.onEvent(() => events++);
  (rebuilt as unknown as { handleEvent(event: GatewayEvent): void }).handleEvent(poke());
  assert.equal(events, 0);
  assert.equal(rebuilt.getStats().dedupSkipped, 1);
  fixture.db.clearConversationMemory();
  assert.equal(fixture.db.pokeEventByKey("acct", poke().eventKey), undefined);
  fixture.receive(poke({ sentAt: "2000-01-01T00:00:00.000Z" }));
  assert.equal(fixture.events.length, 1);
});

test("反戳队列：群与私聊绑定实际来源，重复排队和执行只戳一次", async t => {
  const fixture = gatewayFixture(t);
  for (const type of ["group", "private"] as const) {
    const event = poke({ eventKey: `real-${type}`, ...(type === "private" ? { groupId: undefined, conversationId: `private_${USER}` } : {}) });
    fixture.receive(event);
    const task = { kind: "poke", conversationType: type, targetId: type === "group" ? GROUP : USER, payload: payload(event) };
    const queued = fixture.gateway.enqueueSend(task);
    assert.equal(fixture.gateway.enqueueSend({ ...task, taskKey: "different-key" }).reused, true);
    await fixture.execute(queued.id);
    await fixture.execute(queued.id);
    assert.equal(fixture.db.sendTaskById(queued.id)?.status, "confirmed");
    assert.equal(fixture.db.sendTaskById(queued.id)?.attempts, 1);
  }
  assert.deepEqual(fixture.calls, [{ userId: USER, groupId: GROUP }, { userId: USER, groupId: undefined }]);
});

test("反戳队列：不能改目标、来源、账号、群或越过过期时间；拉黑会取消已排队动作", async t => {
  const fixture = gatewayFixture(t);
  const event = poke();
  fixture.receive(event);
  for (const [index, override] of [
    { userId: "123456", requesterId: "123456" }, { requesterId: "123456" }, { sourceEventKey: "forged-event" },
    { accountId: "other" }, { expiresAt: "invalid-time" },
    { expiresAt: new Date(Date.now() + 600_000).toISOString() }, { expiresAt: new Date(Date.now() - 1).toISOString() },
  ].entries()) {
    const task = fixture.db.enqueueSendTask({ kind: "poke", conversationType: "group", targetId: GROUP, payload: { ...payload(event), ...override } });
    await fixture.execute(task.id);
    assert.equal(fixture.db.sendTaskById(task.id)?.status, "failed", `invalid case ${index}`);
  }
  const wrongGroup = fixture.db.enqueueSendTask({ kind: "poke", conversationType: "group", targetId: "999999", payload: payload(event) });
  await fixture.execute(wrongGroup.id);
  assert.equal(fixture.db.sendTaskById(wrongGroup.id)?.status, "failed");
  const blocked = fixture.gateway.enqueueSend({ kind: "poke", conversationType: "group", targetId: GROUP, payload: payload(event) });
  fixture.db.blockUser("acct", USER, "attack");
  await fixture.execute(blocked.id);
  assert.equal(fixture.db.sendTaskById(blocked.id)?.status, "failed");
  assert.equal(fixture.calls.length, 0);
});

test("反戳队列：提交结果不明不重试，重启中的反戳标 unknown 而普通答复可恢复", async t => {
  for (const result of [{ status: "unknown" as const, error: "timeout" }, new Error("connection lost")]) {
    const fixture = gatewayFixture(t, result);
    const event = poke();
    fixture.receive(event);
    const task = fixture.gateway.enqueueSend({ kind: "poke", conversationType: "group", targetId: GROUP, payload: payload(event) });
    await fixture.execute(task.id);
    await fixture.execute(task.id);
    assert.equal(fixture.db.sendTaskById(task.id)?.status, "unknown");
    assert.equal(fixture.db.retrySendTask(task.id), false, "结果不明的反戳也不能被通用重试入口再次提交");
    assert.equal(fixture.calls.length, 1);
  }
  const fixture = gatewayFixture(t);
  const pokeTask = fixture.db.enqueueSendTask({ kind: "poke", conversationType: "group", targetId: GROUP, payload: payload(poke()) });
  const payloadTask = fixture.db.enqueueSendTask({ kind: "reply", conversationType: "group", targetId: GROUP, payload: payload(poke()) });
  const replyTask = fixture.db.enqueueSendTask({ kind: "reply", conversationType: "group", targetId: GROUP, payload: { kind: "segments", segments: [] } });
  for (const task of [pokeTask, payloadTask, replyTask]) fixture.db.claimSendTask(task.id);
  assert.deepEqual(fixture.db.resetInFlightTasks(), { requeued: 1, unknowned: 2 });
  assert.equal(fixture.db.sendTaskById(pokeTask.id)?.status, "unknown");
  assert.equal(fixture.db.sendTaskById(payloadTask.id)?.status, "unknown");
  assert.equal(fixture.db.retrySendTask(pokeTask.id), false);
  assert.equal(fixture.db.retrySendTask(payloadTask.id), false);
  assert.equal(fixture.db.sendTaskById(replyTask.id)?.status, "queued");
});

test("反戳队列：Provider 缺少动作接口明确失败，不产生文字替身", async t => {
  const fixture = gatewayFixture(t);
  delete fixture.provider.sendPoke;
  const event = poke();
  fixture.receive(event);
  const task = fixture.gateway.enqueueSend({ kind: "poke", conversationType: "group", targetId: GROUP, payload: payload(event) });
  await fixture.execute(task.id);
  assert.equal(fixture.db.sendTaskById(task.id)?.status, "failed");
  assert.match(fixture.db.sendTaskById(task.id)?.last_error ?? "", /未实现 sendPoke/);
});
