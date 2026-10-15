import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Database } from "../src/db/index.js";
import { DocumentService } from "../src/documents/index.js";
import { DocumentDelivery } from "../src/documents/delivery.js";
import type { Gateway } from "../src/gateway/index.js";
import type { MessageRecord, SendStatus } from "../src/types.js";

const OWNER = "10001";
const GROUP = "123456";
const BODY = "# 十月工作计划\n\n完整的中文正文。\n\n- 第一项\n- 第二项\n";
type SendTask = Parameters<Gateway["enqueueSend"]>[0];

async function fixture(t: TestContext, status: SendStatus = "confirmed", providerOutputDir?: string, maxRetainedFiles?: number) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qq-document-delivery-"));
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const service = new DocumentService({ outputDir: directory, maxRetainedFiles });
  const sent: SendTask[] = [];
  const gateway = {
    enqueueSend(task: SendTask) {
      sent.push(task);
      const queued = db.enqueueSendTask(task);
      if (!queued.reused && status !== "queued") {
        db.claimSendTask(queued.id);
        if (status !== "in_flight") db.finishSendTask(queued.id, status, "private diagnostic /srv/secret Bearer fake-secret");
      }
      return queued;
    },
  } as unknown as Gateway;
  const createDelivery = () => new DocumentDelivery({ db, gateway, service, accountId: "sim", providerOutputDir, waitTimeoutMs: 0 });
  const delivery = createDelivery();
  let serial = 0;
  const message = (overrides: Partial<MessageRecord> = {}): MessageRecord => ({
    eventKey: `sim:private_${OWNER}:${++serial}`, accountId: "sim", providerId: "onebot",
    conversationId: `private_${OWNER}`, messageId: String(serial), senderId: OWNER, displayNameAtTime: "主人",
    sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(), segments: [{ type: "text", data: { text: "整理文档发给我" } }],
    textContent: "整理文档发给我", status: "active", origin: "live", ...overrides,
  });
  const request = { format: "md", markdown: BODY, filename: "十月计划" };
  return { directory, db, sent, delivery, createDelivery, message, request, service };
}

test("文档投递：私聊与群聊默认发送当前会话，内容确实存在于文件中", async (t) => {
  const f = await fixture(t);
  for (const groupId of [undefined, GROUP]) {
    const message = f.message(groupId ? { groupId, conversationId: `group_${groupId}` } : {});
    const result = await f.delivery.createAndSend(f.request, message);
    assert.equal(result.status, "confirmed");
    assert.equal(result.destination, "current");
    const task = f.sent.at(-1)!;
    assert.equal(task.conversationType, groupId ? "group" : "private");
    assert.equal(task.targetId, groupId ?? OWNER);
    assert.equal(task.kind, "document_file");
    assert.equal(task.payload.kind, "file");
    if (task.payload.kind !== "file") assert.fail("必须发送真实文件");
    assert.equal(task.payload.fileName, "十月计划.md");
    assert.equal(await fs.readFile(task.payload.filePath, "utf8"), BODY);
    assert.equal(result.bytes, Buffer.byteLength(BODY));
    assert.equal(f.db.sendTaskById(result.taskId)?.status, "confirmed");
    assert.doesNotMatch(JSON.stringify(result), /qq-document-delivery-|Bearer|fake-secret|\/srv\/secret/);
  }
});

test("文档投递：群里要求 private 只能发给真实请求者，不把群号或引用人当收件人", async (t) => {
  const f = await fixture(t);
  const message = f.message({ groupId: GROUP, conversationId: `group_${GROUP}`, replyToMessageId: "98765",
    textContent: `把群友 99887766 的笔记私发给我，另一个收件人 55667788` });
  const result = await f.delivery.createAndSend({ ...f.request, delivery: "private" }, message);
  assert.equal(result.destination, "private");
  assert.equal(f.sent[0]?.conversationType, "private");
  assert.equal(f.sent[0]?.targetId, OWNER);
});

test("文档投递：PDF 与 DOCX 从真实渲染器进入同一文件队列，中文内容与共享路径均有效", async (t) => {
  const f = await fixture(t, "confirmed", "/app/shared/documents");
  for (const format of ["pdf", "docx"] as const) {
    const result = await f.delivery.createAndSend({ ...f.request, format }, f.message());
    assert.equal(result.generated, true);
    assert.equal(result.format, format);
    assert.equal(result.status, "confirmed");
    const task = f.sent.at(-1)!;
    if (task.payload.kind !== "file") assert.fail("必须发送真实文件");
    assert.match(task.payload.filePath, new RegExp(`^/app/shared/documents/doc-[0-9a-f]{32}/十月计划\\.${format}$`));
    const relative = task.payload.filePath.slice("/app/shared/documents/".length).split("/");
    const data = await fs.readFile(path.join(f.directory, ...relative));
    assert.equal(data.length, result.bytes);
    if (format === "pdf") {
      assert.equal(data.subarray(0, 5).toString(), "%PDF-");
      const pdf = await getDocument({ data: new Uint8Array(data), useSystemFonts: false }).promise;
      try {
        const content = await (await pdf.getPage(1)).getTextContent();
        const text = content.items.filter(item => "str" in item).map(item => "str" in item ? item.str : "").join("").replace(/\s/g, "");
        assert.ok(text.includes("十月工作计划") && text.includes("完整的中文正文。"));
      } finally { await pdf.destroy(); }
    } else {
      const zip = await JSZip.loadAsync(data);
      const xml = await zip.file("word/document.xml")!.async("text");
      assert.match(xml, /十月工作计划/);
      assert.match(xml, /完整的中文正文。/);
    }
  }
  assert.equal(f.sent.length, 2);
});

test("文档投递：Windows 生成目录映射至 POSIX 共享目录，保留嵌套目录与中文文件名", async (t) => {
  const f = await fixture(t, "confirmed", "/app/shared/documents");
  await f.delivery.createAndSend(f.request, f.message());
  const payload = f.sent[0]!.payload;
  if (payload.kind !== "file") assert.fail("必须是文件任务");
  assert.match(payload.filePath, /^\/app\/shared\/documents\/doc-[0-9a-f]{32}\/十月计划\.md$/);
  assert.doesNotMatch(payload.filePath, /\\|qq-document-delivery-/);
  const relative = payload.filePath.slice("/app/shared/documents/".length).split("/");
  assert.equal(await fs.readFile(path.join(f.directory, ...relative), "utf8"), BODY);
});

test("文档投递：重复调用及新实例复用同一任务和文件，不重新生成或上传", async (t) => {
  const f = await fixture(t);
  const message = f.message();
  const first = await f.delivery.createAndSend(f.request, message);
  const second = await f.delivery.createAndSend(f.request, message);
  const restarted = await f.createDelivery().createAndSend(f.request, message);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(restarted.reused, true);
  assert.equal(second.taskId, first.taskId);
  assert.equal(restarted.taskId, first.taskId);
  assert.equal(f.sent.length, 1);
  assert.equal((await fs.readdir(f.directory)).length, 1);
  assert.equal(f.db.recentSendTasks(10).length, 1);
});

test("文档投递：同一实例并发重复请求只占一个存储配额", async (t) => {
  const f = await fixture(t, "confirmed", undefined, 1);
  const message = f.message();
  const results = await Promise.all([f.delivery.createAndSend(f.request, message), f.delivery.createAndSend(f.request, message)]);
  assert.equal(results[0]!.taskId, results[1]!.taskId);
  assert.equal(f.sent.length, 1);
  assert.equal((await fs.readdir(f.directory)).length, 1);
});

test("文档投递：跨实例并发重复请求也只占一个配额并复用任务", async (t) => {
  const f = await fixture(t, "confirmed", undefined, 1);
  const message = f.message();
  const results = await Promise.all([f.delivery.createAndSend(f.request, message), f.createDelivery().createAndSend(f.request, message)]);
  assert.equal(results[0]!.taskId, results[1]!.taskId);
  assert.equal(f.sent.length, 1);
  assert.equal((await fs.readdir(f.directory)).length, 1);
});

test("文档投递：queued/in_flight/failed/unknown 都保留实际状态，不重试、不暴露内部错误", async (t) => {
  for (const status of ["queued", "in_flight", "failed", "unknown"] as const) {
    const f = await fixture(t, status);
    const message = f.message();
    const result = await f.delivery.createAndSend(f.request, message);
    const repeated = await f.createDelivery().createAndSend(f.request, message);
    assert.equal(result.generated, true);
    assert.equal(result.status, status);
    assert.equal(repeated.status, status);
    assert.equal(repeated.taskId, result.taskId);
    assert.equal(f.sent.length, 1);
    assert.doesNotMatch(result.detail, /已确认文件发送成功/);
    assert.doesNotMatch(JSON.stringify(result), /secret|Bearer|private diagnostic|qq-document-delivery-/);
    assert.match(result.detail, status === "failed" ? /发送失败.*没有自动重发/ : status === "unknown" ? /回执不明.*没有自动重发/ : /尚未/);
    assert.equal(f.db.sendTaskById(result.taskId)?.status, status);
  }
});

test("文档投递：修改内容或新的用户消息会生成独立任务，避免过度去重", async (t) => {
  const f = await fixture(t);
  const message = f.message();
  const first = await f.delivery.createAndSend(f.request, message);
  const changed = await f.delivery.createAndSend({ ...f.request, markdown: "# 修订后的计划\n\n第二版" }, message);
  const newMessage = await f.delivery.createAndSend(f.request, f.message());
  assert.equal(new Set([first.taskId, changed.taskId, newMessage.taskId]).size, 3);
  assert.equal(f.sent.length, 3);
  assert.equal((await fs.readdir(f.directory)).length, 3);
});

test("文档投递：拒绝跨账号、回填、撤回与非法真实 QQ，不生成文件", async (t) => {
  const f = await fixture(t);
  for (const overrides of [{ accountId: "other-account" }, { origin: "backfill" as const }, { status: "recalled" as const }, { senderId: "not-a-qq" }, { groupId: "bad-group" }]) {
    await assert.rejects(() => f.delivery.createAndSend(f.request, f.message(overrides)), /有效实时消息|有效的 QQ/);
  }
  assert.equal(f.sent.length, 0);
  assert.equal((await fs.readdir(f.directory)).length, 0);
});

test("文档投递：拒绝额外路径、收件人、身份字段、非法类型和未知格式", async (t) => {
  const f = await fixture(t);
  for (const request of [
    { ...f.request, filePath: "/etc/passwd" }, { ...f.request, path: "C:\\private.txt" },
    { ...f.request, recipientId: "55667788" }, { ...f.request, targetId: "55667788" },
    { ...f.request, senderId: "55667788" }, { ...f.request, isOwner: true },
    { ...f.request, delivery: "group" }, { ...f.request, format: "xlsx" },
    { ...f.request, format: ["md"] }, { ...f.request, format: ["docx"] }, { ...f.request, format: null },
    { ...f.request, markdown: ["正文"] }, { ...f.request, markdown: "" },
    { ...f.request, title: 123 }, { ...f.request, filename: 123 },
  ]) await assert.rejects(() => f.delivery.createAndSend(request, f.message()));
  assert.equal(f.sent.length, 0);
  assert.equal((await fs.readdir(f.directory)).length, 0);
});
