import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { parseDocument } from "./markdown.js";
import { renderDocx } from "./docx.js";
import { renderPdf } from "./pdf.js";

export type DocumentFormat = "md" | "docx" | "pdf";
export interface DocumentRequest {
  format: DocumentFormat;
  markdown: string;
  title?: string;
  filename?: string;
}
export interface DocumentArtifact {
  id: string;
  path: string;
  filename: string;
  format: DocumentFormat;
  mimeType: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}
export interface DocumentServiceConfig {
  outputDir: string;
  maxInputChars?: number;
  maxFileBytes?: number;
  maxRetainedFiles?: number;
  retentionHours?: number;
}

const MIME_TYPES = { md: "text/markdown; charset=utf-8", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pdf: "application/pdf" };
const MANAGED_DIRECTORY = /^doc-[0-9a-f]{32}$/;
const directoryQueues = new Map<string, Promise<unknown>>();

export function safeDocumentFilename(input: string, format: DocumentFormat): string {
  let base = input.normalize("NFC").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, "_").trim();
  base = base.replace(/\.(?:md|docx|pdf)$/i, "").replace(/[. ]+$/g, "").replace(/^\.+/, "");
  if (!base || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(base)) base = "文档";
  base = Array.from(base).slice(0, 90).join("");
  while (Buffer.byteLength(base, "utf8") > 180) base = Array.from(base).slice(0, -1).join("");
  return `${base}.${format}`;
}

async function atomicWrite(filePath: string, data: Buffer): Promise<void> {
  const temporary = `${filePath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Local-only renderer. Returning an artifact means generation completed; it does not imply QQ delivery. */
export class DocumentService {
  readonly outputDir: string;
  readonly maxInputChars: number;
  readonly maxFileBytes: number;
  readonly maxRetainedFiles: number;
  readonly retentionHours: number;

  constructor(config: DocumentServiceConfig) {
    if (typeof config.outputDir !== "string" || !config.outputDir.trim()) throw new Error("文档输出目录不能为空");
    this.outputDir = path.resolve(config.outputDir);
    this.maxInputChars = config.maxInputChars ?? 100000;
    this.maxFileBytes = config.maxFileBytes ?? 10 * 1024 * 1024;
    this.maxRetainedFiles = config.maxRetainedFiles ?? 100;
    this.retentionHours = config.retentionHours ?? 72;
    for (const [name, value] of Object.entries({ maxInputChars: this.maxInputChars, maxFileBytes: this.maxFileBytes, maxRetainedFiles: this.maxRetainedFiles, retentionHours: this.retentionHours })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`文档配置 ${name} 必须是正整数`);
    }
  }

  async create(request: DocumentRequest): Promise<DocumentArtifact> {
    if (typeof request.format !== "string" || !Object.hasOwn(MIME_TYPES, request.format)) throw new Error("文档格式只支持 md、docx、pdf");
    if (typeof request.markdown !== "string" || !request.markdown.trim()) throw new Error("文档内容不能为空");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(request.markdown)) throw new Error("文档内容包含不支持的控制字符");
    if (request.markdown.length > this.maxInputChars) throw new Error(`文档内容超过 ${this.maxInputChars} 字符上限，请拆分文档`);
    if (request.title !== undefined && (typeof request.title !== "string" || request.title.length > 200)) throw new Error("文档标题最多 200 字符");
    if (request.title && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(request.title)) throw new Error("文档标题包含不支持的控制字符");
    if (request.filename !== undefined && (typeof request.filename !== "string" || request.filename.length > 500)) throw new Error("文档文件名最多 500 字符");
    // Serialize by output directory, including across service instances, so
    // simultaneous requests cannot exceed quotas or amplify font memory use.
    const previous = directoryQueues.get(this.outputDir) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.generate(request));
    directoryQueues.set(this.outputDir, operation);
    try { return await operation; }
    finally { if (directoryQueues.get(this.outputDir) === operation) directoryQueues.delete(this.outputDir); }
  }

  private async generate(request: DocumentRequest): Promise<DocumentArtifact> {
    await fs.mkdir(this.outputDir, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(this.outputDir, { withFileTypes: true });
    let retained = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !MANAGED_DIRECTORY.test(entry.name)) continue;
      const directory = path.join(this.outputDir, entry.name);
      const stat = await fs.lstat(directory);
      if (Date.now() - stat.mtimeMs > this.retentionHours * 3600000) await fs.rm(directory, { recursive: true, force: true });
      else retained++;
    }
    if (retained >= this.maxRetainedFiles) throw new Error(`文档存储达到 ${this.maxRetainedFiles} 个文件上限，请等待过期清理或增加存储限额`);

    const title = request.title?.trim() || safeDocumentFilename(request.filename || "文档", request.format).replace(/\.(?:md|docx|pdf)$/i, "");
    const filename = safeDocumentFilename(request.filename || title, request.format);
    // Never overwrite a previous artifact, including repeated user filenames.
    const id = crypto.randomBytes(16).toString("hex");
    const directory = path.join(this.outputDir, `doc-${id}`);
    const filePath = path.join(directory, filename);
    await fs.mkdir(directory, { mode: 0o700 });
    try {
      const markdown = request.title?.trim() && !/^\s*#\s+/m.test(request.markdown) ? `# ${request.title.trim().replace(/\r?\n/g, " ")}\n\n${request.markdown}` : request.markdown;
      const data = request.format === "md" ? Buffer.from(markdown, "utf8") : request.format === "docx" ? await renderDocx(parseDocument(markdown), title) : await renderPdf(parseDocument(markdown), title, this.maxFileBytes);
      if (data.length > this.maxFileBytes) throw new Error(`生成的文档超过 ${this.maxFileBytes} 字节文件大小上限`);
      await atomicWrite(filePath, data);
      const artifact: DocumentArtifact = { id, path: filePath, filename, format: request.format, mimeType: MIME_TYPES[request.format], bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex"), createdAt: new Date().toISOString() };
      await atomicWrite(path.join(directory, "artifact.json"), Buffer.from(JSON.stringify(artifact, null, 2), "utf8"));
      return artifact;
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}
