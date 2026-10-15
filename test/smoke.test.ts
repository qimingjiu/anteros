/**
 * 端到端冒烟测试：进程内 Fake Provider（模拟 OneBot 协议端）+ Mock 模型。
 * 验证：接入 → 持久化/去重 → Agent 触发与回复 → 指令 → 日报生成与投递 → 崩溃恢复语义。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "../src/db/index.js";
import { Gateway } from "../src/gateway/index.js";
import { MockLLMClient } from "../src/llm/index.js";
import { Agent } from "../src/agent/index.js";
import { SqliteMemory } from "../src/memory/index.js";
import { ReportEngine } from "../src/report/index.js";
import { McpManager } from "../src/tools/mcp.js";
import type { AppConfig } from "../src/config.js";
import type {
  CapabilityMap,
  GatewayEvent,
  MessageRecord,
  MessageSegment,
  NormalizedIncomingMessage,
  Provider,
  ProviderHealth,
  SendResult,
} from "../src/types.js";
import { sleep } from "../src/util/misc.js";

class FakeProvider implements Provider {
  readonly providerId = "onebot";
  eventCbs: ((ev: GatewayEvent) => void)[] = [];
  sentGroups: { groupId: string; segments: MessageSegment[] }[] = [];
  sentPrivates: { userId: string; segments?: MessageSegment[]; file?: { filePath: string; fileName: string } }[] = [];
  healthState: ProviderHealth = { connection: "connected", login: "online", selfId: "bot001", reconnectCount: 0 };

  onEvent(cb: (ev: GatewayEvent) => void): void {
    this.eventCbs.push(cb);
  }
  emit(ev: GatewayEvent): void {
    for (const cb of this.eventCbs) cb(ev);
  }
  start(): void {}
  async stop(): Promise<void> {}
  health(): ProviderHealth {
    return this.healthState;
  }
  capabilities(): CapabilityMap {
    return {
      receiveMessages: "supported",
      sendText: "supported",
      sendImage: "unverified",
      sendPrivateFile: "unverified",
      groupHistory: "unsupported",
    };
  }
  async sendGroupMsg(groupId: string, segments: MessageSegment[]): Promise<SendResult> {
    this.sentGroups.push({ groupId, segments });
    return { status: "confirmed", messageId: String(1000 + this.sentGroups.length) };
  }
  async sendPrivateMsg(userId: string, segments: MessageSegment[]): Promise<SendResult> {
    this.sentPrivates.push({ userId, segments });
    return { status: "confirmed", messageId: String(2000 + this.sentPrivates.length) };
  }
  async sendPrivateFile(userId: string, filePath: string, fileName: string): Promise<SendResult> {
    this.sentPrivates.push({ userId, file: { filePath, fileName } });
    return { status: "confirmed" };
  }
  inject(record: Omit<MessageRecord, "eventKey" | "accountId" | "providerId" | "receivedAt" | "status" | "origin">): void {
    const full: MessageRecord = {
      ...record,
      eventKey: `acct:group_${record.groupId}:message:${record.messageId}`,
      accountId: "acct",
      providerId: "onebot",
      receivedAt: new Date().toISOString(),
      status: "active",
      origin: "live",
    };
    this.emit({ kind: "message", message: full });
  }
}

function baseConfig(outputDir: string, recipientIds: string[]): AppConfig {
  return {
    timezone: "Asia/Shanghai",
    persona: { name: "", prompt: "", file: "" },
    database: { path: "unused" },
    gateway: {
      provider: "onebot",
      accountId: "acct",
      onebot: {
        endpoint: "ws://127.0.0.1:1",
        tokenEnv: "",
        accessToken: "",
        reconnectBaseMs: 100,
        reconnectMaxMs: 1000,
        heartbeatTimeoutFactor: 2.5,
        requestTimeoutMs: 5000,
        privateFileAction: "upload_private_file",
        historyAction: "get_group_msg_history",
        backfillMaxPages: 0,
        backfillPageLimit: 100,
      },
    },
    groups: {
      allowlist: ["100"],
      replyMode: "mention_or_reply",
      linkPreview: false,
      linkPreviewCooldownMinutes: 1,
      maxReplyChars: 1200,
    },
    model: {
      provider: "mock",
      baseUrl: "",
      apiKey: "",
      model: "mock",
      fallbackModel: "",
      summaryModel: "",
      temperature: 0.7,
      maxContextChars: 6000,
      maxOutputChars: 2000,
      requestTimeoutMs: 5000,
      profiles: [],
    },
    memory: { enabled: true, rawRetentionDays: 30, isolateByGroup: true, topicGapMinutes: 1, extraction: "rules", maxFactsPerTopic: 6 },
    reports: {
      enabled: true,
      schedule: "0 0 1 1 *",
      period: "today_until_run",
      outputDir,
      recipientIds,
      maxDeliveryAttempts: 3,
      groups: ["100"],
    },
    tools: {
      enabled: false,
      search: { provider: "none", tavilyApiKey: "", googleCse: { apiKey: "", cx: "" }, maxResults: 5, timeoutMs: 5000 },
      reader: { enabled: false, timeoutMs: 5000, maxBytes: 100000, maxChars: 1000 },
      browserConcurrency: 1,
      privateToolsOwnerOnly: true,
      mcp: { enabled: false, connectTimeoutMs: 1000, callTimeoutMs: 5000, servers: [] },
    },
    web: { enabled: false, host: "127.0.0.1", port: 0, token: "" },
    admins: ["admin001"],
    logging: { level: "error", dir: "" },
  };
}

function groupMsg(messageId: string, text: string, senderId = "u1", senderName = "小明", at?: string) {
  const segments: MessageSegment[] = senderId === "u_at_bot"
    ? [
        { type: "at", data: { qq: "bot001" } },
        { type: "text", data: { text } },
      ]
    : [{ type: "text", data: { text } }];
  return {
    conversationId: "group_100",
    groupId: "100",
    messageId,
    senderId,
    displayNameAtTime: senderName,
    sentAt: at ?? new Date().toISOString(),
    replyToMessageId: undefined,
    segments,
    textContent: text,
  };
}

test("端到端：@触发回复、去重、指令、日报与投递", async context => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botsmoke-"));
  const db = new Database(path.join(tmp, "bot.db"));
  const provider = new FakeProvider();
  const gateway = new Gateway(db, provider, { accountId: "acct", backfillMaxPages: 0, backfillPageLimit: 100 });
  const llm = new MockLLMClient("好的，收到「{text}」");
  const memory = new SqliteMemory(db, baseConfig(tmp, []).memory, llm);
  const agent = new Agent({
    db,
    cfg: baseConfig(path.join(tmp, "reports"), ["u9"]),
    gateway,
    llm,
    memory,
    search: null,
    reader: null,
    mcp: new McpManager({ enabled: false, connectTimeoutMs: 100, callTimeoutMs: 1000, servers: [] }),
    timezone: "Asia/Shanghai",
  });
  const reportEngine = new ReportEngine(db, baseConfig(path.join(tmp, "reports"), ["u9"]).reports, "Asia/Shanghai", gateway, llm);
  let recoveredGateway: Gateway | undefined;
  context.after(async () => {
    await recoveredGateway?.stop();
    await gateway.stop();
    memory.stop();
    reportEngine.stop();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  agent.setReportEngine(reportEngine);
  agent.attach();
  gateway.start();

  // 1. 普通消息：正常入库，是否接话由主模型决定
  provider.inject(groupMsg("1", "今天天气不错"));
  await sleep(200);
  assert.equal(db.messageCountInRange("100", "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"), 1);

  // 2. 重复事件：去重
  provider.inject(groupMsg("1", "今天天气不错"));
  await sleep(100);
  assert.equal(db.messageCountInRange("100", "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"), 1, "重复事件不重复入库");

  // 3. @机器人：触发回复
  provider.inject(groupMsg("2", "今天怎么安排", "u_at_bot", "小张"));
  await sleep(2500); // 等待合并窗口 + mock LLM + 发送队列
  const triggerTask = db.recentSendTasks(20).find(task => task.task_key === "reply:acct:group_100:message:2:0");
  assert.ok(triggerTask, "当前 @ 消息应产生对应的回复任务");
  assert.equal(triggerTask.status, "confirmed");
  assert.equal(triggerTask.target_id, "100");
  const reply = provider.sentGroups.find(group => group.segments.some(segment => segment.type === "reply" && segment.data.id === "2"));
  assert.ok(reply, "协议端应收到引用当前 @ 消息的回复");
  assert.equal(reply.groupId, "100");
  const text = reply.segments.find((s) => s.type === "text");
  assert.ok(text && text.type === "text" && text.data.text.includes("今天怎么安排"), "回复应包含对触发内容的响应");

  // 4. /帮助 指令
  provider.inject(groupMsg("3", "/帮助"));
  await sleep(800);
  assert.ok(provider.sentGroups.some((g) => g.segments.some((s) => s.type === "text" && s.data.text.includes("/日报"))), "应回复帮助文本");

  // 5. 未启用群不响应
  provider.inject({ ...groupMsg("4", "@bot001 在吗"), groupId: "999", conversationId: "group_999" });
  await sleep(800);
  assert.ok(!provider.sentGroups.some((g) => g.groupId === "999"), "未启用群不应回复");

  // 6. /日报 指令：生成日报 + 给请求者建投递
  provider.inject(groupMsg("5", "/日报", "admin001", "管理员"));
  await sleep(1500);
  const reports = db.recentReports(10);
  assert.ok(reports.length >= 1, "应生成日报记录");
  const report = reports[0]!;
  assert.equal(report.status, "generated");
  assert.ok(report.file_path && fs.existsSync(report.file_path), "日报文件应存在");
  const md = fs.readFileSync(report.file_path!, "utf-8");
  assert.ok(md.includes("群聊日报"), "日报应包含标题");
  assert.ok(md.includes("小张") || md.includes("小明"), "日报应包含成员");

  // 给配置收件人的投递任务已建立
  await sleep(1000); // 投递 tick 3s，先检查任务入队
  const deliveries = db.recentDeliveries(10);
  assert.ok(deliveries.length >= 1, "应建立投递任务");

  // 7. 撤回事件
  provider.emit({ kind: "recall", accountId: "acct", conversationId: "group_100", groupId: "100", messageId: "1", recalledAt: new Date().toISOString() });
  const row = db.getMessageById("group_100", "1");
  assert.equal(row?.status, "recalled");

  // 8. 崩溃恢复语义：重启后 in_flight report 任务标 unknown
  const t = db.enqueueSendTask({ taskKey: "report_delivery:x:u9:a0", kind: "report_file", conversationType: "private", targetId: "u9", payload: { kind: "file", filePath: "x.md", fileName: "x.md" } });
  db.claimSendTask(t.id);
  const g2 = new Gateway(db, provider, { accountId: "acct", backfillMaxPages: 0, backfillPageLimit: 100 });
  recoveredGateway = g2;
  g2.start(); // resetInFlightTasks 在 start 时执行
  assert.equal(db.sendTaskById(t.id)?.status, "unknown", "进程崩溃时的文件投递应标记为结果不明");
});

test("日报：指定日期生成覆盖全天，重复生成幂等", async context => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botrep-"));
  const db = new Database(path.join(tmp, "bot.db"));
  const provider = new FakeProvider();
  const gateway = new Gateway(db, provider, { accountId: "acct", backfillMaxPages: 0, backfillPageLimit: 100 });
  const cfg = baseConfig(path.join(tmp, "reports"), []);
  const reportEngine = new ReportEngine(db, cfg.reports, "Asia/Shanghai", gateway, new MockLLMClient());
  context.after(async () => {
    await gateway.stop();
    reportEngine.stop();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  gateway.start();

  // 插入两天的消息
  db.insertMessage({
    eventKey: "acct:group_100:message:101",
    accountId: "acct",
    providerId: "onebot",
    conversationId: "group_100",
    groupId: "100",
    messageId: "101",
    senderId: "u1",
    displayNameAtTime: "小明",
    sentAt: "2026-10-11T08:00:00Z", // 北京时间 16:00
    receivedAt: "2026-10-11T08:00:00Z",
    segments: [{ type: "text", data: { text: "我准备周六去爬山" } }],
    textContent: "我准备周六去爬山",
    status: "active",
    origin: "live",
  });

  const r1 = await reportEngine.generateOnDemand("acct", "100", "2026-10-11");
  assert.ok(r1.ok && r1.filePath);
  const md = fs.readFileSync(r1.filePath!, "utf-8");
  assert.ok(md.includes("2026-10-11"), "应包含日期");
  assert.ok(md.includes("1 条消息") || md.includes("消息 1 条"), "应统计消息数");
  assert.ok(md.includes("小明"), "应包含发言成员");

  // 幂等：重复生成返回同一文件
  const r2 = await reportEngine.generateOnDemand("acct", "100", "2026-10-11");
  assert.equal(r2.filePath, r1.filePath);

  // 无消息日期也生成简短报告
  const r3 = await reportEngine.generateOnDemand("acct", "100", "2026-10-10");
  assert.ok(r3.ok && r3.filePath);
  const md3 = fs.readFileSync(r3.filePath!, "utf-8");
  assert.ok(md3.includes("没有记录到消息"));

});

test("Mock模型：近期原文超过120字符时仍回显当前消息，兼容文字和图片消息", async () => {
  const llm = new MockLLMClient("收到「{text}」");
  const wrapped = "近期对话原文：\n" + JSON.stringify([{ text: "历史里也可能提到当前需要回复的消息：\n这是较长的历史。".repeat(40) }])
    + "\n当前需要回复的消息：\n[小张]: 今天怎么安排";
  for (const content of [wrapped, [{ type: "text" as const, text: wrapped }, { type: "image_url" as const, image_url: { url: "https://example.invalid/image.png" } }]]) {
    const response = await llm.chat([{ role: "user", content }]);
    assert.match(response.content, /今天怎么安排/);
    assert.doesNotMatch(response.content, /较长的历史|近期对话原文/);
  }
  assert.equal((await llm.chat([{ role: "user", content: "普通消息" }])).content, "收到「普通消息」");
});

test("重连补取：锚点之后的缺失消息被补回且去重", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botbf-"));
  const db = new Database(path.join(tmp, "bot.db"));

  // 带历史能力的 Provider
  class HistoryProvider extends FakeProvider {
    history: NormalizedIncomingMessage[] = [];
    capabilities(): CapabilityMap {
      return { receiveMessages: "supported", sendText: "supported", sendImage: "unverified", sendPrivateFile: "unverified", groupHistory: "supported" };
    }
    async getGroupMsgHistory(groupId: string, anchor?: string): Promise<{ ok: true; messages: NormalizedIncomingMessage[]; hasMore: boolean }> {
      // 返回比锚点更早的消息（模拟从新到旧翻页）
      const msgs = this.history.filter((m) => !anchor || BigInt(m.messageId) < BigInt(anchor));
      return { ok: true, messages: msgs.slice(0, 2), hasMore: false };
    }
  }
  const provider = new HistoryProvider();
  const gateway = new Gateway(db, provider, { accountId: "acct", backfillMaxPages: 3, backfillPageLimit: 100 });
  gateway.start();

  // 先收到 live 消息 #10，更新锚点（生产环境由主程序挂钩完成）
  provider.inject(groupMsg("10", "最新消息"));
  gateway.updateAnchor("100", "10");
  await sleep(100);
  assert.equal(db.messageCountInRange("100", "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"), 1);

  // 断线期间错过了 #8 #9（协议端历史里存在，按从新到旧排列）
  provider.history = [9, 8].map((n) => ({
    accountId: "acct",
    providerId: "onebot",
    messageId: String(n),
    groupId: "100",
    senderId: "u1",
    senderName: "小明",
    sentAt: new Date(Date.now() - (11 - n) * 60000),
    segments: [{ type: "text" as const, data: { text: `历史消息${n}` } }],
  }));

  try {
    // 重连 → 触发补取
    provider.emit({ kind: "connection", state: "connected", at: new Date().toISOString() });
    await sleep(500);
    const total = db.messageCountInRange("100", "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
    assert.equal(total, 3, "补取后应有 3 条（含去重）");
    const backfilled = db.messagesInRange("100", "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z").filter((m) => m.origin === "backfill");
    assert.equal(backfilled.length, 2, "补取消息应标记 origin=backfill");

    // 再次重连（锚点已是 10）→ 不重复补
    provider.emit({ kind: "connection", state: "connected", at: new Date().toISOString() });
    await sleep(400);
    assert.equal(db.messageCountInRange("100", "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"), 3);
  } finally {
    await gateway.stop();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
