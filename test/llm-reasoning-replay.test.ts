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

function fixture(t: TestContext, responses: Record<string, unknown>[], model = "reasoning-fixture") {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "isolated";
  cfg.tools.enabled = true;
  cfg.tools.ownerIds = ["999999992"];
  cfg.model.provider = "openai_compatible";
  cfg.model.baseUrl = "https://fixture.invalid/v1";
  cfg.model.apiKey = "";
  cfg.model.model = model;
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

test("MiniMax工具循环：内联思考原文与reasoning_details完整回传，最终正文和日志不含思考", async t => {
  const rawContent = "<think>PRIVATE-INLINE-REPLAY\n工具调用前的完整思考。</think>\n";
  const reasoning = "PRIVATE-SPLIT-REPLAY\n分离推理原文";
  const reasoningDetails = [{ type: "reasoning.text", format: "MiniMax-response-v1", id: "reasoning_0",
    index: 0, text: "PRIVATE-DETAILS-REPLAY\n原样保留的协议推理" }];
  const tool = toolResponse(1, reasoning);
  Object.assign(tool.choices[0]!.message, { content: rawContent, reasoning_details: reasoningDetails });
  const f = fixture(t, [tool, { choices: [{ message: {
    content: "<think>PRIVATE-FINAL-REASONING\n整理答案。</think>\n根据工具结果生成的最终正文",
    reasoning_details: [{ type: "reasoning.text", text: "PRIVATE-FINAL-DETAILS" }],
  }, finish_reason: "stop" }] }], "MiniMax-M2.7");

  const reply = await f.agent.generateReply(f.message, []);
  assert.equal(f.requests.length, 2);
  assert.equal(f.executed(), 1);
  const assistant = f.requests[1]!.messages.find((message: any) => message.role === "assistant");
  assert.equal(assistant.content, rawContent, "后续请求须保留模型协议要求的内联原文");
  assert.equal(assistant.reasoning_content, reasoning);
  assert.deepEqual(assistant.reasoning_details, reasoningDetails);
  assert.equal(reply, "根据工具结果生成的最终正文");
  assert.doesNotMatch(f.logs.join("\n"), /PRIVATE-|完整思考|分离推理|协议推理/);
});

test("MiniMax关闭工具后的恢复：拒绝调用也完整回传内联思考与reasoning_details，不重复执行", async t => {
  const responses = [1, 2, 3, 4].map(round => {
    const response = toolResponse(round, `PRIVATE-SPLIT-${round}`);
    Object.assign(response.choices[0]!.message, {
      content: `<think>PRIVATE-INLINE-${round}\n原始换行与工具推理。</think>\n`,
      reasoning_details: [{ type: "reasoning.text", format: "MiniMax-response-v1", index: round,
        id: `reasoning_${round}`, text: `PRIVATE-DETAILS-${round}` }],
    });
    return response;
  });
  const expected = responses.map(response => structuredClone(response.choices[0]!.message));
  const f = fixture(t, [...responses, { choices: [{ message: {
    content: "<think>PRIVATE-RECOVERY-FINAL</think>\n根据工具结果生成的最终正文",
  }, finish_reason: "stop" }] }], "MiniMax-M2.5-oc");

  assert.equal(await f.agent.generateReply(f.message, []), "根据工具结果生成的最终正文");
  assert.equal(f.requests.length, 5);
  assert.equal(f.executed(), 3, "工具关闭后追加的第四次调用不得执行");
  const recovery = f.requests[4]!;
  assert.equal(recovery.tool_choice, "none");
  assert.equal(recovery.tools, undefined);
  const assistantMessages = recovery.messages.filter((message: any) => message.role === "assistant");
  assert.equal(assistantMessages.length, 4);
  for (const [index, assistant] of assistantMessages.entries()) {
    assert.equal(assistant.content, expected[index]!.content);
    assert.equal(assistant.reasoning_content, expected[index]!.reasoning_content);
    assert.deepEqual(assistant.reasoning_details, (expected[index] as Record<string, unknown>).reasoning_details);
  }
  assert.match(recovery.messages.find((message: any) => message.tool_call_id === "call_fixture_4").content, /没有执行/);
  assert.doesNotMatch(f.logs.join("\n"), /PRIVATE-|原始换行与工具推理/);
});

test("MiniMax仅思考或截断在思考内：拒绝生成回复，不能把思考当最终正文", async t => {
  for (const [content, finishReason] of [
    ["<think>PRIVATE-THINK-ONLY\n还没有正文。</think>", "stop"],
    ["<think>PRIVATE-TRUNCATED\n尚未完成思考", "length"],
  ]) {
    const f = fixture(t, [{ choices: [{ message: { content,
      reasoning_details: [{ type: "reasoning.text", text: "PRIVATE-ONLY-DETAILS" }] },
      finish_reason: finishReason }] }], "MiniMax-M2.7");
    await assert.rejects(f.agent.generateReply(f.message, []), error => {
      assert.equal((error as Error).constructor.name, "IncompleteReplyError");
      assert.doesNotMatch((error as Error).message, /PRIVATE-|还没有正文|尚未完成思考/);
      return true;
    });
    assert.equal(f.requests.length, 1);
    assert.equal(f.executed(), 0);
    assert.doesNotMatch(f.logs.join("\n"), /PRIVATE-|还没有正文|尚未完成思考/);
  }
});
