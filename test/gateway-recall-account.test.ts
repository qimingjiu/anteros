import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../src/db/index.js";
import { Gateway } from "../src/gateway/index.js";
import { GroupKnowledge } from "../src/group-knowledge/index.js";
import type { GatewayEvent, MessageRecord, Provider } from "../src/types.js";

test("Gateway真实撤回事件传入协议账号，不撤回同群同消息ID的其他账号", t => {
  const db = new Database(":memory:"); t.after(() => db.close());
  for (const account of ["one", "two"]) {
    const message: MessageRecord = { eventKey: `${account}:group_100:message:1`, accountId: account, providerId: "onebot",
      conversationId: "group_100", groupId: "100", messageId: "1", senderId: "person", displayNameAtTime: "群友",
      sentAt: "2026-10-15T00:00:00.000Z", receivedAt: "2026-10-15T00:00:01.000Z", status: "active", origin: "live",
      segments: [{ type: "text", data: { text: `${account}的消息索引` } }], textContent: `${account}的消息索引` };
    db.insertMessage(message);
  }
  const knowledge = new GroupKnowledge(db);
  const gateway = new Gateway(db, {} as Provider, { accountId: "two", backfillMaxPages: 0, backfillPageLimit: 100 });
  const delivered: GatewayEvent[] = [];
  gateway.onEvent(event => delivered.push(event));
  const event: Extract<GatewayEvent, { kind: "recall" }> = { kind: "recall", accountId: "two", groupId: "100",
    conversationId: "group_100", messageId: "1", recalledAt: "2026-10-15T01:00:00.000Z" };
  (gateway as unknown as { handleEvent(event: GatewayEvent): void }).handleEvent(event);
  assert.equal(knowledge.search("one", "100", "索引").length, 1);
  assert.equal(knowledge.search("two", "100", "索引").length, 0);
  assert.equal(gateway.getStats().recalled, 1);
  assert.deepEqual(delivered, [event]);
  (gateway as unknown as { handleEvent(event: GatewayEvent): void }).handleEvent(event);
  assert.equal(gateway.getStats().recalled, 1, "重复撤回不重复计数和派发");
});
