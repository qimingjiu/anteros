import http from "node:http";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/index.js";
import type { Gateway } from "../gateway/index.js";
import type { McpManager } from "../tools/mcp.js";
import type { ReportEngine } from "../report/index.js";
import type { ModelSwitcher } from "../llm/switcher.js";
import type { ProactiveEngine } from "../proactive/index.js";
import { logger } from "../util/logger.js";
import type { PhoneContextProvider } from "../presence/index.js";
import type { RuntimeDiagnosticsProvider } from "../diagnostics/index.js";

const log = logger("web");

export interface WebDeps {
  cfg: AppConfig;
  db: Database;
  gateway: Gateway;
  mcp: McpManager;
  reportEngine: ReportEngine | null;
  startedAt: number;
  modelSwitcher?: ModelSwitcher | null;
  proactiveEngine?: ProactiveEngine | null;
  presence?: PhoneContextProvider | null;
  diagnostics?: RuntimeDiagnosticsProvider | null;
  notion?: {status(): Record<string, unknown>} | null;
  notionReminders?: {status(): Record<string, unknown>} | null;
}

export class StatusPanel {
  private server: http.Server | null = null;

  constructor(private deps: WebDeps) {}

  start(): void {
    const { cfg } = this.deps;
    if (!cfg.web.enabled) return;
    this.server = http.createServer((req, res) => {
      void this.route(req, res).catch((e) => {
        log.error("面板请求异常", e);
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      });
    });
    this.server.listen(cfg.web.port, cfg.web.host, () => {
      log.info(`状态面板: http://${cfg.web.host}:${cfg.web.port}`);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private authOk(req: http.IncomingMessage, url: URL): boolean {
    const t = this.deps.cfg.web.token;
    if (!t) return true;
    const q = url.searchParams.get("token");
    const h = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    return q === t || h === t;
  }

  private json(res: http.ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const { db, gateway, mcp, reportEngine } = this.deps;
    const sendTasks = db.recentSendTasks(20);
    const stats = gateway.getStats();

    if (url.pathname === "/api/status") {
      const h = gateway.getProvider().health();
      const queue = sendTasks.filter((t) => t.status === "queued" || t.status === "in_flight").length;
      return this.json(res, 200, {
        uptimeMs: Date.now() - this.deps.startedAt,
        provider: {
          connection: h.connection,
          login: h.login,
          selfId: h.selfId,
          lastHeartbeatAt: h.lastHeartbeatAt,
          lastError: h.lastError,
          reconnectCount: h.reconnectCount,
          capabilities: gateway.getProvider().capabilities(),
        },
        stats,
        queue,
        mcp: mcp.statuses(),
        timezone: this.deps.cfg.timezone,
        model: { provider: this.deps.cfg.model.provider, model: this.deps.modelSwitcher?.activeDisplayName() ?? this.deps.cfg.model.model },
        groups: this.deps.cfg.groups.allowlist,
        autoReply: {
          enabled: this.deps.cfg.groups.conversation?.enabled ?? true,
          mode: "main_model",
          model: this.deps.modelSwitcher?.activeDisplayName() ?? this.deps.cfg.model.model,
          summon: { priority: "highest", followupWindowMs: 120000, poke: true,
            wakeAliases: [...new Set([...(this.deps.cfg.groups.conversation?.wakeAliases ?? []), this.deps.cfg.persona.name])],
            ownerWakeAliases: this.deps.cfg.groups.conversation?.ownerWakeAliases ?? [] },
          limits: { observerCooldownMs: this.deps.cfg.groups.conversation?.observerCooldownMs ?? 30000,
            observerWindowMs: this.deps.cfg.groups.conversation?.observerWindowMs ?? 600000,
            observerMaxReplies: this.deps.cfg.groups.conversation?.observerMaxReplies ?? 3,
            repeatWindowMs: this.deps.cfg.groups.conversation?.repeatWindowMs ?? 900000,
            ownerMentionRepeatMs: this.deps.cfg.groups.conversation?.ownerMentionRepeatMs ?? 45000 },
        },
        blacklistCount: db.blockedUsers(this.deps.cfg.gateway.accountId).length,
        memoryEnabled: this.deps.cfg.memory.enabled,
        phoneContext: { enabled:this.deps.cfg.presence?.enabled ?? false,
          scope:this.deps.cfg.presence?.allowedGroupIds?.length ? "owner_private_and_allowed_groups" : "owner_private",
          allowedGroupCount:this.deps.cfg.presence?.allowedGroupIds?.length ?? 0,
          configured:Boolean(this.deps.cfg.presence?.supabaseUrl && this.deps.cfg.presence?.serverKey),
          source:this.deps.cfg.presence?.source ?? "phone_presence_state",
          provider:this.deps.cfg.presence?.source === "device_events" ? "EventTap" : "MacroDroid",
          runtime:this.deps.presence?.status?.() ?? null },
        reportsEnabled: this.deps.cfg.reports.enabled,
        reportsSchedule: this.deps.cfg.reports.schedule,
        documents: { enabled: this.deps.cfg.tools.enabled && (this.deps.cfg.documents?.enabled ?? false), formats: ["md", "docx", "pdf"] },
        features: {...this.deps.cfg.features,historyRetentionDays:this.deps.cfg.memory.rawRetentionDays,
          incomingFormats:["pdf","docx","xlsx"],morningMode:this.deps.cfg.proactive?.morningMode ?? "clock"},
        notion: {...(this.deps.notion?.status() ?? {enabled:false, configured:false}),
          reminders:this.deps.notionReminders?.status() ?? {enabled:false}},
        diagnostics: {enabled:this.deps.cfg.tools.enabled && Boolean(this.deps.diagnostics),readOnly:true,historyHours:24},
        weather: {enabled: this.deps.cfg.weather?.enabled ?? false, location: this.deps.cfg.weather?.defaultLocation},
        proactive: this.deps.proactiveEngine?.status() ?? {enabled: false},
      });
    }

    if (url.pathname === "/api/tasks") {
      return this.json(res, 200, {
        sendTasks: sendTasks.map((t) => ({ ...t, payload: undefined })),
      });
    }

    if (url.pathname === "/api/reports") {
      const reports = db.recentReports(20).map((r) => ({
        ...r,
        deliveries: (db.db.prepare("SELECT id, recipient_id, status, attempts, last_error FROM deliveries WHERE report_key = ?").all(r.report_key) as unknown[]),
      }));
      return this.json(res, 200, { reports });
    }

    if (url.pathname === "/api/memories") {
      const groupId = url.searchParams.get("group") ?? "";
      const kw = (url.searchParams.get("q") ?? "").split(/\s+/).filter(Boolean);
      if (!groupId) return this.json(res, 400, { error: "缺少 group 参数" });
      const rows = kw.length > 0
        ? db.searchMemories(this.deps.cfg.gateway.accountId, groupId, kw, 30)
        : db.recentMemories(this.deps.cfg.gateway.accountId, groupId, 30);
      return this.json(res, 200, { memories: rows });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/deliveries/") && url.pathname.endsWith("/retry")) {
      if (!this.authOk(req, url)) return this.json(res, 401, { error: "未授权" });
      const id = Number(url.pathname.split("/")[3]);
      if (!reportEngine) return this.json(res, 400, { error: "日报模块未启用" });
      const ok = reportEngine.retryDelivery(id);
      return this.json(res, ok ? 200 : 404, { ok });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderPage());
      return;
    }

    this.json(res, 404, { error: "not found" });
  }
}

function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QQ 群聊机器人 · 状态面板</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #0f1115; color: #d7dae0; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #7d8590; font-size: 13px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; max-width: 1100px; }
  .card { background: #161a22; border: 1px solid #232a36; border-radius: 10px; padding: 14px 16px; }
  .card h2 { font-size: 14px; margin: 0 0 10px; color: #9ab; font-weight: 600; }
  .kv { display: flex; justify-content: space-between; padding: 3px 0; font-size: 13px; gap: 12px; }
  .kv .k { color: #7d8590; }
  .ok { color: #4cc38a; } .bad { color: #f47067; } .warn { color: #e0a11b; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #232a36; }
  th { color: #7d8590; font-weight: 500; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; background: #232a36; }
  #err { color: #f47067; font-size: 13px; min-height: 18px; margin-top: 12px; }
</style>
</head>
<body>
<h1>QQ 群聊机器人</h1>
<div class="sub">状态面板 · 每 3 秒自动刷新</div>
<div id="err"></div>
<div class="grid">
  <div class="card"><h2>连接</h2><div id="conn"></div></div>
  <div class="card"><h2>统计</h2><div id="stats"></div></div>
  <div class="card"><h2>配置</h2><div id="cfg"></div></div>
  <div class="card"><h2>最近发送任务</h2><div id="tasks"></div></div>
  <div class="card"><h2>日报</h2><div id="reports"></div></div>
  <div class="card"><h2>MCP 服务器</h2><div id="mcp"></div></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const pill = (s) => { const cls = /connected|online|confirmed|generated|supported/.test(s) ? 'ok' : /unknown|unverified|connecting|reconnecting/.test(s) ? 'warn' : 'bad'; return '<span class="' + cls + '">' + s + '</span>'; };
async function refresh() {
  try {
    const [st, tasks, reports] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/tasks').then(r => r.json()),
      fetch('/api/reports').then(r => r.json()),
    ]);
    $('err').textContent = '';
    const h = st.provider;
    $('conn').innerHTML = [
      kv('OneBot 连接', pill(h.connection)),
      kv('QQ 登录', pill(h.login)),
      kv('机器人 QQ', h.selfId || '—'),
      kv('最近心跳', h.lastHeartbeatAt ? h.lastHeartbeatAt.slice(11, 19) : '—'),
      kv('重连次数', h.reconnectCount),
      kv('最近错误', h.lastError ? '<span class="bad">' + esc(h.lastError) + '</span>' : '—'),
    ].join('');
    const s = st.stats;
    $('stats').innerHTML = [
      kv('收到消息', s.receivedTotal + '（去重 ' + s.dedupSkipped + ' / 撤回 ' + s.recalled + '）'),
      kv('补取消息', s.backfilled),
      kv('发送确认/失败/不明', s.sentConfirmed + ' / ' + s.sentFailed + ' / ' + s.sentUnknown),
      kv('排队任务', st.queue),
      kv('运行时长', fmtDur(st.uptimeMs)),
    ].join('');
    $('cfg').innerHTML = [
      kv('模型', esc(st.model.provider === 'mock' ? 'mock（开发）' : st.model.model)),
      kv('启用群', st.groups.length ? st.groups.join(', ') : '（无）'),
      kv('记忆', st.memoryEnabled ? '开' : '关'),
      kv('日报', st.reportsEnabled ? '开 · ' + st.reportsSchedule : '关'),
      kv('文档', st.documents && st.documents.enabled ? '开 · Word / PDF / Markdown' : '关'),
      kv('运行诊断', st.diagnostics && st.diagnostics.enabled ? '开 · 只读，最近24小时' : '关'),
      kv('手机状态', st.phoneContext && st.phoneContext.enabled ? '开 · 仅主人私聊' : '关'),
      kv('手机读取', st.phoneContext && st.phoneContext.runtime && st.phoneContext.runtime.lastFetch
        ? esc(({ready:'已读取',empty:'无有效状态',failed:'读取失败'})[st.phoneContext.runtime.lastFetch.status] || '未读取')
          + ' · ' + st.phoneContext.runtime.currentFreshFieldCount + '/' + st.phoneContext.runtime.currentFieldCount + ' 项在有效期内'
        : '等待主人私聊或定时私聊触发'),
      kv('时区', st.timezone),
    ].join('');
    $('tasks').innerHTML = tasks.sendTasks.length === 0 ? '<div class="kv"><span class="k">暂无任务</span></div>' :
      '<table><tr><th>时间</th><th>类型</th><th>目标</th><th>状态</th></tr>' +
      tasks.sendTasks.slice(0, 12).map(t => '<tr><td>' + t.created_at.slice(11, 19) + '</td><td>' + t.kind + '</td><td>' + t.conversation_type + ':' + t.target_id + '</td><td>' + pill(t.status) + '</td></tr>').join('') + '</table>';
    const rs = reports.reports || [];
    $('reports').innerHTML = rs.length === 0 ? '<div class="kv"><span class="k">暂无日报</span></div>' :
      '<table><tr><th>日期</th><th>群</th><th>消息</th><th>状态</th><th>投递</th></tr>' +
      rs.slice(0, 8).map(r => '<tr><td>' + r.report_date + '</td><td>' + r.group_id + '</td><td>' + r.message_count + '</td><td>' + pill(r.status) + '</td><td>' +
        (r.deliveries || []).map(d => d.recipient_id + ':' + pill(d.status)).join('<br>') + '</td></tr>').join('') + '</table>';
    const m = st.mcp || [];
    $('mcp').innerHTML = m.length === 0 ? '<div class="kv"><span class="k">未启用</span></div>' :
      m.map(s => kv(s.name + ' (' + s.transport + ')', (s.connected ? pill('connected') : pill('disconnected')) + ' 工具 ' + s.tools)).join('');
  } catch (e) {
    $('err').textContent = '刷新失败: ' + e.message;
  }
}
function kv(k, v) { return '<div class="kv"><span class="k">' + k + '</span><span>' + v + '</span></div>'; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDur(ms) { const m = Math.floor(ms/60000); if (m < 60) return m + ' 分钟'; const h = Math.floor(m/60); return h + ' 小时 ' + (m%60) + ' 分'; }
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
}
