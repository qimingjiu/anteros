import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createMusicBuiltin, type MusicBuiltin } from "../src/tools/music-builtin.js";
import { createMusicRpcHandler, runMusicServer } from "../src/tools/music-server.js";
import { McpManager } from "../src/tools/mcp.js";

const neSong = { id: 101, name: "网易歌曲", artists: [{ name: "歌手甲" }, { name: "歌手乙" }] };
const neResult = () => ({ code: 200, result: { songs: [neSong] } });
const jamendoTrack = {
  id: "202", name: "开放歌曲", artist_name: "CC musician", shareurl: "https://www.jamendo.com/track/202",
  audio: "https://audio.test/jamendo.mp3", audiodownload: "https://audio.test/jamendo-download.mp3",
  license_ccurl: "https://creativecommons.org/licenses/by/4.0/",
};
const jamendoResult = () => ({ headers: { status: "success" }, results: [jamendoTrack] });
const ccResult = () => [{
  upload_id: 303, upload_name: "混音", user_name: "mixer", user_real_name: "混音者", file_page_url: "https://ccmixter.org/files/mixer/303",
  files: [{ file_nicname: "wav", download_url: "https://audio.test/cc.wav" }, { file_nicname: "mp3", download_url: "https://audio.test/cc.mp3" }],
}];
const rpc = (id: number, method: string, params?: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method, params });

function musicFixture() {
  const data: { netease: unknown; jamendo: unknown; cc: unknown } = { netease: neResult(), jamendo: jamendoResult(), cc: ccResult() };
  const calls: { source: string; url: string; init?: RequestInit }[] = [];
  const builtin = createMusicBuiltin({
    jamendoClientId: "fixture-client-id",
    fetch: (async (input, init) => {
      const url = String(input);
      const source = url.includes("music.163.com") ? "netease" : "jamendo";
      calls.push({ source, url, init });
      const value = data[source];
      if (value instanceof Error) throw value;
      return new Response(JSON.stringify(value));
    }) as typeof fetch,
    getJson: async url => {
      calls.push({ source: "cc", url });
      if (data.cc instanceof Error) throw data.cc;
      return data.cc;
    },
  });
  return { data, calls, builtin };
}

test("Music builtin：保留三源搜索和紧凑信封，规范页面/播放链接与CC许可", async () => {
  const f = musicFixture();
  const result = JSON.parse(await f.builtin.call("search", { query: " song / artist ", limit: 3 }));
  assert.equal(result.status, "music");
  assert.equal(result.action, "search");
  assert.deepEqual(result.songs.map((s: any) => s.source), ["netease", "ccmixter", "jamendo"]);
  assert.deepEqual(result.songs[0], {
    id: 101, title: "网易歌曲", artist: "歌手甲/歌手乙", source: "netease",
    pageUrl: "https://music.163.com/song?id=101", playUrl: "https://music.163.com/song/media/outer/url?id=101.mp3",
  });
  assert.equal(result.songs[1].playUrl, "https://audio.test/cc.mp3");
  assert.equal(result.songs[2].playUrl, jamendoTrack.audio);
  assert.equal(result.songs[2].licenseUrl, jamendoTrack.license_ccurl);
  assert.deepEqual(f.calls.map(c => c.source), ["netease", "cc", "jamendo"]);
  const ne = f.calls[0]!;
  assert.equal(ne.init?.method, "POST");
  const form = new URLSearchParams(String(ne.init?.body));
  assert.ok(form.get("params"), "网易保留 weapi 双层 AES 加密");
  assert.match(form.get("encSecKey")!, /^[a-f0-9]{256}$/, "网易保留 RSA 密钥字段");
  assert.equal(new URL(f.calls[2]!.url).searchParams.get("client_id"), "fixture-client-id");
  assert.equal(new URL(f.calls[2]!.url).searchParams.get("search"), "song / artist");
});

test("Music builtin：一个平台失败不会丢失其他平台的结果", async () => {
  const f = musicFixture();
  f.data.netease = new Error("fixture NetEase unavailable");
  f.data.cc = new Error("fixture ccMixter unavailable");
  const result = JSON.parse(await f.builtin.call("search", { query: "demo" }));
  assert.deepEqual(result.songs.map((s: any) => s.source), ["jamendo"]);
  assert.equal(f.calls.length, 3);
});

test("Music builtin：搜索会同时发起三源请求，而不是等待逐个结束", async () => {
  const started: string[] = [];
  const gates = new Map<string, (value: any) => void>();
  const builtin = createMusicBuiltin({
    jamendoClientId: "fixture-id",
    fetch: (async input => {
      const source = String(input).includes("music.163.com") ? "netease" : "jamendo";
      started.push(source);
      return new Promise<Response>(resolve => gates.set(source, resolve));
    }) as typeof fetch,
    getJson: async () => {
      started.push("cc");
      return new Promise(resolve => gates.set("cc", resolve));
    },
  });
  const pending = builtin.call("search", { query: "demo" });
  assert.deepEqual(started, ["netease", "cc", "jamendo"]);
  gates.get("netease")!(new Response(JSON.stringify(neResult())));
  gates.get("jamendo")!(new Response(JSON.stringify(jamendoResult())));
  gates.get("cc")!(ccResult());
  assert.equal(JSON.parse(await pending).songs.length, 3);
});

test("Music builtin：play先选网易，返回候选链接而不下载或发送音频", async () => {
  const f = musicFixture();
  const result = JSON.parse(await f.builtin.call("play", { query: "demo" }));
  assert.equal(result.action, "play");
  assert.equal(result.songs.length, 1);
  assert.equal(result.songs[0].source, "netease");
  assert.deepEqual(f.calls.map(c => c.source), ["netease"]);
  assert.match(f.builtin.tools.find(t => t.name === "play")!.description, /not guaranteed|Does not itself send/);
});

test("Music builtin：网易空结果时继续Jamendo，不再把空播放信封当成功", async () => {
  const f = musicFixture();
  f.data.netease = { code: 200, result: { songs: [] } };
  const result = JSON.parse(await f.builtin.call("play", { query: "demo" }));
  assert.equal(result.songs[0].source, "jamendo");
  assert.deepEqual(f.calls.map(c => c.source), ["netease", "jamendo"]);
});

test("Music builtin：网易异常和Jamendo空结果时继续ccMixter", async () => {
  const f = musicFixture();
  f.data.netease = new Error("fixture network error");
  f.data.jamendo = { headers: { status: "success" }, results: [] };
  const result = JSON.parse(await f.builtin.call("play", { query: "demo" }));
  assert.equal(result.songs[0].source, "ccmixter");
  assert.deepEqual(f.calls.map(c => c.source), ["netease", "jamendo", "cc"]);
});

test("Music builtin：没有结果明确报错，空查询和过长查询不访问公网", async () => {
  const f = musicFixture();
  await assert.rejects(f.builtin.call("search", { query: " " }), /query required/);
  await assert.rejects(f.builtin.call("play", { query: "x".repeat(301) }), /query too long/);
  assert.equal(f.calls.length, 0);
  f.data.netease = { code: 200, result: { songs: [] } };
  f.data.jamendo = { headers: { status: "success" }, results: [] };
  f.data.cc = [];
  await assert.rejects(f.builtin.call("search", { query: "nonexistent" }), /all sources failed/);
  await assert.rejects(f.builtin.call("play", { query: "nonexistent" }), /no results/);
});

test("Music builtin：数量范围规范化，结果总数封顶10且JSON始终完整", async () => {
  const f = musicFixture();
  f.data.netease = { code: 200, result: { songs: Array.from({ length: 30 }, (_, i) => ({ ...neSong, id: i })) } };
  const many = JSON.parse(await f.builtin.call("search", { query: "demo", limit: 50_000 }));
  assert.equal(many.songs.length, 10);
  assert.equal(new URL(f.calls.find(c => c.source === "jamendo")!.url).searchParams.get("limit"), "10");
  f.calls.length = 0;
  const low = JSON.parse(await f.builtin.call("search", { query: "demo", limit: -3 }));
  assert.equal(low.songs.filter((s: any) => s.source === "netease").length, 1);
  assert.equal(new URL(f.calls.find(c => c.source === "cc")!.url).searchParams.get("limit"), "1");
});

test("Music MCP：initialize版本协商、tools/list与初始化通知，原工具名不变", async () => {
  const f = musicFixture();
  const handle = createMusicRpcHandler(f.builtin);
  for (const version of ["2024-11-05", "2025-03-26", "2025-06-18"]) {
    const initialized = await handle(rpc(1, "initialize", { protocolVersion: version }));
    assert.equal(initialized?.result?.protocolVersion, version);
    assert.deepEqual(initialized?.result?.capabilities, { tools: {} });
  }
  assert.equal((await handle(rpc(1, "initialize", { protocolVersion: "unsupported" })))?.result?.protocolVersion, "2024-11-05");
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  const listed = await handle(rpc(2, "tools/list"));
  const tools = listed?.result?.tools as MusicBuiltin["tools"];
  assert.deepEqual(tools.map(t => t.name), ["search", "play"]);
  assert.deepEqual(tools[0]!.inputSchema.required, ["query"]);
  assert.equal(f.calls.length, 0, "列工具不触发音乐搜索");
});

test("Music MCP：tools/call输出合法文本信封，工具异常标isError", async () => {
  const f = musicFixture();
  const handle = createMusicRpcHandler(f.builtin);
  const called = await handle(rpc(3, "tools/call", { name: "search", arguments: { query: "demo" } }));
  assert.equal(called?.error, undefined);
  const content = called?.result?.content as { type: string; text: string }[];
  assert.equal(content[0]!.type, "text");
  assert.equal(JSON.parse(content[0]!.text).songs.length, 3);
  const invalid = await handle(rpc(4, "tools/call", { name: "search", arguments: { query: "" } }));
  assert.equal(invalid?.result?.isError, true);
  assert.match((invalid?.result?.content as any)[0].text, /query required/);
});

test("Music MCP：拒绝未知方法、未知工具、非法RPC和非对象参数，不执行工具", async () => {
  const f = musicFixture();
  const handle = createMusicRpcHandler(f.builtin);
  assert.equal((await handle(rpc(1, "unknown")))?.error?.code, -32601);
  assert.equal((await handle(rpc(2, "tools/call", { name: "fetch_any_url", arguments: { url: "https://test" } })))?.error?.code, -32602);
  assert.equal((await handle(rpc(3, "tools/call", { name: "search", arguments: [] })))?.error?.code, -32602);
  assert.equal((await handle(rpc(4, "tools/call", {})))?.error?.code, -32602);
  assert.equal((await handle({ jsonrpc: "2.0", id: {}, method: "tools/list" }))?.error?.code, -32600);
  assert.equal((await handle(null))?.error?.code, -32600);
  assert.equal(f.calls.length, 0);
});

test("Music MCP：工具错误脱敏Jamendo client id", async t => {
  const previous = process.env.JAMENDO_CLIENT_ID;
  process.env.JAMENDO_CLIENT_ID = "fixture-secret-client-id";
  t.after(() => { if (previous === undefined) delete process.env.JAMENDO_CLIENT_ID; else process.env.JAMENDO_CLIENT_ID = previous; });
  const builtin: MusicBuiltin = {
    tools: [{ name: "search", description: "fixture", inputSchema: { type: "object" } }],
    call: async () => { throw new Error("fixture request failed client_id=fixture-secret-client-id"); },
  };
  const reply = await createMusicRpcHandler(builtin)(rpc(1, "tools/call", { name: "search" }));
  assert.equal(reply?.result?.isError, true);
  assert.doesNotMatch(JSON.stringify(reply), /fixture-secret-client-id/);
  assert.match(JSON.stringify(reply), /redacted/);
});

test("Music MCP：stdio处理逐行请求和解析错误，通知不输出，EOF正常结束", async () => {
  const input = Readable.from([
    JSON.stringify(rpc(1, "initialize")) + "\n",
    '{broken-json}\n',
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    JSON.stringify(rpc(2, "tools/list")) + "\n",
    JSON.stringify(rpc(3, "tools/call", { name: "play", arguments: { query: "demo" } })) + "\n",
  ]);
  let raw = "";
  const output = new Writable({ write(chunk, _encoding, done) { raw += String(chunk); done(); } });
  await runMusicServer(input, output, musicFixture().builtin);
  const replies = raw.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(replies.map(r => r.id), [1, null, 2, 3]);
  assert.equal(replies[1].error.code, -32700);
  assert.equal(JSON.parse(replies[3].result.content[0].text).action, "play");
});

test("Music MCP：正常导入后可被现有McpManager作为stdio服务器注册", async t => {
  const cli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const source = fileURLToPath(new URL("../src/tools/music-server.ts", import.meta.url));
  const manager = new McpManager({
    enabled: true, connectTimeoutMs: 5000, callTimeoutMs: 5000,
    servers: [{ name: "music", transport: "stdio", command: process.execPath, args: [cli, source] }],
  });
  t.after(async () => manager.stop());
  await manager.start();
  assert.equal(manager.statuses()[0]?.connected, true);
  assert.equal(manager.statuses()[0]?.tools, 2);
  assert.deepEqual(manager.getTools().map(tool => tool.name), ["mcp__music__search", "mcp__music__play"]);
  await assert.rejects(manager.getTools()[0]!.execute({ query: "" }, { accountId: "fixture", isPrivate: true }), /query required/);
});

test("Music MCP：独立进程只输出JSON协议，stdin EOF结束且不触发真实搜索", async t => {
  const cli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const source = fileURLToPath(new URL("../src/tools/music-server.ts", import.meta.url));
  const child = spawn(process.execPath, [cli, source], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8").on("data", chunk => { output += chunk; });
  child.stderr.setEncoding("utf-8").on("data", chunk => { stderr += chunk; });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  child.stdin.end(JSON.stringify(rpc(1, "initialize")) + "\n" + JSON.stringify(rpc(2, "tools/list")) + "\n");
  assert.equal(await exit, 0);
  assert.equal(stderr, "");
  const messages = output.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(messages.map(message => message.id), [1, 2]);
  assert.equal(messages[1].result.tools.length, 2);
});
