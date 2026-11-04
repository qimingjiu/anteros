import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "../src/config.js";
import { OpenAICompatibleClient, type ChatMessage } from "../src/llm/index.js";

const cfg: AppConfig["model"] = { provider: "openai_compatible", baseUrl: "https://api.moonshot.cn/v1",
  apiKey: "PRIVATE-KEY", model: "kimi-k2.6", fallbackModel: "", summaryModel: "", temperature: 0.7,
  maxContextChars: 6000, maxOutputChars: 2000, requestTimeoutMs: 5000, profiles: [] };
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const inline = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
const imageMessages: ChatMessage[] = [{ role: "user", content: [
  { type: "text", text: "PRIVATE-QUESTION" }, { type: "image_url", image_url: { url: inline } },
] }];
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"images":[]}' }, finish_reason: "stop" }] }));
const scoped = (name: string): AppConfig["model"] => ({ ...cfg, apiKey: `PRIVATE-KEY-${name}` });

test("Moonshot官方：读图使用JSON模式与K2.6非思考模式，不发送固定采样参数或本地purpose", async t => {
  let body: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return success();
  });
  const original = structuredClone(imageMessages);
  await new OpenAICompatibleClient(scoped("legacy-extraction")).chat(imageMessages, { temperature: 0, purpose: "image_reading" });
  assert.deepEqual(body.messages, imageMessages);
  assert.deepEqual(imageMessages, original);
  assert.equal(Object.hasOwn(body, "temperature"), false);
  assert.equal(Object.hasOwn(body, "purpose"), false);
  assert.equal(Object.hasOwn(body, "tool_choice"), false);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("Moonshot官方：普通文字与K3的思考配置不被图像提取任务覆盖", async t => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return success();
  });
  await new OpenAICompatibleClient(scoped("text")).chat([{ role: "user", content: "hello" }]);
  await new OpenAICompatibleClient({ ...scoped("k3"), model: "kimi-k3" }).chat(imageMessages, { purpose: "image_reading" });
  assert.equal(bodies[0]!.temperature, undefined);
  assert.equal(bodies[0]!.thinking, undefined);
  assert.equal(bodies[0]!.response_format, undefined);
  assert.equal(bodies[1]!.temperature, undefined);
  assert.equal(bodies[1]!.thinking, undefined, "K3不接受K2系列thinking参数");
  assert.deepEqual(bodies[1]!.response_format, { type: "json_object" });
});

test("Moonshot官方：只向模型发送图片真实字节，下载不附模型密钥，同一图片后续读取复用缓存", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let downloads = 0;
  let requests = 0;
  const remote: ChatMessage[] = [{ role: "user", content: [
    { type: "image_url", image_url: { url: "https://93.184.216.34/PRIVATE-IMAGE?token=PRIVATE-SIGNATURE" } },
  ] }];
  const logged: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => logged.push(parts.map(String).join(" ")));
  t.mock.method(console, "warn", (...parts: unknown[]) => logged.push(parts.map(String).join(" ")));
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    if (String(url).startsWith("https://93.184.216.34/")) {
      downloads++;
      assert.equal(new Headers(init.headers).get("authorization"), null);
      assert.equal(init.redirect, "manual");
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    }
    assert.equal(String(url), "https://api.moonshot.cn/v1/chat/completions");
    requests++;
    const body = JSON.parse(String(init.body));
    assert.equal(body.messages[0].content[0].image_url.url, inline);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer PRIVATE-KEY-cache");
    return success();
  });
  const client = new OpenAICompatibleClient(scoped("cache"));
  await client.chat(remote, { purpose: "image_reading" });
  t.mock.timers.tick(20_100);
  await client.chat(remote, { purpose: "image_reading" });
  assert.equal(downloads, 1);
  assert.equal(requests, 2);
  assert.equal((remote[0]!.content as { image_url: { url: string } }[])[0]!.image_url.url,
    "https://93.184.216.34/PRIVATE-IMAGE?token=PRIVATE-SIGNATURE");
  const sent = logged.filter(s => s.includes("模型图片请求已发送"));
  assert.equal(sent.length, 2);
  assert.ok(sent.every(s => s.includes('"remoteUrlCount":0') && s.includes('"inlineDataCount":1')));
  assert.doesNotMatch(logged.join("\n"), /PRIVATE-|data:image|93\.184|token=/);
});

test("Moonshot官方：拒绝私网取图且不调用模型，准备失败只记录固定错误", async t => {
  let calls = 0;
  const logged: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => logged.push(parts.map(String).join(" ")));
  t.mock.method(console, "warn", (...parts: unknown[]) => logged.push(parts.map(String).join(" ")));
  t.mock.method(globalThis, "fetch", async () => { calls++; return success(); });
  await assert.rejects(new OpenAICompatibleClient(scoped("private-network")).chat([{ role: "user", content: [
    { type: "image_url", image_url: { url: "http://127.0.0.1/PRIVATE-PATH?key=PRIVATE-KEY" } },
  ] }], { purpose: "image_reading" }), error => {
    assert.match(String(error), /IMAGE_INPUT_ERROR/);
    assert.doesNotMatch(String(error), /PRIVATE-|127\.0|http:/);
    return true;
  });
  assert.equal(calls, 0);
  assert.equal(logged.filter(s => s.includes("模型图片请求已发送")).length, 0);
  assert.doesNotMatch(logged.join("\n"), /PRIVATE-|127\.0|http:/);
});

test("Moonshot官方：主聊天直接携带原图，不强制提取JSON或关闭思考", async t => {
  let body: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body)); return success();
  });
  await new OpenAICompatibleClient(scoped("direct-main")).chat(imageMessages);
  assert.deepEqual(body.messages, imageMessages);
  assert.equal(body.model, "kimi-k2.6");
  assert.equal(body.response_format, undefined);
  assert.equal(body.thinking, undefined);
  assert.equal(body.temperature, undefined);
});

test("Moonshot官方：跨客户端等完整响应后释放，排队可取消且不占HTTP超时", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const firstEntered = Promise.withResolvers<void>();
  const finishBody = Promise.withResolvers<void>();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) {
      firstEntered.resolve();
      return { ok: true, status: 200, text: async () => {
        await finishBody.promise;
        return JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
      } } as Response;
    }
    return success();
  });
  const sharedCfg = scoped("shared-body");
  const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
  const first = new OpenAICompatibleClient(sharedCfg).chat(messages);
  await firstEntered.promise;
  const controller = new AbortController();
  const cancelled = new OpenAICompatibleClient(sharedCfg).chat(messages, { signal: controller.signal });
  const cancellation = assert.rejects(cancelled, { name: "AbortError" });
  const second = new OpenAICompatibleClient({ ...sharedCfg, requestTimeoutMs: 10 }).chat(messages);
  // Response headers alone must not permit another client's request.
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(25);
  assert.equal(calls, 1);
  controller.abort();
  await cancellation;
  finishBody.resolve();
  await first;
  t.mock.timers.tick(20_100);
  assert.ok(await second);
  assert.equal(calls, 2);
});

test("兼容服务：域名后缀相似不触发Moonshot特殊参数与图片下载", async t => {
  let body: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return success();
  });
  await new OpenAICompatibleClient({ ...cfg, baseUrl: "https://api.moonshot.cn.example.invalid/v1" })
    .chat(imageMessages, { temperature: 0, purpose: "image_reading" });
  assert.equal(body.temperature, 0);
  assert.equal(body.response_format, undefined);
  assert.equal(body.thinking, undefined);
  assert.deepEqual(body.messages, imageMessages);
});
