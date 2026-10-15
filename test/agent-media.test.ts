import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {Agent} from "../src/agent/index.js";
import {Database} from "../src/db/index.js";
import {loadConfig} from "../src/config.js";
import {RuntimeDiagnostics} from "../src/diagnostics/index.js";
import type {Gateway} from "../src/gateway/index.js";
import type {McpManager} from "../src/tools/mcp.js";
import type {MessageRecord,ToolDef} from "../src/types.js";
import type {ChatResult} from "../src/llm/index.js";

function fixture(t:TestContext,scopedAdapters=false){
  const cfg=loadConfig(fileURLToPath(new URL("../config.sim.yaml",import.meta.url)));
  cfg.gateway.accountId="acct";cfg.admins=["10000"];cfg.tools.ownerIds=["10000"];cfg.tools.enabled=true;
  cfg.tools.minimax={enabled:true};cfg.groups.allowlist=["20000"];
  cfg.tools.feishu={enabled:scopedAdapters};cfg.tools.muninn={enabled:scopedAdapters};
  cfg.tools.email={enabled:scopedAdapters};
  const db=new Database(":memory:"),diagnostics=new RuntimeDiagnostics({subscribeLogs:false});
  t.after(()=>{diagnostics.close();db.close();});
  let rawCalls=0,wrappedCalls=0,body=JSON.stringify({generated:true,status:"confirmed"});
  const raw:ToolDef[]=["text_to_audio","text_to_image","list_voices"].map(name=>({name:`mcp__minimax__${name}`,description:name,
    inputSchema:{type:"object"},execute:async()=>{rawCalls++;return "raw";}}));
  if(scopedAdapters)raw.push(...[...Array.from({length:227},(_,i)=>`mcp__feishu__drive_v1_fixture_${i}`),"mcp__muninn__memory_context"].map(name=>({
    name,description:name,inputSchema:{type:"object" as const},execute:async()=>{rawCalls++;return "raw";}})));
  const scopes:MessageRecord[]=[];
  const media={toolsFor(message:MessageRecord):ToolDef[]{scopes.push(message);return ["generate_image","generate_english_speech"].map(name=>({name,
    description:name,inputSchema:{type:"object"},execute:async()=>{wrappedCalls++;return body;}}));}};
  const gateway={getProvider:()=>({health:()=>({selfId:"bot"})}),enqueueSend(){assert.fail("No QQ delivery in this test");}} as unknown as Gateway;
  const steps:ChatResult[]=[],modelTools:string[][]=[];
  const fakeTools=(names:string[])=>({toolsFor:()=>names.map(name=>({name,description:name,inputSchema:{type:"object" as const},execute:async()=>JSON.stringify({status:"ok"})}))});
  const agent=new Agent({db,cfg,gateway,llm:{async chat(_messages,options){modelTools.push(options?.tools?.map(t=>t.function.name)??[]);const result=steps.shift();if(!result)throw Error("Unexpected model call");return result;}},memory:null,search:null,reader:null,
    mcp:{getTools:()=>raw} as unknown as McpManager,minimaxMedia:media,diagnostics,timezone:cfg.timezone}) as unknown as {
      buildToolSpecs(m:MessageRecord):{function:{name:string}}[];executeTool(name:string,args:string,m:MessageRecord):Promise<string>;
      generateReply(m:MessageRecord,merged:MessageRecord[]):Promise<string|null>;
    };
  if(scopedAdapters)Object.assign(agent,{feishuTools:fakeTools(["feishu_tools","feishu_call"]),muninnMemory:fakeTools(["muninn_memory"]),
    email:{toolsFor:()=>[{name:"email",description:"email",inputSchema:{type:"object"},execute:async()=>body}]}});
  const message=(patch:Partial<MessageRecord>={}):MessageRecord=>({eventKey:"media:test",accountId:"acct",providerId:"onebot",
    conversationId:"private_10000",messageId:"fixture",senderId:"10000",displayNameAtTime:"owner",sentAt:new Date().toISOString(),receivedAt:new Date().toISOString(),
    segments:[{type:"text",data:{text:"生成图片和英文语音"}}],textContent:"生成图片和英文语音",origin:"live",status:"active",...patch});
  const names=(m:MessageRecord)=>agent.buildToolSpecs(m).map(spec=>spec.function.name);
  return {cfg,agent,diagnostics,message,names,scopes,steps,modelTools,setBody:(value:string)=>{body=value;},counts:()=>({rawCalls,wrappedCalls})};
}

test("媒体工具：主人私聊和启用群均使用受限封装，不能调用原始MiniMax生成接口",async t=>{
  const f=fixture(t);
  for(const m of [f.message(),f.message({groupId:"20000",conversationId:"group_20000"})]){
    const tools=f.names(m);assert.ok(tools.includes("generate_image"));assert.ok(tools.includes("generate_english_speech"));
    assert.ok(tools.includes("mcp__minimax__list_voices"));
    assert.ok(!tools.includes("mcp__minimax__text_to_audio"));assert.ok(!tools.includes("mcp__minimax__text_to_image"));
    for(const name of ["mcp__minimax__text_to_audio","mcp__minimax__text_to_image"])
      assert.match(await f.agent.executeTool(name,"{}",m),/不存在或当前不可用/u);
  }
  const m=f.message();assert.equal(JSON.parse(await f.agent.executeTool("generate_image",'{}',m)).status,"confirmed");
  assert.ok(f.scopes.includes(m));assert.deepEqual(f.counts(),{rawCalls:0,wrappedCalls:1});
});

test("媒体工具：关闭、非主人、历史、撤回、其他账号及戳一戳均不能生成",async t=>{
  const f=fixture(t);
  for(const patch of [{senderId:"30000"},{accountId:"foreign"},{origin:"backfill" as const},{status:"recalled" as const},
    {interaction:"poke" as const},{groupId:"disabled",conversationId:"group_disabled"}]){
    const m=f.message(patch);assert.ok(!f.names(m).includes("generate_english_speech"));
    assert.match(await f.agent.executeTool("generate_english_speech",'{}',m),/不存在或当前不可用/u);
  }
  f.cfg.tools.minimax={enabled:false};assert.ok(!f.names(f.message()).includes("generate_image"));
  assert.ok(!f.names(f.message()).includes("mcp__minimax__text_to_image"));
  assert.deepEqual(f.counts(),{rawCalls:0,wrappedCalls:0});
});

test("媒体工具：结果不明进入诊断且保留JSON回执，不把不明投递记为成功",async t=>{
  const f=fixture(t);f.setBody(JSON.stringify({generated:true,status:"unknown",detail:"回执不明，不自动重试"}));
  const result=JSON.parse(await f.agent.executeTool("generate_english_speech","{}",f.message()));
  assert.equal(result.status,"unknown");assert.match(result.diagnosticHint,/不自动/u);
  const events=f.diagnostics.snapshot({scope:"global",accountId:"acct",conversationId:"private_10000"}).events;
  assert.ok(events.some(event=>event.reason==="delivery_unknown"));
});

test("飞书和衔枝：数百内部接口只暴露三个受限入口，原始接口不能绕过隔离",async t=>{
  const f=fixture(t,true),m=f.message();
  const names=f.names(m);for(const name of ["feishu_tools","feishu_call","muninn_memory"])assert.ok(names.includes(name));
  assert.ok(names.length<128);assert.ok(!names.some(name=>/^mcp__(?:feishu|muninn)__/u.test(name)));
  for(const name of ["mcp__feishu__drive_v1_fixture_0","mcp__muninn__memory_context"])
    assert.match(await f.agent.executeTool(name,"{}",m),/不存在或当前不可用/u);
  assert.equal(f.counts().rawCalls,0);
  for(const senderId of ["30000"]){const ordinary=f.names(f.message({senderId}));assert.ok(!ordinary.includes("feishu_call"));assert.ok(!ordinary.includes("muninn_memory"));}
});

test("明确飞书任务为目录发现和实际操作保留有界多步机会",async t=>{
  const f=fixture(t,true),text="请在飞书查找这个文档";
  for(let i=0;i<4;i++)f.steps.push({content:"",toolCalls:[{id:`meta-${i}`,name:"feishu_tools",arguments:'{"action":"list"}'}],finishReason:"tool_calls"});
  f.steps.push({content:"已依据目录结果回答。",toolCalls:[],finishReason:"stop"});
  const m=f.message({textContent:text,segments:[{type:"text",data:{text}}]});
  assert.equal(await f.agent.generateReply(m,[]),"已依据目录结果回答。");
  assert.ok(f.modelTools[3]!.includes("feishu_tools"));assert.equal(f.modelTools.length,5);
});

test("个人日历查询保留目录、schema及日历编号发现需要的有界多轮机会",async t=>{
  const f=fixture(t,true),text="看看我明天的日程";
  for(let i=0;i<4;i++)f.steps.push({content:"",toolCalls:[{id:`calendar-${i}`,name:"feishu_tools",arguments:'{"action":"list","category":"calendar"}'}],finishReason:"tool_calls"});
  f.steps.push({content:"已根据日历工具结果回答。",toolCalls:[],finishReason:"stop"});
  const m=f.message({textContent:text,segments:[{type:"text",data:{text}}]});
  assert.equal(await f.agent.generateReply(m,[]),"已根据日历工具结果回答。");
  assert.ok(f.modelTools[3]!.includes("feishu_tools"));assert.equal(f.modelTools.length,5);
});

test("邮箱集成只向当前有效主人会话开放，关闭后不暴露工具",async t=>{
  const f=fixture(t,true);
  assert.ok(f.names(f.message()).includes("email"));
  assert.ok(f.names(f.message({groupId:"20000",conversationId:"group_20000"})).includes("email"));
  for(const patch of [{senderId:"30000"},{accountId:"foreign"},{origin:"backfill" as const},
    {status:"recalled" as const},{interaction:"poke" as const},{groupId:"disabled",conversationId:"group_disabled"}]){
    const m=f.message(patch);assert.ok(!f.names(m).includes("email"));
    assert.match(await f.agent.executeTool("email",'{"action":"status"}',m),/不存在或当前不可用/u);
  }
  f.cfg.tools.email={enabled:false};assert.ok(!f.names(f.message()).includes("email"));
});

test("邮箱发送结果不明保留JSON并写入邮箱诊断，认证失败分类准确",async t=>{
  for(const [status,reason,expected] of [["unknown","delivery_unknown","delivery_unknown"],["failed","authentication","authentication"]]){
    const f=fixture(t,true),m=f.message();
    f.setBody(JSON.stringify({status,reason}));
    const result=JSON.parse(await f.agent.executeTool("email",'{"action":"send"}',m));
    assert.equal(result.status,status);assert.equal(result.reason,reason);assert.ok(result.diagnosticHint);
    const events=f.diagnostics.snapshot({scope:"global",accountId:"acct",conversationId:"private_10000"}).events;
    assert.ok(events.some(event=>event.component==="email"&&event.reason===expected&&event.operation==="email"));
  }
});
