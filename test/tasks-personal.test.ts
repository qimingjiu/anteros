import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../src/db/index.js";
import { TaskLedger, taskText, isTaskRequest, isTaskReadOnly } from "../src/tasks/index.js";
import { PersonalMemory } from "../src/memory/personal.js";
import type { MessageRecord } from "../src/types.js";

const message = (textContent: string, groupId?: string, senderId = "owner", accountId = "a"): MessageRecord => ({
  eventKey:"event",accountId,providerId:"onebot",conversationId:groupId ? `group_${groupId}` : `private_${senderId}`,
  groupId,messageId:"1",senderId,displayNameAtTime:"主人",sentAt:new Date().toISOString(),receivedAt:new Date().toISOString(),
  segments:[{type:"text",data:{text:textContent}}],textContent,status:"active",origin:"live",
});
test("progress questions and negative search instructions do not create new work",()=>{
  assert.equal(isTaskRequest("查询一下任务状态，别重新搜索"),false);
  assert.equal(isTaskRequest("不要搜了"),false);
  assert.equal(isTaskRequest("帮我查询资料"),true);
  assert.equal(isTaskRequest("别再搜了，把结果做成文档"),true);
});
test("task receipts preserve incomplete work, scope and cancellation across ledger restart", t => {
  const db=new Database(":memory:");t.after(()=>db.close());const ledger=new TaskLedger(db);
  const m=message("搜索这个项目并发文档","g");const a=ledger.begin(m);
  assert.equal(ledger.begin(m).id,a.id);
  assert.equal(ledger.get(a.id,ledger.scope(message("","other"))),undefined);
  assert.equal(ledger.get(a.id,ledger.scope(message("",undefined,"other"))),undefined);
  const step=ledger.stepStart(a.id,"web_search");ledger.stepEnd(a.id,step,"web_search",false,"链接 https://example.com");
  assert.equal(ledger.recoverInterrupted("a"),1);assert.equal(new TaskLedger(db).get(a.id,ledger.scope(m))!.state,"interrupted");
  assert.match(JSON.stringify(ledger.detail(a.id,ledger.scope(message("")))),/example.com/u);
  assert.equal(ledger.cancel(a.id,ledger.scope(m)),true);ledger.finish(a.id,"done");
  assert.equal(ledger.get(a.id,ledger.scope(m))!.state,"cancelled");assert.equal(ledger.stepStart(a.id,"create_order"),undefined);
});
test("task with no actual tool result remains unfinished and credentials are redacted", t => {
  const db=new Database(":memory:");t.after(()=>db.close());const ledger=new TaskLedger(db);const m=message("帮我搜");
  const a=ledger.begin(m);ledger.finish(a.id,"我会去搜");assert.equal(ledger.get(a.id,ledger.scope(m))!.state,"waiting_input");
  assert.doesNotMatch(taskText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz api_key=verysecret"),/abcdefghijklmnopqrstuvwxyz|verysecret/u);
});
test("blocked unknown write cannot become completed merely because diagnostics returned",t=>{
  const db=new Database(":memory:");t.after(()=>db.close());const ledger=new TaskLedger(db);const m=message("创建订单");
  const a=ledger.begin(m),s=ledger.stepStart(a.id,"mcp__shop__create_order",{item:"coffee"});
  ledger.stepEnd(a.id,s,"mcp__shop__create_order",true,"网络中断，回执不明",{item:"coffee"});ledger.finish(a.id,"未确认",true);
  ledger.resume(a.id,ledger.scope(m));ledger.blockedWrite(a.id,"mcp__shop__create_order");
  const diagnostic=ledger.stepStart(a.id,"runtime_diagnostics");ledger.stepEnd(a.id,diagnostic,"runtime_diagnostics",false,"诊断完成");
  ledger.finish(a.id,"没有重下订单，状态需要核对");assert.equal(ledger.get(a.id,ledger.scope(m))!.state,"waiting_input");
});
test("explicit personal memory is private by default and sharing requires actual owner request", async t => {
  const db=new Database(":memory:");t.after(()=>db.close());const memory=new PersonalMemory(db,["g","h"]);
  const privateMessage=message("记住：推荐工具优先免费档");
  const run=(m:MessageRecord,args:Record<string,unknown>)=>memory.tool(m).execute(args,{accountId:m.accountId,requesterId:m.senderId,isPrivate:!m.groupId,groupId:m.groupId});
  const saved=JSON.parse(await run(privateMessage,{action:"save",content:"推荐工具优先免费档"}));
  assert.equal(saved.entry.visibility,"private");assert.equal(memory.list(message("","g")).length,0);
  assert.equal(memory.list(message("",undefined,"other")).length,0);assert.equal(memory.list(message("",undefined,"owner","b")).length,0);
  assert.equal(JSON.parse(await run(privateMessage,{action:"update",id:saved.entry.id,content:"免费优先",visibility:"shared"})).status,"error");
  const shared=message("更新这条记忆，私聊和获准群聊都可以用");
  assert.equal(JSON.parse(await run(shared,{action:"update",id:saved.entry.id,content:"免费优先",visibility:"shared"})).status,"updated");
  assert.equal(memory.list(message("","g")).length,1);assert.equal(memory.list(message("","unapproved")).length,0);
  assert.equal(JSON.parse(await run(message("忘掉这条","g"),{action:"delete",id:saved.entry.id})).status,"deleted");
});

test("同一轮飞书、衔枝和邮件写入已有回执时禁止重复，读取保持可重查",t=>{
  const db=new Database(":memory:");t.after(()=>db.close());const ledger=new TaskLedger(db),m=message("飞书创建文档并记住约定");
  const task=ledger.begin(m);
  for(const [tool,args] of [["feishu_call",{tool_name:"docx_v1_document_create",arguments:{title:"Fixture"}}],
    ["muninn_memory",{action:"save",text:"Fixture"}],["email",{action:"send",to:"fixture@example.com",subject:"Fixture",text:"Fixture"}]] as const){
    const step=ledger.stepStart(task.id,tool,args);ledger.stepEnd(task.id,step,tool,true,"回执不明",args);
    assert.ok(ledger.previousWrite(task.id,tool,args,m.eventKey));
  }
  for(const [name,args] of [["feishu_tools",{}],["feishu_call",{tool_name:"docx_v1_document_rawContent"}],
    ["feishu_call",{tool_name:"drive_v1_file_list"}],["muninn_memory",{action:"claims"}],
    ...["status","list","search","read"].map(action=>["email",{action}] as const)] as const){
    assert.equal(isTaskReadOnly(name,args),true);
    assert.equal(ledger.previousWrite(task.id,name,args,m.eventKey),undefined);
  }
  assert.equal(isTaskReadOnly("feishu_call",{tool_name:"mail_v1_userMailboxMessage_send"}),false);
  assert.equal(isTaskReadOnly("email",{action:"send"}),false);
  assert.equal(isTaskReadOnly("email",{action:"delete"}),false);
});
test("group memory visibility and provenance remain bounded, ordinary chat cannot save", async t=>{
  const db=new Database(":memory:");t.after(()=>db.close());const memory=new PersonalMemory(db,["g","h"]);
  const m=message("我今天吃了面","g");const tool=memory.tool(m);const ctx={accountId:"a",requesterId:"owner",groupId:"g",isPrivate:false};
  assert.equal(JSON.parse(await tool.execute({action:"save",content:"吃面"},ctx)).status,"error");
  const good=memory.tool(message("记住这个群的约定","g"));
  const saved=JSON.parse(await good.execute({action:"save",content:"每周一起读书"},ctx));
  assert.equal(saved.entry.sourceMessageId,"1");assert.equal(memory.list(message("","h")).length,0);
  assert.equal(memory.list(message("")).length,1);
});
