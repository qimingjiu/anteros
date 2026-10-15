import fs from "node:fs/promises";
import path from "node:path";
import type { Database, DBRow_SendTask } from "../db/index.js";
import type { Gateway } from "../gateway/index.js";
import type { MessageRecord, SendStatus } from "../types.js";
import { stableHash, sleep } from "../util/misc.js";
import type { DocumentService, DocumentRequest, DocumentArtifact } from "./index.js";

interface DeliveryDeps {
  db: Database;
  gateway: Gateway;
  service: DocumentService;
  accountId: string;
  providerOutputDir?: string;
  waitTimeoutMs?: number;
}

export interface DocumentDeliveryResult {
  generated: true;
  filename: string;
  format: string;
  bytes: number;
  taskId: number;
  status: SendStatus;
  destination: "current" | "private";
  reused: boolean;
  detail: string;
}

const databaseOperations = new WeakMap<Database, Map<string, Promise<DocumentDeliveryResult>>>();

/** Creates files and submits only to the current chat or the real requester. */
export class DocumentDelivery {
  private operations: Map<string, Promise<DocumentDeliveryResult>>;
  constructor(private deps: DeliveryDeps) {
    this.operations = databaseOperations.get(deps.db) ?? new Map();
    databaseOperations.set(deps.db, this.operations);
  }

  async createAndSend(args: Record<string, unknown>, message: MessageRecord): Promise<DocumentDeliveryResult> {
    if (message.accountId !== this.deps.accountId || message.origin !== "live" || message.status !== "active") {
      throw new Error("文档只能由当前账号的有效实时消息请求");
    }
    const allowed = new Set(["format", "markdown", "title", "filename", "delivery"]);
    if (Object.keys(args).some(key => !allowed.has(key))) throw new Error("文档参数不接受文件路径、收件人或其他额外字段");
    if (typeof args.format !== "string" || !["md", "docx", "pdf"].includes(args.format)) throw new Error("文档格式只支持 md、docx、pdf");
    if (typeof args.markdown !== "string") throw new Error("markdown 必须是完整的文档正文字符串");
    if (args.title !== undefined && typeof args.title !== "string") throw new Error("文档标题必须是字符串");
    if (args.filename !== undefined && typeof args.filename !== "string") throw new Error("文件名必须是字符串");
    if (args.delivery !== undefined && args.delivery !== "current" && args.delivery !== "private") throw new Error("delivery 只支持 current 或 private");
    const destination = args.delivery === "private" ? "private" : "current";
    const conversationType = message.groupId && destination === "current" ? "group" : "private";
    const targetId = conversationType === "group" ? message.groupId! : message.senderId;
    if (!/^[1-9]\d*$/.test(targetId)) throw new Error("文档接收者不是有效的 QQ 号码");
    const request: DocumentRequest = { format: args.format as DocumentRequest["format"], markdown: args.markdown,
      title: args.title as string | undefined, filename: args.filename as string | undefined };
    const taskKey = `document:${stableHash(JSON.stringify([message.accountId, message.eventKey, message.senderId, conversationType, targetId, request]))}`;
    const existing = this.operations.get(taskKey);
    if (existing) return existing;
    const operation = this.deliver(request, taskKey, conversationType, targetId, destination);
    this.operations.set(taskKey, operation);
    try { return await operation; }
    finally { if (this.operations.get(taskKey) === operation) this.operations.delete(taskKey); }
  }

  private async deliver(request: DocumentRequest, taskKey: string, conversationType: "group" | "private", targetId: string,
    destination: "current" | "private"): Promise<DocumentDeliveryResult> {
    const metadataKey = `${taskKey}:artifact`;
    const prior = this.deps.db.kvGet(metadataKey);
    let artifact: DocumentArtifact;
    if (prior) artifact = JSON.parse(prior) as DocumentArtifact;
    else {
      artifact = await this.deps.service.create(request);
      this.deps.db.kvSet(metadataKey, JSON.stringify(artifact));
    }
    const existing = this.deps.db.db.prepare("SELECT * FROM send_tasks WHERE task_key = ?").get(taskKey) as DBRow_SendTask | undefined;
    let taskId: number;
    let reused = Boolean(prior);
    if (existing) { taskId = existing.id; reused = true; }
    else {
      const filePath = await this.providerPath(artifact.path);
      const task = this.deps.gateway.enqueueSend({ taskKey, kind: "document_file", conversationType, targetId,
        payload: { kind: "file", filePath, fileName: artifact.filename } });
      taskId = task.id;
      reused ||= task.reused;
    }
    const timeout = Math.max(0, Math.min(60000, this.deps.waitTimeoutMs ?? 21500));
    const deadline = Date.now() + timeout;
    let task = this.deps.db.sendTaskById(taskId);
    while (task && (task.status === "queued" || task.status === "in_flight") && Date.now() < deadline) {
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
      task = this.deps.db.sendTaskById(taskId);
    }
    if (!task) throw new Error("文档已生成，但未找到文件投递任务");
    const details: Record<SendStatus, string> = {
      confirmed: "文档已生成，协议端已确认文件发送成功。",
      queued: "文档已生成，文件仍在发送队列中；尚未确认发送成功。",
      in_flight: "文档已生成，文件正在上传；尚未收到成功回执。",
      unknown: "文档已生成，但文件发送回执不明；为避免重复投递，没有自动重发。",
      failed: "文档已生成，但文件发送失败；没有自动重发。",
    };
    // Provider errors can contain local paths or credentials. Keep model-facing
    // errors fixed; detailed diagnostics stay in the existing task record.
    return { generated: true, filename: artifact.filename, format: artifact.format, bytes: artifact.bytes,
      taskId, status: task.status, destination, reused, detail: details[task.status] };
  }

  private async providerPath(filePath: string): Promise<string> {
    const root = await fs.realpath(this.deps.service.outputDir);
    const absolute = await fs.realpath(filePath);
    const relative = path.relative(root, absolute);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("文档文件不在生成目录中，拒绝上传");
    }
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > this.deps.service.maxFileBytes) throw new Error("文档文件无效或超过上传大小限额");
    const providerRoot = this.deps.providerOutputDir?.trim();
    if (!providerRoot) return absolute;
    // A container running as a different user needs to traverse the shared
    // directory and read the exported file. Metadata remains private.
    if (process.platform !== "win32") {
      await fs.chmod(root, 0o755);
      await fs.chmod(path.dirname(absolute), 0o755);
      await fs.chmod(absolute, 0o644);
    }
    const join = providerRoot.startsWith("/") ? path.posix.join : path.win32.join;
    return join(providerRoot, ...relative.split(path.sep));
  }
}
