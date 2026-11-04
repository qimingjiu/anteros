import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { AttachmentBuilder } from "discord.js";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

function ffmpegPath(): string {
  try { const p = require("ffmpeg-static") as string | null; if (p) return p; } catch { /* fall through */ }
  return "ffmpeg";
}

/** Convert any audio (local path or http url) to a Discord native voice-message attachment (ogg/opus + waveform + duration). */
export async function buildVoiceAttachment(input: string): Promise<AttachmentBuilder> {
  const ff = ffmpegPath();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dcvoice-"));
  try {
    const ogg = path.join(dir, "voice-message.ogg");
    await run(ff, ["-y", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "48k", "-application", "voip", ogg], { timeout: 60000 });
    // Decode to 8 kHz mono s16le to measure duration and draw the waveform.
    const { stdout } = await run(ff, ["-loglevel", "error", "-i", ogg, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 60000 }) as unknown as { stdout: Buffer };
    const samples = Math.floor(stdout.length / 2);
    const duration = Math.max(0.1, samples / 8000);
    const bins = 256;
    const per = Math.max(1, Math.floor(samples / bins));
    const peaks: number[] = [];
    for (let b = 0; b < bins; b++) {
      let sum = 0, n = 0;
      for (let i = b * per; i < Math.min(samples, (b + 1) * per); i++) { const v = stdout.readInt16LE(i * 2); sum += v * v; n++; }
      peaks.push(n ? Math.sqrt(sum / n) : 0);
    }
    const max = Math.max(1, ...peaks);
    const wave = Buffer.from(peaks.map((p) => Math.min(255, Math.round((p / max) * 255))));
    const bytes = await fs.readFile(ogg);
    return new AttachmentBuilder(bytes, { name: "voice-message.ogg" })
      .setDuration(Math.round(duration * 100) / 100)
      .setWaveform(wave.toString("base64"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
