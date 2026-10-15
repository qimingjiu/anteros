import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import type { Gateway } from "../src/gateway/index.js";
import type { ChatMessage, LLMClient, ToolSpec } from "../src/llm/index.js";
import { ModelSwitcher } from "../src/llm/switcher.js";
import type { McpManager } from "../src/tools/mcp.js";
import type { PageReader } from "../src/tools/reader.js";
import type { SearchProvider } from "../src/tools/search.js";
import type { MessageRecord, ToolContext, ToolDef } from "../src/types.js";

const OWNER = "10001";
const OTHER_ADMIN = "admin-without-tool-ownership";
const MCP_NAMES = ["mcp__fixture__qq_history", "mcp__fixture__document", "mcp__fixture__media"];

interface InspectableAgent {
  buildToolSpecs(m: MessageRecord): ToolSpec[];
  executeTool(name: string, argsJson: string, m: MessageRecord): Promise<string>;
  generateReply(m: MessageRecord, merged: MessageRecord[]): Promise<string>;
}

function fixture(t: TestContext, options: { owners?: string[] | null; legacyFlag?: boolean; toolsEnabled?: boolean } = {}) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.memory.enabled = false;
  cfg.admins = [OWNER, OTHER_ADMIN];
  cfg.groups.allowlist = ["100"];
  cfg.groups.linkPreview = false;
  cfg.tools.enabled = options.toolsEnabled ?? true;
  cfg.tools.mcp.enabled = true;
  cfg.tools.privateToolsOwnerOnly = options.legacyFlag ?? true;
  if (options.owners === null) delete cfg.tools.ownerIds;
  else cfg.tools.ownerIds = options.owners ?? [OWNER];
  cfg.model = {
    ...cfg.model, provider: "mock", baseUrl: "", apiKey: "", model: "fixture-model", providers: [],
    profiles: [{ name: "mock", serviceName: "Fixture", provider: "mock", baseUrl: "", apiKey: "", model: "fixture-model" }],
  };
  const executed: { name: string; args: Record<string, unknown>; ctx: ToolContext }[] = [];
  const defs: ToolDef[] = MCP_NAMES.map(name => ({
    name, description: `${name} fixture`, inputSchema: { type: "object", properties: {} },
    execute: async (args, ctx) => { executed.push({ name, args, ctx }); return `${name}: executed`; },
  }));
  const fakeMcp = { getTools: () => defs } as unknown as McpManager;
  const searches: string[] = [];
  const reads: string[] = [];
  const search: SearchProvider = {
    name: "fixture", search: async query => {
      searches.push(query);
      return [{ title: "Shared search result", url: "https://example.invalid/result", snippet: "fixture snippet", source: "fixture" }];
    },
  };
  const reader = {
    read: async (url: string) => {
      reads.push(url);
      return { url, finalUrl: url, title: "Shared page", text: "fixture page body", status: "ok", fetchedAt: new Date().toISOString() };
    },
  } as unknown as PageReader;
  const calls: { messages: ChatMessage[]; tools: ToolSpec[] | undefined }[] = [];
  const llm: LLMClient = {
    chat: async (messages, opts) => {
      calls.push({ messages: structuredClone(messages), tools: opts?.tools ? structuredClone(opts.tools) : undefined });
      return { content: "fixture answer", toolCalls: [], finishReason: "stop" };
    },
  };
  const gateway = { getProvider: () => ({ health: () => ({ selfId: "bot" }) }) } as unknown as Gateway;
  const switcher = new ModelSwitcher(cfg.model.profiles, cfg.model, db);
  const agent = new Agent({
    db, cfg, gateway, llm, memory: null, search, reader, mcp: fakeMcp, modelSwitcher: switcher, timezone: cfg.timezone,
  }) as unknown as InspectableAgent;
  let serial = 0;
  const message = (senderId = OWNER, groupId?: string): MessageRecord => ({
    eventKey: `fixture:${++serial}`, accountId: "acct", providerId: "onebot",
    conversationId: groupId ? `group_${groupId}` : `private_${senderId}`, groupId, messageId: String(serial), senderId,
    displayNameAtTime: senderId, sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
    segments: [{ type: "text", data: { text: "use the tools" } }], textContent: "use the tools", status: "active", origin: "live",
  });
  const names = (m: MessageRecord) => agent.buildToolSpecs(m).map(spec => spec.function.name);
  return { cfg, agent, message, names, executed, searches, reads, calls, switcher };
}

test("工具权限：唯一所有者在私聊和已启用群都得到全部 MCP 工具，旧标志不影响", async t => {
  for (const legacyFlag of [true, false]) {
    const f = fixture(t, { legacyFlag });
    for (const m of [f.message(), f.message(OWNER, "100")]) {
      assert.ok(MCP_NAMES.every(name => f.names(m).includes(name)));
      assert.ok(f.names(m).includes("web_search"));
      assert.ok(f.names(m).includes("read_page"));
      for (const name of MCP_NAMES) assert.match(await f.agent.executeTool(name, "{}", m), /executed/);
    }
    assert.equal(f.executed.length, 6);
  }
});

test("工具权限：其他管理员和普通用户都不获得 MCP，旧标志关闭也不能扩大权限", async t => {
  for (const legacyFlag of [true, false]) {
    const f = fixture(t, { legacyFlag });
    for (const sender of [OTHER_ADMIN, "ordinary-user", "unknown-user"]) {
      for (const m of [f.message(sender), f.message(sender, "100")]) {
        assert.ok(MCP_NAMES.every(name => !f.names(m).includes(name)));
        for (const name of MCP_NAMES) {
          assert.match(await f.agent.executeTool(name, "{}", m), /不存在或当前不可用|未授权|没有权限/);
        }
      }
    }
    assert.equal(f.executed.length, 0);
  }
});

test("工具权限：普通用户在群聊和私聊仍可搜索和读取网页", async t => {
  const f = fixture(t);
  for (const m of [f.message("ordinary-user"), f.message("ordinary-user", "100")]) {
    assert.deepEqual(f.names(m).sort(), ["read_page", "web_search"]);
    assert.match(await f.agent.executeTool("web_search", '{"query":"fixture query"}', m), /Shared search result/);
    assert.match(await f.agent.executeTool("read_page", '{"url":"https://example.invalid/page"}', m), /fixture page body/);
  }
  assert.deepEqual(f.searches, ["fixture query", "fixture query"]);
  assert.deepEqual(f.reads, ["https://example.invalid/page", "https://example.invalid/page"]);
  assert.equal(f.executed.length, 0);
});

test("工具权限：伪造所有者 QQ、管理员标志和私聊上下文的参数不能获得 MCP", async t => {
  const f = fixture(t);
  const spoofed = JSON.stringify({ requesterId: OWNER, senderId: OWNER, ownerId: OWNER, isAdmin: true, isOwner: true, isPrivate: true, groupId: "100" });
  for (const m of [f.message("unknown-user"), f.message("unknown-user", "100")]) {
    assert.match(await f.agent.executeTool(MCP_NAMES[0]!, spoofed, m), /不存在或当前不可用|未授权|没有权限/);
  }
  assert.equal(f.executed.length, 0);
});

test("工具权限：所有者执行时上下文来自真实消息，不能被 JSON 参数覆盖", async t => {
  const f = fixture(t);
  const params = JSON.stringify({ requesterId: "fake-user", isPrivate: true, groupId: "999", accountId: "fake-acct" });
  await f.agent.executeTool(MCP_NAMES[0]!, params, f.message(OWNER, "100"));
  assert.deepEqual(f.executed[0]!.ctx, { accountId: "acct", groupId: "100", requesterId: OWNER, isPrivate: false });
});

test("工具权限：禁用群不向所有者暴露 MCP，也拒绝直接调用", async t => {
  const f = fixture(t);
  const m = f.message(OWNER, "999");
  assert.ok(MCP_NAMES.every(name => !f.names(m).includes(name)));
  assert.match(await f.agent.executeTool(MCP_NAMES[0]!, "{}", m), /不存在或当前不可用|未授权|没有权限/);
  assert.equal(f.executed.length, 0);
});

test("工具权限：全局工具关闭后连伪造直接调用也不能执行任何工具", async t => {
  const f = fixture(t, { toolsEnabled: false });
  const m = f.message();
  assert.deepEqual(f.names(m), []);
  for (const [name, args] of [
    [MCP_NAMES[0]!, "{}"], ["web_search", '{"query":"fixture"}'],
    ["read_page", '{"url":"https://example.invalid/page"}'], ["list_models", "{}"],
  ]) {
    assert.match(await f.agent.executeTool(name!, args!, m), /不存在或当前不可用|工具.*关闭|未启用/);
  }
  assert.equal(f.executed.length, 0);
  assert.equal(f.searches.length, 0);
  assert.equal(f.reads.length, 0);
});

test("工具权限：显式空所有者列表拒绝所有 MCP，不能回退管理员", async t => {
  const f = fixture(t, { owners: [] });
  for (const sender of [OWNER, OTHER_ADMIN]) {
    for (const m of [f.message(sender), f.message(sender, "100")]) {
      assert.ok(MCP_NAMES.every(name => !f.names(m).includes(name)));
      assert.match(await f.agent.executeTool(MCP_NAMES[0]!, "{}", m), /不存在或当前不可用|未授权|没有权限/);
    }
  }
  assert.equal(f.executed.length, 0);
});

test("工具权限：旧配置没有所有者字段时兼容管理员，但仍不授权普通用户", async t => {
  const f = fixture(t, { owners: null });
  assert.ok(MCP_NAMES.every(name => f.names(f.message(OTHER_ADMIN, "100")).includes(name)));
  assert.ok(MCP_NAMES.every(name => f.names(f.message(OTHER_ADMIN)).includes(name)));
  assert.ok(MCP_NAMES.every(name => !f.names(f.message("ordinary-user")).includes(name)));
  assert.match(await f.agent.executeTool(MCP_NAMES[0]!, "{}", f.message("ordinary-user")), /不存在或当前不可用|未授权|没有权限/);
  assert.equal(f.executed.length, 0);
});

test("工具权限：模型菜单保持管理员私聊限制，工具所有者身份不扩大模型权限", t => {
  const f = fixture(t, { owners: ["ordinary-owner"] });
  assert.ok(f.names(f.message(OTHER_ADMIN)).includes("list_models"));
  assert.ok(!f.names(f.message(OTHER_ADMIN, "100")).includes("list_models"));
  assert.ok(!f.names(f.message("ordinary-owner")).includes("list_models"));
  assert.ok(MCP_NAMES.every(name => f.names(f.message("ordinary-owner", "100")).includes(name)));
  assert.ok(MCP_NAMES.every(name => !f.names(f.message(OTHER_ADMIN)).includes(name)));
});

test("工具权限：模型实际收到的定义按当前消息发送者分配", async t => {
  const f = fixture(t);
  await f.agent.generateReply(f.message(OWNER, "100"), []);
  await f.agent.generateReply(f.message("ordinary-user", "100"), []);
  const ownerNames = f.calls[0]!.tools!.map(tool => tool.function.name);
  const ordinaryNames = f.calls[1]!.tools!.map(tool => tool.function.name);
  assert.ok(MCP_NAMES.every(name => ownerNames.includes(name)));
  assert.deepEqual(ordinaryNames.sort(), ["read_page", "web_search"]);
  assert.equal(f.executed.length, 0, "仅公布工具定义不会执行工具");
});

test("工具权限配置：显式 QQ 列表转为字符串，空列表保留，缺省使用管理员", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bot-owner-config-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const configPath = path.join(temp, "config.yaml");
  const write = (ownerSetting: string) => {
    fs.writeFileSync(configPath, `gateway:\n  onebot:\n    endpoint: ws://127.0.0.1:1\nmodel:\n  provider: mock\n  model: fixture\nadmins: ["legacy-admin"]\ntools:\n  enabled: true\n${ownerSetting}`, "utf8");
    return loadConfig(configPath);
  };
  assert.deepEqual(write(`  owner_ids: [10001, "second-owner"]\n`).tools.ownerIds, [OWNER, "second-owner"]);
  assert.deepEqual(write("  owner_ids: []\n").tools.ownerIds, []);
  const missing = write("");
  assert.deepEqual(missing.tools.ownerIds ?? missing.admins, ["legacy-admin"]);
});
