import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { EmailService, emailConfigFromEnv, type EmailConfig, type EmailImapClient, type EmailSmtpClient } from "../src/tools/email.js";
import type { MessageRecord, ToolContext } from "../src/types.js";

const config: EmailConfig = { smtp: { host: "smtp.example.com", port: 465, user: "bot@example.com", pass: "smtp-secret" }, imap: { host: "imap.example.com", port: 993, user: "bot@example.com", pass: "imap-secret" }, defaultTo: "owner@example.com", fromName: "QQ Bot" };
const message = (changes: Partial<MessageRecord> = {}): MessageRecord => ({ eventKey: "event", accountId: "bot", providerId: "onebot", conversationId: "private_owner", messageId: "1", senderId: "owner", displayNameAtTime: "主人", sentAt: "2026-10-16T00:00:00Z", receivedAt: "2026-10-16T00:00:00Z", textContent: "看看邮件", status: "active", origin: "live", segments: [{ type: "text", data: { text: changes.textContent ?? "看看邮件" } }], ...changes });
const context = (m: MessageRecord): ToolContext => ({ accountId: m.accountId, groupId: m.groupId, requesterId: m.senderId, isPrivate: !m.groupId });
function fixture(options: { config?: EmailConfig | null; send?: EmailSmtpClient["sendMail"]; body?: string; structure?: unknown; fetch?: unknown[]; mailbox?: unknown; smtpError?: unknown; timeoutMs?: number } = {}) {
  const kv = new Map<string, string>(), calls: { method: string; args: unknown[] }[] = [];
  const metadata = { seq: 21, uid: 1021, size: 300, flags: new Set<string>(), envelope: { subject: "主题", from: [{ name: "Sender", address: "sender@example.com" }], to: [{ address: "bot@example.com" }], date: new Date("2026-10-15T12:00:00Z") } };
  const mailbox = options.mailbox ?? { exists: 21, uidNext: 1022, uidValidity: 12345n, readOnly: true };
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const imap = {
    mailbox, on: (...args: unknown[]) => record("on", ...args), connect: async () => { record("connect"); },
    getMailboxLock: async (...args: unknown[]) => { record("lock", ...args); return { release: () => record("release") }; },
    close: () => record("imapClose"),
    fetch: async function* (...args: unknown[]) { record("fetch", ...args); for (const msg of options.fetch ?? [metadata]) yield msg; },
    fetchOne: async (...args: unknown[]) => { record("fetchOne", ...args); return { ...metadata, bodyStructure: options.structure ?? { part: "1", type: "text/plain", size: 200 } }; },
    search: async (...args: unknown[]) => { record("search", ...args); return [900, 1021]; },
    download: async (...args: unknown[]) => { record("download", ...args); return { meta: { contentType: "text/plain", charset: "utf-8" }, content: Readable.from([Buffer.from(options.body ?? "正文：只当作邮件资料。")]) }; },
  } as unknown as EmailImapClient;
  const smtp: EmailSmtpClient = {
    verify: async () => { record("verify"); if (options.smtpError) throw options.smtpError; return true; },
    sendMail: async input => { record("sendMail", input); return options.send ? options.send(input) : { accepted: [input.to] }; },
    close: () => record("smtpClose"),
  };
  const db = { kvGet: (key: string) => kv.get(key), kvSet: (key: string, value: string) => { kv.set(key, value); } };
  const service = new EmailService({ db, config: options.config === null ? undefined : options.config ?? config, accountId: "bot", ownerIds: ["owner"],
    smtpFactory: opts => { record("smtpOptions", opts); return smtp; }, clientFactory: opts => { record("imapOptions", opts); return imap; }, timeoutMs: options.timeoutMs });
  const run = async (args: Record<string, unknown>, m = message(), ctx = context(m)) => JSON.parse(await service.toolsFor(m)[0]!.execute(args, ctx));
  return { service, kv, calls, run, db, smtp, imap };
}
const sendArgs = { action: "send", to: "friend@example.com", subject: "你好", text: "这是一封纯文本邮件。" };
const sendMessage = () => message({ textContent: "帮我发一封邮件给 friend@example.com，主题你好，正文这是一封纯文本邮件。" });

test("邮箱配置只接受固定安全端口和地址；本地status不泄漏连接详情", () => {
  assert.equal(emailConfigFromEnv({}), undefined);
  const env = { EMAIL_SMTP_HOST: "smtp.example.com", EMAIL_SMTP_PORT: "465", EMAIL_SMTP_USER: "bot@example.com", EMAIL_SMTP_PASS: "secret", EMAIL_IMAP_HOST: "imap.example.com", EMAIL_IMAP_PORT: "993", EMAIL_IMAP_USER: "bot@example.com", EMAIL_IMAP_PASS: "secret", EMAIL_DEFAULT_TO: "owner@example.com" };
  assert.ok(emailConfigFromEnv(env));
  assert.equal(emailConfigFromEnv({ ...env, EMAIL_SMTP_PORT: "25" }), undefined);
  assert.equal(emailConfigFromEnv({ ...env, EMAIL_IMAP_PORT: "143" }), undefined);
  assert.equal(emailConfigFromEnv({ ...env, EMAIL_FROM_NAME: "a\r\nBcc: b@evil.com" }), undefined);
  assert.deepEqual(fixture().service.status(), { configured: true });
  assert.deepEqual(fixture({ config: null }).service.status(), { configured: false });
});
test("邮箱只对真实存活主人匹配账号/会话可见，工具执行也检查上下文", async () => {
  const f = fixture();
  for (const changes of [{ senderId: "other", conversationId: "private_other" }, { accountId: "other" }, { origin: "backfill" as const }, { status: "recalled" as const }, { interaction: "poke" as const }, { conversationId: "private_other" }, { groupId: "1", conversationId: "group_2" }]) assert.equal(f.service.toolsFor(message(changes)).length, 0);
  const m = message();
  assert.equal((await f.run({ action: "status" }, m, { ...context(m), requesterId: "other" })).reason, "forbidden");
  assert.equal(f.service.toolsFor(message({ groupId: "1", conversationId: "group_1" })).length, 1);
  assert.equal(f.calls.length, 0);
});
test("缺配置安全返回，模型不能指定主机/凭据/任意命令", async () => {
  const f = fixture({ config: null }); assert.equal((await f.run({ action: "status" })).reason, "not_configured"); assert.equal(f.calls.length, 0);
  const ready = fixture();
  for (const args of [{ action: "list", host: "evil.example" }, { action: "read", command: "STORE" }, { action: "delete" }, { action: "send", ...sendArgs, cc: "evil@example.com" }, { action: "status", to: "a@example.com" }]) assert.equal((await ready.run(args)).reason, "invalid_input");
  let getterCalls = 0;
  const evil = Object.defineProperty({}, "action", { enumerable: true, get: () => { getterCalls++; return "send"; } });
  assert.equal((await ready.run(evil)).reason, "invalid_input"); assert.equal(getterCalls, 0);
  assert.equal(ready.calls.length, 0);
});
test("status只验证连接与计数，不发送邮件，TLS不降级不输出账号", async () => {
  const f = fixture(), result = await f.run({ action: "status" });
  assert.equal(result.status, "ok"); assert.equal(result.inboxCount, 21); assert.equal(result.smtpVerified, true); assert.equal(result.imapVerified, true);
  assert.equal(f.calls.filter(c => c.method === "sendMail").length, 0);
  const smtp = f.calls.find(c => c.method === "smtpOptions")!.args[0] as any;
  assert.equal(smtp.secure, true); assert.equal(smtp.requireTLS, true); assert.equal(smtp.ignoreTLS, false); assert.equal(smtp.tls.rejectUnauthorized, true); assert.equal(smtp.disableUrlAccess, true);
  const imap = f.calls.find(c => c.method === "imapOptions")!.args[0] as any;
  assert.equal(imap.secure, true); assert.equal(imap.tls.rejectUnauthorized, true); assert.equal(imap.logger, false); assert.equal(imap.logRaw, false);
  assert.deepEqual(f.calls.find(c => c.method === "lock")!.args, ["INBOX", { readOnly: true }]);
  assert.doesNotMatch(JSON.stringify(result), /smtp-secret|imap-secret|bot@example\.com|smtp\.example/);
});
test("587强制STARTTLS，服务器只读锁不成立则拒绝读取", async () => {
  const f = fixture({ config: { ...config, smtp: { ...config.smtp, port: 587 } } }); await f.run({ action: "status" });
  const opts = f.calls.find(c => c.method === "smtpOptions")!.args[0] as any; assert.equal(opts.secure, false); assert.equal(opts.requireTLS, true); assert.equal(opts.ignoreTLS, false);
  const bad = fixture({ mailbox: { exists: 21, uidNext: 1022, uidValidity: 12345n, readOnly: false } }); assert.equal((await bad.run({ action: "list" })).reason, "unavailable"); assert.equal(bad.calls.some(c => c.method === "fetch"), false);
});
test("list只读有界元数据，无正文、附件下载或STORE", async () => {
  const f = fixture(), result = await f.run({ action: "list", limit: 3, offset: 2 });
  assert.equal(result.uidValidity, "12345"); assert.equal(result.messages[0].uid, 1021); assert.equal(result.messages[0].seen, false); assert.equal(result.untrustedData, true);
  assert.deepEqual(f.calls.find(c => c.method === "fetch")!.args, ["17:19", { uid: true, envelope: true, size: true, flags: true }, { uid: false }]);
  assert.equal(f.calls.some(c => ["download", "fetchOne", "sendMail"].includes(c.method)), false);
  const invalid = fixture(); for (const args of [{ action: "list", limit: 11 }, { action: "list", offset: 1001 }, { action: "list", limit: 0 }, { action: "list", limit: 1.5 }]) assert.equal((await invalid.run(args)).reason, "invalid_input"); assert.equal(invalid.calls.length, 0);
});
test("search只扫描最近5000UID窗口，使用结构化查询且结果取最新limit", async () => {
  const f = fixture({ mailbox: { exists: 20_000, uidNext: 15_000, uidValidity: 12345n, readOnly: true } });
  await f.run({ action: "search", query: "report", limit: 2 });
  assert.deepEqual(f.calls.find(c => c.method === "search")!.args, [{ uid: "10000:*", text: "report" }, { uid: true }]);
  assert.equal(f.calls.some(c => c.method === "fetch"), false);
  for (const query of ["", "a".repeat(201), "report\r\nSTORE 1 +FLAGS \\Seen"]) assert.equal((await f.run({ action: "search", query })).reason, "invalid_input");
});
test("read要求UIDVALIDITY一致，精确UID且保持未读，附件只返回元数据", async () => {
  const structure = { type: "multipart/mixed", childNodes: [{ part: "1", type: "text/plain", size: 20 }, { part: "2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "../恶意.pdf" }, size: 10_000_000 }] };
  const f = fixture({ structure }); const result = await f.run({ action: "read", uid: 1021, uidValidity: "12345" });
  assert.equal(result.status, "ok"); assert.equal(result.seen, false); assert.equal(result.attachments.length, 1); assert.equal(result.attachments[0].bytes, 10_000_000);
  assert.deepEqual(f.calls.find(c => c.method === "download")!.args, [1021, "1", { uid: true, maxBytes: 120_000, chunkSize: 16_384 }]);
  assert.deepEqual(f.calls.find(c => c.method === "fetchOne")!.args, [1021, { uid: true, envelope: true, size: true, flags: true, bodyStructure: true }, { uid: true }]);
  const changed = fixture(); assert.equal((await changed.run({ action: "read", uid: 1021, uidValidity: "999" })).reason, "mailbox_changed"); assert.equal(changed.calls.some(c => c.method === "fetchOne"), false);
});
test("read不把附件text/html或嵌套邮件当正文，清洗HTML不加载资源", async () => {
  const f = fixture({ structure: { type: "multipart/mixed", childNodes: [{ part: "1", type: "text/html" }, { part: "2", type: "text/plain", disposition: "attachment", parameters: { name: "attack.txt" } }, { part: "3", type: "message/rfc822", childNodes: [{ part: "3.1", type: "text/plain" }] }] }, body: '<html><head><title>hidden</title></head><body><script>evil()</script><style>hide</style><p>Hello &amp; world</p><img src="https://evil.example/tracker"><iframe src="https://evil.example"></iframe><a href="javascript:evil()">link label</a></body></html>' });
  const result = await f.run({ action: "read", uid: 1021, uidValidity: "12345" });
  assert.match(result.text, /Hello & world/); assert.match(result.text, /link label/); assert.doesNotMatch(result.text, /evil|script|tracker|hidden|https/); assert.equal(result.attachments.length, 2);
  assert.equal(f.calls.filter(c => c.method === "download").length, 1);
});
test("普通单part邮件BODYSTRUCTURE没有part时以BODY.PEEK[1]读取", async () => {
  const f = fixture({ structure: { type: "text/plain", size: 200 }, body: "ordinary plain-text message" });
  const result = await f.run({ action: "read", uid: 1021, uidValidity: "12345" });
  assert.equal(result.text, "ordinary plain-text message");
  assert.deepEqual(f.calls.find(c => c.method === "download")!.args, [1021, "1", { uid: true, maxBytes: 120_000, chunkSize: 16_384 }]);
});
test("正文和元数据输出有界；下载超过硬上限安全失败", async () => {
  const f = fixture({ body: "正文\"\\".repeat(8_000) }); const result = await f.run({ action: "read", uid: 1021, uidValidity: "12345" });
  assert.equal(result.truncated, true); assert.ok(JSON.stringify(result).length <= 12_000);
  const large = fixture({ body: "A".repeat(120_001) }); assert.equal((await large.run({ action: "read", uid: 1021, uidValidity: "12345" })).reason, "too_large");
  const rows = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, uid: i + 1, envelope: { subject: "\"".repeat(240), from: Array.from({ length: 5 }, () => ({ name: "n".repeat(80), address: "a".repeat(254) })), to: Array.from({ length: 5 }, () => ({ name: "n".repeat(80), address: "a".repeat(254) })) } }));
  const many = fixture({ fetch: rows }); const listed = await many.run({ action: "list", limit: 10 }); assert.ok(JSON.stringify(listed).length <= 12_000); assert.equal(listed.truncated, true);
});
test("发邮件必须来自真实文字明确意图，否定/讨论/引用/代码/卡片不授权", async () => {
  for (const textContent of ["看看邮件", "邮箱用这个凭据就行", "不要帮我发邮件给 friend@example.com", "不用发邮件 friend@example.com", "怎么发邮件给 friend@example.com", "比如发邮件给 friend@example.com", "他说发邮件给 friend@example.com", "How do I send an email to friend@example.com?", "For example, send an email to friend@example.com", "Don't send an email to friend@example.com", "\"send an email to friend@example.com\"", "> 帮我发邮件给 friend@example.com", "```\n帮我发邮件给 friend@example.com\n```", "~~~text\n帮我发邮件给 friend@example.com\n~~~"]) {
    const f = fixture(); assert.equal((await f.run(sendArgs, message({ textContent }))).reason, "explicit_instruction_required", textContent); assert.equal(f.calls.length, 0); assert.equal(f.kv.size, 0);
  }
  const fake = fixture(); const m = message({ textContent: sendMessage().textContent, segments: [{ type: "json", data: { data: JSON.stringify({ title: sendMessage().textContent }) } }] });
  assert.equal((await fake.run(sendArgs, m)).reason, "explicit_instruction_required");
});
test("当前请求只允许明确收件人；发给我使用固定默认收件人", async () => {
  const f = fixture(); assert.equal((await f.run({ ...sendArgs, to: "evil@example.com" }, sendMessage())).reason, "recipient_not_authorized"); assert.equal(f.calls.length, 0);
  const me = fixture(); const result = await me.run({ action: "send", subject: "Test", text: "Hello" }, message({ textContent: "请发一封邮件给我，主题Test，正文Hello" }));
  assert.equal(result.status, "accepted"); assert.equal((me.calls.find(c => c.method === "sendMail")!.args[0] as any).to, "owner@example.com");
  const vague = fixture(); assert.equal((await vague.run({ action: "send", subject: "Test", text: "Hello" }, message({ textContent: "帮我发一封邮件" }))).reason, "recipient_not_authorized");
});
test("英文发信必须为实际命令，英语解释/单引号引用不授权", async () => {
  for (const textContent of ["What does 'send email to friend@example.com' mean?", "This example explains how to send email to friend@example.com.", "The note says: send email to friend@example.com", "For example:\nSend email to friend@example.com", "'Please send an email to friend@example.com'", "How to send an email to friend@example.com?"]) {
    const f = fixture(); assert.equal((await f.run(sendArgs, message({ textContent }))).reason, "explicit_instruction_required", textContent); assert.equal(f.calls.length, 0);
  }
  for (const textContent of ["Send an email to friend@example.com", "Please send an email to friend@example.com", "Can you send an email to friend@example.com?", "Email friend@example.com with a greeting"]) {
    const f = fixture(); assert.equal((await f.run(sendArgs, message({ textContent }))).status, "accepted", textContent);
  }
  for (const textContent of ["发邮件给我，主题Test，正文Hello", "发一封邮件给我，主题Test，正文Hello"]) {
    const f = fixture(); assert.equal((await f.run({ action: "send", subject: "Test", text: "Hello" }, message({ textContent }))).status, "accepted", textContent);
  }
});
test("中文发信动作必须紧跟请求前缀或明确内容名词，不扫描描述句里的发邮件", async () => {
  for (const textContent of [
    "帮我看看这封邮件为什么说要发邮件给 friend@example.com",
    "帮我分析这封邮件里说发邮件给 friend@example.com 是什么情况",
    "请解释这封邮件中发邮件给 friend@example.com 的含义",
    "帮我把这封邮件为什么说要发邮件给 friend@example.com 解释清楚",
    "我要你看看那段文字写着发邮件给 friend@example.com",
    "给我介绍发邮件给 friend@example.com 的方法",
  ]) {
    const f = fixture(); assert.equal((await f.run(sendArgs, message({ textContent }))).reason, "explicit_instruction_required", textContent); assert.equal(f.calls.length, 0); assert.equal(f.kv.size, 0);
  }
  for (const textContent of [
    "帮我发一封邮件给 friend@example.com",
    "请你帮我发邮件给 friend@example.com",
    "帮我把这段内容发邮件给 friend@example.com",
    "把这段内容发邮件给 friend@example.com",
    "请把今天的总结通过邮件发送给 friend@example.com",
    "我想让你把刚才的报告用邮件发给 friend@example.com",
  ]) {
    const f = fixture(); assert.equal((await f.run(sendArgs, message({ textContent }))).status, "accepted", textContent);
  }
  for (const textContent of ["给我发一封邮件", "请发邮件给我", "把这段内容发邮件给我"]) {
    const f = fixture(); assert.equal((await f.run({ action: "send", subject: "Test", text: "Hello" }, message({ textContent }))).status, "accepted", textContent);
  }
});
test("发邮件拒绝收件人和主题header注入，纯文本且禁文件/URL读取", async () => {
  for (const args of [{ ...sendArgs, to: "friend@example.com\r\nBcc: evil@example.com" }, { ...sendArgs, to: "Name <friend@example.com>" }, { ...sendArgs, subject: "hello\r\nBcc: evil@example.com" }, { ...sendArgs, text: "a\0b" }, { ...sendArgs, text: "a".repeat(10_001) }]) {
    const f = fixture(); assert.notEqual((await f.run(args, sendMessage())).status, "accepted"); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); const result = await f.run(sendArgs, sendMessage()); const input = f.calls.find(c => c.method === "sendMail")!.args[0] as any;
  assert.equal(result.status, "accepted"); assert.equal(result.delivered, false); assert.equal(result.smtpAccepted, true); assert.equal(input.text, sendArgs.text); assert.equal(input.html, undefined); assert.equal(input.attachments, undefined); assert.equal(input.disableUrlAccess, true); assert.equal(input.disableFileAccess, true); assert.match(input.messageId, /^<qqbot-[0-9a-f]{16}@example\.com>$/);
});
test("同一真实消息只发一次，重复参数复用回执，参数变化不再发", async () => {
  const f = fixture(), m = sendMessage(); const one = await f.run(sendArgs, m), two = await f.run(sendArgs, m);
  assert.equal(one.reused, false); assert.equal(two.reused, true); assert.equal(one.messageId, two.messageId); assert.equal(f.calls.filter(c => c.method === "sendMail").length, 1);
  assert.equal((await f.run({ ...sendArgs, subject: "changed" }, m)).reason, "invalid_input"); assert.equal(f.calls.filter(c => c.method === "sendMail").length, 1);
  const restarted = new EmailService({ db: f.db, accountId: "bot", ownerIds: ["owner"], config, smtpFactory: () => { throw new Error("must not reconnect"); } });
  assert.equal(JSON.parse(await restarted.toolsFor(m)[0]!.execute(sendArgs, context(m))).reused, true);
});
test("同时请求同一消息也只执行一次SMTP发送", async () => {
  const f = fixture(), m = sendMessage(); const results = await Promise.all([f.run(sendArgs, m), f.run(sendArgs, m)]);
  assert.equal(f.calls.filter(c => c.method === "sendMail").length, 1); assert.equal(results.filter(r => r.reused).length, 1);
});
test("SMTP异常或超时结果不明，不泄漏原始错误、不会自动重发", async () => {
  const f = fixture({ send: async () => { throw Object.assign(new Error("smtp-secret imap-secret raw protocol credentials"), { code: "ETIMEDOUT" }); } }), m = sendMessage();
  const one = await f.run(sendArgs, m), two = await f.run(sendArgs, m); assert.equal(one.status, "unknown"); assert.equal(one.reason, "delivery_unknown"); assert.equal(two.retryAllowed, false); assert.equal(f.calls.filter(c => c.method === "sendMail").length, 1); assert.doesNotMatch(JSON.stringify([one, two]), /smtp-secret|imap-secret|protocol/);
  const timed = fixture({ send: async () => new Promise(() => {}), timeoutMs: 5 }); assert.equal((await timed.run(sendArgs, m)).status, "unknown"); assert.equal((await timed.run(sendArgs, m)).retryAllowed, false); assert.equal(timed.calls.filter(c => c.method === "sendMail").length, 1);
});
test("SMTP没有accepted收件人不声称成功且禁止原消息重发", async () => {
  const f = fixture({ send: async () => ({ accepted: [], rejected: ["friend@example.com"] }) }), m = sendMessage();
  assert.equal((await f.run(sendArgs, m)).status, "failed"); assert.equal((await f.run(sendArgs, m)).status, "unknown"); assert.equal(f.calls.filter(c => c.method === "sendMail").length, 1);
});
test("持久journal必须先成功才发送，发送后写盘失败不重发", async () => {
  const f = fixture(); f.db.kvSet = () => { throw new Error("private DB path"); };
  assert.equal((await f.run(sendArgs, sendMessage())).reason, "storage"); assert.equal(f.calls.filter(c => c.method === "sendMail").length, 0);
  const after = fixture(); const original = after.db.kvSet; let count = 0; after.db.kvSet = (k, v) => { if (++count > 1) throw new Error("private"); original(k, v); };
  assert.equal((await after.run(sendArgs, sendMessage())).status, "unknown"); assert.equal((await after.run(sendArgs, sendMessage())).status, "unknown"); assert.equal(after.calls.filter(c => c.method === "sendMail").length, 1);
});
test("连接错误只返回白名单类别，不返回服务器原始消息", async () => {
  const f = fixture({ smtpError: Object.assign(new Error("smtp-secret host private details"), { code: "EAUTH" }) });
  assert.deepEqual(await f.run({ action: "status" }), { status: "failed", reason: "authentication" });
  const network = fixture({ smtpError: Object.assign(new Error("private"), { code: "ECONNRESET" }) }); assert.equal((await network.run({ action: "status" })).reason, "network");
});
