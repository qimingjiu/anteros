import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PersonaSwitcher } from "../src/agent/persona-switch.js";
import { Database } from "../src/db/index.js";
import { FamilyRooms } from "../src/family/rooms.js";
import { PrivateTranscript } from "../src/family/transcript.js";
import type { MessageRecord } from "../src/types.js";

const homeId = "family:qq:100";
const peers = [
  { accountId: "qq", ownerIds: ["100"], botId: () => "101" },
  { accountId: "dc", ownerIds: ["200"], botId: () => "201" },
  { accountId: "tg", ownerIds: ["300"], botId: () => "301" },
];

function fixtures() {
  const db = new Database(":memory:");
  const directory = mkdtempSync(path.join(tmpdir(), "anteros-family-rooms-"));
  mkdirSync(path.join(directory, "personas"));
  for (const [id, name, alias] of [["mist", "雾岛纪", "阿雾"], ["moon", "月照", "月"]]) {
    writeFileSync(path.join(directory, "personas", id + ".md"),
      ["---", "id: " + id, "name: " + name, "aliases: " + alias, "---", name + "的设定"].join("\n"));
  }
  const createSwitcher = () => new PersonaSwitcher(directory,
    { persona: { name: "κόραξ", prompt: "客厅主人格", file: path.join(directory, "persona.md") } });
  const switcher = createSwitcher();
  const createRooms = () => new FamilyRooms(db, { homeId, catalog: () => switcher.list(),
    isOwner: message => peers.some(peer => peer.accountId === message.accountId && peer.ownerIds.includes(message.senderId)) });
  const rooms = createRooms();
  let sequence = 0;
  const insert = (accountId: string, senderId: string, text: string, changes: Partial<MessageRecord> = {}): MessageRecord => {
    const id = String(++sequence);
    const at = new Date(Date.parse("2026-11-20T10:00:00.000Z") + sequence * 1000).toISOString();
    const row: MessageRecord = {
      eventKey: accountId + ":" + id, accountId, providerId: accountId, conversationId: "private_" + senderId,
      messageId: id, senderId, displayNameAtTime: senderId, sentAt: at, receivedAt: at, origin: "live",
      textContent: text, segments: [{ type: "text", data: { text } }], status: "active", ...changes,
    };
    db.insertMessage(row);
    return row;
  };
  return {
    db, rooms, switcher, createSwitcher, createRooms, insert,
    close: () => { db.close(); rmSync(directory, { force: true, recursive: true }); },
  };
}

test("room selection is shared by bound three-platform owner and each source stays in its first room", () => {
  const fixture = fixtures();
  const { rooms, insert, createRooms } = fixture;
  try {
    const qq = insert("qq", "100", "/房间 创建 书房 | 阿雾、月");
    const created = rooms.handle(qq);
    assert.ok(created);
    assert.notEqual(created.roomId, homeId);
    assert.deepEqual(rooms.get(created.roomId)?.memberIds, ["mist", "moon"]);
    assert.equal(rooms.roomFor(qq), homeId);

    const discord = insert("dc", "200", "我在书房");
    assert.equal(rooms.assign(discord), created.roomId);
    const telegram = insert("tg", "300", "/房间 进入 客厅");
    assert.equal(rooms.handle(telegram)?.roomId, homeId);
    assert.equal(rooms.roomFor(telegram), created.roomId);
    assert.equal(rooms.handle(qq)?.roomId, created.roomId, "replay returns original acknowledgement");
    assert.equal(createRooms().current().id, homeId, "replay cannot move the current room");
    assert.equal(rooms.assign(discord), created.roomId, "older source keeps its room after owner switches");

    const nonOwner = insert("dc", "100", "/房间 进入 书房");
    assert.equal(rooms.handle(nonOwner), null);
    const group = insert("qq", "100", "/房间 进入 书房", { groupId: "88", conversationId: "group_88" });
    assert.equal(rooms.assign(group), undefined);
    assert.equal(rooms.current().id, homeId);
  } finally {
    fixture.close();
  }
});

test("room persona choices, handoff notes and member lists stay separate through reload", () => {
  const fixture = fixtures();
  const { rooms, switcher, createSwitcher, insert } = fixture;
  try {
    const created = rooms.handle(insert("qq", "100", "/房间 创建 书房 | 阿雾、月"))!;
    const members = () => rooms.get(created.roomId)!.memberIds;
    const workroom = switcher.forRoom(members, rooms.personaState(created.roomId));
    assert.equal(workroom.active().id, "mist");
    assert.equal(workroom.handle("让κόραξ来"), null);
    assert.equal(workroom.handle("让月照来")?.changed?.id, "moon");
    workroom.setHandoff("雾岛纪", "moon", "只有书房的便签");
    assert.equal(switcher.active().id, "koraks");
    assert.doesNotMatch(switcher.promptOf(switcher.active()), /只有书房/);
    const reloaded = createSwitcher().forRoom(members, rooms.personaState(created.roomId));
    assert.equal(reloaded.active().id, "moon");
    assert.match(reloaded.promptOf(reloaded.active()), /只有书房的便签/);
    rooms.handle(insert("tg", "300", "/房间 成员 阿雾"));
    assert.equal(reloaded.active().id, "mist");
    assert.doesNotMatch(reloaded.promptOf(reloaded.active()), /只有书房/);
  } finally {
    fixture.close();
  }
});

test("ranked recall backfills old home history and returns only sourced turns from the selected private room", () => {
  const fixture = fixtures();
  const { db, rooms, insert } = fixture;
  try {
    const old = insert("qq", "100", "客厅原话 探测报告也有内容");
    const linked = new PrivateTranscript(db, peers, { rooms });
    const created = rooms.handle(insert("qq", "100", "/房间 创建 书房 | 雾岛纪"))!;
    const older = insert("tg", "300", "记住火星探测报告要用落款A");
    rooms.assign(older);
    const recentPartial = insert("dc", "200", "这里还有另一份火星资料");
    rooms.assign(recentPartial);
    const answer = insert("tg", "301", "落款A 已记下", { conversationId: "private_300", displayNameAtTime: "雾岛纪" });
    rooms.recordMessage(answer.eventKey, created.roomId, older.eventKey);
    const fake = insert("qq", "666", "火星探测报告 这条无权召回", { conversationId: "private_100" });
    rooms.recordMessage(fake.eventKey, created.roomId);
    const publicCopy = insert("tg", "300", "火星探测报告 公开材料", { groupId: "-999", conversationId: "group_-999" });
    rooms.recordMessage(publicCopy.eventKey, created.roomId);

    const prompt = insert("qq", "100", "火星探测报告");
    rooms.assign(prompt);
    const hits = linked.recall(prompt, "火星探测报告", { limit: 4, excludeCurrent: true });
    assert.equal(hits[0]?.hit.eventKey, older.eventKey, "older exact title outranks newer partial mention");
    assert.deepEqual(hits[0]?.turn.map(row => row.eventKey), [older.eventKey, answer.eventKey]);
    assert.equal(hits[0]?.turn[1]?.author, "雾岛纪");
    assert.ok(hits.some(candidate => candidate.hit.eventKey === recentPartial.eventKey));
    assert.ok(!hits.some(candidate => [old.eventKey, fake.eventKey, publicCopy.eventKey].includes(candidate.hit.eventKey)));

    rooms.handle(insert("dc", "200", "/房间 进入 客厅"));
    const homePrompt = insert("tg", "300", "找探测报告");
    rooms.assign(homePrompt);
    assert.equal(linked.search(homePrompt, "探测报告", { limit: 2, excludeCurrent: true })[0]?.eventKey, old.eventKey);
    assert.equal(linked.search(homePrompt, "落款A").length, 0);
    assert.equal(rooms.messageInRoom(homePrompt, answer.eventKey), false);
  } finally {
    fixture.close();
  }
});

test("as-of-source recall keeps earlier same-second history and ignores unassigned later ingress", () => {
  const fixture = fixtures();
  const { db, rooms, insert } = fixture;
  try {
    const linked = new PrivateTranscript(db, peers, { rooms });
    const at = "2026-11-20T10:10:00.000Z";
    const earlier = insert("dc", "200", "甲阶段探测报告", { sentAt: at });
    rooms.assign(earlier);
    const source = insert("qq", "100", "我的当前问题", { sentAt: at });
    rooms.assign(source);
    const later = insert("tg", "300", "下一条尚未分房间的探测报告", { sentAt: at });
    assert.ok(linked.search(source, "探测报告").some(row => row.eventKey === later.eventKey));
    assert.deepEqual(linked.search(source, "探测报告", { asOfSource: true }).map(row => row.eventKey), [earlier.eventKey]);
    assert.deepEqual(linked.recent(source, { asOfSource: true, excludeCurrent: true }).map(row => row.eventKey), [earlier.eventKey]);
    assert.ok(!linked.recall(source, "探测报告", { asOfSource: true }).flatMap(result => result.turn)
      .some(row => row.eventKey === later.eventKey));
  } finally {
    fixture.close();
  }
});
