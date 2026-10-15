import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
const root = '/opt/qq-group-bot-mcp/feishu';
const file = root + '/user-token.private.json';
const marker = root + '/user-token.enabled.json';
let refreshPromise;
export async function userTokenEnabled() {
  try { return JSON.parse(await readFile(marker, 'utf8')).identityMatched === true; } catch { return false; }
}
export async function getUserToken() {
  if (!await userTokenEnabled()) return undefined;
  if (!refreshPromise) refreshPromise = loadOrRefresh().finally(() => { refreshPromise = undefined; });
  return refreshPromise;
}
async function loadOrRefresh() {
  const ready = async () => JSON.parse(await readFile(file, 'utf8'));
  let token = await ready();
  if (token.access_token && token.obtained_at + token.expires_in > Date.now()/1000 + 90) return token.access_token;
  let lock;
  const lockPath = root + '/user-token.refresh.lock';
  for (let attempt=0;attempt<30;attempt++) {
    try { lock = await open(lockPath, 'wx', 0o600); break; }
    catch (error) { if (error.code !== 'EEXIST') throw new Error('feishu_token_storage_failed'); await new Promise(r=>setTimeout(r,1000)); }
  }
  if (!lock) throw new Error('feishu_token_refresh_busy');
  try {
    token = await ready();
    if (token.access_token && token.obtained_at + token.expires_in > Date.now()/1000 + 90) return token.access_token;
    if (!token.refresh_token) throw new Error('feishu_user_login_required');
    const response = await fetch('https://accounts.feishu.cn/oauth/v3/token', { method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'refresh_token',refresh_token:token.refresh_token,
        client_id:process.env.FEISHU_APP_ID,client_secret:process.env.FEISHU_APP_SECRET}),signal:AbortSignal.timeout(30000) });
    const next = await response.json();
    if (!response.ok || !next.access_token || (next.token_type && next.token_type.toLowerCase() !== 'bearer')) throw new Error('feishu_user_login_required');
    next.obtained_at=Math.floor(Date.now()/1000);
    if (!next.refresh_token) next.refresh_token=token.refresh_token;
    if (!next.scope) next.scope=token.scope;
    const temp=file+'.'+process.pid+'.tmp';
    await writeFile(temp,JSON.stringify(next),{mode:0o600});await rename(temp,file);
    return next.access_token;
  } finally { await lock.close(); await unlink(lockPath).catch(()=>{}); }
}
