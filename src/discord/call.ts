import fs from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import {
  AudioPlayer, AudioPlayerStatus, EndBehaviorType, NoSubscriberBehavior, StreamType, VoiceConnection, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource, entersState, getVoiceConnection, joinVoiceChannel,
} from "@discordjs/voice";
import type { Client, VoiceBasedChannel } from "discord.js";
import type { MessageRecord, ToolDef } from "../types.js";
import type { Database } from "../db/index.js";
import { logger } from "../util/logger.js";
import { localizeTimestamps } from "../util/model-time.js";
import { OWNER_NAME_EN } from "../util/owner.js";

const log = logger("call");
const req = createRequire(import.meta.url);
const ffmpegBin: string = (() => { try { return (req("ffmpeg-static") as string) || "ffmpeg"; } catch { return "ffmpeg"; } })();
const OpusScript = req("opusscript");

export interface CallDeps {
  getClient(): Client | null;
  accountId: string;
  ownerIds: string[];
  personaFile: string;
  llm: { baseUrl: string; apiKey: string; model: string };
  tts: { host: string; apiKey: string; voiceId: string; model: string };
  /** Give the voice connection back to the music player after the call (if music is active). */
  restoreMusic(guildId: string): boolean;
  /** Shared chat history: call turns are written here so text chat knows what was said, and the call starts from recent text. */
  db?: Database;
  selfId?(): string | undefined;
  music?: { play(m: MessageRecord, a: Record<string, unknown>): Promise<object>; control(m: MessageRecord, a: Record<string, unknown>): object };
}

interface Turn { role: "user" | "assistant"; content: string }
interface CallState {
  guildId: string; channelId: string; ownerId: string; conn: VoiceConnection; player: AudioPlayer;
  history: Turn[]; capturing: boolean; textChannelId?: string; conversationId: string; ownerName: string; textContext: string; busy: Promise<void>; lastActivity: number; idleTimer: NodeJS.Timeout; gen: number;
}

function wavFromPcm(pcm: Buffer, rate = 48000, ch = 2): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Downsample to 16 kHz mono wav (small upload) via ffmpeg. */
function toSmallWav(wav: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegBin, ["-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"]);
    const out: Buffer[] = [];
    ff.stdout.on("data", (d) => out.push(d));
    ff.on("error", reject);
    ff.on("close", (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}`)));
    ff.stdin.on("error", () => {});
    ff.stdin.end(wav);
  });
}

function oggFromBuffer(audio: Buffer) {
  const ff = spawn(ffmpegBin, ["-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "2", "-ar", "48000", "-c:a", "libopus", "-b:a", "96k", "-f", "ogg", "pipe:1"]);
  ff.stdin.on("error", () => {});
  ff.on("error", (e) => log.warn(`ffmpeg 启动失败: ${e.message}`));
  Readable.from([audio]).pipe(ff.stdin);
  const res = createAudioResource(ff.stdout, { inputType: StreamType.OggOpus });
  res.playStream.on("close", () => { if (ff.exitCode === null) ff.kill("SIGKILL"); });
  return res;
}

const CALL_RULES = `

## Live voice call (current mode)
You are in a live Discord voice call with ${OWNER_NAME_EN} right now. Each user turn is a short recording of her voice (she usually speaks Chinese).
Reply as κόραξ would on a phone call: spoken English only (your voice is a fixed English male voice and cannot speak Chinese), 1-3 short natural sentences, no markdown, no emoji, no stage directions, no lists.
Output exactly two lines:
HEARD: <what she said, transcribed in her original language>
REPLY: <your spoken English reply>
She is in a noisy dorm. If she asks you to play, switch, pause, resume or stop music, add a third line:
ACTION: play <song name / artist, as she said it, or \"liked\" for her own favourites list> | skip | pause | resume | stop_music
(only when she clearly asks; your REPLY should then be a short acknowledgement like "Coming right up.")
If the recording has no intelligible speech from her (silence, noise, breathing, music, or only distant roommates/background chatter not spoken to you), output exactly: HEARD: [none]`;

export class VoiceCallService {
  private calls = new Map<string, CallState>();
  constructor(private deps: CallDeps) {}

  private allowed(m: MessageRecord): boolean {
    return m.accountId === this.deps.accountId && m.origin === "live" && m.status === "active" && this.deps.ownerIds.includes(m.senderId);
  }

  private findVoice(userId: string, preferChannelId?: string): VoiceBasedChannel | null {
    const client = this.deps.getClient();
    if (!client) return null;
    const guilds = [...client.guilds.cache.values()];
    if (preferChannelId) { const ch = client.channels.cache.get(preferChannelId); if (ch && "guild" in ch && ch.guild) guilds.unshift(ch.guild as any); }
    for (const g of guilds) { const vs = g.voiceStates.cache.get(userId); if (vs?.channel) return vs.channel; }
    return null;
  }

  isActive(guildId: string): boolean { return this.calls.has(guildId); }

  async start(m: MessageRecord): Promise<object> {
    const ch = this.findVoice(m.senderId, m.groupId);
    if (!ch) return { ok: false, reason: "主人现在不在任何语音频道里，先进语音频道再打电话。" };
    if (this.calls.has(ch.guild.id)) return { ok: true, already: true, voice_channel_name: ch.name };
    let conn = getVoiceConnection(ch.guild.id);
    if (!conn || conn.joinConfig.channelId !== ch.id) {
      conn = joinVoiceChannel({ channelId: ch.id, guildId: ch.guild.id, adapterCreator: ch.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
    }
    await entersState(conn, VoiceConnectionStatus.Ready, 20000);
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    player.on("error", (e) => log.warn(`通话播放出错: ${e.message}`));
    player.on("stateChange", (a, b) => {
      log.info(`通话播放器 ${a.status} -> ${b.status}`);
      // Reply finished: give the channel back to the music (it auto-paused while we spoke).
      if (b.status === AudioPlayerStatus.Idle && this.calls.has(ch.guild.id)) this.deps.restoreMusic(ch.guild.id);
    });
    const st: CallState = { guildId: ch.guild.id, textChannelId: m.groupId, conversationId: m.conversationId, ownerName: m.displayNameAtTime || "主人", textContext: this.recentText(m.conversationId), channelId: ch.id, ownerId: m.senderId, conn, player, history: [], capturing: false,
      busy: Promise.resolve(), lastActivity: Date.now(), gen: 0,
      idleTimer: setInterval(() => { if (Date.now() - st.lastActivity > 10 * 60_000) { log.info("通话 10 分钟无声，自动挂断"); this.stop(st.guildId, "idle"); } }, 30_000) };
    st.idleTimer.unref();
    this.calls.set(ch.guild.id, st);
    conn.receiver.speaking.on("start", (userId) => { if (userId === st.ownerId) this.capture(st); });
    conn.on("debug", (d) => { if (/dave|encrypt|transition|epoch|mls/i.test(d)) log.info(`voice debug: ${d.slice(0, 200)}`); });
    conn.on("stateChange", (a, b) => log.info(`语音连接 ${a.status} -> ${b.status}`));
    conn.on(VoiceConnectionStatus.Disconnected, () => { if (this.calls.get(st.guildId) === st) this.stop(st.guildId, "disconnected"); });
    log.info(`通话开始 @ ${ch.name}`);
    void this.speak(st, "I'm here, Little Moon. Talk to me.");
    return { ok: true, voice_channel_name: ch.name, note: "通话已接通，主人直接说话即可；说「挂断」或让我 voice_call stop 结束。" };
  }

  stop(guildId?: string, why = "user"): object {
    const gid = guildId ?? [...this.calls.keys()][0];
    const st = gid ? this.calls.get(gid) : undefined;
    if (!st) return { ok: false, reason: "现在没有在通话" };
    this.calls.delete(st.guildId);
    clearInterval(st.idleTimer);
    st.gen++;
    st.player.stop(true);
    st.conn.receiver.speaking.removeAllListeners("start");
    if (why !== "disconnected" && !this.deps.restoreMusic(st.guildId)) getVoiceConnection(st.guildId)?.destroy();
    log.info(`通话结束 (${why})`);
    return { ok: true, ended: true, turns: Math.floor(st.history.length / 2) };
  }

  private capture(st: CallState): void {
    if (st.capturing) return;
    st.capturing = true;
    st.lastActivity = Date.now();
    const stream = st.conn.receiver.subscribe(st.ownerId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
    const dec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    const chunks: Buffer[] = [];
    let barged = false;
    stream.on("data", (pkt: Buffer) => {
      try { chunks.push(Buffer.from(dec.decode(pkt))); } catch { /* skip bad packet */ }
      // Barge-in only after ~0.7 s of real talking, so a cough or click doesn't cut the reply off.
      if (!barged && chunks.length >= 35 && st.player.state.status !== AudioPlayerStatus.Idle) { barged = true; st.gen++; st.player.stop(true); log.info("主人插话，停止当前回复"); }
    });
    const done = () => {
      st.capturing = false;
      try { dec.delete(); } catch { /* ignore */ }
      const pcm = Buffer.concat(chunks);
      const secs = pcm.length / (48000 * 4);
      log.info(`收到一段语音 ${secs.toFixed(1)}s (${chunks.length} 包)`);
      st.lastActivity = Date.now();
      let sum = 0; const n = Math.floor(pcm.length / 2);
      for (let i = 0; i < n; i += 4) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
      const rms = Math.sqrt(sum / Math.max(1, n / 4));
      if (secs < 0.8 || rms < 300 || this.calls.get(st.guildId) !== st) { log.info(`忽略短促/很轻的声音 ${secs.toFixed(1)}s rms=${rms.toFixed(0)}`); return; }
      if (secs > 60) log.warn(`一段语音 ${secs.toFixed(1)}s，过长只取前 60s`);
      const clip = pcm.subarray(0, 60 * 48000 * 4);
      st.busy = st.busy.then(() => this.turn(st, clip)).catch((e) => log.warn(`通话一轮失败: ${(e as Error).message}`));
    };
    stream.once("end", done);
    stream.once("error", (e) => { log.warn(`收音出错: ${e.message}`); });
  }

  private persona(): string {
    try { return fs.readFileSync(this.deps.personaFile, "utf8"); } catch { return `You are κόραξ, ${OWNER_NAME_EN}'s raven.`; }
  }

  private async turn(st: CallState, pcm: Buffer): Promise<void> {
    if (this.calls.get(st.guildId) !== st) return;
    const myGen = ++st.gen;
    const t0 = Date.now();
    const wav = await toSmallWav(wavFromPcm(pcm));
    log.info(`上传音频 ${(wav.length / 1024).toFixed(0)}KB 给 ${this.deps.llm.model}`);
    const messages: any[] = [{ role: "system", content: localizeTimestamps(this.persona() + CALL_RULES + st.textContext) }, ...st.history.slice(-16),
      { role: "user", content: [{ type: "input_audio", input_audio: { data: wav.toString("base64"), format: "wav" } }] }];
    let text = "", lastErr = "";
    for (const model of this.deps.llm.model.split(",").map(x => x.trim()).filter(Boolean)) {
      try {
        const r = await fetch(new URL("chat/completions", this.deps.llm.baseUrl.replace(/\/?$/, "/")), {
          method: "POST", headers: { authorization: `Bearer ${this.deps.llm.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model, messages, temperature: 0.8 }), signal: AbortSignal.timeout(25000) });
        const j: any = await r.json().catch(() => null);
        text = j?.choices?.[0]?.message?.content ?? "";
        if (r.ok && text) { log.info(`通话模型 ${model} ${Date.now() - t0}ms`); break; }
        lastErr = `${model} HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 160)}`;
      } catch (e) { lastErr = `${model}: ${(e as Error).message}`; }
      log.warn(`通话模型失败，换下一个: ${lastErr}`);
      if (myGen !== st.gen) return;
    }
    if (!text) throw new Error(lastErr);
    const heard = text.match(/HEARD:\s*(.*)/)?.[1]?.trim() ?? "";
    let reply = text.match(/REPLY:\s*([\s\S]*)/)?.[1]?.trim() ?? "";
    if (!heard || heard === "[none]") { log.info("通话：没听到有效语音"); return; }
    reply = reply.replace(/[*_#`~>]/g, "").replace(/\p{Extended_Pictographic}/gu, "").trim();
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(reply)) reply = reply.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af，。！？、]+/g, " ").replace(/\s+/g, " ").trim();
    const act = text.match(/ACTION:\s*(play|skip|pause|resume|stop_music)\s*(.*)/i);
    reply = reply.replace(/\n?ACTION:[\s\S]*$/i, "").trim();
    if (act && this.deps.music) void this.musicAction(st, act[1]!.toLowerCase(), act[2]!.trim());
    log.info(`通话 听到「${heard.slice(0, 120)}」 回复「${reply.slice(0, 160)}」 LLM ${Date.now() - t0}ms`);
    st.history.push({ role: "user", content: `(voice) ${heard}` }, { role: "assistant", content: reply });
    this.record(st, st.ownerId, heard);
    this.record(st, this.deps.selfId?.() ?? "self", reply);
    if (!reply || myGen !== st.gen) return; // she started talking again meanwhile
    await this.speak(st, reply, myGen);
  }

  /** Last text messages of the conversation the call was started from, so the call picks up where chat left off. */
  private recentText(conversationId: string): string {
    const db = this.deps.db;
    if (!db) return "";
    try {
      const self = this.deps.selfId?.();
      const rows = db.recentMessages(conversationId, 14).reverse().filter(r => r.status === "active" && r.text_content.trim());
      if (!rows.length) return "";
      const lines = rows.map(r => `${r.sender_id === self ? "you" : (r.sender_name || "her")}: ${r.text_content.replace(/\s+/g, " ").slice(0, 200)}`);
      return `\n\nRecent text chat right before this call (for context; she may refer to it):\n${lines.join("\n")}`;
    } catch { return ""; }
  }

  /** Write one spoken turn into the shared message history (marked call-*, skipped by reply limits). */
  private record(st: CallState, senderId: string, text: string): void {
    const db = this.deps.db;
    if (!db || !text.trim()) return;
    try {
      const id = `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const body = `🎙️(语音通话) ${text}`;
      db.insertMessage({ eventKey: `${this.deps.accountId}:${st.conversationId}:message:${id}`, accountId: this.deps.accountId, providerId: "discord",
        conversationId: st.conversationId, groupId: st.textChannelId, messageId: id, senderId,
        displayNameAtTime: senderId === st.ownerId ? st.ownerName : "（你自己）", sentAt: now, receivedAt: now,
        segments: [{ type: "text", data: { text: body } }] as any, textContent: body, status: "active", origin: "live" });
    } catch (e) { log.warn(`通话记录写入失败: ${(e as Error).message}`); }
  }

  private async musicAction(st: CallState, action: string, query: string): Promise<void> {
    const m = { accountId: this.deps.accountId, senderId: st.ownerId, groupId: st.textChannelId, origin: "live", status: "active",
      conversationId: st.textChannelId ? `group_${st.textChannelId}` : `private_${st.ownerId}`, segments: [] } as unknown as MessageRecord;
    try {
      const r = action === "play" ? await this.deps.music!.play(m, /^(liked|my (liked|songs|playlist)|我喜欢|红心|我的歌)/i.test(query) ? { source: "liked", mode: "now" } : { query, mode: "now" })
        : this.deps.music!.control(m, { action: action === "stop_music" ? "pause" : action });
      log.info(`通话点歌 ${action} ${query} -> ${JSON.stringify(r).slice(0, 200)}`);
      // The music player took the connection; our next reply re-subscribes us.
    } catch (e) { log.warn(`通话点歌失败: ${(e as Error).message}`); }
  }

  private async speak(st: CallState, text: string, gen = st.gen): Promise<void> {
    const t0 = Date.now();
    const r = await fetch(`${this.deps.tts.host.replace(/\/$/, "")}/v1/t2a_v2`, {
      method: "POST", headers: { authorization: `Bearer ${this.deps.tts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.deps.tts.model, text: text.slice(0, 1200), stream: false, language_boost: "English", output_format: "hex",
        voice_setting: { voice_id: this.deps.tts.voiceId, speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 24000, bitrate: 128000, format: "mp3", channel: 1 } }),
      signal: AbortSignal.timeout(30000) });
    const j: any = await r.json().catch(() => null);
    const hex: string | undefined = j?.data?.audio;
    if (!hex) { log.warn(`TTS 失败: ${JSON.stringify(j?.base_resp ?? j)?.slice(0, 200)}`); return; }
    log.info(`通话 TTS ${Date.now() - t0}ms`);
    if (gen !== st.gen || this.calls.get(st.guildId) !== st || st.capturing) return;
    st.conn.subscribe(st.player);
    st.player.play(oggFromBuffer(Buffer.from(hex, "hex")));
    st.lastActivity = Date.now();
  }

  toolsFor(m: MessageRecord): ToolDef[] {
    if (!this.allowed(m) || !this.deps.getClient()) return [];
    return [{
      name: "voice_call",
      description: "和主人在 Discord 语音频道里实时语音通话（她说话，你用固定英文男声回答）。主人说「打电话/语音通话/来语音」时用 start（她必须已在语音频道）；说「挂断/挂了/结束通话」用 stop；status 看是否在通话。通话期间放歌会暂停接管。",
      inputSchema: { type: "object", properties: { action: { type: "string", enum: ["start", "stop", "status"] } }, required: ["action"], additionalProperties: false },
      execute: async (args) => {
        const a = String(args.action);
        if (a === "start") return JSON.stringify(await this.start(m).catch((e) => ({ ok: false, reason: (e as Error).message })));
        if (a === "stop") return JSON.stringify(this.stop());
        return JSON.stringify({ in_call: this.calls.size > 0 });
      },
    }];
  }
}
