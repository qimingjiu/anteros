import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Database, DBRow_Delivery, DBRow_Report } from "../db/index.js";
import type { Gateway } from "../gateway/index.js";
import type { LLMClient } from "../llm/index.js";
import { logger, localTimeParts, localDateStr } from "../util/logger.js";
import { atomicWriteFile, cronMatches, parseCron } from "../util/misc.js";

const log = logger("report");

export interface GenerateResult {
  ok: boolean;
  error?: string;
  reportKey?: string;
  filePath?: string;
  rangeStart?: string;
  rangeEnd?: string;
  messageCount?: number;
}

export class ReportEngine {
  private db: Database;
  private cfg: AppConfig["reports"];
  private tz: string;
  private gateway: Gateway;
  private llm: LLMClient | null;
  private cron: ReturnType<typeof parseCron> | null = null;
  private lastCronFire = "";
  private timer: NodeJS.Timeout | null = null;
  private deliveryTimer: NodeJS.Timeout | null = null;

  constructor(db: Database, cfg: AppConfig["reports"], tz: string, gateway: Gateway, llm: LLMClient | null) {
    this.db = db;
    this.cfg = cfg;
    this.tz = tz;
    this.gateway = gateway;
    this.llm = llm;
    if (cfg.schedule) {
      try {
        this.cron = parseCron(cfg.schedule);
      } catch (e) {
        log.error("日报 cron 表达式无效:", (e as Error).message);
      }
    }
  }

  start(): void {
    if (!this.cfg.enabled) return;
    this.timer = setInterval(() => this.cronTick(), 20_000);
    this.timer.unref?.();
    this.deliveryTimer = setInterval(() => this.deliveryTick(), 30_000);
    this.deliveryTimer.unref?.();
    // 启动时立即执行一次投递检查，恢复中断的投递
    setTimeout(() => this.deliveryTick(), 3000);
    log.info(`日报模块已启动: schedule=${this.cfg.schedule} period=${this.cfg.period}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
  }

  targetGroups(): string[] {
    // 显式配置了日报群就用配置；否则用 known_groups（Agent 侧记录的启用群）
    if (this.cfg.groups.length > 0) return this.cfg.groups;
    return this.gatewayGroups();
  }

  private gatewayGroups(): string[] {
    // 日报群未显式配置时，用群白名单（从 config 传入会更好，但避免循环依赖，从 kv 读取 agent 侧写入的群列表）
    const raw = this.db.kvGet("known_groups");
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  noteKnownGroup(groupId: string): void {
    const groups = this.gatewayGroups();
    if (!groups.includes(groupId)) {
      groups.push(groupId);
      this.db.kvSet("known_groups", JSON.stringify(groups));
    }
  }

  // ---------- 调度 ----------

  private cronTick(): void {
    if (!this.cron) return;
    const now = new Date();
    const parts = localTimeParts(now, this.tz);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: this.tz, weekday: "short" }).format(now);
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday as "Sun"] ?? 0;
    if (!cronMatches(this.cron, { minute: parts.minute, hour: parts.hour, day: Number(parts.date.split("-")[2]), month: Number(parts.date.split("-")[1]), weekday: wd })) {
      return;
    }
    // 同一分钟内只触发一次
    const fireKey = `${parts.date} ${parts.hour}:${parts.minute}`;
    if (fireKey === this.lastCronFire) return;
    this.lastCronFire = fireKey;

    // 防止上次还没跑完（进程重启后 lastCronFire 丢失 → 靠 reportKey 幂等）
    const date = this.cfg.period === "full_day" ? shiftDate(parts.date, -1) : parts.date;
    void this.runScheduled(date).catch((e) => log.error("定时日报异常", e));
  }

  private async runScheduled(date: string): Promise<void> {
    const groups = this.targetGroups();
    if (groups.length === 0) {
      log.info("定时日报: 没有目标群，跳过");
      return;
    }
    for (const g of groups) {
      const reportKey = reportKeyOf("", g, date, this.cfg.period);
      const existing = this.db.reportByKey(reportKey);
      if (existing && existing.status === "generated") continue; // 已生成，幂等
      try {
        await this.generateReport("", g, date, this.cfg.period);
      } catch (e) {
        log.error(`群 ${g} 日报生成失败:`, (e as Error).message);
      }
    }
  }

  // ---------- 时间范围 ----------

  private rangeFor(date: string, period: "today_until_run" | "full_day", now?: Date): { start: string; end: string } {
    const nowD = now ?? new Date();
    const start = zonedToUtc(`${date}T00:00:00`, this.tz);
    if (period === "full_day") {
      const boundary = zonedToUtc(`${shiftDate(date, 1)}T00:00:00`, this.tz);
      // 过去的日期取完整自然日；今天还没结束则只覆盖到现在
      const end = new Date(boundary).getTime() <= nowD.getTime() ? boundary : nowD.toISOString();
      return { start, end };
    }
    return { start, end: nowD.toISOString() };
  }

  // ---------- 生成 ----------

  /** /日报 指令入口。date 空 = 今天（today_until_run）；指定日期 = 该日全天。 */
  async generateOnDemand(accountId: string, groupId: string, date?: string): Promise<GenerateResult> {
    let d = date;
    let period: "today_until_run" | "full_day" = this.cfg.period;
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "日期格式应为 YYYY-MM-DD" };
      d = date;
      period = "full_day";
    }
    if (!d) d = localDateStr(new Date(), this.tz);
    return this.generateReport(accountId, groupId, d, period);
  }

  async generateReport(accountId: string, groupId: string, date: string, period: "today_until_run" | "full_day"): Promise<GenerateResult> {
    const { start, end } = this.rangeFor(date, period);
    const reportKey = reportKeyOf(accountId, groupId, date, period);
    const now = new Date().toISOString();

    const existing = this.db.reportByKey(reportKey);
    if (existing?.status === "generated" && existing.file_path && fs.existsSync(existing.file_path)) {
      return {
        ok: true,
        reportKey,
        filePath: existing.file_path,
        rangeStart: existing.range_start,
        rangeEnd: existing.range_end,
        messageCount: existing.message_count,
      };
    }

    const messages = this.db.messagesInRange(groupId, start, end);
    const messageCount = messages.length;

    this.db.upsertReport({
      reportKey,
      accountId,
      groupId,
      reportDate: date,
      period,
      rangeStart: start,
      rangeEnd: end,
      status: messageCount === 0 ? "generated" : "generating",
      messageCount,
    });

    const md = await this.buildMarkdown(accountId, groupId, date, period, start, end, messages, messageCount);

    const fileName = `群聊日报_${groupId}_${date}.md`;
    const outDir = path.resolve(this.cfg.outputDir);
    const filePath = path.join(outDir, fileName);
    atomicWriteFile(filePath, md);

    this.db.upsertReport({
      reportKey,
      accountId,
      groupId,
      reportDate: date,
      period,
      rangeStart: start,
      rangeEnd: end,
      status: "generated",
      filePath,
      messageCount,
    });

    // 为配置的收件人建投递任务
    for (const r of this.cfg.recipientIds) {
      this.enqueueDelivery(reportKey, r);
    }

    log.info(`日报已生成: ${filePath} (${messageCount} 条消息)`);
    return { ok: true, reportKey, filePath, rangeStart: start, rangeEnd: end, messageCount };
  }

  private async buildMarkdown(
    accountId: string,
    groupId: string,
    date: string,
    period: "today_until_run" | "full_day",
    start: string,
    end: string,
    messages: import("../db/index.js").DBRow_Message[],
    messageCount: number,
  ): Promise<string> {
    const now = new Date().toISOString();
    const stats = this.db.senderStatsInRange(groupId, start, end);
    const topics = this.db.topicsInRange(accountId, groupId, start, end);
    const links = this.db.linksInRange(groupId, start, end);
    const memories = this.db.memoriesInTimeRange(accountId, groupId, start, end);
    const downtimes = this.db.downtimeInRange(accountId, start, end);
    const downtimeMin = downtimes.reduce((acc, d) => {
      const s = Math.max(new Date(d.started_at).getTime(), new Date(start).getTime());
      const e = Math.min(d.ended_at ? new Date(d.ended_at).getTime() : Date.now(), new Date(end).getTime());
      return acc + Math.max(0, Math.round((e - s) / 60000));
    }, 0);

    const L: string[] = [];
    L.push(`# 群聊日报 · 群 ${groupId} · ${date}`);
    L.push("");
    L.push(`> 生成时间：${formatLocal(now, this.tz)}（${this.tz}）  `);
    L.push(`> 数据范围：${formatLocal(start, this.tz)} ~ ${formatLocal(end, this.tz)}  `);
    L.push(`> 消息 ${messageCount} 条，${stats.length} 位成员发言${downtimes.length > 0 ? `；采集中断 ${downtimes.length} 次（约 ${downtimeMin} 分钟，该时段消息可能缺失）` : ""}`);
    L.push("");

    if (messageCount === 0) {
      L.push("本时段内没有记录到消息。");
      L.push("");
      L.push("---");
      L.push(`*由机器人自动生成于 ${formatLocal(now, this.tz)}；统计来自本地消息库。*`);
      return L.join("\n");
    }

    // 整体概述（可选 LLM）
    const overview = await this.buildOverview(topics, messageCount);
    if (overview) {
      L.push("## 整体概述");
      L.push("");
      L.push(overview);
      L.push("");
    }

    // 今日话题
    if (topics.length > 0) {
      L.push("## 今日话题");
      L.push("");
      for (const t of topics) {
        const part = t.participants ? (JSON.parse(t.participants) as { name: string; count: number }[]) : [];
        L.push(`### ${t.started_at.slice(11, 16)} 起（${t.message_count} 条消息）`);
        if (t.summary) L.push(t.summary);
        else {
          const sample = messages.filter((m) => m.sent_at >= t.started_at).slice(0, 5);
          L.push(sample.map((m) => `- ${m.sender_name}: ${m.text_content.slice(0, 80)}`).join("\n"));
        }
        if (part.length > 0) {
          L.push(`参与者：${part.slice(0, 8).map((p) => `${p.name}(${p.count})`).join("、")}`);
        }
        L.push(`原始消息：本地记录 ${t.first_message_id ?? "?"} ~ ${t.last_message_id ?? "?"}`);
        L.push("");
      }
    }

    // 资源分享
    if (links.length > 0) {
      L.push("## 资源分享");
      L.push("");
      const seen = new Set<string>();
      for (const l of links) {
        if (seen.has(l.url)) continue;
        seen.add(l.url);
        const note =
          l.status === "ok"
            ? l.title
              ? `${l.title}${l.summary ? ` — ${l.summary}` : ""}`
              : (l.summary ?? "")
            : `未能读取正文（${l.error ?? "未知原因"}）`;
        L.push(`- [${l.created_at.slice(11, 16)}] ${l.shared_by_name ?? "群成员"} 分享 <${l.url}>：${note}`);
      }
      L.push("");
    }

    // 约定与待办 / 事实 / 趣味
    const plans = memories.filter((m) => m.kind === "plan" || m.kind === "convention");
    const facts = memories.filter((m) => m.kind === "fact");
    const jokes = memories.filter((m) => m.kind === "joke");
    if (plans.length > 0) {
      L.push("## 约定与待办");
      L.push("");
      for (const m of plans) {
        L.push(`- [${m.status === "confirmed" ? "已确认" : m.status === "candidate" ? "待确认" : "已作废"}] ${m.statement}`);
        L.push(`  来源：${m.narrator_name ?? m.narrator_id} 说于 ${(m.source_sent_at ?? m.created_at).slice(0, 16).replace("T", " ")}（本地消息 ${m.source_message_id ?? "?"}）`);
      }
      L.push("");
    }
    if (facts.length > 0) {
      L.push("## 群内事实");
      L.push("");
      for (const m of facts.slice(0, 10)) {
        L.push(`- [${m.status === "confirmed" ? "已确认" : "候选"}] ${m.statement}（${m.narrator_name ?? m.narrator_id}）`);
      }
      L.push("");
    }
    if (jokes.length > 0) {
      L.push("## 趣味片段（保留语境，不是事实）");
      L.push("");
      for (const m of jokes.slice(0, 5)) L.push(`- ${m.statement}（${m.narrator_name ?? m.narrator_id}）`);
      L.push("");
    }

    // 成员活跃
    L.push("## 发言统计");
    L.push("");
    L.push("| 成员 | 消息数 |");
    L.push("| --- | --- |");
    for (const s of stats.slice(0, 15)) L.push(`| ${s.sender_name} | ${s.c} |`);
    if (stats.length > 15) L.push(`| ……共 ${stats.length} 位 | |`);
    L.push("");
    L.push("## 数据说明");
    L.push("");
    L.push("- 统计与发言数来自本地消息库；“某人说过”可按本地消息编号追溯，非 QQ 官方消息链接。");
    L.push("- 候选记忆未经本人确认，仅作参考。");
    L.push("- 本文件由机器人自动生成。");
    L.push("");
    L.push("---");
    L.push(`*reportKey: ${reportKeyOf(accountId, groupId, date, period)}*`);
    return L.join("\n");
  }

  private async buildOverview(topics: import("../db/index.js").DBRow_Topic[], messageCount: number): Promise<string> {
    if (!this.llm || topics.length === 0) return "";
    const summaries = topics
      .map((t) => `- [${t.started_at.slice(11, 16)}] ${t.summary ?? "(无摘要)"}`)
      .join("\n");
    try {
      const r = await this.llm.chat(
        [
          {
            role: "system",
            content:
              "根据一天的话题摘要写一段 100 字以内的日报概述：今天群里主要聊了什么、有什么结论或待办。不要编造摘要之外的信息，直接输出概述正文。",
          },
          { role: "user", content: `共 ${messageCount} 条消息，话题如下：\n${summaries}` },
        ],
        { temperature: 0.4 },
      );
      return r.content.trim().slice(0, 300);
    } catch (e) {
      log.warn("日报概述生成失败（跳过）:", (e as Error).message);
      return "";
    }
  }

  // ---------- 投递 ----------

  enqueueDelivery(reportKey: string, recipientId: string): void {
    const r = this.db.reportByKey(reportKey);
    if (!r || r.status !== "generated" || !r.file_path) {
      log.warn(`投递跳过：报告 ${reportKey} 未就绪`);
      return;
    }
    this.db.ensureDelivery(reportKey, recipientId);
  }

  private deliveryTick(): void {
    try {
      const pending = this.db.pendingDeliveries(this.cfg.maxDeliveryAttempts);
      for (const d of pending) {
        const report = this.db.reportByKey(d.report_key);
        if (!report?.file_path) continue;
        const taskKey = `report_delivery:${d.report_key}:${d.recipient_id}:a${d.attempts}`;
        const fileName = path.basename(report.file_path);
        const enq = this.gateway.enqueueSend({
          taskKey,
          kind: "report_file",
          conversationType: "private",
          targetId: d.recipient_id,
          payload: { kind: "file", filePath: report.file_path, fileName },
        });
        if (enq.reused) {
          const t = this.db.sendTaskById(enq.id);
          if (!t) continue;
          if (t.status === "confirmed") {
            this.db.updateDelivery(d.id, "confirmed");
            log.info(`日报投递成功: ${d.report_key} → ${d.recipient_id}`);
          } else if (t.status === "failed") {
            this.handleFailedDelivery(d);
          } else if (t.status === "unknown") {
            this.db.updateDelivery(d.id, "unknown", t.last_error ?? "发送结果不明");
            log.warn(`日报投递结果不明: ${d.report_key} → ${d.recipient_id}，不自动重试`);
          }
          // queued/in_flight → 等下一个 tick
        }
      }
      // 处理超时的重试间隔
      this.scheduleFailedRetries();
    } catch (e) {
      log.error("投递检查异常", e);
    }
  }

  private handleFailedDelivery(d: DBRow_Delivery): void {
    this.db.updateDelivery(d.id, "failed", undefined, true);
    // attempts 已 +1，若还没到上限且过了退避时间 → 重新排队
    if (d.attempts + 1 < this.cfg.maxDeliveryAttempts) {
      this.db.updateDelivery(d.id, "queued");
    } else {
      log.warn(`日报投递失败已达上限: ${d.report_key} → ${d.recipient_id}`);
    }
  }

  private scheduleFailedRetries(): void {
    const failed = this.db.db
      .prepare("SELECT * FROM deliveries WHERE status = 'failed' AND attempts < ?")
      .all(this.cfg.maxDeliveryAttempts) as unknown as DBRow_Delivery[];
    for (const d of failed) {
      const backoffMs = Math.min(30 * 60_000, d.attempts * 5 * 60_000);
      if (Date.now() - new Date(d.updated_at).getTime() > backoffMs) {
        this.db.updateDelivery(d.id, "queued");
      }
    }
  }

  retryDelivery(deliveryId: number): boolean {
    return this.db.retryDelivery(deliveryId);
  }

  statusText(): string {
    const reports = this.db.recentReports(10);
    if (reports.length === 0) return "还没有生成过日报。";
    const lines: string[] = ["最近日报："];
    for (const r of reports) {
      const deliveries = this.db
        .db.prepare("SELECT recipient_id, status, attempts FROM deliveries WHERE report_key = ?")
        .all(r.report_key) as { recipient_id: string; status: string; attempts: number }[];
      const dText = deliveries.length > 0 ? deliveries.map((d) => `${d.recipient_id}:${d.status}(${d.attempts})`).join(", ") : "无收件人";
      lines.push(`- ${r.report_date} 群${r.group_id} [${r.status}] ${r.message_count} 条消息 → ${dText}`);
    }
    return lines.join("\n");
  }
}

export function reportKeyOf(accountId: string, groupId: string, date: string, period: string): string {
  return `${accountId || "default"}:${groupId}:${date}:${period}`;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 把某时区的本地墙钟时间字符串转成 UTC ISO（迭代求偏移，处理 DST） */
export function zonedToUtc(localStr: string, tz: string): string {
  const target = Date.parse(`${localStr}Z`);
  if (Number.isNaN(target)) throw new Error(`无效的本地时间: ${localStr}`);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = localTimeParts(new Date(guess), tz);
    const wallMs = Date.parse(`${p.date}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}Z`);
    const diff = target - wallMs;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess).toISOString();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: tz, dateStyle: "short", timeStyle: "short", hour12: false }).format(new Date(iso));
}
