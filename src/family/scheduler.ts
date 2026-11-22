import { createHash } from "node:crypto";
import type { Database } from "../db/index.js";
import type { MessageRecord } from "../types.js";
import { nextOccurrence, type Schedule } from "./schedule.js";

export type JobKind = "task" | "diary" | "alarm" | "todo" | "web" | "notice";
export type TaskCondition = "task_completed" | "task_failed";
export type ExternalCondition = "signal" | "mcp_job_completed";
type NoticeTrigger = { event: TaskCondition; taskId?: string; once: boolean }
  | { event: ExternalCondition; name?: string; match?: Record<string, string>; once: boolean };
type JobState = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export interface JobScope { room: string; member: string; source: MessageRecord }
export interface Job {
  id: string;
  room: string;
  member: string;
  kind: JobKind;
  state: JobState;
  title: string;
  source: MessageRecord;
  sourceAt: string;
  dueAt: number | null;
  schedule?: Schedule;
  deadline?: string;
  destination?: string;
  url?: string;
  date?: string;
  trigger?: NoticeTrigger;
  checkpoint?: string;
  result?: string;
  digest?: string;
  artifactId?: string;
  inputIds?: string[];
  receipt?: string;
  revision: number;
}
type JobInput = Pick<Job, "kind" | "title" | "dueAt" | "schedule" | "destination" | "deadline" | "url" | "date" | "trigger" | "inputIds">;
export interface JobOutcome {
  result: string;
  artifactId?: string;
  digest?: string;
  quiet?: boolean;
}

export interface SchedulerOptions {
  run: (job: Job, signal: AbortSignal, lease: TaskLease) => Promise<JobOutcome>;
  notify: (job: Job, result: JobOutcome, key: string) => Promise<void>;
  allowed: (job: Job) => boolean;
  now: () => number;
}

export interface TaskLease {
  check(): void;
  checkpoint(text: string): void;
}

export class ConflictingFamilyEvent extends Error {}

export class DeskScheduler {
  private timer?: NodeJS.Timeout;
  private closed = false;
  private running = new Map<string, { job: Job; abort: AbortController; done: Promise<void> }>();
  private dispatching?: Promise<void>;

  constructor(private readonly db: Database, private readonly options: SchedulerOptions) {
    db.db.exec(`
      CREATE TABLE IF NOT EXISTS family_jobs (
        id TEXT PRIMARY KEY, room TEXT NOT NULL, member TEXT NOT NULL,
        kind TEXT NOT NULL, state TEXT NOT NULL, due_at INTEGER, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS family_jobs_scope ON family_jobs (room, member);
      CREATE INDEX IF NOT EXISTS family_jobs_due ON family_jobs (state, due_at);
      CREATE TABLE IF NOT EXISTS family_inbox (
        id TEXT PRIMARY KEY, room TEXT NOT NULL, member TEXT NOT NULL, job_id TEXT NOT NULL,
        result TEXT NOT NULL, artifact_id TEXT, created_at TEXT NOT NULL, read_at TEXT
      );
      CREATE INDEX IF NOT EXISTS family_inbox_scope ON family_inbox (room, member);
      CREATE TABLE IF NOT EXISTS family_notices (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, job TEXT NOT NULL, outcome TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS family_notice_state ON family_notices (state);
      CREATE TABLE IF NOT EXISTS family_external_events (
        room TEXT NOT NULL, event TEXT NOT NULL, id TEXT NOT NULL,
        payload TEXT NOT NULL, received_at TEXT NOT NULL,
        PRIMARY KEY(room, event, id)
      );
    `);
  }

  start(): void {
    if (this.timer || this.closed) return;
    const interrupted = this.db.db.prepare("SELECT body FROM family_jobs WHERE state = 'running'").all();
    for (const row of interrupted) {
      const job = JSON.parse(String(row.body)) as Job;
      job.state = job.kind === "task" ? "paused" : "queued";
      job.revision++;
      this.save(job);
    }
    this.db.db.exec("UPDATE family_notices SET state='queued' WHERE state='dispatching'");
    this.timer = setInterval(() => this.tick(), 500);
    this.timer.unref();
    this.tick();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const value of this.running.values()) value.abort.abort();
    await Promise.allSettled([...this.running.values()].map(value => value.done).concat(this.dispatching ?? []));
  }

  create(scope: JobScope, input: JobInput): ReturnType<DeskScheduler["summary"]> {
    const { source } = scope;
    const { dueAt: _dueAt, ...intent } = input;
    const id = createHash("sha256").update(JSON.stringify([scope.room, scope.member, source.eventKey, intent]))
      .digest("hex").slice(0, 24);
    const previous = this.get(id);
    if (previous) return this.summary(previous);
    const job: Job = {
      id, room: scope.room, member: scope.member, state: "queued", revision: 1,
      source: { ...source, segments: source.segments.filter(segment => segment.type === "text") },
      sourceAt: source.sentAt, ...input,
    };
    this.save(job);
    return this.summary(job);
  }

  list(scope: Pick<JobScope, "room" | "member">): ReturnType<DeskScheduler["summary"]>[] {
    return this.db.db.prepare("SELECT body FROM family_jobs WHERE room = ? AND member = ? ORDER BY rowid DESC LIMIT 100")
      .all(scope.room, scope.member).map(row => this.summary(JSON.parse(String(row.body)) as Job));
  }

  inbox(scope: Pick<JobScope, "room" | "member">, readId?: string): unknown {
    if (readId) this.db.db.prepare("UPDATE family_inbox SET read_at = ? WHERE room = ? AND member = ? AND id = ?")
      .run(new Date(this.options.now()).toISOString(), scope.room, scope.member, readId);
    return this.db.db.prepare(
      "SELECT id, job_id, result, artifact_id, created_at, read_at FROM family_inbox "
      + "WHERE room = ? AND member = ? ORDER BY rowid DESC LIMIT 30",
    ).all(scope.room, scope.member);
  }

  control(
    scope: JobScope, id: string,
    action: "pause" | "resume" | "cancel" | "handoff" | "checkpoint" | "complete" | "postpone",
    input: { member?: string; checkpoint?: string; at?: number; shareInputs?: (task: Job, member: string) => void },
  ): ReturnType<DeskScheduler["summary"]> {
    const job = this.get(id);
    if (!job || job.room !== scope.room || (job.member !== scope.member && action !== "handoff")) {
      throw new Error("当前成员没有这个任务或计划。");
    }
    if (job.state === "completed" || job.state === "cancelled") throw new Error("这项任务或计划已经结束。");
    if (action === "checkpoint") {
      if (job.kind !== "task" || !input.checkpoint) throw new Error("请填写任务检查点。");
      job.checkpoint = input.checkpoint;
    } else if (action === "pause") {
      job.state = "paused";
    } else if (action === "resume") {
      if (job.state !== "paused" && job.state !== "failed") throw new Error("只能恢复已暂停或失败的事项。");
      job.state = "queued";
    } else if (action === "handoff") {
      if (job.kind !== "task" || !input.member || input.member === job.member) throw new Error("请选择另一位成员接手任务。");
      input.shareInputs?.(job, input.member);
      job.checkpoint = [job.checkpoint, job.result, input.checkpoint].filter(Boolean).join("\n").slice(0, 8000);
      job.member = input.member;
      job.state = "queued";
      job.dueAt = this.options.now();
    } else if (action === "postpone") {
      if (job.kind === "task" || job.kind === "notice" || !input.at || input.at <= this.options.now()) {
        throw new Error("这个事项无法推迟到指定时间。");
      }
      job.dueAt = input.at;
      job.state = "queued";
    } else {
      if (action === "complete" && job.kind !== "todo") throw new Error("只有待办可以手动标记完成。");
      job.state = action === "complete" ? "completed" : "cancelled";
      job.dueAt = null;
    }
    if (action !== "checkpoint") {
      job.revision++;
      this.running.get(id)?.abort.abort();
    }
    this.save(job);
    return this.summary(job);
  }

  private get(id: string): Job | undefined {
    const row = this.db.db.prepare("SELECT body FROM family_jobs WHERE id = ?").get(id);
    return row ? JSON.parse(String(row.body)) as Job : undefined;
  }

  private save(job: Job): void {
    this.db.db.prepare(`
      INSERT INTO family_jobs (id, room, member, kind, state, due_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET member=excluded.member, state=excluded.state, due_at=excluded.due_at, body=excluded.body
    `).run(job.id, job.room, job.member, job.kind, job.state, job.dueAt, JSON.stringify(job));
  }

  private summary(job: Job) {
    const { room: _room, source: _source, revision: _revision, digest: _digest, ...visible } = job;
    return visible;
  }

  private queueNotice(key: string, job: Job, outcome: JobOutcome): void {
    this.db.db.prepare(
      "INSERT INTO family_inbox (id, room, member, job_id, result, artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
      + "ON CONFLICT(id) DO NOTHING",
    ).run(key, job.room, job.member, job.id, outcome.result,
      outcome.artifactId ?? null, new Date(this.options.now()).toISOString());
    this.db.db.prepare("INSERT INTO family_notices (id,state,job,outcome) VALUES (?,'queued',?,?) ON CONFLICT(id) DO NOTHING")
      .run(key, JSON.stringify(job), JSON.stringify(outcome));
  }

  private taskEvent(task: Job, event: TaskCondition): void {
    if (task.kind !== "task") return;
    const candidates = this.db.db.prepare(
      "SELECT body FROM family_jobs WHERE room=? AND member=? AND kind='notice' AND state='queued' ORDER BY rowid LIMIT 100",
    ).all(task.room, task.member);
    for (const row of candidates) {
      const notice = JSON.parse(String(row.body)) as Job;
      const trigger = notice.trigger;
      if (!trigger || (trigger.event !== "task_completed" && trigger.event !== "task_failed")
        || trigger.event !== event || (trigger.taskId && trigger.taskId !== task.id)
        || !this.options.allowed(notice)) continue;
      const result = notice.title + "\n任务 " + task.id + (event === "task_completed" ? " 已完成。" : " 执行失败。");
      this.queueNotice(["family", notice.id, task.id, task.revision, event].join(":"), notice, { result });
      if (trigger.once) {
        notice.state = "completed";
        notice.receipt = "条件已满足，已存入收件箱。";
        this.save(notice);
      }
    }
  }

  externalEvent(room: string, event: ExternalCondition, id: string, name: string, data: Record<string, string>) {
    const payload = JSON.stringify([name, Object.entries(data).sort(([a], [b]) => a.localeCompare(b))]);
    this.db.db.exec("SAVEPOINT family_external_event");
    let notified = 0;
    try {
      const row = this.db.db.prepare("SELECT payload FROM family_external_events WHERE room=? AND event=? AND id=?")
        .get(room, event, id);
      if (row) {
        if (row.payload !== payload) throw new ConflictingFamilyEvent("该事件 ID 已用于不同内容。");
        this.db.db.exec("RELEASE family_external_event");
        return { duplicate: true, notified };
      }
      this.db.db.prepare("INSERT INTO family_external_events VALUES (?,?,?,?,?)")
        .run(room, event, id, payload, new Date(this.options.now()).toISOString());
      const candidates = this.db.db.prepare(
        "SELECT body FROM family_jobs WHERE room=? AND kind='notice' AND state='queued' ORDER BY rowid",
      ).all(room);
      for (const candidate of candidates) {
        const notice = JSON.parse(String(candidate.body)) as Job;
        const trigger = notice.trigger;
        if (!trigger || (trigger.event !== "signal" && trigger.event !== "mcp_job_completed")
          || trigger.event !== event || (trigger.name && trigger.name !== name)
          || Object.entries(trigger.match ?? {}).some(([key, value]) => data[key] !== value)
          || !this.options.allowed(notice)) continue;
        const eventKey = createHash("sha256").update(id).digest("hex").slice(0, 32);
        const key = `family:${notice.id}:external:${event}:${eventKey}`;
        const description = event === "signal" ? `收到事件 ${name}。` : `MCP ${name} 已结束，状态 ${data.status ?? "未知"}。`;
        this.queueNotice(key, notice, { result: notice.title + "\n" + description });
        notified++;
        if (trigger.once) {
          notice.state = "completed";
          notice.receipt = "条件已满足，已存入收件箱。";
          this.save(notice);
        }
      }
      this.db.db.exec("RELEASE family_external_event");
    } catch (error) {
      this.db.db.exec("ROLLBACK TO family_external_event; RELEASE family_external_event");
      throw error;
    }
    this.pumpNotice();
    return { duplicate: false, notified };
  }

  private tick(): void {
    if (this.closed) return;
    this.pumpNotice();
    if (this.running.size >= 2) return;
    const candidates = this.db.db.prepare(
      "SELECT body FROM family_jobs WHERE state = 'queued' AND due_at IS NOT NULL AND due_at <= ? "
      + "ORDER BY due_at LIMIT 50",
    ).all(this.options.now());
    for (const row of candidates) {
      if (this.running.size >= 2) break;
      const job = JSON.parse(String(row.body)) as Job;
      if (this.running.has(job.id) || [...this.running.values()]
        .some(value => value.job.room === job.room && value.job.member === job.member)) continue;
      if (!this.options.allowed(job)) {
        job.state = "paused";
        job.receipt = "来源身份、房间或成员绑定已变更，请核对后恢复。";
        this.save(job);
        continue;
      }
      job.state = "running";
      this.save(job);
      const abort = new AbortController();
      const done = this.run(job, abort.signal).finally(() => this.running.delete(job.id));
      this.running.set(job.id, { job, abort, done });
    }
  }

  private async run(job: Job, signal: AbortSignal): Promise<void> {
    const runAt = job.dueAt;
    const key = ["family", job.id, runAt].join(":");
    try {
      const activeJob = () => {
        signal.throwIfAborted();
        const row = this.get(job.id);
        if (!row || row.revision !== job.revision || row.state !== "running" || !this.options.allowed(row)) {
          throw new Error("后台任务的执行授权已变更。");
        }
        return row;
      };
      const outcome = await this.options.run(job, signal, {
        check: () => { activeJob(); },
        checkpoint: text => {
          const row = activeJob();
          row.checkpoint = text;
          this.save(row);
        },
      });
      const current = this.get(job.id);
      if (!current || current.revision !== job.revision || signal.aborted) return;
      if (!this.options.allowed(current)) {
        current.state = "paused";
        current.receipt = "来源身份、房间或成员绑定已变更，请核对后恢复。";
        this.save(current);
        return;
      }
      current.result = outcome.result;
      current.artifactId = outcome.artifactId;
      if (outcome.digest !== undefined) current.digest = outcome.digest;
      current.dueAt = current.schedule ? nextOccurrence(current.schedule, this.options.now()) : null;
      current.state = current.kind === "todo" || current.dueAt !== null ? "queued" : "completed";
      current.receipt = outcome.quiet ? "无新内容" : "已存入收件箱";
      this.db.db.exec("SAVEPOINT family_complete");
      try {
        if (!outcome.quiet) {
          this.queueNotice(key, job, outcome);
        }
        this.save(current);
        this.taskEvent(current, "task_completed");
        this.db.db.exec("RELEASE family_complete");
      } catch (error) {
        this.db.db.exec("ROLLBACK TO family_complete; RELEASE family_complete");
        throw error;
      }
      this.pumpNotice();
    } catch {
      const current = this.get(job.id);
      if (!current || current.revision !== job.revision || signal.aborted) return;
      current.state = "failed";
      current.receipt = "事项执行失败，原始请求和已有产物已保留。";
      this.save(current);
      this.taskEvent(current, "task_failed");
      this.pumpNotice();
    }
  }

  private pumpNotice(): void {
    if (this.closed || this.dispatching) return;
    const row = this.db.db.prepare("SELECT id,job,outcome FROM family_notices WHERE state='queued' ORDER BY rowid LIMIT 1").get();
    if (!row) return;
    const id = String(row.id);
    this.db.db.prepare("UPDATE family_notices SET state='dispatching' WHERE id=?").run(id);
    const job = JSON.parse(String(row.job)) as Job;
    const outcome = JSON.parse(String(row.outcome)) as JobOutcome;
    this.dispatching = this.dispatchNotice(id, job, outcome).finally(() => { this.dispatching = undefined; });
  }

  private async dispatchNotice(id: string, job: Job, outcome: JobOutcome): Promise<void> {
    try {
      const active = this.get(job.id);
      if (!active || active.revision !== job.revision || !this.options.allowed(job)) {
        this.db.db.prepare("UPDATE family_notices SET state='blocked' WHERE id=?").run(id);
        return;
      }
      await this.options.notify(job, outcome, id);
      this.db.db.prepare("UPDATE family_notices SET state='submitted' WHERE id=?").run(id);
    } catch {
      const after = this.get(job.id);
      if (after?.revision === job.revision) {
        after.receipt = "收件箱已保存，平台投递未确认。";
        this.save(after);
      }
      this.db.db.prepare("UPDATE family_notices SET state='failed' WHERE id=?").run(id);
    }
  }
}
