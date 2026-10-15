import {test, type TestContext} from "node:test";
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {loadConfig} from "../src/config.js";
import {Database} from "../src/db/index.js";
import type {Gateway} from "../src/gateway/index.js";
import type {McpManager} from "../src/tools/mcp.js";
import {RuntimeDiagnostics, type RuntimeDiagnosticsReadRequest} from "../src/diagnostics/index.js";
import {runtimeDiagnosticStatus, type RuntimeDiagnosticDeps} from "../src/diagnostics/runtime.js";

const SECRET = "PRIVATE_CHAT_AND_API_SECRET_MUST_NOT_ENTER_MODEL_768f3";
const NOW = Date.now();
function fixture(t: TestContext) {
  const db = new Database(":memory:");
  t.after(()=>db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml",import.meta.url)));
  cfg.gateway.accountId = "acct";
  cfg.model.profiles = [{name:"selected",provider:"openai_compatible",model:"deepseek-flash",baseUrl:"https://model.invalid",apiKey:SECRET}];
  db.kvSet("active_model_profile","selected");
  const task = (target: string, conversationType:"group"|"private",status:"failed"|"unknown",old=false) => {
    const row = db.enqueueSendTask({kind:"document_file",conversationType,targetId:target,payload:{kind:"file",filePath:SECRET,fileName:SECRET}});
    db.claimSendTask(row.id);
    db.finishSendTask(row.id,status,SECRET);
    db.db.prepare("UPDATE send_tasks SET updated_at=? WHERE id=?").run(new Date(NOW-(old?25*3600_000:1000)).toISOString(),row.id);
  };
  task("100","group","failed"); task("200","group","unknown"); task("300","private","failed"); task("100","group","failed",true);
  const deps:RuntimeDiagnosticDeps = {cfg,db,searchReady:true,readerReady:true,documentsReady:true,weatherReady:false,now:()=>NOW,
    gateway:{getProvider:()=>({health:()=>({connection:"connected",login:"online",selfId:SECRET,reconnectCount:0,lastError:`HTTP 403 ${SECRET}`}),
      capabilities:()=>({sendText:"supported",sendPrivateFile:"unverified"})})} as unknown as Gateway,
    mcp:{statuses:()=>[{name:"music",transport:"stdio",connected:true,tools:2},
      {name:`unsafe ${SECRET}`,transport:"http",connected:false,tools:0,error:`HTTP 401 ${SECRET}`}]} as unknown as McpManager,
    presence:{async context(){return SECRET;},status:()=>({enabled:true,configured:true,source:"device_events",supportedFields:[],
      lastFetch:{at:new Date(NOW).toISOString(),status:"failed",httpStatus:200,failure:"invalid_json"},
      cacheExpiresAt:null,currentFieldCount:0,currentFreshFieldCount:0})},
    proactive:{status:()=>({enabled:true,paused:false,recipientId:SECRET,groupId:SECRET})} as unknown as RuntimeDiagnosticDeps["proactive"]};
  const diagnostics = new RuntimeDiagnostics({subscribeLogs:false,now:()=>NOW,currentStatus:request=>runtimeDiagnosticStatus(deps,request)});
  t.after(()=>diagnostics.close());
  const request:RuntimeDiagnosticsReadRequest = {scope:"conversation",accountId:"acct",conversationId:"group_100"};
  return {deps,diagnostics,request};
}

test("运行诊断状态：群只统计当前群近24小时任务，不读payload、不返回私聊手机或计划",t=>{
  const f=fixture(t);
  const result=JSON.parse(f.diagnostics.read(f.request));
  const docs=result.current.find((item:any)=>item.component==="documents");
  assert.equal(docs.details.failedTasks,1);
  assert.equal(docs.details.unknownTasks,0);
  assert.equal(result.current.some((item:any)=>["presence","memory","proactive"].includes(item.component)),false);
  assert.equal(JSON.stringify(result).includes(SECRET),false);
  assert.equal(result.current.find((item:any)=>item.component==="gateway").failure,"permission");
});

test("运行诊断状态：主人私聊显示安全全局状态，HTTP分类与缺测类型准确，无原始错误或密钥",t=>{
  const f=fixture(t);
  const result=JSON.parse(f.diagnostics.read({...f.request,scope:"global",conversationId:"private_300"}));
  const docs=result.current.find((item:any)=>item.component==="documents");
  assert.equal(docs.details.failedTasks,2);
  assert.equal(docs.details.unknownTasks,1);
  assert.deepEqual(result.current.find((item:any)=>item.component==="model").details,{model:"deepseek-flash",provider:"openai_compatible"});
  assert.equal(result.current.find((item:any)=>item.component==="presence").failure,"invalid_response");
  assert.ok(result.current.some((item:any)=>item.component==="mcp"&&item.failure==="authentication"&&item.httpStatus===401));
  assert.equal(JSON.stringify(result).includes(SECRET),false);
});

test("运行诊断状态：不接受不同账号，也不将缺少群目标的请求扩大为全局任务统计",t=>{
  const f=fixture(t);
  assert.deepEqual(runtimeDiagnosticStatus(f.deps,{...f.request,accountId:"other"}),[{component:"system",ready:false,failure:"permission"}]);
  const result=JSON.parse(f.diagnostics.read({...f.request,conversationId:"private_300"}));
  const docs=result.current.find((item:any)=>item.component==="documents");
  assert.equal(docs.details.failedTasks,0);
  assert.equal(docs.details.unknownTasks,0);
});
