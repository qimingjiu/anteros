import { test } from "node:test";
import assert from "node:assert/strict";
import { PhonePresenceService, type PhoneFetchFailure } from "../src/presence/index.js";
import type { PhonePresenceConfig } from "../src/config.js";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const OWNER = "10001", DEVICE = "phone-main";
const cfg: PhonePresenceConfig = { enabled: true, source: "device_events", sourceOwner: "azhan",
  supabaseUrl: "https://test.supabase.co", serverKey: "sb_secret_private_server_key", ownerId: OWNER, deviceId: DEVICE,
  cacheTtlMs: 30000, requestTimeoutMs: 100, staleRetentionMs: 86400000 };
const ownerRequest = { senderId: OWNER, conversationType: "private" as const, purpose: "chat" as const };
const row = (timestamp: number, values: Record<string, unknown>) => ({ owner: "azhan", device_id: DEVICE,
  timestamp: new Date(timestamp).toISOString(), ...values });

test("手机诊断：状态和receipt只包含来源、字段数量和时间；群聊、非主人不拉取也不给receipt", async () => {
  let requests = 0;
  const service = new PhonePresenceService(cfg, { now: () => NOW, fetch: (async () => {
    requests++;
    return Response.json([row(NOW, { battery_level: 42, wifi_ssid: "private-network", foreground_app: "com.private.application" }),
      row(NOW - 300000, { screen_state: "on" })]);
  }) as typeof fetch });
  assert.equal(service.status().lastFetch, null);
  assert.equal(requests, 0, "状态面板读取不能触发新的Supabase请求");
  for (const request of [{ senderId: OWNER, conversationType: "group" as const },
    { senderId: "11111111", conversationType: "private" as const }]) {
    assert.deepEqual(await service.contextResult(request), { context: "", receipt: null });
  }
  assert.equal(requests, 0);
  const result = await service.contextResult(ownerRequest);
  assert.equal(result.receipt!.contextChars, result.context.length);
  assert.deepEqual(result.receipt, { source: "device_events", purpose: "chat", contextChars: result.context.length,
    fieldCount: 4, newestObservedAt: new Date(NOW).toISOString(), oldestObservedAt: new Date(NOW - 300000).toISOString(),
    freshFieldCount: 3, staleFieldCount: 1 });
  assert.equal(service.status().lastFetch!.status, "ready");
  assert.equal(service.status().lastFetch!.httpStatus, 200);
  assert.equal(service.status().supportedFields.length, 8);
  assert.doesNotMatch(JSON.stringify({ receipt: result.receipt, status: service.status() }),
    /private-network|com\.private|private_server_key|10001|phone-main|azhan|battery_level/);
  const proactive = await service.contextResult({ ...ownerRequest, purpose: "proactive" });
  assert.equal(proactive.receipt!.purpose, "proactive");
  assert.equal(requests, 1);
});

test("手机诊断：空表与HTTP失败分开，失败不能沿用旧上下文，缓存到期后成功清除错误", async () => {
  let now = NOW, status = 200, rows: unknown[] = [];
  const service = new PhonePresenceService(cfg, { now: () => now,
    fetch: (async () => Response.json(rows, { status })) as typeof fetch });
  assert.deepEqual(await service.contextResult(ownerRequest), { context: "", receipt: null });
  assert.equal(service.status().lastFetch!.status, "empty");
  rows = [row(NOW, { charging: true })]; now += 30000;
  assert.equal((await service.contextResult(ownerRequest)).receipt!.fieldCount, 1);
  status = 403; now += 30000;
  assert.deepEqual(await service.contextResult(ownerRequest), { context: "", receipt: null });
  assert.deepEqual(service.status().lastFetch, { at: new Date(now).toISOString(), status: "failed", httpStatus: 403, failure: "http" });
  assert.equal(service.status().currentFieldCount, 0);
  status = 200; now += 30000;
  assert.equal((await service.contextResult(ownerRequest)).receipt!.fieldCount, 1);
  assert.equal(service.status().lastFetch!.status, "ready");
  assert.equal(service.status().lastFetch!.failure, undefined);
});

test("手机诊断：格式、容量、网络和超时错误脱敏分类，不泄露异常正文", async () => {
  const cases: [PhoneFetchFailure, () => Promise<Response>][] = [
    ["invalid_json", async () => new Response("credential-secret-not-json")],
    ["invalid_response", async () => Response.json({ credential: "secret" })],
    ["oversized", async () => new Response("secret".repeat(12000))],
    ["network", async () => { throw new Error("private-network sb_secret_sensitive"); }],
    ["timeout", async () => { throw new DOMException("private-timeout", "TimeoutError"); }],
  ];
  for (const [expected, fetcher] of cases) {
    const service = new PhonePresenceService(cfg, { now: () => NOW, fetch: fetcher as typeof fetch });
    assert.deepEqual(await service.contextResult(ownerRequest), { context: "", receipt: null });
    assert.equal(service.status().lastFetch!.failure, expected);
    assert.equal(service.status().lastFetch!.status, "failed");
    assert.doesNotMatch(JSON.stringify(service.status()), /credential|sensitive|private-network|private-timeout/);
  }
});

test("手机诊断：字段新鲜度随时间重算，状态调用不续期、不发HTTP", async () => {
  let now = NOW, requests = 0;
  const service = new PhonePresenceService(cfg, { now: () => now, fetch: (async () => {
    requests++;
    return Response.json([row(NOW - 299999, { foreground_app: "com.example.app" })]);
  }) as typeof fetch });
  assert.equal((await service.contextResult(ownerRequest)).receipt!.freshFieldCount, 1);
  now++;
  assert.equal(service.status().currentFreshFieldCount, 0);
  assert.equal((await service.contextResult(ownerRequest)).receipt!.staleFieldCount, 1);
  assert.equal(requests, 1);
  now += 86400000;
  assert.equal(service.status().currentFieldCount, 0);
  assert.equal(requests, 1);
});
