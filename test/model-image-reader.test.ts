import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createImageReaderClient } from "../src/llm/image-reader.js";
import { MockLLMClient, type ChatMessage } from "../src/llm/index.js";

function configuration(t: TestContext, mutate: (raw: Record<string, any>) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-image-reader-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const raw = YAML.parse(fs.readFileSync(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)), "utf8"));
  mutate(raw);
  const filename = path.join(directory, "config.yaml");
  fs.writeFileSync(filename, YAML.stringify(raw));
  return () => loadConfig(filename);
}

function fixture(): AppConfig["model"] {
  return {
    provider: "openai_compatible", baseUrl: "https://main.example/v1", apiKey: "main-fixture-key",
    model: "main-chat-model", fallbackModel: "main-fallback-model", summaryModel: "main-summary-model",
    temperature: 0.6, maxContextChars: 6000, maxOutputChars: 2000, requestTimeoutMs: 2000,
    profiles: [{ name: "main-profile", provider: "mock", baseUrl: "", apiKey: "", model: "main-profile-model" }],
    providers: [{ name: "vision-service", provider: "openai_compatible", baseUrl: "https://vision.example/v1",
      apiKey: "vision-fixture-key", temperature: 0.9, models: ["another-model"] }],
    imageReader: { providerName: "vision-service", model: "vendor/full-vision-model-id" },
  };
}

const image: ChatMessage[] = [{ role: "user", content: [
  { type: "text", text: "Read visible text." },
  { type: "image_url", image_url: { url: "https://images.example/fixture.png" } },
] }];

test("image reader is absent by default and does not change main model settings", t => {
  const cfg = configuration(t, () => {})();
  assert.equal(cfg.model.imageReader, undefined);
  assert.equal(Object.hasOwn(cfg.model, "imageReader"), false);
  const before = structuredClone(cfg.model);
  assert.equal(createImageReaderClient(cfg.model), undefined);
  assert.deepEqual(cfg.model, before);
});

test("image reader resolves an existing normalized service and preserves the full model ID", t => {
  const keyEnv = "QQ_TEST_IMAGE_READER_SERVICE_KEY";
  const previous = process.env[keyEnv];
  process.env[keyEnv] = "vision-environment-fixture-key";
  t.after(() => previous === undefined ? delete process.env[keyEnv] : process.env[keyEnv] = previous);
  const cfg = configuration(t, raw => {
    raw.model.providers = [{ name: "vision-service", base_url: "https://vision.example/v1/", api_key_env: keyEnv }];
    raw.model.image_reader = { provider: "vision-service", model: "vendor/full-vision-model-id" };
  })();
  assert.deepEqual(cfg.model.imageReader, { providerName: "vision-service", model: "vendor/full-vision-model-id" });
  assert.equal(cfg.model.providers?.[0]?.baseUrl, "https://vision.example/v1");
  assert.equal(cfg.model.providers?.[0]?.apiKey, "vision-environment-fixture-key");
  assert.equal(cfg.model.model, "sim-model");
});

test("image reader configuration rejects malformed objects and incomplete service/model selection", t => {
  const invalid = [null, true, [], "vision-service", {}, { provider: "vision-service" },
    { model: "vision-model" }, { provider: 1, model: "vision-model" },
    { provider: "vision-service", model: 1 }, { provider: " ", model: "vision-model" },
    { provider: "vision-service", model: " " }];
  for (const value of invalid) {
    assert.throws(configuration(t, raw => {
      raw.model.providers = [{ name: "vision-service", provider: "mock", base_url: "http://mock.example/v1" }];
      raw.model.image_reader = value;
    }), /model\.image_reader/);
  }
});

test("image reader configuration rejects unknown service names without echoing provided values", t => {
  const untrusted = "private-fixture-value";
  assert.throws(configuration(t, raw => {
    raw.model.image_reader = { provider: untrusted, model: "vision-model" };
  }), error => error instanceof Error && /model\.image_reader\.provider/.test(error.message)
    && !error.message.includes(untrusted));
});

test("explicit image reader requires its service key and never borrows the main model key", t => {
  assert.throws(configuration(t, raw => {
    raw.model.api_key = "main-key-not-for-vision";
    raw.model.providers = [{ name: "vision-service", base_url: "https://vision.example/v1" }];
    raw.model.image_reader = { provider: "vision-service", model: "vision-model" };
  }), error => error instanceof Error && /API key 未配置/.test(error.message)
    && !error.message.includes("main-key-not-for-vision"));
  const cfg = fixture();
  cfg.providers![0]!.apiKey = " ";
  assert.throws(() => createImageReaderClient(cfg), error => error instanceof Error
    && /API key 未配置/.test(error.message) && !error.message.includes(cfg.apiKey));
});

test("independent image reader selects its service URL/key/model without changing main model or profiles", async t => {
  const cfg = fixture();
  const before = structuredClone(cfg);
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init: RequestInit) => {
    requests.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "visible words" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  });
  const reader = createImageReaderClient(cfg)!;
  assert.equal((await reader.chat(image)).content, "visible words");
  await reader.chat(image, { temperature: 0 });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, "https://vision.example/v1/chat/completions");
    assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer vision-fixture-key");
    assert.equal(request.body.model, "vendor/full-vision-model-id");
    assert.ok(request.init.signal instanceof AbortSignal);
    assert.ok(!JSON.stringify(request.body).includes("main-chat-model"));
  }
  assert.equal(requests[0]!.body.temperature, 0.6);
  assert.equal(requests[1]!.body.temperature, 0);
  assert.deepEqual(cfg, before);
});

test("image reader failure never falls back to the main chat model", async t => {
  const cfg = fixture();
  const models: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init: RequestInit) => {
    models.push(JSON.parse(String(init.body)).model);
    return new Response(JSON.stringify({ error: { message: "fixture failure" } }), { status: 503 });
  });
  await assert.rejects(createImageReaderClient(cfg)!.chat(image, { model: cfg.imageReader!.model }), /HTTP 503/);
  assert.deepEqual(models, ["vendor/full-vision-model-id"]);
  assert.equal(cfg.fallbackModel, "main-fallback-model");
});

test("image reader permits a mock service fixture without an API key", t => {
  const cfg = configuration(t, raw => {
    raw.model.providers = [{ name: "mock-vision", provider: "mock", base_url: "http://mock.example/v1" }];
    raw.model.image_reader = { provider: "mock-vision", model: "mock-image-model" };
  })();
  assert.ok(createImageReaderClient(cfg.model) instanceof MockLLMClient);
});

test("image reader factory rejects programmatic unknown or incomplete selections", () => {
  const cfg = fixture();
  cfg.imageReader = { providerName: "missing", model: "vision-model" };
  assert.throws(() => createImageReaderClient(cfg), /model\.image_reader\.provider/);
  cfg.imageReader = { providerName: "vision-service", model: " " };
  assert.throws(() => createImageReaderClient(cfg), /model\.image_reader/);
});
