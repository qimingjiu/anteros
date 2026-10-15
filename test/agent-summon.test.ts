import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import type { DocumentDelivery } from "../src/documents/delivery.js";
import type { Gateway } from "../src/gateway/index.js";
import type { ChatMessage, ChatResult, LLMClient, ToolSpec } from "../src/llm/index.js";
import type { MemoryProvider } from "../src/memory/index.js";
import type { McpManager } from "../src/tools/mcp.js";
import type { SearchProvider } from "../src/tools/search.js";
import type { MessageRecord, ToolDef } from "../src/types.js";

const OWNER = "10001";
const MEMBER = "12345678";
const BOT = "99999999";
const BASE = Date.parse("2026-10-13T15:45:00Z");
type SendTask = Parameters<Gateway["enqueueSend"]>[0];
type Step = ChatResult | ((signal: AbortSignal | undefined) => Promise<ChatResult>);
const answer = (content: string): ChatResult => ({ content, toolCalls: [], finishReason: "stop" });
const silent = (): ChatResult => ({ content: "", toolCalls: [{ id: "silent", name: "conversation_action",
  arguments: '{"action":"silent"}' }], finishReason: "tool_calls" });

async function flush() {
  for (let i = 0; i < 48; i++) await Promise.resolve();
}

function fixture(t: TestContext, steps: Step[] = [], mcpTools: ToolDef[] = []) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: BASE });
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "acct";
  cfg.persona.name = "κόραξ";
  cfg.groups.allowlist = ["100"];
  cfg.groups.linkPreview = false;
  cfg.groups.conversation = {
    enabled: true, ownerAliases: ["朔朔", "Azhan"], wakeAliases: ["乌鸦"],
    ownerWakeAliases: [{ userId: OWNER, aliases: ["小渡", "鸦鸦", "黑羽"] }],
  };
  cfg.tools.enabled = true;
  cfg.tools.ownerIds = [OWNER];
  cfg.admins = [OWNER];
  cfg.model.maxOutputChars = 10_000;
  cfg.groups.maxReplyChars = 10_000;
  const calls: { messages: ChatMessage[]; signal?: AbortSignal; tools?: ToolSpec[] }[] = [];
  let active = 0;
  let maxActive = 0;
  const llm: LLMClient = { async chat(messages, options) {
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
    calls.push({ messages: structuredClone(messages), signal, tools: options?.tools && structuredClone(options.tools) });
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const next = steps.shift();
      return typeof next === "function" ? await next(signal) : next ?? answer(`本次只回答当前请求，第${calls.length}次。`);
    } finally { active--; }
  } };
  const ingested: MessageRecord[] = [];
  const memory = { ingest: (m: MessageRecord) => { ingested.push(m); }, retrieve: () => [], recentContextSummary: () => "" } as unknown as MemoryProvider;
  const sent: SendTask[] = [];
  const gateway = {
    getProvider: () => ({ health: () => ({ selfId: BOT, connection: "connected", login: "online", reconnectCount: 0 }) }),
    enqueueSend(task: SendTask) {
      const result = db.enqueueSendTask(task);
      if (!result.reused) sent.push(task);
      return result;
    },
  } as unknown as Gateway;
  const agent = new Agent({ db, cfg, llm, gateway, memory, search: null, reader: null,
    mcp: { getTools: () => mcpTools } as unknown as McpManager, timezone: cfg.timezone,
  });
  let serial = 0;
  const message = (text: string, patch: Partial<MessageRecord> = {}): MessageRecord => {
    t.mock.timers.tick(1);
    const id = String(++serial);
    return { eventKey: `summon-event:${id}`, accountId: "acct", providerId: "onebot", conversationId: "group_100", groupId: "100",
      messageId: id, senderId: MEMBER, displayNameAtTime: "群友", sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
      segments: [{ type: "text", data: { text } }], textContent: text, origin: "live", status: "active", ...patch };
  };
  const owner = (text: string, patch: Partial<MessageRecord> = {}) => message(text, { senderId: OWNER, displayNameAtTime: "主人", ...patch });
  const explicit = (text: string) => message(text, { segments: [{ type: "at", data: { qq: BOT } }, { type: "text", data: { text } }] });
  const start = (m: MessageRecord) => { db.insertMessage(m); return agent.onMessage(m); };
  const run = async (m: MessageRecord) => {
    const pending = start(m);
    await flush();
    t.mock.timers.tick(1200);
    await pending;
    await flush();
  };
  const immediate = async (m: MessageRecord) => {
    const before = calls.length;
    const pending = start(m);
    await flush();
    assert.equal(calls.length, before + 1, "召唤应在当前微任务进入主模型，不能等待1200ms收集窗口");
    await pending;
    await flush();
  };
  const fillWindow = async () => {
    for (let i = 0; i < 3; i++) {
      if (i) t.mock.timers.tick(61_000);
      await run(message(`全新环境话题${i + 1}`, { senderId: `1234567${i}` }));
    }
    assert.equal(calls.length, 3);
    assert.equal(sent.length, 3);
  };
  return { agent, db, cfg, calls, sent, ingested, message, owner, explicit, start, run, immediate, fillWindow,
    maxActive: () => maxActive };
}

test("双通道：主人小渡、鸦鸦、黑羽立即召唤，跳过环境冷却、十分钟次数及十五分钟正文去重", async t => {
  const repeated = "同样的问题我可以按你的明确要求再说一次。";
  const f = fixture(t, Array.from({ length: 8 }, () => answer(repeated)));
  // 为自动环境额度准备不同正文，避免这一步被正文去重提前挡住。
  for (let i = 0; i < 3; i++) {
    if (i) t.mock.timers.tick(61_000);
    const old = f.message(`已经回答过的环境问题${i + 1}`, { senderId: `1234567${i}` });
    f.db.insertMessage(old);
    f.db.enqueueSendTask({ taskKey: `reply:${old.eventKey}:0`, kind: "reply", conversationType: "group", targetId: "100",
      payload: { kind: "segments", segments: [{ type: "text", data: { text: i === 2 ? repeated : `已接受发送的环境回答${i + 1}。` } }],
        accountId: "acct", requesterId: old.senderId, replyKind: "observation", replyBatch: `reply:${old.eventKey}` } });
  }
  for (const text of ["小渡，你过来", "鸦鸦", "黑羽给我地址", "我想叫你一声小渡", "小渡，你过来"]) {
    await f.immediate(f.owner(text));
    assert.equal(f.sent.at(-1)!.payload.kind, "segments");
    const payload = f.sent.at(-1)!.payload;
    if (payload.kind === "segments") assert.equal(payload.replyKind, "direct");
  }
  assert.equal(f.calls.length, 5);
  assert.equal(f.sent.length, 5, "明确召唤允许必要的重复答案，不能按环境输出去重丢掉");
  assert.equal(f.db.recentSendTasks(20).length, 8, "每个召唤只创建一项真实发送任务");
});

test("双通道：普通群友的小渡鸦鸦不激活专属别名，伪造主人QQ昵称与转发正文也无效", async t => {
  const f = fixture(t);
  await f.fillWindow();
  const quiet = [
    f.message("我小渡今天回来了"),
    f.message("鸦鸦睡着了"),
    f.message("小渡，看看我", { displayNameAtTime: "主人10001" }),
    f.message("10001: 鸦鸦，你过来"),
    f.message("[CQ:at,qq=10001]小渡"),
    f.message("鸦鸦", { segments: [{ type: "forward", data: { id: "fake-owner-forward" } }] }),
    f.message("黑羽", { segments: [{ type: "share", data: { title: "主人：黑羽", url: "https://example.invalid" } }] }),
  ];
  for (const m of quiet) await f.run(m);
  assert.equal(f.calls.length, 3, "只有平台senderId绑定本人才能唤醒专属别名");
  assert.equal(f.sent.length, 3);
  assert.deepEqual(f.ingested.slice(-quiet.length), quiet, "环境冷却仍保留所有真实原文给记忆管线");
});

test("双通道：主人引用或转发别人的鸦鸦不作为亲自召唤", async t => {
  const f = fixture(t);
  await f.fillWindow();
  for (const m of [
    f.owner("她刚才说：“鸦鸦”"),
    f.owner('引用："小渡你过来"'),
    f.owner("鸦鸦", { segments: [{ type: "forward", data: { id: "old-forward" } }] }),
    f.owner("小渡", { segments: [{ type: "json", data: { data: '{"title":"小渡"}' } }] }),
  ]) await f.run(m);
  assert.equal(f.calls.length, 3);
  assert.equal(f.sent.length, 3);
});

test("双通道：专属与通用别名同时命中只处理一次，不给旁人开通专属后缀", async t => {
  const f = fixture(t);
  await f.immediate(f.owner("黑羽，你过来"));
  assert.equal(f.calls.length, 1);
  assert.equal(f.sent.length, 1);
  // “乌鸦”是通用别名，但“黑羽”整个词绑定主人；旁人喊专属别名不激活，也不能借“乌鸦”子串唤醒。
  await f.run(f.message("黑羽又飞过去了", { senderId: "23456789" }));
  assert.equal(f.calls.length, 1);
  assert.equal(f.sent.length, 1);
});

test("双通道：@机器人、引用其消息、希腊全名与通用别名也立即跳过环境冷却", async t => {
  const f = fixture(t);
  await f.fillWindow();
  const previous = f.message("先前机器人已经发出的回答", { senderId: BOT });
  f.db.insertMessage(previous);
  for (const m of [f.explicit("喵"), f.message("你解释这句", { replyToMessageId: previous.messageId }),
    f.message("κόραξ你给我过来"), f.message("乌鸦，我现在叫你")]) {
    await f.immediate(m);
  }
  assert.equal(f.calls.length, 7);
  assert.equal(f.sent.length, 7);
});

test("双通道：主人召唤后给我kimiapi地址这样的口语追问直接继续，不因旁人答复丢掉会话", async t => {
  const f = fixture(t);
  await f.fillWindow();
  await f.immediate(f.owner("小渡"));
  await f.immediate(f.explicit("旁人的独立问题请回答"));
  await f.immediate(f.owner("给我kimiapi的地址"));
  await f.immediate(f.owner("再短点"));
  assert.equal(f.calls.length, 7);
  assert.equal(f.sent.length, 7);
  const prompt = String(f.calls[5]!.messages[1]!.content);
  assert.match(prompt, /给我kimiapi的地址/);
  // The live window admits these turns to the main model as well; it may
  // choose natural silence for acknowledgement rather than a routing regex.
  const originalChat = (f.agent as unknown as { llm: LLMClient }).llm.chat;
  (f.agent as unknown as { llm: LLMClient }).llm.chat = async (messages, options) => {
    await originalChat(messages, options);
    return silent();
  };
  await f.run(f.owner("嗯"));
  await f.run(f.owner("哈哈"));
  assert.equal(f.calls.length, 9, "身份连续窗口将短句交给主模型判断，不用关键词吞掉消息");
  assert.equal(f.sent.length, 7, "纯附和仍可由主模型自然静默，不强制重试出声");
  t.mock.timers.tick(120_001);
  await f.run(f.owner("给我那份地址"));
  assert.equal(f.calls.length, 9, "过期追问恢复环境通道，仍受十分钟窗口限制");
});

test("双通道：主人已召唤但答案尚未返回，后续口语追问仍保留独立请求", async t => {
  let release!: (response: ChatResult) => void;
  const f = fixture(t, [() => new Promise(resolve => { release = resolve; }), answer("本条给出地址。")]);
  const first = f.start(f.owner("鸦鸦"));
  await flush();
  assert.equal(f.calls.length, 1);
  const followup = f.start(f.owner("给我kimiapi的地址"));
  await flush();
  assert.equal(f.calls.length, 1, "同群明确对话仍串行生成");
  release(answer("来了。"));
  await first;
  await followup;
  await flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.sent.length, 2);
  assert.equal(f.maxActive(), 1);
  assert.match(String(f.calls[1]!.messages[1]!.content), /给我kimiapi的地址/);
});

test("连续对话：截图无URL后的口语催搜实际进入搜索，短句不受环境满额影响", async t => {
  const steps: Step[] = [];
  const f = fixture(t, steps);
  await f.fillWindow();
  const searches: string[] = [];
  (f.agent as unknown as { search: SearchProvider }).search = { name: "fixture", async search(query) {
    searches.push(query);
    return [{ title: "可辨认的文章标题", url: "https://example.org/article", snippet: "原文线索", source: "fixture" }];
  } };
  steps.push(answer("截图里没有链接，请给我标题。"));
  await f.immediate(f.owner("小渡，昨晚截图里的文章标题是‘可辨认的文章标题’，原文链接给我"));
  steps.push({ content: "", finishReason: "tool_calls", toolCalls: [{ id: "search-current-request", name: "web_search",
    arguments: JSON.stringify({ query: "可辨认的文章标题" }) }] }, answer("找到这个候选原文：https://example.org/article"));
  const before = f.calls.length;
  const waiting = f.start(f.owner("你，不懂去搜吗。"));
  await flush();
  await waiting;
  assert.equal(f.calls.length, before + 2);
  assert.deepEqual(searches, ["可辨认的文章标题"]);
  const prompt = String(f.calls[before]!.messages[1]!.content);
  assert.match(prompt, /可辨认的文章标题/);
  assert.match(prompt, /询问线索也不等于已执行搜索/);
  assert.equal(f.sent.at(-1)!.payload.kind, "segments");
  if (f.sent.at(-1)!.payload.kind === "segments") assert.equal(f.sent.at(-1)!.payload.replyKind, "direct");
  await f.immediate(f.owner("你去搜啊"));
  await f.immediate(f.owner("你完了。"));
});

test("连续对话：长任务回答后再保留完整两分钟，重启可从已排队直接答复恢复", async t => {
  let release!: (response: ChatResult) => void;
  const f = fixture(t, [() => new Promise(resolve => { release = resolve; })]);
  f.cfg.groups.conversation!.enabled = false;
  const first = f.start(f.owner("小渡，帮我处理这个问题"));
  await flush();
  t.mock.timers.tick(150_000);
  release(answer("这个任务已经处理完了。"));
  await first;
  t.mock.timers.tick(110_000);
  await f.immediate(f.owner("那这个呢"));
  assert.equal(f.calls.length, 2);
  (f.agent as unknown as { directSessions: Map<string, number> }).directSessions.clear();
  // The warm reply snapshot has the actual requester identity, unlike a
  // generic bot echo in a group that could have addressed somebody else.
  await f.immediate(f.owner("喂。"));
  assert.equal(f.calls.length, 3);
  t.mock.timers.tick(120_001);
  await f.run(f.owner("你去搜啊"));
  assert.equal(f.calls.length, 3, "过期且关闭环境接话时没有隐式激活");
});

test("连续对话：同群另一发送者不继承窗口，明确对旁人说话仍不触发", async t => {
  const f = fixture(t);
  f.cfg.groups.conversation!.enabled = false;
  await f.immediate(f.owner("小渡"));
  await f.run(f.message("你去搜啊"));
  assert.equal(f.calls.length, 1);
  const other = f.message("我来帮你", { senderId: "23456789" });
  f.db.insertMessage(other);
  await f.run(f.owner("你去搜啊", { replyToMessageId: other.messageId }));
  await f.run(f.owner("喂", { segments: [{ type: "at", data: { qq: other.senderId } }, { type: "text", data: { text: "喂" } }] }));
  assert.equal(f.calls.length, 1);
});

test("连续对话：排队中的口语催促不丢弃，前一个澄清答复不把任务标成已完成", async t => {
  let release!: (response: ChatResult) => void;
  const f = fixture(t, [() => new Promise(resolve => { release = resolve; }), answer("现在按已有标题开始查找。"), answer("这次也收到你的话了。")]);
  f.cfg.groups.conversation!.enabled = false;
  const first = f.start(f.owner("小渡，按标题‘文章线索’找昨晚那个链接"));
  await flush();
  const second = f.start(f.owner("你去搜啊"));
  const third = f.start(f.owner("你完了。"));
  await flush();
  assert.equal(f.calls.length, 1);
  release(answer("截图没URL，请给我标题。"));
  await Promise.all([first, second, third]);
  assert.equal(f.calls.length, 3); assert.equal(f.sent.length, 3); assert.equal(f.maxActive(), 1);
  const secondPrompt = String(f.calls[1]!.messages[1]!.content);
  assert.match(secondPrompt, /文章线索/); assert.match(secondPrompt, /你去搜啊/);
  assert.match(secondPrompt, /截图没URL/); assert.match(secondPrompt, /发出回复不等于已经完成工具任务/);
});

test("双通道：主人近期会话中明确@或引用旁人时，不把给我这样的用语误认成继续叫机器人", async t => {
  const f = fixture(t);
  await f.fillWindow();
  await f.immediate(f.owner("小渡"));
  const other = f.message("旁人刚才的说法", { senderId: "23456789" });
  f.db.insertMessage(other);
  await f.run(f.owner("给我这个地址", { segments: [{ type: "at", data: { qq: other.senderId } },
    { type: "text", data: { text: "给我这个地址" } }] }));
  await f.run(f.owner("你给我那个文件", { replyToMessageId: other.messageId }));
  assert.equal(f.calls.length, 4);
  assert.equal(f.sent.length, 4);
});

test("双通道：启用文档能力时，主人向别人的PDF请求也不能被文档优先入口抢成机器人召唤", async t => {
  const f = fixture(t);
  (f.agent as unknown as { documentDelivery: DocumentDelivery }).documentDelivery = {
    createAndSend: async () => { assert.fail("向旁人的文档请求不能执行机器人文件生成或投递"); },
  } as unknown as DocumentDelivery;
  await f.fillWindow();
  await f.immediate(f.owner("鸦鸦"));
  const human = f.message("我给你发文件", { senderId: "23456789" });
  f.db.insertMessage(human);
  for (const m of [f.owner("给我一份 PDF", { segments: [{ type: "at", data: { qq: human.senderId } },
    { type: "text", data: { text: "给我一份 PDF" } }] }),
    f.owner("给我一份 PDF", { replyToMessageId: human.messageId })]) await f.run(m);
  assert.equal(f.calls.length, 4, "文档意图不能越过已经明确指向旁人的目标检查");
  assert.equal(f.sent.length, 4);
  assert.equal(f.sent.filter(task => task.payload.kind === "file").length, 0);
});

test("双通道：关闭环境自动接话仍摄入原文，主人专属召唤和明确@继续可用", async t => {
  const f = fixture(t);
  f.cfg.groups.conversation!.enabled = false;
  const environment = f.message("普通群友继续聊天");
  await f.run(environment);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.ingested, [environment]);
  await f.immediate(f.owner("鸦鸦"));
  await f.immediate(f.explicit("叫你回答这一条"));
  assert.equal(f.calls.length, 2);
  assert.equal(f.sent.length, 2);
});

test("双通道：鸦鸦这样的短召唤明确交给主人模型，意外静默或空响应只补一次自然应答", async t => {
  for (const first of [silent(), answer("")]) {
    const f = fixture(t, [first, answer("怎么了？我听着。")]);
    const pending = f.start(f.owner("鸦鸦"));
    await flush();
    assert.equal(f.calls.length, 2, "真实召唤没有新事实也应答，第一次静默或空响应可再让同一模型答一次");
    await pending;
    assert.equal(f.sent.length, 1);
    const prompt = String(f.calls[0]!.messages[0]!.content);
    assert.match(prompt, /(?:明确召唤|召唤通道)/);
    assert.match(prompt, /(?:应一声|回应|回复)/);
  }
});

test("双通道：主人召唤后不再喊名字的明确口语追问，模型意外静默也补一次当前答案", async t => {
  const currentAnswer = "本条只回答你正在问的 API 地址。";
  const f = fixture(t, [answer("来了。"), silent(), answer(currentAnswer)]);
  await f.immediate(f.owner("鸦鸦"));
  const pending = f.start(f.owner("给我kimiapi的地址"));
  await flush();
  assert.equal(f.calls.length, 3, "近期追问无需再次叫名字，也应从首次意外静默恢复一次");
  await pending;
  assert.equal(f.sent.length, 2);
  const payload = f.sent[1]!.payload;
  assert.equal(payload.kind, "segments");
  if (payload.kind === "segments") assert.equal(payload.segments.map(s => s.type === "text" ? s.data.text : "").join(""), currentAnswer);
  assert.match(String(f.calls[2]!.messages.at(-1)?.content), /(?:明确召唤|接着提出请求)/);
});

test("双通道：明确召唤业务工具完成后意外静默只恢复正文，不再执行已经完成的业务工具", async t => {
  const name = "mcp__fixture__summon_lookup";
  let executions = 0;
  const tool: ToolDef = { name, description: "测试查询当前事实", inputSchema: { type: "object" },
    execute: async () => { executions++; return "已确认的当前结果：fixture-current-value"; } };
  const finalAnswer = "查到的当前结果是 fixture-current-value。";
  const f = fixture(t, [{ content: "", toolCalls: [{ id: "lookup", name, arguments: "{}" }], finishReason: "tool_calls" },
    silent(), answer(finalAnswer)], [tool]);
  const pending = f.start(f.owner("鸦鸦，帮我查一下这个结果"));
  await flush();
  await pending;
  assert.equal(f.calls.length, 3, "查询、意外静默及正文恢复总共三轮当前主模型调用");
  assert.equal(executions, 1, "恢复最终正文不能重新执行MCP或生成投递文件");
  assert.ok(f.calls[0]!.tools?.some(spec => spec.function.name === name));
  assert.deepEqual(f.calls[2]!.tools?.map(spec => spec.function.name), ["conversation_action"], "恢复正文时业务工具已经关闭");
  assert.match(String(f.calls[2]!.messages.find(m => m.role === "tool")?.content), /fixture-current-value/);
  assert.equal(f.sent.length, 1);
  const payload = f.sent[0]!.payload;
  assert.equal(payload.kind, "segments");
  if (payload.kind === "segments") assert.equal(payload.segments.map(s => s.type === "text" ? s.data.text : "").join(""), finalAnswer);
});

test("双通道：主人明确要求不回复时尊重静默，不因唤醒词再逼模型应答", async t => {
  const f = fixture(t, [silent(), answer("不该发送的第二次回复")]);
  const pending = f.start(f.owner("鸦鸦，先不要回复"));
  await flush();
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.sent.length, 0);
});

test("双通道：短召唤第二次仍静默时不无限重试主模型", async t => {
  const f = fixture(t, [silent(), silent(), answer("不应发生的第三次模型调用")]);
  const pending = f.start(f.owner("鸦鸦"));
  await flush();
  await pending;
  assert.equal(f.calls.length, 2);
  assert.ok(f.sent.length <= 1);
});

test("双通道：1200ms收集中的普通环境被召唤让路，召唤无需等待定时器", async t => {
  const f = fixture(t);
  const environment = f.message("这里聊的是普通环境话题");
  const quiet = f.start(environment);
  await flush();
  assert.equal(f.calls.length, 0);
  const summon = f.owner("黑羽给我过来");
  const call = f.start(summon);
  await flush();
  assert.equal(f.calls.length, 1, "新召唤应取消环境收集等待，先处理主人");
  await call;
  await quiet;
  t.mock.timers.tick(1200);
  await flush();
  assert.equal(f.calls.length, 1, "已被召唤覆盖的旧环境不应之后再生成");
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.ingested, [environment, summon]);
});

test("双通道：正在生成的普通环境可以取消，迟到的正文不发送且召唤保持同群串行", async t => {
  let aborted = false;
  const f = fixture(t, [signal => new Promise(resolve => {
    assert.ok(signal, "环境LLM请求必须带可取消signal");
    signal.addEventListener("abort", () => { aborted = true; resolve(answer("不应再发送的旧环境回答。")); }, { once: true });
  }), answer("主人叫我后立即处理的答案。")]);
  const old = f.start(f.message("正在讨论的环境话题"));
  await flush();
  t.mock.timers.tick(1200);
  await flush();
  assert.equal(f.calls.length, 1);
  const summoned = f.start(f.owner("小渡"));
  await flush();
  assert.equal(aborted, true);
  assert.equal(f.calls.length, 2, "环境取消完成后直接启动召唤，不再等一个收集窗口");
  await old;
  await summoned;
  assert.equal(f.maxActive(), 1);
  assert.equal(f.sent.length, 1);
  const payload = f.sent[0]!.payload;
  assert.equal(payload.kind, "segments");
  if (payload.kind === "segments") assert.match(payload.segments.map(s => s.type === "text" ? s.data.text : "").join(""), /主人叫我/);
});

test("双通道：取消环境后迟到的conversation_action也不能拉黑原发送者", async t => {
  const f = fixture(t, [signal => new Promise(resolve => {
    assert.ok(signal);
    signal.addEventListener("abort", () => resolve({ content: "", toolCalls: [{ id: "stale-ban", name: "conversation_action",
      arguments: '{"action":"blacklist","reason":"已取消生成的控制动作"}' }], finishReason: "tool_calls" }), { once: true });
  }), answer("本条回应主人召唤。")]);
  const environment = f.start(f.message("没有攻击的普通原文"));
  await flush();
  t.mock.timers.tick(1200);
  await flush();
  const summon = f.start(f.owner("鸦鸦"));
  await flush();
  await environment;
  await summon;
  assert.equal(f.calls.length, 2);
  assert.equal(f.sent.length, 1);
  assert.equal(f.db.isUserBlocked("acct", MEMBER), false, "取消后的模型结果不能执行控制副作用");
});
