import { createHash } from "node:crypto";
import type { ChatMessage } from "./index.js";
import { fetchPublicBytes } from "../tools/web-http.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 32;

type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
type ImageInputFailureCode = "download_failed" | "download_timeout" | "too_large" | "unsupported_image";

/** Fixed messages only; neither image locations nor image contents enter errors. */
export class ImageInputError extends Error {
  override name = "ImageInputError";
  constructor(readonly code: ImageInputFailureCode) {
    super(`图片输入准备失败 code=${code}`);
  }
}

export interface ImageDownloadOptions {
  maxBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
}
export interface ImageInputCacheOptions {
  download?: (url: string, options: ImageDownloadOptions) => Promise<Uint8Array>;
  now?: () => number;
}
interface CachedImage { bytes: Uint8Array; mime: ImageMime; expiresAt: number }

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason : new DOMException("图片输入准备已取消", "AbortError");
}

function imageMime(bytes: Uint8Array): ImageMime {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  const prefix = Buffer.from(bytes.subarray(0, 12)).toString("latin1");
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "image/gif";
  if (bytes.length >= 12 && prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") return "image/webp";
  throw new ImageInputError("unsupported_image");
}

async function downloadImage(url: string, options: ImageDownloadOptions): Promise<Uint8Array> {
  const response = await fetchPublicBytes(url, { ...options, headers: { Accept: "image/*,application/octet-stream;q=0.5" } });
  if (response.status < 200 || response.status >= 300) throw new ImageInputError("download_failed");
  if (response.truncated) throw new ImageInputError("too_large");
  return response.bytes;
}

function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new ImageInputError("download_timeout"));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** Bounded, temporary image bytes only; message identities and extracted evidence are never cached. */
export class ImageInputCache {
  private readonly download: NonNullable<ImageInputCacheOptions["download"]>;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedImage>();
  private cacheBytes = 0;

  constructor(options: ImageInputCacheOptions = {}) {
    this.download = options.download ?? downloadImage;
    this.now = options.now ?? Date.now;
  }

  async inlineMessages(messages: ChatMessage[], signal?: AbortSignal): Promise<ChatMessage[]> {
    throwIfCancelled(signal);
    const result = structuredClone(messages);
    for (const message of result) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        throwIfCancelled(signal);
        if (part.type !== "image_url" || /^data:/i.test(part.image_url.url)) continue;
        let parsed: URL;
        try { parsed = new URL(part.image_url.url); }
        catch { continue; }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
        const image = await this.image(part.image_url.url, signal);
        throwIfCancelled(signal);
        part.image_url.url = `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`;
      }
    }
    return result;
  }

  private async image(url: string, signal?: AbortSignal): Promise<CachedImage> {
    const now = this.now();
    for (const [key, image] of this.cache) if (image.expiresAt <= now) this.remove(key);
    const key = createHash("sha256").update(url).digest("hex");
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const downloadSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
    let bytes: Uint8Array;
    try {
      const downloaded = await bounded(Promise.resolve().then(() => this.download(url, {
        maxBytes: MAX_IMAGE_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS, signal: downloadSignal,
      })), downloadSignal);
      throwIfCancelled(signal);
      if (downloadSignal.aborted) throw new ImageInputError("download_timeout");
      if (!(downloaded instanceof Uint8Array)) throw new ImageInputError("unsupported_image");
      if (downloaded.byteLength > MAX_IMAGE_BYTES) throw new ImageInputError("too_large");
      bytes = new Uint8Array(downloaded);
    } catch (error) {
      throwIfCancelled(signal);
      if (downloadSignal.aborted) throw new ImageInputError("download_timeout");
      if (error instanceof ImageInputError) throw error;
      throw new ImageInputError("download_failed");
    }
    const image: CachedImage = { bytes, mime: imageMime(bytes), expiresAt: this.now() + CACHE_TTL_MS };
    this.remove(key);
    this.cache.set(key, image);
    this.cacheBytes += bytes.byteLength;
    while (this.cache.size > MAX_CACHE_ENTRIES || this.cacheBytes > MAX_CACHE_BYTES) {
      this.remove(this.cache.keys().next().value!);
    }
    return image;
  }

  private remove(key: string): void {
    const image = this.cache.get(key);
    if (image) { this.cacheBytes -= image.bytes.byteLength; this.cache.delete(key); }
  }
}
