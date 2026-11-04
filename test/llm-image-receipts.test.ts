import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import type { AppConfig } from "../src/config.js";
import { OpenAICompatibleClient, type ChatMessage } from "../src/llm/index.js";

const config: AppConfig["model"] = {
  provider: "openai_compatible", baseUrl: "https://PRIVATE-PROVIDER.invalid/PRIVATE-ENDPOINT", apiKey: "PRIVATE-API-KEY",
  model: "primary-fixture", fallbackModel: "", summaryModel: "", temperature: 0.7,
  maxContextChars: 6000, maxOutputChars: 2000, requestTimeoutMs: 5000, profiles: [],
};
const contextId = "a1e2c3d4-1234-4678-9abc-123456789abc";
const messages: ChatMessage[] = [{ role: "user", content: [
  { type: "text", text: "PRIVATE-CHAT-TEXT PRIVATE-QQ-123456" },
  { type: "image_url", image_url: { url: "https://PRIVATE-IMAGE-HOST.invalid/PRIVATE-IMAGE-PATH?signature=PRIVATE-QUERY" } },
  { type: "image_url", image_url: { url: "data:image/png;base64,PRIVATE-BASE64" } },
] }, { role: "user", content: [
  { type: "image_url", image_url: { url: "https://PRIVATE-OTHER-HOST.invalid/PRIVATE-OTHER-PATH" } },
] }];
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: "PRIVATE-OUTPUT-TEXT" }, finish_reason: "stop" }] }));

function captureLogs(t: TestContext): string[] {
  const logged: string[] = [];
  const collect = (...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); };
  t.mock.method(console, "log", collect);
  t.mock.method(console, "warn", collect);
  return logged;
}

function receipts(logged: string[], event: string): Record<string, unknown>[] {
  return logged.filter(line => line.includes(`${event} {`)).map(line => JSON.parse(line.slice(line.indexOf("{"))));
}

function assertNoPrivateValues(logged: string[]): void {
  assert.doesNotMatch(logged.join("\n"), /PRIVATE-|https?:\/\/|data:image|base64|signature=/);
}

test("图片请求回执：记录实际远程和内联图片数，关联已发送与完成，不改变模型载荷", async t => {
  const logged = captureLogs(t);
  let request: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    request = JSON.parse(String(init.body));
    return success();
  });
  const result = await new OpenAICompatibleClient(config).chat(messages, { model: "actual-fixture", imageContextId: contextId });
  const sent = receipts(logged, "模型图片请求已发送");
  const completed = receipts(logged, "模型图片请求已完成");
  assert.equal(sent.length, 1);
  assert.equal(completed.length, 1);
  assert.match(String(sent[0]!.receiptId), /^[0-9a-f-]{36}$/);
  assert.deepEqual(sent[0], { receiptId: sent[0]!.receiptId, imageContextId: contextId, model: "actual-fixture",
    imageCount: 3, remoteUrlCount: 2, inlineDataCount: 1 });
  assert.deepEqual(completed[0], { ...sent[0], httpStatus: 200, durationMs: completed[0]!.durationMs,
    finishReason: "stop", contentPresent: true });
  assert.equal(typeof completed[0]!.durationMs, "number");
  assert.equal(receipts(logged, "模型图片请求失败").length, 0);
  assert.equal(result.content, "PRIVATE-OUTPUT-TEXT");
  assert.deepEqual(request, { model: "actual-fixture", messages, temperature: 0.7 });
  assertNoPrivateValues(logged);
});

test("图片请求回执：工具轮次与fallback分别生成请求编号，并保留同一图片上下文编号", async t => {
  const logged = captureLogs(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: { message: "PRIVATE-PROVIDER-ERROR" } }), { status: 503 });
    return success();
  });
  const client = new OpenAICompatibleClient({ ...config, fallbackModel: "fallback-fixture" });
  await client.chat(messages, { model: config.model, imageContextId: contextId });
  await client.chat(messages, { tools: [], imageContextId: contextId });
  const sent = receipts(logged, "模型图片请求已发送");
  const completed = receipts(logged, "模型图片请求已完成");
  const failed = receipts(logged, "模型图片请求失败");
  assert.deepEqual(sent.map(receipt => receipt.model), ["primary-fixture", "fallback-fixture", "primary-fixture"]);
  assert.equal(new Set(sent.map(receipt => receipt.receiptId)).size, 3);
  assert.ok(sent.every(receipt => receipt.imageContextId === contextId));
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.receiptId, sent[0]!.receiptId);
  assert.equal(failed[0]!.code, "HTTP_ERROR");
  assert.equal(failed[0]!.httpStatus, 503);
  assert.deepEqual(completed.map(receipt => receipt.receiptId), sent.slice(1).map(receipt => receipt.receiptId));
  assertNoPrivateValues(logged);
});

test("图片请求回执：无实际图片时不增加图片回执日志，非法上下文编号不会写入日志", async t => {
  const logged = captureLogs(t);
  t.mock.method(globalThis, "fetch", async () => success());
  const client = new OpenAICompatibleClient(config);
  await client.chat([{ role: "user", content: "图片在文字里 https://PRIVATE-TEXT-URL.invalid" }], { imageContextId: contextId });
  assert.equal(logged.filter(line => line.includes("模型图片请求")).length, 0);
  await client.chat(messages, { imageContextId: "PRIVATE-CONTEXT-QQ-OR-URL" });
  const sent = receipts(logged, "模型图片请求已发送");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.imageContextId, undefined);
  assertNoPrivateValues(logged);
});

test("图片请求回执：仅有工具调用的成功响应可区分无正文，未知结束原因不写入日志", async t => {
  const logged = captureLogs(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{
    message: { content: null, tool_calls: [{ id: "fixture-tool", type: "function",
      function: { name: "fixture_function", arguments: "{}" } }] },
    finish_reason: "PRIVATE-PROVIDER-FINISH-REASON",
  }] })));
  const result = await new OpenAICompatibleClient(config).chat(messages);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.finishReason, "PRIVATE-PROVIDER-FINISH-REASON", "安全日志不会改变调用方收到的模型结果");
  const completed = receipts(logged, "模型图片请求已完成");
  assert.equal(completed[0]!.contentPresent, false);
  assert.equal(completed[0]!.finishReason, "unknown");
  assertNoPrivateValues(logged);
});

test("图片请求回执：HTTP、非JSON、网络异常只记录固定错误类别与代码", async t => {
  for (const fixture of [
    { code: "HTTP_ERROR", status: 403, kind: "response", response: () => new Response(JSON.stringify({
      error: { message: "PRIVATE-BODY https://PRIVATE-HOST.invalid/PRIVATE-PATH?signature=PRIVATE-QUERY PRIVATE-API-KEY" },
    }), { status: 403 }) },
    { code: "INVALID_JSON", status: 200, kind: "response", response: () => new Response("PRIVATE-INVALID-JSON-BODY") },
    { code: "INVALID_RESPONSE", status: 200, kind: "response", response: () => new Response("null") },
    { code: "EMPTY_CHOICES", status: 200, kind: "response", response: () => new Response('{"choices":[]}') },
    { code: "NETWORK_ERROR", status: undefined, kind: "network", response: () => {
      throw new TypeError("PRIVATE-NETWORK-ERROR https://PRIVATE-HOST.invalid/PRIVATE-PATH?signature=PRIVATE-QUERY");
    } },
  ]) {
    await t.test(fixture.code, async sub => {
      const logged = captureLogs(sub);
      sub.mock.method(globalThis, "fetch", async () => fixture.response());
      await assert.rejects(new OpenAICompatibleClient(config).chat(messages), error => {
        assert.equal((error as Error).name, "ImageRequestError");
        assert.match((error as Error).message, new RegExp(fixture.code));
        assert.doesNotMatch(String(error), /PRIVATE-|https?:\/\//);
        return true;
      });
      const sent = receipts(logged, "模型图片请求已发送");
      const failed = receipts(logged, "模型图片请求失败");
      assert.equal(sent.length, 1);
      assert.equal(failed.length, 1);
      assert.equal(failed[0]!.receiptId, sent[0]!.receiptId);
      assert.equal(failed[0]!.code, fixture.code);
      assert.equal(failed[0]!.httpStatus, fixture.status);
      assert.equal(failed[0]!.errorClass, fixture.kind);
      assert.equal(receipts(logged, "模型图片请求已完成").length, 0);
      assertNoPrivateValues(logged);
    });
  }
});

test("图片请求回执：图片请求中取消保留AbortError，不等待fallback并清理监听器", async t => {
  const logged = captureLogs(t);
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("PRIVATE-ABORT-REASON")), { once: true });
    });
  });
  const pending = new OpenAICompatibleClient({ ...config, fallbackModel: "fallback-fixture" })
    .chat(messages, { model: config.model, signal: controller.signal });
  const started = Date.now();
  controller.abort(new Error("PRIVATE-CALLER-REASON"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(Date.now() - started < 400);
  assert.equal(calls, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const failed = receipts(logged, "模型图片请求失败");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.code, "CANCELLED");
  assert.equal(failed[0]!.errorClass, "abort");
  assertNoPrivateValues(logged);
});
