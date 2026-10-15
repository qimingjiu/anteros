import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/index.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db/index.js";
import { ResearchRuntime } from "../src/tools/research.js";
import { createSearchProvider } from "../src/tools/search.js";
import type { Gateway } from "../src/gateway/index.js";
import type { McpManager } from "../src/tools/mcp.js";
import type { LLMClient, ChatMessage, ChatResult } from "../src/llm/index.js";
import type { MessageRecord } from "../src/types.js";

function fixture(t: TestContext) {
  const db = new Database(":memory:"); t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)));
  cfg.gateway.accountId = "acct"; cfg.admins = ["10001"]; cfg.tools.ownerIds = cfg.admins;
  cfg.memory.enabled = false; cfg.groups.linkPreview = false;
  const runtime = new ResearchRuntime({ limits: { maxQueries: 2, maxSearchRequests: 2 }, perHostDelayMs: 0 });
  let requests = 0;
  const search = createSearchProvider({ ...cfg.tools.search, provider: "tavily", tavilyApiKey: "fixture-key", fallbackProviders: [] }, runtime,
    (async () => { requests++; return new Response(JSON.stringify({ results: [{title:"Fixture source",url:"https://example.com/article",content:"Verified fixture material"}] })); }) as typeof fetch);
  const steps: ChatResult[] = [];
  const captured: ChatMessage[][] = [];
  const llm: LLMClient = { async chat(messages) { captured.push(structuredClone(messages)); const step = steps.shift(); assert.ok(step); return step; } };
  const gateway = { getProvider: () => ({ health: () => ({selfId:"bot"}) }) } as unknown as Gateway;
  const agent = new Agent({db,cfg,gateway,llm,search,reader:null,memory:null,mcp:{getTools:()=>[]} as unknown as McpManager,
    research:runtime,timezone:cfg.timezone}) as unknown as {generateReply(message:MessageRecord,merged:MessageRecord[]):Promise<string|null>};
  const message = (conversationId="private_10001"): MessageRecord => ({eventKey:"fixture",accountId:"acct",providerId:"onebot",
    conversationId,messageId:"1",senderId:"10001",displayNameAtTime:"fixture",sentAt:new Date().toISOString(),receivedAt:new Date().toISOString(),
    segments:[{type:"text",data:{text:"查证公开资料"}}],textContent:"查证公开资料",status:"active",origin:"live"});
  const call = (query:string,id:string): ChatResult => ({content:"",toolCalls:[{id,name:"web_search",arguments:JSON.stringify({query})}],finishReason:"tool_calls"});
  const answer = (): ChatResult => ({content:"已根据取得的公开资料回答。",toolCalls:[],finishReason:"stop"});
  return {agent,steps,captured,message,call,answer,requests:()=>requests};
}

test("all model tool rounds share one research budget and still permit a final answer", async t => {
  const f=fixture(t);
  f.steps.push(f.call("query one","s1"),f.call("query two","s2"),f.call("query three","s3"),f.answer());
  assert.match((await f.agent.generateReply(f.message(),[]))!,/公开资料/);
  assert.equal(f.requests(),2);
  const toolMessages=f.captured.at(-1)!.filter(message=>message.role==="tool");
  assert.match(String(toolMessages.find(message=>message.tool_call_id==="s3")?.content),/budget|预算/);
});

test("one conversation reuses search cache across replies while another conversation cannot", async t => {
  const f=fixture(t);
  for (const conversation of ["private_10001","private_10001","private_fixture_other"]) {
    f.steps.push(f.call("same public query","search"),f.answer());
    await f.agent.generateReply(f.message(conversation),[]);
  }
  assert.equal(f.requests(),2);
});

test("search tool explicitly distinguishes search snippets from a read source", async t => {
  const f=fixture(t);
  f.steps.push(f.call("public query","search"),f.answer());
  await f.agent.generateReply(f.message(),[]);
  const result=f.captured.at(-1)!.find(message=>message.tool_call_id==="search");
  assert.match(String(result?.content),/搜索服务: tavily/);
  assert.match(String(result?.content),/详细事实需要读取原文核对/);
  assert.match(String(result?.content),/研究回执/);
  assert.doesNotMatch(JSON.stringify(f.captured),/fixture-key/);
});
