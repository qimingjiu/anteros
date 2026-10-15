import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/db/index.js";
import { loadConfig, type ModelService } from "../src/config.js";
import { discoverModelProfiles } from "../src/llm/catalog.js";

function service(overrides: Partial<ModelService> = {}): ModelService {
  return { name: "Sora", provider: "openai_compatible", baseUrl: "https://sora.example/v1", apiKey: "catalog-test-secret", ...overrides };
}

function fixture(t: TestContext): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-catalog-"));
  const db = new Database(path.join(dir, "test.db"));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

function listFetch(ids: (string | Record<string, unknown>)[]): typeof fetch {
  return async () => new Response(JSON.stringify({ data: ids.map((id) => typeof id === "string" ? { id } : id) }));
}

const failingFetch: typeof fetch = async () => { throw new Error("catalog-test-secret must never leak"); };

test("目录拉取带鉴权，精确保留白名单和含斜线 ID", async (t) => {
  const db = fixture(t);
  let requested = "";
  let auth = "";
  const fakeFetch: typeof fetch = async (url, init) => {
    requested = String(url);
    auth = new Headers(init?.headers).get("authorization") ?? "";
    return listFetch(["gemini", "times/gemini", "times/gemini-compat", "other"])(url, init);
  };
  const result = await discoverModelProfiles([service({ models: ["gemini", "times/gemini"] })], db, { fetch: fakeFetch });
  assert.equal(requested, "https://sora.example/v1/models");
  assert.equal(auth, "Bearer catalog-test-secret");
  assert.deepEqual(result.profiles.map((p) => p.name), ["Sora/gemini", "Sora/times/gemini"]);
  assert.deepEqual(result.profiles.map((p) => p.model), ["gemini", "times/gemini"]);
  assert.ok(result.profiles.every((p) => p.serviceName === "Sora"));
  assert.equal(result.reports[0]?.source, "live");
  assert.equal(result.reports[0]?.warnings.length, 0);
});

test("空白名单导入全部对话模型，显式非对话模型不加入", async (t) => {
  const result = await discoverModelProfiles([service({ name: "天翼云", models: [] })], fixture(t), {
    fetch: listFetch([
      "chat-1", "chat-1", { id: "chat-vision", output_modalities: ["text"] },
      { id: "vectors", type: "embedding" }, "text-embedding-3-small",
      { id: "draw", output_modalities: ["image"] },
    ]),
  });
  assert.deepEqual(result.profiles.map((p) => p.model), ["chat-1", "chat-vision"]);
});

test("计价标签只影响展示，截断前缀唯一时找回真实完整 ID", async (t) => {
  const result = await discoverModelProfiles([service({
    name: "tale", models: ["[0.045/次]gemini-pro"], modelPrefixes: ["gemini-preview…"],
  })], fixture(t), { fetch: listFetch(["[0.045/次]gemini-pro", "[0.06/次]gemini-preview-vertex"]) });
  assert.deepEqual(result.profiles.map((p) => p.displayName), ["gemini-pro", "gemini-preview-vertex"]);
  assert.deepEqual(result.profiles.map((p) => p.model), ["[0.045/次]gemini-pro", "[0.06/次]gemini-preview-vertex"]);
  assert.equal(result.profiles[0]?.name, "tale/[0.045/次]gemini-pro");
});

test("歧义、未找到或截断的 ID 明确报告，不猜测替代模型", async (t) => {
  const result = await discoverModelProfiles([service({
    models: ["retired-free", "truncated…"], modelPrefixes: ["gemini-preview", "missing…"],
  })], fixture(t), { fetch: listFetch(["gemini-preview-a", "gemini-preview-b", "paid-version"]) });
  assert.deepEqual(result.profiles, []);
  assert.equal(result.reports[0]?.warnings.length, 4);
  assert.match(result.reports[0]!.warnings.join("\n"), /未找到已选模型.*retired-free/);
  assert.match(result.reports[0]!.warnings.join("\n"), /匹配到多个 ID/);
});

test("拉取失败使用隔离的缓存，缓存中不含密钥，白名单变更立即生效", async (t) => {
  const db = fixture(t);
  await discoverModelProfiles([service()], db, { fetch: listFetch(["one", "two"]) });
  const raw = db.kvGet("model_catalog:Sora")!;
  assert.ok(!raw.includes("catalog-test-secret"));
  assert.ok(!raw.includes("apiKey"));
  const cached = await discoverModelProfiles([service({ apiKey: "new-secret", models: ["two"] })], db, { fetch: failingFetch });
  assert.equal(cached.reports[0]?.source, "cache");
  assert.deepEqual(cached.profiles.map((p) => p.model), ["two"]);
  assert.equal(cached.profiles[0]?.apiKey, "new-secret");
  assert.ok(!cached.reports[0]!.warnings.join("\n").includes("catalog-test-secret"));
  const unrelated = await discoverModelProfiles([
    service({ name: "Other", models: [] }),
    service({ baseUrl: "https://different.example/v1", models: [] }),
  ], db, { fetch: failingFetch });
  assert.deepEqual(unrelated.profiles, []);
  assert.ok(unrelated.reports.every((r) => r.source === "unavailable"));
});

test("无缓存失败保留显式完整 ID，不把前缀伪造成模型", async (t) => {
  const result = await discoverModelProfiles([service({
    models: ["known/model", "unfinished…"], modelPrefixes: ["gemini-preview…"],
  })], fixture(t), { fetch: failingFetch });
  assert.equal(result.reports[0]?.source, "configured");
  assert.deepEqual(result.profiles.map((p) => p.model), ["known/model"]);
  assert.match(result.reports[0]!.warnings.join("\n"), /保留已配置的完整 ID/);
});

test("鉴权失败报告状态码，缺失凭据不发出请求", async (t) => {
  const db = fixture(t);
  const unauthorized = await discoverModelProfiles([service({ models: ["exact"] })], db, {
    fetch: async () => new Response("catalog-test-secret", { status: 401 }),
  });
  assert.match(unauthorized.reports[0]!.warnings[0]!, /HTTP 401/);
  assert.ok(!JSON.stringify(unauthorized.reports).includes("catalog-test-secret"));
  let calls = 0;
  const missing = await discoverModelProfiles([service({ apiKey: "", models: ["exact"] })], db, {
    fetch: async () => { calls++; return new Response("{}"); },
  });
  assert.equal(calls, 0);
  assert.match(missing.reports[0]!.warnings[0]!, /API key 未配置/);
});

test("模型列表请求超时可回退，错误响应不会清空已有缓存", async (t) => {
  const db = fixture(t);
  await discoverModelProfiles([service()], db, { fetch: listFetch(["cached"]) });
  const timeoutFetch: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
  });
  const result = await discoverModelProfiles([service()], db, { fetch: timeoutFetch, timeoutMs: 5 });
  assert.equal(result.reports[0]?.source, "cache");
  assert.match(result.reports[0]!.warnings[0]!, /超时/);
  assert.deepEqual(result.profiles.map((p) => p.model), ["cached"]);
  const invalid = await discoverModelProfiles([service()], db, { fetch: async () => new Response(JSON.stringify({ error: "not models" })) });
  assert.equal(invalid.reports[0]?.source, "cache");
  assert.deepEqual(invalid.profiles.map((p) => p.model), ["cached"]);
});

test("配置解析服务商白名单和独立环境变量，不继承默认密钥", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.yaml");
  const yaml = [
    "gateway:", "  onebot:", "    endpoint: ws://localhost:3001",
    "model:", "  provider: mock", "  api_key: default-key", "  model: default",
    "  providers:", "    - name: Test", "      base_url: https://test.example/v1/",
    "      api_key_env: QQ_MODEL_CATALOG_TEST_KEY", "      models: [exact/model]",
    "      model_prefixes: [preview]", "      temperature: 0.8",
  ].join("\n");
  fs.writeFileSync(file, yaml);
  const old = process.env.QQ_MODEL_CATALOG_TEST_KEY;
  process.env.QQ_MODEL_CATALOG_TEST_KEY = "separate-key";
  try {
    const cfg = loadConfig(file);
    assert.deepEqual(cfg.model.providers, [{
      name: "Test", provider: "openai_compatible", baseUrl: "https://test.example/v1", apiKey: "separate-key",
      modelsUrl: undefined, models: ["exact/model"], modelPrefixes: ["preview"], temperature: 0.8,
    }]);
    delete process.env.QQ_MODEL_CATALOG_TEST_KEY;
    assert.equal(loadConfig(file).model.providers?.[0]?.apiKey, "");
    fs.writeFileSync(file, `${yaml}\n  profiles:\n    - name: legacy\n      api_key_env: QQ_MODEL_CATALOG_TEST_KEY\n      model: legacy-model\n`);
    assert.equal(loadConfig(file).model.profiles[0]?.apiKey, "", "旧档位指定了独立环境变量时也不能继承默认密钥");
    fs.writeFileSync(file, yaml.replace("models: [exact/model]", "models: [123]"));
    assert.throws(() => loadConfig(file), /models 必须是非空字符串列表/);
  } finally {
    if (old === undefined) delete process.env.QQ_MODEL_CATALOG_TEST_KEY;
    else process.env.QQ_MODEL_CATALOG_TEST_KEY = old;
  }
});
