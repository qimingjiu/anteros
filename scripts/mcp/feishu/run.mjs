import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { getUserToken, userTokenEnabled } from './user-token.mjs';
const base = '/opt/qq-group-bot-mcp/feishu';
mkdirSync(base+'/mcp-home',{recursive:true,mode:0o700});
process.env.HOME=base+'/mcp-home';
process.env.XDG_CONFIG_HOME=base+'/mcp-home/.config';
process.env.XDG_DATA_HOME=base+'/mcp-home/.local/share';
process.env.XDG_CACHE_HOME=base+'/mcp-home/.cache';
const require = createRequire(import.meta.url);
const pkg = base + '/node_modules/@larksuiteoapi/lark-mcp';
const { initOAPIMcpServer } = require(pkg + '/dist/mcp-server/shared/init.js');
const packageRequire = createRequire(pkg + '/package.json');
const { StdioServerTransport } = packageRequire('@modelcontextprotocol/sdk/server/stdio.js');
const enabled = await userTokenEnabled();
const { mcpServer } = initOAPIMcpServer({
  appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET,
  domain:'https://open.feishu.cn',tokenMode:'auto',
  tools:JSON.parse(readFileSync(base+'/selected-tools.json','utf8')),
  language:'zh',toolNameCase:'snake',oauth:false,
  userAccessToken:{getter:getUserToken},
});
const modes = new Map(JSON.parse(readFileSync(base+'/tool-auth-modes.json','utf8')).map(x=>[x.name,x.tokens]));
const transport = new StdioServerTransport();
await mcpServer.connect(transport);
const receive = transport.onmessage;
transport.onmessage = (message, extra) => {
  if (message.method === 'tools/call' && message.params?.name && modes.has(message.params.name)) {
    const tokens = modes.get(message.params.name);
    // The server chooses identity. Model supplied useUAT is never authoritative.
    const useUAT = (enabled && tokens.includes('user')) || !tokens.includes('tenant');
    message = { ...message, params: { ...message.params, arguments: { ...message.params.arguments, useUAT } } };
  }
  return receive(message, extra);
};
