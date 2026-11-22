import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpAdmin } from "./index.js";
import { asObject } from "./manifest.js";

const MAX_BODY_BYTES = 32 * 1024;
type Handler = (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")
    || Number(request.headers["content-length"]) > MAX_BODY_BYTES) throw new Error("请提交 32 KiB 以内的 JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) { request.resume(); throw new Error("请求体超过 32 KiB"); }
    chunks.push(bytes);
  }
  let body: Record<string, unknown> | undefined;
  try { body = asObject(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* reply with a fixed message */ }
  if (!body) throw new Error("请求体必须是 JSON 对象");
  return body;
}

export function createMcpAdminHandler(admin: McpAdmin, token: string | undefined): Handler {
  const configured = typeof token === "string" && token.trim() ? Buffer.from(token) : undefined;
  return async (request, response, url) => {
    if (url.pathname !== "/mcp" && !url.pathname.startsWith("/api/mcp/")) return false;
    if (!configured) { json(response, 404, { error: "未启用 MCP 管理" }); return true; }
    if (url.pathname === "/mcp" && request.method === "GET") {
      const nonce = randomBytes(18).toString("base64");
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
        "X-Content-Type-Options": "nosniff",
      });
      response.end(renderMcpAdmin(nonce));
      return true;
    }
    const match = /^Bearer ([^\r\n]+)$/i.exec(request.headers.authorization ?? "");
    const provided = Buffer.from(match?.[1] ?? "");
    if (provided.length !== configured.length || !timingSafeEqual(configured, provided)) {
      json(response, 401, { error: "需要面板管理令牌" });
      return true;
    }
    try {
      const route = url.pathname;
      if (request.method === "GET") {
        if (route === "/api/mcp/services") json(response, 200, { services: admin.list() });
        else if (route === "/api/mcp/search") json(response, 200, await admin.search(url.searchParams.get("query") ?? ""));
        else if (route === "/api/mcp/secrets") json(response, 200, { refs: admin.vault.list() });
        else if (route === "/api/mcp/jobs") json(response, 200, { jobs: admin.jobs() });
        else if (route.startsWith("/api/mcp/jobs/")) {
          const job = admin.job(route.slice("/api/mcp/jobs/".length));
          json(response, job ? 200 : 404, job ?? { error: "没有找到任务" });
        } else json(response, 404, { error: "没有找到 MCP 接口" });
      } else if (request.method === "POST" && ["/api/mcp/secrets", "/api/mcp/install", "/api/mcp/manage", "/api/mcp/retry"].includes(route)) {
        const body = await readJson(request);
        if (route === "/api/mcp/secrets") {
          if (typeof body.ref !== "string" || typeof body.value !== "string") throw new Error("请填写凭据引用和值");
          await admin.vault.write(body.ref, body.value);
          json(response, 200, { ref: body.ref });
        } else if (route === "/api/mcp/retry") {
          if (typeof body.id !== "string") throw new Error("请选择任务");
          json(response, 202, admin.retry(body.id));
        } else json(response, 202, admin.submit(route === "/api/mcp/install" ? "install" : body.action,
          { id: body.id, manifest: body.manifest }));
      } else json(response, 404, { error: "没有找到 MCP 接口" });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message.slice(0, 200) : "MCP 操作未完成" });
    }
    return true;
  };
}

function renderMcpAdmin(nonce: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>安忒洛斯 · MCP 管理</title>
<style nonce="${nonce}">
  :root { color-scheme: dark; font: 15px/1.55 system-ui, sans-serif; color: #e6e4df; background: #191b1b; }
  * { box-sizing: border-box; }
  body { max-width: 760px; margin: 24px auto; padding: 0 16px 36px; }
  section { display: grid; gap: 9px; border: 1px solid #3b4340; border-radius: 8px; padding: 16px; margin-block: 12px; }
  h1, h2, p { margin: 0; }
  h1 { font-size: 24px; } h2 { font-size: 18px; }
  input, textarea, select, button { padding: 9px 10px; color: inherit; background: #222626; border: 1px solid #56615c; border-radius: 5px; font: inherit; }
  textarea, pre { width: 100%; font: 13px/1.55 Consolas, monospace; }
  textarea { min-height: 195px; resize: vertical; }
  pre { margin: 0; max-height: 22rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  button { cursor: pointer; background: #24463b; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .row input { flex: 1; min-width: 10rem; }
  #notice { color: #c6d9c8; min-height: 1.55em; }
</style></head>
<body>
  <h1>MCP 管理</h1>
  <section aria-label="管理令牌">
    <label for="token">面板管理令牌</label>
    <div class="row"><input id="token" type="password" autocomplete="off"><button id="reload">读取服务和任务</button></div>
    <p id="notice" role="status"></p>
  </section>
  <section>
    <h2>查找服务</h2>
    <div class="row"><input id="query" aria-label="MCP 搜索词"><button id="search">搜索官方 Registry</button></div>
    <pre id="results"></pre>
  </section>
  <section>
    <h2>凭据</h2>
    <div class="row"><input id="ref" aria-label="凭据引用名"><input id="value" aria-label="凭据值" type="password" autocomplete="off">
      <button id="save">保存凭据</button></div>
    <pre id="secrets"></pre>
  </section>
  <section>
    <h2>安装与更新</h2>
    <label for="manifest">安装清单</label>
    <textarea id="manifest" spellcheck="false">{
  "id": "my-mcp",
  "kind": "remote",
  "url": "https://example.org/mcp",
  "allowedAgents": ["成员ID"],
  "allowedRooms": ["房间ID"]
}</textarea>
    <div class="row"><button id="install">安装</button><button id="update">用清单更新</button></div>
  </section>
  <section>
    <h2>服务与任务</h2>
    <div class="row"><select id="service" aria-label="选择服务"></select><button id="enable">启用</button><button id="disable">停用</button><button id="restart">重启</button><button id="uninstall">卸载</button></div>
    <pre id="services"></pre>
    <div class="row"><select id="job" aria-label="选择可重试任务"></select><button id="retry">重试所选任务</button></div>
    <pre id="jobs"></pre>
  </section>
<script nonce="${nonce}">
  const get = id => document.getElementById(id);
  const write = (id, value) => { get(id).textContent = JSON.stringify(value, null, 2); };
  async function api(path, body) {
    const token = get('token').value;
    if (!token) throw new Error('请填写面板管理令牌。');
    const headers = { Authorization: 'Bearer ' + token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch('/api/mcp/' + path, { cache: 'no-store', method: body === undefined ? 'GET' : 'POST',
      headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求未完成');
    return result;
  }
  function bind(id, action) {
    get(id).addEventListener('click', async () => {
      const button = get(id);
      button.disabled = true;
      try { get('notice').textContent = ''; await action(); }
      catch (error) { get('notice').textContent = error.message || '请求未完成'; }
      finally { button.disabled = false; }
    });
  }
  async function refresh() {
    const [services, jobs, secrets] = await Promise.all([api('services'), api('jobs'), api('secrets')]);
    write('services', services.services); write('jobs', jobs.jobs); write('secrets', secrets.refs);
    const select = get('service');
    const previous = select.value;
    select.replaceChildren(...services.services.map(item => new Option(item.manifest.id, item.manifest.id)));
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
    const job = get('job');
    const selected = job.value;
    job.replaceChildren(...jobs.jobs.filter(item => ['failed', 'awaiting_input', 'interrupted'].includes(item.status))
      .map(item => new Option(item.service + ' · ' + item.action, item.id)));
    if ([...job.options].some(option => option.value === selected)) job.value = selected;
  }
  async function submit(path, body) {
    const job = await api(path, body);
    get('notice').textContent = '管理任务已提交，等待状态更新。';
    await refresh();
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const current = await api('jobs/' + encodeURIComponent(job.id));
      if (!['queued', 'running'].includes(current.status)) {
        get('notice').textContent = current.error || (current.status === 'succeeded' ? '操作完成。' : current.status);
        await refresh(); return;
      }
    }
    get('notice').textContent = '任务仍在运行，可刷新查看状态。';
  }
  bind('reload', refresh);
  bind('search', async () => { const result = await api('search?query=' + encodeURIComponent(get('query').value)); write('results', result.results); });
  bind('save', async () => {
    const input = get('value');
    const value = input.value;
    input.value = '';
    await api('secrets', { ref: get('ref').value, value });
    await refresh();
    get('notice').textContent = '凭据已保存。';
  });
  bind('install', () => submit('install', { manifest: JSON.parse(get('manifest').value) }));
  bind('update', () => submit('manage', { action: 'update', manifest: JSON.parse(get('manifest').value) }));
  bind('retry', () => submit('retry', { id: get('job').value }));
  for (const action of ['enable', 'disable', 'restart']) bind(action, () => submit('manage', { action, id: get('service').value }));
  bind('uninstall', () => {
    const id = get('service').value;
    if (id && confirm('卸载 '+ id + ' 并移除它的安装文件？')) return submit('manage', { action: 'uninstall', id });
  });
</script></body></html>`;
}
