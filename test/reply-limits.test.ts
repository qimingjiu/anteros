import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ConversationReplyLimits, isRepeatedReply, normalizeReplyText,
  type GroupReplyRequest,
} from "../src/agent/reply-limits.js";

const request = (overrides: Partial<GroupReplyRequest> = {}): GroupReplyRequest => ({
  accountId: "account", conversationId: "group_100", senderId: "12345",
  kind: "observation", receivedAt: 1_000_000, text: "今天晚上去吃什么？", ...overrides,
});

const firstReply = "群里刚才已经约好今晚七点去吃火锅，具体地点等发起人确认后再告诉大家。";

test("重复平台事件只消费一次，不误伤另一账号或会话相同消息编号", () => {
  let now = 1_000_000;
  const limits = new ConversationReplyLimits({ now: () => now });
  assert.equal(limits.claimEvent("account", "group_100", "message:1"), true);
  assert.equal(limits.claimEvent("account", "group_100", "message:1"), false);
  assert.equal(limits.claimEvent("account2", "group_100", "message:1"), true);
  assert.equal(limits.claimEvent("account", "group_200", "message:1"), true);
  now += 2 * 60 * 60_000;
  assert.equal(limits.claimEvent("account", "group_100", "message:1"), true);
});

test("环境接话与别人提及主人遵守30秒冷却，明确召唤和其他群不受冷却", () => {
  let now = 1_000_000;
  const limits = new ConversationReplyLimits({ now: () => now });
  assert.deepEqual(limits.canStart(request()), { allowed: true });
  limits.recordReply(request(), firstReply);
  now += 1000;
  assert.deepEqual(limits.canStart(request({ receivedAt: now })), { allowed: false, reason: "cooldown" });
  assert.deepEqual(limits.canStart(request({ kind: "direct", receivedAt: now })), { allowed: true });
  assert.deepEqual(limits.canStart(request({ kind: "owner_mention", receivedAt: now })), { allowed: false, reason: "cooldown" });
  assert.deepEqual(limits.canStart(request({ conversationId: "group_200", receivedAt: now })), { allowed: true });
  assert.deepEqual(limits.canStart(request({ accountId: "account2", receivedAt: now })), { allowed: true });
  now += 28_999;
  assert.deepEqual(limits.canStart(request({ receivedAt: now })), { allowed: false, reason: "cooldown" });
  now += 1;
  assert.deepEqual(limits.canStart(request({ receivedAt: now })), { allowed: true });
  assert.deepEqual(limits.canStart(request({ kind: "owner_mention", receivedAt: now })), { allowed: true });
});

test("普通自动接话十分钟最多三次，静默或失败不消耗次数，窗口边界准时恢复", () => {
  let now = 1_000_000;
  const limits = new ConversationReplyLimits({ now: () => now });
  for (let index = 0; index < 3; index++) {
    const input = request({ receivedAt: now });
    assert.deepEqual(limits.canStart(input), { allowed: true });
    assert.deepEqual(limits.canStart(input), { allowed: true });
    limits.recordReply(input, `${firstReply}${index}`);
    now += 60_000;
  }
  assert.deepEqual(limits.canStart(request({ receivedAt: now })), { allowed: false, reason: "window_limit" });
  assert.deepEqual(limits.canStart(request({ kind: "direct", receivedAt: now })), { allowed: true });
  now = 1_000_000 + 10 * 60_000;
  assert.deepEqual(limits.canStart(request({ receivedAt: now })), { allowed: true });
});

test("此前明确回复也让自动插话冷却，但不占自动接话窗口配额", () => {
  let now = 1_000_000;
  const limits = new ConversationReplyLimits({ now: () => now });
  for (let index = 0; index < 4; index++) {
    limits.recordReply(request({ kind: "direct", receivedAt: now }), firstReply);
    now += 60_000;
  }
  assert.deepEqual(limits.canStart(request({ receivedAt: now })), { allowed: true });
});

test("超过正文快照容量的显式问答不会挤掉十分钟内已经用满的自动接话配额", () => {
  let now = 1_000_000;
  const limits = new ConversationReplyLimits({ now: () => now });
  for (let index = 0; index < 3; index++) {
    limits.recordReply(request({ receivedAt: now }), `自动回答${index}`);
    now += 60_000;
  }
  for (let index = 0; index < 25; index++) {
    limits.recordReply(request({ kind: "direct", receivedAt: now }), `显式回答${index}`);
    now += 1000;
  }
  assert.equal(limits.recentReplies("account", "group_100").length, 20);
  assert.equal(limits.recentReplies("account", "group_100").some(reply => reply.kind === "observation"), false);
  now += 60_000;
  assert.deepEqual(limits.canStart(request({ receivedAt: now })), { allowed: false, reason: "window_limit" });
  now = 1_000_000 + 10 * 60_000;
  assert.deepEqual(limits.canStart(request({ receivedAt: now })), { allowed: true });
});

test("早于已完成回复的环境消息包括别人提及主人都被抛弃，明确召唤仍然保留", () => {
  let now = 1_000_000;
  const limits = new ConversationReplyLimits({ now: () => now });
  const queued = request({ receivedAt: now - 1000 });
  limits.recordReply(request({ kind: "direct" }), firstReply);
  now += 60_000;
  assert.deepEqual(limits.canStart(queued), { allowed: false, reason: "stale_observation" });
  assert.deepEqual(limits.canStart({ ...queued, kind: "direct" }), { allowed: true });
  assert.deepEqual(limits.canStart({ ...queued, kind: "owner_mention" }), { allowed: false, reason: "stale_observation" });
  assert.deepEqual(limits.canStart(request({ receivedAt: 1_000_000 })), { allowed: true });
});

test("重复提及主人先检查同人同意图，换人或新意图仍服从环境冷却，明确召唤豁免", () => {
  let now = 1_000_000;
  const limits = new ConversationReplyLimits({ now: () => now });
  const mention = request({ kind: "owner_mention", text: "朔朔，在吗？" });
  limits.recordReply(mention, "你找朔朔有什么事？");
  now += 1000;
  assert.deepEqual(limits.canStart({ ...mention, receivedAt: now, text: "朔朔在吗!" }),
    { allowed: false, reason: "repeated_owner_mention" });
  assert.deepEqual(limits.canStart({ ...mention, receivedAt: now, senderId: "54321" }), { allowed: false, reason: "cooldown" });
  assert.deepEqual(limits.canStart({ ...mention, receivedAt: now, text: "朔朔下午要交的文档准备好了吗" }), { allowed: false, reason: "cooldown" });
  assert.deepEqual(limits.canStart({ ...mention, receivedAt: now, kind: "direct" }), { allowed: true });
  now += 29_000;
  assert.deepEqual(limits.canStart({ ...mention, receivedAt: now, text: "朔朔下午要交的文档准备好了吗" }), { allowed: true });
  assert.deepEqual(limits.canStart({ ...mention, receivedAt: now }), { allowed: false, reason: "repeated_owner_mention" });
  now += 15_000;
  assert.deepEqual(limits.canStart({ ...mention, receivedAt: now }), { allowed: true });
});

test("别人提及主人与普通观察共享十分钟配额，机器人召唤不受已满配额约束", () => {
  let now = 1_000_000;
  const limits = new ConversationReplyLimits({ now: () => now });
  for (const kind of ["owner_mention", "observation", "owner_mention"] as const) {
    const input = request({ kind, receivedAt: now, text: `朔朔新问题${now}` });
    assert.deepEqual(limits.canStart(input), { allowed: true });
    limits.recordReply(input, `环境回答${now}`);
    now += 60_000;
  }
  for (const kind of ["owner_mention", "observation"] as const) {
    assert.deepEqual(limits.canStart(request({ kind, receivedAt: now, text: "新的主人提及" })),
      { allowed: false, reason: "window_limit" });
  }
  assert.deepEqual(limits.canStart(request({ kind: "direct", receivedAt: now })), { allowed: true });
  now = 1_000_000 + 10 * 60_000;
  assert.deepEqual(limits.canStart(request({ kind: "owner_mention", receivedAt: now, text: "另一个主人提及" })), { allowed: true });
});

test("自动接话不重复已经发过的长段落，标点变更与少量改写不能绕过", () => {
  const limits = new ConversationReplyLimits({ now: () => 1_000_000 });
  limits.recordReply(request({ kind: "direct" }), firstReply);
  for (const candidate of [
    firstReply,
    firstReply.replaceAll("，", "\n").replaceAll("。", "！"),
    `${firstReply}好的。`,
    firstReply.replace("告诉大家", "告知大家"),
  ]) {
    assert.deepEqual(limits.canSend(request(), candidate), { allowed: false, reason: "repeated_reply" }, candidate);
    assert.deepEqual(limits.canSend(request({ kind: "owner_mention" }), candidate), { allowed: false, reason: "repeated_reply" });
    assert.deepEqual(limits.canSend(request({ kind: "direct" }), candidate), { allowed: true });
  }
});

test("短确认、新信息和数值变化不被当成重复；其他会话与过期旧答案不影响发送", () => {
  let now = 1_000_000;
  const limits = new ConversationReplyLimits({ now: () => now });
  limits.recordReply(request(), firstReply);
  limits.recordReply(request({ kind: "direct" }), "好的");
  assert.deepEqual(limits.canSend(request(), "好的！"), { allowed: true });
  assert.deepEqual(limits.canSend(request(), "餐厅已经订好了，是附近新开的烤肉店，预约联系人会在半小时后发地址。"), { allowed: true });
  assert.deepEqual(limits.canSend(request({ conversationId: "group_200" }), firstReply), { allowed: true });
  const weather = "今天的天气预测是晴天，最高温度28度，最低温度18度，出门可以带一件薄外套。";
  assert.equal(isRepeatedReply(weather.replace("28", "29"), weather), false);
  assert.equal(isRepeatedReply(weather.replace("28", "2.8"), weather), false);
  now += 15 * 60_000;
  assert.deepEqual(limits.canSend(request({ receivedAt: now }), firstReply), { allowed: true });
});

test("从近期已发数据库记录恢复，乱序载入不把最近完成时间回退", () => {
  const now = 1_000_000;
  const limits = new ConversationReplyLimits({ now: () => now });
  limits.recordReply(request({ kind: "direct" }), firstReply, { sentAt: now - 10_000 });
  limits.recordReply(request({ kind: "direct" }), "旧记录", { sentAt: now - 80_000 });
  assert.deepEqual(limits.canStart(request({ receivedAt: now })), { allowed: false, reason: "cooldown" });
  assert.deepEqual(limits.canSend(request(), firstReply), { allowed: false, reason: "repeated_reply" });
  assert.deepEqual(limits.canStart(request({ receivedAt: now - 15_000 })), { allowed: false, reason: "stale_observation" });
});

test("注入配置控制冷却和窗口，Unicode与CQ信息不会绕过正文重复检查", () => {
  let now = 1_000_000;
  const limits = new ConversationReplyLimits({ now: () => now, cooldownMs: 2000, windowMs: 5000, maxRepliesPerWindow: 1 });
  limits.recordReply(request(), firstReply);
  now += 2000;
  assert.deepEqual(limits.canStart(request({ receivedAt: now })), { allowed: false, reason: "window_limit" });
  now += 3000;
  assert.deepEqual(limits.canStart(request({ receivedAt: now })), { allowed: true });
  assert.equal(normalizeReplyText("[CQ:reply,id=100][CQ:at,qq=123] ＡＢＣ，今天 好的！"), "abc今天好的");
  assert.equal(isRepeatedReply(`[CQ:at,qq=123]${firstReply}`, firstReply), true);
});

test("最新答复快照包括原请求人并隔离会话，读返回值不能修改限流状态", () => {
  let now = 1_000_000;
  const limits = new ConversationReplyLimits({ now: () => now });
  limits.recordReply(request({ kind: "direct", senderId: "12345" }), firstReply);
  now += 1000;
  limits.recordReply(request({ kind: "owner_mention", senderId: "54321" }), "你找朔朔有什么事？");
  const snapshot = limits.recentReplies("account", "group_100");
  assert.deepEqual(snapshot, [
    { text: "你找朔朔有什么事？", sentAt: now, kind: "owner_mention", senderId: "54321" },
    { text: firstReply, sentAt: now - 1000, kind: "direct", senderId: "12345" },
  ]);
  snapshot[1]!.text = "被外部改写";
  assert.equal(limits.recentReplies("account", "group_100")[1]?.text, firstReply);
  assert.deepEqual(limits.recentReplies("account2", "group_100"), []);
  assert.deepEqual(limits.recentReplies("account", "group_200"), []);
  now += 15 * 60_000;
  assert.deepEqual(limits.recentReplies("account", "group_100"), []);
});

test("近期答复数量、单条正文与活跃会话都有固定上限", () => {
  let now = 1_000_000;
  const limits = new ConversationReplyLimits({ now: () => now });
  for (let index = 0; index < 25; index++) {
    limits.recordReply(request(), "长".repeat(20_000));
    now += 1;
  }
  const replies = limits.recentReplies("account", "group_100");
  assert.equal(replies.length, 20);
  assert.equal(replies[0]?.text.length, 8000);
  for (let index = 0; index < 128; index++) {
    limits.recordReply(request({ conversationId: `group_${index + 1000}` }), firstReply);
    now += 1;
  }
  assert.deepEqual(limits.recentReplies("account", "group_100"), []);
  assert.equal(limits.recentReplies("account", "group_1127").length, 1);
});
