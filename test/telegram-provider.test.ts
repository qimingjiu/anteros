import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { messageImageUrls, resolveProviderImageContext } from "../src/agent/image-context.js";
import { IncomingDocumentService } from "../src/documents/incoming.js";
import { parseIncomingDocument } from "../src/documents/incoming-parser.js";
import { Database } from "../src/db/index.js";
import { telegramMessage } from "../src/telegram/incoming.js";
import { TelegramProvider, type TelegramOffset, type TelegramProviderOptions } from "../src/telegram/provider.js";
import type { MessageRecord, Provider } from "../src/types.js";

const TOKEN = "test-token";
const OPTIONS = { accountId: "tg-main", ownerIds: ["789"], groupAllowlist: ["-100123:12"] };
const date = Math.floor(Date.now() / 1000);
function update(updateId: number, fields: Record<string, unknown> = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100, date, from: { id: 789, is_bot: false, first_name: "主人" },
      chat: { id: 789, type: "private" }, text: "你好", ...fields,
    },
  };
}
const forum = { chat: { id: -100123, type: "supergroup" }, is_topic_message: true, message_thread_id: 12 };
const ok = (result: unknown) => Response.json({ ok: true, result });
const method = (ref: string | URL | Request) => new URL(String(ref)).pathname.split("/").at(-1);
const provider = (fetch: typeof globalThis.fetch, options: Partial<TelegramProviderOptions> = {}) =>
  new TelegramProvider({ ...OPTIONS, token: TOKEN, fetch, ...options });

test("Telegram 长轮询保存游标、隔离主题并忽略非主人、机器人和重复更新", { timeout: 5000 }, async t => {
  const more = Promise.withResolvers<void>();
  const batches = [
    [update(9, forum), update(8), update(7), update(9, forum),
      update(10, { ...forum, message_thread_id: 13 }),
      update(11, { from: { id: 456, is_bot: false } }),
      update(12, { from: { id: 789, is_bot: true } })],
    [],
  ];
  const saved: TelegramOffset[] = [];
  const pollOffsets: number[] = [];
  const telegram = provider(async (url, init) => {
    if (method(url) === "getMe") return ok({ id: 987, username: "example_bot", is_bot: true });
    assert.equal(method(url), "getUpdates");
    const parameters = JSON.parse(String(init?.body));
    pollOffsets.push(parameters.offset);
    assert.deepEqual(parameters.allowed_updates, ["message"]);
    if (pollOffsets.length === 2) more.resolve();
    return ok(batches.shift() ?? []);
  }, { offsetStore: { load: () => ({ nextOffset: 8, observedAt: Date.now() }), save: offset => saved.push(offset) } });
  t.after(() => telegram.stop());
  const messages: MessageRecord[] = [];
  telegram.onEvent(event => { if (event.kind === "message") messages.push(event.message); });
  telegram.start();
  await more.promise;
  assert.deepEqual(pollOffsets, [8, 13]);
  assert.deepEqual(saved.map(offset => offset.nextOffset), [9, 10, 11, 12, 13]);
  assert.deepEqual(messages.map(msg => [msg.conversationId, msg.messageId]), [["private_789", "108"], ["group_-100123:12", "109"]]);
  assert.equal(telegram.health().selfId, "987");
  assert.equal(telegram.health().connection, "connected");
  await telegram.stop();
  assert.equal(telegram.health().connection, "disconnected");
});

test("Telegram 保存引用、机器人提及及不带令牌的图片、语音和文件 ID", () => {
  const source = update(20, {
    ...forum,
    text: undefined,
    caption: "😀@example_bot 看这个",
    caption_entities: [{ type: "mention", offset: 2, length: 12 }],
    reply_to_message: { ...forum, message_id: 119 },
    photo: [{ file_id: "small" }, { file_id: "large" }],
    voice: { file_id: "voice_id" },
    document: { file_id: "doc_id", file_name: "folder/example.pdf", file_size: 300 },
  });
  const record = telegramMessage(source, { ...OPTIONS, selfId: "987", username: "example_bot" });
  assert.ok(record);
  assert.equal(record.groupId, "-100123:12");
  assert.equal(record.replyToMessageId, "119");
  assert.deepEqual(record.segments, [
    { type: "reply", data: { id: "119" } },
    { type: "text", data: { text: "😀" } },
    { type: "at", data: { qq: "987" } },
    { type: "text", data: { text: " 看这个" } },
    { type: "image", data: { url: "telegram-file:large" } },
    { type: "record", data: { file: "telegram-file:voice_id" } },
    { type: "file", data: { fileId: "doc_id", name: "folder_example.pdf", size: 300 } },
  ]);
  assert.deepEqual(messageImageUrls(record), ["telegram-file:large"]);
  assert.deepEqual(messageImageUrls({ ...record, providerId: "onebot" }), []);
});

test("Telegram 发送长文字、话题回复、原生 MP3 语音和附件", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-provider-"));
  const mp3 = path.join(dir, "voice.mp3");
  const pdf = path.join(dir, "report.pdf");
  t.after(async () => {
    await Promise.allSettled([fs.unlink(mp3), fs.unlink(pdf)]);
    await fs.rmdir(dir);
  });
  await fs.writeFile(mp3, "fixture-mp3");
  await fs.writeFile(pdf, "fixture-pdf");
  const requests: { method: string | undefined; body: BodyInit | null | undefined }[] = [];
  const telegram = provider(async (url, init) => {
    requests.push({ method: method(url), body: init?.body });
    return ok({ message_id: requests.length + 200, voice: method(url) === "sendVoice" ? { file_id: "voice_id" } : undefined });
  });
  const text = "a".repeat(4095) + "😀剩余文字";
  assert.deepEqual(await telegram.sendGroupMsg("-100123:12", [
    { type: "reply", data: { id: "120" } },
    { type: "text", data: { text } },
    { type: "record", data: { file: pathToFileURL(mp3).href, nativeOnly: true } },
  ]), { status: "confirmed", messageId: "203" });
  assert.deepEqual(await telegram.sendPrivateFile("789", pdf, "报告.pdf"), { status: "confirmed", messageId: "204" });
  assert.deepEqual(requests.map(request => request.method), ["sendMessage", "sendMessage", "sendVoice", "sendDocument"]);
  const first = JSON.parse(String(requests[0]?.body));
  const second = JSON.parse(String(requests[1]?.body));
  assert.equal(first.text.length, 4095);
  assert.equal(first.text + second.text, text);
  assert.equal(first.chat_id, "-100123");
  assert.equal(first.message_thread_id, 12);
  assert.deepEqual(first.reply_parameters, { message_id: 120, allow_sending_without_reply: true });
  assert.equal(second.reply_parameters, undefined);
  const voice = requests[2]?.body as FormData;
  assert.equal(voice.get("chat_id"), "-100123");
  assert.equal(voice.get("message_thread_id"), "12");
  assert.equal(await (voice.get("voice") as File).text(), "fixture-mp3");
  assert.equal((voice.get("voice") as File).type, "audio/mpeg");
  const doc = requests[3]?.body as FormData;
  assert.equal(doc.get("chat_id"), "789");
  assert.equal((doc.get("document") as File).name, "报告.pdf");
  assert.equal(await (doc.get("document") as File).text(), "fixture-pdf");
});

test("Telegram 对明确拒绝、响应丢失和部分投递分别保留真实结果", async () => {
  const failure = (status: number) => Response.json({ ok: false, error_code: status, description: TOKEN }, { status });
  const send = (telegram: TelegramProvider, length = 1) =>
    telegram.sendPrivateMsg("789", [{ type: "text", data: { text: "a".repeat(length) } }]);
  assert.equal((await send(provider(async () => failure(429)))).status, "failed");
  assert.equal((await send(provider(async () => failure(502)))).status, "unknown");
  const noResponse = await send(provider(async () => { throw new Error(TOKEN); }));
  assert.equal(noResponse.status, "unknown");
  assert.equal(noResponse.error?.includes(TOKEN), false);
  let count = 0;
  const partial = await send(provider(async () => ++count === 1 ? ok({ message_id: 201 }) : failure(400)), 4097);
  assert.equal(partial.status, "unknown");
  assert.equal(partial.messageId, "201");
  assert.equal(count, 2);
  const attachmentInsteadOfVoice = await provider(async () => ok({ message_id: 202, document: { file_id: "file_id" } }))
    .sendPrivateMsg("789", [{ type: "record", data: { file: "https://example.org/voice.ogg", nativeOnly: true } }]);
  assert.equal(attachmentInsteadOfVoice.status, "unknown");
});

test("Telegram 按需读取照片和主人授权的群文件，下载地址与 API 令牌不入上下文", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const docx = new JSZip();
  docx.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>正文验收</w:t></w:r></w:p></w:body></w:document>');
  const bytes = await docx.generateAsync({ type: "uint8array" });
  const requests: string[] = [];
  const telegram = provider(async (ref, init) => {
    const url = String(ref);
    requests.push(url);
    if (method(ref) === "getFile") {
      const file = JSON.parse(String(init?.body)).file_id;
      return ok({ file_path: file === "document_id" ? "documents/file_1.docx"
        : file === "photo_id" ? "photos/file_1.jpg" : "../wrong" });
    }
    if (url.endsWith("/photos/file_1.jpg")) return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
    return new Response(new Uint8Array(bytes));
  });
  const images = await resolveProviderImageContext(telegram, [{ url: "telegram-file:photo_id", source: "current",
    senderId: "789", senderName: "主人", messageId: "101", sentAt: new Date().toISOString(), origin: "live" }]);
  assert.match(images[0]?.url ?? "", /^data:image\/jpeg;base64,/);
  assert.equal(JSON.stringify(images).includes(TOKEN), false);
  await assert.rejects(telegram.downloadIncomingFile({ fileId: "malformed_path", maxBytes: 1000, timeoutMs: 500 }), /没有|未返回/);
  assert.equal(requests.some(request => request.endsWith("/wrong")), false);

  const documents = new IncomingDocumentService({ db, provider: telegram, ownerIds: ["789"],
    parse: async (data, name, limits) => parseIncomingDocument(data, name, limits) });
  const record = telegramMessage(update(51, { ...forum, text: "请读一下这个文件", document: {
    file_id: "document_id", file_name: "报告.docx", file_size: bytes.length,
  } }), OPTIONS);
  assert.ok(record);
  const [file] = documents.register(record);
  assert.ok(file);
  const scope = { accountId: OPTIONS.accountId, requesterId: record.senderId, conversationId: record.conversationId };
  assert.equal(JSON.parse(await documents.read({ file_id: file.id }, scope)).reason, "not_authorized");
  assert.ok(documents.authorizeRequest(record).length);
  const result = await documents.read({ file_id: file.id }, scope);
  assert.match(result, /正文验收/);
  assert.equal(result.includes(TOKEN), false);
});

test("转发附件只读取当前已落库的主人事件，验证格式、登记、体积和撤回状态", async t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const downloads: string[] = [];
  const storedFiles: Record<string, Buffer> = {
    doc: Buffer.from("%PDF-1.7\n"),
    photo: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    voice: Buffer.from("OggS\0OpusHead"),
  };
  const telegram = provider(async (url, init) => {
    if (method(url) === "getFile") {
      const fileId = JSON.parse(String(init?.body)).file_id as string;
      return ok({ file_path: `files/${fileId}` });
    }
    const id = method(url)!;
    downloads.push(id);
    return new Response(new Uint8Array(storedFiles[id]!));
  });
  const service = new IncomingDocumentService({ db: db.db, provider: telegram, ownerIds: ["789"] });
  const attachment = { file_id: "doc", file_name: "../报告.pdf", file_size: 9 };
  const record = telegramMessage(update(61, { ...forum, text: "把附件发到我的另一个账号", document: attachment,
    photo: [{ file_id: "photo" }], voice: { file_id: "voice" } }), OPTIONS);
  assert.ok(record);
  assert.deepEqual(await service.loadCurrentAttachments(record), []);
  db.insertMessage(record);
  await assert.rejects(service.loadCurrentAttachments(record), /登记|上传记录/);
  service.register(record);

  const reply = telegramMessage(update(62, { ...forum, reply_to_message: { ...forum, message_id: 161 } }), OPTIONS);
  assert.ok(reply);
  db.insertMessage(reply);
  assert.deepEqual(await service.loadCurrentAttachments(reply), []);
  assert.deepEqual(await service.loadCurrentAttachments({ ...record, accountId: "other" }), []);
  assert.deepEqual(await service.loadCurrentAttachments({ ...record, senderId: "456" }), []);
  assert.deepEqual(downloads, []);

  const media = await service.loadCurrentAttachments({ ...record, segments: [] });
  assert.deepEqual(media.map(({ mime }) => mime), ["image/jpeg", "audio/ogg", "application/pdf"]);
  assert.deepEqual(media.map(({ bytes }) => bytes), [storedFiles.photo, storedFiles.voice, storedFiles.doc]);
  assert.deepEqual(media.map(({ name }) => name), ["attachment-1.jpg", "attachment-2.ogg", "_报告.pdf"]);
  assert.equal(JSON.stringify(media).includes(TOKEN), false);
  const oversized = telegramMessage(update(63, { ...forum, document: { ...attachment, file_size: 15 * 1024 * 1024 } }), OPTIONS);
  assert.ok(oversized);
  db.insertMessage(oversized);
  service.register(oversized);
  await assert.rejects(service.loadCurrentAttachments(oversized), /体积/);
  assert.equal(db.markRecalled(record.conversationId, record.messageId, record.accountId), true);
  assert.deepEqual(await service.loadCurrentAttachments(record), []);
  assert.deepEqual(downloads, ["photo", "voice", "doc"]);
});

test("转发附件拒绝消息中的本地路径和非平台地址", async t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const options = { ...OPTIONS, groupAllowlist: [] };
  const record = telegramMessage(update(70), options);
  assert.ok(record);
  const discord = { providerId: "discord" } as unknown as Provider;
  const service = new IncomingDocumentService({ db: db.db, provider: discord, ownerIds: ["789"] });
  for (const [index, url] of ["file:///C:/secret.jpg", "https://example.org/picture.jpg",
    "https://cdn.discordapp.com.evil.example/attachments/1/2/photo.jpg"].entries()) {
    const source: MessageRecord = { ...record, eventKey: `discord:unsafe:${index}`, providerId: discord.providerId, messageId: String(200 + index),
      segments: [{ type: "image", data: { url } }] };
    db.insertMessage(source);
    await assert.rejects(service.loadCurrentAttachments(source), /下载失败/);
  }
});
