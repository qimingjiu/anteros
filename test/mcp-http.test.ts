import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { McpManager } from "../src/tools/mcp.js";
import type { McpServerConfig } from "../src/config.js";

interface Rpc {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

async function endpoint(t: TestContext, handle: (body: Rpc, req: IncomingMessage, res: ServerResponse) => Promise<void> | void) {
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Rpc;
      await handle(body, req, res);
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/mcp`;
}

function json(res: ServerResponse, id: number, result: unknown, headers: Record<string, string> = {}) {
  res.writeHead(200, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function initialized(res: ServerResponse) { res.writeHead(202); res.end(); }
const info = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
const echo = { name: "echo", description: "Fixture echo", inputSchema: { type: "object", properties: { value: { type: "string" } } } };

test("MCP工具白名单：只暴露精确允许项，后续新增生成工具不可进入模型工具集合", async t => {
  const calls:string[]=[];
  const url=await endpoint(t,(body,_req,res)=>{
    if(body.method==="notifications/initialized"){initialized(res);return;}
    if(body.method==="initialize"){json(res,body.id!,info);return;}
    if(body.method==="tools/list"){json(res,body.id!,{tools:["list_voices","text_to_audio","list_voices_paid","future_generator"].map(name=>({...echo,name}))});return;}
    calls.push(String(body.params?.name));json(res,body.id!,{content:[{type:"text",text:"readonly fixture"}]});
  });
  const mcp=new McpManager({enabled:true,connectTimeoutMs:1000,callTimeoutMs:1000,
    servers:[{name:"restricted",transport:"http",url,allowTools:["list_voices"]},{name:"empty",transport:"http",url,allowTools:[]}]});
  t.after(()=>mcp.stop());await mcp.start();
  assert.deepEqual(mcp.getTools().map(tool=>tool.name),["mcp__restricted__list_voices"]);
  await mcp.getTools()[0]!.execute({},{accountId:"fixture",isPrivate:true});
  assert.deepEqual(calls,["list_voices"]);
});

function manager(t: TestContext, url: string, settings: { timeout?: number; headers?: Record<string, string>; name?: string } = {}) {
  const server: McpServerConfig = { name: settings.name ?? "fixture", transport: "http", url, headers: settings.headers };
  const instance = new McpManager({ enabled: true, connectTimeoutMs: settings.timeout ?? 1000,
    callTimeoutMs: settings.timeout ?? 1000, servers: [server] });
  t.after(() => instance.stop());
  return instance;
}

test("MCP HTTP：JSON 会话、协商协议头和分页工具定义都保留", async t => {
  const requests: { body: Rpc; session?: string; protocol?: string; client?: string }[] = [];
  const url = await endpoint(t, (body, req, res) => {
    requests.push({ body, session: req.headers["mcp-session-id"] as string | undefined,
      protocol: req.headers["mcp-protocol-version"] as string | undefined, client: req.headers["x-fixture"] as string | undefined });
    if (body.method === "initialize") json(res, body.id!, info, { "mcp-session-id": "fixture-session" });
    else if (body.method === "notifications/initialized") initialized(res);
    else if (body.method === "tools/list" && !body.params?.cursor) json(res, body.id!, { tools: [echo], nextCursor: "second-page" });
    else if (body.method === "tools/list") json(res, body.id!, { tools: [{ ...echo, name: "second" }] });
    else json(res, body.id!, { content: [{ type: "text", text: String((body.params?.arguments as { value: string }).value) }] });
  });
  const mcp = manager(t, url, { headers: { "x-fixture": "client-marker" } });
  await mcp.start();
  assert.equal(mcp.statuses()[0]!.connected, true);
  assert.deepEqual(mcp.getTools().map(tool => tool.name), ["mcp__fixture__echo", "mcp__fixture__second"]);
  assert.deepEqual(mcp.getTools()[0]!.inputSchema, echo.inputSchema);
  assert.equal(await mcp.getTools()[0]!.execute({ value: "expected echo" }, { accountId: "acct", isPrivate: true }), "expected echo");
  assert.ok(requests.every(request => request.client === "client-marker"));
  assert.ok(requests.slice(1).every(request => request.session === "fixture-session" && request.protocol === "2025-06-18"));
  assert.equal(requests.filter(request => request.body.method === "tools/list").length, 2);
});

test("MCP HTTP：未关闭的 SSE 按匹配 id 及时结束，兼容分块 UTF8、多行 data 与 CRLF", async t => {
  let cancelledStreams = 0;
  let allStreamsClosed!: () => void;
  const streamsClosed = new Promise<void>(resolve => { allStreamsClosed = resolve; });
  const url = await endpoint(t, (body, _req, res) => {
    if (body.method === "notifications/initialized") { initialized(res); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.on("close", () => { cancelledStreams++; if (cancelledStreams === 2) allStreamsClosed(); });
    res.write(": keepalive\r\n\r\nevent: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\r\n\r\n");
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 9999, result: {} })}\r\n\r\n`);
    const result = body.method === "initialize" ? info : { tools: [{ ...echo, description: "分块中文工具" }] };
    const data = JSON.stringify({ jsonrpc: "2.0", id: body.id, result }, null, 2);
    const bytes = Buffer.from(data.split("\n").map(line => `data: ${line}`).join("\r\n") + "\r\n\r\n");
    for (let start = 0; start < bytes.length; start += 7) res.write(bytes.subarray(start, start + 7));
    // 故意保持连接开放：客户端不能等待 resp.text() 完成。
  });
  const mcp = manager(t, url);
  await mcp.start();
  assert.equal(mcp.statuses()[0]!.connected, true);
  assert.equal(mcp.getTools()[0]!.description, "[MCP:fixture] 分块中文工具");
  await mcp.stop();
  let deadline!: NodeJS.Timeout;
  try {
    await Promise.race([streamsClosed, new Promise<void>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("SSE reader 未关闭")), 1000);
    })]);
  } finally { clearTimeout(deadline); }
  assert.equal(cancelledStreams, 2);
});

test("MCP HTTP：初始化响应头迟迟未到时遵守连接超时", async t => {
  const url = await endpoint(t, () => {});
  const mcp = manager(t, url, { timeout: 80 });
  const start = Date.now();
  await mcp.start();
  assert.ok(Date.now() - start < 1500, "不能等待硬编码的六十秒");
  assert.equal(mcp.statuses()[0]!.connected, false);
  assert.match(mcp.statuses()[0]!.error!, /请求超时\(80ms\)/);
});

test("MCP HTTP：SSE 正文停止发送时同样遵守连接超时", async t => {
  const url = await endpoint(t, (_body, _req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": no RPC response yet\n\n");
  });
  const mcp = manager(t, url, { timeout: 80 });
  await mcp.start();
  assert.equal(mcp.statuses()[0]!.connected, false);
  assert.match(mcp.statuses()[0]!.error!, /请求超时\(80ms\)/);
});

test("MCP HTTP：initialized 通知等待也有超时，失败不残留已连接状态", async t => {
  const url = await endpoint(t, (body, _req, res) => {
    if (body.method === "initialize") json(res, body.id!, info);
    // notifications/initialized 故意不返回。
  });
  const mcp = manager(t, url, { timeout: 80 });
  await mcp.start();
  assert.equal(mcp.statuses()[0]!.connected, false);
  assert.equal(mcp.getTools().length, 0);
  assert.match(mcp.statuses()[0]!.error!, /请求超时\(80ms\)/);
});

test("MCP HTTP：并发 RPC 响应乱序时，各调用获得自己的结果", async t => {
  const url = await endpoint(t, (body, _req, res) => {
    if (body.method === "initialize") json(res, body.id!, info);
    else if (body.method === "notifications/initialized") initialized(res);
    else if (body.method === "tools/list") json(res, body.id!, { tools: [echo] });
    else {
      const args = body.params?.arguments as { value: string; delay: number };
      const timer = setTimeout(() => json(res, body.id!, { content: [{ type: "text", text: args.value }] }), args.delay);
      res.on("close", () => clearTimeout(timer));
    }
  });
  const mcp = manager(t, url);
  await mcp.start();
  const tool = mcp.getTools()[0]!;
  const ctx = { accountId: "acct", isPrivate: true };
  const results = await Promise.all([tool.execute({ value: "first", delay: 30 }, ctx), tool.execute({ value: "second", delay: 5 }, ctx)]);
  assert.deepEqual(results, ["first", "second"]);
});

test("MCP HTTP：JSON 响应 id 不匹配时拒绝初始化，而非使用其他请求的结果", async t => {
  const url = await endpoint(t, (body, _req, res) => json(res, body.id! + 100, info));
  const mcp = manager(t, url);
  await mcp.start();
  assert.equal(mcp.statuses()[0]!.connected, false);
  assert.match(mcp.statuses()[0]!.error!, /匹配的 RPC id/);
  assert.equal(mcp.getTools().length, 0);
});

test("MCP HTTP：重复分页游标被拒绝，不无限请求或发布不完整工具列表", async t => {
  let pages = 0;
  const url = await endpoint(t, (body, _req, res) => {
    if (body.method === "initialize") json(res, body.id!, info);
    else if (body.method === "notifications/initialized") initialized(res);
    else { pages++; json(res, body.id!, { tools: [echo], nextCursor: "repeated" }); }
  });
  const mcp = manager(t, url);
  await mcp.start();
  assert.equal(pages, 2);
  assert.equal(mcp.getTools().length, 0);
  assert.match(mcp.statuses()[0]!.error!, /分页游标重复/);
});

test("MCP HTTP：鉴权错误保存可诊断状态，URL 和查询密钥不出现在错误里", async t => {
  const secret = "fixture-secret-never-log";
  let target = "";
  let requests = 0;
  const url = await endpoint(t, (_body, _req, res) => {
    requests++;
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end(`Unauthorized ${target}; credential=${secret}`);
  });
  target = `${url}?key=${secret}`;
  const mcp = manager(t, target);
  await mcp.start();
  assert.equal(requests, 1);
  assert.equal(mcp.statuses()[0]!.connected, false);
  assert.match(mcp.statuses()[0]!.error!, /HTTP 401/);
  assert.ok(!mcp.statuses()[0]!.error!.includes(secret));
  assert.ok(!mcp.statuses()[0]!.error!.includes(target));
});

async function sessionFixture(t: TestContext, timeout = 1000, serverName = "cn-scraper") {
  const requests: { method: string; name?: string; session?: string; keyword?: string }[] = [];
  const state = {
    generation: 0, expired: false, executed: 0,
    initialize: undefined as ((generation: number, body: Rpc, res: ServerResponse) => void | Promise<void>) | undefined,
    tool: undefined as ((body: Rpc, session: string | undefined, res: ServerResponse) => void | Promise<void>) | undefined,
  };
  const search = { name: "taobao_search", description: "Readonly fixture search", inputSchema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] } };
  const tools = [search, { ...search, name: "taxi_create_order" }, { ...search, name: "post_comment" },
    ...["dianping_search", "dianping_shop", "dianping_reviews"].map(name => ({ ...search, name }))];
  const url = await endpoint(t, async (body, req, res) => {
    const session = req.headers["mcp-session-id"] as string | undefined;
    const args = body.params?.arguments as { keyword?: string } | undefined;
    requests.push({ method: body.method, name: body.params?.name as string | undefined, session, keyword: args?.keyword });
    if (body.method === "initialize") {
      const generation = ++state.generation;
      if (state.initialize) await state.initialize(generation, body, res);
      else json(res, body.id!, info, { "mcp-session-id": `session-${generation}` });
    } else if (body.method === "notifications/initialized") initialized(res);
    else if (body.method === "tools/list") json(res, body.id!, { tools });
    else if (state.tool) await state.tool(body, session, res);
    else if (state.expired && session === "session-1") { res.writeHead(404); res.end("Session not found"); }
    else {
      state.executed++;
      json(res, body.id!, { content: [{ type: "text", text: args?.keyword ?? "fixture result" }] });
    }
  });
  const mcp = manager(t, url, { timeout, name: serverName });
  await mcp.start();
  assert.equal(mcp.statuses()[0]!.connected, true);
  const tool = (name = "taobao_search") => mcp.getTools().find(value => value.name.endsWith(`__${name}`))!;
  const ctx = { accountId: "acct", requesterId: "owner", isPrivate: true };
  return { mcp, requests, state, tool, ctx };
}

test("MCP HTTP：明确的会话404使只读查询重新初始化一次并重试，初始化不带旧ID", async t => {
  const f = await sessionFixture(t);
  f.state.expired = true;
  assert.equal(await f.tool().execute({ keyword: "one" }, f.ctx), "one");
  assert.equal(f.state.generation, 2);
  assert.equal(f.state.executed, 1);
  assert.deepEqual(f.requests.filter(request => request.method === "initialize").map(request => request.session), [undefined, undefined]);
  assert.deepEqual(f.requests.filter(request => request.method === "tools/call").map(request => request.session), ["session-1", "session-2"]);
  assert.equal(f.mcp.statuses()[0]!.connected, true);
  assert.equal(f.mcp.statuses()[0]!.error, undefined);
});

test("MCP HTTP：点评搜索、商户详情和评价只读调用均可在会话404后恢复并重试", async t => {
  for (const name of ["dianping_search", "dianping_shop", "dianping_reviews"]) {
    const f = await sessionFixture(t);
    f.state.expired = true;
    assert.equal(await f.tool(name).execute({ keyword: "fixture" }, f.ctx), "fixture");
    assert.equal(f.state.generation, 2);
    assert.equal(f.state.executed, 1);
    assert.equal(f.requests.filter(request => request.method === "tools/call").length, 2);
    assert.equal(f.mcp.statuses()[0]!.connected, true);
  }
});

test("MCP HTTP：恢复中的新并发查询加入同一次初始化，而非因connected=false被拒绝", async t => {
  const f = await sessionFixture(t);
  f.state.expired = true;
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.state.initialize = async (generation, body, res) => {
    signalStarted();
    await held;
    json(res, body.id!, info, { "mcp-session-id": `session-${generation}` });
  };
  const first = f.tool().execute({ keyword: "first" }, f.ctx);
  await started;
  assert.equal(f.mcp.statuses()[0]!.connected, false);
  const second = f.tool().execute({ keyword: "second" }, f.ctx);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(f.state.generation, 2);
  assert.equal(f.state.executed, 2);
  assert.equal(f.requests.filter(request => request.method === "tools/call" && request.session === "session-1").length, 1);
});

test("MCP HTTP：旧会话迟到的404不会再次刷新已恢复的新会话", async t => {
  const f = await sessionFixture(t);
  f.state.tool = (body, session, res) => {
    const keyword = (body.params?.arguments as { keyword: string }).keyword;
    if (session === "session-1") {
      const timer = setTimeout(() => { res.writeHead(404); res.end("Session not found"); }, keyword === "late" ? 60 : 0);
      res.on("close", () => clearTimeout(timer));
    } else {
      f.state.executed++;
      json(res, body.id!, { content: [{ type: "text", text: keyword }] });
    }
  };
  const results = await Promise.all([f.tool().execute({ keyword: "fast" }, f.ctx), f.tool().execute({ keyword: "late" }, f.ctx)]);
  assert.deepEqual(results, ["fast", "late"]);
  assert.equal(f.state.generation, 2);
  assert.equal(f.state.executed, 2);
  assert.equal(f.mcp.statuses()[0]!.connected, true);
});

test("MCP HTTP：刷新失败诚实报告断开，下次授权的新查询仍能重新连接", async t => {
  const f = await sessionFixture(t);
  f.state.expired = true;
  f.state.initialize = (generation, body, res) => {
    if (generation === 2) { res.writeHead(503); res.end("fixture unavailable"); }
    else json(res, body.id!, info, { "mcp-session-id": `session-${generation}` });
  };
  await assert.rejects(f.tool().execute({ keyword: "first" }, f.ctx), /503/);
  assert.equal(f.state.executed, 0);
  assert.equal(f.mcp.statuses()[0]!.connected, false);
  assert.match(f.mcp.statuses()[0]!.error!, /503/);
  assert.equal(await f.tool().execute({ keyword: "new user request" }, f.ctx), "new user request");
  assert.equal(f.state.generation, 3);
  assert.equal(f.state.executed, 1);
  assert.equal(f.mcp.statuses()[0]!.connected, true);
  assert.equal(f.mcp.statuses()[0]!.error, undefined);
});

test("MCP HTTP：一次重试仍被会话404拒绝时停止，不能无限刷新或重放", async t => {
  const f = await sessionFixture(t);
  f.state.tool = (_body, _session, res) => { res.writeHead(404); res.end("Session not found"); };
  await assert.rejects(f.tool().execute({ keyword: "one" }, f.ctx), /会话已过期/);
  assert.equal(f.state.generation, 2);
  assert.equal(f.requests.filter(request => request.method === "tools/call").length, 2);
  assert.equal(f.mcp.statuses()[0]!.connected, false);
});

test("MCP HTTP：下单和未知写操作遇明确会话404也只恢复连接，不自动重放动作", async t => {
  for (const name of ["taxi_create_order", "post_comment"]) {
    const f = await sessionFixture(t);
    f.state.expired = true;
    await assert.rejects(f.tool(name).execute({ keyword: "mutation fixture" }, f.ctx), /未自动重试/);
    assert.equal(f.state.generation, 2);
    assert.equal(f.state.executed, 0);
    assert.equal(f.requests.filter(request => request.method === "tools/call").length, 1);
    assert.equal(f.mcp.statuses()[0]!.connected, true, "会话可恢复，但动作不会重放");
  }
});

test("MCP HTTP：其他MCP服务器的同名搜索工具不继承cn-scraper只读重试许可", async t => {
  const f = await sessionFixture(t, 1000, "another-server");
  f.state.expired = true;
  await assert.rejects(f.tool().execute({ keyword: "same tool name" }, f.ctx), /未自动重试/);
  assert.equal(f.state.generation, 2);
  assert.equal(f.state.executed, 0);
  assert.equal(f.requests.filter(request => request.method === "tools/call").length, 1);
  assert.equal(f.mcp.statuses()[0]!.connected, true);
});

test("MCP HTTP：普通404、500以及网站登录业务错误都不能触发自动重放", async t => {
  for (const [status, text] of [[404, "Not Found"], [500, "Session not found"]] as const) {
    const f = await sessionFixture(t);
    f.state.tool = (_body, _session, res) => { res.writeHead(status); res.end(text); };
    await assert.rejects(f.tool().execute({ keyword: "one" }, f.ctx), new RegExp(`HTTP ${status}`));
    assert.equal(f.state.generation, 1);
    assert.equal(f.requests.filter(request => request.method === "tools/call").length, 1);
    assert.equal(f.mcp.statuses()[0]!.connected, false);
  }
  const business = await sessionFixture(t);
  business.state.tool = (body, _session, res) => json(res, body.id!, { isError: true, content: [{ type: "text", text: "Website login required" }] });
  await assert.rejects(business.tool().execute({ keyword: "one" }, business.ctx), /Website login required/);
  assert.equal(business.state.generation, 1);
  assert.equal(business.mcp.statuses()[0]!.connected, true, "网站登录失败不等同MCP会话断开");
});

test("MCP HTTP：cn-scraper JSON业务错误拒绝假成功，保留连接且不重新初始化或重放", async t => {
  for (const output of [
    { ok: false, error: { code: "COOKIE_EXPIRED", message: "登录态被拒绝", retryable: false } },
    { keyword: "fixture", error: "知乎搜索需要登录", hint: "请检查接口和登录态" },
  ]) {
    const f = await sessionFixture(t);
    f.state.tool = (body, _session, res) => json(res, body.id!, {
      content: [{ type: "text", text: JSON.stringify(output) }],
    });
    await assert.rejects(f.tool().execute({ keyword: "fixture" }, f.ctx), /cn-scraper 网站工具失败/);
    assert.equal(f.state.generation, 1);
    assert.equal(f.requests.filter(request => request.method === "tools/call").length, 1);
    assert.equal(f.mcp.statuses()[0]!.connected, true);
    assert.equal(f.mcp.statuses()[0]!.error, undefined);
  }
});

test("MCP HTTP：cn-scraper正常结果与其他服务JSON不被业务错误规则误判", async t => {
  for (const [serverName, output] of [
    ["cn-scraper", { keyword: "fixture", items: [], count: 0 }],
    ["cn-scraper", { ok: true, error: null, items: [{ error: "文档中的文本" }] }],
    ["another-server", { error: "合法的该服务业务数据" }],
  ] as const) {
    const f = await sessionFixture(t, 1000, serverName);
    const text = JSON.stringify(output);
    f.state.tool = (body, _session, res) => json(res, body.id!, { content: [{ type: "text", text }] });
    assert.equal(await f.tool().execute({ keyword: "fixture" }, f.ctx), text);
    assert.equal(f.mcp.statuses()[0]!.connected, true);
  }
});

test("MCP HTTP：会话刷新与重试共享原调用期限，刷新挂起不会额外等待完整超时", async t => {
  const f = await sessionFixture(t, 100);
  f.state.tool = (_body, _session, res) => {
    const timer = setTimeout(() => { res.writeHead(404); res.end("Session not found"); }, 50);
    res.on("close", () => clearTimeout(timer));
  };
  f.state.initialize = () => {};
  const start = Date.now();
  await assert.rejects(f.tool().execute({ keyword: "one" }, f.ctx), /请求超时\(100ms\)|协议会话恢复超时/);
  assert.ok(Date.now() - start < 500);
  assert.equal(f.state.generation, 2);
  assert.equal(f.state.executed, 0);
  assert.equal(f.mcp.statuses()[0]!.connected, false);
});
