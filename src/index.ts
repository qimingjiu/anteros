import path from "node:path";
import process from "node:process";
import { loadConfig, resolveDataPath, type AppConfig } from "./config.js";
import { Database } from "./db/index.js";
import { RecallTools } from "./tools/recall.js";
import { DiscordProvider } from "./discord/provider.js";
import { MusicService } from "./discord/music.js";
import { VoiceCallService } from "./discord/call.js";
import type { MessageRecord } from "./types.js";
import { Gateway, gatewayOptionsFromConfig } from "./gateway/index.js";
import { createLLMClient } from "./llm/index.js";
import { ModelSwitcher } from "./llm/switcher.js";
import { ModelSelection } from "./llm/selection.js";
import type { PersonaCard } from "./agent/persona-switch.js";
import { discoverModelProfiles } from "./llm/catalog.js";
import { SqliteMemory } from "./memory/index.js";
import { MessageRetention } from "./memory/retention.js";
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
import { setModelTimezone } from "./util/model-time.js";
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
import { SendImageService } from "./tools/send-image.js";
import { MuninnMemoryService } from "./tools/muninn-memory.js";
import { FeishuToolsService } from "./tools/feishu-tools.js";
import { EmailService, emailConfigFromEnv } from "./tools/email.js";
import { configuredAccounts, createPlatformProvider } from "./platform-accounts.js";
import { CrossPlatformDelivery, type CrossPlatformAccount } from "./cross-platform/index.js";
import { FamilyDesk } from "./family/index.js";
import { PrivateTranscript } from "./family/transcript.js";
import { McpAdmin } from "./mcp-admin/index.js";
import { createMcpAdminHandler } from "./mcp-admin/panel.js";

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
  const diagnosticDeps = new Map<string, RuntimeDiagnosticDeps>();
  const diagnostics = new RuntimeDiagnostics({directory:path.join(baseDir,"data","diagnostics"),
    currentStatus: request => {
      const account = diagnosticDeps.get(request.accountId);
      return account ? runtimeDiagnosticStatus(account, request) : [];
    } });
  log.info("启动安忒洛斯");
  log.info(`配置: ${configPath}（账号 ${cfg.gateway.accountId}，时区 ${cfg.timezone}）`);
  setModelTimezone(cfg.timezone);

  if (cfg.groups.allowlist.length === 0) {
    log.warn("groups.allowlist 为空：不会响应任何群聊。请在 config.yaml 中填入群号。");
  }
  if (cfg.model.provider === "openai_compatible" && !cfg.model.apiKey) {
    log.warn("model.api_key 为空：如果模型服务需要鉴权，回复会失败。");
  }

  const startedAt = Date.now();

  // 数据层
  const db = new Database(resolveDataPath(baseDir, cfg.database.path));
  const accounts = configuredAccounts(cfg).map((config, index) => {
    if (config.features?.tasks !== false) new TaskLedger(db).recoverInterrupted(config.gateway.accountId);
    const provider = createPlatformProvider(config, db, index === 0 && !cfg.gateway.additionalAccounts?.length);
    const gateway = new Gateway(db, provider, gatewayOptionsFromConfig(config, index === 0));
    gateway.onEvent(ev => {
      if (provider.getGroupMsgHistory && ev.kind === "message" && ev.message.groupId && ev.message.origin === "live") {
        gateway.updateAnchor(ev.message.groupId, ev.message.messageId);
      }
    });
    return { config, provider, gateway };
  });
  const routeAccounts = new Map<string, CrossPlatformAccount>(accounts.map(({ config, gateway }) => [
    config.gateway.accountId,
    { gateway, platform: config.gateway.provider, ownerIds: config.tools.ownerIds ?? config.admins,
      providerFileRoot: config.gateway.provider === "onebot" && config.documents?.providerOutputDir
        ? path.posix.join(config.documents.providerOutputDir, ".cross-platform") : undefined },
  ]));
  const crossPlatform = cfg.crossPlatform?.destinations.length ? new CrossPlatformDelivery({
    db, config: cfg.crossPlatform, accounts: routeAccounts,
    artifactRoot: path.join(resolveDataPath(baseDir, cfg.documents?.outputDir ?? "data/documents"), ".cross-platform"),
  }) : undefined;
  const linked = cfg.family ? new PrivateTranscript(db, accounts.map(({ config, provider }, index) => ({
    accountId: config.gateway.accountId,
    ownerIds: index === 0 ? [cfg.family!.ownerId] : config.tools.ownerIds ?? config.admins,
    botId: () => provider.health().selfId,
  }))) : undefined;

  // 模型（支持管理员切换档位）
  const catalog = await discoverModelProfiles(cfg.model.providers ?? [], db);
  cfg.model.profiles = [...cfg.model.profiles, ...catalog.profiles];
  for (const report of catalog.reports) {
    log.info(`模型目录: ${report.provider}，${report.count} 个模型，来源 ${report.source}`);
    for (const warning of report.warnings) log.warn(`${report.provider}: ${warning}`);
  }
  const defaultLlm = createLLMClient(cfg.model);
  const modelSwitcher = cfg.model.profiles.length > 0 || (cfg.model.providers?.length ?? 0) > 0
    ? new ModelSwitcher(cfg.model.profiles, cfg.model, db)
    : null;
  const llm = modelSwitcher ?? defaultLlm;

  // 工具
  const research = new ResearchRuntime({ ...cfg.tools.research,
    quotaFile: path.join(path.dirname(resolveDataPath(baseDir, cfg.database.path)), "research-quota.json") });
  const search = cfg.tools.enabled ? createSearchProvider(cfg.tools.search, research) : null;
  const reader = cfg.tools.enabled && cfg.tools.reader.enabled
    ? new PageReader({ ...cfg.tools.reader, runtime: research, tavilyApiKey: cfg.tools.search.tavilyApiKey })
    : null;
  const mcp = new McpManager(cfg.tools.mcp, (tool: ToolDef) => tool.name.startsWith("mcp__"));
  const mcpAdmin = cfg.tools.mcp.enabled && cfg.tools.mcp.managedEnabled && cfg.web.enabled && cfg.web.token
    ? new McpAdmin({ db: db.db, manager: mcp, directory: resolveDataPath(baseDir, "data/mcp"),
      isOwner: (accountId, requesterId) => Boolean(routeAccounts.get(accountId)?.ownerIds.includes(requesterId)
        && !db.isUserBlocked(accountId, requesterId)) })
    : undefined;
  const weather = cfg.weather?.enabled ? new OpenMeteoWeather(cfg.weather) : null;
  const notion = cfg.tools.enabled && cfg.notion?.enabled
    ? new NotionNotebook(cfg.notion,{db}) : null;

  const memory = cfg.memory.enabled ? new SqliteMemory(db, cfg.memory, llm, cfg.model.summaryModel || undefined,
    { selfId: accountId => accounts.find(entry => entry.config.gateway.accountId === accountId)?.provider.health().selfId }) : null;
  memory?.start();

  let familyTurn = Promise.resolve();
  const runFamilyTurn = (turn: () => Promise<void>) => {
    const next = familyTurn.then(turn);
    familyTurn = next.catch(() => undefined);
    return next;
  };
  let sharedWorld: ReturnType<Agent["familyWorld"]> | undefined;
  const familyRoom = cfg.family ? `family:${cfg.gateway.accountId}:${cfg.family.ownerId}` : undefined;
  const memberModels = new Map<string, { llm: ModelSwitcher; selection: ModelSelection }>();
  const familyModel = (member: PersonaCard) => {
    if (!familyRoom || !modelSwitcher) return undefined;
    let route = memberModels.get(member.id);
    if (!route) {
      const scoped = modelSwitcher.forMember(familyRoom, member.id, member.name);
      route = { llm: scoped, selection: new ModelSelection(scoped) };
      memberModels.set(member.id, route);
    }
    return route;
  };
  const incomingServices = new Map<string, IncomingDocumentService>();
  const familyDesk = linked && familyRoom ? new FamilyDesk(db, {
    isOwner: (message: MessageRecord) => linked.has(message) && !db.isUserBlocked(message.accountId, message.senderId),
    members: () => sharedWorld?.personas.list() ?? [],
    room: () => familyRoom,
    timeZone: cfg.timezone,
    readPage: reader ? async url => {
      const page = await reader.read(url);
      if (page.status !== "ok") throw new Error("网页读取失败");
      return page;
    } : undefined,
    loadAttachments: source => incomingServices.get(source.accountId)?.loadCurrentAttachments(source) ?? Promise.resolve([]),
    generate: async (memberId, text, signal) => {
      const personas = sharedWorld?.personas;
      const member = personas?.list().find(card => card.id === memberId);
      if (!personas || !member) throw new Error("家庭成员不存在");
      const result = await (familyModel(member)?.llm ?? llm).chat([{ role: "system", content: personas.promptOf(member) },
        { role: "user", content: text }], { tools: [], signal });
      return result.content;
    },
    transcript: (source, start, end) => linked.read(source, start, end, { limit: 2000 }),
    notify: async ({ key, source, text, destination, artifact }) => {
      const account = routeAccounts.get(source.accountId);
      if (!account || !linked.has(source) || db.isUserBlocked(source.accountId, source.senderId)) {
        throw new Error("家庭通知的原始私聊已解绑");
      }
      if (destination) {
        const kind = artifact ? "file" : "text";
        const route = crossPlatform?.authorize(source, destination, kind);
        if (!crossPlatform || !route) throw new Error("家庭任务的投递地址未绑定");
        const receipt = await crossPlatform.enqueue(source, route, artifact
          ? { kind: "file", files: [{ filename: artifact.name, bytes: artifact.bytes }] }
          : { kind: "text", text: text.slice(0, 1500) }, { key });
        if (receipt.status === "failed" || receipt.status === "unknown") throw new Error(receipt.detail);
        return;
      }
      account.gateway.enqueueSend({ taskKey: `family:${key}`, kind: "family_notice", conversationType: "private",
        targetId: source.senderId, payload: { kind: "segments", segments: [{ type: "text", data: { text: text.slice(0, 1500) } }],
          requesterId: source.senderId, accountId: source.accountId } });
    },
  }) : undefined;
  function createAccountRuntime(account: (typeof accounts)[number], primary: boolean) {
    const { config: cfg, provider, gateway } = account;
    const notionReminders = notion && cfg.notion?.remindersEnabled ? new NotionReminderScheduler({
      db,gateway,accountId:cfg.gateway.accountId,ownerIds:cfg.tools.ownerIds ?? cfg.admins,allowedGroupIds:cfg.groups.allowlist,
      notebook:notion,
    }) : null;
    const incomingDocuments = cfg.tools.enabled && (cfg.documents?.enabled || crossPlatform || familyDesk)
      && cfg.features?.incomingFiles !== false
      ? new IncomingDocumentService({db:db.db,ownerIds:cfg.tools.ownerIds ?? cfg.admins,provider}) : null;
    if (incomingDocuments) incomingServices.set(cfg.gateway.accountId, incomingDocuments);
    const documentDelivery = cfg.documents?.enabled ? new DocumentDelivery({
      db, gateway, accountId: cfg.gateway.accountId,
      service: new DocumentService({ ...cfg.documents, outputDir: resolveDataPath(baseDir, cfg.documents.outputDir) }),
      providerOutputDir: provider.providerId === "onebot" ? cfg.documents.providerOutputDir : undefined,
      waitTimeoutMs: Math.min(60000, cfg.gateway.onebot.requestTimeoutMs + 1500),
      crossPlatform,
    }) : null;
    const music = provider instanceof DiscordProvider ? new MusicService({
      getClient: () => provider.getClient(), accountId: cfg.gateway.accountId, ownerIds: cfg.tools.ownerIds ?? cfg.admins,
      apiBase: process.env.NCM_API_BASE ?? "http://127.0.0.1:3010", cookieFile: path.join(baseDir, "data/discord/ncm.cookie"),
      sendImage: (t, b64, text) => {
        const segs = [{ type: "text" as const, data: { text } }, { type: "image" as const, data: { file: `base64://${b64}` } }];
        return t.groupId ? provider.sendGroupMsg(t.groupId, segs as any) : provider.sendPrivateMsg(t.userId, segs as any);
      },
    }) : null;
    const voiceCall = music && process.env.SORA_API_KEY && process.env.MINIMAX_API_KEY ? new VoiceCallService({
      getClient: () => (provider as DiscordProvider).getClient(), accountId: cfg.gateway.accountId, ownerIds: cfg.tools.ownerIds ?? cfg.admins,
      personaFile: path.join(baseDir, "persona.md"),
      llm: { baseUrl: process.env.CALL_LLM_BASE ?? "https://api.usora.net/v1", apiKey: process.env.SORA_API_KEY, model: process.env.CALL_LLM_MODEL ?? "times/gemini-3.8-flash-compat,gemini-3.8-flash-high,times/gemini-3.8-flash" },
      tts: { host: process.env.MINIMAX_API_HOST ?? "https://api.minimaxi.com", apiKey: process.env.MINIMAX_API_KEY, voiceId: "English_Gentle-voiced_man", model: process.env.CALL_TTS_MODEL ?? "speech-2.8-hd" },
      restoreMusic: (gid) => music.resubscribe(gid),
      db, selfId: () => provider.health().selfId,
      music: { play: (m, x) => music.play(m, x), control: (m, x) => music.control(m, x) },
    }) : null;
    const minimaxMedia = cfg.tools.enabled && cfg.tools.minimax?.enabled ? new MiniMaxMediaService({
      db,gateway,mcp,accountId:cfg.gateway.accountId,ownerIds:cfg.tools.ownerIds ?? cfg.admins,
      outputDir:path.join(resolveDataPath(baseDir,cfg.documents?.outputDir ?? "data/documents"),"media"),
      providerOutputDir: provider.providerId === "onebot" && cfg.documents?.providerOutputDir
        ? path.posix.join(cfg.documents.providerOutputDir, "media") : undefined,
      waitTimeoutMs:Math.min(60000,cfg.gateway.onebot.requestTimeoutMs+1500),
      crossPlatform,
    }) : null;
    const sendImage = cfg.tools.enabled ? new SendImageService({
      db,gateway,accountId:cfg.gateway.accountId,ownerIds:cfg.tools.ownerIds ?? cfg.admins,
      waitTimeoutMs:Math.min(60000,cfg.gateway.onebot.requestTimeoutMs+1500),
      crossPlatform,
    }) : null;
    const muninnMemory = cfg.tools.enabled && cfg.tools.muninn?.enabled ? new MuninnMemoryService({
      mcp,accountId:cfg.gateway.accountId,ownerIds:cfg.tools.ownerIds ?? cfg.admins,
    }) : null;
    const feishuTools = cfg.tools.enabled && cfg.tools.feishu?.enabled ? new FeishuToolsService({
      mcp,accountId:cfg.gateway.accountId,ownerIds:cfg.tools.ownerIds ?? cfg.admins,
    }) : null;
    const email = cfg.tools.enabled && cfg.tools.email?.enabled ? new EmailService({
      db,accountId:cfg.gateway.accountId,ownerIds:cfg.tools.ownerIds ?? cfg.admins,config:emailConfigFromEnv(),
      recentTexts:(conversationId:string,senderIds:string[],limit:number)=>{
        const self=provider.health().selfId; const ids=[...senderIds, ...(self?[String(self)]:[])];
        if(!ids.length) return [];
        const rows=db.db.prepare(`SELECT sender_id, text_content FROM (SELECT sender_id, text_content FROM messages WHERE account_id=? AND conversation_id=? AND status='active' ORDER BY id DESC LIMIT ?) WHERE sender_id IN (${ids.map(()=>"?").join(",")})`)
          .all(cfg.gateway.accountId, conversationId, limit, ...ids) as {sender_id:string;text_content:string}[];
        return rows.map(r=>r.text_content);
      },
    }) : null;

    // Agent
    if (cfg.groups.conversation?.enabled !== false) log.info("群聊由当前主模型决定回复或静默，独立判断模型已停用");
    const presence = new PhonePresenceService(cfg.presence);
    const proactiveEngine = new ProactiveEngine({db, cfg, gateway, llm: llm, weather, presence});
    // Custom status: apply once logged in, and re-apply every 10 min (survives reconnects).
    const applyStatus = () => { try { music?.updatePresence(); } catch { /* not ready */ } };
    const musicStartup = music ? setTimeout(applyStatus, 8000) : undefined;
    const musicRefresh = music ? setInterval(applyStatus, 600_000) : undefined;
    diagnosticDeps.set(cfg.gateway.accountId, {cfg,db,gateway,mcp,presence,proactive:proactiveEngine,searchReady:Boolean(search),
      readerReady:Boolean(reader),documentsReady:Boolean(documentDelivery),weatherReady:Boolean(weather),research,notion,notionReminders,email});
    const agent = new Agent({
      db,
      cfg,
      gateway,
      llm: llm,
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
      sendImage,
      muninnMemory,
      feishuTools,
      email,
      recall: new RecallTools({ provider, db, ownerIds: (cfg.tools.ownerIds ?? cfg.admins).map(String) }),
      music: music ? { toolsFor: (m: any) => [...music.toolsFor(m), ...(voiceCall?.toolsFor(m) ?? [])] } : null,
      crossPlatform,
      familyDesk,
      linkedTranscript: linked,
      runFamilyTurn,
      familyWorld: sharedWorld,
      familyModel,
      familyRoom: familyRoom ? "family" : undefined,
      personaDirectory: baseDir,
      legacyWorldAccess: primary,
    });
    sharedWorld ??= agent.familyWorld();

    // 日报
    const reportEngine = primary ? new ReportEngine(db, cfg.reports, cfg.timezone, gateway, llm) : null;
    if (reportEngine) {
      agent.setReportEngine(reportEngine);
      gateway.onEvent(ev => {
        if (ev.kind === "message" && ev.message.groupId && cfg.groups.allowlist.includes(ev.message.groupId)) {
          reportEngine.noteKnownGroup(ev.message.groupId);
        }
      });
    }
    return { gateway, agent, reportEngine, proactiveEngine, presence, notionReminders, musicStartup, musicRefresh };
  }
  const runtimes = accounts.map((account, index) => createAccountRuntime(account, index === 0));
  const primary = runtimes[0]!;

  // MCP 后台连接（失败不阻塞主流程）
  const mcpStartup = mcp.start().then(() => mcpAdmin?.restore())
    .catch(e => log.warn("MCP 启动失败:", (e as Error).message));

  // 面板
  const panel = new StatusPanel({ cfg, db, gateway: primary.gateway, mcp, reportEngine: primary.reportEngine,
    startedAt, modelSwitcher, proactiveEngine: primary.proactiveEngine, presence: primary.presence, diagnostics, notion,
    notionReminders: primary.notionReminders, accounts: routeAccounts,
    mcpAdmin: mcpAdmin ? createMcpAdminHandler(mcpAdmin, cfg.web.token) : undefined,
    family: familyDesk && familyRoom ? {
      desk: familyDesk, room: familyRoom,
      allowedOrigins: (process.env.ANTEROS_IDE_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean),
      destinations: crossPlatform ? () => crossPlatform.consoleDestinations() : undefined,
      send: crossPlatform ? input => crossPlatform.sendFromConsole(input) : undefined,
    } : undefined });
  panel.start();

  for (const runtime of runtimes) {
    runtime.agent.attach();
    runtime.gateway.start();
    runtime.reportEngine?.start();
    runtime.proactiveEngine.start();
    runtime.notionReminders?.start();
  }

  const messageRetention = new MessageRetention({ db, memory, config: cfg.memory, timezone: cfg.timezone });
  messageRetention.start();

  familyDesk?.start();

  // 优雅退出
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`收到 ${signal}，正在退出…`);
    try {
      sharedWorld?.life.stop();
      await familyDesk?.close();
      for (const runtime of runtimes) {
        clearTimeout(runtime.musicStartup);
        clearInterval(runtime.musicRefresh);
        runtime.reportEngine?.stop();
        await runtime.proactiveEngine.stop();
        await runtime.notionReminders?.stop();
      }
      await messageRetention.stop();
      memory?.stop();
      await panel.stop();
      await Promise.all(runtimes.map(runtime => runtime.gateway.stop()));
      await mcpAdmin?.stop();
      await mcpStartup;
      await mcp.stop();
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
