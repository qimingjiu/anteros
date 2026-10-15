import assert from "node:assert/strict";
import test from "node:test";
import { FeishuToolsService, isFeishuReadOnly, isFeishuWriteTool } from "../src/tools/feishu-tools.js";
import type { MessageRecord, ToolContext, ToolDef, ToolParamSchema } from "../src/types.js";

function message(body = "查看飞书文档", changes: Partial<MessageRecord> = {}): MessageRecord {
  return { eventKey: "event", accountId: "bot", providerId: "onebot", conversationId: "private_owner", messageId: "m1", senderId: "owner",
    displayNameAtTime: "主人", sentAt: "2026-10-15T15:00:00Z", receivedAt: "2026-10-15T15:00:00Z", segments: [{ type: "text", data: { text: body } }],
    textContent: body, status: "active", origin: "live", ...changes };
}
function context(m: MessageRecord): ToolContext { return { accountId: m.accountId, groupId: m.groupId, requesterId: m.senderId, isPrivate: !m.groupId }; }
const schema: ToolParamSchema = { type: "object", properties: { document_id: { type: "string" } }, required: ["document_id"], additionalProperties: false };
function fixture(names = ["docx_v1_document_rawContent", "drive_v1_file_list", "bitable_v1_appTableRecord_create", "mail_v1_message_send"]) {
  const calls: { name: string; args: Record<string, unknown>; ctx: ToolContext }[] = [];
  const tools: ToolDef[] = names.map(name => ({ name: `mcp__feishu__${name}`, description: `飞书工具 ${name}`, inputSchema: structuredClone(schema),
    execute: async (args, ctx) => { calls.push({ name, args, ctx }); return JSON.stringify({ code: 0, data: { id: "resource", request: args } }); } }));
  tools.push({ name: "mcp__other__drive_v1_file_list", description: "other server", inputSchema: { type: "object" }, execute: async () => { throw new Error("Must never call another MCP"); } });
  const service = new FeishuToolsService({ mcp: { getTools: () => tools }, accountId: "bot", ownerIds: ["owner", "owner2"] });
  const exposed = (m = message()) => service.toolsFor(m);
  return { service, tools, calls, exposed };
}

test("飞书只暴露两个工具且限定真实主人、账号和会话", () => {
  const f = fixture();
  assert.deepEqual(f.exposed().map(t => t.name), ["feishu_tools", "feishu_call"]);
  for (const changes of [{ senderId: "other", conversationId: "private_other" }, { accountId: "other" }, { origin: "backfill" }, { status: "recalled" },
    { conversationId: "private_other" }, { groupId: "123", conversationId: "group_other" }, { interaction: "poke" }]) {
    assert.equal(f.exposed(message("查看", changes as Partial<MessageRecord>)).length, 0);
  }
  assert.equal(f.exposed(message("查看", { groupId: "123", conversationId: "group_123" })).length, 2);
});
test("飞书目录分页面对227个工具不一次发送schema、没有slides就明确为空", async () => {
  const groups = ["docx", "drive", "bitable", "sheets", "wiki", "mail"];
  const f = fixture(Array.from({ length: 227 }, (_, i) => `${groups[i % groups.length]}_v1_resource_list_${i}`));
  const m = message(), tool = f.exposed(m)[0]!;
  const first = JSON.parse(await tool.execute({ action: "list" }, context(m)));
  assert.equal(first.total, 227); assert.equal(first.tools.length, 12); assert.equal(first.nextOffset, 12);
  assert.equal(first.tools[0].inputSchema, undefined); assert.equal(first.untrustedData, true);
  const second = JSON.parse(await tool.execute({ action: "list", offset: 12, limit: 20 }, context(m)));
  assert.equal(second.tools.length, 20); assert.equal(second.nextOffset, 32);
  assert.notEqual(first.tools[0].toolName, second.tools[0].toolName);
  const slides = JSON.parse(await tool.execute({ action: "list", category: "slides" }, context(m)));
  assert.equal(slides.total, 0); assert.deepEqual(slides.tools, []); assert.equal(slides.nextOffset, null);
  assert.equal(f.calls.length, 0);
});
test("飞书按真实名称分类，query同时搜索名称和描述", async () => {
  const f = fixture(); f.tools[0]!.description = "读取季度规划全文";
  const m = message(), tool = f.exposed(m)[0]!;
  const a = JSON.parse(await tool.execute({ action: "list", category: "docx", query: "季度" }, context(m)));
  assert.equal(a.total, 1); assert.equal(a.tools[0].toolName, "mcp__feishu__docx_v1_document_rawContent");
  const b = JSON.parse(await tool.execute({ action: "list", query: "RAWCONTENT" }, context(m)));
  assert.equal(b.total, 1);
  assert.equal(JSON.parse(await tool.execute({ action: "list", category: "mail", query: "季度" }, context(m))).total, 0);
});
test("飞书describe保留一个真实完整schema，过大时不输出半截schema", async () => {
  const f = fixture(), m = message(), tool = f.exposed(m)[0]!;
  const a = JSON.parse(await tool.execute({ action: "describe", tool_name: "docx_v1_document_rawContent" }, context(m)));
  assert.deepEqual(a.inputSchema, schema); assert.equal(a.toolName, "mcp__feishu__docx_v1_document_rawContent"); assert.equal(a.write, false);
  f.tools[0]!.inputSchema.properties = { body: { type: "string", description: "PRIVATE_SCHEMA_CANARY" + "x".repeat(13000) } };
  const b = await tool.execute({ action: "describe", tool_name: "docx_v1_document_rawContent" }, context(m));
  assert.equal(JSON.parse(b).reason, "schema_too_large"); assert.equal(JSON.parse(b).inputSchema, undefined); assert.equal(b.includes("PRIVATE_SCHEMA_CANARY"), false);
});
test("飞书目录校验分页、分类和describe参数", async () => {
  const f = fixture(), m = message(), tool = f.exposed(m)[0]!;
  for (const args of [{ action: "list", limit: 21 }, { action: "list", limit: 0 }, { action: "list", offset: -1 }, { action: "list", offset: 1.1 },
    { action: "list", category: "contact" }, { action: "list", query: "x".repeat(161) }, { action: "list", namespace: "other" },
    { action: "describe" }, { action: "describe", tool_name: "docx_v1_document_rawContent", limit: 1 }]) {
    assert.equal(JSON.parse(await tool.execute(args, context(m))).reason, "invalid_input");
  }
});
test("飞书调用只能命中当前官方catalog，不能跨MCP命名空间或伪造工具", async () => {
  const f = fixture(), m = message(), call = f.exposed(m)[1]!;
  for (const tool_name of ["mcp__other__drive_v1_file_list", "mcp__feishuevil__drive_v1_file_list", "https://evil/tools", "../drive_v1_file_list"]) {
    assert.equal(JSON.parse(await call.execute({ tool_name, arguments: {} }, context(m))).reason, "invalid_input");
  }
  assert.equal(JSON.parse(await call.execute({ tool_name: "drive_v1_missing_list", arguments: {} }, context(m))).reason, "unavailable");
  assert.equal(f.calls.length, 0);
  const a = JSON.parse(await call.execute({ tool_name: "mcp__feishu__docx_v1_document_rawContent", arguments: { document_id: "doc" } }, context(m)));
  assert.equal(a.status, "ok"); assert.equal(a.toolName, "mcp__feishu__docx_v1_document_rawContent"); assert.equal(a.untrustedData, true);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0]!.args, { document_id: "doc" });
});
test("飞书两个wrapper均固定账号、群、requester、私聊标记并防止撤回后继续调用", async () => {
  const f = fixture(), m = message("读文档", { groupId: "123", conversationId: "group_123" }), tools = f.exposed(m);
  for (const changes of [{ accountId: "other" }, { groupId: "456" }, { requesterId: "owner2" }, { isPrivate: true }]) {
    assert.equal(JSON.parse(await tools[0]!.execute({ action: "list" }, { ...context(m), ...changes })).reason, "forbidden");
    assert.equal(JSON.parse(await tools[1]!.execute({ tool_name: "drive_v1_file_list", arguments: {} }, { ...context(m), ...changes })).reason, "forbidden");
  }
  await tools[1]!.execute({ tool_name: "drive_v1_file_list", arguments: {} }, context(m));
  assert.deepEqual(f.calls[0]!.ctx, context(m)); assert.equal(Object.isFrozen(f.calls[0]!.ctx), true);
  m.status = "recalled";
  assert.equal(JSON.parse(await tools[1]!.execute({ tool_name: "drive_v1_file_list", arguments: {} }, context(m))).reason, "forbidden");
});
test("飞书arguments仅接受有界plain JSON，不调用getter或toJSON", async () => {
  const f = fixture(), m = message(), call = f.exposed(m)[1]!; let getterCalled = false;
  const accessor = Object.defineProperty({}, "secret", { enumerable: true, get: () => { getterCalled = true; return "secret"; } });
  const toJSON = { toJSON: () => { getterCalled = true; return {}; } };
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  let deep: Record<string, unknown> = {}; for (let i = 0; i < 18; i++) deep = { nested: deep };
  for (const args of [null, [], "{}", { body: "中".repeat(22000) }, { bad: undefined }, { bad: Number.NaN }, { bad: 1n }, { bad: new Date() },
    { bad: () => 1 }, { bad: Symbol("symbol") }, { bad: new Array(2) }, cyclic, deep, accessor, toJSON, JSON.parse('{"__proto__":{"polluted":true}}')]) {
    assert.equal(JSON.parse(await call.execute({ tool_name: "drive_v1_file_list", arguments: args }, context(m))).reason, "invalid_input");
  }
  assert.equal(getterCalled, false); assert.equal(f.calls.length, 0);
  const input = { body: "a".repeat(63000), options: [null, true, 1, { value: "ok" }] };
  assert.equal(JSON.parse(await call.execute({ tool_name: "drive_v1_file_list", arguments: input }, context(m))).status, "ok");
  assert.notEqual(f.calls[0]!.args, input); assert.notEqual(f.calls[0]!.args.options, input.options);
});
test("飞书业务写入要求本条实际主人文字，普通聊天、否定、引用和工具内容均不授权", async () => {
  for (const body of ["今天聊聊飞书", "我昨天创建了一个文档", "不要创建文档", "别帮我创建文档", "飞书怎么创建文档？", "帮我看看如何创建文档", "> 帮我创建一个文档", "```帮我创建一个文档```", "他说“帮我创建一个文档”", "do not create a document"]) {
    const f = fixture(), m = message(body), call = f.exposed(m)[1]!;
    assert.equal(JSON.parse(await call.execute({ tool_name: "bitable_v1_appTableRecord_create", arguments: {} }, context(m))).reason, "explicit_instruction_required", body);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(), m = message("闲聊", { textContent: "帮我创建一个文档" });
  assert.equal(JSON.parse(await f.exposed(m)[1]!.execute({ tool_name: "bitable_v1_appTableRecord_create", arguments: {} }, context(m))).reason, "explicit_instruction_required");
});
test("飞书仅按实际明确写指令操作，不将连接能力当成发邮件授权", async () => {
  for (const body of ["帮我创建一个飞书文档", "创建一条记录", "把这个保存到飞书", "我想创建一条记录", "Please create a document", "Can you create a record?"]) {
    const f = fixture(), m = message(body);
    assert.equal(JSON.parse(await f.exposed(m)[1]!.execute({ tool_name: "bitable_v1_appTableRecord_create", arguments: {} }, context(m))).status, "ok", body);
  }
  for (const body of ["飞书已经连上了", "不要发邮件", "创建一个文档", "我昨天发邮件了"]) {
    const f = fixture(), m = message(body);
    assert.equal(JSON.parse(await f.exposed(m)[1]!.execute({ tool_name: "mail_v1_message_send", arguments: {} }, context(m))).reason, "explicit_instruction_required", body);
  }
  const f = fixture(), m = message("帮我发邮件给小王");
  assert.equal(JSON.parse(await f.exposed(m)[1]!.execute({ tool_name: "mail_v1_message_send", arguments: {} }, context(m))).status, "ok");
});
test("飞书读写分类支持官方camelCase并对未知动作保守，不相信模型标志", () => {
  for (const name of ["docx_v1_document_rawContent", "drive_v1_file_list", "bitable_v1_appTableRecord_batchGet", "sheets_v3_spreadsheetSheet_find", "wiki_v2_space_get"]) {
    assert.equal(isFeishuReadOnly(name), true, name); assert.equal(isFeishuWriteTool(`mcp__feishu__${name}`), false, name);
  }
  for (const name of ["bitable_v1_appTableRecord_batchUpdate", "drive_v1_file_copy", "mail_v1_message_send", "sheets_v3_spreadsheetSheet_replace", "unknownAction", "mcp__other__drive_get"]) assert.equal(isFeishuReadOnly(name), false, name);
});
test("飞书日历目录与schema按真实calendar分类并标记精确只读接口", async () => {
  const names = ["calendar_v4_calendar_primary", "calendar_v4_calendarEvent_instances", "calendar_v4_calendarEvent_instanceView", "calendar_v4_calendarEvent_create", "drive_v1_file_list"];
  const f = fixture(names), m = message("查看我的飞书日历"), tools = f.exposed(m);
  const calendarSchema: ToolParamSchema = { type: "object", properties: { path: { type: "object", properties: { calendar_id: { type: "string" } }, required: ["calendar_id"] } }, required: ["path"] };
  f.tools[1]!.inputSchema = calendarSchema;
  assert.ok(tools[0]!.inputSchema.properties?.category?.enum?.includes("calendar"));
  const listed = JSON.parse(await tools[0]!.execute({ action: "list", category: "calendar" }, context(m)));
  assert.equal(listed.total, 4); assert.equal(listed.tools.every((tool: { category: string }) => tool.category === "calendar"), true);
  assert.deepEqual(listed.tools.map((tool: { write: boolean }) => tool.write), [false, false, false, true]);
  const described = JSON.parse(await tools[0]!.execute({ action: "describe", tool_name: names[1] }, context(m)));
  assert.equal(described.category, "calendar"); assert.equal(described.write, false); assert.deepEqual(described.inputSchema, calendarSchema);
  assert.equal(f.calls.length, 0);
});
test("飞书日历无读取动词的三个接口仅按精确名称允许读取，不开放其他MCP或未知动作", async () => {
  const names = ["calendar_v4_calendar_primary", "calendar_v4_calendarEvent_instances", "calendar_v4_calendarEvent_instanceView"];
  const f = fixture(names), m = message("查看我的日历"), call = f.exposed(m)[1]!;
  for (const name of names) {
    assert.equal(isFeishuReadOnly(name), true); assert.equal(isFeishuReadOnly(`mcp__feishu__${name}`), true);
    assert.equal(isFeishuReadOnly(`mcp__other__${name}`), false);
    assert.equal(isFeishuReadOnly(`mcp__feishuevil__${name}`), false);
    assert.equal(isFeishuReadOnly(`${name}_unknown`), false);
    assert.equal(isFeishuReadOnly(`mcp__feishu__mcp__feishu__${name}`), false);
    assert.equal(JSON.parse(await call.execute({ tool_name: name, arguments: {} }, context(m))).status, "ok");
  }
  assert.equal(f.calls.length, 3);
  for (const name of ["calendar_v4_calendar_subscribe", "calendar_v4_calendar_unsubscribe", "calendar_v4_calendarEvent_create", "calendar_v4_calendarEvent_patch", "calendar_v4_calendarEvent_delete", "calendar_v4_calendar_unknown"]) {
    assert.equal(isFeishuReadOnly(name), false); assert.equal(isFeishuReadOnly(`mcp__feishu__${name}`), false);
  }
});
test("飞书日历创建改删与订阅退订分别要求主人本条明确写意图", async () => {
  const operations = [
    ["calendar_v4_calendarEvent_create", "帮我创建明天的飞书日程"],
    ["calendar_v4_calendarEvent_patch", "把这个日程修改为明天下午"],
    ["calendar_v4_calendarEvent_delete", "删除这个飞书日程"],
    ["calendar_v4_calendar_subscribe", "帮我订阅这个日历"],
    ["calendar_v4_calendar_unsubscribe", "帮我退订这个日历"],
  ] as const;
  const f = fixture(operations.map(([name]) => name));
  for (const [tool_name, instruction] of operations) {
    for (const body of ["看看我的日历", "已授权", `不要${instruction}`, `> ${instruction}`, `\u0060\u0060\u0060${instruction}\u0060\u0060\u0060`]) {
      const m = message(body), before = f.calls.length;
      assert.equal(JSON.parse(await f.exposed(m)[1]!.execute({ tool_name, arguments: {} }, context(m))).reason, "explicit_instruction_required", `${tool_name}: ${body}`);
      assert.equal(f.calls.length, before);
    }
    const m = message(instruction);
    assert.equal(JSON.parse(await f.exposed(m)[1]!.execute({ tool_name, arguments: {} }, context(m))).status, "ok", instruction);
  }
  for (const [tool_name, body] of [["calendar_v4_calendar_unsubscribe", "帮我订阅这个日历"], ["calendar_v4_calendar_subscribe", "帮我退订这个日历"], ["calendar_v4_calendar_subscribe", "帮我取消订阅这个日历"], ["calendar_v4_calendar_subscribe", "帮我创建一个日程"]]) {
    const m = message(body), before = f.calls.length;
    assert.equal(JSON.parse(await f.exposed(m)[1]!.execute({ tool_name, arguments: {} }, context(m))).reason, "explicit_instruction_required");
    assert.equal(f.calls.length, before);
  }
});
test("飞书工具目录热更新，无需重建wrapper且不暴露其他server", async () => {
  const f = fixture([]), m = message(), tools = f.exposed(m);
  assert.equal(JSON.parse(await tools[0]!.execute({ action: "list" }, context(m))).total, 0);
  f.tools.push({ name: "mcp__feishu__wiki_v2_space_list", description: "new", inputSchema: { type: "object" }, execute: async () => "[]" });
  assert.equal(JSON.parse(await tools[0]!.execute({ action: "list" }, context(m))).total, 1);
  assert.equal(JSON.parse(await tools[1]!.execute({ tool_name: "wiki_v2_space_list", arguments: {} }, context(m))).status, "ok");
});
test("飞书异常和错误envelope只返回固定失败，不泄漏凭据路径或raw错误", async () => {
  const f = fixture(), m = message(), call = f.exposed(m)[1]!;
  for (const operation of [async () => { throw new Error("Bearer secret-canary /opt/private/cookie"); }, async () => JSON.stringify({ code: 999, msg: "secret-canary /opt/private/cookie" }),
    async () => JSON.stringify({ status: "failed", secret: "secret-canary" }), async () => "Error: Bearer secret-canary"]) {
    f.tools[0]!.execute = operation;
    const response = await call.execute({ tool_name: "docx_v1_document_rawContent", arguments: {} }, context(m));
    assert.equal(JSON.parse(response).reason, "unavailable"); assert.equal(response.includes("secret-canary"), false); assert.equal(response.includes("/opt/"), false);
  }
});
test("飞书资料结果和目录最多12000字符，截断保留合法JSON和不可信标记", async () => {
  const f = fixture(), m = message(), call = f.exposed(m)[1]!;
  f.tools[0]!.execute = async () => JSON.stringify({ text: '\\"\n'.repeat(20000) + "TAIL" });
  const output = await call.execute({ tool_name: "docx_v1_document_rawContent", arguments: {} }, context(m));
  assert.ok(output.length <= 12000); assert.equal(JSON.parse(output).truncated, true); assert.equal(JSON.parse(output).untrustedData, true); assert.equal(output.includes("TAIL"), false);
  const many = fixture(Array.from({ length: 20 }, (_, i) => "drive_v1_file_list_" + i + "x".repeat(180)));
  for (const t of many.tools) t.description = '\\"\n'.repeat(1000);
  const listed = await many.exposed(m)[0]!.execute({ action: "list", limit: 20 }, context(m));
  assert.ok(listed.length <= 12000); assert.ok(JSON.parse(listed).tools.length > 0);
});
test("飞书HTTP成功中的业务权限失败保留安全code分类，绝不当作读取成功", async () => {
  const f = fixture(), m = message(), call = f.exposed(m)[1]!;
  for (const [code, reason] of [[99991672, "permission"], [99991676, "permission"], [99991679, "permission"], [99991663, "authentication"], [99991677, "authentication"], [99991403, "quota"], [123456, "unavailable"]] as const) {
    f.tools[0]!.execute = async () => JSON.stringify({ code, msg: "Bearer secret-canary /opt/private/cookie", error: { permission_link: "https://example.invalid/?token=secret-canary" } });
    const response = await call.execute({ tool_name: "docx_v1_document_rawContent", arguments: {} }, context(m)), result = JSON.parse(response);
    assert.equal(result.status, "failed"); assert.equal(result.reason, reason); assert.equal(result.code, code);
    assert.equal(result.result, undefined); assert.equal(response.includes("secret-canary"), false); assert.equal(response.includes("/opt/"), false); assert.equal(response.includes("https:"), false);
  }
});
test("飞书MCP抛出的权限和凭据错误仅提取已知code，未知错误文本不透传", async () => {
  const f = fixture(), m = message(), call = f.exposed(m)[1]!;
  for (const [error, reason, code] of [
    [new Error('{"code":99991672,"msg":"secret-canary https://example.invalid /opt/private"}'), "permission", 99991672],
    [new Error('upstream failed: {"code": 99991663, "msg":"Bearer secret-canary"}'), "authentication", 99991663],
    [{ code: 99991679, msg: "secret-canary" }, "permission", 99991679],
    [new Error('query https://example.invalid/?code=99991672&token=secret-canary'), "unavailable", undefined],
  ] as const) {
    f.tools[0]!.execute = async () => { throw error; };
    const response = await call.execute({ tool_name: "docx_v1_document_rawContent", arguments: {} }, context(m)), result = JSON.parse(response);
    assert.equal(result.status, "failed"); assert.equal(result.reason, reason); assert.equal(result.code, code);
    assert.equal(response.includes("secret-canary"), false); assert.equal(response.includes("/opt/"), false); assert.equal(response.includes("https:"), false);
  }
});
test("官方飞书MCP成功时已解包data，保留真实files数组且不伪造code零", async () => {
  const f = fixture(), m = message(), call = f.exposed(m)[1]!;
  f.tools[1]!.execute = async () => JSON.stringify({ files: [{ name: "fixture-note", token: "fixture-file" }], has_more: false });
  const response = JSON.parse(await call.execute({ tool_name: "drive_v1_file_list", arguments: { params: { page_size: 1 } } }, context(m)));
  assert.equal(response.status, "ok"); assert.equal(response.result.files.length, 1); assert.equal(response.result.has_more, false);
  assert.equal(response.result.code, undefined); assert.equal(response.code, undefined); assert.equal(response.untrustedData, true);
});
