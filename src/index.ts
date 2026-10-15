import path from "node:path";
import process from "node:process";
import { loadConfig, resolveDataPath, type AppConfig } from "./config.js";
import { Database } from "./db/index.js";
import { OneBotProvider } from "./onebot/provider.js";
import { Gateway } from "./gateway/index.js";
import { createLLMClient } from "./llm/index.js";
import { ModelSwitcher } from "./llm/switcher.js";
import { discoverModelProfiles } from "./llm/catalog.js";
import { SqliteMemory } from "./memory/index.js";
import { Agent } from "./agent/index.js";
import { createSearchProvider } from "./tools/search.js";
import { PageReader } from "./tools/reader.js";
import { ResearchRuntime } from "./tools/research.js";
import { NotionNotebook } from "./tools/notion.js";
import { NotionReminderScheduler } from "./tools/notion-reminders.js";
import { McpManager } from "./tools/mcp.js";
import { ReportEngine } from "./report/index.js";
import { StatusPanel } from "./web/index.js";
import { initLogging, logger } from "./util/logger.js";
import type { ToolDef } from "./types.js";
import { OpenMeteoWeather } from "./tools/weather.js";
import { ProactiveEngine } from "./proactive/index.js";
import { PhonePresenceService } from "./presence/index.js";
import { DocumentService } from "./documents/index.js";
import { DocumentDelivery } from "./documents/delivery.js";
import { RuntimeDiagnostics } from "./diagnostics/index.js";
import { runtimeDiagnosticStatus, type RuntimeDiagnosticDeps } from "./diagnostics/runtime.js";
import { IncomingDocumentService } from "./documents/incoming.js";
import { TaskLedger } from "./tasks/index.js";
import { MiniMaxMediaService } from "./tools/minimax-media.js";
import { MuninnMemoryService } from "./tools/muninn-memory.js";
import { FeishuToolsService } from "./tools/feishu-tools.js";
import { EmailService, emailConfigFromEnv } from "./tools/email.js";

const log = logger("main");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configIdx = args.indexOf("--config");
  const configArg = configIdx >= 0 ? args[configIdx + 1] : undefined;
  const configPath = configArg ? path.resolve(configArg) : path.resolve("config.yaml");
  const baseDir = path.dirname(configPath);

  let cfg: AppConfig;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exitCode = 1;
    return;
  }

  initLogging(cfg.logging.level, resolveDataPath(baseDir, cfg.logging.dir));
  let diagnosticDeps: RuntimeDiagnosticDeps | undefined;
  const diagnostics = new RuntimeDiagnostics({directory:path.join(baseDir,"data","diagnostics"),
    currentStatus:request => diagnosticDeps ? runtimeDiagnosticStatus(diagnosticDeps,request) : []});
  log.info("启动 QQ 群聊机器人");
  log.info(`配置: ${configPath}（账号 ${cfg.gateway.accountId}，时区 ${cfg.timezone}）`);

  if (cfg.groups.allowlist.length === 0) {
    log.warn("groups.allowlist 为空：不会响应任何群聊。请在 config.yaml 中填入群号。");
  }
  if (cfg.model.provider === "openai_compatible" && !cfg.model.apiKey) {
    log.warn("model.api_key 为空：如果模型服务需要鉴权，回复会失败。");
  }

  const startedAt = Date.now();

  // 数据层
  const db = new Database(resolveDataPath(baseDir, cfg.database.path));
  if (cfg.features?.tasks !== false) new TaskLedger(db).recoverInterrupted(cfg.gateway.accountId);

  // Provider + Gateway
  const provider = new OneBotProvider({
    accountId: cfg.gateway.accountId,
    endpoint: cfg.gateway.onebot.endpoint,
    accessToken: cfg.gateway.onebot.accessToken,
    reconnectBaseMs: cfg.gateway.onebot.reconnectBaseMs,
    reconnectMaxMs: cfg.gateway.onebot.reconnectMaxMs,
    heartbeatTimeoutFactor: cfg.gateway.onebot.heartbeatTimeoutFactor,
    requestTimeoutMs: cfg.gateway.onebot.requestTimeoutMs,
    privateFileAction: cfg.gateway.onebot.privateFileAction,
    groupFileAction: cfg.gateway.onebot.groupFileAction,
    historyAction: cfg.gateway.onebot.historyAction,
  });
  const gateway = new Gateway(db, provider, {
    accountId: cfg.gateway.accountId,
    backfillMaxPages: cfg.gateway.onebot.backfillMaxPages,
    backfillPageLimit: cfg.gateway.onebot.backfillPageLimit,
  });
  // 新锚点：每条实时群消息都更新锚点，供重连补取
  gateway.onEvent((ev) => {
    if (ev.kind === "message" && ev.message.groupId && ev.message.origin === "live") {
      gateway.updateAnchor(ev.message.groupId, ev.message.messageId);
    }
  });

  // 模型（支持管理员切换档位）
  const catalog = await discoverModelProfiles(cfg.model.providers ?? [], db);
  cfg.model.profiles = [...cfg.model.profiles, ...catalog.profiles];
  for (const report of catalog.reports) {
    log.info(`模型目录: ${report.provider}，${report.count} 个模型，来源 ${report.source}`);
    for (const warning of report.warnings) log.warn(`${report.provider}: ${warning}`);
  }
  const llm = createLLMClient(cfg.model);
  const modelSwitcher = cfg.model.profiles.length > 0 || (cfg.model.providers?.length ?? 0) > 0
    ? new ModelSwitcher(cfg.model.profiles, cfg.model, db)
    : null;

  // 工具
  const research = new ResearchRuntime({ ...cfg.tools.research,
    quotaFile: path.join(path.dirname(resolveDataPath(baseDir, cfg.database.path)), "research-quota.json") });
  const search = cfg.tools.enabled ? createSearchProvider(cfg.tools.search, research) : null;
  const reader = cfg.tools.enabled && cfg.tools.reader.enabled
    ? new PageReader({ ...cfg.tools.reader, runtime: research, tavilyApiKey: cfg.tools.search.tavilyApiKey })
    : null;
  const mcp = new McpManager(cfg.tools.mcp, (tool: ToolDef) => tool.name.startsWith("mcp__"));
  const weather = cfg.weather?.enabled ? new OpenMeteoWeather(cfg.weather) : null;
  const notion = cfg.tools.enabled && cfg.notion?.enabled
    ? new NotionNotebook(cfg.notion,{db}) : null;
  const notionReminders = notion && cfg.notion?.remindersEnabled ? new NotionReminderScheduler({
    db,gateway,accountId:cfg.gateway.accountId,ownerIds:cfg.tools.ownerIds ?? cfg.admins,allowedGroupIds:cfg.groups.allowlist,
    notebook:notion,
  }) : null;
  const incomingDocuments = cfg.tools.enabled && cfg.documents?.enabled && cfg.features?.incomingFiles !== false
    ? new IncomingDocumentService({db:db.db,ownerIds:cfg.tools.ownerIds ?? cfg.admins,provider}) : null;
  const documentDelivery = cfg.documents?.enabled ? new DocumentDelivery({
    db, gateway, accountId: cfg.gateway.accountId,
    service: new DocumentService({ ...cfg.documents, outputDir: resolveDataPath(baseDir, cfg.documents.outputDir) }),
    providerOutputDir: cfg.documents.providerOutputDir,
    waitTimeoutMs: Math.min(60000, cfg.gateway.onebot.requestTimeoutMs + 1500),
  }) : null;
  const minimaxMedia = cfg.tools.enabled && cfg.tools.minimax?.enabled ? new MiniMaxMediaService({
    db,gateway,mcp,accountId:cfg.gateway.accountId,ownerIds:cfg.tools.ownerIds ?? cfg.admins,
    outputDir:path.join(resolveDataPath(baseDir,cfg.documents?.outputDir ?? "data/documents"),"media"),
    providerOutputDir:cfg.documents?.providerOutputDir ? path.posix.join(cfg.documents.providerOutputDir,"media") : undefined,
    waitTimeoutMs:Math.min(60000,cfg.gateway.onebot.requestTimeoutMs+1500),
  }) : null;
  const muninnMemory = cfg.tools.enabled && cfg.tools.muninn?.enabled ? new MuninnMemoryService({
    mcp,accountId:cfg.gateway.accountId,ownerIds:cfg.tools.ownerIds ?? cfg.admins,
  }) : null;
  const feishuTools = cfg.tools.enabled && cfg.tools.feishu?.enabled ? new FeishuToolsService({
    mcp,accountId:cfg.gateway.accountId,ownerIds:cfg.tools.ownerIds ?? cfg.admins,
  }) : null;
  const email = cfg.tools.enabled && cfg.tools.email?.enabled ? new EmailService({
    db,accountId:cfg.gateway.accountId,ownerIds:cfg.tools.ownerIds ?? cfg.admins,config:emailConfigFromEnv(),
  }) : null;

  // 记忆
  const memory = cfg.memory.enabled
    ? new SqliteMemory(db, cfg.memory, modelSwitcher ?? llm, cfg.model.summaryModel || undefined)
    : null;
  memory?.start();

  // Agent
  if (cfg.groups.conversation?.enabled !== false) log.info("群聊由当前主模型决定回复或静默，独立判断模型已停用");
  const presence = new PhonePresenceService(cfg.presence);
  const proactiveEngine = new ProactiveEngine({db, cfg, gateway, llm: modelSwitcher ?? llm, weather, presence});
  diagnosticDeps = {cfg,db,gateway,mcp,presence,proactive:proactiveEngine,searchReady:Boolean(search),
    readerReady:Boolean(reader),documentsReady:Boolean(documentDelivery),weatherReady:Boolean(weather),research,notion,notionReminders,email};
  const agent = new Agent({
    db,
    cfg,
    gateway,
    llm: modelSwitcher ?? llm,
    memory,
    search,
    reader,
    mcp,
    modelSwitcher,
    timezone: cfg.timezone,
    weather,
    proactiveEngine,
    documentDelivery,
    presence,
    diagnostics,
    research,
    notion,
    notionReminders,
    incomingDocuments,
    minimaxMedia,
    muninnMemory,
    feishuTools,
    email,
  });

  // 日报
  const reportEngine = new ReportEngine(db, cfg.reports, cfg.timezone, gateway, cfg.reports.enabled ? (modelSwitcher ?? llm) : null);
  agent.setReportEngine(reportEngine);
  gateway.onEvent((ev) => {
    if (ev.kind === "message" && ev.message.groupId && cfg.groups.allowlist.includes(ev.message.groupId)) {
      reportEngine.noteKnownGroup(ev.message.groupId);
    }
  });

  // MCP 后台连接（失败不阻塞主流程）
  void mcp.start().catch((e) => log.warn("MCP 启动失败:", (e as Error).message));

  // 面板
  const panel = new StatusPanel({ cfg, db, gateway, mcp, reportEngine, startedAt, modelSwitcher, proactiveEngine, presence, diagnostics, notion, notionReminders });
  panel.start();

  agent.attach();
  gateway.start();

  // 消息保留清理：每天一次
  const retentionTimer = setInterval(() => {
    try {
      const n = db.purgeOldMessages(cfg.memory.rawRetentionDays);
      if (n > 0) log.info(`清理 ${n} 条过期消息（保留 ${cfg.memory.rawRetentionDays} 天）`);
    } catch (e) {
      log.error("消息清理失败", e);
    }
  }, 6 * 3600_000);
  retentionTimer.unref?.();

  reportEngine.start();
  proactiveEngine.start();
  notionReminders?.start();

  // 优雅退出
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`收到 ${signal}，正在退出…`);
    try {
      reportEngine.stop();
      await proactiveEngine.stop();
      await notionReminders?.stop();
      retentionTimer.unref?.();
      memory?.stop();
      await mcp.stop();
      await panel.stop();
      await gateway.stop();
      diagnostics.close();
      db.close();
    } catch (e) {
      log.error("退出清理异常", e);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Windows Ctrl+C / 关闭窗口
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("SIGBREAK", () => void shutdown("SIGBREAK"));

  log.info("机器人已启动。状态面板见上方地址；Ctrl+C 退出。");
}

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
