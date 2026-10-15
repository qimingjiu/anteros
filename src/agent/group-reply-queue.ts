interface ReplyJob {
  priority: number;
  interruptible: boolean;
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<void>;
  complete: () => void;
}

interface GroupQueue {
  jobs: ReplyJob[];
  active?: ReplyJob;
  drained: Promise<void>;
  finish: () => void;
}

/** 召唤优先；取消的环境工作即使稍后返回，也由 signal 阻止继续执行或发送。 */
export class GroupReplyQueue {
  private groups = new Map<string, GroupQueue>();

  enqueue(groupId: string, priority: number, interruptible: boolean, run: ReplyJob["run"]): Promise<void> {
    let queue = this.groups.get(groupId);
    const created = !queue;
    if (!queue) {
      let finish!: () => void;
      const drained = new Promise<void>(resolve => { finish = resolve; });
      queue = { jobs: [], drained, finish };
      this.groups.set(groupId, queue);
    }
    const current = queue;
    const accepted = new Promise<void>(complete => {
      current.jobs.push({ priority, interruptible, controller: new AbortController(), run, complete });
    });
    if (priority > 0) {
      if (current.active?.interruptible && current.active.priority < priority) current.active.controller.abort();
      current.jobs = current.jobs.filter(job => {
        if (job.interruptible && job.priority < priority) { job.controller.abort(); job.complete(); return false; }
        return true;
      });
    }
    if (created) void this.drain(groupId, current);
    return accepted;
  }

  draining(groupId: string): Promise<void> | undefined { return this.groups.get(groupId)?.drained; }

  private async drain(groupId: string, queue: GroupQueue): Promise<void> {
    // 同一事件循环内到达的召唤先于环境快照开始。
    await Promise.resolve();
    while (queue.jobs.length) {
      queue.jobs.sort((a, b) => b.priority - a.priority);
      const job = queue.jobs.shift()!;
      queue.active = job;
      let onAbort!: () => void;
      const cancelled = new Promise<void>(resolve => { onAbort = resolve; });
      job.controller.signal.addEventListener("abort", onAbort, { once: true });
      try {
        await Promise.race([job.run(job.controller.signal), cancelled]);
      } catch {
        // 回复流程负责报告错误；一项失败不能卡住后续召唤。
      } finally {
        job.controller.signal.removeEventListener("abort", onAbort);
        queue.active = undefined;
        job.complete();
      }
    }
    this.groups.delete(groupId);
    queue.finish();
  }
}
