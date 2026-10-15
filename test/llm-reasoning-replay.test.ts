import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import { OpenAICompatibleClient } from "../src/llm/index.js";
import type { Gateway } from "../src/gateway/index.js";
import type { McpManager } from "../src/tools/mcp.js";
import type { MessageRecord } from "../src/types.js";

function fixture(t: TestContext, responses: Record<string, unknown>[]) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "isolated";
  cfg.tools.enabled = true;
  cfg.tools.ownerIds = ["999999992"];
  cfg.model.provider = "openai_compatible";
  cfg.model.baseUrl = "https://fixture.invalid/v1";
  cfg.model.apiKey = "";
  cfg.model.model = "reasoning-fixture";
  cfg.model.fallbackModel = "";
  const requests: Record<string, any>[] = [];
  const logs: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); });
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    requests.push(JSON.parse(String(options.body)));
    const response = responses.shift();
    assert.ok(response, "不允许多余HTTP调用");
    return new Response(JSON.stringify(response));
  });
  let executed = 0;
  const mcp = { getTools: () => [{ name: "mcp__fixture__lookup", description: "隔离工具",
    inputSchema: { type: "object" }, execute: async () => { executed++; return "真实执行的隔离结果"; } }] } as unknown as McpManager;
  const gateway = { getProvider: () => ({ health: () => ({ selfId: "999999991" }) }) } as unknown as Gateway;
  const agent = new Agent({ db, cfg, gateway, llm: new OpenAICompatibleClient(cfg.model), memory: null,
    search: null, reader: null, mcp, timezone: cfg.timezone }) as unknown as {
      generateReply(message: MessageRecord, merged: MessageRecord[]): Promise<string | null>;
    };
  const message: MessageRecord = { eventKey: "isolated-request", accountId: "isolated", providerId: "onebot",
    conversationId: "private_999999992", messageId: "1", senderId: "999999992", displayNameAtTime: "隔离请求者",
    sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(), textContent: "查资料并回答",
    segments: [{ type: "text", data: { text: "查资料并回答" } }], status: "active", origin: "live" };
  return { agent, message, requests, logs, executed: () => executed };
}

const answer = { choices: [{ message: { content: "根据工具结果生成的最终正文" }, finish_reason: "stop" }] };
const toolResponse = (round: number, reasoning?: unknown) => ({ choices: [{ message: { content: "",
  ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}), tool_calls: [{ id: `call_fixture_${round}`,
    type: "function", function: { name: "mcp__fixture__lookup", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });

test("LLM推理兼容：真实HTTP响应reasoning_content完整回传下一工具请求，不进入正文或日志", async t => {
  const reasoning = "PRIVATE-REASONING-REPLAY-FIXTURE\n保持原始换行与完整字段";
  const f = fixture(t, [toolResponse(1, reasoning), answer]);
  const reply = await f.agent.generateReply(f.message, []);
  assert.equal(f.requests.length, 2);
  const assistant = f.requests[1]!.messages.find((message: any) => message.role === "assistant");
  assert.equal(assistant.reasoning_content, reasoning);
  assert.equal(assistant.content, "", "推理工具轮提供可接受的空字符串正文");
  assert.equal(f.executed(), 1);
  assert.equal(reply, "根据工具结果生成的最终正文");
  assert.doesNotMatch(f.logs.join("\n"), /PRIVATE-REASONING|保持原始换行/);
});

test("LLM推理兼容：关闭工具后的拒绝调用仍回传reasoning_content，纯文字恢复不重复执行", async t => {
  const f = fixture(t, [toolResponse(1, "reason-1"), toolResponse(2, "reason-2"),
    toolResponse(3, "reason-3"), toolResponse(4, "reason-rejected"), answer]);
  assert.equal(await f.agent.generateReply(f.message, []), "根据工具结果生成的最终正文");
  assert.equal(f.requests.length, 5);
  assert.equal(f.executed(), 3);
  const recovery = f.requests[4]!;
  assert.equal(recovery.tool_choice, "none");
  assert.equal(recovery.tools, undefined);
  assert.deepEqual(recovery.messages.filter((message: any) => message.role === "assistant")
    .map((message: any) => message.reasoning_content), ["reason-1", "reason-2", "reason-3", "reason-rejected"]);
  assert.match(recovery.messages.find((message: any) => message.tool_call_id === "call_fixture_4").content, /没有执行/);
  assert.doesNotMatch(f.logs.join("\n"), /reason-rejected/);
});

test("LLM推理兼容：没有字符串reasoning_content的提供者不添加额外消息字段", async t => {
  for (const reasoning of [undefined, null, 123, { unexpected: "value" }]) {
    const f = fixture(t, [toolResponse(1, reasoning), answer]);
    await f.agent.generateReply(f.message, []);
    const assistant = f.requests[1]!.messages.find((message: any) => message.role === "assistant");
    assert.equal(Object.hasOwn(assistant, "reasoning_content"), false);
    assert.equal(assistant.content, null);
  }
});

test("LLM推理兼容：空字符串reasoning_content作为合法协议字段保留", async t => {
  const f = fixture(t, [toolResponse(1, ""), answer]);
  await f.agent.generateReply(f.message, []);
  const assistant = f.requests[1]!.messages.find((message: any) => message.role === "assistant");
  assert.equal(assistant.reasoning_content, "");
  assert.equal(Object.hasOwn(assistant, "reasoning_content"), true);
});
