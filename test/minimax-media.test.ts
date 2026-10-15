import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/db/index.js";
import type { Gateway } from "../src/gateway/index.js";
import type { MessageRecord, SendStatus, ToolDef } from "../src/types.js";
import { MiniMaxMediaService, MINIMAX_ENGLISH_MALE_VOICE, validateEnglishSpeech, validateMiniMaxAssetUrl } from "../src/tools/minimax-media.js";

const OWNER = "10001";
const GROUP = "123456";
const SPEECH = "Hello. This is an English voice test. Your QQ bot can now send generated speech.";
const URL = "https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/generated/test.mp3?Expires=123&Signature=private-signature";
type SendTask = Parameters<Gateway["enqueueSend"]>[0];
async function fixture(t: TestContext, options: { status?: SendStatus; failure?: boolean; missing?: boolean; downloadFails?: number } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qq-minimax-media-"));
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const sent: SendTask[] = [];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let downloadCalls = 0;
  const gateway = { enqueueSend(task: SendTask) {
    sent.push(task); const queued = db.enqueueSendTask(task);
    const status = options.status ?? "confirmed";
    if (status !== "queued") {
      db.claimSendTask(queued.id);
      if (status !== "in_flight") db.finishSendTask(queued.id, status, "private /srv/path Bearer secret");
    }
    return queued;
  } } as unknown as Gateway;
  const backends: ToolDef[] = options.missing ? [] : ["text_to_image", "text_to_audio"].map(name => ({
    name: `mcp__minimax__${name}`, description: "backend", inputSchema: { type: "object" },
    execute: async (args: Record<string, unknown>) => { calls.push({ name, args });
      if (options.failure) throw new Error("Bearer private-key /srv/path signed-url");
      await new Promise(resolve => setTimeout(resolve, 1));
      return name === "text_to_image" ? `Success. Image URLs: ['${URL}']` : `Success. Audio URL: ${URL}`;
    },
  }));
  const create = () => new MiniMaxMediaService({ db, gateway, mcp: { getTools: () => backends }, accountId: "sim", ownerIds: [OWNER],
    outputDir: directory, providerOutputDir: "/app/shared/documents/media", waitTimeoutMs: 0,
    downloadAsset: async (_url, kind) => {
      downloadCalls++;
      if (downloadCalls <= (options.downloadFails ?? 0)) throw new Error("private-url");
      return { bytes: Buffer.from(kind === "image" ? [255, 216, 255, 0] : [73, 68, 51, 0]), extension: kind === "image" ? "jpg" : "mp3" };
    } });
  let serial = 0;
  const message = (overrides: Partial<MessageRecord> = {}): MessageRecord => ({ eventKey: `sim:${++serial}`, accountId: "sim", providerId: "onebot",
    conversationId: `private_${OWNER}`, messageId: String(serial), senderId: OWNER, displayNameAtTime: "主人", sentAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(), segments: [{ type: "text", data: { text: "画一张图，生成英文男声" } }],
    textContent: "画一张图，生成英文男声", status: "active", origin: "live", ...overrides });
  return { db, directory, sent, calls, create, service: create(), message, downloads: () => downloadCalls };
}

test("英文语音：正常英文、短问候和弯引号允许；中文其他脚本、标签、外语与混合句拒绝", () => {
  for (const text of [SPEECH, "Hello", "Goodnight", "Yes", "No", "Thank you!", "I’m glad you are here."]) assert.ok(validateEnglishSpeech(text));
  for (const text of ["你好", "Hello 你好", "Привет", "こんにちは", "Bonjour tout le monde, comment allez vous maintenant?",
    "Hola como estas hoy, quiero escuchar esta noticia en la radio.", "Hello, how are you today? Bonjour tout le monde, comment allez vous maintenant?", "Hello. Hola.", "Hello. Bonjour.", "Hello. Konnichiwa.",
    "<voice name='female'>Hello</voice>", "Hello [laughs]", "www.example.com", "12345", "a".repeat(2001), "bonjour"]) {
    assert.throws(() => validateEnglishSpeech(text), undefined, text);
  }
});

test("MiniMax媒体下载：仅受信官方HTTPS主机，拒绝内网/任意站/伪后缀/凭据/端口", () => {
  assert.equal(validateMiniMaxAssetUrl(URL).hostname, "minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com");
  for (const value of ["http://cdn.minimax.io/a", "https://127.0.0.1/a", "https://evil.test/a", "https://cdn.minimax.io.evil.test/a",
    "https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com.evil.test/a", "https://user:pass@cdn.minimax.io/a", "https://cdn.minimax.io:8443/a", "file:///etc/passwd"]) {
    assert.throws(() => validateMiniMaxAssetUrl(value));
  }
});

test("MiniMax媒体：图片和英文男声真实生成到共享目录，模型回执不暴露URL、密钥或本地路径", async t => {
  const f = await fixture(t);
  for (const kind of ["image", "speech"] as const) {
    const result = await f.service.createAndSend(kind, kind === "image" ? { prompt: "A raven under the moon" } : { text: SPEECH }, f.message());
    assert.equal(result.status, "confirmed"); assert.equal(result.generated, true);
    const task = f.sent.at(-1)!;
    assert.equal(task.kind, `minimax_${kind}`); assert.equal(task.targetId, OWNER);
    if (task.payload.kind !== "segments") assert.fail("必须发送原生媒体段");
    const segment = task.payload.segments[0]!;
    assert.equal(segment.type, kind === "image" ? "image" : "record");
    if (segment.type !== "image" && segment.type !== "record") assert.fail("必须为媒体");
    assert.match(segment.data.file!, /^file:\/\/\/app\/shared\/documents\/media\/media-[a-f0-9]+\//);
    const relative = segment.data.file!.split("/media/")[1]!;
    assert.equal((await fs.readFile(path.join(f.directory, ...relative.split("/")))).length, result.bytes);
    assert.doesNotMatch(JSON.stringify(result), /Signature|private-signature|Bearer|\/srv\/|qq-minimax-media|https?:/);
  }
  const voice = f.calls.find(call => call.name === "text_to_audio")!.args;
  assert.equal(voice.voice_id, MINIMAX_ENGLISH_MALE_VOICE); assert.equal(voice.language_boost, "English"); assert.equal(voice.model, "speech-2.8-hd");
  assert.equal(voice.format, "mp3"); assert.equal(voice.channel, 1);
  const image = f.calls.find(call => call.name === "text_to_image")!.args;
  assert.equal(image.n, 1); assert.equal(image.model, "image-01");
});

test("MiniMax媒体：主人群里默认发本群，private只发真实主人，不接受任意收件人", async t => {
  const f = await fixture(t);
  const group = () => f.message({ groupId: GROUP, conversationId: `group_${GROUP}` });
  await f.service.createAndSend("image", { prompt: "A raven" }, group());
  assert.equal(f.sent[0]!.conversationType, "group"); assert.equal(f.sent[0]!.targetId, GROUP);
  await f.service.createAndSend("speech", { text: SPEECH, delivery: "private" }, group());
  assert.equal(f.sent[1]!.conversationType, "private"); assert.equal(f.sent[1]!.targetId, OWNER);
  await assert.rejects(f.service.createAndSend("speech", { text: SPEECH, target_id: "9999" }, group()));
});

test("MiniMax媒体：非主人/跨账号/回填/撤回/伪造会话不能生成，工具上下文无法修改音色", async t => {
  const f = await fixture(t);
  for (const overrides of [{ senderId: "9999" }, { accountId: "other" }, { origin: "backfill" as const }, { status: "recalled" as const }, { conversationId: "group_9999" }, { interaction: "poke" as const }]) {
    const m = f.message(overrides);
    await assert.rejects(f.service.createAndSend("image", { prompt: "A raven" }, m));
  }
  for (const args of [{ text: SPEECH, voice_id: "English_Graceful_Lady" }, { text: SPEECH, language_boost: "Chinese" }, { text: "你好" }, { text: SPEECH, output_directory: "/tmp" }]) {
    await assert.rejects(f.service.createAndSend("speech", args, f.message()));
  }
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.service.toolsFor(f.message({ senderId: "9999" })).length, 0);
  const speechTool = f.service.toolsFor(f.message()).find(tool => tool.name === "generate_english_speech")!;
  assert.equal(speechTool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(speechTool.inputSchema.properties!), ["text", "delivery"]);
});

test("MiniMax媒体：仅真实正文中的本类明确请求授权；否定语句、无请求和伪textContent不能扣额度", async t => {
  const f = await fixture(t);
  for (const text of ["你好", "不要生成图片", "别画图", "Do not generate an image", "请生成语音"]) {
    const m = f.message({ textContent: "生成图片", segments: [{ type: "text", data: { text } }] });
    await assert.rejects(f.service.createAndSend("image", { prompt: "A raven" }, m));
  }
  for (const text of ["你好", "不要发语音", "别用男声", "Do not generate speech", "请画图"]) {
    const m = f.message({ textContent: "生成语音", segments: [{ type: "text", data: { text } }] });
    await assert.rejects(f.service.createAndSend("speech", { text: SPEECH }, m));
  }
  assert.equal(f.calls.length, 0);
});

test("MiniMax媒体：画对象的直接请求不必含图字，普通评论、画重点及引用代码不能触发", async t => {
  const f = await fixture(t);
  for (const text of ["帮我画一只乌鸦", "给我画只乌鸦", "画我"]) {
    const m = f.message({ textContent: text, segments: [{ type: "text", data: { text } }] });
    assert.equal((await f.service.createAndSend("image", { prompt: "A raven" }, m)).status, "confirmed");
  }
  const calls = f.calls.length;
  for (const text of ["这幅画很好看", "画重点", "如何画一张图", "> 帮我画一只乌鸦", "```text\n生成图片\n```", "只是讨论这幅画，不要画我"]) {
    const m = f.message({ textContent: "生成图片", segments: [{ type: "text", data: { text } }] });
    await assert.rejects(f.service.createAndSend("image", { prompt: "A raven" }, m));
  }
  assert.equal(f.calls.length, calls);
});

test("MiniMax媒体：同一事件跨实例/并发/重启只生成及投递一次，修改参数不重复消费", async t => {
  const f = await fixture(t); const message = f.message(); const args = { prompt: "A raven" };
  const results = await Promise.all([f.service.createAndSend("image", args, message), f.create().createAndSend("image", args, message)]);
  assert.equal(results[0]!.taskId, results[1]!.taskId);
  const restarted = await f.create().createAndSend("image", args, message);
  assert.equal(restarted.reused, true); assert.equal(restarted.taskId, results[0]!.taskId);
  const altered = await f.create().createAndSend("image", { prompt: "Another picture" }, message);
  assert.equal(altered.reason, "already_requested");
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1); assert.equal(f.downloads(), 1);
});

test("MiniMax媒体：上游异常视为结果不明，跨实例再次调用也不自动生成，不泄漏异常细节", async t => {
  const f = await fixture(t, { failure: true }); const m = f.message();
  const first = await f.service.createAndSend("speech", { text: SPEECH }, m);
  const second = await f.create().createAndSend("speech", { text: SPEECH }, m);
  assert.equal(first.status, "unknown"); assert.equal(second.status, "unknown");
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 0);
  assert.doesNotMatch(JSON.stringify([first, second]), /Bearer|private-key|\/srv\/|signed-url/);
});

test("MiniMax媒体：生成后下载失败只重取同一产物，保持生成一次", async t => {
  const f = await fixture(t, { downloadFails: 1 }); const m = f.message();
  const failed = await f.service.createAndSend("image", { prompt: "A raven" }, m);
  assert.equal(failed.reason, "asset_unavailable"); assert.equal(f.sent.length, 0);
  const second = await f.create().createAndSend("image", { prompt: "A raven" }, m);
  assert.equal(second.status, "confirmed"); assert.equal(f.calls.length, 1); assert.equal(f.downloads(), 2);
});

for (const status of ["failed", "unknown", "queued", "in_flight"] as const) test(`MiniMax媒体：QQ ${status}回执保持真实状态，不自动重发/重生成`, async t => {
  const f = await fixture(t, { status }); const m = f.message();
  const first = await f.service.createAndSend("speech", { text: SPEECH }, m);
  const second = await f.create().createAndSend("speech", { text: SPEECH }, m);
  assert.equal(first.status, status); assert.equal(second.status, status); assert.equal(first.generated, true);
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
});

test("MiniMax媒体：MCP缺失不写生成中标记，后续连接后可以正常请求", async t => {
  const f = await fixture(t, { missing: true });
  const result = await f.service.createAndSend("image", { prompt: "A raven" }, f.message());
  assert.equal(result.reason, "unavailable"); assert.equal(result.status, "failed");
  assert.equal((f.db.db.prepare("SELECT count(*) AS n FROM kv WHERE key LIKE 'minimax_media:%'").get() as { n: number }).n, 0);
});
