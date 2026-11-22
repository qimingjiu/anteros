import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Database } from "../src/db/index.js";
import { BackgroundTaskRunner } from "../src/family/background.js";
import { FamilyDesk } from "../src/family/index.js";
import type { Job } from "../src/family/scheduler.js";
import { serveFamilySignals } from "../src/family/signals.js";
import type { LLMClient } from "../src/llm/index.js";
import type { MessageRecord, ToolDef } from "../src/types.js";

function ownerMessage(text: string): MessageRecord {
  const stamp = new Date().toISOString();
  return { eventKey: "qq:private_10001:message:7", accountId: "qq", providerId: "onebot", conversationId: "private_10001",
    messageId: "7", senderId: "10001", displayNameAtTime: "主人", sentAt: stamp, receivedAt: stamp,
    segments: [{ type: "text", data: { text } }], textContent: text, origin: "live", status: "active" };
}

function task(): Job {
  const source = ownerMessage("在后台查一下项目状态。");
  return { id: "test-task", room: "room:study", member: "fog", kind: "task", state: "running", title: source.textContent,
    source, sourceAt: source.sentAt, dueAt: 1, revision: 1 };
}

const toolName = "mcp__project__find";
const scope = { accountId: "qq", requesterId: "10001", isPrivate: true, roomId: "room:study", personaId: "fog" };

test("a background task executes allowed tools, keeps its member scope, and reuses a durable tool receipt", async () => {
  const db = new Database(":memory:");
  let calls = 0;
  let checkpoint = "";
  try {
    const tool: ToolDef = {
      name: toolName, description: "Search project", inputSchema: { type: "object" },
      execute: async (args, ctx) => {
        calls++;
        assert.deepEqual(ctx, scope);
        assert.equal(args.query, "project");
        return "真实工具回执 7";
      },
    };
    const invoke = (order: string) => {
      const llm: LLMClient = { async chat(messages, options) {
        if (messages.length === 2) {
          assert.ok(options?.tools?.some(spec => spec.function.name === toolName));
          return { content: "", finishReason: "tool_calls", toolCalls: [
            { id: "q", name: toolName, arguments: order },
            { id: "checkpoint", name: "family_task_checkpoint", arguments: '{"text":"已查阅工具回执"}' },
            { id: "blocked", name: "send_email", arguments: "{}" },
          ] };
        }
        assert.match(String(messages.find(message => message.tool_call_id === "q")?.content), /真实工具回执 7/);
        assert.match(String(messages.find(message => message.tool_call_id === "blocked")?.content), /无权调用/);
        return { content: "已整理项目状态。", finishReason: "stop", toolCalls: [] };
      } };
      return new BackgroundTaskRunner(db).run({
        job: task(), prompt: "用户任务", persona: "雾岛纪", llm, tools: [tool], context: scope, signal: new AbortController().signal,
        lease: { check() {}, checkpoint: text => { checkpoint = text; } },
      });
    };
    assert.equal(await invoke('{"query":"project","page":1}'), "已整理项目状态。");
    assert.equal(await invoke('{"page":1,"query":"project"}'), "已整理项目状态。");
    assert.equal(calls, 1);
    assert.equal(checkpoint, "已查阅工具回执");
  } finally { db.close(); }
});

test("an uncertain background MCP call is not replayed after cancellation with modified arguments", async () => {
  const db = new Database(":memory:");
  const controller = new AbortController();
  let started!: () => void;
  const runningTool = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  try {
    const tool: ToolDef = {
      name: toolName, description: "External action", inputSchema: { type: "object" },
      execute: () => { calls++; started(); return new Promise(() => {}); },
    };
    const invoke = (argument: string, signal: AbortSignal) => {
      const llm: LLMClient = { async chat(messages) {
        if (messages.length === 2) return { content: "", finishReason: "tool_calls",
          toolCalls: [{ id: "q", name: toolName, arguments: argument }] };
        assert.match(String(messages.at(-1)?.content), /未确认/);
        return { content: "需要核对外部服务。", finishReason: "stop", toolCalls: [] };
      } };
      return new BackgroundTaskRunner(db).run({ job: task(), prompt: "执行任务", persona: "", llm,
        tools: [tool], context: scope, signal, lease: { check() {}, checkpoint() {} } });
    };
    const first = invoke('{"key":"one"}', controller.signal);
    await runningTool;
    controller.abort();
    await assert.rejects(first, { name: "AbortError" });
    const resumed = await invoke('{"key":"two"}', new AbortController().signal);
    assert.match(resumed, /工具回执未确认/);
    assert.equal(calls, 1);
  } finally { db.close(); }
});

test("external signals require a bearer token, match the registered room and fields and deduplicate retries", async () => {
  const db = new Database(":memory:");
  const notices: string[] = [];
  const desk = new FamilyDesk(db, {
    isOwner: message => message.senderId === "10001",
    members: () => [{ id: "fog", name: "雾岛纪" }],
    room: () => "room:study",
    timeZone: "UTC",
    generate: async () => "",
    notify: async ({ text, source }) => { assert.ok(source.segments.length); notices.push(text); },
  });
  const source = ownerMessage("每次收到 build.done 而且状态是 ready 就提醒我。");
  const registration = desk.toolsFor(source, "fog").find(tool => tool.name === "family_job")!;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    void serveFamilySignals(request, response, url, {
      token: "local-test-token", resolveRoom: room => !room || room === "room:study" ? "room:study" : undefined,
      dispatch: (room, input) => desk.externalEvent(room, input),
    });
  });
  try {
    const watcher = await registration.execute({
      action: "watch_event", event: "signal", eventName: "build.done", match: { status: "ready" }, recurring: true,
    }, scope);
    assert.match(watcher, /build\.done/);
    desk.start();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const post = (body: unknown, token = "local-test-token") => fetch(`http://127.0.0.1:${address.port}/api/family/signals`, {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const good = { id: "build-7".padEnd(128, "a"), name: "build.done", data: { status: "ready" } };
    assert.equal((await post(good, "wrong")).status, 401);
    assert.equal((await post({ ...good, room: "other-room" })).status, 404);
    const ignored = await post({ ...good, id: "build-6", data: { status: "pending" } });
    assert.deepEqual(await ignored.json(), { duplicate: false, notified: 0 });
    const first = await post(good);
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { duplicate: false, notified: 1 });
    assert.deepEqual(await (await post(good)).json(), { duplicate: true, notified: 0 });
    assert.equal((await post({ ...good, data: { status: "different" } })).status, 409);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /收到事件 build\.done/);
    const inbox = JSON.parse(await registration.execute({ action: "inbox" }, scope)) as { ok: boolean; result: { id: string }[] };
    assert.equal(inbox.ok, true);
    assert.equal(inbox.result.length, 1);
    assert.ok(inbox.result[0]!.id.length <= 150);
  } finally {
    await desk.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  }
});
