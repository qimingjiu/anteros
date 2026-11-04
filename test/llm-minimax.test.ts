import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleClient } from "../src/llm/index.js";
import type { AppConfig } from "../src/config.js";

const cfg: AppConfig["model"] = { provider: "openai_compatible", baseUrl: "https://api.minimaxi.com/v1",
  apiKey: "fixture-key", model: "MiniMax-M2.7-highspeed", fallbackModel: "", summaryModel: "", temperature: 0.7,
  maxContextChars: 6000, maxOutputChars: 2000, requestTimeoutMs: 5000, profiles: [] };

function fixture(t: TestContext, message: Record<string, unknown>) {
  const bodies: Record<string, any>[] = [];
  const logs: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => logs.push(parts.map(String).join(" ")));
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
  });
  return { bodies, logs };
}

test("MiniMax: official endpoints request separated reasoning without disabling thinking", async t => {
  const f = fixture(t, { content: "确认", reasoning_content: "PRIVATE-THINKING", reasoning_details: [
    { type: "reasoning.text", format: "MiniMax-response-v1", text: "PRIVATE-THINKING", id: "fixture" },
  ] });
  for (const baseUrl of ["https://api.minimaxi.com/v1", "https://api.minimax.io/v1"]) {
    const result = await new OpenAICompatibleClient({ ...cfg, baseUrl }).chat([{ role: "user", content: "确认一下" }]);
    assert.equal(result.content, "确认");
    assert.equal(result.reasoningContent, "PRIVATE-THINKING");
    assert.equal(result.reasoningDetails?.length, 1);
    assert.equal(result.replayContent, undefined);
  }
  assert.ok(f.bodies.every(b => b.reasoning_split === true && b.thinking === undefined));
  assert.doesNotMatch(f.logs.join("\n"), /PRIVATE-THINKING/);
});

test("MiniMax: compatible proxy inline thinking is hidden while exact raw content remains available for tool replay", async t => {
  const raw = "\n<think>PRIVATE-THINKING\nwith a second line</think>\n最终回答";
  const f = fixture(t, { content: raw });
  for (const model of ["MiniMax-M2.5-oc", "minimax/minimax-m3", "[0.1元/次]MiniMax-M2.7"]) {
    const result = await new OpenAICompatibleClient({ ...cfg, model, baseUrl: "https://fixture.invalid/v1" })
      .chat([{ role: "user", content: "确认一下" }]);
    assert.equal(result.content, "最终回答");
    assert.equal(result.replayContent, raw);
    assert.equal(result.reasoningContent, undefined);
  }
  assert.ok(f.bodies.every(b => b.reasoning_split === undefined));
  assert.doesNotMatch(f.logs.join("\n"), /PRIVATE-THINKING|second line/);
});

test("MiniMax: even an official endpoint ignoring reasoning_split cannot expose a leading inline block", async t => {
  const raw = "<think>PRIVATE-THINKING</think>确认";
  fixture(t, { content: raw, reasoning_content: "PRIVATE-SEPARATE" });
  const result = await new OpenAICompatibleClient(cfg).chat([{ role: "user", content: "确认一下" }]);
  assert.equal(result.content, "确认");
  assert.equal(result.replayContent, raw);
  assert.equal(result.reasoningContent, "PRIVATE-SEPARATE");
});

test("MiniMax: truncated thinking produces no visible answer", async t => {
  const raw = "<think>PRIVATE-THINKING that never closes";
  fixture(t, { content: raw });
  const result = await new OpenAICompatibleClient(cfg).chat([{ role: "user", content: "确认一下" }]);
  assert.equal(result.content, "");
  assert.equal(result.replayContent, raw);
});

test("MiniMax: suffix-lookalike hosts receive no provider-specific parameter and unrelated models are untouched", async t => {
  const raw = "<think>an example supplied by another provider</think>";
  const f = fixture(t, { content: raw });
  const result = await new OpenAICompatibleClient({ ...cfg, baseUrl: "https://api.minimaxi.com.example.invalid/v1", model: "ordinary-model" })
    .chat([{ role: "user", content: "解释一下标签" }]);
  assert.equal(result.content, raw);
  assert.equal(result.replayContent, undefined);
  assert.equal(f.bodies[0]!.reasoning_split, undefined);
});

test("MiniMax: ordinary code examples and visible answer whitespace remain intact", async t => {
  const content = "  示例：\n```xml\n<think>示例内容</think>\n```\n";
  fixture(t, { content });
  const result = await new OpenAICompatibleClient(cfg).chat([{ role: "user", content: "解释一下标签" }]);
  assert.equal(result.content, content);
  assert.equal(result.replayContent, undefined);
});
