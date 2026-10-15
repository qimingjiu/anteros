import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { McpManager } from "../src/tools/mcp.js";

const ENV = "QQ_MCP_HEADER_ENV_TEST_AUTHORIZATION";
const SECRET = "Bearer fixture-credential-never-log";

function withEnv(t: TestContext, value?: string) {
  const previous = process.env[ENV];
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  });
}

function load(servers: Record<string, unknown>[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qq-mcp-header-env-"));
  const filename = path.join(directory, "config.yaml");
  fs.writeFileSync(filename, YAML.stringify({ model: { provider: "mock" },
    gateway: { onebot: { endpoint: "ws://localhost:3001" } },
    tools: { mcp: { enabled: true, servers } } }));
  try { return loadConfig(filename).tools.mcp; }
  finally { fs.unlinkSync(filename); fs.rmdirSync(directory); }
}

const remote = { name: "fixture", transport: "http", url: "https://example.invalid/mcp" };

test("MCP工具白名单：HTTP与stdio均保留精确名称，空白名单不回退为全部开放", () => {
  const config=load([{...remote,allow_tools:["list_voices"]},
    {name:"local",transport:"stdio",command:"node",allow_tools:[]}]);
  assert.deepEqual(config.servers[0]!.allowTools,["list_voices"]);
  assert.deepEqual(config.servers[1]!.allowTools,[]);
});

test("MCP请求头：环境变量提供完整鉴权值，并大小写不敏感地覆盖内联请求头", t => {
  withEnv(t, SECRET);
  const config = load([{ ...remote, headers: { authorization: "obsolete", "X-Client": "fixture" },
    headers_env: { Authorization: ENV } }]);
  assert.deepEqual(config.servers[0]!.headers, { Authorization: SECRET, "X-Client": "fixture" });
});

test("MCP请求头：旧HTTP内联配置、无请求头配置和stdio均继续兼容", () => {
  const config = load([{ ...remote, headers: { Authorization: "Bearer inline-fixture" } },
    { ...remote, name: "plain" }, { name: "local", transport: "stdio", command: "node", args: ["fixture.js"] }]);
  assert.deepEqual(config.servers[0]!.headers, { Authorization: "Bearer inline-fixture" });
  assert.deepEqual(config.servers[1]!.headers, {});
  assert.deepEqual(config.servers[2], { name: "local", transport: "stdio", command: "node", args: ["fixture.js"] });
});

test("MCP请求头：鉴权环境变量缺失或为空时拒绝启动，不能回落到过期内联令牌", t => {
  withEnv(t);
  const config = { ...remote, headers: { Authorization: SECRET }, headers_env: { Authorization: ENV } };
  assert.throws(() => load([config]), /headers_env.*环境变量未设置或为空/);
  process.env[ENV] = "";
  assert.throws(() => load([config]), /headers_env.*环境变量未设置或为空/);
  assert.throws(() => load([{ ...remote, headers_env: { Authorization: "" } }]), /headers_env.*环境变量未设置或为空/);
});

test("MCP请求头：内联值和环境变量映射都必须是字符串映射", () => {
  for (const key of ["headers", "headers_env"]) {
    for (const value of [null, [], "fixture", 42, { Authorization: 42 }, { Authorization: false }]) {
      assert.throws(() => load([{ ...remote, [key]: value }]), new RegExp(`${key} 必须是字符串映射`));
    }
  }
});

test("MCP请求头：拒绝非法名称以及内联换行注入，错误中不能含有凭据", () => {
  for (const key of ["headers", "headers_env"]) {
    for (const name of ["Bad Header", "Injected\r\nHeader", "", "Bad:Header"]) {
      assert.throws(() => load([{ ...remote, [key]: { [name]: SECRET } }]), error => {
        assert.match(String(error), /非法 HTTP 请求头名称/);
        assert.ok(!String(error).includes(SECRET));
        return true;
      });
    }
  }
  for (const suffix of ["\rInjected: true", "\nInjected: true", "\0"]) {
    assert.throws(() => load([{ ...remote, headers: { Authorization: SECRET + suffix } }]), error => {
      assert.match(String(error), /非法 HTTP 请求头值/);
      assert.ok(!String(error).includes(SECRET));
      return true;
    });
  }
});

test("MCP请求头：环境变量中的非法请求头值也在启动前拒绝且不泄露", t => {
  withEnv(t, SECRET + "\r\nInjected: true");
  assert.throws(() => load([{ ...remote, headers_env: { Authorization: ENV } }]), error => {
    assert.match(String(error), /headers_env.*非法 HTTP 请求头值/);
    assert.ok(!String(error).includes(SECRET));
    return true;
  });
});

test("MCP请求头：环境鉴权从配置真正进入HTTP初始化和工具发现请求", async t => {
  withEnv(t, SECRET);
  const received: { method: string; authorization?: string; client?: string }[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string };
      received.push({ method: rpc.method, authorization: req.headers.authorization, client: req.headers["x-client"] as string });
      if (rpc.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      const result = rpc.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : { tools: [] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = load([{ ...remote, url: `http://127.0.0.1:${address.port}/mcp`,
    headers: { "X-Client": "fixture" }, headers_env: { Authorization: ENV } }]);
  const mcp = new McpManager(config);
  t.after(() => mcp.stop());
  await mcp.start();
  assert.equal(mcp.statuses()[0]!.connected, true);
  assert.deepEqual(received.map(request => request.method), ["initialize", "notifications/initialized", "tools/list"]);
  assert.ok(received.every(request => request.authorization === SECRET && request.client === "fixture"));
});
