import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent/index.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import { PrivateTranscript } from "../src/family/transcript.js";
import { Gateway, gatewayOptionsFromConfig } from "../src/gateway/index.js";
import type { LLMClient } from "../src/llm/index.js";
import { ModelSwitcher } from "../src/llm/switcher.js";
import { configuredAccounts } from "../src/platform-accounts.js";
import { McpManager } from "../src/tools/mcp.js";
import type { GatewayEvent, MessageRecord, MessageSegment, Provider, SendResult } from "../src/types.js";

class TestProvider implements Provider {
  private listeners: ((event: GatewayEvent) => void)[] = [];
  readonly sent: { target: string; text: string }[] = [];

  constructor(readonly providerId: string, private readonly botId: string) {}
  start() {}
  async stop() {}
  onEvent(listener: (event: GatewayEvent) => void) { this.listeners.push(listener); }
  emit(message: MessageRecord) {
    for (const listener of this.listeners) listener({ kind: "message", message });
  }
  health() {
    return { connection: "connected", login: "online", selfId: this.botId, reconnectCount: 0 } as const;
  }
  capabilities() {
    return { receiveMessages: "supported", sendText: "supported", sendImage: "supported",
      sendPrivateFile: "unsupported", groupHistory: "unsupported" } as const;
  }
  async sendPrivateMsg(target: string, segments: MessageSegment[]): Promise<SendResult> {
    this.sent.push({ target, text: segments.flatMap(part => part.type === "text" ? [part.data.text] : []).join("") });
    return { status: "confirmed", messageId: String(1000 + this.sent.length) };
  }
  async sendGroupMsg(target: string, segments: MessageSegment[]) {
    return this.sendPrivateMsg(target, segments);
  }
}

async function eventually(predicate: () => boolean) {
  for (let tries = 0; tries < 100; tries++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.ok(predicate(), "expected message processing to finish");
}

test("one Anteros process shares one private family among three gateways and isolates group prompts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "anteros-family-"));
  await mkdir(path.join(directory, "personas"));
  await writeFile(path.join(directory, "personas", "2-fog.md"),
    "---\r\nid: fog\r\nname: 雾岛纪\r\n---\r\nFAMILY_MEMBER_PROMPT\r\n");
  const sample = (await readFile(new URL("../README.md", import.meta.url), "utf8"))
    .match(/```yaml\r?\n([\s\S]+?)\r?\n```/)?.[1];
  assert.ok(sample, "README has a loadable three-platform example");
  const configPath = path.join(directory, "config.yaml");
  await writeFile(configPath, sample + "\nmodel: { provider: mock }\n"
    + "groups: { allowlist: [\"333\"], mention_only: [\"333\"] }\n"
    + "persona: { name: 乌鸦, prompt: PUBLIC_PERSONA }\nmemory: { enabled: false }\n");
  const config = loadConfig(configPath);
  const db = new Database(":memory:");
  const accounts = configuredAccounts(config).map((cfg, index) => {
    const provider = new TestProvider(cfg.gateway.provider, String(500 + index));
    return { cfg, provider, gateway: new Gateway(db, provider, gatewayOptionsFromConfig(cfg, index === 0)) };
  });
  const transcript = new PrivateTranscript(db, accounts.map(({ cfg, provider }) => ({
    accountId: cfg.gateway.accountId, ownerIds: cfg.tools.ownerIds!, botId: () => provider.health().selfId,
  })));
  const prompts: string[] = [];
  const llm: LLMClient = { async chat(messages) {
    const prompt = messages.map(message => typeof message.content === "string" ? message.content : "").join("\n");
    if (prompt.includes("当前需要回复的消息")) prompts.push(prompt);
    return { content: "已收到", toolCalls: [], finishReason: "stop" };
  } };
  const mcp = new McpManager(config.tools.mcp);
  let shared: ReturnType<Agent["familyWorld"]> | undefined;
  let chain = Promise.resolve();
  const serial = (fn: () => Promise<void>) => {
    const job = chain.then(fn);
    chain = job.catch(() => undefined);
    return job;
  };
  try {
    for (const [index, account] of accounts.entries()) {
      const agent = new Agent({ db, ...account, llm, memory: null, search: null, reader: null, mcp,
        timezone: "Asia/Shanghai", familyWorld: shared, linkedTranscript: transcript,
        runFamilyTurn: serial, personaDirectory: directory, legacyWorldAccess: index === 0 });
      shared ??= agent.familyWorld();
      agent.attach();
      account.gateway.start();
    }
    function inject(index: number, id: string, text: string, group = false) {
      const { cfg, provider } = accounts[index]!;
      const owner = cfg.tools.ownerIds![0]!;
      const conversationId = group ? "group_333" : "private_" + owner;
      const now = new Date().toISOString();
      provider.emit({ eventKey: cfg.gateway.accountId + ":" + conversationId + ":message:" + id,
        accountId: cfg.gateway.accountId, providerId: provider.providerId,
        conversationId, groupId: group ? "333" : undefined, messageId: id, senderId: owner,
        displayNameAtTime: "主人", sentAt: now, receivedAt: now, textContent: text, origin: "live", status: "active",
        segments: [...(group ? [{ type: "at" as const, data: { qq: provider.health().selfId } }] : []),
          { type: "text", data: { text } }] });
    }
    inject(0, "1", "PRIVATE_SOURCE_ONLY 橘子");
    await eventually(() => accounts[0]!.provider.sent.length > 0);
    inject(0, "2", "让雾岛纪来");
    await eventually(() => shared?.personas.active().id === "fog");
    inject(1, "1", "DISCORD_CONTINUITY");
    await eventually(() => accounts[1]!.provider.sent.length === 1);
    inject(2, "1", "TELEGRAM_CONTINUITY");
    await eventually(() => accounts[2]!.provider.sent.length === 1);
    inject(0, "3", "PUBLIC_REQUEST", true);
    await eventually(() => accounts[0]!.provider.sent.some(row => row.target === "333"));
    for (const marker of ["DISCORD_CONTINUITY", "TELEGRAM_CONTINUITY"]) {
      const prompt = prompts.find(entry => entry.includes("]: " + marker));
      assert.match(prompt ?? "", /FAMILY_MEMBER_PROMPT/);
      assert.match(prompt ?? "", /PRIVATE_SOURCE_ONLY/);
    }
    const groupPrompt = prompts.find(entry => entry.includes("]: PUBLIC_REQUEST"));
    assert.match(groupPrompt ?? "", /PUBLIC_PERSONA/);
    assert.doesNotMatch(groupPrompt ?? "", /FAMILY_MEMBER_PROMPT|PRIVATE_SOURCE_ONLY/);
    assert.equal(db.getMessageById("private_123456789", "1", "telegram")?.text_content, "TELEGRAM_CONTINUITY");
    assert.equal(db.getMessageById("private_10001", "1", "default")?.text_content, "PRIVATE_SOURCE_ONLY 橘子");
  } finally {
    await Promise.all(accounts.map(account => account.gateway.stop()));
    db.close();
  }
});

test("a model selection for one member survives reload without changing the group default", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "anteros-model-"));
  const configPath = path.join(directory, "config.yaml");
  await writeFile(configPath, `
gateway: { onebot: { endpoint: "ws://127.0.0.1:3001" } }
model:
  provider: mock
  model: basic
  profiles:
    - { name: other, provider: mock, model: sample }
`);
  const config = loadConfig(configPath);
  const db = new Database(":memory:");
  try {
    const create = () => new ModelSwitcher(config.model.profiles, config.model, db);
    const root = create();
    assert.equal(root.forMember("room", "fog", "雾岛纪").switchTo("other").ok, true);
    const restored = create();
    assert.equal(restored.forMember("room", "fog", "雾岛纪").activeName(), "other");
    assert.notEqual(restored.forMember("room", "raven", "乌鸦").activeName(), "other");
    assert.notEqual(restored.activeName(), "other");
  } finally { db.close(); }
});
