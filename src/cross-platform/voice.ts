import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

export function ffmpegPath(): string {
  try {
    const bundled = require("ffmpeg-static") as string | null;
    if (bundled && existsSync(bundled)) return bundled;
  } catch { /* Use the system installation. */ }
  return "ffmpeg";
}

export function localVoiceInput(filePath: string): string[] {
  if (!path.isAbsolute(filePath)) throw new Error("原生语音需要本地音频文件。");
  return ["-protocol_whitelist", "file,pipe",
    "-format_whitelist", "ogg,mp3,mov,wav,aac,flac", "-i", filePath];
}

/** Retain formats Telegram can send as voice, converting WAV and other audio to Opus. */
export async function telegramVoice(bytes: Buffer, filename: string, maxBytes: number): Promise<{ bytes: Buffer; filename: string }> {
  if (bytes.subarray(0, 4).toString() === "OggS" && bytes.subarray(0, 128).includes("OpusHead")) {
    return { bytes, filename: replaceExtension(filename, "ogg") };
  }
  if (bytes.subarray(0, 3).toString() === "ID3"
    || (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe6) === 0xe2)) {
    return { bytes, filename: replaceExtension(filename, "mp3") };
  }
  if (bytes.subarray(4, 12).toString() === "ftypM4A ") {
    return { bytes, filename: replaceExtension(filename, "m4a") };
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anteros-voice-"));
  try {
    const input = path.join(directory, "source.audio");
    const output = path.join(directory, "voice.ogg");
    await fs.writeFile(input, bytes, { flag: "wx", mode: 0o600 });
    await run(ffmpegPath(), ["-nostdin", "-loglevel", "error", ...localVoiceInput(input),
      "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "48k",
      "-application", "voip", output], { timeout: 30000, windowsHide: true });
    const stat = await fs.stat(output);
    if (!stat.size || stat.size > maxBytes) throw new Error("转换后的语音超过发送大小限制。");
    return { bytes: await fs.readFile(output), filename: replaceExtension(filename, "ogg") };
  } catch {
    throw new Error("Telegram 原生语音准备失败，请检查音频格式、大小与 ffmpeg。");
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function replaceExtension(filename: string, extension: string): string {
  return filename.replace(/\.[a-z0-9]{1,12}$/iu, "") + "." + extension;
}
