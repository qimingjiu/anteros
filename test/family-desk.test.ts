import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Database } from "../src/db/index.js";
import { FamilyDesk } from "../src/family/index.js";
import { serveFamilyPanel } from "../src/family/panel.js";
import { dayBounds, nextOccurrence, scheduleFromInput } from "../src/family/schedule.js";
import { PrivateTranscript } from "../src/family/transcript.js";
import type { MessageRecord } from "../src/types.js";

const date = "2026-11-20T10:00:00.000Z";
let sequence = 0;

function message(accountId: string, senderId: string, textContent: string, overrides?: Partial<MessageRecord>): MessageRecord {
  sequence++;
  return {
    eventKey: accountId + ":" + sequence, accountId, providerId: accountId, conversationId: "private_" + senderId,
    messageId: String(sequence), senderId, displayNameAtTime: senderId, sentAt: date, receivedAt: date,
    segments: [{ type: "text", data: { text: textContent } }], textContent, status: "active", origin: "live",
    ...overrides,
  };
}

function desk(db: Database, options?: Partial<ConstructorParameters<typeof FamilyDesk>[1]>): FamilyDesk {
  return new FamilyDesk(db, {
    isOwner: m => (m.accountId === "qq" && m.senderId === "01") || (m.accountId === "tg" && m.senderId === "02"),
    room: () => "family", members: () => [{ id: "raven", name: "鸦" }, { id: "mist", name: "雾" }],
    timeZone: "Asia/Shanghai", generate: async (_member, prompt) => "已处理 " + prompt,
    ...options,
  });
}

async function tool(service: FamilyDesk, source: MessageRecord, member: string, name: string, args: Record<string, unknown>) {
  const selected = service.toolsFor(source, member).find(item => item.name === name);
  assert.ok(selected, name);
  return JSON.parse(await selected.execute(args, { isPrivate: true, accountId: source.accountId, requesterId: source.senderId }));
}

test("private continuity admits only explicit account, exact peer and known self", () => {
  const db = new Database(":memory:");
  try {
    const rooms = new PrivateTranscript(db, [
      { accountId: "qq", ownerIds: ["01"], botId: () => "qbot" },
      { accountId: "tg", ownerIds: ["02"], botId: () => "tbot" },
    ]);
    const qq = message("qq", "01", "from QQ");
    const tg = message("tg", "02", "from TG");
    for (const entry of [
      qq, tg, message("qq", "qbot", "QQ reply", { conversationId: "private_01" }),
      message("tg", "tbot", "TG reply", { conversationId: "private_02" }),
      message("tg", "qbot", "wrong account bot", { conversationId: "private_02" }),
      message("qq", "other", "other sender", { conversationId: "private_01" }),
      message("qq", "01", "group copy", { conversationId: "private_01", groupId: "group" }),
      message("tg", "02", "recalled", { status: "recalled" }),
      message("qq", "01", "other user space", { conversationId: "private_02" }),
    ]) db.insertMessage(entry);
    const start = "2026-11-20T00:00:00.000Z";
    const end = "2026-11-21T00:00:00.000Z";
    assert.deepEqual(rooms.read(qq, start, end).map(row => row.text), ["from QQ", "from TG", "QQ reply", "TG reply"]);
    assert.deepEqual(rooms.read(qq, start, end, { otherAccountsOnly: true }).map(row => row.text), ["from TG", "TG reply"]);
    assert.deepEqual(rooms.search(qq, "from qq", { limit: 1 }).map(row => row.text), ["from QQ"]);
    assert.deepEqual(rooms.search(qq, "wrong account bot"), []);
    assert.equal(rooms.recent(qq, { limit: 1 })[0]?.role, "assistant");
    assert.deepEqual(rooms.read(message("qq", "other", "impersonation"), start, end), []);
    assert.deepEqual(rooms.read({ ...qq, groupId: "group" }, start, end), []);
  } finally {
    db.close();
  }
});

test("versioned workshop follows the same bound family room and locks member-private artifacts", async () => {
  const db = new Database(":memory:");
  const service = desk(db);
  try {
    const qq = message("qq", "01", "请保存这份笔记");
    const first = await tool(service, qq, "raven", "family_workspace", { action: "write", name: "notes.md", content: "原版" });
    assert.equal(first.ok, true);
    assert.equal((await tool(service, qq, "raven", "family_workspace",
      { action: "write", name: "notes.md", content: "原版" })).result.id, first.result.id);
    const tg = message("tg", "02", "从 TG 保存第二版");
    const second = await tool(service, tg, "raven", "family_workspace", { action: "write", name: "notes.md", content: "第二版" });
    assert.equal(second.result.parentId, first.result.id);
    assert.equal(service.readArtifact(tg, "raven", first.result.id).bytes.toString(), "原版");
    assert.throws(() => service.readArtifact(tg, "mist", first.result.id));
    assert.deepEqual(service.toolsFor({ ...tg, groupId: "group" }, "raven"), []);
    assert.deepEqual(service.toolsFor(message("tg", "01", "冒充"), "raven"), []);
    const denied = await tool(service, message("qq", "01", "不要分享给雾"), "raven", "family_workspace",
      { action: "share", member: "mist", id: first.result.id });
    assert.equal(denied.ok, false);
    const shared = await tool(service, message("qq", "01", "分享给雾"), "raven", "family_workspace",
      { action: "share", member: "mist", id: first.result.id });
    assert.equal(shared.ok, true);
    assert.equal(service.readArtifact(tg, "mist", first.result.id).bytes.toString(), "原版");
    assert.throws(() => service.readArtifact(tg, "mist", second.result.id));
  } finally {
    await service.close();
    db.close();
  }
});

test("workbench runs a member's background job, delivers a versioned result, and keeps it private", async () => {
  const db = new Database(":memory:");
  const notices: { destination?: string; text: string; artifact?: { bytes: Buffer } }[] = [];
  const service = desk(db, { notify: async notice => { notices.push(notice); },
    loadAttachments: async () => [{ name: "提纲.txt", mime: "text/plain", bytes: Buffer.from("议题一：何时提交") }],
  });
  try {
    const qq = message("qq", "01", "后台任务交给雾，把附件提纲整理完发到 tg");
    const input = { action: "start", member: "mist", title: "把会议原文做成清单", destination: "tg", currentAttachments: true };
    const result = await tool(service, qq, "raven", "family_job", input);
    assert.equal(result.result.state, "queued");
    await sleep(5);
    assert.equal((await tool(service, qq, "raven", "family_job", input)).result.id, result.result.id);
    assert.deepEqual((await tool(service, qq, "raven", "family_job", { action: "list" })).result, []);
    service.start();
    for (let i = 0; i < 10 && !notices.length; i++) await sleep(50);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.destination, "tg");
    assert.match(notices[0]!.artifact!.bytes.toString(), /会议原文/);
    assert.match(notices[0]!.artifact!.bytes.toString(), /何时提交/);
    const inbox = await tool(service, message("tg", "02", "看收件箱"), "mist", "family_job", { action: "inbox" });
    assert.equal(inbox.result.length, 1);
    assert.match(inbox.result[0].result, /已完成/);
    assert.equal((await tool(service, qq, "raven", "family_job", { action: "inbox" })).result.length, 0);
  } finally {
    await service.close();
    db.close();
  }
});

test("workbench can retrieve annotated library entries across linked accounts and validate workflows", async () => {
  const db = new Database(":memory:");
  const service = desk(db, { readPage: async () => ({ title: "Android notes", text: "Read the guide." }) });
  try {
    const source = message("qq", "01", "把 https://example.test/?utm_source=chat 收藏一下");
    const capture = await tool(service, source, "raven", "family_toolbox",
      { action: "capture", url: "https://example.test/", category: "工具" });
    assert.equal(capture.ok, true);
    const tg = message("tg", "02", "找下安卓的笔记");
    assert.equal((await tool(service, tg, "raven", "family_toolbox", { action: "search", query: "安卓" })).result.length, 1);
    assert.equal((await tool(service, tg, "mist", "family_toolbox", { action: "search", query: "安卓" })).result.length, 0);
    const install = message("tg", "02", "新增一个标题排序去重功能");
    const workflow = await tool(service, install, "raven", "family_workflow",
      { action: "install", name: "去重排序", steps: [{ op: "unique" }, { op: "sort" }],
        examples: [{ input: [2, 1, 2], expected: [1, 2] }] });
    assert.equal(workflow.result.state, "enabled");
    assert.deepEqual((await tool(service, tg, "raven", "family_workflow",
      { action: "run", id: workflow.result.id, input: [5, 3, 5] })).result, [3, 5]);
    const unsafe = await tool(service, install, "raven", "family_workflow",
      { action: "install", name: "不安全", steps: [{ op: "pick", path: "__proto__" }],
        examples: [{ input: {}, expected: null }] });
    assert.equal(unsafe.ok, false);
  } finally {
    await service.close();
    db.close();
  }
});

test("only current member's confirmed private notes enter model context", async () => {
  const db = new Database(":memory:");
  const service = desk(db);
  try {
    const remember = message("qq", "01", "记住我喜欢在晚上读诗");
    const saved = await tool(service, remember, "raven", "family_member_notes", { action: "remember", text: "晚上读诗" });
    assert.equal(service.contextFor(remember, "raven"), "");
    const confirm = message("tg", "02", "确认这条是真的");
    await tool(service, confirm, "raven", "family_member_notes", { action: "confirm", id: saved.result.id, text: "本人已确认" });
    assert.match(service.contextFor(confirm, "raven"), /晚上读诗/);
    assert.equal(service.contextFor(confirm, "mist"), "");
    assert.equal(service.contextFor({ ...confirm, groupId: "group" }, "raven"), "");
    const challenge = message("qq", "01", "这条记忆有误，请质疑它");
    await tool(service, challenge, "raven", "family_member_notes", { action: "challenge", id: saved.result.id, text: "偏好有变化" });
    assert.equal(service.contextFor(confirm, "raven"), "");
  } finally {
    await service.close();
    db.close();
  }
});

test("task conditions survive scheduling and notify only members in the linked room", async () => {
  const db = new Database(":memory:");
  const notices: { key: string; text: string }[] = [];
  const service = desk(db, { notify: async notice => { notices.push(notice); } });
  try {
    const notice = message("qq", "01", "任务完成时提醒我");
    const rule = await tool(service, notice, "mist", "family_job",
      { action: "watch_task", event: "task_completed", title: "可以验收了" });
    assert.equal(rule.result.state, "queued");
    const source = message("tg", "02", "让雾去做这个后台任务");
    const task = await tool(service, source, "raven", "family_job", { action: "start", member: "mist", title: "整理会议" });
    service.start();
    for (let i = 0; i < 30 && notices.length < 2; i++) await sleep(40);
    assert.equal(notices.length, 2);
    assert.match(notices[1]!.text, /可以验收了/);
    assert.match(notices[1]!.key, new RegExp(task.result.id));
    const list = await tool(service, notice, "mist", "family_job", { action: "list" });
    assert.equal(list.result.find((item: { id: string }) => item.id === rule.result.id).state, "completed");
    assert.deepEqual((await tool(service, source, "raven", "family_job", { action: "inbox" })).result, []);
  } finally {
    await service.close();
    db.close();
  }
});

test("wall clock schedules skip a missing DST time and choose one fall-back time", () => {
  const zone = "America/New_York";
  const calendar = scheduleFromInput({ type: "calendar", time: "02:30" }, 0, zone);
  const next = nextOccurrence(calendar, Date.parse("2026-03-08T05:00:00.000Z"));
  assert.equal(new Date(next!).toISOString(), "2026-03-09T06:30:00.000Z");
  const fallback = scheduleFromInput({ type: "calendar", time: "01:30" }, 0, zone);
  const first = nextOccurrence(fallback, Date.parse("2026-11-01T04:00:00.000Z"));
  assert.equal(new Date(first!).toISOString(), "2026-11-01T05:30:00.000Z");
  const later = nextOccurrence(fallback, first!);
  assert.equal(new Date(later!).toISOString(), "2026-11-02T06:30:00.000Z");
  const day = dayBounds("2026-11-01", zone);
  assert.equal(Date.parse(day.end) - Date.parse(day.start), 25 * 3_600_000);
});

test("family panel keeps data and IDE actions behind token and exact origin", async () => {
  const db = new Database(":memory:");
  const service = desk(db);
  const dispatched: { destination: string; file?: Buffer; room?: string }[] = [];
  const origin = "https://host.ide.example";
  const token = "test-ide-owner";
  const room = "room:study";
  const server = createServer((req, res) => {
    if (serveFamilyPanel(req, res, new URL(req.url!, "http://" + req.headers.host), {
      desk: service, room: "family", allowedOrigins: [origin],
      rooms: () => [{ id: "family", name: "客厅" }, { id: room, name: "书房" }],
      activeRoom: () => room,
      authorized: () => req.headers.authorization === "Bearer " + token,
      destinations: () => ["discord"],
      send: async ({ destination, resource, familyRoomId }) => {
        dispatched.push({ destination, file: resource.file?.bytes, room: familyRoomId });
        return { id: 1, status: "queued" };
      },
    })) return;
    res.writeHead(404).end();
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    const auth = { Authorization: "Bearer " + token, Origin: origin };
    const page = await fetch(base + "/family");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /nonce/);
    const module = await fetch(base + "/ide-toolbox.js", { headers: { Origin: origin } });
    assert.equal(module.status, 200);
    assert.match(await module.text(), /export function installToolboxDock/);
    assert.equal(module.headers.get("access-control-allow-origin"), origin);
    assert.equal((await fetch(base + "/api/family?token=" + token)).status, 401);
    assert.equal((await fetch(base + "/api/family", {
      headers: { ...auth, Origin: "https://host.ide.example.evil.example" },
    })).status, 403);
    const proxyOrigin = base.replace("http:", "https:");
    assert.equal((await fetch(base + "/api/family", {
      headers: { ...auth, Origin: proxyOrigin, "Sec-Fetch-Site": "same-origin" },
    })).status, 200);
    const upload = await fetch(base + "/api/family/toolbox/file?member=raven&name=notes.txt", {
      method: "PUT", headers: { ...auth, "Content-Type": "text/plain" }, body: "测试原件",
    });
    assert.equal(upload.status, 201);
    const saved = await upload.json() as { artifact: string; id: string };
    const download = await fetch(base + "/api/family/artifact?member=raven&id=" + saved.artifact, { headers: auth });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "测试原件");
    assert.equal((await fetch(base + "/api/family/artifact?room=family&member=raven&id=" + saved.artifact, { headers: auth })).status, 404);
    assert.equal((await fetch(base + "/api/family?room=unregistered", { headers: auth })).status, 404);
    assert.equal((await fetch(base + "/api/family/artifact?member=mist&id=" + saved.artifact, { headers: auth })).status, 404);
    const forward = await fetch(base + "/api/family/toolbox/send?member=raven", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ id: saved.id, destination: "discord", requestId: "test-request-id" }),
    });
    assert.equal(forward.status, 202);
    assert.equal(dispatched[0]?.destination, "discord");
    assert.equal(dispatched[0]?.room, room);
    assert.equal(dispatched[0]?.file?.toString(), "测试原件");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await service.close();
    db.close();
  }
});
