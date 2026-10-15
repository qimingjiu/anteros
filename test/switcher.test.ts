import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "../src/db/index.js";
import { ModelSwitcher } from "../src/llm/switcher.js";
import type { AppConfig, ModelProfile } from "../src/config.js";
import { MockLLMClient } from "../src/llm/index.js";

function profiles(): ModelProfile[] {
  return [
    { name: "ds", provider: "mock", baseUrl: "", apiKey: "", model: "deepseek-flash" },
    { name: "fun", provider: "mock", baseUrl: "", apiKey: "", model: "fun-model", temperature: 1.1 },
  ];
}

function defaultCfg(): AppConfig["model"] {
  return {
    provider: "mock",
    baseUrl: "",
    apiKey: "",
    model: "default-model",
    fallbackModel: "",
    summaryModel: "",
    temperature: 0.7,
    maxContextChars: 6000,
    maxOutputChars: 2000,
    requestTimeoutMs: 5000,
    profiles: profiles(),
  };
}

test("ModelSwitcher：切换、持久化、回退", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switch-"));
  const db = new Database(path.join(tmp, "t.db"));

  const s1 = new ModelSwitcher(profiles(), defaultCfg(), db);
  assert.equal(s1.activeName(), "默认（default-model）");
  assert.deepEqual(s1.profileNames(), ["ds", "fun"]);

  const r = s1.switchTo("fun");
  assert.ok(r.ok);
  assert.equal(s1.activeName(), "fun");
  const reply = await s1.chat([{ role: "user", content: "hi" }]);
  assert.ok(reply.content.includes("fun-model") || reply.content.length > 0);

  assert.ok(!s1.switchTo("不存在").ok, "未知档位不切换");

  // 重启后保持
  const s2 = new ModelSwitcher(profiles(), defaultCfg(), db);
  assert.equal(s2.activeName(), "fun");

  // 持久化了不存在的档位 → 回退默认
  db.kvSet("active_model_profile", "ghost");
  const s3 = new ModelSwitcher(profiles(), defaultCfg(), db);
  assert.equal(s3.activeName(), "默认（default-model）");

  // 切回同档位提示幂等
  s3.switchTo("ds");
  const again = s3.switchTo("ds");
  assert.ok(again.ok && again.message.includes("已经在用"));

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("MockLLM 兼容多段内容（vision 消息）", async () => {
  const m = new MockLLMClient();
  const r = await m.chat([
    {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "https://x/y.png" } },
      ],
    },
  ]);
  assert.ok(r.content.includes("看图"));
});

test("ModelSwitcher：先列模型商，同名模型按商隔离，显示不泄漏计价标签", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switch-providers-"));
  const db = new Database(path.join(tmp, "t.db"));
  t.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const options: ModelProfile[] = [
    { name: "ds", provider: "mock", serviceName: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "", model: "deepseek-flash" },
    { name: "Sora/times/gemini", serviceName: "Sora", provider: "mock", baseUrl: "https://sora.example/v1", apiKey: "", model: "times/gemini" },
    { name: "tale/[0.02/次]times/gemini", serviceName: "tale", provider: "mock", baseUrl: "https://tale.example/v1", apiKey: "", model: "[0.02/次]times/gemini" },
  ];
  const s = new ModelSwitcher(options, defaultCfg(), db);
  assert.deepEqual(s.providerNames(), ["DeepSeek", "Sora", "tale"]);
  assert.deepEqual(s.modelsFor("Sora").map((p) => p.name), ["Sora/times/gemini"]);
  assert.match(s.list(), /先选择模型商/);
  assert.ok(!s.list().includes("times/gemini"), "初次菜单不把全部模型摊开");
  assert.match(s.list("Sora"), /1\. times\/gemini/);
  assert.ok(!s.list("Sora").includes("tale"));
  assert.ok(!s.switchTo("times/gemini").ok, "不以裸 ID 跨商匹配");
  const switched = s.switchTo("tale/[0.02/次]times/gemini");
  assert.ok(switched.ok);
  assert.equal(s.activeName(), "tale/[0.02/次]times/gemini");
  assert.equal(s.activeDisplayName(), "tale / times/gemini");
  assert.ok(!switched.message.includes("0.02"));
  assert.ok(!s.list("tale").includes("0.02"));
  assert.ok(!s.switchTo(s.activeName()).message.includes("0.02"));
  assert.match(s.list("tale"), /← 当前/);
  const restarted = new ModelSwitcher(options, defaultCfg(), db);
  assert.equal(restarted.activeName(), "tale/[0.02/次]times/gemini");
});

test("ModelSwitcher：缺失独立密钥不能切换或恢复，仍展示服务商", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switch-missing-key-"));
  const db = new Database(path.join(tmp, "t.db"));
  t.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const options: ModelProfile[] = [
    { name: "Tianyi/chat", serviceName: "天翼云", provider: "openai_compatible", baseUrl: "https://tianyi.example/v1", apiKey: "", model: "chat" },
  ];
  const cfg = defaultCfg();
  cfg.providers = [{ name: "未连通商", provider: "openai_compatible", baseUrl: "https://offline.example/v1", apiKey: "" }];
  const s = new ModelSwitcher(options, cfg, db);
  assert.deepEqual(s.providerNames(), ["天翼云", "未连通商"]);
  assert.ok(!s.switchTo("Tianyi/chat").ok);
  assert.equal(s.activeName(), "默认（default-model）");
  assert.equal(db.kvGet("active_model_profile"), undefined);
  assert.match(s.list("未连通商"), /暂时没有可用模型/);
  db.kvSet("active_model_profile", "Tianyi/chat");
  assert.equal(new ModelSwitcher(options, cfg, db).activeName(), "默认（default-model）");
});
