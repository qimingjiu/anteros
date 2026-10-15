import fs from "node:fs/promises";
import path from "node:path";
import dns from "node:dns";
import { pathToFileURL } from "node:url";
import { Agent as HttpAgent } from "undici";
import { detectAll } from "tinyld";
import type { Database } from "../db/index.js";
import type { Gateway } from "../gateway/index.js";
import type { MessageRecord, SendStatus, ToolDef, ToolContext } from "../types.js";
import { sleep, stableHash } from "../util/misc.js";
import { isPrivateAddress, readBounded } from "./web-http.js";

export const MINIMAX_ENGLISH_MALE_VOICE = "English_Gentle-voiced_man";
export type MiniMaxMediaKind = "image" | "speech";
export interface MiniMaxMediaResult {
  generated: boolean;
  kind: MiniMaxMediaKind;
  status: SendStatus;
  taskId?: number;
  bytes?: number;
  filename?: string;
  voiceId?: string;
  language?: "English";
  destination: "current" | "private";
  reused: boolean;
  reason?: string;
  detail: string;
}
export interface MiniMaxMediaDeps {
  db: Database;
  gateway: Gateway;
  mcp: { getTools(): ToolDef[] };
  accountId: string;
  ownerIds: string[];
  outputDir: string;
  providerOutputDir?: string;
  waitTimeoutMs?: number;
  generationTimeoutMs?: number;
  /** Dependency injection for offline validation. Production uses the pinned, bounded downloader. */
  downloadAsset?: typeof downloadMiniMaxAsset;
}
interface Artifact { filename: string; bytes: number; relativePath: string }
interface Journal {
  requestHash: string;
  state: "generating" | "asset_ready" | "generated" | "failed";
  assetUrl?: string;
  artifact?: Artifact;
  reason?: string;
}
const operations = new WeakMap<Database, Map<string, Promise<MiniMaxMediaResult>>>();
const SHORT_ENGLISH = new Set(["hello", "hi", "hey", "yes", "no", "okay", "ok", "goodnight", "good night", "good morning",
  "good afternoon", "good evening", "goodbye", "bye", "thank you", "thanks", "you are welcome", "i love you", "i miss you", "welcome", "sorry"]);
const LATIN_LANGUAGES = ["en", "es", "fr", "de", "it", "pt", "nl", "sv", "da", "no", "fi", "pl", "cs", "sk", "ro", "hu", "tr", "id", "vi", "af", "la", "eo", "sw"];

/** Conservative local language gate; no caller-controlled voice, tags, scripts or language overrides. */
export function validateEnglishSpeech(value: unknown): string {
  if (typeof value !== "string") throw new Error("语音正文必须是英文字符串");
  const text = value.trim().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[—–]/g, "-");
  if (!text || text.length > 2000 || !/[A-Za-z]/.test(text) || /[^\x20-\x7e\n\r\t]/.test(text)
    || /[<>\[\]{}\\`]/.test(text) || /(?:https?:|www\.)/i.test(text)) throw new Error("只允许最多 2000 字符的英文正文，不接受中文、其他文字脚本、链接或语音控制标签");
  const plain = text.toLowerCase().replace(/[^a-z\s']/g, " ").replace(/\s+/g, " ").trim();
  if (SHORT_ENGLISH.has(plain)) return text;
  const isEnglish = (input: string) => {
    const first = detectAll(input, { only: LATIN_LANGUAGES })[0];
    return first?.lang === "en" && first.accuracy >= 0.55;
  };
  if (!isEnglish(text)) throw new Error("正文未能可靠识别为英文，请先改写为英文再生成语音");
  for (const sentence of text.split(/[.!?;\n]+/).map(s => s.trim()).filter(Boolean)) {
    const sentencePlain = sentence.toLowerCase().replace(/[^a-z\s']/g, " ").replace(/\s+/g, " ").trim();
    if (SHORT_ENGLISH.has(sentencePlain)) continue;
    if (!isEnglish(sentence)) {
      throw new Error("正文包含未能识别为英文的句子，请仅提供英文");
    }
  }
  return text;
}

/** Only official MiniMax media hosts; a model or user can never supply the download URL. */
export function validateMiniMaxAssetUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("MiniMax 返回的媒体地址无效"); }
  const host = url.hostname.toLowerCase();
  const allowed = host === "minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com"
    || host === "hailuo-image-algeng-data.oss-cn-wulanchabu.aliyuncs.com"
    || host === "minimax-algeng-chat-tts.oss-cn-beijing.aliyuncs.com"
    || host === "cdn.minimax.io" || host.endsWith(".minimax.io") || host.endsWith(".minimax.cn") || host.endsWith(".minimax.chat");
  if (value.length > 8192 || url.protocol !== "https:" || url.username || url.password || url.port || !allowed) {
    throw new Error("MiniMax 媒体地址不在受信任的 HTTPS 服务范围内");
  }
  return url;
}

/** All DNS answers and redirect hops are checked, with the validated DNS pinned to the connection. */
export async function downloadMiniMaxAsset(value: string, kind: MiniMaxMediaKind): Promise<{ bytes: Buffer; extension: string }> {
  const maxBytes = kind === "image" ? 16 * 1024 * 1024 : 4 * 1024 * 1024;
  const signal = AbortSignal.timeout(45000);
  let url = validateMiniMaxAssetUrl(value);
  try {
    for (let hop = 0; hop <= 3; hop++) {
      const records = await Promise.race([dns.promises.lookup(url.hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("媒体下载超时")), { once: true }))]);
      signal.throwIfAborted();
      if (!records.length || records.some(record => isPrivateAddress(record.address))) throw new Error("媒体地址解析到非公开网络，已停止下载");
      const lookup = ((_host: string, options: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => {
        const selected = records.filter(record => !options.family || record.family === options.family);
        if (options.all) callback(null, selected);
        else { const chosen = selected[0] ?? records[0]!; callback(null, chosen.address, chosen.family); }
      }) as typeof dns.lookup;
      const dispatcher = new HttpAgent({ connect: { lookup, timeout: 10000 } });
      try {
        const response = await fetch(url, { redirect: "manual", signal, dispatcher } as RequestInit);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || hop === 3) throw new Error("媒体下载重定向无效");
          url = validateMiniMaxAssetUrl(new URL(location, url).toString());
          continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error("MiniMax 媒体下载失败"); }
        const length = Number(response.headers.get("content-length"));
        if (Number.isFinite(length) && length > maxBytes) { await response.body?.cancel(); throw new Error("媒体文件超过大小上限"); }
        const data = await readBounded(response, maxBytes);
        if (data.truncated || !data.bytes.length) throw new Error("媒体文件为空或超过大小上限");
        const bytes = Buffer.from(data.bytes);
        const extension = mediaExtension(bytes, kind);
        return { bytes, extension };
      } finally { await dispatcher.close(); }
    }
    throw new Error("媒体下载失败");
  } catch { throw new Error("MiniMax 媒体下载失败、超时或格式不受支持；已停止，不会重复生成"); }
}

function mediaExtension(bytes: Buffer, kind: MiniMaxMediaKind): string {
  if (kind === "image") {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "webp";
  } else if (bytes.subarray(0, 3).toString() === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return "mp3";
  throw new Error("媒体文件格式不受支持");
}

export class MiniMaxMediaService {
  private running: Map<string, Promise<MiniMaxMediaResult>>;
  constructor(private deps: MiniMaxMediaDeps) {
    this.running = operations.get(deps.db) ?? new Map();
    operations.set(deps.db, this.running);
  }

  toolsFor(message: MessageRecord): ToolDef[] {
    if (!this.allowed(message)) return [];
    const delivery = { type: "string", enum: ["current", "private"], description: "默认发当前会话；private 只发给当前请求主人本人。" };
    return [
      { name: "generate_image", description: "主人明确要求画图时，使用 MiniMax 生成一张图片并直接发送到 QQ。仅 confirmed 表示协议确认成功，unknown 禁止重试。", private: true,
        inputSchema: { type: "object", properties: { prompt: { type: "string", minLength: 1, maxLength: 2000 },
          aspect_ratio: { type: "string", enum: ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"] }, delivery }, required: ["prompt"], additionalProperties: false },
        execute: async args => JSON.stringify(await this.createAndSend("image", args, message)) },
      { name: "generate_english_speech", description: "主人明确要求语音时，将英文正文用固定英文男声生成并作为 QQ 语音发送。仅允许英文，禁止中文/其他语言、女声、音色克隆或控制标签；非英文须先改写为英文。unknown 禁止重试。", private: true,
        inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 2000 }, delivery }, required: ["text"], additionalProperties: false },
        execute: async args => JSON.stringify(await this.createAndSend("speech", args, message)) },
    ];
  }

  private allowed(message: MessageRecord): boolean {
    return message.accountId === this.deps.accountId && message.origin === "live" && message.status === "active" && !message.interaction
      && this.deps.ownerIds.includes(message.senderId) && !this.deps.db.isUserBlocked(message.accountId, message.senderId);
  }

  async createAndSend(kind: MiniMaxMediaKind, args: Record<string, unknown>, message: MessageRecord): Promise<MiniMaxMediaResult> {
    if (!this.allowed(message)) throw new Error("媒体生成只允许由当前账号主人的有效实时消息请求");
    if (kind !== "image" && kind !== "speech") throw new Error("不支持的媒体类型");
    // A quote, webpage or tool result is never the authorization source. Use only the owner's actual text segments.
    const ownerText = message.segments.filter(segment => segment.type === "text").map(segment => segment.type === "text" ? segment.data.text : "").join("\n")
      .replace(/```[\s\S]*?```/gu, "").replace(/^\s*>.*$/gmu, "");
    const forbidden = kind === "image"
      ? /(?:不要|别|不准|不允许|禁止|不用|无需).{0,8}(?:画|绘|图|image|picture)|(?:do not|don't|never).{0,12}(?:draw|generat\w*|image|picture)/i
      : /(?:不要|别|不准|不允许|禁止|不用|无需).{0,8}(?:语音|朗读|男声|读出来)|(?:do not|don't|never).{0,12}(?:speak|speech|audio|voice|read aloud)/i;
    const requested = kind === "image"
      ? /(?:画|绘制|绘画|生成|制作|做|来|发).{0,16}(?:图|插画|照片|image|picture)|(?:draw|paint|generat\w*|creat\w*|send).{0,24}(?:image|picture|illustration|photo)/i
      : /(?:生成|制作|发|来|用|转成|转为).{0,16}(?:语音|男声|speech|audio|voice)|(?:朗读|读出来|念出来|说一句)|(?:generat\w*|creat\w*|send|speak|read).{0,24}(?:speech|audio|voice|aloud)/i;
    const drawObject = /(?:^|[。！？!?\n，,；;])\s*(?:请\s*)?(?:(?:你\s*)?(?:帮我|替我|给我)|我(?:想|希望)(?:要)?(?:让)?你|你)?\s*(?:画|绘制)\s*(?:一?(?:只|个|张|幅|匹|头|朵|条|棵)|我|你|他|她|它|咱们|我们|自己|这只|那只|这个|那个)/u;
    const discussion = /(?:怎么|如何|怎样|是否支持|我想知道).{0,30}(?:画|绘|生成|制作|语音)/u.test(ownerText);
    if (forbidden.test(ownerText) || discussion || !(requested.test(ownerText) || (kind === "image" && drawObject.test(ownerText)))) {
      throw new Error("需要主人在当前消息中明确请求本类媒体生成或发送；资料、引用或模型参数不能代替授权");
    }
    const allowed = kind === "image" ? ["prompt", "aspect_ratio", "delivery"] : ["text", "delivery"];
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error("媒体参数不接受音色、模型、语言、路径、URL 或任意收件人");
    if (args.delivery !== undefined && args.delivery !== "current" && args.delivery !== "private") throw new Error("delivery 只允许 current 或 private");
    const destination = args.delivery === "private" ? "private" : "current";
    const conversationType = message.groupId && destination === "current" ? "group" : "private";
    const targetId = conversationType === "group" ? message.groupId! : message.senderId;
    if (!/^[1-9]\d*$/.test(targetId) || message.conversationId !== (message.groupId ? `group_${message.groupId}` : `private_${message.senderId}`)) throw new Error("媒体请求的真实会话无效");
    let request: Record<string, unknown>;
    if (kind === "speech") request = { text: validateEnglishSpeech(args.text), voice_id: MINIMAX_ENGLISH_MALE_VOICE,
      language_boost: "English", model: "speech-2.8-hd", format: "mp3", sample_rate: 24000, bitrate: 128000, channel: 1,
      speed: 1, vol: 1, pitch: 0, emotion: "neutral" };
    else {
      if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(args.prompt)) throw new Error("图片描述必须为 1 到 2000 字符");
      const ratio = args.aspect_ratio ?? "1:1";
      if (typeof ratio !== "string" || !["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"].includes(ratio)) throw new Error("不支持的图片比例");
      request = { prompt: args.prompt.trim(), aspect_ratio: ratio, model: "image-01", n: 1, prompt_optimizer: true };
    }
    const key = `minimax_media:v1:${stableHash(JSON.stringify([message.accountId, message.conversationId, message.senderId, message.eventKey, kind]))}`;
    const priorRunning = this.running.get(key);
    if (priorRunning) return priorRunning;
    const operation = this.deliver(key, kind, request, message, conversationType, targetId, destination);
    this.running.set(key, operation);
    try { return await operation; }
    finally { if (this.running.get(key) === operation) this.running.delete(key); }
  }

  private async deliver(key: string, kind: MiniMaxMediaKind, request: Record<string, unknown>, message: MessageRecord,
    conversationType: "group" | "private", targetId: string, destination: "current" | "private"): Promise<MiniMaxMediaResult> {
    const requestHash = stableHash(JSON.stringify([request, conversationType, targetId]));
    const raw = this.deps.db.kvGet(key);
    let journal: Journal | undefined = raw ? JSON.parse(raw) as Journal : undefined;
    const reused = Boolean(journal);
    const result = (status: SendStatus, detail: string, extra: Partial<MiniMaxMediaResult> = {}): MiniMaxMediaResult => ({
      generated: journal?.state === "generated", kind, status, destination, reused, detail,
      ...(kind === "speech" ? { voiceId: MINIMAX_ENGLISH_MALE_VOICE, language: "English" as const } : {}), ...extra });
    if (journal && journal.requestHash !== requestHash) return result("failed", "此条消息已启动过媒体生成；为避免重复消耗，没有使用修改后的参数重做。", { reason: "already_requested" });
    if (journal?.state === "generating" || journal?.state === "failed") return result("unknown", "上次生成可能已经消耗额度或结果不明；没有自动重新生成。", { reason: journal.reason ?? "generation_uncertain" });
    if (!journal) {
      const backend = this.deps.mcp.getTools().find(tool => tool.name === `mcp__minimax__${kind === "image" ? "text_to_image" : "text_to_audio"}`);
      if (!backend) return result("failed", "MiniMax 生成工具尚未连接，未提交生成请求。", { reason: "unavailable" });
      await fs.mkdir(this.deps.outputDir, { recursive: true, mode: 0o700 });
      if ((await fs.readdir(this.deps.outputDir)).filter(name => /^media-[a-f0-9]+$/.test(name)).length >= 128) {
        return result("failed", "媒体目录已达本地容量上限，未提交生成请求。", { reason: "local_quota" });
      }
      journal = { state: "generating", requestHash };
      this.deps.db.kvSet(key, JSON.stringify(journal));
      const ctx: ToolContext = { accountId: message.accountId, groupId: message.groupId, requesterId: message.senderId, isPrivate: !message.groupId };
      let timer: NodeJS.Timeout | undefined;
      try {
        const response = await Promise.race([backend.execute(request, ctx), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), Math.max(1000, Math.min(180000, this.deps.generationTimeoutMs ?? 125000)));
        })]);
        if (!response.startsWith("Success.")) throw new Error("generation_failed");
        const urls = response.match(/https:\/\/[^\s'"\]<>]+/g) ?? [];
        if (urls.length !== 1) throw new Error("invalid_response");
        const assetUrl = validateMiniMaxAssetUrl(urls[0]!).toString();
        journal = { state: "asset_ready", requestHash, assetUrl };
        this.deps.db.kvSet(key, JSON.stringify(journal));
      } catch {
        journal = { state: "failed", requestHash, reason: "generation_uncertain" };
        this.deps.db.kvSet(key, JSON.stringify(journal));
        return result("unknown", "MiniMax 未返回可确认的生成结果；为避免重复消耗额度，没有自动重试。", { reason: "generation_uncertain" });
      } finally { if (timer) clearTimeout(timer); }
    }
    if (journal.state === "asset_ready") {
      try {
        const downloaded = await (this.deps.downloadAsset ?? downloadMiniMaxAsset)(journal.assetUrl!, kind);
        const relativeDir = `media-${stableHash(key)}`;
        const absoluteDir = path.join(this.deps.outputDir, relativeDir);
        await fs.mkdir(absoluteDir, { recursive: true, mode: 0o700 });
        const filename = `${kind === "image" ? "minimax-image" : "english-male-speech"}.${downloaded.extension}`;
        await fs.writeFile(path.join(absoluteDir, filename), downloaded.bytes, { mode: 0o600 });
        journal = { state: "generated", requestHash, artifact: { filename, bytes: downloaded.bytes.length, relativePath: path.join(relativeDir, filename) } };
        this.deps.db.kvSet(key, JSON.stringify(journal));
      } catch {
        return result("failed", "MiniMax 已返回媒体，但下载或存储尚未成功；再次调用只尝试取得同一媒体，不会重新生成。", { reason: "asset_unavailable" });
      }
    }
    const artifact = journal.artifact!;
    const priorTask = this.deps.db.db.prepare("SELECT id FROM send_tasks WHERE task_key = ?").get(key) as { id: number } | undefined;
    let task: { id: number; reused: boolean };
    if (priorTask) task = { id: priorTask.id, reused: true };
    else {
      let file: string;
      try { file = await this.providerPath(artifact); }
      catch { return result("failed", "媒体文件当前不可用；没有自动重新生成。", { reason: "asset_unavailable" }); }
      task = this.deps.gateway.enqueueSend({ taskKey: key, kind: `minimax_${kind}`, conversationType, targetId,
        payload: { kind: "segments", requesterId: message.senderId, accountId: message.accountId,
          segments: [{ type: kind === "image" ? "image" : "record", data: { file } }] } });
    }
    const deadline = Date.now() + Math.max(0, Math.min(60000, this.deps.waitTimeoutMs ?? 21500));
    let receipt = this.deps.db.sendTaskById(task.id);
    while (receipt && (receipt.status === "queued" || receipt.status === "in_flight") && Date.now() < deadline) {
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
      receipt = this.deps.db.sendTaskById(task.id);
    }
    const status = receipt?.status ?? "unknown";
    const details: Record<SendStatus, string> = { confirmed: "媒体已生成，QQ 协议端已确认发送成功。", queued: "媒体已生成并排队，尚未确认发送成功。",
      in_flight: "媒体已生成，正在发送，尚未收到确认回执。", failed: "媒体已生成，但 QQ 发送失败；没有自动重发。",
      unknown: "媒体已生成，但 QQ 发送回执不明；为避免重复投递，没有自动重发。" };
    return result(status, details[status], { taskId: task.id, bytes: artifact.bytes, filename: artifact.filename, reused: reused || task.reused });
  }

  private async providerPath(artifact: Artifact): Promise<string> {
    const root = await fs.realpath(this.deps.outputDir);
    const absolute = await fs.realpath(path.join(root, artifact.relativePath));
    const relative = path.relative(root, absolute);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("媒体文件不在生成目录");
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size !== artifact.bytes || stat.size > 16 * 1024 * 1024) throw new Error("媒体文件大小无效");
    let providerPath = absolute;
    if (this.deps.providerOutputDir) {
      if (process.platform !== "win32") {
        await fs.chmod(root, 0o755); await fs.chmod(path.dirname(absolute), 0o755); await fs.chmod(absolute, 0o644);
      }
      const join = this.deps.providerOutputDir.startsWith("/") ? path.posix.join : path.win32.join;
      providerPath = join(this.deps.providerOutputDir, ...relative.split(path.sep));
    }
    return providerPath.startsWith("/") ? `file://${providerPath}` : pathToFileURL(providerPath).toString();
  }
}
