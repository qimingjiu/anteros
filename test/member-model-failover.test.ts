import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { AppConfig, ModelProfile } from "../src/config.js";
import { Database } from "../src/db/index.js";
import type { ChatMessage, ToolSpec } from "../src/llm/index.js";
import { ModelSwitcher, type MemberModelFailoverPolicy } from "../src/llm/switcher.js";

interface RequestBody {
  model: string;
  messages: ChatMessage[];
}

const prompt: ChatMessage[] = [{ role: "user", content: "选一个模型，正常回答。" }];
const policy: MemberModelFailoverPolicy = {
  primaryProfile: "main", fallbackProfiles: ["backup"], attemptTimeoutMs: 500, totalTimeoutMs: 1500, cooldownMs: 1000,
};

function answer(response: ServerResponse, content: string, finish = "stop"): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }));
}

async function fixture(t: TestContext, handler: (body: RequestBody, response: ServerResponse) => void) {
  const requests: RequestBody[] = [];
  const server = createServer(async (request, response) => {
    let input = "";
    for await (const chunk of request) input += String(chunk);
    const body = JSON.parse(input) as RequestBody;
    requests.push(body);
    handler(body, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server unavailable");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const profiles: ModelProfile[] = [
    { name: "main", provider: "openai_compatible", baseUrl, apiKey: "test-main", model: "minimax-primary" },
    { name: "backup", provider: "openai_compatible", baseUrl, apiKey: "test-backup", model: "backup" },
    { name: "manual", provider: "openai_compatible", baseUrl, apiKey: "test-manual", model: "manual" },
  ];
  const cfg: AppConfig["model"] = {
    provider: "openai_compatible", baseUrl, apiKey: "test-global", model: "global", fallbackModel: "",
    summaryModel: "", temperature: 0.5, maxContextChars: 8000, maxOutputChars: 3000, requestTimeoutMs: 1500, profiles,
  };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anteros-member-model-"));
  const file = path.join(directory, "models.db");
  let db = new Database(file);
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { cfg, profiles, requests, db, switcher: () => new ModelSwitcher(profiles, cfg, db),
    reopen: () => { db.close(); db = new Database(file); return new ModelSwitcher(profiles, cfg, db); } };
}

test("only a listed backup is used and selection persists across linked clients and restart", async t => {
  const f = await fixture(t, (body, response) => {
    if (body.model === "minimax-primary") {
      response.writeHead(429, { "Retry-After": "30" }).end("provider content is private");
    } else answer(response, body.model);
  });
  const member = f.switcher().forMember("family", "korax", "κόραξ", policy);
  assert.equal(member.activeName(), "main");
  assert.equal((await member.chat(prompt)).content, "backup");
  assert.equal(member.activeName(), "backup");
  assert.deepEqual(f.requests.map(request => request.model), ["minimax-primary", "backup"]);
  const sameMemberInAnotherChannel = f.switcher().forMember("family", "korax", "κόραξ", policy);
  assert.equal((await sameMemberInAnotherChannel.chat(prompt)).content, "backup");
  const restarted = f.reopen();
  assert.equal(restarted.forMember("family", "korax", "κόραξ", policy).activeName(), "backup");
  assert.equal(restarted.forMember("family", "kirishima", "雾岛纪", policy).activeName(), "main");
  assert.equal((await restarted.chat(prompt)).content, "global");
});

test("cooldown is persisted, manual same-route selection makes exactly one immediate attempt, and no other profile is tried", async t => {
  const f = await fixture(t, (_body, response) => response.writeHead(503, { "Retry-After": "60" }).end("secret error body"));
  const member = f.switcher().forMember("family", "korax", "κόραξ", policy);
  await assert.rejects(member.chat(prompt), { message: "模型服务拒绝了请求 HTTP 503" });
  const restart = f.reopen().forMember("family", "korax", "κόραξ", policy);
  await assert.rejects(restart.chat(prompt), /没有符合要求/);
  assert.deepEqual(f.requests.map(request => request.model), ["minimax-primary", "backup"]);
  assert.equal(restart.switchTo("main").ok, true);
  await assert.rejects(restart.chat(prompt), /HTTP 503/);
  await assert.rejects(restart.chat(prompt), /没有符合要求/);
  assert.deepEqual(f.requests.map(request => request.model), ["minimax-primary", "backup", "minimax-primary"]);
});

test("member attempt timeout advances to backup, whereas caller cancellation stops the route", async t => {
  let primaryStarted!: () => void;
  const started = new Promise<void>(resolve => { primaryStarted = resolve; });
  const f = await fixture(t, (body, response) => {
    if (body.model === "minimax-primary") { primaryStarted(); return; }
    answer(response, body.model);
  });
  const parent = f.switcher();
  const timed = parent.forMember("family", "korax", "κόραξ", { ...policy, attemptTimeoutMs: 125 });
  assert.equal((await timed.chat(prompt)).content, "backup");
  const cancelled = parent.forMember("family", "kirishima", "雾岛纪", policy);
  const controller = new AbortController();
  const secondStarted = new Promise<void>(resolve => { primaryStarted = resolve; });
  const pending = cancelled.chat(prompt, { signal: controller.signal });
  await Promise.all([started, secondStarted]);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled.activeName(), "main");
  assert.deepEqual(f.requests.map(request => request.model), ["minimax-primary", "backup", "minimax-primary"]);
});

test("changing the selected member route takes precedence over an older backup response", async t => {
  let receiveBackup!: (response: ServerResponse) => void;
  const backup = new Promise<ServerResponse>(resolve => { receiveBackup = resolve; });
  const f = await fixture(t, (body, response) => {
    if (body.model === "minimax-primary") response.writeHead(503).end();
    else if (body.model === "backup") receiveBackup(response);
    else answer(response, body.model);
  });
  const member = f.switcher().forMember("family", "korax", "κόραξ", policy);
  const pending = member.chat(prompt);
  const response = await backup;
  member.switchTo("manual");
  answer(response, "earlier authorized backup");
  assert.equal((await pending).content, "earlier authorized backup");
  assert.equal(member.activeName(), "manual");
  assert.equal((await member.chat(prompt)).content, "manual");
});

test("fallback strips foreign reasoning but keeps all executed tool history and original context", async t => {
  const tool: ToolSpec = { type: "function", function: { name: "fixture", description: "test tool", parameters: {} } };
  let primaryCalls = 0;
  const f = await fixture(t, (body, response) => {
    if (body.model !== "minimax-primary") { answer(response, "用了上次的实际工具结果"); return; }
    if (++primaryCalls > 1) { response.writeHead(503).end(); return; }
    response.end(JSON.stringify({ choices: [{ message: { content: "<think>仅原模型可见</think>可见说明",
      reasoning_content: "private reasoning", reasoning_details: [{ internal: true }],
      tool_calls: [{ id: "tool-1", function: { name: "fixture", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }));
  });
  const member = f.switcher().forMember("family", "korax", "κόραξ", policy);
  const first = await member.chat(prompt, { tools: [tool] });
  assert.equal(first.content, "可见说明");
  const toolHistory: ChatMessage[] = [...prompt, { role: "assistant", content: first.replayContent,
    reasoning_content: first.reasoningContent, reasoning_details: first.reasoningDetails, reasoning_scope: first.reasoningScope,
    tool_calls: [{ id: "tool-1", type: "function", function: { name: "fixture", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "tool-1", content: "已经执行，只一次" }];
  const next = await member.chat(toolHistory, { tools: [tool] });
  assert.notEqual(next.reasoningScope, first.reasoningScope);
  assert.equal(f.requests[1]!.messages[1]!.reasoning_content, "private reasoning");
  assert.equal(f.requests[1]!.messages[1]!.content, "<think>仅原模型可见</think>可见说明");
  const replay = f.requests[2]!.messages[1]!;
  assert.equal(replay.content, "可见说明");
  assert.equal(replay.reasoning_content, undefined);
  assert.equal(replay.reasoning_details, undefined);
  assert.equal(replay.reasoning_scope, undefined);
  assert.equal(replay.tool_calls?.[0]?.id, "tool-1");
  assert.equal(f.requests[2]!.messages[2]!.content, "已经执行，只一次");
});

test("nonrecoverable provider responses stop, and incompatible profiles never receive images", async t => {
  const f = await fixture(t, (body, response) => answer(response, body.model,
    body.model === "minimax-primary" ? "content_filter" : "stop"));
  f.profiles[0]!.capabilities = { vision: false };
  const member = f.switcher().forMember("family", "korax", "κόραξ", policy);
  await assert.rejects(member.chat(prompt), /模型服务停止生成/);
  assert.deepEqual(f.requests.map(request => request.model), ["minimax-primary"]);
  const image: ChatMessage[] = [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }];
  assert.equal((await member.chat(image)).content, "backup");
  assert.deepEqual(f.requests.map(request => request.model), ["minimax-primary", "backup"]);
});

test("the configured attempt count bounds retries even when multiple models are healthy", async t => {
  const f = await fixture(t, (body, response) => {
    if (body.model === "minimax-primary") answer(response, "  ");
    else answer(response, body.model);
  });
  const member = f.switcher().forMember("family", "korax", "κόραξ", { ...policy, maxAttempts: 1 });
  await assert.rejects(member.chat(prompt), /空白或无效/);
  assert.deepEqual(f.requests.map(request => request.model), ["minimax-primary"]);
  assert.equal((await member.chat(prompt)).content, "backup");
  assert.deepEqual(f.requests.map(request => request.model), ["minimax-primary", "backup"]);
});
