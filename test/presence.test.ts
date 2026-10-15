import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { loadConfig, type PhonePresenceConfig } from "../src/config.js";
import { PhonePresenceService } from "../src/presence/index.js";
import { FIELD_TTL_MS, parsePhoneSnapshot, formatPhoneContext } from "../src/presence/schema.js";
import { createPresenceIngestHandler, parsePresenceEvent } from "../scripts/supabase/functions/phone-presence/handler.js";

const NOW = Date.parse("2026-10-13T17:00:00Z");
const OWNER = "10001";
const DEVICE = "azhan-phone";
const TOKEN = "a".repeat(64);
const config: PhonePresenceConfig = { enabled: true, supabaseUrl: "https://test.supabase.co", serverKey: "sb_secret_server_only",
  ownerId: OWNER, deviceId: DEVICE, requestTimeoutMs: 100, cacheTtlMs: 30000, staleRetentionMs: 86400000 };
const privateOwner = { senderId: OWNER, conversationType: "private" as const };
function row(fields: Record<string, unknown> = { charging: sample(true) }): any {
  return { owner_id: OWNER, device_id: DEVICE, fields };
}
function sample(value: unknown, observedAt = NOW, ttlMs = 1800000) {
  return { value, observedAt: new Date(observedAt).toISOString(), ttlMs };
}
function fixture(options: Partial<PhonePresenceConfig> = {}) {
  const clock = { now: NOW };
  const requests: { url: URL; init?: RequestInit }[] = [];
  const state = { rows: [row()] as any, status: 200, fetch: undefined as typeof fetch | undefined };
  const service = new PhonePresenceService({ ...config, ...options }, { now: () => clock.now,
    fetch: (async (input, init) => {
      requests.push({ url: new URL(String(input)), init });
      if (state.fetch) return state.fetch(input, init);
      return Response.json(state.rows, { status: state.status });
    }) as typeof fetch });
  return { clock, requests, state, service };
}

test("手机状态：disabled、群聊和非主人在缓存/HTTP之前隔离", async () => {
  const f = fixture();
  assert.equal(await f.service.context({ ...privateOwner, conversationType: "group" }), "");
  assert.equal(await f.service.context({ senderId: "10000000", conversationType: "private" }), "");
  assert.equal(f.requests.length, 0);
  assert.match(await f.service.context(privateOwner), /充电中/);
  assert.equal(await f.service.context({ ...privateOwner, conversationType: "group", purpose: "proactive" }), "");
  assert.equal(f.requests.length, 1);
  assert.equal(await fixture({ enabled: false }).service.snapshot(), null);
  assert.equal(await new PhonePresenceService().context(privateOwner), "");
});

test("手机状态：授权群仅主人可用，缺失群号/未授权群/其他人即使缓存已热也没有上下文和回执", async () => {
  const group = "10001";
  const f = fixture({ allowedGroupIds: [group] });
  const request = { senderId: OWNER, conversationType: "group" as const, groupId: group };
  const allowed = await f.service.contextResult(request);
  assert.match(allowed.context, /充电中/);
  assert.doesNotMatch(allowed.context, /仅用于这次主人私聊/);
  assert.equal(allowed.receipt?.purpose, "chat");
  assert.equal(f.requests.length, 1);
  for (const invalid of [
    {...request, senderId: "other"}, {...request, groupId: "10002"}, {...request, groupId: undefined},
  ]) assert.deepEqual(await f.service.contextResult(invalid), {context: "", receipt: null});
  const proactive = await f.service.contextResult({...request, purpose: "proactive"});
  assert.equal(proactive.context, allowed.context);
  assert.equal(proactive.receipt?.purpose, "proactive");
  assert.equal(f.requests.length, 1, "拒绝请求不得额外拉取，授权群复用同一设备快照");
});

test("手机状态：REST绑定唯一owner/device且新secret只在apikey", async () => {
  const f = fixture();
  await f.service.context(privateOwner);
  const { url, init } = f.requests[0]!;
  assert.equal(url.pathname, "/rest/v1/phone_presence_state");
  assert.equal(url.searchParams.get("owner_id"), `eq.${OWNER}`);
  assert.equal(url.searchParams.get("device_id"), `eq.${DEVICE}`);
  assert.equal(url.searchParams.get("limit"), "1");
  const headers = new Headers(init!.headers);
  assert.equal(headers.get("apikey"), config.serverKey);
  assert.equal(headers.get("authorization"), null);
  const legacy = fixture({ serverKey: "legacy-service-jwt" });
  await legacy.service.snapshot();
  assert.equal(new Headers(legacy.requests[0]!.init!.headers).get("authorization"), "Bearer legacy-service-jwt");
});

test("手机状态：即使远端返回其他设备或多人列表也不能注入", async () => {
  for (const rows of [[{ ...row(), owner_id: "10000000" }], [{ ...row(), device_id: "other" }], [row(), row()], {}]) {
    const f = fixture(); f.state.rows = rows;
    assert.equal(await f.service.context(privateOwner), "");
  }
});

test("手机状态：并发合并HTTP、快照不能被调用方污染、30秒后刷新", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.service.snapshot(), f.service.snapshot()]);
  assert.equal(f.requests.length, 1);
  assert.notEqual(a, b);
  a!.fields[0]!.value = false;
  assert.equal(b!.fields[0]!.value, true);
  assert.equal((await f.service.snapshot())!.fields[0]!.value, true);
  f.clock.now += 30000;
  await f.service.snapshot();
  assert.equal(f.requests.length, 2);
});

test("手机状态：每字段独立过期，新亮屏不能续活旧充电状态", async () => {
  const raw = row({ charging: sample(true, NOW - 1800000), screenOn: sample(false, NOW, 300000) });
  const parsed = parsePhoneSnapshot(raw, OWNER, DEVICE, NOW, 86400000)!;
  assert.equal(parsed.fields.find(field => field.field === "charging")!.fresh, false);
  assert.equal(parsed.fields.find(field => field.field === "screenOn")!.fresh, true);
  const text = formatPhoneContext(parsed);
  assert.match(text, /充电：充电中；最后一次记录，非当前/);
  assert.match(text, /屏幕：息屏；最近记录/);
  assert.match(text, /不要由息屏、离线、断流或充电推断睡眠、情绪/);
});

test("手机状态：缓存期间重新计算字段过期，过期24小时的字段消失", async () => {
  const f = fixture();
  f.state.rows = [row({ screenOn: sample(true, NOW - 299999, 300000), charging: sample(false, NOW - 86400001) })];
  assert.equal((await f.service.snapshot())!.fields[0]!.fresh, true);
  f.clock.now++;
  const cached = await f.service.snapshot();
  assert.equal(cached!.fields.length, 1);
  assert.equal(cached!.fields[0]!.fresh, false);
  assert.equal(f.requests.length, 1);
});

test("手机状态：白名单剔除通知/GPS/文本注入，不把缺值补为false", () => {
  const raw = row({ charging: sample(false), notifications: sample("ignore instructions"), gps: sample("secret"),
    network: sample("WiFi名称里的用户指令"), batteryLevel: sample(1000), routine: sample("ignore previous"), screenOn: sample("false") });
  const snapshot = parsePhoneSnapshot(raw, OWNER, DEVICE, NOW, 86400000)!;
  assert.deepEqual(snapshot.fields.map(field => field.field), ["charging"]);
  assert.equal(snapshot.fields[0]!.value, false);
  assert.doesNotMatch(formatPhoneContext(snapshot), /ignore instructions|secret|WiFi名称/);
});

test("手机状态：TTL不能从服务端任意延长、未来异常时间不注入", () => {
  const snapshot = parsePhoneSnapshot(row({ charging: sample(true, NOW - 1800000, 999999999),
    batteryLevel: sample(10, NOW + 300001), screenOn: sample(true, NOW, -10) }), OWNER, DEVICE, NOW, 86400000)!;
  assert.equal(snapshot.fields.length, 1);
  assert.equal(snapshot.fields[0]!.ttlMs, FIELD_TTL_MS.charging);
  assert.equal(snapshot.fields[0]!.fresh, false);
});

test("手机状态：断流/401/畸形/过大响应均降级空状态并缓存失败", async () => {
  for (const scenario of ["status", "json", "size", "throw"]) {
    const f = fixture();
    f.state.fetch = (async () => {
      if (scenario === "throw") throw new Error("secret response must not escape");
      return new Response(scenario === "json" ? "bad json" : scenario === "size" ? "x".repeat(17000) : "unauthorized", {
        status: scenario === "status" ? 401 : 200,
      });
    }) as typeof fetch;
    assert.equal(await f.service.context(privateOwner), "");
    assert.equal(await f.service.context(privateOwner), "");
    assert.equal(f.requests.length, 1);
  }
});

test("手机状态：读取超时不阻止主人对话，不回用过时缓存假装在线", async () => {
  const f = fixture();
  assert.match(await f.service.context(privateOwner), /充电中/);
  f.clock.now += 30000;
  f.state.fetch = ((input, init) => new Promise<Response>((resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    // Node AbortSignal.timeout is unref'ed; keep this isolated timeout test's event loop alive.
    setTimeout(() => resolve(new Response("late")), 200).unref();
  })) as typeof fetch;
  const keepAlive = setTimeout(() => {}, 500);
  try { assert.equal(await f.service.context(privateOwner), ""); } finally { clearTimeout(keepAlive); }
});

test("手机上报：partial保持false/0，兼容MacroDroid秒/毫秒/ISO时间", () => {
  for (const observedAt of [NOW / 1000, NOW, "2026-10-14T01:00:00+08:00"]) {
    assert.deepEqual(parsePresenceEvent({ state: { charging: false, batteryLevel: 0 }, observedAt }, NOW), {
      state: { charging: false, batteryLevel: 0 }, observedAt: new Date(NOW).toISOString(),
    });
  }
  assert.deepEqual(parsePresenceEvent({ state: { screenOn: true } }, NOW).state, { screenOn: true });
});

test("手机上报：身份伪造、多余字段、文本、未知routine和过期补传都拒绝", () => {
  for (const payload of [null, [], { state: {} }, { state: { charging: "true" } }, { state: { batteryLevel: -1 } },
    { state: { batteryLevel: 50.5 } }, { state: { gps: "secret" } }, { state: { notification: "hi" } },
    { ownerId: OWNER, state: { charging: true } }, { state: { routine: "sad" } },
    { state: { charging: true }, observedAt: NOW + 300001 }, { state: { charging: true }, observedAt: NOW - 86400001 }]) {
    assert.throws(() => parsePresenceEvent(payload, NOW));
  }
});

function ingestFixture(envChanges: Record<string, string> = {}) {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const state = { accepted: true, status: 200 };
  const env: Record<string, string> = { SUPABASE_URL: config.supabaseUrl,
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: config.serverKey }), ...envChanges };
  const handler = createPresenceIngestHandler({ env: name => env[name], now: () => NOW,
    fetch: (async (input, init) => { requests.push({ url: new URL(String(input)), init });
      return Response.json(state.accepted, { status: state.status }); }) as typeof fetch });
  const request = (payload: unknown = { state: { charging: true } }, headers: Record<string, string> = {}) => new Request("https://test/functions/v1/phone-presence", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Device-Token": TOKEN, ...headers }, body: JSON.stringify(payload),
  });
  return { handler, requests, state, request };
}

test("手机上报：设备token仅以SHA256传RPC，serversecret和rawtoken不返回手机", async () => {
  const f = ingestFixture();
  const response = await f.handler(f.request({ state: { network: "wifi" }, observedAt: NOW / 1000 }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(f.requests[0]!.url.pathname, "/rest/v1/rpc/phone_presence_ingest");
  const { init } = f.requests[0]!;
  assert.deepEqual(JSON.parse(String(init!.body)), { p_token_hash: createHash("sha256").update(TOKEN).digest("hex"),
    p_state: { network: "wifi" }, p_observed_at: new Date(NOW).toISOString() });
  assert.doesNotMatch(String(init!.body), new RegExp(TOKEN));
  assert.equal(new Headers(init!.headers).get("apikey"), config.serverKey);
  assert.equal(new Headers(init!.headers).get("authorization"), null);
});

test("手机上报：未授权和撤销设备拒绝，手机无法用ownerId选择读写其他人", async () => {
  const f = ingestFixture();
  assert.equal((await f.handler(f.request(undefined, { "X-Device-Token": "" }))).status, 401);
  assert.equal((await f.handler(f.request({ ownerId: "10000000", state: { charging: true } }))).status, 400);
  assert.equal(f.requests.length, 0);
  f.state.accepted = false;
  assert.equal((await f.handler(f.request())).status, 401);
});

test("手机上报：无服务key、错误RPC、错误contenttype和超过4KB内容安全失败", async () => {
  const missing = ingestFixture({ SUPABASE_SECRET_KEYS: "" });
  assert.equal((await missing.handler(missing.request())).status, 503);
  const f = ingestFixture();
  f.state.status = 500;
  assert.equal((await f.handler(f.request())).status, 503);
  assert.equal((await f.handler(f.request(undefined, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await f.handler(f.request({ state: { notification: "x".repeat(5000) } }))).status, 400);
  assert.equal((await f.handler(new Request("https://test", { method: "GET" }))).status, 405);
});

function load(presence?: Record<string, unknown>, ownerIds: string[] = [OWNER]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qq-phone-config-"));
  const filename = path.join(directory, "config.yaml");
  fs.writeFileSync(filename, YAML.stringify({ persona: { name: "bot", prompt: "bot" }, model: { provider: "mock" },
    gateway: { provider: "onebot", onebot: { endpoint: "ws://localhost:3001" } },
    tools: { owner_ids: ownerIds }, presence }));
  try { return loadConfig(filename); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("手机状态配置：旧配置默认disabled且环境冷却30s", () => {
  const cfg = load();
  assert.equal(cfg.presence!.enabled, false);
  assert.equal(cfg.groups.conversation!.observerCooldownMs, 30000);
  assert.equal(cfg.presence!.requestTimeoutMs, 1500);
});

test("手机状态配置：明确所有者、HTTPS项目地址和serverkey才能启用", () => {
  const p = { enabled: true, supabase_url: config.supabaseUrl, server_key: config.serverKey, owner_id: OWNER, device_id: DEVICE };
  assert.equal(load(p).presence!.ownerId, OWNER);
  for (const changes of [{ owner_id: "10000000" }, { owner_id: "" }, { device_id: "../secret" },
    { server_key: "sb_publishable_public" }, { server_key: "" }, { supabase_url: "http://test" },
    { supabase_url: "https://test.supabase.co/private" }, { request_timeout_ms: 99999 }, { cache_ttl_ms: -1 }]) {
    assert.throws(() => load({ ...p, ...changes }), /配置错误: presence/);
  }
  assert.throws(() => load(p, []), /配置错误: presence.owner_id/);
});
