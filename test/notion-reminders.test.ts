import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/db/index.js";
import { NotionNotebook, type NotionEntry, type NotionScope } from "../src/tools/notion.js";
import { NotionReminderScheduler, nextReminderOccurrence, type NotionReminderInput, type ReminderRecurrence } from "../src/tools/notion-reminders.js";

const ROOT = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", OWNER = "1111111", GROUP = "3333333", ACCOUNT = "notion-reminder-test";
const START = Date.parse("2026-10-15T00:00:00Z"), DUE = new Date(START + 60_000).toISOString();
const priv: NotionScope = { requesterId: OWNER, conversationType: "private", targetId: OWNER };
const group: NotionScope = { requesterId: OWNER, conversationType: "group", targetId: GROUP };
function fixture(file = ":memory:") {
  const db = new Database(file), clock = { now: START }, groups = [GROUP];
  let sequence = 0;
  const notebook = new NotionNotebook({ apiKey: "fixture-private-token", rootPageId: ROOT }, { db, now: () => clock.now, minRequestIntervalMs: 0,
    fetch: (async (_input, init) => Response.json({ id: `bbbbbbbb-bbbb-4bbb-bbbb-${String(++sequence).padStart(12, "0")}`, parent: JSON.parse(String(init?.body)).parent })) as typeof fetch });
  const outbox = { throwOnce: false };
  const gateway = { enqueueSend(input: any) { const result = db.enqueueSendTask(input); if (outbox.throwOnce) { outbox.throwOnce = false; throw new Error("simulated crash during transaction"); } return result; } };
  const make = () => new NotionReminderScheduler({ db, gateway, accountId: ACCOUNT, ownerIds: [OWNER], allowedGroupIds: groups, now: () => clock.now });
  const scheduler = make();
  const save = (scope = priv) => notebook.save({ kind: "reminder", title: "给植物浇水", content: "阳台的小盆栽", dueAt: DUE }, scope, `entry-${sequence}`);
  const input = (entry: NotionEntry, scope = priv): NotionReminderInput => ({ entryId: entry.id, title: entry.title, notionUrl: entry.url, dueAt: entry.dueAt!, ...scope });
  return { db, clock, groups, notebook, outbox, make, scheduler, save, input };
}

test("Notion提醒：保存日期本身不投递，持久调度到期才入QQ outbox，重复tick/重启不重复", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save();
  assert.equal(f.db.pendingSendTasks(20).length, 0);
  const receipt = f.scheduler.schedule(f.input(entry)); assert.equal(receipt.delivery, "qq_server_scheduler"); assert.equal(receipt.status, "scheduled");
  await f.scheduler.tick(); assert.equal(f.db.pendingSendTasks(20).length, 0);
  f.clock.now += 60_000; await Promise.all([f.scheduler.tick(), f.scheduler.tick()]); await f.make().tick();
  const tasks = f.db.pendingSendTasks(20); assert.equal(tasks.length, 1); assert.equal(tasks[0]?.target_id, OWNER);
  const payload = JSON.parse(tasks[0]!.payload); assert.match(payload.segments[0].data.text, /给植物浇水/); assert.match(payload.segments[0].data.text, /notion.so/);
  assert.equal(payload.requesterId, OWNER); assert.equal(tasks[0]?.kind, "proactive_notion_reminder");
});

test("Notion提醒：owner限制、私聊不能换收件人、群必须allowlist；私聊条目可挂群提醒", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save(); const base = f.input(entry);
  for (const bad of [{ ...base, requesterId: "8888888", targetId: "8888888" }, { ...base, targetId: "8888888" }, { ...base, conversationType: "group" as const, targetId: "8888888" }]) assert.throws(() => f.scheduler.schedule(bad));
  const cross = f.scheduler.schedule({ ...base, conversationType: "group" as const, targetId: GROUP });
  assert.equal(cross.status, "scheduled", "私聊保存的条目也能挂白名单群提醒");
  const inGroup = await f.save(group); const receipt = f.scheduler.schedule(f.input(inGroup, group)); assert.equal(receipt.status, "scheduled");
  f.clock.now += 60_000; await f.scheduler.tick(); assert.equal(f.db.pendingSendTasks(20)[0]?.target_id, GROUP);
  assert.deepEqual(JSON.parse(f.db.pendingSendTasks(20)[0]!.payload).segments[0], { type: "at", data: { qq: OWNER } });
});

test("Notion提醒：不能伪造未创建条目、到期时间/标题/Notion地址", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save(); const base = f.input(entry);
  for (const bad of [{ ...base, entryId: "cccccccc-cccc-4ccc-cccc-cccccccccccc" }, { ...base, title: "改掉原始内容" }, { ...base, dueAt: new Date(START + 120_000).toISOString() }, { ...base, notionUrl: "https://example.com" }]) assert.throws(() => f.scheduler.schedule(bad));
  assert.equal(f.db.pendingSendTasks(20).length, 0);
});

test("Notion提醒：同条目重复schedule复用，禁止改路由造成私记泄漏", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save(group);
  const first = f.scheduler.schedule(f.input(entry, group)), second = f.scheduler.schedule(f.input(entry, group)); assert.deepEqual(first, second);
  assert.throws(() => f.scheduler.schedule(f.input(entry, priv)));
  const row = f.db.db.prepare("SELECT COUNT(*) AS n FROM notion_reminders").get() as { n: number }; assert.equal(row.n, 1);
});

test("Notion提醒：到期后权限撤销、条目完成会取消，不发群消息", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save(group); f.scheduler.schedule(f.input(entry, group));
  f.groups.splice(0); f.clock.now += 60_000; await f.scheduler.tick(); assert.equal(f.db.pendingSendTasks(20).length, 0);
  const status = f.db.db.prepare("SELECT status FROM notion_reminders").get() as { status: string }; assert.equal(status.status, "cancelled");
});

test("Notion提醒：完成/取消可取消已经排队尚未投递的outbox", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save(); f.scheduler.schedule(f.input(entry));
  f.clock.now += 60_000; await f.scheduler.tick(); assert.equal(f.db.pendingSendTasks(20).length, 1);
  assert.equal(f.scheduler.cancel(entry.id), true); assert.equal(f.scheduler.cancel(entry.id), false); assert.equal(f.db.pendingSendTasks(20).length, 0);
  const task = f.db.sendTaskById(1); assert.equal(task?.status, "failed"); assert.equal(task?.last_error, "提醒已取消");
});

test("Notion提醒：事务中断同时回滚outbox和状态，后续tick安全恢复", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save(); f.scheduler.schedule(f.input(entry));
  f.outbox.throwOnce = true; f.clock.now += 60_000; await f.scheduler.tick(); assert.equal(f.db.pendingSendTasks(20).length, 0);
  const row = f.db.db.prepare("SELECT status FROM notion_reminders").get() as { status: string }; assert.equal(row.status, "scheduled");
  assert.equal(f.scheduler.status().healthy, false); assert.equal((f.scheduler.status().lastFailure as any).reason, "outbox_error");
  await f.scheduler.tick(); assert.equal(f.db.pendingSendTasks(20).length, 0);
  f.clock.now += 5000; await f.scheduler.tick(); assert.equal(f.db.pendingSendTasks(20).length, 1); assert.equal(f.scheduler.status().healthy, true);
});

test("Notion提醒：网关重启时结果不明的发送不重发，避免重复提醒", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save(); f.scheduler.schedule(f.input(entry)); f.clock.now += 60_000; await f.scheduler.tick();
  const task = f.db.pendingSendTasks(20)[0]!; f.db.claimSendTask(task.id);
  const reset = f.db.resetInFlightTasks(); assert.equal(reset.unknowned, 1); assert.equal(f.db.sendTaskById(task.id)?.status, "unknown");
  await f.make().tick(); assert.equal(f.db.pendingSendTasks(20).length, 0);
  assert.equal((f.scheduler.status().deliveryCounts as any).unknown, 1); assert.equal(f.scheduler.status().healthy, false);
});

test("Notion提醒：SQLite关闭重开仍可恢复到期提醒，补送只创建一个任务", async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qq-notion-reminder-")));
  const file = path.join(dir, "db.sqlite"), f = fixture(file), entry = await f.save(); f.scheduler.schedule(f.input(entry)); f.db.close();
  const db = new Database(file); t.after(() => { db.close(); assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const gateway = { enqueueSend: (input: any) => db.enqueueSendTask(input) };
  const scheduler = new NotionReminderScheduler({ db, gateway, accountId: ACCOUNT, ownerIds: [OWNER], allowedGroupIds: [GROUP], now: () => START + 3600_000 });
  await scheduler.tick(); await scheduler.tick(); const task = db.pendingSendTasks(20); assert.equal(task.length, 1); assert.match(task[0]!.payload, /服务器恢复后补送/);
});

const daily: ReminderRecurrence = { frequency: "daily", time: "08:01", timezone: "Asia/Shanghai" };
function remoteScheduler(f: ReturnType<typeof fixture>, check: (id: string, scope: NotionScope) => Promise<boolean>) {
  return new NotionReminderScheduler({ db: f.db, gateway: { enqueueSend: (input: any) => f.db.enqueueSendTask(input) },
    accountId: ACCOUNT, ownerIds: [OWNER], allowedGroupIds: f.groups, now: () => f.clock.now, notebook: { completionStatus: check } });
}

test("循环提醒：按本地时区计算每天/每周，不接受无效规则或无限间隔", () => {
  assert.equal(nextReminderOccurrence(daily, START), DUE);
  assert.equal(nextReminderOccurrence(daily, Date.parse(DUE)), "2026-10-16T00:01:00.000Z");
  assert.equal(nextReminderOccurrence({ frequency: "weekly", weekday: 7, time: "21:00", timezone: "Asia/Shanghai" }, START), "2026-10-18T13:00:00.000Z");
  for (const rule of [{ ...daily, time: "24:00" }, { ...daily, timezone: "Moon/Base" }, { ...daily, frequency: "hourly" }, { ...daily, frequency: "weekly" }, { ...daily, frequency: "weekly", weekday: 8 }]) assert.throws(() => nextReminderOccurrence(rule as ReminderRecurrence, START));
});

test("循环提醒：夏令时保留本地钟点，跳过不存在的小时并处理重复小时", () => {
  const rule: ReminderRecurrence = { frequency: "daily", time: "02:30", timezone: "America/New_York" };
  assert.equal(nextReminderOccurrence(rule, Date.parse("2026-03-08T05:00:00Z")), "2026-03-09T06:30:00.000Z");
  assert.equal(nextReminderOccurrence({ ...rule, time: "01:30" }, Date.parse("2026-11-01T05:45:00Z")), "2026-11-02T06:30:00.000Z");
  assert.equal(nextReminderOccurrence(rule, Date.parse("2026-11-01T08:00:00Z")), "2026-11-02T07:30:00.000Z");
});

test("循环提醒：保存一条规则，重复tick和重启不重复，下次周期继续", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save();
  await f.scheduler.manage({ action: "repeat", entryId: entry.id, recurrence: daily }, priv, "repeat-1");
  f.clock.now += 60_000; await f.scheduler.tick(); await f.make().tick();
  assert.equal(f.db.pendingSendTasks(20).length, 1);
  let list = await f.scheduler.manage({ action: "list" }, priv); assert.equal((list.reminders as any[])[0].dueAt, "2026-10-16T00:01:00.000Z");
  f.clock.now += 86400_000; await f.make().tick();
  assert.equal(f.db.pendingSendTasks(20).length, 2);
  assert.notEqual(f.db.pendingSendTasks(20)[0]!.task_key, f.db.pendingSendTasks(20)[1]!.task_key);
});

test("循环提醒：unknown不重发当次，不阻止下一次；恢复多天只补一条", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save();
  await f.scheduler.manage({ action: "repeat", entryId: entry.id, recurrence: daily }, priv);
  f.clock.now += 60_000; await f.scheduler.tick(); f.db.claimSendTask(1); f.db.resetInFlightTasks();
  await f.make().tick(); assert.equal(f.db.pendingSendTasks(20).length, 0);
  f.clock.now += 10 * 86400_000; await f.make().tick(); await f.make().tick();
  assert.equal(f.db.pendingSendTasks(20).length, 1);
  assert.equal((f.scheduler.status().deliveryCounts as any).unknown, 1);
  const list = await f.scheduler.manage({ action: "list" }, priv); assert.equal((list.reminders as any[])[0].dueAt, "2026-10-26T00:01:00.000Z");
});

test("循环提醒：延期只动一次，第二天固定钟点不变", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save();
  await f.scheduler.manage({ action: "repeat", entryId: entry.id, recurrence: daily }, priv);
  const until = new Date(START + 11 * 60_000).toISOString();
  await f.scheduler.manage({ action: "snooze", entryId: entry.id, until }, priv, "snooze-1");
  f.clock.now += 60_000; await f.scheduler.tick(); assert.equal(f.db.pendingSendTasks(20).length, 0);
  f.clock.now += 10 * 60_000; await f.scheduler.tick(); assert.equal(f.db.pendingSendTasks(20).length, 1);
  const list = await f.scheduler.manage({ action: "list" }, priv); assert.equal((list.reminders as any[])[0].dueAt, "2026-10-16T00:01:00.000Z");
});

test("循环提醒：已收到后十分钟再叫我，不改变明天周期", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save();
  await f.scheduler.manage({ action: "repeat", entryId: entry.id, recurrence: daily }, priv);
  f.clock.now += 60_000; await f.scheduler.tick(); f.db.finishSendTask(1, "confirmed");
  const until = new Date(f.clock.now + 600_000).toISOString();
  await f.scheduler.manage({ action: "snooze", entryId: entry.id, until }, priv, "again");
  f.clock.now += 600_000; await f.scheduler.tick(); assert.equal(f.db.pendingSendTasks(20).length, 1);
  const list = await f.scheduler.manage({ action: "list" }, priv); assert.equal((list.reminders as any[])[0].dueAt, "2026-10-16T00:01:00.000Z");
});

test("循环提醒：跳过下一次的动作幂等，取消会撤销所有queued投递", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save();
  await f.scheduler.manage({ action: "repeat", entryId: entry.id, recurrence: daily }, priv);
  const action = { action: "skip_next" as const, entryId: entry.id };
  const first = await f.scheduler.manage(action, priv, "skip-one");
  assert.deepEqual(await f.make().manage(action, priv, "skip-one"), first);
  assert.equal(first.dueAt, "2026-10-16T00:01:00.000Z");
  f.clock.now = Date.parse(String(first.dueAt)); await f.scheduler.tick();
  f.clock.now += 86400_000; await f.scheduler.tick(); assert.equal(f.db.pendingSendTasks(20).length, 2);
  await f.scheduler.manage({ action: "cancel", entryId: entry.id }, priv); assert.equal(f.db.pendingSendTasks(20).length, 0);
  assert.equal(f.scheduler.status().healthy, true);
});

test("提醒管理：提醒不按会话隔离，本人随处可管；其他人不能修改", async t => {
  const f = fixture(); t.after(() => f.db.close()); const privateEntry = await f.save(); f.scheduler.schedule(f.input(privateEntry));
  assert.equal(((await f.scheduler.manage({ action: "list" }, group)).reminders as any[]).length, 1, "群里也能列出本人私聊提醒");
  await assert.rejects(f.scheduler.manage({ action: "cancel", entryId: privateEntry.id }, { ...priv, requesterId: "8888888", targetId: "8888888" }));
  await f.scheduler.manage({ action: "cancel", entryId: privateEntry.id }, group);
  const groupEntry = await f.save(group); f.scheduler.schedule(f.input(groupEntry, group));
  await f.scheduler.manage({ action: "cancel", entryId: groupEntry.id }, priv);
  assert.equal(((await f.scheduler.manage({ action: "list" }, priv)).reminders as any[]).length, 2);
});

test("Notion同步：手工勾选完成自动取消循环和待发消息，重启后仍取消", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save();
  await f.scheduler.manage({ action: "repeat", entryId: entry.id, recurrence: daily }, priv);
  f.clock.now += 60_000; await f.scheduler.tick(); assert.equal(f.db.pendingSendTasks(20).length, 1);
  const synced = remoteScheduler(f, async (id, scope) => { assert.equal(id, entry.id); assert.deepEqual(scope, priv); return true; });
  await synced.tick(); assert.equal(f.db.pendingSendTasks(20).length, 0);
  f.clock.now += 86400_000; await f.make().tick(); assert.equal(f.db.pendingSendTasks(20).length, 0);
  assert.equal(f.notebook.list({}, priv)[0]?.completed, true);
});

test("Notion同步：到期前核验远端，不依赖五分钟后台轮询", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save(); f.scheduler.schedule(f.input(entry));
  let completed = false, calls = 0;
  const synced = remoteScheduler(f, async () => { calls++; return completed; });
  await synced.tick(); assert.equal(calls, 1);
  completed = true; f.clock.now += 60_000; await synced.tick();
  assert.equal(calls, 2); assert.equal(f.db.pendingSendTasks(20).length, 0);
});

test("Notion同步：失败保留提醒，两分钟宽限后明确标注未同步，失败限频", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save(); f.scheduler.schedule(f.input(entry));
  let calls = 0; const synced = remoteScheduler(f, async () => { calls++; throw new Error("private upstream fixture must never be logged"); });
  f.clock.now += 60_000; await synced.tick(); await synced.tick();
  assert.equal(calls, 1); assert.equal(f.db.pendingSendTasks(20).length, 0); assert.equal(synced.status().healthy, false);
  f.clock.now += 120_000; await synced.tick(); assert.equal(f.db.pendingSendTasks(20).length, 1); assert.match(f.db.pendingSendTasks(20)[0]!.payload, /完成状态暂未同步/);
  assert(!JSON.stringify(synced.status()).includes("private upstream"));
});

test("Notion同步：跨实例竞争时远端I/O后的重新检查保证只入队一次", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save();
  await f.scheduler.manage({ action: "repeat", entryId: entry.id, recurrence: daily }, priv);
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const one = remoteScheduler(f, async () => { await barrier; return false; }), two = remoteScheduler(f, async () => { release(); return false; });
  f.clock.now += 60_000; await Promise.all([one.tick(), two.tick()]);
  assert.equal(f.db.pendingSendTasks(20).length, 1);
});

test("Notion同步：I/O期间被用户取消时不发送，停止后不再工作", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save(); f.scheduler.schedule(f.input(entry));
  const synced = remoteScheduler(f, async () => { f.scheduler.cancel(entry.id); return false; });
  f.clock.now += 60_000; await synced.tick(); assert.equal(f.db.pendingSendTasks(20).length, 0);
  synced.start(); await synced.stop(); assert.equal(synced.status().schedulerRunning, false);
  await synced.tick(); assert.equal(f.db.pendingSendTasks(20).length, 0);
});

test("Notion同步：后台轮询每账号五分钟最多30项，重启/第二实例不加倍", async t => {
  const f = fixture(); t.after(() => f.db.close());
  for (let i = 0; i < 35; i++) {
    const entry = await f.save(); await f.scheduler.manage({ action: "repeat", entryId: entry.id, recurrence: { ...daily, time: "23:00" } }, priv);
  }
  let calls = 0; const check = async () => { calls++; return false; };
  await remoteScheduler(f, check).tick(); assert.equal(calls, 30);
  await remoteScheduler(f, check).tick(); assert.equal(calls, 30);
  f.clock.now += 299_999; await remoteScheduler(f, check).tick(); assert.equal(calls, 30);
  f.clock.now += 1; await remoteScheduler(f, check).tick(); assert.equal(calls, 60);
});

test("Notion同步：等待远端期间撤销群权限也不能漏发群提醒", async t => {
  const f = fixture(); t.after(() => f.db.close()); const entry = await f.save(group); f.scheduler.schedule(f.input(entry, group));
  const synced = remoteScheduler(f, async () => { f.groups.splice(0); return false; });
  f.clock.now += 60_000; await synced.tick(); assert.equal(f.db.pendingSendTasks(20).length, 0);
  assert.equal(((await f.scheduler.manage({ action: "list" }, priv)).reminders as any[])[0].status, "cancelled");
});
