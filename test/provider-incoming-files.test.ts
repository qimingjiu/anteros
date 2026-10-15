import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { downloadIncomingFile, validateIncomingDownloadUrl } from "../src/documents/incoming.js";
import { IncomingFileError } from "../src/documents/incoming-errors.js";

const native = "http://8.8.8.8/asn.com/qqdownloadftnv5?ver=1&rkey=test-signature&isthumb=0";

test("QQ 文件公网 IP：只有真实协议解析后的固定私聊下载端点可用", () => {
  assert.throws(() => validateIncomingDownloadUrl(native));
  assert.equal(validateIncomingDownloadUrl(native, { providerResolved: true }).hostname, "8.8.8.8");
  assert.equal(validateIncomingDownloadUrl("https://8.8.8.8/ftn_handler/AB12/?fname=opaque-id", { providerResolved: true }).hostname, "8.8.8.8");
  for (const value of [
    native.replace("8.8.8.8", "127.0.0.1"), native.replace("8.8.8.8", "10.0.0.1"),
    native.replace("8.8.8.8", "169.254.169.254"), native.replace("8.8.8.8", "192.168.1.2"),
    native.replace("8.8.8.8", "100.64.0.1"), native.replace("8.8.8.8", "example.com"),
    native.replace("8.8.8.8", "qq.com.evil.test"), native.replace("8.8.8.8", "8.8.8.8:8080"),
    native.replace("qqdownloadftnv5", "arbitrary-file"), native.replace("rkey=test-signature", "rkey="),
    native.replace("&isthumb=0", ""), native.replace("isthumb=0", "isthumb=1"),
    "file:///etc/passwd", "http://8.8.8.8/ftn_handler/../../secret?fname=x",
  ]) assert.throws(() => validateIncomingDownloadUrl(value, { providerResolved: true }));
});

test("QQ 文件公网 IP：未提供协议来源时下载前拒绝，不执行网络请求", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("unexpected"); });
  await assert.rejects(downloadIncomingFile(native, { maxBytes: 100, timeoutMs: 1000 }), /受信任/);
  assert.equal(calls, 0);
});

test("QQ 文件公网 IP：协议端点可下载，体积限制照常执行", async t => {
  t.mock.method(dns.promises, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array([37, 80, 68, 70])));
  assert.deepEqual(await downloadIncomingFile(native, { maxBytes: 100, timeoutMs: 1000, providerResolved: true }), new Uint8Array([37, 80, 68, 70]));
  await assert.rejects(downloadIncomingFile(native, { maxBytes: 2, timeoutMs: 1000, providerResolved: true }), /体积/);
});

test("QQ 文件公网 IP：跳转不向新 IP、任意站点或内网扩展协议来源", async t => {
  t.mock.method(dns.promises, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  for (const destination of [native.replace("8.8.8.8", "1.1.1.1"), native.replace("8.8.8.8", "127.0.0.1"), "https://example.com/file.pdf"]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(null, { status: 302, headers: { Location: destination } }); });
    await assert.rejects(downloadIncomingFile(native, { maxBytes: 100, timeoutMs: 1000, providerResolved: true }), /受信任/);
    assert.equal(calls, 1);
  }
});

test("QQ 文件公网 IP：同来源签名更新允许，随后 DNS 仍逐跳检查", async t => {
  let dnsCalls = 0, fetchCalls = 0;
  t.mock.method(dns.promises, "lookup", async () => [{ address: ++dnsCalls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }]);
  t.mock.method(globalThis, "fetch", async () => { fetchCalls++; return new Response(null, { status: 302, headers: { Location: native.replace("test-signature", "refreshed-signature") } }); });
  await assert.rejects(downloadIncomingFile(native, { maxBytes: 100, timeoutMs: 1000, providerResolved: true }), /非公开地址/);
  assert.equal(fetchCalls, 1);
  assert.equal(dnsCalls, 2);
});

test("QQ 文件下载 HTTP 失败保留固定阶段和状态码，不暴露响应内容", async t => {
  t.mock.method(dns.promises, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  t.mock.method(globalThis, "fetch", async () => new Response("secret-signed-url", { status: 403 }));
  await assert.rejects(downloadIncomingFile(native, { maxBytes: 100, timeoutMs: 1000, providerResolved: true }), error => {
    assert.ok(error instanceof IncomingFileError);
    assert.equal(error.stage, "download");
    assert.equal(error.reason, "download_failed");
    assert.equal(error.httpStatus, 403);
    assert.doesNotMatch(error.message, /secret-signed-url/);
    return true;
  });
});
