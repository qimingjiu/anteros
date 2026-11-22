import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { McpAdmin, type McpAdminOptions } from "../src/mcp-admin/index.js";
import { managedLocalLaunch } from "../src/mcp-admin/local.js";
import { validateManagedManifest } from "../src/mcp-admin/manifest.js";
import { createMcpAdminHandler } from "../src/mcp-admin/panel.js";
import { McpManager, type ManagedMcpRunConfig } from "../src/tools/mcp.js";
import type { ToolContext } from "../src/types.js";

const secret = "Bearer fixture-private-value";
const room = "private-room";
const persona = "member";
const context: ToolContext = { accountId: "main", requesterId: "789", isPrivate: true, personaId: persona, roomId: room };
const remote = { id: "fixture", kind: "remote", allowedAgents: [persona], allowedRooms: [room],
  url: "https://fixture.example/mcp", secretHeaders: { Authorization: "provider-token" }, allowedTools: ["allowed"] };

async function fixtures(t: TestContext, options: Partial<McpAdminOptions> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anteros-mcp-admin-"));
  const db = new DatabaseSync(":memory:");
  const mounted = new Map<string, { config: ManagedMcpRunConfig; allowed(ctx: ToolContext): boolean }>();
  const manager: McpAdminOptions["manager"] = {
    async upsertManaged(config, allowed) {
      if (config.url?.endsWith("/broken")) throw new Error("握手失败");
      mounted.set(config.name, { config, allowed });
    },
    async removeManaged(id) { mounted.delete(id); },
    managedStatus(id) { return { connected: mounted.has(id), tools: mounted.has(id) ? 1 : 0 }; },
    hasStaticServer(id) { return id === "static-config"; },
  };
  const admin = new McpAdmin({ db, manager, directory, isOwner: (account, user) => account === "main" && user === "789", ...options });
  t.after(async () => {
    await admin.stop();
    db.close();
    await fs.unlink(path.join(directory, "vault.key")).catch(error => { if (error.code !== "ENOENT") throw error; });
    await fs.rmdir(directory);
  });
  return { directory, db, mounted, manager, admin };
}

async function settled(admin: McpAdmin, id: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const job = admin.job(id);
    if (job && !["queued", "running"].includes(job.status)) { await delay(0); return job; }
    await delay(10);
  }
  assert.fail("Managed MCP job did not settle");
}

test("托管 MCP 清单拒绝任意命令、版本范围、危险环境覆盖和非公开地址", () => {
  assert.throws(() => validateManagedManifest({ ...remote, command: "node" }), /不支持/);
  assert.throws(() => validateManagedManifest({ ...remote, secretHeaders: { Host: "provider-token" } }), /引用/);
  assert.throws(() => validateManagedManifest({ ...remote, url: "https://127.0.0.1/mcp" }), /公开 HTTPS/);
  assert.throws(() => validateManagedManifest({ ...remote, url: "https://example.com/mcp?token=inline" }), /公开 HTTPS/);
  const local = { id: "fixture", kind: "npm", allowedAgents: [persona], allowedRooms: [room], package: "@demo/server", version: "1.2.3" };
  assert.throws(() => validateManagedManifest({ ...local, version: "^1.2.3" }), /精确/);
  assert.throws(() => validateManagedManifest({ ...local, package: "https://example.com/package.tgz" }), /包名/);
  assert.throws(() => validateManagedManifest({ ...local, secretEnv: { NODE_OPTIONS: "provider-token" } }), /凭据/);
  assert.throws(() => validateManagedManifest({ ...local, allowedRooms: [] }), /房间/);
  assert.equal(validateManagedManifest(local).kind, "npm");
});

test("托管 MCP 凭据加密、待补凭据可重试，失败更新和重启保持有效版本", async t => {
  const { admin, db, manager, mounted, directory } = await fixtures(t);
  assert.throws(() => admin.submit("install", { manifest: { ...remote, id: "static-config" } }), /静态配置/);
  const pending = admin.submit("install", { manifest: remote });
  assert.equal((await settled(admin, pending.id)).status, "awaiting_input");
  assert.deepEqual(admin.list(), []);
  await admin.vault.write("provider-token", secret);
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT payload FROM managed_mcp_credentials").all()), /fixture-private-value/);
  const installed = admin.retry(pending.id);
  assert.equal((await settled(admin, installed.id)).status, "succeeded");
  assert.equal(mounted.get("fixture")?.config.headers?.Authorization, secret);
  assert.equal(mounted.get("fixture")?.config.secureRemote, true);
  assert.equal(mounted.get("fixture")?.allowed(context), true);
  for (const denied of [{ ...context, roomId: "other" }, { ...context, personaId: "other" },
    { ...context, isPrivate: false }, { ...context, requesterId: "456" }, { ...context, accountId: "other" }]) {
    assert.equal(mounted.get("fixture")?.allowed(denied), false);
  }
  const update = admin.submit("update", { manifest: { ...remote, url: "https://fixture.example/broken" } });
  assert.equal((await settled(admin, update.id)).status, "failed");
  assert.equal(admin.list()[0]?.manifest.kind, "remote");
  assert.equal(mounted.get("fixture")?.config.url, remote.url);
  const disable = admin.submit("disable", { id: remote.id });
  assert.equal((await settled(admin, disable.id)).status, "succeeded");
  assert.equal(admin.list()[0]?.enabled, false);
  assert.equal(mounted.has("fixture"), false);
  const enable = admin.submit("enable", { id: remote.id });
  assert.equal((await settled(admin, enable.id)).status, "succeeded");
  await admin.stop();
  mounted.clear();
  const resumed = new McpAdmin({ db, manager, directory, isOwner: () => true });
  try {
    await resumed.restore();
    assert.equal(mounted.get("fixture")?.config.headers?.Authorization, secret);
    const remove = resumed.submit("uninstall", { id: remote.id });
    assert.equal((await settled(resumed, remove.id)).status, "succeeded");
    assert.deepEqual(resumed.list(), []);
    assert.deepEqual(resumed.vault.list(), ["provider-token"]);
  } finally {
    await resumed.stop();
  }
});

test("托管 MCP 沿用 stdio，引入实际调用范围并在移除后拒绝已捕获工具", async t => {
  const manager = new McpManager({ enabled: true, servers: [], connectTimeoutMs: 1000, callTimeoutMs: 1000 });
  t.after(() => manager.stop());
  const mcp = `
import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const value = process.env.FIXTURE_VALUE;
  const result = request.method === "initialize"
    ? { serverInfo: { name: value, version: "1" }, protocolVersion: "2025-11-25" }
    : request.method === "tools/list"
      ? { tools: [{ name: "allowed", description: value, inputSchema: { type: "object", example: value } }, { name: "ignored" }] }
      : { content: [{ type: "text", text: value + " / " + String(process.env.NODE_OPTIONS) }] };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
`;
  const config: ManagedMcpRunConfig = {
    name: "fixture", transport: "stdio", command: process.execPath, args: ["--input-type=module", "--eval", mcp],
    env: { FIXTURE_VALUE: secret }, credentials: [secret],
    isolatedStdio: { directory: process.cwd(), env: {} }, allowTools: ["allowed"],
  };
  try {
    await manager.upsertManaged(config, ctx => ctx.isPrivate && ctx.roomId === room);
    assert.deepEqual(manager.getTools(), []);
    assert.deepEqual(manager.getTools({ ...context, roomId: "other" }), []);
    const [tool] = manager.getTools(context);
    assert.ok(tool);
    assert.equal(tool.name, "mcp__fixture__allowed");
    assert.doesNotMatch(JSON.stringify(tool), /fixture-private-value/);
    assert.equal(await tool.execute({}, context), "[redacted] / undefined");
    await assert.rejects(tool.execute({}, { ...context, isPrivate: false }), /不可用/);
    await assert.rejects(manager.upsertManaged({ ...config, command: path.join(os.tmpdir(), "nonexistent-managed-fixture") }, () => true), /未能启动/);
    assert.equal(await tool.execute({}, context), "[redacted] / undefined");
    await manager.removeManaged("fixture");
    await assert.rejects(tool.execute({}, context), /未连接/);
  } finally {
    await manager.stop();
  }
});

test("手机 MCP 面板只接受已有面板 Bearer 令牌，目录搜索可缓存且不会安装", async t => {
  let searches = 0;
  const { admin, mounted } = await fixtures(t, { fetch: async input => {
    searches++;
    assert.match(String(input), /^https:\/\/registry\.modelcontextprotocol\.io\/v0\.1\/servers\?/);
    return Response.json({ servers: [{ server: { name: "test/server", packages: [{ registryType: "npm", identifier: "@test/server", version: "1.2.3" }] } }] });
  } });
  const handler = createMcpAdminHandler(admin, "fixture-panel-token");
  const server = http.createServer((req, res) => {
    void handler(req, res, new URL(req.url ?? "/", "http://localhost")).then(handled => { if (!handled) res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const page = await fetch(url + "/mcp");
  const markup = await page.text();
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.doesNotMatch(markup, /fixture-panel-token/);
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(markup)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  assert.equal((await fetch(url + "/api/mcp/services?token=fixture-panel-token")).status, 401);
  const headers = { Authorization: "Bearer fixture-panel-token", "Content-Type": "application/json" };
  const write = await fetch(url + "/api/mcp/secrets", { method: "POST", headers, body: JSON.stringify({ ref: "provider-token", value: secret }) });
  assert.deepEqual(await write.json(), { ref: "provider-token" });
  const refs = await fetch(url + "/api/mcp/secrets", { headers });
  assert.deepEqual(await refs.json(), { refs: ["provider-token"] });
  const first = await (await fetch(url + "/api/mcp/search?query=Test", { headers })).json();
  const second = await (await fetch(url + "/api/mcp/search?query=test", { headers })).json();
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.deepEqual(first.results, second.results);
  assert.equal(searches, 1);
  assert.equal(mounted.size, 0);
});

test("npm 启动路径必须落在固定版本的已安装包内部", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anteros-mcp-package-"));
  const modules = path.join(directory, "node_modules");
  const packageRoot = path.join(modules, "fixture");
  await fs.mkdir(packageRoot, { recursive: true });
  const entry = path.join(packageRoot, "mcp.js");
  const outside = path.join(modules, "outside.js");
  const metadata = path.join(packageRoot, "package.json");
  t.after(async () => {
    for (const file of [entry, outside, metadata]) await fs.unlink(file);
    for (const dir of [packageRoot, modules, directory]) await fs.rmdir(dir);
  });
  await fs.writeFile(entry, "");
  await fs.writeFile(outside, "");
  const manifest = validateManagedManifest({ id: "fixture", kind: "npm", package: "fixture", version: "1.2.3",
    allowedAgents: [persona], allowedRooms: [room] });
  assert.equal(manifest.kind, "npm");
  await fs.writeFile(metadata, JSON.stringify({ name: "fixture", version: "1.2.3", bin: "./mcp.js" }));
  assert.deepEqual(await managedLocalLaunch(manifest, directory), { command: process.execPath, args: [await fs.realpath(entry)] });
  await fs.writeFile(metadata, JSON.stringify({ name: "fixture", version: "1.2.3", bin: "../outside.js" }));
  await assert.rejects(managedLocalLaunch(manifest, directory), /超出安装目录/);
});
