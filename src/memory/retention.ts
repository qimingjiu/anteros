import type { AppConfig } from "../config.js";
import type { Database } from "../db/index.js";
import { zonedToUtc } from "../report/index.js";
import { localTimeParts, logger } from "../util/logger.js";

const log = logger("memory");

interface RetentionOptions {
  db: Database;
  memory?: { prepareForMessagePurge?(cutoffIso: string): Promise<void> } | null;
  config: AppConfig["memory"];
  timezone: string;
  now?: () => number;
}

/** Preserve topic summaries before deleting originals, with restart-safe calendar scheduling. */
export class MessageRetention {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(private readonly options: RetentionOptions) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const daily = this.options.config.rawDailyCleanupTime;
    if (!daily && this.options.config.rawRetentionDays <= 0) return;
    this.timer = setInterval(() => {
      void this.tick().catch(error => log.error("消息清理失败，保留原文等待重试", error));
    }, daily ? 60_000 : 6 * 3600_000);
    this.timer.unref?.();
    if (daily) {
      log.info(`原文清理已启用：每天 ${daily} (${this.options.timezone}) 清理前一天及更早记录，保留摘要和记忆`);
      void this.tick().catch(error => log.error("消息清理失败，保留原文等待重试", error));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      await this.running;
    } catch (error) {
      log.warn("退出时原文清理未完成，继续关闭其他模块", error);
    }
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run(): Promise<void> {
    const { db, config, memory, timezone } = this.options;
    const now = this.options.now?.() ?? Date.now();
    let cutoff: string;
    if (config.rawDailyCleanupTime) {
      const local = localTimeParts(new Date(now), timezone);
      const [hour, minute] = config.rawDailyCleanupTime.split(":").map(Number);
      let date = local.date;
      if (local.hour * 60 + local.minute < hour! * 60 + minute!) {
        // Catch up the last scheduled day if the service was down at the scheduled time.
        const previous = new Date(`${date}T12:00:00Z`);
        previous.setUTCDate(previous.getUTCDate() - 1);
        date = previous.toISOString().slice(0, 10);
      }
      cutoff = zonedToUtc(`${date}T00:00:00`, timezone);
      const completed = db.kvGet("raw_messages_before");
      if (completed && completed >= cutoff) return;
    } else {
      if (config.rawRetentionDays <= 0) return;
      cutoff = new Date(now - config.rawRetentionDays * 86400_000).toISOString();
    }
    const resumeExpiredMessages = db.beginMessagePurge(cutoff);
    try {
      await memory?.prepareForMessagePurge?.(cutoff);
      if (this.stopped) return;
      const deleted = db.purgeMessagesBefore(cutoff);
      log.info(`原文清理完成：删除 ${deleted} 条 ${cutoff} 之前的消息，摘要和记忆已保留`);
    } finally {
      resumeExpiredMessages();
    }
  }
}
