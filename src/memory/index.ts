import type { AppConfig } from "../config.js";
import type { Database, DBRow_Message, DBRow_Memory, DBRow_Topic } from "../db/index.js";
import type { GatewayEvent, MemoryFact, MessageRecord } from "../types.js";
import type { LLMClient } from "../llm/index.js";
import { logger } from "../util/logger.js";

const log = logger("memory");

export interface MemoryProvider {
  ingest(m: MessageRecord): void;
  handleRecall(ev: Extract<GatewayEvent, { kind: "recall" }>): void;
  retrieve(accountId: string, groupId: string, keywords: string[], limit: number): DBRow_Memory[];
  recentContextSummary(accountId: string, groupId: string, limit: number): string;
  revise(accountId: string, groupId: string, memoryId: number, action: "confirm" | "invalidate"): boolean;
  forget(accountId: string, groupId: string, memoryId: number): boolean;
  /** 话题维护：关闭超时的开放话题并提取事实 */
  tick(): Promise<void>;
}

interface CandidateFact {
  subject?: string; // 涉及成员名或“大家/该群”
  kind: "fact" | "plan" | "convention" | "joke";
  statement: string;
  confidence: number;
}

/** 规则式提取（无模型时的兜底）：识别少量高置信模式 */
export function ruleExtract(text: string, narratorName: string): CandidateFact[] {
  const out: CandidateFact[] = [];
  const trimmed = text.trim();
  if (trimmed.length < 4 || trimmed.length > 200) return out;
  const patterns: { re: RegExp; kind: CandidateFact["kind"]; confidence: number }[] = [
    { re: /^(我|本人|咱)(已经|已)报名/, kind: "fact", confidence: 0.6 },
    { re: /^(我|本人|咱)(准备|打算|计划|决定|想要?)/, kind: "plan", confidence: 0.5 },
    { re: /(约定|说好|定了|规矩|群规)[::，, ]?.{2,60}/, kind: "convention", confidence: 0.55 },
    { re: /^(明天|后天|下周|周六|周日|周[一二三四五六])[^，。]{2,50}(考试|开会|上线|发布|截止|答辩|面试)/, kind: "plan", confidence: 0.5 },
  ];
  for (const p of patterns) {
    if (p.re.test(trimmed)) {
      out.push({ subject: narratorName, kind: p.kind, statement: trimmed, confidence: p.confidence });
      break;
    }
  }
  return out;
}

export class SqliteMemory implements MemoryProvider {
  private db: Database;
  private cfg: AppConfig["memory"];
  private llm: LLMClient | null;
  private summaryModel: string | undefined;
  /** topicId → 最后一条消息时间（毫秒），用于话题切分 */
  private lastActivity = new Map<number, number>();
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(db: Database, cfg: AppConfig["memory"], llm: LLMClient | null, summaryModel?: string) {
    this.db = db;
    this.cfg = cfg;
    this.llm = cfg.extraction === "llm" ? llm : null;
    this.summaryModel = summaryModel;
    // 启动时恢复开放话题的活动时间
    void this.restoreOpenTopics();
  }

  private async restoreOpenTopics(): Promise<void> {
    const stale = this.db.staleOpenTopics(new Date(Date.now() - this.cfg.topicGapMinutes * 60_000).toISOString());
    for (const t of stale) {
      // 启动恢复：先把它们的活动时间设为 started_at，交给 tick 统一关闭提取
      this.lastActivity.set(t.id, new Date(t.started_at).getTime());
    }
    log.info(`恢复 ${stale.length} 个未关闭话题，待处理`);
  }

  start(): void {
    this.tickTimer = setInterval(() => void this.tick().catch((e) => log.error("tick 异常", e)), 60_000);
    this.tickTimer.unref?.();
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  ingest(m: MessageRecord): void {
    if (!this.cfg.enabled) return;
    if (this.db.isUserBlocked(m.accountId, m.senderId)) return;
    if (!m.groupId) return; // 群记忆只处理群消息
    if (m.origin === "backfill") {
      // 补取消息不新开话题，仅当存在开放话题时计入
      const open = this.db.openTopics(m.accountId, m.groupId);
      const t = open[open.length - 1];
      if (t) {
        const tEnd = t.started_at;
        if (m.sentAt >= tEnd) this.db.appendTopicMessage(t.id, m.messageId);
      }
      return;
    }

    const openTopics = this.db.openTopics(m.accountId, m.groupId);
    const last = openTopics[openTopics.length - 1];
    const gapMs = this.cfg.topicGapMinutes * 60_000;
    let topicId: number;
    if (last) {
      // 以话题最后活动时间判断是否需要切分（会话内用内存 map，重启后退回话题开始时间）
      const lastAct = this.lastActivity.get(last.id);
      const lastMsgTime = lastAct ?? new Date(last.started_at).getTime();
      if (new Date(m.sentAt).getTime() - lastMsgTime > gapMs) {
        // 关闭旧话题（异步提取摘要/事实）
        this.db.closeTopic(last.id, m.sentAt);
        void this.finalizeTopic(last.id).catch((e) => log.error("话题收尾异常", e));
        topicId = this.db.upsertOpenTopic(m.accountId, m.groupId, { id: m.messageId, sentAt: m.sentAt });
      } else {
        topicId = last.id;
      }
    } else {
      topicId = this.db.upsertOpenTopic(m.accountId, m.groupId, { id: m.messageId, sentAt: m.sentAt });
    }
    this.db.appendTopicMessage(topicId, m.messageId);
    this.lastActivity.set(topicId, new Date(m.sentAt).getTime());
  }

  handleRecall(ev: Extract<GatewayEvent, { kind: "recall" }>): void {
    if (!ev.groupId) return;
    // 撤回的消息从开放话题计数中剔除的影响有限（计数用于统计），这里仅记录
    log.debug(`撤回: 群 ${ev.groupId} 消息 ${ev.messageId}`);
  }

  /** 话题关闭后：生成摘要 + 提取事实 */
  private async finalizeTopic(topicId: number): Promise<void> {
    const t = this.db.topicById(topicId);
    if (!t) return;
    const endIso = new Date().toISOString();
    const msgs = this.db.messagesInRange(t.group_id, t.started_at, endIso);
    const relevant = msgs.filter((m) => m.account_id === t.account_id && m.sent_at >= t.started_at && m.sent_at <= endIso
      && m.status === "active" && !this.db.isUserBlocked(m.account_id, m.sender_id));
    if (relevant.length === 0) {
      this.db.closeTopic(topicId, endIso);
      return;
    }

    // 参与者统计
    const counts = new Map<string, { name: string; count: number }>();
    for (const m of relevant) {
      const cur = counts.get(m.sender_id) ?? { name: m.sender_name, count: 0 };
      cur.count++;
      counts.set(m.sender_id, cur);
    }
    const participants = [...counts.entries()]
      .map(([id, v]) => ({ id, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    let summary = "";
    if (this.llm && relevant.length >= 3) {
      summary = await this.summarizeTopic(relevant);
    } else {
      const names = participants.slice(0, 5).map((p) => `${p.name}(${p.count})`).join("、");
      const sample = relevant.slice(-5).map((m) => `${m.sender_name}: ${m.text_content.slice(0, 50)}`).join(" / ");
      summary = `${relevant.length} 条消息；主要参与者: ${names}；最近内容: ${sample}`;
    }
    if (relevant.some(m => this.db.isUserBlocked(m.account_id, m.sender_id))) return;
    this.db.setTopicSummary(topicId, summary, participants);
    this.db.closeTopic(topicId, endIso);

    // 事实提取
    await this.extractFacts(t, relevant);
    this.lastActivity.delete(topicId);
  }

  private async summarizeTopic(msgs: DBRow_Message[]): Promise<string> {
    if (!this.llm) return "";
    const transcript = msgs
      .slice(-60)
      .map((m) => `${m.sent_at.slice(5, 16).replace("T", " ")} ${m.sender_name}: ${m.text_content.slice(0, 120)}`)
      .join("\n");
    try {
      const r = await this.llm.chat(
        [
          {
            role: "system",
            content:
              "你是群聊记录整理助手。用不超过 120 字概括这段对话的主题、参与者和结论/未决事项。不要编造未出现的信息。直接输出概述，不要前缀。",
          },
          { role: "user", content: transcript },
        ],
        { model: this.summaryModel },
      );
      return r.content.trim().slice(0, 300);
    } catch (e) {
      log.warn("话题摘要失败:", (e as Error).message);
      return "";
    }
  }

  private async extractFacts(t: DBRow_Topic, msgs: DBRow_Message[]): Promise<void> {
    if (!msgs.length || msgs.some(m => this.db.isUserBlocked(m.account_id, m.sender_id))) return;
    const candidates: (MemoryFact & { accountId: string })[] = [];
    const accountId = t.account_id;

    if (this.llm) {
      const transcript = msgs
        .slice(-80)
        .map((m) => `[${m.sender_id}|${m.sender_name}] ${m.text_content.slice(0, 150)}`)
        .join("\n");
      try {
        const r = await this.llm.chat(
          [
            {
              role: "system",
              content:
                "从群聊记录中提取值得记住的事实。只提取明确表达的信息：某人陈述的事实、计划/约定、群规。" +
                "注意区分：谁说的（narrator）、关于谁（subject）、是事实还是计划还是玩笑。" +
                '输出 JSON 数组，每项 {"subject":"成员名或空","kind":"fact|plan|convention|joke","statement":"用第三人称简述","confidence":0-1}，' +
                `最多 ${this.cfg.maxFactsPerTopic} 条。没有值得记的就输出 []。只输出 JSON。`,
            },
            { role: "user", content: transcript },
          ],
          { model: this.summaryModel, temperature: 0.2 },
        );
        const parsed = safeParseFacts(r.content);
        for (const c of parsed.slice(0, this.cfg.maxFactsPerTopic)) {
          if (!c.statement) continue;
          const subjectMsg = c.subject
            ? msgs.find((mm) => mm.sender_name === c.subject || mm.sender_id === c.subject)
            : undefined;
          const narrator = subjectMsg ?? msgs[0]!;
          candidates.push({
            accountId,
            groupId: t.group_id,
            kind: c.kind,
            subjectUserId: subjectMsg?.sender_id,
            subjectName: c.subject || subjectMsg?.sender_name,
            statement: c.statement.slice(0, 300),
            narratorId: narrator.sender_id,
            narratorName: narrator.sender_name,
            sourceMessageId: narrator.message_id,
            sourceSentAt: narrator.sent_at,
            status: "candidate",
            confidence: Math.min(1, Math.max(0, c.confidence ?? 0.5)),
          });
        }
      } catch (e) {
        log.warn("LLM 事实提取失败，退回规则:", (e as Error).message);
      }
    }

    if (candidates.length === 0 && this.cfg.extraction !== "off") {
      // 规则兜底
      for (const m of msgs.slice(-40)) {
        for (const c of ruleExtract(m.text_content, m.sender_name)) {
          candidates.push({
            accountId,
            groupId: t.group_id,
            kind: c.kind,
            subjectUserId: m.sender_id,
            subjectName: m.sender_name,
            statement: c.statement,
            narratorId: m.sender_id,
            narratorName: m.sender_name,
            sourceMessageId: m.message_id,
            sourceSentAt: m.sent_at,
            status: "candidate",
            confidence: c.confidence,
          });
        }
        if (candidates.length >= this.cfg.maxFactsPerTopic) break;
      }
    }

    for (const c of candidates) {
      if (msgs.some(m => this.db.isUserBlocked(m.account_id, m.sender_id))) return;
      // 幂等：同群同句不重复
      if (this.db.findMemoryByStatement(accountId, t.group_id, c.statement)) continue;
      const id = this.db.insertMemory(c);
      log.info(`新增候选记忆 #${id}: [${c.kind}]`);
    }
  }

  async tick(): Promise<void> {
    const gapMs = this.cfg.topicGapMinutes * 60_000;
    const now = Date.now();
    for (const [topicId, lastAct] of this.lastActivity) {
      if (now - lastAct > gapMs) {
        this.lastActivity.delete(topicId);
        this.db.closeTopic(topicId, new Date(now).toISOString());
        void this.finalizeTopic(topicId).catch((e) => log.error("话题收尾异常", e));
      }
    }
  }

  retrieve(accountId: string, groupId: string, keywords: string[], limit: number): DBRow_Memory[] {
    if (keywords.length > 0) {
      const hits = this.db.searchMemories(accountId, groupId, keywords, limit);
      if (hits.length > 0) return hits;
    }
    return this.db.recentMemories(accountId, groupId, limit);
  }

  recentContextSummary(accountId: string, groupId: string, limit: number): string {
    const topics = this.db.recentTopics(accountId, groupId, limit).filter((t) => t.summary);
    if (topics.length === 0) return "";
    return topics
      .map((t) => `[${t.started_at.slice(5, 16).replace("T", " ")}] ${t.summary}`)
      .reverse()
      .join("\n");
  }

  revise(accountId: string, groupId: string, memoryId: number, action: "confirm" | "invalidate"): boolean {
    const m = this.db.memoryById(memoryId);
    if (!m || m.account_id !== accountId || m.group_id !== groupId) return false;
    return this.db.reviseMemory(memoryId, action === "confirm" ? "confirmed" : "invalid");
  }

  forget(accountId: string, groupId: string, memoryId: number): boolean {
    const m = this.db.memoryById(memoryId);
    if (!m || m.account_id !== accountId || m.group_id !== groupId) return false;
    return this.db.reviseMemory(memoryId, "invalid");
  }
}

function safeParseFacts(text: string): CandidateFact[] {
  try {
    const jsonText = text.includes("[") ? text.slice(text.indexOf("["), text.lastIndexOf("]") + 1) : "[]";
    const arr = JSON.parse(jsonText) as Record<string, unknown>[];
    return arr.map((o) => ({
      subject: typeof o.subject === "string" ? o.subject : undefined,
      kind: (["fact", "plan", "convention", "joke"].includes(String(o.kind)) ? o.kind : "fact") as CandidateFact["kind"],
      statement: String(o.statement ?? "").trim(),
      confidence: Number(o.confidence ?? 0.5),
    }));
  } catch {
    return [];
  }
}
