import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import type { Gateway } from "../src/gateway/index.js";
import type { ChatMessage, ChatOptions, LLMClient } from "../src/llm/index.js";
import type { McpManager } from "../src/tools/mcp.js";
import type { MessageRecord } from "../src/types.js";

test("图片状态：当前原图与旧否认交给同一主模型一次请求，选择日志不含图片地址", async t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  const calls: { messages: ChatMessage[]; options?: ChatOptions }[] = [];
  const llm: LLMClient = { chat: async (messages, options) => {
    assert.doesNotMatch(String(messages[0]?.content), /图像读取核验/);
    calls.push({ messages: structuredClone(messages), options });
    return { content: "图里是一段英文对话。", toolCalls: [], finishReason: "stop" };
  } };
  const gateway = { getProvider: () => ({ health: () => ({ selfId: "bot" }) }) } as unknown as Gateway;
  const mcp = { getTools: () => [] } as unknown as McpManager;
  const agent = new Agent({ db, cfg, gateway, llm, memory: null, search: null, reader: null, mcp, timezone: cfg.timezone }) as unknown as {
    generateReply(m: MessageRecord, merged: MessageRecord[], proactiveContext?: string, observe?: boolean): Promise<string> };
  const base = Date.now();
  const current: MessageRecord = { eventKey: "image-state:current", accountId: "fixture", providerId: "onebot",
    conversationId: "group_100", groupId: "100", messageId: "current", senderId: "fixture-owner", displayNameAtTime: "群友",
    sentAt: new Date(base - 1000).toISOString(), receivedAt: new Date(base).toISOString(),
    segments: [{ type: "image", data: { url: "https://fixture.invalid/PRIVATE-IMAGE?token=PRIVATE-TOKEN" } }],
    textContent: "[图片]", status: "active", origin: "live" };
  db.insertMessage({ ...current, eventKey: "image-state:old-bot", messageId: "old-bot", senderId: "bot",
    sentAt: new Date(base - 5000).toISOString(), segments: [{ type: "text", data: { text: "我看不到图片。" } }],
    textContent: "我看不到图片。" });
  const logged: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); });

  assert.equal(await agent.generateReply(current, []), "图里是一段英文对话。");
  assert.equal(calls.length, 1, "带图聊天只调用一次主模型，没有独立图像转述请求");
  const call = calls[0]!;
  assert.match(String(call.messages[0]!.content), /本轮实际附有 1 张图片/);
  assert.match(String(call.messages[0]!.content), /不能沿用旧的否认/);
  assert.match(String(call.messages[0]!.content), /没有诊断证据就说原因尚未确认/);
  const content = call.messages.find(message => message.role === "user")!.content;
  assert.ok(Array.isArray(content));
  const images = content.filter(part => part.type === "image_url");
  assert.deepEqual(images, [{ type: "image_url", image_url: { url: "https://fixture.invalid/PRIVATE-IMAGE?token=PRIVATE-TOKEN" } }]);
  assert.ok(content.some(part => part.type === "text" && part.text.includes("我看不到图片")));
  assert.ok(content.some(part => part.type === "text" && part.text.startsWith("图片 1 的消息来源")));
  assert.doesNotMatch(JSON.stringify(call.messages), /图像读取核验|本轮独立读图结果|已独立读取/);
  assert.match(call.options!.imageContextId!, /^[0-9a-f-]{36}$/i);
  const receipt = logged.find(line => line.includes("图片上下文已选择"))!;
  assert.ok(receipt.includes(call.options!.imageContextId!));
  assert.match(receipt, /"imageCount":1/);
  assert.doesNotMatch(receipt, /PRIVATE|fixture-owner|fixture\.invalid/);
});

test("图片状态：主模型图片接口异常保持失败，不伪装成功也不调用第二个模型", async t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  let calls = 0;
  const error = new Error("模型图片请求失败 code=HTTP_ERROR receiptId=11111111-1111-4111-8111-111111111111 HTTP 503");
  error.name = "ImageRequestError";
  const llm: LLMClient = { chat: async messages => {
    calls++;
    assert.match(String(messages[0]?.content), /本轮实际附有 1 张图片/);
    assert.doesNotMatch(JSON.stringify(messages), /图像读取核验|本轮独立读图结果|已独立读取/);
    assert.equal(messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(part => part.type === "image_url") : []).length, 1);
    throw error;
  } };
  const gateway = { getProvider: () => ({ health: () => ({ selfId: "bot" }) }) } as unknown as Gateway;
  const mcp = { getTools: () => [] } as unknown as McpManager;
  const agent = new Agent({ db, cfg, gateway, llm, memory: null, search: null, reader: null, mcp, timezone: cfg.timezone }) as unknown as {
    generateReply(m: MessageRecord, merged: MessageRecord[], proactiveContext?: string, observe?: boolean): Promise<string> };
  const at = new Date(Date.now() - 1000).toISOString();
  const message: MessageRecord = { eventKey: "image-read:failure", accountId: "fixture", providerId: "onebot",
    conversationId: "group_100", groupId: "100", messageId: "failure", senderId: "fixture-owner", displayNameAtTime: "群友",
    sentAt: at, receivedAt: at, segments: [{ type: "image", data: { url: "https://fixture.invalid/image.jpg" } }],
    textContent: "[图片]", status: "active", origin: "live" };
  await assert.rejects(agent.generateReply(message, []), thrown => thrown === error);
  assert.equal(calls, 1);
});

test("图片状态：历史发图记录不冒充本轮视觉输入，普通新话题仍发纯文字", async t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  let request: ChatMessage[] = [];
  const llm: LLMClient = { chat: async messages => {
    request = structuredClone(messages);
    return { content: "今天挺晴的。", toolCalls: [], finishReason: "stop" };
  } };
  const gateway = { getProvider: () => ({ health: () => ({ selfId: "bot" }) }) } as unknown as Gateway;
  const mcp = { getTools: () => [] } as unknown as McpManager;
  const agent = new Agent({ db, cfg, gateway, llm, memory: null, search: null, reader: null, mcp, timezone: cfg.timezone }) as unknown as {
    generateReply(m: MessageRecord, merged: MessageRecord[]): Promise<string> };
  const base = Date.now();
  const current: MessageRecord = { eventKey: "image-state:text", accountId: "fixture", providerId: "onebot",
    conversationId: "group_100", groupId: "100", messageId: "text", senderId: "fixture-owner", displayNameAtTime: "群友",
    sentAt: new Date(base - 1000).toISOString(), receivedAt: new Date(base).toISOString(),
    segments: [{ type: "text", data: { text: "今天天气真好" } }], textContent: "今天天气真好", status: "active", origin: "live" };
  db.insertMessage({ ...current, eventKey: "image-state:old-image", messageId: "old-image",
    sentAt: new Date(base - 60000).toISOString(), segments: [{ type: "image", data: { url: "https://fixture.invalid/old.jpg" } }],
    textContent: "[图片]" });
  await agent.generateReply(current, []);
  assert.match(String(request[0]!.content), /本轮未附带图片/);
  assert.match(String(request[0]!.content), /不能把未附图解释成图片下载失败或平台丢图/);
  assert.match(String(request[0]!.content), /也没有执行图片读取/);
  assert.match(String(request[0]!.content), /不能声称正在看图、尝试读图或本轮已经读取失败/);
  const content = request.find(message => message.role === "user")!.content;
  assert.equal(typeof content, "string");
  assert.match(String(content), /"imageCount":1/);
});

test("图片衔接：额度满跳过本人图，六十一秒后召唤同一主请求带本人图，新话题不带旧图", async t => {
  const base = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: base });
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "fixture";
  cfg.persona.name = "κόραξ";
  cfg.tools.enabled = false;
  cfg.tools.ownerIds = ["owner"];
  cfg.groups.allowlist = ["100"];
  cfg.groups.linkPreview = false;
  cfg.groups.conversation = { enabled: true, ownerAliases: [], observerMaxReplies: 1, observerCooldownMs: 0 };
  const chats: ChatMessage[][] = [];
  const llm: LLMClient = { chat: async messages => {
    assert.doesNotMatch(String(messages[0]?.content), /图像读取核验/);
    chats.push(structuredClone(messages));
    return { content: `本轮答复${chats.length}`, toolCalls: [], finishReason: "stop" };
  } };
  let sends = 0;
  const gateway = {
    getProvider: () => ({ health: () => ({ selfId: "bot" }) }),
    enqueueSend: (task: Parameters<Gateway["enqueueSend"]>[0]) => { sends++; return db.enqueueSendTask(task); },
  } as unknown as Gateway;
  const agent = new Agent({ db, cfg, llm, gateway, memory: null, search: null, reader: null,
    mcp: { getTools: () => [] } as unknown as McpManager, timezone: cfg.timezone });
  let serial = 0;
  const message = (text: string, patch: Partial<MessageRecord> = {}): MessageRecord => {
    const id = String(++serial);
    return { eventKey: `resume-image:${id}`, accountId: "fixture", providerId: "onebot", conversationId: "group_100", groupId: "100",
      messageId: id, senderId: "owner", displayNameAtTime: "本人", sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
      textContent: text, segments: [{ type: "text", data: { text } }], origin: "live", status: "active", ...patch };
  };
  const prior = message("之前的群聊话题", { senderId: "other", sentAt: new Date(base - 10_000).toISOString() });
  db.insertMessage(prior);
  db.enqueueSendTask({ taskKey: `reply:${prior.eventKey}:0`, kind: "reply", conversationType: "group", targetId: "100",
    payload: { kind: "segments", accountId: "fixture", requesterId: "other", replyKind: "observation", replyBatch: `reply:${prior.eventKey}`,
      segments: [{ type: "text", data: { text: "已经发出的环境回答" } }] } });
  const own = message("[图片]", { segments: [{ type: "image", data: { url: "https://fixture.invalid/owner.jpg" } }] });
  db.insertMessage(own);
  const skipped = agent.onMessage(own);
  for (let i = 0; i < 48; i++) await Promise.resolve();
  t.mock.timers.tick(1200);
  await skipped;
  assert.equal(chats.length, 0, "普通图片仍受自动接话额度约束，跳过时不调用主模型");
  assert.equal(sends, 0);
  t.mock.timers.tick(60_000);
  db.insertMessage(message("[图片]", { senderId: "other", segments: [{ type: "image", data: { url: "https://fixture.invalid/other.jpg" } }] }));
  t.mock.timers.tick(1);
  const summon = message("κόραξ你在干嘛。");
  db.insertMessage(summon);
  await agent.onMessage(summon);
  assert.equal(chats.length, 1, "召唤只发起同一主模型的一次请求");
  const urls = chats[0]!.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(part => part.type === "image_url").map(part => part.image_url.url) : []);
  assert.deepEqual(urls, ["https://fixture.invalid/owner.jpg"], "召唤补上本人图片，不被别人较新的图替换");
  assert.equal(sends, 1);
  assert.match(String(chats[0]?.[0]?.content), /本轮实际附有 1 张图片/);
  const data = chats[0]?.find(m => m.role === "user")?.content;
  assert.ok(Array.isArray(data));
  assert.ok(data.some(p => p.type === "text" && p.text.includes('"senderId":"owner"')));
  t.mock.timers.tick(1);
  const newTopic = message("κόραξ我好无聊。给我找点乐子。");
  db.insertMessage(newTopic);
  await agent.onMessage(newTopic);
  assert.equal(chats.length, 2, "新话题仍只发起一次主模型请求");
  assert.equal(chats[1]!.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(part => part.type === "image_url") : []).length, 0, "带名字的新话题不重复附旧图");
  assert.equal(sends, 2);
  assert.match(String(chats[1]?.[0]?.content), /本轮未附带图片，也没有执行图片读取/);
});
