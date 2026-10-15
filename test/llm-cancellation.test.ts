import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { AppConfig } from "../src/config.js";
import { MockLLMClient, OpenAICompatibleClient, type ChatMessage } from "../src/llm/index.js";

const messages: ChatMessage[] = [{ role: "user", content: "fixture request" }];
function client(requestTimeoutMs = 5000) {
  const config: AppConfig["model"] = {
    provider: "openai_compatible", baseUrl: "https://fixture.invalid/v1", apiKey: "", model: "primary",
    fallbackModel: "fallback", summaryModel: "", temperature: 0.7,
    maxContextChars: 6000, maxOutputChars: 2000, requestTimeoutMs, profiles: [],
  };
  return new OpenAICompatibleClient(config);
}
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: "fixture answer" }, finish_reason: "stop" }] }), { status: 200 });

test("LLM取消：预取消不会发HTTP或尝试fallback", async t => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; return success(); });
  const controller = new AbortController();
  controller.abort(new Error("superseded"));
  await assert.rejects(client().chat(messages, { model: "primary", signal: controller.signal }), { name: "AbortError" });
  assert.equal(fetches, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("LLM取消：请求中取消终止fetch，不等待重试延迟、不尝试fallback", async t => {
  const models: string[] = [];
  let requestSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    models.push(JSON.parse(String(init.body)).model);
    requestSignal = init.signal ?? undefined;
    return await new Promise<Response>((_resolve, reject) => {
      requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = client().chat(messages, { model: "primary", signal: controller.signal });
  assert.ok(requestSignal);
  const started = Date.now();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(models, ["primary"]);
  assert.ok(Date.now() - started < 400, "用户取消不应等待500毫秒重试间隔");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("LLM取消：上游失败后的重试等待也能立即取消", async t => {
  const models: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    models.push(JSON.parse(String(init.body)).model);
    return new Response(JSON.stringify({ error: { message: "fixture unavailable" } }), { status: 503 });
  });
  const controller = new AbortController();
  const pending = client().chat(messages, { model: "primary", signal: controller.signal });
  await nextTurn();
  const started = Date.now();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(models, ["primary"]);
  assert.ok(Date.now() - started < 400, "取消应打断重试延迟");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("LLM取消：自己的请求超时仍保留fallback，与调用方取消区分", async t => {
  const models: string[] = [];
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    models.push(JSON.parse(String(init.body)).model);
    if (models.length > 1) return success();
    return await new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  });
  const result = await client(10).chat(messages, { model: "primary", signal: controller.signal });
  assert.deepEqual(models, ["primary", "fallback"]);
  assert.equal(result.content, "fixture answer");
  assert.equal(controller.signal.aborted, false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("LLM取消：正常完成后移除调用方取消监听器", async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => success());
  const result = await client().chat(messages, { signal: controller.signal });
  assert.equal(result.content, "fixture answer");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("LLM取消：Mock支持预取消和回复等待中取消", async () => {
  const mock = new MockLLMClient();
  const preCancelled = new AbortController();
  preCancelled.abort();
  await assert.rejects(mock.chat(messages, { signal: preCancelled.signal }), { name: "AbortError" });
  const controller = new AbortController();
  const pending = mock.chat(messages, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
