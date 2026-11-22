import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FamilyDesk } from "./index.js";
import type { Category } from "./library.js";

interface PanelOptions {
  desk: FamilyDesk;
  room: string;
  authorized: () => boolean;
  allowedOrigins?: readonly string[];
  destinations?: () => string[];
  send?: (delivery: { requestId: string; destination: string; resource: ReturnType<FamilyDesk["dashboardResource"]> }) => Promise<unknown>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export function serveFamilyPanel(
  request: IncomingMessage, response: ServerResponse, url: URL, options: PanelOptions,
): boolean {
  const routes = ["/family", "/family/", "/ide-toolbox.js", "/api/family", "/api/family/artifact",
    "/api/family/toolbox", "/api/family/toolbox/file", "/api/family/toolbox/url", "/api/family/toolbox/send"];
  if (!routes.includes(url.pathname)) return false;
  const origin = request.headers.origin;
  if (origin) {
    // The application receives plain HTTP behind an HTTPS proxy. A browser
    // can still attest that its public HTTPS origin is the same origin.
    const proxiedSameOrigin = request.headers["sec-fetch-site"] === "same-origin"
      && url.protocol === "http:" && origin === "https://" + url.host;
    if (origin !== url.origin && !proxiedSameOrigin
      && !options.allowedOrigins?.some(allowed => allowed === origin && isWebOrigin(allowed))) {
      json(response, 403, { error: "此 IDE 来源未授权。" });
      return true;
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  if (request.method === "OPTIONS" && origin) {
    response.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, PUT",
      "Access-Control-Allow-Headers": "Authorization, Content-Type", "Cache-Control": "no-store" });
    response.end();
    return true;
  }
  const method = url.pathname.endsWith("/file") ? "PUT"
    : /\/(?:url|send)$/.test(url.pathname) ? "POST" : "GET";
  if (request.method !== method) {
    response.setHeader("Allow", method);
    json(response, 405, { error: "请求方法不正确。" });
    return true;
  }
  if (url.pathname === "/family" || url.pathname === "/family/") {
    const nonce = randomBytes(18).toString("base64");
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce
        + "'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(page.replaceAll("{{nonce}}", nonce));
    return true;
  }
  if (url.pathname === "/ide-toolbox.js") {
    try {
      const source = readFileSync(new URL("../../integrations/ide-toolbox.js", import.meta.url));
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      response.end(source);
    } catch {
      json(response, 404, { error: "未找到 IDE 工具箱组件。" });
    }
    return true;
  }
  // Only use the Authorization header for owner data. Never allow a token in
  // an address, where intermediaries and browser history could record it.
  if (!request.headers.authorization?.startsWith("Bearer ") || !options.authorized()) {
    json(response, 401, { error: "请输入已配置的面板令牌。" });
    return true;
  }
  const member = url.searchParams.get("member") ?? undefined;
  if (url.pathname === "/api/family") {
    json(response, 200, options.desk.dashboard(options.room, member));
    return true;
  }
  if (url.pathname.startsWith("/api/family/toolbox")) {
    void toolbox(request, response, url, options, member).catch(error => {
      if (response.destroyed || response.writableEnded) return;
      const status = error instanceof SizeLimit ? 413 : 400;
      json(response, status, { error: error instanceof Error ? error.message.slice(0, 200) : "工具箱请求失败。" });
    });
    return true;
  }
  const id = url.searchParams.get("id");
  if (!member || !id) {
    json(response, 400, { error: "缺少成员或文件 ID。" });
    return true;
  }
  try {
    const file = options.desk.dashboardArtifact(options.room, member, id);
    const safeName = encodeURIComponent(file.name).replace(/['()!*]/g, char => "%" + char.charCodeAt(0).toString(16));
    response.writeHead(200, {
      "Content-Type": "application/octet-stream", "Content-Length": file.bytes.length,
      "Content-Disposition": "attachment; filename*=UTF-8''" + safeName, "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(file.bytes);
  } catch {
    json(response, 404, { error: "文件不存在或当前成员无权查看。" });
  }
  return true;
}

function isWebOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && value === url.origin;
  } catch {
    return false;
  }
}

class SizeLimit extends Error {}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"] ?? 0);
    if (!Number.isFinite(declared) || declared > limit) {
      request.resume();
      reject(new SizeLimit("上传长度超过上限。"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        request.off("data", onData);
        request.resume();
        reject(new SizeLimit("上传长度超过上限。"));
        return;
      }
      chunks.push(chunk);
    };
    request.on("data", onData);
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", () => reject(new Error("上传未完成。")));
    request.once("aborted", () => reject(new Error("上传已中断。")));
  });
}

async function toolbox(request: IncomingMessage, response: ServerResponse, url: URL, options: PanelOptions, member?: string) {
  const active = member ?? options.desk.dashboard(options.room, undefined).member;
  if (!active) throw new Error("还没有配置任何成员。");
  const category = url.searchParams.get("category") as Category | null;
  if (url.pathname === "/api/family/toolbox") {
    const items = options.desk.dashboardLibrary(options.room, active, url.searchParams.get("query") ?? "", category ?? undefined);
    const { members } = options.desk.dashboard(options.room, active);
    json(response, 200, { items, members, member: active, destinations: options.destinations?.() ?? [] });
  } else if (url.pathname === "/api/family/toolbox/file") {
    const name = url.searchParams.get("name") ?? "收纳文件";
    const mime = String(request.headers["content-type"] || "application/octet-stream").split(";", 1)[0]!;
    const bytes = await readBody(request, 25 * 1024 * 1024);
    const item = await options.desk.addDashboardResource(options.room, active, category ?? undefined, { name, mime, bytes });
    json(response, 201, item);
  } else if (url.pathname === "/api/family/toolbox/url") {
    const raw = JSON.parse((await readBody(request, 4096)).toString("utf8")) as { url?: unknown };
    if (typeof raw?.url !== "string") throw new Error("需要一个网址。");
    const item = await options.desk.addDashboardResource(options.room, active, category ?? undefined, raw.url);
    json(response, 201, item);
  } else {
    const raw = JSON.parse((await readBody(request, 4096)).toString("utf8")) as { id?: unknown; destination?: unknown; requestId?: unknown };
    if (!options.send || typeof raw?.id !== "string" || typeof raw.destination !== "string"
      || typeof raw.requestId !== "string" || !/^[a-z0-9_-]{12,100}$/i.test(raw.requestId)
      || !options.destinations?.().includes(raw.destination)) throw new Error("需要选择已绑定的发送目的地。");
    const resource = options.desk.dashboardResource(options.room, active, raw.id);
    json(response, 202, await options.send({ requestId: raw.requestId, destination: raw.destination, resource }));
  }
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>家庭工作台 · 安忒洛斯</title>
<style nonce="{{nonce}}">
  :root { color-scheme: light; --paper:#f6f2e9; --ink:#241d18; --muted:#514c42; --line:#d1c8b8; --accent:#972e23; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font-family:system-ui,sans-serif; line-height:1.55; }
  main { max-width:70rem; margin:auto; padding:clamp(20px,5vw,60px); }
  h1 { font:600 clamp(2rem,4.5vw,3.7rem)/1.2 Georgia,"Noto Serif SC",serif; margin:0 0 20px; }
  h2 { font:600 1.25rem/1.3 Georgia,"Noto Serif SC",serif; margin:0 0 14px; }
  a { color:var(--accent); text-decoration:none; }
  nav { margin-bottom:22px; }
  .row { display:flex; align-items:end; gap:10px; flex-wrap:wrap; }
  label { display:grid; gap:5px; font-size:.9rem; }
  button,input,select { font:inherit; min-height:42px; padding:7px 12px; border:1px solid var(--line); border-radius:4px; background:#fffdf7; color:var(--ink); }
  input { width:min(100%,23rem); }
  button { cursor:pointer; }
  button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  button.primary { background:var(--accent); border-color:var(--accent); color:white; }
  .status { min-height:1.6rem; color:var(--muted); margin:8px 0 16px; }
  .layout { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:23px; margin-top:24px; }
  section { border-top:2px solid var(--ink); padding-top:13px; min-width:0; }
  ul { list-style:none; margin:0; padding:0; }
  li { padding:11px 0; border-bottom:1px solid var(--line); overflow-wrap:anywhere; white-space:pre-wrap; }
  li small { color:var(--muted); display:block; }
  li button { color:var(--accent); padding:1px 7px; min-height:32px; margin-top:5px; }
  [hidden] { display:none !important; }
  @media (max-width:42rem) { .layout { grid-template-columns:1fr; } }
</style>
</head>
<body>
<main>
<nav><a href="/">安忒洛斯状态面板</a></nav>
<h1>家庭工作台</h1>
<form id="access" class="row" autocomplete="off">
  <label>面板令牌 <input id="token" type="password" required></label>
  <button class="primary" type="submit">打开</button>
</form>
<p id="status" class="status" role="status" aria-live="polite"></p>
<div id="desk" hidden>
  <div class="row">
    <label>成员 <select id="member"></select></label>
    <button id="refresh" type="button">刷新</button>
    <button id="lock" type="button">锁定</button>
  </div>
  <div class="layout">
    <section><h2>任务与计划</h2><ul id="jobs"></ul></section>
    <section><h2>收件箱</h2><ul id="inbox"></ul></section>
    <section><h2>成员文件</h2><ul id="files"></ul></section>
  </div>
</div>
</main>
<script nonce="{{nonce}}">
  const byId = id => document.getElementById(id);
  let credential = "";
  let activeRequest;
  const states = {queued:"待运行",running:"进行中",paused:"已暂停",completed:"已完成",failed:"失败",cancelled:"已取消"};
  function row(title, detail) {
    const item = document.createElement("li");
    item.textContent = title;
    if (detail) {
      const sub = document.createElement("small");
      sub.textContent = detail;
      item.append(sub);
    }
    return item;
  }
  function renderList(id, rows, build) {
    byId(id).replaceChildren(...(rows.length ? rows.map(build) : [row("暂无记录")]));
  }
  async function api(path, signal) {
    return fetch(path, { headers:{Authorization:"Bearer " + credential}, credentials:"omit", cache:"no-store", signal });
  }
  async function download(file, member) {
    const params = new URLSearchParams({id:file.id, member});
    try {
      const response = await api("/api/family/artifact?" + params);
      if (!response.ok) throw new Error();
      const location = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = location;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(location), 1500);
    } catch {
      byId("status").textContent = "文件下载失败。";
    }
  }
  async function load(member) {
    activeRequest?.abort();
    const request = new AbortController();
    activeRequest = request;
    byId("status").textContent = "正在读取…";
    try {
      const query = member ? "?" + new URLSearchParams({member}) : "";
      const response = await api("/api/family" + query, request.signal);
      if (!response.ok) throw new Error(response.status === 401 ? "面板令牌不可用。" : "读取失败。");
      const data = await response.json();
      if (request.signal.aborted) return;
      byId("member").replaceChildren(...data.members.map(member => new Option(member.name, member.id)));
      if (data.member) byId("member").value = data.member;
      renderList("jobs", data.jobs, job => row(job.title, [states[job.state], job.receipt, "#" + job.id].filter(Boolean).join(" · ")));
      renderList("inbox", data.inbox, item => row(item.result, item.created_at));
      renderList("files", data.files, file => {
        const item = row(file.name, (file.size / 1024).toFixed(1) + " KB");
        const downloadButton = document.createElement("button");
        downloadButton.textContent = "下载";
        downloadButton.addEventListener("click", () => download(file, data.member));
        item.append(downloadButton);
        return item;
      });
      byId("access").hidden = true;
      byId("desk").hidden = false;
      byId("status").textContent = "";
    } catch (error) {
      if (!request.signal.aborted) byId("status").textContent = error.message || "读取失败。";
    }
  }
  byId("access").addEventListener("submit", event => {
    event.preventDefault();
    credential = byId("token").value;
    byId("token").value = "";
    load();
  });
  byId("member").addEventListener("change", () => load(byId("member").value));
  byId("refresh").addEventListener("click", () => load(byId("member").value));
  byId("lock").addEventListener("click", () => {
    activeRequest?.abort();
    credential = "";
    for (const id of ["member", "jobs", "inbox", "files"]) byId(id).replaceChildren();
    byId("desk").hidden = true;
    byId("access").hidden = false;
    byId("status").textContent = "";
    byId("token").focus();
  });
</script>
</body>
</html>`;
