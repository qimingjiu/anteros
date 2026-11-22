import { readBounded } from "../tools/web-http.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const FILE_ID = /^[A-Za-z0-9_-]{1,512}$/;
export const TELEGRAM_FILE_PROTOCOL = "telegram-file:";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

export function numericId(value: unknown, signed = false): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== "string" || !(signed ? /^-?[1-9]\d{0,15}$/ : /^[1-9]\d{0,15}$/).test(value)) return;
  return Number.isSafeInteger(Number(value)) ? value : undefined;
}

export function telegramFileId(value: unknown): string | undefined {
  return typeof value === "string" && FILE_ID.test(value) ? value : undefined;
}

export function telegramFileIdFromUri(uri: string): string | undefined {
  return uri.startsWith(TELEGRAM_FILE_PROTOCOL) ? telegramFileId(uri.slice(TELEGRAM_FILE_PROTOCOL.length)) : undefined;
}

export class TelegramApiError extends Error {
  constructor(message: string, readonly code?: number, readonly retryAfterMs?: number) { super(message); }
  get rejected(): boolean { return this.code !== undefined && this.code >= 400 && this.code < 500; }
}

export class TelegramApi {
  private readonly baseUrl: string;

  constructor(private readonly token: string, baseUrl: string | undefined, private readonly request = fetch) {
    if (!/^[A-Za-z0-9_:-]{1,256}$/.test(token)) throw new Error("Telegram 令牌格式无效");
    const url = new URL(baseUrl ?? "https://api.telegram.org");
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username || url.password || url.search || url.hash) throw new Error("Telegram Bot API 地址无效");
    this.baseUrl = url.href.replace(/\/+$/, "");
  }

  async call(method: string, parameters: Record<string, unknown> | FormData,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    const form = parameters instanceof FormData;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response: Response;
    try {
      response = await this.request(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        body: form ? parameters : JSON.stringify(parameters),
        headers: form ? undefined : { "Content-Type": "application/json" },
        redirect: "error",
        signal,
      });
    } catch {
      throw new TelegramApiError("Telegram API 请求未取得确认");
    }
    let value: Record<string, unknown> | undefined;
    try {
      const { bytes, truncated } = await readBounded(response, MAX_RESPONSE_BYTES);
      if (!truncated) value = asRecord(JSON.parse(new TextDecoder().decode(bytes)));
    } catch { /* HTTP status can still identify a definite rejection. */ }
    if (response.ok && value?.ok === true && Object.hasOwn(value, "result")) return value.result;
    const code = !response.ok ? response.status : typeof value?.error_code === "number" ? value.error_code : undefined;
    const retryAfter = Number(asRecord(value?.parameters)?.retry_after ?? response.headers.get("Retry-After"));
    throw new TelegramApiError(code ? `Telegram API 返回 ${code}` : "Telegram API 未返回可确认的结果",
      code, retryAfter > 0 && Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
  }

  async download(fileId: string, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
    if (!telegramFileId(fileId)) throw new Error("Telegram 文件标识无效");
    const signal = AbortSignal.timeout(timeoutMs);
    const info = asRecord(await this.call("getFile", { file_id: fileId }, { signal }));
    const filePath = info?.file_path;
    if (typeof filePath !== "string" || filePath.length > 1024
      || !filePath.split("/").every(part => part !== "." && part !== ".." && /^[A-Za-z0-9_.-]+$/.test(part))) {
      throw new Error("Telegram 未返回可下载的文件路径");
    }
    const limit = Math.min(maxBytes, MAX_DOWNLOAD_BYTES);
    if (typeof info?.file_size === "number" && info.file_size > limit) throw new Error("Telegram 文件超过下载上限");
    try {
      const response = await this.request(`${this.baseUrl}/file/bot${this.token}/${filePath}`, { signal, redirect: "error" });
      if (!response.ok || Number(response.headers.get("content-length")) > limit) {
        await response.body?.cancel();
        throw new Error("Telegram 文件无法读取或超过体积上限");
      }
      const { bytes, truncated } = await readBounded(response, limit);
      if (truncated) throw new Error("Telegram 文件超过下载上限");
      return bytes;
    } catch {
      if (signal.aborted) throw new Error("Telegram 文件下载超时");
      throw new Error("Telegram 文件下载失败或超过体积上限");
    }
  }
}
