import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import type { MessageRecord, ToolDef } from "../types.js";
import type { IncomingDocumentService } from "../documents/incoming.js";
import { downloadSendImage, type ReplyImageStore } from "./send-image.js";
import { logger } from "../util/logger.js";

const log = logger("labrys-forward");
const TARGETS: Record<string, string> = { wechat: "wechat-home", tg: "tg-home" };
// 2026-11-05 主人要求 QQ 与 DC 互发：不走 Labrys，直接发到主人本人的 QQ 私聊 / DC 私信。
const OWNER_QQ = process.env.FORWARD_OWNER_QQ || "";
const OWNER_DC = process.env.FORWARD_OWNER_DC || "";
const ONEBOT_WS = process.env.FORWARD_ONEBOT_WS || "ws://127.0.0.1:3001/";
const QQ_HOST_DIR = process.env.FORWARD_QQ_HOST_DIR || "/opt/snowluma-docker/data/qq-bot-documents/forward";
const QQ_CONTAINER_DIR = process.env.FORWARD_QQ_CONTAINER_DIR || "/app/data/qq-bot-documents/forward";
const MAX_BYTES = 25 * 1024 * 1024;
const RECENT_MEDIA_MS = 60 * 60_000;
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp4": "video/mp4",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export interface LabrysForwardDeps {
  db: Database; accountId: string; ownerIds: string[];
  incoming?: IncomingDocumentService | null;
  mediaDir: string;
  documentsDir?: string;
  baseUrl?: string; token?: string;
}

interface Item { kind: "image" | "file"; name: string; mime: string; bytes: Buffer }

/** 2026-11-05 主人要求：QQ/DC 里让机器人经 Labrys 网关把文字/图片/文件转发到微信或 TG。只听主人，只发到网关里配置好的两个固定目的地。 */
// 2026-11-06 主人要求：把拉布里斯的后台任务、提醒、待办、日记、自加功能、MCP 管理桥接到 QQ/DC（仅主人）。
const BRIDGE_SKIP = new Set(["toolbox_save", "toolbox_search", "mcp_search", "mcp_install", "delivery_send", "delivery_targets", "task_checkpoint", "task_status", "task_control"]); // 2026-11-07 本地已有同名工具，DeepSeek 拒绝重名
interface WorldTool { name: string; description?: string; parameters?: Record<string, unknown> }

export class LabrysForwardService {
  private worldTools: WorldTool[] = [];
  constructor(private deps: LabrysForwardDeps) {
    const load = () => { void this.loadWorldTools(); };
    setTimeout(load, 3000); setInterval(load, 10 * 60_000).unref();
  }

  private async loadWorldTools(): Promise<void> {
    if (!this.base || !this.token) return;
    try {
      const r = await fetch(`${this.base}/api/world/tools`, { headers: this.headers(), signal: AbortSignal.timeout(15000) });
      if (!r.ok) { log.warn(`拉布里斯工具列表 HTTP ${r.status}`); return; }
      const j = await r.json() as { tools?: WorldTool[] };
      this.worldTools = (j.tools ?? []).filter(t => /^[a-z][a-z0-9_]{0,63}$/.test(t.name) && !BRIDGE_SKIP.has(t.name));
      log.info(`拉布里斯桥接工具 ${this.worldTools.length} 个`);
    } catch (e) { log.warn(`拉布里斯工具列表失败: ${(e as Error).message}`); }
  }

  private bridgeTools(m: MessageRecord): ToolDef[] {
    return this.worldTools.map(t => ({
      name: t.name,
      description: `[拉布里斯网关] ${t.description ?? t.name}`.slice(0, 1000),
      private: true,
      inputSchema: (t.parameters && (t.parameters as { type?: string }).type === "object" ? t.parameters : { type: "object", properties: {} }) as ToolDef["inputSchema"],
      execute: async args => {
        const out = await this.gw("POST", "/api/world/call", { name: t.name, arguments: args ?? {}, userText: m.textContent || "(无文字)" }, 120000);
        return out.length > 12000 ? out.slice(0, 12000) + "…（已截断）" : out;
      },
    }));
  }

  private get base(): string { return (this.deps.baseUrl || process.env.LABRYS_URL || "").replace(/\/$/, ""); }
  private get token(): string { return this.deps.token || process.env.LABRYS_GATEWAY_TOKEN || ""; }

  private allowed(m: MessageRecord): boolean {
    return m.accountId === this.deps.accountId && m.origin === "live" && m.status === "active" && !m.interaction
      && this.deps.ownerIds.includes(m.senderId) && !this.deps.db.isUserBlocked(m.accountId, m.senderId);
  }

  toolsFor(m: MessageRecord, images: ReplyImageStore): ToolDef[] {
    if (!this.allowed(m) || !this.base || !this.token) return [];
    return [...this.bridgeTools(m), {
      name: "forward_to_platform",
      description: "主人明确要求把东西发到微信、Telegram（TG）、QQ 或 Discord（DC）时使用：微信/TG 经 Labrys 网关，QQ/DC 直接发到主人本人的 QQ 私聊或 DC 私信（不能发到当前所在的同一平台）。可发文字、本轮图片（image_ids，如 img1）、公开 HTTPS 图片直链、你自己生成过的文档或主人在当前会话发来的文件（file_name 填文件名；省略则取主人当前/所引用消息里的文件，或两分钟内刚发的文件），或你最近一小时生成的图片/语音（latest_generated=true）。只能发给主人自己，不能指定其他收件人。微信不支持原生语音，音频会作为文件发。返回 queued 表示网关已接收并排队投递；unknown 或失败时照原文告诉主人，禁止重试。",
      private: true,
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["wechat", "tg", "qq", "dc"], description: "wechat=微信，tg=Telegram，qq=主人的 QQ 私聊，dc=主人的 Discord 私信" },
          text: { type: "string", minLength: 1, maxLength: 2000, description: "要发的文字；带附件时作为说明（最多 1000 字）" },
          image_ids: { type: "array", items: { type: "string", pattern: "^img[1-9]\\d*$" }, maxItems: 4 },
          image_urls: { type: "array", items: { type: "string", maxLength: 8192 }, maxItems: 4 },
          file_name: { type: "string", maxLength: 200, description: "你生成过的文档名或主人在当前会话发过的文件名；空字符串表示取当前/引用/刚发的那个" },
          latest_generated: { type: "boolean", description: "发送你最近一小时生成的那张图或那段语音" },
        },
        required: ["target"],
        additionalProperties: false,
      },
      execute: async args => {
        try { return JSON.stringify(await this.forward(args, m, images)); }
        catch (e) {
          log.warn(`转发失败: ${(e as Error).message}`);
          return JSON.stringify({ status: "failed", detail: (e as Error).message });
        }
      },
        }, {
      // 2026-11-05 主人要求：「放工具箱」指 Labrys 工具箱，不是 Notion。
      name: "toolbox_save",
      description: "主人说「放工具箱 / 存工具箱 / 收进工具箱」时用：把链接存进 Labrys 工具箱（家里共用的工具收藏，自动整理标题、分类和标签）。工具箱就是这里，不要写进 Notion。",
      private: true,
      inputSchema: { type: "object", properties: { urls: { type: "array", items: { type: "string", maxLength: 2048 }, minItems: 1, maxItems: 10 } }, required: ["urls"], additionalProperties: false },
      execute: async args => {
        try {
          const urls = (Array.isArray(args.urls) ? args.urls : []).map(String).filter(u => /^https?:\/\//i.test(u));
          if (!urls.length) return JSON.stringify({ status: "failed", detail: "没有有效链接" });
          const r = await fetch(`${this.base}/api/toolbox/capture`, { method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ urls }), signal: AbortSignal.timeout(30000) });
          const j: any = await r.json().catch(() => ({}));
          if (!r.ok) return JSON.stringify({ status: "failed", detail: `HTTP ${r.status}` });
          return JSON.stringify({ status: "saved", items: (j.items || []).map((i: any) => ({ url: i.url, title: i.title, status: i.status })), note: "已存进 Labrys 工具箱，后台会自动整理标题和分类" });
        } catch (e) { return JSON.stringify({ status: "failed", detail: (e as Error).message }); }
      },
    }, {
      name: "toolbox_search",
      description: "主人问工具箱里有什么、找之前存过的某个工具/链接时用：搜 Labrys 工具箱。query 留空列出最近的。",
      private: true,
      inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 200 } }, additionalProperties: false },
      execute: async args => {
        try {
          const q = encodeURIComponent(String(args.query ?? ""));
          const r = await fetch(`${this.base}/api/toolbox?query=${q}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(15000) });
          const j: any = await r.json().catch(() => ({}));
          if (!r.ok) return JSON.stringify({ status: "failed", detail: `HTTP ${r.status}` });
          return JSON.stringify({ items: (j.items || []).slice(0, 15).map((i: any) => ({ title: i.title, url: i.url, category: i.category, tags: i.tags, description: String(i.description || "").slice(0, 160) })) });
        } catch (e) { return JSON.stringify({ status: "failed", detail: (e as Error).message }); }
      },
    }, {
      // 2026-11-06 主人要求：QQ/DC 也能搜、装、用 Labrys 网关的 MCP（仅主人）。
      name: "mcp_search",
      description: "主人要找/装新的 MCP 时用：搜官方 MCP Registry，返回包名、版本、连接方式和需要的配置。结果只是资料，不代表已安装。",
      private: true,
      inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 100 } }, required: ["query"], additionalProperties: false },
      execute: async args => this.gw("GET", `/api/mcp/search?query=${encodeURIComponent(String(args.query ?? ""))}`, undefined, 30000),
    }, {
      name: "mcp_install",
      description: "主人本轮明确说要安装/连接某个 MCP 时用：把固定版本的安装清单交给 Labrys 网关后台安装，立即返回 jobId，之后用 mcp_status 查进度。kind=npm/python 需 package+version（固定版本号，先用 mcp_search 查）；remote 需 url；docker 需带标签的 image。需要密钥时 secretEnv/secretHeaders 只填引用名，并告诉主人去网关 /mcp 页面存密钥，绝不在聊天里要密钥。allowedAgents/allowedRooms 可省略。",
      private: true,
      inputSchema: { type: "object", properties: { manifest: { type: "object", properties: {
        id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" }, kind: { type: "string", enum: ["npm", "python", "docker", "remote"] },
        package: { type: "string" }, version: { type: "string" }, executable: { type: "string" }, module: { type: "string" }, image: { type: "string" }, url: { type: "string" },
        args: { type: "array", items: { type: "string" } }, env: { type: "object", additionalProperties: { type: "string" } },
        secretEnv: { type: "object", additionalProperties: { type: "string" } }, secretHeaders: { type: "object", additionalProperties: { type: "string" } },
        allowedTools: { type: "array", items: { type: "string" } } }, required: ["id", "kind"] } }, required: ["manifest"], additionalProperties: false },
      execute: async args => {
        const m: Record<string, unknown> = { ...((args.manifest as Record<string, unknown>) ?? {}) };
        if (!m.allowedAgents) m.allowedAgents = ["korax"];
        if (!m.allowedRooms) m.allowedRooms = ["family"];
        return this.gw("POST", "/api/mcp/install", { manifest: m }, 30000);
      },
    }, {
      name: "mcp_status",
      description: "查 Labrys 网关 MCP 安装任务进度（给 jobId），或不给 jobId 列出已装的 MCP 服务和状态。",
      private: true,
      inputSchema: { type: "object", properties: { jobId: { type: "string" } }, additionalProperties: false },
      execute: async args => args.jobId ? this.gw("GET", `/api/mcp/jobs/${encodeURIComponent(String(args.jobId))}`) : this.gw("GET", "/api/mcp/services"),
    }, {
      name: "mcp_call",
      description: "调用 Labrys 网关上已装好的 MCP 工具。不给 name 时列出全部可用工具（含参数格式）；先列出再调用。name 用列表里的 name，arguments 按它的 parameters 填。",
      private: true,
      inputSchema: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, additionalProperties: false },
      execute: async args => {
        if (!args.name) return this.gw("GET", "/api/mcp/tools");
        const out = await this.gw("POST", "/api/mcp/call", { name: String(args.name), arguments: args.arguments ?? {} }, 120000);
        return out.length > 12000 ? out.slice(0, 12000) + "…（已截断）" : out;
      },
    }];
  }

  private async gw(method: string, p: string, body?: unknown, ms = 20000): Promise<string> {
    try {
      const r = await fetch(`${this.base}${p}`, { method, headers: this.headers(body === undefined ? {} : { "Content-Type": "application/json" }), ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(ms) });
      const text = await r.text();
      if (!r.ok) { let d = text; try { const j = JSON.parse(text); d = j.error?.message ?? j.message ?? j.code ?? text; } catch { /* keep */ } return JSON.stringify({ status: "failed", http: r.status, detail: String(d).slice(0, 500) }); }
      return text;
    } catch (e) { return JSON.stringify({ status: "failed", detail: (e as Error).message }); }
  }

  private async forward(args: Record<string, unknown>, m: MessageRecord, images: ReplyImageStore) {
    if (!this.allowed(m)) throw new Error("只有主人的实时消息可以转发");
    const target = String(args.target);
    const direct = target === "qq" || target === "dc";
    if (direct && (target === "dc") === (this.deps.accountId === "discord")) throw new Error("不能转发到当前所在的同一平台");
    const destination = TARGETS[target];
    if (!destination && !direct) throw new Error("target 只能是 wechat、tg、qq 或 dc");
    const items: Item[] = [];
    for (const id of (args.image_ids as string[] | undefined) ?? []) {
      const img = images.get(id);
      if (!img) throw new Error(`没有编号为 ${id} 的本轮图片`);
      const ext = img.mimeType.split("/")[1]!.replace("jpeg", "jpg");
      items.push({ kind: "image", name: `${id}.${ext}`, mime: img.mimeType, bytes: Buffer.from(img.data, "base64") });
    }
    for (const url of (args.image_urls as string[] | undefined) ?? []) {
      const img = await downloadSendImage(url);
      const ext = img.mimeType.split("/")[1]!.replace("jpeg", "jpg");
      items.push({ kind: "image", name: `image.${ext}`, mime: img.mimeType, bytes: Buffer.from(img.data, "base64") });
    }
    if (args.file_name !== undefined) {
      const wanted = String(args.file_name).trim();
      const own = wanted ? await this.generatedDocument(wanted) : undefined;
      if (!own && !this.deps.incoming) throw new Error("接收文件功能未开启");
      const f = own ?? await this.deps.incoming!.bytesFor(m, wanted);
      const mime = MIME_BY_EXT[path.extname(f.name).toLowerCase()] ?? "application/octet-stream";
      items.push({ kind: mime.startsWith("image/") ? "image" : "file", name: f.name, mime, bytes: Buffer.from(f.bytes) });
    }
    if (args.latest_generated === true) items.push(await this.latestGenerated());
    const text = typeof args.text === "string" && args.text.trim() ? args.text.trim() : undefined;
    if (!items.length && !text) throw new Error("没有要发的内容");
    if (items.length && text && text.length > 1000) throw new Error("带附件时文字说明最多 1000 字");
    if (direct) {
      for (const item of items) if (item.bytes.length > MAX_BYTES) throw new Error(`${item.name} 超过 25MB`);
      if (target === "dc") await this.sendDiscord(text, items); else await this.sendQQ(text, items);
      return { status: "sent", target, count: Math.max(items.length, 1), detail: "已发出" };
    }
    const receipts: unknown[] = [];
    if (!items.length) receipts.push(await this.deliver({ destination, kind: "text", text }));
    for (const [i, item] of items.entries()) {
      if (item.bytes.length > MAX_BYTES) throw new Error(`${item.name} 超过 25MB`);
      const artifact = await this.upload(item);
      receipts.push(await this.deliver({ destination, kind: item.kind, artifactId: artifact.id, ...(i === 0 && text ? { text } : {}) }));
    }
    const statuses = receipts.map(r => (r as { status?: string }).status ?? "unknown");
    const status = statuses.every(s => s === "queued" || s === "sent") ? "queued" : statuses.includes("blocked") ? "blocked" : "unknown";
    return { status, target: args.target, count: receipts.length, detail: status === "queued" ? "网关已接收，正在投递" : `网关回执：${statuses.join(",")}` };
  }

  /** 你自己生成过的文档（docx/pdf 等），按文件名在文档输出目录里找最新的一份。 */
  private async generatedDocument(name: string): Promise<{ name: string; bytes: Uint8Array } | undefined> {
    const dir = this.deps.documentsDir; if (!dir) return undefined;
    const base = path.basename(name);
    let best: { file: string; mtime: number } | undefined;
    for (const d of await fs.readdir(dir).catch(() => [] as string[])) {
      const file = path.join(dir, d, base);
      const st = await fs.stat(file).catch(() => null);
      if (st?.isFile() && (!best || st.mtimeMs > best.mtime)) best = { file, mtime: st.mtimeMs };
    }
    if (!best) return undefined;
    return { name: base, bytes: await fs.readFile(best.file) };
  }

  private async latestGenerated(): Promise<Item> {
    let best: { file: string; mtime: number } | undefined;
    const dirs = await fs.readdir(this.deps.mediaDir).catch(() => [] as string[]);
    for (const d of dirs) {
      const dir = path.join(this.deps.mediaDir, d);
      for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
        const st = await fs.stat(path.join(dir, f)).catch(() => null);
        if (st?.isFile() && (!best || st.mtimeMs > best.mtime)) best = { file: path.join(dir, f), mtime: st.mtimeMs };
      }
    }
    if (!best || Date.now() - best.mtime > RECENT_MEDIA_MS) throw new Error("最近一小时没有生成过图片或语音");
    const name = path.basename(best.file);
    const mime = MIME_BY_EXT[path.extname(name).toLowerCase()] ?? "application/octet-stream";
    return { kind: mime.startsWith("image/") ? "image" : "file", name, mime, bytes: await fs.readFile(best.file) };
  }

  private async sendDiscord(text: string | undefined, items: Item[]): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN; if (!token) throw new Error("DC 机器人未配置");
    const h = { Authorization: `Bot ${token}` };
    const ch = await fetch("https://discord.com/api/v10/users/@me/channels", { method: "POST",
      headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ recipient_id: OWNER_DC }), signal: AbortSignal.timeout(20000) });
    const chBody = await ch.json().catch(() => ({})) as { id?: string };
    if (!ch.ok || !chBody.id) throw new Error(`DC 私信通道打开失败（${ch.status}）`);
    const batches: Item[][] = items.length ? [] : [[]];
    for (let i = 0; i < items.length; i += 10) batches.push(items.slice(i, i + 10));
    for (const [bi, batch] of batches.entries()) {
      const form = new FormData();
      form.append("payload_json", JSON.stringify({ content: bi === 0 && text ? text.slice(0, 2000) : "",
        attachments: batch.map((it, i) => ({ id: i, filename: it.name })) }));
      batch.forEach((it, i) => form.append(`files[${i}]`, new Blob([new Uint8Array(it.bytes)], { type: it.mime }), it.name));
      const r = await fetch(`https://discord.com/api/v10/channels/${chBody.id}/messages`, { method: "POST", headers: h, body: form, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`DC 发送失败（${r.status}）`);
    }
  }

  private async sendQQ(text: string | undefined, items: Item[]): Promise<void> {
    const token = process.env.ONEBOT_TOKEN ?? "";
    const ws = new WebSocket(`${ONEBOT_WS}${token ? `?access_token=${encodeURIComponent(token)}` : ""}`);
    const pending = new Map<string, (v: { status?: string; retcode?: number; wording?: string; message?: string }) => void>();
    ws.addEventListener("message", ev => {
      try { const d = JSON.parse(String(ev.data)); if (d?.echo && pending.has(d.echo)) { pending.get(d.echo)!(d); pending.delete(d.echo); } } catch { /* 事件推送，忽略 */ }
    });
    await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error("QQ 协议端连接超时")), 10000);
      ws.addEventListener("open", () => { clearTimeout(t); res(); }); ws.addEventListener("error", () => { clearTimeout(t); rej(new Error("QQ 协议端连接失败")); }); });
    const call = (action: string, params: Record<string, unknown>) => new Promise<void>((res, rej) => {
      const echo = randomUUID(); const t = setTimeout(() => { pending.delete(echo); rej(new Error(`QQ ${action} 超时`)); }, 60000);
      pending.set(echo, d => { clearTimeout(t); if (d.retcode === 0 || d.status === "ok") res(); else rej(new Error(`QQ ${action} 失败：${d.wording ?? d.message ?? d.retcode}`)); });
      ws.send(JSON.stringify({ action, params, echo }));
    });
    const tmp: string[] = [];
    try {
      const images = items.filter(i => i.kind === "image"), files = items.filter(i => i.kind === "file");
      const segs: unknown[] = [];
      if (text) segs.push({ type: "text", data: { text } });
      for (const im of images) segs.push({ type: "image", data: { file: `base64://${im.bytes.toString("base64")}` } });
      if (segs.length) await call("send_private_msg", { user_id: OWNER_QQ, message: segs });
      for (const f of files) {
        const id = randomUUID(); const dir = path.join(QQ_HOST_DIR, id);
        await fs.mkdir(dir, { recursive: true, mode: 0o755 }); await fs.chmod(QQ_HOST_DIR, 0o755).catch(() => {});
        const safe = path.basename(f.name).replace(/[\x00-\x1f]/g, "_") || "file";
        await fs.writeFile(path.join(dir, safe), f.bytes, { mode: 0o644 }); tmp.push(dir);
        await call("upload_private_file", { user_id: OWNER_QQ, file: path.posix.join(QQ_CONTAINER_DIR, id, safe), name: safe });
      }
    } finally {
      ws.close();
      setTimeout(() => { for (const d of tmp) fs.rm(d, { recursive: true, force: true }).catch(() => {}); }, 120000);
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, "X-Room-Id": "family", "X-Client-Id": this.deps.accountId === "discord" ? "discord" : "qqbot", ...extra };
  }

  private async upload(item: Item): Promise<{ id: string }> {
    const r = await fetch(`${this.base}/api/workspaces/korax/files?name=${encodeURIComponent(item.name)}`, {
      method: "PUT", headers: this.headers({ "Content-Type": item.mime }), body: new Uint8Array(item.bytes), signal: AbortSignal.timeout(60000) });
    const body = await r.json().catch(() => ({})) as { id?: string; message?: string; code?: string };
    if (!r.ok || !body.id) throw new Error(`网关上传失败（${r.status} ${body.code ?? body.message ?? ""}）`);
    return { id: body.id };
  }

  private async deliver(payload: Record<string, unknown>): Promise<unknown> {
    const r = await fetch(`${this.base}/api/deliveries`, {
      method: "POST", headers: this.headers({ "Content-Type": "application/json", "Idempotency-Key": randomUUID() }),
      body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
    const body = await r.json().catch(() => ({})) as { status?: string; code?: string; message?: string };
    if (!r.ok) throw new Error(`网关投递被拒（${r.status} ${body.code ?? body.message ?? ""}）`);
    return body;
  }
}
