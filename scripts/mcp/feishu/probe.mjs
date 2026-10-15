import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
const base = '/opt/qq-group-bot-mcp/feishu';
const credentials = {};
for (const line of readFileSync(base+'/.env','utf8').split(/\r?\n/)) {
 const match = /^([A-Z_]+)=(.*)$/.exec(line); if(match) credentials[match[1]]=match[2].replace(/^(["'])(.*)\1$/, '$2');
}
const tokenResponse = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
 method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:credentials.FEISHU_APP_ID,app_secret:credentials.FEISHU_APP_SECRET})});
const tokenInfo=await tokenResponse.json();
console.log('TENANT_AUTH',JSON.stringify({httpStatus:tokenResponse.status,code:tokenInfo.code,expires:tokenInfo.expire,hasToken:!!tokenInfo.tenant_access_token}));
const scopeResponse=await fetch('https://open.feishu.cn/open-apis/application/v6/scopes',{headers:{Authorization:'Bearer '+tokenInfo.tenant_access_token}});
const scopeInfo=await scopeResponse.json();
const scopeStatus={httpStatus:scopeResponse.status,code:scopeInfo.code,scopes:(scopeInfo.data?.scopes??[]).map(x=>({name:x.scope_name,status:x.grant_status,type:x.scope_type}))};
console.log('GRANTED_SCOPES',JSON.stringify({code:scopeStatus.code,count:scopeStatus.scopes.length,types:[...new Set(scopeStatus.scopes.map(x=>x.type))],relevant:scopeStatus.scopes.filter(x=>['space:document:retrieve','wiki:space:retrieve','sheets:spreadsheet:read','docx:document:readonly'].includes(x.name))}));
console.log('SCOPE_OBJECT_KEYS',JSON.stringify(Object.keys(scopeInfo.data?.scopes?.[0]??{})));
const appResponse=await fetch('https://open.feishu.cn/open-apis/application/v6/applications/me?lang=zh_cn',{headers:{Authorization:'Bearer '+tokenInfo.tenant_access_token}});
const appInfo=await appResponse.json();
console.log('APP_INFO_KEYS',JSON.stringify({httpStatus:appResponse.status,code:appInfo.code,dataKeys:Object.keys(appInfo.data??{}),appKeys:Object.keys(appInfo.data?.app??{})}));
console.log('APP_SCOPE_SAMPLE',JSON.stringify({appStatus:appInfo.data?.app?.status,count:appInfo.data?.app?.scopes?.length,scopeSamples:appInfo.data?.app?.scopes?.filter(x=>/space:document:retrieve|wiki:space:retrieve/.test(JSON.stringify(x)))}));
const child=spawn(process.execPath,['--env-file='+base+'/.env',base+'/run.mjs'],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:base,NODE_ENV:'production'}});
let buffer='',id=0;const waiters=new Map();let stderrBytes=0;
child.stderr.on('data',c=>{stderrBytes+=c.length;});
child.stdout.on('data',c=>{buffer+=c.toString();let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const m=JSON.parse(line);if(m.id && waiters.has(m.id)){waiters.get(m.id)(m);waiters.delete(m.id);}}catch{}}});
const call=(method,params)=>new Promise((resolve,reject)=>{const requestId=++id;const timer=setTimeout(()=>{waiters.delete(requestId);reject(Error('timeout'));},60000);waiters.set(requestId,m=>{clearTimeout(timer);if(m.error)reject(Error('rpc_error'));else resolve(m.result);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n');});
const result={packageVersion:'0.5.1',tenantAuth:{httpStatus:tokenResponse.status,code:tokenInfo.code,hasToken:!!tokenInfo.tenant_access_token},scopeStatus,readonlyChecks:[]};
try {
 const init=await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'qqbot-readonly-validation',version:'1'}});
 result.serverInfo=init.serverInfo;
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const listing=await call('tools/list',{});result.tools=listing.tools;
 console.log('MCP_DISCOVERY',JSON.stringify({serverInfo:init.serverInfo,count:listing.tools?.length,names:listing.tools?.slice(0,8).map(x=>x.name)}));
 writeFileSync(base+'/discovery.json',JSON.stringify({serverInfo:init.serverInfo,tools:listing.tools},null,2));
 for (const name of ['drive_v1_file_list','wiki_v2_space_list']) {
  const tool=listing.tools.find(x=>x.name===name); if(!tool){console.log('READONLY_MISSING',name);continue;}
  const response=await call('tools/call',{name,arguments:{params:{page_size:1}}});
  const texts=(response.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
  let parsed;try{parsed=JSON.parse(texts);}catch{}
  const business=parsed?.data??parsed;
  const count=business?.files?.length??business?.items?.length;
  const success=!response.isError && typeof count==='number';
  const check={tool:name,isError:response.isError??false,code:parsed?.code??(success?0:undefined),count,messageCategory:success?'success':parsed?.code?'api_error':'unknown',requiredScopes:[...new Set((parsed?.msg??'').match(/[a-z_]+(?::[a-z_]+){1,4}/g)??[])].filter(x=>!x.startsWith('https:'))};
  result.readonlyChecks.push(check);console.log('READONLY_CHECK',JSON.stringify(check));
 }
} finally { child.kill('SIGTERM'); }
delete result.tools;
writeFileSync(base+'/acceptance.json',JSON.stringify(result,null,2));
process.exit(0);
