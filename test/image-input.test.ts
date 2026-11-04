import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay, setImmediate as tick } from "node:timers/promises";
import { ImageInputCache, ImageInputError } from "../src/llm/image-input.js";
import type { ChatMessage, ContentPart } from "../src/llm/index.js";

const source = (id = "one") => `https://fixture.invalid/${id}`;
const jpeg = () => Uint8Array.from([255, 216, 255, 0]);
const messages = (id = "one"): ChatMessage[] => [{ role: "user", content: [
  { type: "text", text: "fixture" }, { type: "image_url", image_url: { url: source(id) } },
] }];
const imagePart = (value: ChatMessage[]): string => {
  const content = value[0]!.content as ContentPart[];
  const part = content.find(part => part.type === "image_url");
  assert.ok(part?.type === "image_url");
  return part.image_url.url;
};

test("image input: supported magic bytes become inline data without changing messages", async () => {
  const fixtures = [
    { mime: "image/jpeg", bytes: jpeg() },
    { mime: "image/png", bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) },
    { mime: "image/gif", bytes: new TextEncoder().encode("GIF89a") },
    { mime: "image/gif", bytes: new TextEncoder().encode("GIF87a") },
    { mime: "image/webp", bytes: new TextEncoder().encode("RIFF0000WEBP") },
  ];
  for (const fixture of fixtures) {
    const original = messages();
    const snapshot = structuredClone(original);
    const cache = new ImageInputCache({ download: async (_url, options) => {
      assert.equal(options.maxBytes, 10 * 1024 * 1024);
      assert.equal(options.timeoutMs, 10_000);
      assert.ok(options.signal instanceof AbortSignal);
      return fixture.bytes;
    } });
    const result = await cache.inlineMessages(original);
    const data = imagePart(result);
    assert.ok(data.startsWith(`data:${fixture.mime};base64,`), "MIME comes from binary signature");
    assert.ok(Buffer.from(data.slice(data.indexOf(",") + 1), "base64").equals(Buffer.from(fixture.bytes)), "binary content is preserved");
    assert.deepEqual(original, snapshot);
    assert.notEqual(result, original);
  }
});

test("image input: inline data remains unchanged and repeated remote input reuses bytes", async () => {
  let downloads = 0;
  const original = messages();
  const data = "data:image/jpeg;base64,/9j/AA==";
  (original[0]!.content as ContentPart[]).push({ type: "image_url", image_url: { url: data } },
    { type: "image_url", image_url: { url: source() } });
  const cache = new ImageInputCache({ download: async () => { downloads++; return jpeg(); } });
  const result = await cache.inlineMessages(original);
  const parts = result[0]!.content as ContentPart[];
  assert.ok(parts[2]?.type === "image_url" && parts[2].image_url.url === data);
  await cache.inlineMessages(messages());
  assert.equal(downloads, 1);
});

test("image input: cache expires after ten minutes without extending TTL on a hit", async () => {
  let now = 0, downloads = 0;
  const cache = new ImageInputCache({ now: () => now, download: async () => { downloads++; return jpeg(); } });
  await cache.inlineMessages(messages());
  now = 599_999;
  await cache.inlineMessages(messages());
  assert.equal(downloads, 1);
  now = 600_000;
  await cache.inlineMessages(messages());
  assert.equal(downloads, 2);
});

test("image input: at most thirty-two entries use least-recently-used eviction", async () => {
  let downloads = 0;
  const cache = new ImageInputCache({ download: async () => { downloads++; return jpeg(); } });
  for (let i = 0; i < 32; i++) await cache.inlineMessages(messages(String(i)));
  await cache.inlineMessages(messages("0"));
  await cache.inlineMessages(messages("32"));
  await cache.inlineMessages(messages("0"));
  assert.equal(downloads, 33);
  await cache.inlineMessages(messages("1"));
  assert.equal(downloads, 34);
});

test("image input: cached raw bytes stay below thirty-two MiB", async () => {
  let downloads = 0;
  const cache = new ImageInputCache({ download: async () => {
    downloads++;
    const bytes = new Uint8Array(9 * 1024 * 1024);
    bytes.set(jpeg());
    return bytes;
  } });
  for (let i = 0; i < 4; i++) await cache.inlineMessages(messages(String(i)));
  await cache.inlineMessages(messages("3"));
  assert.equal(downloads, 4);
  await cache.inlineMessages(messages("0"));
  assert.equal(downloads, 5, "oldest raw image was evicted to satisfy byte bound");
});

test("image input: failed, oversized, empty and unsupported downloads are never cached or exposed", async () => {
  for (const kind of ["failure", "oversized", "empty", "unsupported"] as const) {
    let downloads = 0;
    const cache = new ImageInputCache({ download: async () => {
      downloads++;
      if (kind === "failure") throw new Error("PRIVATE-UPSTREAM-CONTENT");
      if (kind === "oversized") return new Uint8Array(10 * 1024 * 1024 + 1);
      if (kind === "empty") return new Uint8Array();
      return new TextEncoder().encode("<html>PRIVATE-UPSTREAM-CONTENT</html>");
    } });
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(cache.inlineMessages(messages()), error =>
      error instanceof ImageInputError && !error.message.includes("PRIVATE-UPSTREAM-CONTENT"));
    assert.equal(downloads, 2, kind);
  }
});

test("image input: high-bit lookalikes do not pass exact image signatures", async () => {
  const cache = new ImageInputCache({ download: async () => Uint8Array.from([0xc7, 0xc9, 0xc6, 0xb8, 0xb9, 0xe1]) });
  await assert.rejects(cache.inlineMessages(messages()), error =>
    error instanceof ImageInputError && error.code === "unsupported_image");
});

test("image input: pre-cancellation and cancellation during download propagate without caching", async () => {
  let downloads = 0;
  let release!: (value: Uint8Array) => void;
  const cache = new ImageInputCache({ download: async () => {
    downloads++;
    return downloads === 1 ? new Promise<Uint8Array>(resolve => { release = resolve; }) : jpeg();
  } });
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(cache.inlineMessages(messages(), pre.signal), { name: "AbortError" });
  assert.equal(downloads, 0);
  const controller = new AbortController();
  const pending = cache.inlineMessages(messages(), controller.signal);
  await tick();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  release(jpeg());
  await tick();
  await cache.inlineMessages(messages());
  assert.equal(downloads, 2);
});

test("image input: the download deadline also bounds an injected downloader that ignores abort", async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", () => timeout(15));
  let downloads = 0;
  const cache = new ImageInputCache({ download: async () => {
    downloads++;
    return downloads === 1 ? new Promise<Uint8Array>(() => undefined) : jpeg();
  } });
  await Promise.all([assert.rejects(cache.inlineMessages(messages()), error =>
    error instanceof ImageInputError && error.code === "download_timeout"), delay(35)]);
  await cache.inlineMessages(messages());
  assert.equal(downloads, 2);
});

test("image input: the default downloader rejects private destinations before a connection", async t => {
  let fetched = false;
  t.mock.method(globalThis, "fetch", async () => { fetched = true; throw new Error("unexpected connection"); });
  const original: ChatMessage[] = [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://127.0.0.1/blocked" } }] }];
  await assert.rejects(new ImageInputCache().inlineMessages(original), error =>
    error instanceof ImageInputError && error.code === "download_failed");
  assert.equal(fetched, false);
});

test("image input: default binary download checks actual signature and reuses successful bytes", async t => {
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    downloads++;
    return new Response(jpeg(), { headers: { "Content-Type": "application/octet-stream" } });
  });
  const original: ChatMessage[] = [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://8.8.8.8/fixture" } }] }];
  const cache = new ImageInputCache();
  assert.ok(imagePart(await cache.inlineMessages(original)).startsWith("data:image/jpeg;base64,"));
  await cache.inlineMessages(original);
  assert.equal(downloads, 1);
});
