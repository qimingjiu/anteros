import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "../src/config.js";
import { OpenAICompatibleClient, type ChatMessage, type ToolSpec } from "../src/llm/index.js";
import type { PhoneContextReceipt } from "../src/presence/index.js";

const config: AppConfig["model"] = {
  provider: "openai_compatible", baseUrl: "https://fixture.invalid/v1", apiKey: "", model: "fixture",
  fallbackModel: "", summaryModel: "", temperature: 0.7, maxContextChars: 6000,
  maxOutputChars: 2000, requestTimeoutMs: 5000, profiles: [],
};
const messages: ChatMessage[] = [
  { role: "user", content: "请根据已取得资料答复" },
  { role: "assistant", content: null, tool_calls: [{ id: "prior-tool", type: "function",
    function: { name: "generate_document", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "prior-tool", content: '{"status":"confirmed"}' },
];
const tool: ToolSpec = { type: "function", function: { name: "conversation_action", description: "静默控制",
  parameters: { type: "object" } } };

test("LLM工具关闭：显式空tools将tool_choice=none发送到兼容HTTP端，保留历史工具结果", async t => {
  let request: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    request = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "文件已经交付" }, finish_reason: "stop" }] }));
  });
  const result = await new OpenAICompatibleClient(config).chat(messages, { tools: [] });
  assert.equal(request!.tool_choice, "none");
  assert.equal(request!.tools, undefined);
  assert.deepEqual(request!.messages, messages);
  assert.equal(result.content, "文件已经交付");
});

test("LLM工具关闭：非空工具仍使用auto，未指定工具时保持普通请求兼容", async t => {
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "正常回答" }, finish_reason: "stop" }] }));
  });
  const client = new OpenAICompatibleClient(config);
  await client.chat(messages, { tools: [tool] });
  await client.chat(messages);
  assert.equal(requests[0]!.tool_choice, "auto");
  assert.deepEqual(requests[0]!.tools, [tool]);
  assert.equal(requests[1]!.tool_choice, undefined);
  assert.equal(requests[1]!.tools, undefined);
});

test("LLM手机上下文：实际序列化请求包含上下文，回执日志脱除正文身份并按上下文与模型去重", async t => {
  const requests: Record<string, unknown>[] = [];
  const logged: string[] = [];
  const context = "PHONE-CONTEXT-PRIVATE-STATE-FIXTURE";
  const receipt: PhoneContextReceipt = Object.assign({ source: "device_events" as const, purpose: "chat" as const,
    contextChars: context.length, fieldCount: 3, newestObservedAt: "2026-10-14T10:00:00Z",
    oldestObservedAt: "2026-10-14T09:00:00Z", freshFieldCount: 2, staleFieldCount: 1 },
  { qq: "PRIVATE-QQ-FIXTURE", value: "PRIVATE-STATE-FIXTURE" });
  t.mock.method(console, "log", (...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "正常回答" }, finish_reason: "stop" }] }));
  });
  const client = new OpenAICompatibleClient(config);
  const prompt: ChatMessage[] = [{ role: "system", content: context }, ...messages];
  await client.chat(prompt, { tools: [tool], phoneContextReceipt: receipt });
  await client.chat(prompt, { tools: [], phoneContextReceipt: receipt });
  await client.chat(prompt, { model: "alternate-fixture", phoneContextReceipt: receipt });
  await client.chat(prompt, { phoneContextReceipt: { ...receipt } });
  assert.equal(requests.length, 4);
  assert.ok(requests.every(request => JSON.stringify(request.messages).includes(context)));
  assert.ok(requests.every(request => request.phoneContextReceipt === undefined));
  const receipts = logged.filter(line => line.includes("手机上下文已附加到模型请求"));
  assert.equal(receipts.length, 3, "相同上下文同模型的工具轮次只记录一次，新模型和新上下文分别记录");
  assert.ok(receipts.every(line => line.includes('"fieldCount":3') && line.includes('"freshFieldCount":2')
    && line.includes('"staleFieldCount":1') && line.includes('"source":"device_events"')));
  assert.doesNotMatch(receipts.join("\n"), /PRIVATE-QQ|PRIVATE-STATE|PHONE-CONTEXT/);
});
