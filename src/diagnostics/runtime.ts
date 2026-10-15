import type { AppConfig } from "../config.js";
import type { Database } from "../db/index.js";
import type { Gateway } from "../gateway/index.js";
import type { McpManager } from "../tools/mcp.js";
import type { PhoneContextProvider } from "../presence/index.js";
import type { ProactiveEngine } from "../proactive/index.js";
import type { ResearchRuntime } from "../tools/research.js";
import { classifyDiagnosticFailure, type RuntimeDiagnosticStatus, type RuntimeDiagnosticsReadRequest } from "./index.js";

export interface RuntimeDiagnosticDeps {
  cfg: AppConfig;
  db: Database;
  gateway: Gateway;
  mcp: McpManager;
  presence?: PhoneContextProvider | null;
  proactive?: ProactiveEngine | null;
  searchReady: boolean;
  readerReady: boolean;
  documentsReady: boolean;
  weatherReady: boolean;
  research?: ResearchRuntime;
  notion?: { status(): Record<string, unknown> } | null;
  notionReminders?: { status(): Record<string, unknown> } | null;
  email?: { status(): { configured: boolean } } | null;
  now?: () => number;
}

/** Local status only. No HTTP probes, tool execution, payloads or chat reads. */
export function runtimeDiagnosticStatus(deps: RuntimeDiagnosticDeps, request: RuntimeDiagnosticsReadRequest): RuntimeDiagnosticStatus[] {
  const {cfg, db, gateway} = deps;
  if (request.accountId !== cfg.gateway.accountId) return [{component:"system",ready:false,failure:"permission"}];
  const provider = gateway.getProvider();
  const health = provider.health();
  const selected = cfg.model.profiles.find(profile => profile.name === db.kvGet("active_model_profile")) ?? cfg.model;
  const modelConfigured = selected.provider === "mock" || Boolean(selected.apiKey);
  // Group callers get only task aggregates for their actual target. Payloads
  // and last_error bodies never become diagnostic responses.
  const conversation = /^group_([1-9]\d*)$/.exec(request.conversationId);
  const cutoff = new Date((deps.now?.() ?? Date.now()) - 24 * 60 * 60 * 1000).toISOString();
  const tasks = request.scope === "global"
    ? db.db.prepare("SELECT kind,status,count(*) AS count FROM send_tasks WHERE updated_at>=? GROUP BY kind,status").all(cutoff)
    : conversation && request.accountId === cfg.gateway.accountId
      ? db.db.prepare("SELECT kind,status,count(*) AS count FROM send_tasks WHERE conversation_type='group' AND target_id=? AND updated_at>=? GROUP BY kind,status").all(conversation[1]!,cutoff)
      : [];
  const count = (status: string, documentsOnly = false) => tasks.reduce((total, row) => total
    + (row.status === status && (!documentsOnly || row.kind === "document_file") ? Number(row.count) : 0), 0);
  const result: RuntimeDiagnosticStatus[] = [
    {component:"model", name:"active_model", enabled:true, configured:modelConfigured,
      details:{model:selected.model,provider:selected.provider}},
    {component:"gateway", enabled:true, connected:health.connection === "connected", ready:health.login === "online",
      ...(health.lastHeartbeatAt ? {lastAt:health.lastHeartbeatAt} : {}),
      ...(health.lastError ? {failure:classifyDiagnosticFailure(health.lastError).reason,
        httpStatus:classifyDiagnosticFailure(health.lastError).httpStatus} : {}),
      details:{connection:health.connection,login:health.login,capabilities:provider.capabilities(),
        failedTasks:count("failed"),unknownTasks:count("unknown"),queuedTasks:count("queued")+count("in_flight")}},
    {component:"documents", enabled:cfg.tools.enabled && Boolean(cfg.documents?.enabled), configured:deps.documentsReady,
      details:{failedTasks:count("failed",true),unknownTasks:count("unknown",true),queuedTasks:count("queued",true)+count("in_flight",true)}},
    {component:"search", enabled:cfg.tools.enabled && cfg.tools.search.provider !== "none", configured:deps.searchReady},
    {component:"reader", enabled:cfg.tools.enabled && cfg.tools.reader.enabled, configured:deps.readerReady},
    {component:"weather", enabled:cfg.tools.enabled && Boolean(cfg.weather?.enabled), configured:deps.weatherReady},
    {component:"email", enabled:cfg.tools.enabled && Boolean(cfg.tools.email?.enabled), configured:deps.email?.status().configured === true},
  ];
  const mcp = deps.mcp.statuses();
  if (deps.research) {
    const research = deps.research.status();
    result.push({component:"search",name:"free_research",configured:true,ready:research.storageReady,
      ...(research.lastFailure ? {lastAt:research.lastFailure.at,failure:classifyDiagnosticFailure({reason:research.lastFailure.reason,name:"WebAccessError"}).reason} : {}),
      details:{freeOnly:true,quotaSource:"local_reservations"}});
    for (const [name, quota] of Object.entries(research.quotas)) {
      const configured = name === "tavily" ? Boolean(cfg.tools.search.tavilyApiKey) : name === "exa" ? Boolean(cfg.tools.search.exaApiKey)
        : name === "firecrawl" ? Boolean(cfg.tools.reader.firecrawlApiKey) : Boolean(cfg.tools.search.googleCse.apiKey && cfg.tools.search.googleCse.cx);
      if (!configured) continue;
      const multiplier = name === "exa" ? 1000 : 1;
      result.push({component:name === "firecrawl" ? "reader" : "search",name,configured:true,
        ready:research.storageReady && deps.research.providerAvailable(name),
        ...(!deps.research.providerAvailable(name) ? {failure:research.storageReady ? "quota" as const : "storage" as const} : {}),
        details:{freeOnly:true,quotaSource:"local_reservations",quotaUnit:name === "exa" ? "usd_milli" : "credits",
          dailyUsedUnits:Math.ceil(quota.dailyUsed*multiplier),monthlyUsedUnits:Math.ceil(quota.monthlyUsed*multiplier),
          dailyLimitUnits:Math.floor(quota.dailyLimit*multiplier),monthlyLimitUnits:Math.floor(quota.monthlyLimit*multiplier)}});
    }
  }
  if (!mcp.length) result.push({component:"mcp",enabled:cfg.tools.enabled && cfg.tools.mcp.enabled,count:0});
  for (const server of mcp.slice(0,12)) {
    result.push({component:"mcp",name:server.name,enabled:cfg.tools.enabled && cfg.tools.mcp.enabled,connected:server.connected,
      ...(server.error ? {failure:classifyDiagnosticFailure(server.error).reason,
        httpStatus:classifyDiagnosticFailure(server.error).httpStatus} : {}),
      details:{service:server.name,toolCount:server.tools,...(server.transport === "stdio" || server.transport === "http" ? {transport:server.transport} : {})}});
  }
  if (request.scope === "global") {
    const notebook = deps.notion?.status();
    result.push({component:"notion",name:"notebook",enabled:Boolean(cfg.notion?.enabled),configured:notebook?.configured === true,
      ready:notebook?.configured === true && !(Number(notebook.cooldownMs) > 0),
      ...(Number(notebook?.cooldownMs) > 0 ? {failure:"rate_limit" as const} : {})});
    const reminders = deps.notionReminders?.status();
    if (reminders) result.push({component:"notion",name:"qq_reminders",enabled:true,ready:reminders.schedulerRunning === true && reminders.healthy !== false,
      ...(reminders.lastFailure ? {failure:"storage" as const} : {})});
    const phone = deps.presence?.status?.();
    if (phone) result.push({component:"presence",enabled:phone.enabled,configured:phone.configured,count:phone.currentFieldCount,
      ...(phone.lastFetch ? {lastAt:phone.lastFetch.at,httpStatus:phone.lastFetch.httpStatus ?? undefined,
        ready:phone.lastFetch.status === "ready",
        ...(phone.lastFetch.status === "failed" ? {failure:phone.lastFetch.failure === "timeout" ? "timeout" as const
          : phone.lastFetch.failure === "network" ? "network" as const
          : phone.lastFetch.failure === "oversized" ? "quota" as const
          : phone.lastFetch.failure === "invalid_json" || phone.lastFetch.failure === "invalid_response" ? "invalid_response" as const
          : classifyDiagnosticFailure({status:phone.lastFetch.httpStatus}).reason} : {})} : {}),
      details:{source:phone.source,currentFieldCount:phone.currentFieldCount,currentFreshFieldCount:phone.currentFreshFieldCount,
        ...(phone.lastFetch ? {lastFetchStatus:phone.lastFetch.status} : {})}});
    const proactive = deps.proactive?.status();
    if (proactive) result.push({component:"proactive",enabled:proactive.enabled === true,
      ready:proactive.enabled === true && proactive.paused !== true});
    result.push({component:"memory",enabled:cfg.memory.enabled});
  }
  return result;
}
