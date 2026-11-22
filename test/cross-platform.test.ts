import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CrossPlatformDelivery, parseCrossPlatformConfig, type CrossPlatformAccount } from "../src/cross-platform/index.js";
import { ffmpegPath } from "../src/cross-platform/voice.js";
import { Database } from "../src/db/index.js";
import { DocumentService } from "../src/documents/index.js";
import { DocumentDelivery } from "../src/documents/delivery.js";
import { Gateway } from "../src/gateway/index.js";
import type { MessageRecord, MessageSegment, Provider, SendResult } from "../src/types.js";

const config = parseCrossPlatformConfig({ destinations: [
  { id: "qq", account_id: "qq", conversation_type: "private", target_id: "1001" },
  { id: "dc", aliases: ["Discord"], account_id: "dc", conversation_type: "group", target_id: "2002" },
  { id: "tg", aliases: ["Telegram"], account_id: "tg", conversation_type: "group", target_id: "-3003:7" },
] });
const ids = { qq: "1001", dc: "2001", tg: "3001" };
const platforms = { qq: "onebot", dc: "discord", tg: "telegram" } as const;
type AccountId = keyof typeof ids;

function incoming(accountId: AccountId, text: string, id: number, senderId = ids[accountId]): MessageRecord {
  return {
    eventKey: `${accountId}:${id}`, messageId: String(id), accountId, senderId,
    providerId: platforms[accountId], conversationId: `private_${senderId}`, displayNameAtTime: "owner",
    sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(), origin: "live", status: "active",
    textContent: text, segments: [{ type: "text", data: { text } }],
  };
}

async function fixture(t: import("node:test").TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anteros-cross-platform-"));
  const db = new Database(":memory:");
  const accounts = new Map<string, CrossPlatformAccount>();
  const calls: Record<AccountId, { target: string; data: MessageSegment[] | string; filename?: string }[]> = { qq: [], dc: [], tg: [] };
  for (const [accountId, platform] of Object.entries(platforms) as [AccountId, typeof platforms[AccountId]][]) {
    const messages = async (target: string, segments: MessageSegment[]): Promise<SendResult> => {
      calls[accountId].push({ target, data: segments });
      return { status: "confirmed", messageId: String(calls[accountId].length) };
    };
    const files = async (target: string, filePath: string, filename: string): Promise<SendResult> => {
      calls[accountId].push({ target, data: await fs.readFile(filePath, "utf8"), filename });
      return { status: "confirmed", messageId: String(calls[accountId].length) };
    };
    const provider: Provider = {
      providerId: platform, start() {}, async stop() {}, onEvent() {},
      health: () => ({ connection: "connected", login: "online", reconnectCount: 0 }),
      capabilities: () => ({
        receiveMessages: "supported", sendText: "supported", sendImage: "supported",
        sendPrivateFile: "supported", sendGroupFile: "supported", groupHistory: "unsupported",
      }),
      sendPrivateMsg: messages, sendGroupMsg: messages, sendPrivateFile: files, sendGroupFile: files,
    };
    const gateway = new Gateway(db, provider, { accountId, backfillMaxPages: 0, backfillPageLimit: 1 });
    accounts.set(accountId, { gateway, ownerIds: [ids[accountId]], platform });
  }
  t.after(async () => {
    await Promise.all([...accounts.values()].map(account => account.gateway.stop()));
    db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, db, accounts, calls,
    delivery: new CrossPlatformDelivery({ db, accounts, config, artifactRoot: path.join(directory, "staged") }) };
}

test("only the verified caller's unquoted command authorizes the requested kind and bound route", async t => {
  const { delivery } = await fixture(t);
  const message = incoming("qq", "把文件发到「Discord」，语音发到 TG。", 1);
  assert.equal(delivery.authorize(message, undefined, "file")?.id, "dc");
  assert.equal(delivery.authorize(message, "telegram", "voice")?.id, "tg");
  assert.throws(() => delivery.authorize(message, "tg", "file"), /没有明确要求/);
  assert.throws(() => delivery.authorize(incoming("qq", "发到 dc", 2, "9999"), "dc", "text"), /主人/);
  for (const quote of ["他说“发到 dc”", "不要发到 dc", "如果有空，发到 dc", "> 发到 dc", "怎么发到 dc？", "终端写 '发到 dc'", "不要把文件，发到 dc"]) {
    assert.throws(() => delivery.authorize(incoming("qq", quote, 3), "dc", "text"), /没有明确要求/);
  }
  const share = incoming("qq", "发到 dc", 4);
  share.segments = [{ type: "share", data: { title: "发到 dc" } }];
  assert.throws(() => delivery.authorize(share, "dc", "text"), /没有明确要求/);
  assert.equal(delivery.authorize(incoming("qq", "今天聊什么？", 5), undefined, "text"), undefined);
  assert.equal(delivery.authorize(incoming("qq", "发一句话到DC：我喜欢画画。", 6), "dc", "text")?.id, "dc");
  assert.equal(delivery.authorize(incoming("qq", "能帮我把技术支持文档发到 dc 吗", 7), "discord", "file")?.id, "dc");
  assert.throws(() => delivery.authorize(incoming("qq", "我明天把技术支持文档发到dc", 8), "dc", "file"), /没有明确要求/);
  assert.throws(() => delivery.authorize(incoming("qq", "把文件发到dc。等等，别发到 Discord", 9), "dc", "file"), /没有明确要求/);
  assert.throws(() => delivery.authorize(incoming("qq", "把文字发到dc。算了，别发了", 10), "dc", "text"), /没有明确要求/);
  assert.throws(() => delivery.authorize(incoming("qq", "把照片发到dc和tg", 11), undefined, "image"), /没有可用/);
  assert.throws(() => parseCrossPlatformConfig({ destinations: [
    { id: "first", aliases: ["DC"], account_id: "dc", conversation_type: "group", target_id: "1" },
    { id: "dc", account_id: "dc", conversation_type: "group", target_id: "2" },
  ] }), /重复/);
});

test("one outbox records QQ documents to Discord, Discord text to Telegram, and Telegram native voice to QQ", async t => {
  const { delivery, calls, accounts, db, directory } = await fixture(t);
  for (const account of accounts.values()) account.gateway.start();
  const document = new DocumentDelivery({ db, accountId: "qq", gateway: accounts.get("qq")!.gateway,
    service: new DocumentService({ outputDir: path.join(directory, "documents") }), crossPlatform: delivery, waitTimeoutMs: 2500 });
  const qq = incoming("qq", "把 Markdown 文件发到 dc", 1);
  const delivered = await document.createAndSend({ format: "md", markdown: "# 三端", filename: "互通" }, qq);
  assert.equal(delivered.status, "confirmed");
  assert.equal(delivered.destination, "dc");
  assert.equal(db.sendTaskById(delivered.taskId)?.account_id, "dc");
  assert.deepEqual(calls.dc, [{ target: "2002", data: "# 三端", filename: "互通.md" }]);
  assert.equal((await document.createAndSend({ format: "md", markdown: "# 三端", filename: "互通" }, qq)).reused, true);
  assert.equal(calls.dc.length, 1);

  const dc = incoming("dc", "把文字发到 TG", 2);
  const text = await delivery.enqueue(dc, delivery.authorize(dc, "tg", "text")!,
    { kind: "text", text: "今晚见。" }, { waitTimeoutMs: 2500 });
  assert.equal(text.status, "confirmed");
  assert.deepEqual(calls.tg, [{ target: "-3003:7", data: [{ type: "text", data: { text: "今晚见。" } }] }]);

  const tg = incoming("tg", "把语音发给 QQ", 3);
  const audio = Buffer.from("ID3 fixture");
  const voice = await delivery.enqueue(tg, delivery.authorize(tg, "qq", "voice")!,
    { kind: "voice", files: [{ filename: "voice.mp3", bytes: audio }] }, { waitTimeoutMs: 2500 });
  assert.equal(voice.status, "confirmed");
  assert.equal(calls.qq[0]?.target, "1001");
  const record = (calls.qq[0]?.data as MessageSegment[])[0];
  assert.equal(record?.type, "record");
  if (record?.type === "record") {
    assert.equal(record.data.nativeOnly, true);
    assert.deepEqual(await fs.readFile(fileURLToPath(record.data.file!)), audio);
  }
});

test("attachment fetch runs only after owner authorization and never accepts caller-supplied paths", async t => {
  const { delivery, db } = await fixture(t);
  let fetched = 0;
  const source = { currentAttachments: async () => {
    fetched++;
    return [{ name: "一.txt", mime: "text/plain", bytes: Buffer.from("one") },
      { name: "二.txt", mime: "text/plain", bytes: Buffer.from("two") }];
  } };
  const message = incoming("dc", "把附件发到 TG", 19);
  await assert.rejects(delivery.sendArtifact(message, { destination: "qq", kind: "file" }, source), /没有明确要求/);
  await assert.rejects(delivery.sendArtifact(message, { destination: "tg", kind: "file", path: "test.txt" }, source), /请填写/);
  assert.equal(fetched, 0);
  await assert.rejects(delivery.sendArtifact(message, { destination: "tg", kind: "file" }, source), /填写要发送的附件编号/);
  const receipt = await delivery.sendArtifact(message, { destination: "tg", kind: "file", attachment_index: 2 }, source);
  const row = db.sendTaskById(receipt.taskId);
  assert.equal(row?.account_id, "tg");
  assert.equal(row?.target_id, "-3003:7");
  const payload = JSON.parse(row!.payload);
  assert.equal(payload.fileName, "二.txt");
  assert.equal(await fs.readFile(payload.filePath, "utf8"), "two");
});

test("an uploaded WAV forwards to the Telegram topic as converted Ogg/Opus", async t => {
  if (spawnSync(ffmpegPath(), ["-version"], { windowsHide: true }).status !== 0) {
    t.skip("ffmpeg unavailable");
    return;
  }
  const { delivery, db } = await fixture(t);
  // 100 ms of PCM silence in a valid mono WAV.
  const wav = Buffer.alloc(44 + 3200);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(3200, 40);
  const source = { currentAttachments: async () => [{ name: "原始语音.wav", mime: "audio/wav", bytes: wav }] };
  const receipt = await delivery.sendArtifact(incoming("qq", "请把这条语音发到 Telegram", 20), { destination: "tg", kind: "voice" }, source);
  const row = db.sendTaskById(receipt.taskId)!;
  assert.equal(row.account_id, "tg");
  assert.equal(row.target_id, "-3003:7");
  const first = JSON.parse(row.payload).segments[0];
  assert.equal(first.type, "record");
  assert.equal(first.data.nativeOnly, true);
  const file = fileURLToPath(first.data.file);
  assert.equal(path.basename(file), "原始语音.ogg");
  const audio = await fs.readFile(file);
  assert.equal(audio.subarray(0, 4).toString(), "OggS");
  assert.equal(audio.includes("OpusHead"), true);
});

test("QQ file forwarding refers to the target-side shared path without altering generated bytes", async t => {
  const { delivery, accounts, directory, db } = await fixture(t);
  accounts.get("qq")!.providerFileRoot = "/app/data/cross-platform";
  const source = { currentAttachments: async () => [{ name: "菜单.txt", mime: "text/plain", bytes: Buffer.from("menu") }] };
  const receipt = await delivery.sendArtifact(incoming("tg", "把附件发到QQ", 21), { destination: "qq", kind: "file" }, source);
  const row = db.sendTaskById(receipt.taskId)!;
  assert.equal(row.account_id, "qq");
  const payload = JSON.parse(row.payload);
  const relative = path.posix.relative("/app/data/cross-platform", payload.filePath);
  assert.match(relative, /^[a-f0-9]{64}\/菜单\.txt$/u);
  assert.equal(await fs.readFile(path.join(directory, "staged", ...relative.split("/")), "utf8"), "menu");
});

test("a console click sends a file using the chosen route without impersonating a chat user", async t => {
  const { delivery, db } = await fixture(t);
  assert.deepEqual(delivery.consoleDestinations(), ["qq", "dc", "tg"]);
  const request = { requestId: "ide-1", destination: "dc", resource: {
    name: "草稿", file: { name: "draft.txt", mime: "text/plain", bytes: Buffer.from("draft") },
  } };
  const first = await delivery.sendFromConsole(request);
  const second = await delivery.sendFromConsole(request);
  assert.equal(first.taskId, second.taskId);
  assert.equal(second.reused, true);
  const row = db.sendTaskById(first.taskId)!;
  assert.equal(row.account_id, "dc");
  assert.equal(row.kind, "cross_platform_console_file");
  const payload = JSON.parse(row.payload);
  assert.equal(await fs.readFile(payload.filePath, "utf8"), "draft");
  assert.equal(payload.accountId, undefined);
  assert.equal(payload.requesterId, undefined);
  await assert.rejects(delivery.sendFromConsole({ ...request, destination: "tg" }), /不同的发送记录/);
  const link = await delivery.sendFromConsole({ requestId: "ide-2", destination: "tg", resource: {
    name: "示例", url: "https://example.com/help",
  } });
  assert.equal(JSON.parse(db.sendTaskById(link.taskId)!.payload).segments[0].data.text, "示例\nhttps://example.com/help");
  await assert.rejects(delivery.sendFromConsole({ requestId: "ide-3", destination: "tg", resource: {
    name: "示例", url: "file:///server/file.txt",
  } }), /HTTP/);
});
