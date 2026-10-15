const fs = require('node:fs');
const path = require('node:path');
const base = process.env.FEISHU_MCP_ROOT || '/opt/qq-group-bot-mcp/feishu';
const { AllToolsZh } = require(path.join(base, 'node_modules/@larksuiteoapi/lark-mcp/dist/mcp-tool/tools/index.js'));
const domains = new Set(['docx', 'drive', 'bitable', 'sheets', 'slides', 'wiki', 'mail', 'calendar']);
const selected = AllToolsZh.filter(tool => domains.has(tool.project));
fs.writeFileSync(path.join(base, 'selected-tools.json'), JSON.stringify(selected.map(tool => tool.name), null, 2));
fs.writeFileSync(path.join(base, 'tool-auth-modes.json'), JSON.stringify(selected.map(tool => ({
  name: tool.name.replaceAll('.', '_'), tokens: tool.accessTokens || [], method: tool.httpMethod,
})), null, 2));
console.log(JSON.stringify({ toolCount: selected.length }));
