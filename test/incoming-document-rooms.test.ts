import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Database } from "../src/db/index.js";
import { createReadFileTool, IncomingDocumentService, type IncomingDocumentOptions } from "../src/documents/incoming.js";
import type { MessageRecord, MessageSegment, Provider } from "../src/types.js";

function setup(t: TestContext) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const assignments = new Map<string, string>();
  let counter = 0;
  let downloads = 0;
  const provider = {
    providerId: "onebot",
    async downloadIncomingFile() { downloads++; return Buffer.from("%PDF-room-document"); },
  } as unknown as Provider;
  const options: IncomingDocumentOptions = {
    db: db.db, provider, ownerIds: ["789"],
    parse: async () => ({ format: "pdf", chunks: [{ index: 0, source: "第 1 页", text: "当前上传的正文" }], notices: [], truncated: false }),
    roomVisibility: source => {
      const roomId = assignments.get(source.eventKey) ?? "home";
      return { roomId, canSee: eventKey => (assignments.get(eventKey) ?? "home") === roomId };
    },
  };
  const service = new IncomingDocumentService(options);
  function event(room: string, text: string, file?: { id: string; name: string }, quote?: MessageRecord): MessageRecord {
    const messageId = String(++counter);
    const eventKey = `a:private:${messageId}`;
    const segments: MessageSegment[] = [{ type: "text", data: { text } }];
    if (file) segments.push({ type: "file", data: { fileId: file.id, name: file.name, size: 18 } });
    const timestamp = new Date().toISOString();
    const result = { eventKey, accountId: "a", providerId: "onebot", conversationId: "private_789",
      messageId, senderId: "789", displayNameAtTime: "owner", sentAt: timestamp, receivedAt: timestamp,
      status: "active" as const, origin: "live" as const, segments, textContent: text, replyToMessageId: quote?.messageId };
    assignments.set(eventKey, room);
    db.insertMessage(result);
    return result;
  }
  const scope = { accountId: "a", conversationId: "private_789", requesterId: "789" };
  const read = async (source: MessageRecord, fileId?: string) => JSON.parse(await createReadFileTool(service, source).execute(
    fileId ? { file_id: fileId } : { mode: "list" }, { accountId: "a", isPrivate: true, requesterId: "789" }));
  return { db, service, options, event, scope, read, downloads: () => downloads };
}

test("metadata, quoted files, cached bytes and grants are scoped to each private room", async t => {
  const f = setup(t);
  const first = f.event("studio", "读这个文件", { id: "same-file", name: "工作室机密.pdf" });
  const [file] = f.service.register(first);
  assert.ok(file);
  assert.equal(f.service.authorizeRequest(first).length, 1);
  assert.equal((await f.read(first, file.id)).status, "ok");
  assert.equal(f.downloads(), 1);

  const other = f.event("guest", "总结这份文件", undefined, first);
  assert.deepEqual(f.service.authorizeRequest(other), []);
  assert.equal(f.service.contextFor(other), "");
  assert.deepEqual((await f.read(other)).files, []);
  assert.equal((await f.read(other, file.id)).reason, "not_found");
  assert.equal(JSON.parse(await f.service.read({ file_id: file.id }, f.scope)).reason, "forbidden");

  const copy = f.event("guest", "", { id: "same-file", name: "访客房副本.pdf" });
  assert.equal(f.service.register(copy)[0]!.id, file.id);
  const visible = await f.read(copy);
  assert.equal(visible.files[0].name, "访客房副本.pdf");
  assert.equal(visible.files[0].messageId, copy.messageId);
  assert.equal(visible.files[0].parsed, false);
  assert.doesNotMatch(f.service.contextFor(copy), /工作室机密/);
  assert.equal((await f.read(copy, file.id)).reason, "not_authorized");

  const grant = f.event("guest", "读一下这个", undefined, copy);
  assert.equal(f.service.authorizeRequest(grant).length, 1);
  assert.equal((await f.read(grant, file.id)).status, "ok");
  const revoke = f.event("guest", "别读", undefined, copy);
  f.service.authorizeRequest(revoke);
  assert.equal((await f.read(revoke, file.id)).reason, "not_authorized");
  assert.equal((await f.read(first, file.id)).status, "ok");
  assert.equal(f.downloads(), 1);
});

test("pending upload requests and current attachment forwarding use the assigned room", async t => {
  const f = setup(t);
  const request = f.event("studio", "把文件读一下");
  assert.deepEqual(f.service.authorizeRequest(request), []);
  const other = f.event("guest", "", { id: "guest-file", name: "访客.pdf" });
  f.service.register(other);
  assert.deepEqual(f.service.authorizeRequest(other), []);
  assert.equal(f.service.authorizedRequestFor(other), undefined);
  const upload = f.event("studio", "", { id: "studio-file", name: "工作室.pdf" });
  f.service.register(upload);
  assert.equal(f.service.authorizeRequest(upload).length, 1);
  assert.equal(f.service.authorizedRequestSourceFor(upload), request.eventKey);
  const [attachment] = await f.service.loadCurrentAttachments(upload);
  assert.equal(attachment!.name, "工作室.pdf");
  assert.equal(attachment!.bytes.toString(), "%PDF-room-document");
});

test("pre-room document metadata and existing grants remain visible in the home room only", async t => {
  const f = setup(t);
  const legacy = new IncomingDocumentService({ ...f.options, roomVisibility: undefined });
  const upload = f.event("home", "读这个文件", { id: "legacy-file", name: "老资料.pdf" });
  const [file] = legacy.register(upload);
  legacy.authorizeRequest(upload);
  f.db.db.prepare("UPDATE incoming_document_messages SET event_key=NULL,alias_name=NULL WHERE file_id=?").run(file!.id);
  const saved = f.event("home", "");
  assert.equal((await f.read(saved, file!.id)).status, "ok");
  const other = f.event("guest", "读这个文件", undefined, upload);
  assert.equal((await f.read(other, file!.id)).reason, "not_found");
  assert.deepEqual(f.service.authorizeRequest(other), []);
});
