import fs from "node:fs";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import path from "node:path";
import {
  AudioPlayer, AudioPlayerStatus, NoSubscriberBehavior, VoiceConnection, VoiceConnectionStatus,
  StreamType, createAudioPlayer, createAudioResource, entersState, getVoiceConnection, joinVoiceChannel,
} from "@discordjs/voice";
import { ActionRowBuilder, ActivityType, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { Client, Guild, Message, VoiceBasedChannel } from "discord.js";

export const DEFAULT_STATUS = `在陪${OWNER_NAME}`;
export const WAITING_STATUS = `在等${OWNER_NAME}点歌`;
import type { MessageRecord, ToolDef } from "../types.js";
import { logger } from "../util/logger.js";
import { OWNER_NAME } from "../util/owner.js";

const log = logger("music");
const ffmpegBin: string = (() => { try { return (createRequire(import.meta.url)("ffmpeg-static") as string) || "ffmpeg"; } catch { return "ffmpeg"; } })();

export function oggResource(url: string, clip?: { start: number; seconds: number }) {
  // The static ffmpeg build crashes on network input (DNS in a static binary), so Node downloads and pipes into stdin.
  const ff = spawn(ffmpegBin, ["-loglevel", "error", ...(clip ? ["-ss", String(clip.start)] : []), "-i", "pipe:0", ...(clip ? ["-t", String(clip.seconds), "-af", `afade=t=out:st=${Math.max(0, clip.seconds - 1)}:d=1`] : []), "-vn", "-ac", "2", "-ar", "48000", "-c:a", "libopus", "-b:a", "128k", "-f", "ogg", "pipe:1"],
    { stdio: ["pipe", "pipe", "pipe"] });
  ff.stderr.on("data", (d) => log.warn(`ffmpeg: ${String(d).trim().slice(0, 300)}`));
  ff.on("error", (e) => log.warn(`ffmpeg 启动失败: ${e.message}`));
  ff.stdin.on("error", () => { /* player stopped early */ });
  fetch(url, { headers: { "user-agent": "Mozilla/5.0", referer: "https://music.163.com/" } }).then((r) => {
    if (!r.ok || !r.body) throw new Error(`下载失败 HTTP ${r.status}`);
    Readable.fromWeb(r.body as any).on("error", () => ff.stdin.end()).pipe(ff.stdin);
  }).catch((e) => { log.warn(`音源下载失败: ${(e as Error).message}`); ff.stdin.end(); });
  const res = createAudioResource(ff.stdout, { inputType: StreamType.OggOpus });
  res.playStream.on("close", () => { if (ff.exitCode === null) ff.kill("SIGKILL"); });
  return res;
}

/** Dominant "vivid" colour of an image: 16x16 sample via ffmpeg, hue buckets weighted by saturation, ignoring near-black/white. */
async function dominantColor(url: string): Promise<number | undefined> {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) return undefined;
  const img = Buffer.from(await r.arrayBuffer());
  const raw: Buffer = await new Promise((resolve, reject) => {
    const ff = spawn(ffmpegBin, ["-loglevel", "error", "-i", "pipe:0", "-vf", "scale=16:16", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    const out: Buffer[] = []; ff.stdout.on("data", (d) => out.push(d)); ff.on("error", reject);
    ff.on("close", (c) => c === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${c}`)));
    ff.stdin.on("error", () => {}); ff.stdin.end(img);
  });
  const buckets = new Map<number, { w: number; r: number; g: number; b: number }>();
  let fr = 0, fg = 0, fb = 0, fn = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const R = raw[i]!, G = raw[i + 1]!, B = raw[i + 2]!;
    fr += R; fg += G; fb += B; fn++;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B), v = mx / 255, sat = mx ? (mx - mn) / mx : 0;
    if (v < 0.18 || (v > 0.95 && sat < 0.1) || sat < 0.15) continue;
    let h = 0; const d = mx - mn;
    if (d) h = mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
    const key = Math.round(((h * 60 + 360) % 360) / 24);
    const w = sat * v; const bk = buckets.get(key) ?? { w: 0, r: 0, g: 0, b: 0 };
    bk.w += w; bk.r += R * w; bk.g += G * w; bk.b += B * w; buckets.set(key, bk);
  }
  const best = [...buckets.values()].sort((a, b) => b.w - a.w)[0];
  const [R, G, B] = best && best.w > 1.5 ? [best.r / best.w, best.g / best.w, best.b / best.w] : fn ? [fr / fn, fg / fn, fb / fn] : [183, 166, 245];
  return (Math.round(R) << 16) | (Math.round(G) << 8) | Math.round(B);
}

interface LyricLine { t: number; text: string; tr?: string }
function parseLrc(lrc?: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of (lrc ?? "").split("\n")) {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    if (!tags.length || !text || /^(作词|作曲|编曲|制作人|混音|母带|和声|吉他|贝斯|鼓|录音|监制|出品|发行|OP|SP|Lyricist|Composer|Arranger|Producer)\s*[:：]/i.test(text)) continue;
    for (const m of tags) out.set(Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000), text);
  }
  return out;
}

interface Track { id: number; name: string; artists: string; album?: string; durationMs?: number; cover?: string; color?: number; lyric?: LyricLine[] }
interface GuessState { pool: Track[]; answer?: Track; round: number; score: number; tries: number; source: string }

function normTitle(x: string): string {
  return x.toLowerCase().replace(/[（(\[【].*?[）)\]】]/g, "").replace(/[\s\p{P}\p{S}]/gu, "");
}

interface GuildState { player: AudioPlayer; queue: Track[]; current?: Track; textChannelId?: string; dmUserId?: string; card?: Message; resource?: { playbackDuration: number }; ticker?: NodeJS.Timeout; clip?: boolean; lastKey?: string; guess?: GuessState }

export interface MusicDeps {
  getClient(): Client | null;
  accountId: string;
  ownerIds: string[];
  apiBase: string;          // e.g. http://127.0.0.1:3010
  cookieFile: string;       // persisted NetEase login cookie
  sendImage(target: { groupId?: string; userId: string }, base64Png: string, text: string): Promise<unknown>;
}

export class MusicService {
  private states = new Map<string, GuildState>();
  constructor(private deps: MusicDeps) {}

  private cookie(): string {
    try { return fs.readFileSync(this.deps.cookieFile, "utf8").trim(); } catch { return ""; }
  }

  private async api(p: string, params: Record<string, string | number | boolean> = {}): Promise<any> {
    const u = new URL(p, this.deps.apiBase);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    u.searchParams.set("randomCNIP", "true");
    u.searchParams.set("timestamp", String(Date.now()));
    const c = this.cookie();
    const res = await fetch(u, { method: c ? "POST" : "GET", headers: c ? { "content-type": "application/json" } : {},
      body: c ? JSON.stringify({ cookie: c }) : undefined, signal: AbortSignal.timeout(20000) });
    return res.json();
  }

  private allowed(m: MessageRecord): boolean {
    return m.accountId === this.deps.accountId && m.origin === "live" && m.status === "active" && this.deps.ownerIds.includes(m.senderId);
  }

  /** Find the voice channel the requester is sitting in (current guild first, then any guild). */
  private findVoice(m: MessageRecord): VoiceBasedChannel | null {
    const client = this.deps.getClient();
    if (!client) return null;
    const guilds: Guild[] = [];
    if (m.groupId) { const ch = client.channels.cache.get(m.groupId); if (ch && "guild" in ch && ch.guild) guilds.push(ch.guild as Guild); }
    for (const g of client.guilds.cache.values()) if (!guilds.includes(g)) guilds.push(g);
    for (const g of guilds) { const vs = g.voiceStates.cache.get(m.senderId); if (vs?.channel) return vs.channel; }
    return null;
  }

  private state(guild: Guild): GuildState {
    let s = this.states.get(guild.id);
    if (s) return s;
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    s = { player, queue: [] };
    const st = s;
    player.on(AudioPlayerStatus.Idle, () => { if (st.clip) { st.clip = false; return; } st.current = undefined; void this.next(guild.id); });
    player.on("error", (e) => { log.warn(`播放出错: ${e.message}`); });
    player.on("stateChange", (a, b) => {
      log.info(`播放器 ${a.status} -> ${b.status}`);
      if ((a.status === AudioPlayerStatus.Paused) !== (b.status === AudioPlayerStatus.Paused)) { void this.refreshCard(guild.id); this.updatePresence(); }
    });
    this.states.set(guild.id, s);
    return s;
  }

  private async songUrl(id: number): Promise<{ url?: string; reason?: string; trial?: boolean }> {
    for (const level of ["exhigh", "standard"]) {
      const r = await this.api("/song/url/v1", { id, level });
      const d = r?.data?.[0];
      if (d?.url) return { url: d.url, trial: !!d.freeTrialInfo };
    }
    return { reason: this.cookie() ? "这首歌当前账号没有播放权限（可能需要黑胶VIP或无版权）" : "这首歌需要登录网易云才能播放，可用 netease_login 扫码登录" };
  }

  private async next(guildId: string): Promise<void> {
    const s = this.states.get(guildId);
    if (!s) return;
    const t = s.queue.shift();
    if (!t) {
      this.updatePresence();
      void this.retireCard(guildId, "播放结束");
      // queue finished: leave after 3 minutes idle
      setTimeout(() => { const st = this.states.get(guildId); if (st && !st.current && st.queue.length === 0) { getVoiceConnection(guildId)?.destroy(); this.updatePresence(); } }, 180000).unref();
      return;
    }
    const u = await this.songUrl(t.id);
    if (!u.url) { log.warn(`跳过 ${t.name}: ${u.reason}`); return this.next(guildId); }
    s.current = t;
    await this.enrich(t).catch((e) => log.warn(`封面/主色获取失败: ${(e as Error).message}`));
    log.info(`播放 ${t.name} - ${t.artists}`);
    const res = oggResource(u.url); s.resource = res;
    s.player.play(res);
    this.presenceFrame = 0;
    this.updatePresence();
    void this.announce(guildId);
  }

  // ---------- 正在听 状态 + 播放卡片 ----------
  /** Fill in cover/duration/artist for tracks queued by bare ID, then pull the cover's dominant colour. */
  private async enrich(t: Track): Promise<void> {
    if (!t.cover || !t.durationMs || !t.artists) {
      const d = (await this.api("/song/detail", { ids: t.id }))?.songs?.[0];
      if (d) {
        t.cover ||= d.al?.picUrl; t.durationMs ||= d.dt; t.album ||= d.al?.name;
        if (!t.artists) t.artists = (d.ar ?? []).map((a: any) => a.name).join("/");
        if (t.name === String(t.id) && d.name) t.name = d.name;
      }
    }
    if (t.cover) t.cover = t.cover.replace(/^http:/, "https:");
    if (t.cover && t.color === undefined) t.color = await dominantColor(`${t.cover}?param=64y64`).catch(() => undefined);
    if (!t.lyric) {
      const l = await this.api("/lyric", { id: t.id }).catch(() => null);
      const main = parseLrc(l?.lrc?.lyric), tr = parseLrc(l?.tlyric?.lyric);
      t.lyric = [...main.entries()].sort((a, b) => a[0] - b[0]).map(([ms, text]) => ({ t: ms, text, tr: tr.get(ms) }));
    }
  }


  private statusFile(): string { return path.join(path.dirname(this.deps.cookieFile), "status.txt"); }
  idleStatus(): string {
    try { return fs.readFileSync(this.statusFile(), "utf8").trim() || DEFAULT_STATUS; } catch { return DEFAULT_STATUS; }
  }
  setStatus(text: string): object {
    const t = text.trim().slice(0, 128);
    if (!t || /^(默认|恢复默认|reset|default)$/i.test(t)) { try { fs.unlinkSync(this.statusFile()); } catch { /* none */ } }
    else fs.writeFileSync(this.statusFile(), t);
    this.updatePresence();
    const playing = [...this.states.values()].some(x => x.current && x.player.state.status !== AudioPlayerStatus.Paused);
    return { ok: true, status: this.idleStatus(), note: playing ? "现在在放歌，状态显示正在听；离开语音频道后会显示这个" : "离开语音频道时显示这个" };
  }

  private presenceFrame = 0;
  private presenceTimer?: NodeJS.Timeout;

  updatePresence(): void {
    const user = this.deps.getClient()?.user;
    if (!user) return;
    const playing = [...this.states.values()].find(x => x.current && x.player.state.status !== AudioPlayerStatus.Paused);
    if (playing?.current) {
      // Rotate every 20 s: the song itself, then queue facts, then a line about her.
      const t = playing.current, q = playing.queue;
      const frames: { name: string; state?: string; type: ActivityType }[] = [
        { name: `${t.name} - ${t.artists}`.slice(0, 120), type: ActivityType.Listening },
        ...(q.length ? [{ name: "custom", state: `队列还有 ${q.length} 首歌`, type: ActivityType.Custom },
          { name: "custom", state: `下一首：${q[0]!.name}${q[0]!.artists ? ` - ${q[0]!.artists}` : ""}`.slice(0, 128), type: ActivityType.Custom }] : []),
        { name: "custom", state: `在陪${OWNER_NAME}听歌`, type: ActivityType.Custom },
      ];
      const f = frames[this.presenceFrame % frames.length]!;
      user.setPresence({ status: "online", activities: [f.type === ActivityType.Custom ? { name: "custom", state: f.state!, type: f.type } : { name: f.name, type: f.type }] });
      if (!this.presenceTimer) this.presenceTimer = setInterval(() => { this.presenceFrame++; this.updatePresence(); }, 20000);
      return;
    }
    if (this.presenceTimer) { clearInterval(this.presenceTimer); this.presenceTimer = undefined; }
    this.presenceFrame = 0;
    {
      const paused = [...this.states.values()].find(x => x.current && x.player.state.status === AudioPlayerStatus.Paused);
      const inVoice = [...this.states.keys()].some(g => getVoiceConnection(g));
      const state = paused?.current ? `已暂停 · ${paused.current.name}`.slice(0, 128) : inVoice ? WAITING_STATUS : this.idleStatus();
      user.setPresence({ status: "online", activities: [{ name: "custom", state, type: ActivityType.Custom }] });
    }
  }

  private cardPayload(guildId: string, s: GuildState, ended?: string) {
    const t = s.current;
    const paused = s.player.state.status === AudioPlayerStatus.Paused;
    const avatar = this.deps.getClient()?.user?.displayAvatarURL({ size: 64 }) ?? undefined;
    const fmt = (ms: number) => { const x = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`; };
    const e = new EmbedBuilder().setColor(t?.color ?? 0xb7a6f5);
    if (ended || !t) e.setAuthor({ name: `♪ ${ended ?? "没有在放歌"}`, iconURL: avatar });
    else {
      const pos = s.resource?.playbackDuration ?? 0;
      let bar = fmt(pos);
      if (t.durationMs) {
        const n = 16, k = Math.min(n - 1, Math.floor((pos / t.durationMs) * n));
        bar = `${fmt(pos)}  ${"━".repeat(k)}●${"─".repeat(n - 1 - k)}  ${fmt(t.durationMs)}`;
      }
      e.setAuthor({ name: paused ? "⏸ 已暂停" : "♪ 正在播放", iconURL: avatar })
        .setTitle(t.name.slice(0, 250))
        .setURL(`https://music.163.com/song?id=${t.id}`)
        .setDescription(`${[t.artists, t.album].filter(Boolean).join(" · ").slice(0, 300)}\n\n${this.lyricBlock(t, pos)}${bar}`)
        .setFooter({ text: `接下来：${s.queue[0]?.name ?? "队列已空"}${s.queue.length > 1 ? `（还有 ${s.queue.length - 1} 首）` : ""}` })
        .setTimestamp();
      if (t.cover) e.setImage(`${t.cover}?param=800y800`);
    }
    const disabled = !!ended || !t;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`music:toggle:${guildId}`).setLabel(paused ? "▶\uFE0E 继续" : "❚❚ 暂停").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`music:skip:${guildId}`).setLabel("▶▶ 下一首").setStyle(ButtonStyle.Secondary).setDisabled(disabled || s.queue.length === 0),
      new ButtonBuilder().setCustomId(`music:stop:${guildId}`).setLabel("■ 停止").setStyle(ButtonStyle.Danger).setDisabled(disabled),
    );
    return { embeds: [e], components: [row] };
  }

  /** What the card would show now; edit only when it changes (lyric line or progress cell). */
  private cardKey(s: GuildState): string {
    const t = s.current, pos = s.resource?.playbackDuration ?? 0;
    if (!t) return "";
    const li = t.lyric?.length ? t.lyric.filter(l => l.t <= pos + 400).length : -1;
    const cell = t.durationMs ? Math.floor((pos / t.durationMs) * 16) : Math.floor(pos / 15000);
    return `${t.id}|${li}|${cell}`;
  }

  private lyricBlock(t: Track, pos: number): string {
    const L = t.lyric;
    if (!L?.length) return "";
    let i = -1;
    for (let k = 0; k < L.length; k++) { if (L[k]!.t <= pos + 400) i = k; else break; }
    const esc = (x: string) => x.replace(/([*_~`|>\\])/g, "\\$1").slice(0, 120);
    const lines: string[] = [];
    if (i >= 1) lines.push(`-# ${esc(L[i - 1]!.text)}`);
    if (i >= 0) { lines.push(`### ${esc(L[i]!.text)}`); if (L[i]!.tr) lines.push(esc(L[i]!.tr!)); }
    else lines.push("-# ♪ 前奏中…");
    if (L[i + 1]) lines.push(`-# ${esc(L[i + 1]!.text)}`);
    return lines.join("\n") + "\n\n";
  }

  /** Move the progress bar (every 15 s) and lyrics (every 3 s when the song has them) while a card is showing. */
  private tick(guildId: string, s: GuildState): void {
    if (s.ticker) clearInterval(s.ticker);
    s.ticker = setInterval(() => {
      if (!s.card || !s.current) { clearInterval(s.ticker!); s.ticker = undefined; return; }
      if (s.player.state.status !== AudioPlayerStatus.Playing) return;
      const key = this.cardKey(s);
      if (key === s.lastKey) return;
      s.lastKey = key;
      void s.card.edit(this.cardPayload(guildId, s)).catch(() => {});
    }, s.current?.lyric?.length ? 3000 : 15000);
    s.ticker.unref();
  }

  private async announce(guildId: string): Promise<void> {
    const s = this.states.get(guildId); const client = this.deps.getClient();
    if (!s || !client) return;
    this.ensureButtons(client);
    try {
      if (s.card) { const old = s.card; s.card = undefined; await old.delete().catch(() => {}); }
      const ch = s.textChannelId ? await client.channels.fetch(s.textChannelId).catch(() => null)
        : s.dmUserId ? await (await client.users.fetch(s.dmUserId)).createDM() : null;
      if (!ch || !("send" in ch) || typeof ch.send !== "function") return;
      s.card = await (ch as any).send(this.cardPayload(guildId, s));
      this.tick(guildId, s);
    } catch (e) { log.warn(`播放卡片发送失败: ${(e as Error).message}`); }
  }

  private async refreshCard(guildId: string): Promise<void> {
    const s = this.states.get(guildId);
    if (s?.card && s.current) await s.card.edit(this.cardPayload(guildId, s)).catch(() => {});
  }

  private async retireCard(guildId: string, text: string): Promise<void> {
    const s = this.states.get(guildId);
    if (!s?.card) return;
    const c = s.card; s.card = undefined;
    await c.edit(this.cardPayload(guildId, s, text)).catch(() => {});
  }

  private buttonsReady = false;
  private ensureButtons(client: Client): void {
    if (this.buttonsReady) return;
    this.buttonsReady = true;
    client.on("interactionCreate", async (i) => {
      if (!i.isButton() || !i.customId.startsWith("music:")) return;
      const [, action, gid] = i.customId.split(":");
      if (!this.deps.ownerIds.includes(i.user.id)) { await i.reply({ content: "只有主人能点这个。", ephemeral: true }).catch(() => {}); return; }
      const s = gid ? this.states.get(gid) : undefined;
      if (!s || !s.current) { await i.update(this.cardPayload(gid ?? "", s ?? { player: createAudioPlayer(), queue: [] }, "播放结束")).catch(() => {}); return; }
      try {
        if (action === "toggle") {
          if (s.player.state.status === AudioPlayerStatus.Paused) s.player.unpause(); else s.player.pause();
          await i.update(this.cardPayload(gid!, s));
          this.updatePresence();
        } else if (action === "skip") {
          await i.deferUpdate(); s.player.stop(true);
        } else if (action === "stop") {
          s.queue = []; s.current = undefined;
          if (s.card?.id === i.message.id) s.card = undefined;
          await i.update(this.cardPayload(gid!, s, "已停止"));
          s.player.stop(true); getVoiceConnection(gid!)?.destroy(); this.updatePresence();
        }
      } catch (e) { log.warn(`按钮处理失败: ${(e as Error).message}`); }
    });
  }

  private async search(q: string, limit = 5): Promise<Track[]> {
    const r = await this.api("/cloudsearch", { keywords: q, limit, type: 1 });
    return (r?.result?.songs ?? []).map((x: any) => ({ id: x.id, name: x.name, artists: (x.ar ?? []).map((a: any) => a.name).join("/"), album: x.al?.name, durationMs: x.dt, cover: x.al?.picUrl }));
  }

  /** Her own NetEase playlists; the first one is 「我喜欢的音乐」. */
  private async myPlaylists(): Promise<{ id: number; name: string; count: number }[]> {
    const uid = (await this.api("/login/status"))?.data?.profile?.userId;
    if (!uid) return [];
    const r = await this.api("/user/playlist", { uid, limit: 100 });
    return (r?.playlist ?? []).map((p: any) => ({ id: p.id, name: p.name, count: p.trackCount ?? 0, mine: p.userId === uid }))
      .sort((a: any, b: any) => Number(b.mine) - Number(a.mine));
  }

  private async playlist(id: string, limit = 200): Promise<Track[]> {
    const r = await this.api("/playlist/track/all", { id, limit });
    return (r?.songs ?? []).map((x: any) => ({ id: x.id, name: x.name, artists: (x.ar ?? []).map((a: any) => a.name).join("/"), album: x.al?.name, durationMs: x.dt, cover: x.al?.picUrl }));
  }

  private async join(ch: VoiceBasedChannel): Promise<VoiceConnection> {
    let conn = getVoiceConnection(ch.guild.id);
    if (!conn || conn.joinConfig.channelId !== ch.id) {
      conn = joinVoiceChannel({ channelId: ch.id, guildId: ch.guild.id, adapterCreator: ch.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
    }
    await entersState(conn, VoiceConnectionStatus.Ready, 20000);
    conn.subscribe(this.state(ch.guild).player);
    return conn;
  }

  async play(m: MessageRecord, args: Record<string, unknown>): Promise<object> {
    const ch = this.findVoice(m);
    if (!ch) return { ok: false, reason: "主人现在不在任何语音频道里。请先进入服务器的语音频道，再让我放歌。" };
    const query = String(args.query ?? "").trim();
    const mode = args.mode === "queue" ? "queue" : "now";
    let tracks: Track[] = [];
    const source = String(args.source ?? "search");
    let pl: RegExpMatchArray | true | null = query.match(/playlist\?id=(\d+)|^歌单[:：]?\s*(\d+)$/);
    if (source === "liked" || source === "my_playlist") {
      const mine = await this.myPlaylists();
      if (!mine.length) return { ok: false, reason: "网易云没登录或拿不到你的歌单" };
      const want = source === "liked" ? mine[0] : mine.find(p => p.name === query) ?? mine.find(p => query && (p.name.includes(query) || query.includes(p.name)));
      if (!want) return { ok: false, reason: `你的歌单里没有「${query}」`, her_playlists: mine.slice(0, 30).map(p => `${p.name}（${p.count}首）`) };
      tracks = await this.playlist(String(want.id), 1000);
      if (args.shuffle !== false) tracks.sort(() => Math.random() - 0.5);
      pl = true;
      if (!tracks.length) return { ok: false, reason: `歌单「${want.name}」是空的` };
    }
    else if (pl) tracks = await this.playlist((pl[1] ?? pl[2])!);
    else if (/^\d{5,}$/.test(query)) tracks = [{ id: Number(query), name: query, artists: "" }];
    else { const found = await this.search(query, 1); tracks = found.slice(0, 1); }
    if (!tracks.length) return { ok: false, reason: `网易云没搜到「${query}」` };
    if (!pl) { const t0 = tracks[0]!; const u = await this.songUrl(t0.id); if (!u.url) return { ok: false, song: t0, reason: u.reason }; }
    await this.join(ch);
    const s = this.state(ch.guild);
    if (m.groupId) { s.textChannelId = m.groupId; s.dmUserId = undefined; } else { s.textChannelId = undefined; s.dmUserId = m.senderId; }
    if (mode === "now") { s.queue.unshift(...tracks); const busy = s.player.state.status !== AudioPlayerStatus.Idle; s.current = undefined; if (busy) s.player.stop(true); else await this.next(ch.guild.id); }
    else { s.queue.push(...tracks); if (!s.current && s.player.state.status === AudioPlayerStatus.Idle) await this.next(ch.guild.id); }
    return { ok: true, voice_channel_name: ch.name, mode, added: tracks.slice(0, 5).map(t => `${t.name} - ${t.artists}`), total_added: tracks.length, queue_length: s.queue.length };
  }

  control(m: MessageRecord, args: Record<string, unknown>): object {
    const ch = this.findVoice(m);
    const gid = ch?.guild.id ?? [...this.states.keys()][0];
    const s = gid ? this.states.get(gid) : undefined;
    const action = String(args.action);
    if (!s) return { ok: false, reason: "现在没有在放歌" };
    switch (action) {
      case "pause": s.player.pause(); break;
      case "resume": s.player.unpause(); break;
      case "skip": s.player.stop(true); break;
      case "stop": s.queue = []; s.current = undefined; void this.retireCard(gid!, "已停止"); s.player.stop(true); getVoiceConnection(gid!)?.destroy(); this.updatePresence(); break;
      case "status": break;
      default: return { ok: false, reason: "未知操作" };
    }
    return { ok: true, action, now_playing: s.current ? `${s.current.name} - ${s.current.artists}` : null, paused: s.player.state.status === AudioPlayerStatus.Paused,
      queue: s.queue.slice(0, 10).map(t => `${t.name} - ${t.artists}`), queue_length: s.queue.length };
  }

  private qrKey?: string;
  async login(m: MessageRecord, args: Record<string, unknown>): Promise<object> {
    if (args.action === "status") {
      const r = await this.api("/login/status");
      const p = r?.data?.profile;
      return p ? { logged_in: true, nickname: p.nickname, vip: r?.data?.account?.vipType ?? null } : { logged_in: false };
    }
    if (args.action === "check") {
      if (!this.qrKey) return { ok: false, reason: "还没生成二维码" };
      const r = await this.api("/login/qr/check", { key: this.qrKey, noCookie: true });
      if (r?.code === 803 && r.cookie) {
        fs.mkdirSync(path.dirname(this.deps.cookieFile), { recursive: true });
        fs.writeFileSync(this.deps.cookieFile, r.cookie, { mode: 0o600 });
        this.qrKey = undefined;
        return { ok: true, status: "登录成功" };
      }
      return { ok: false, code: r?.code, status: r?.message ?? "等待扫码" };
    }
    const k = await this.api("/login/qr/key");
    this.qrKey = k?.data?.unikey;
    const q = await this.api("/login/qr/create", { key: this.qrKey!, qrimg: true });
    const img = String(q?.data?.qrimg ?? "").replace(/^data:image\/\w+;base64,/, "");
    if (!img) return { ok: false, reason: "二维码生成失败" };
    await this.deps.sendImage({ groupId: m.groupId, userId: m.senderId }, img, "用网易云音乐 App 扫这个码登录，扫完告诉我。");
    return { ok: true, status: "二维码已发出，等主人扫码后调用 action=check" };
  }

  // ---------- 猜歌 ----------
  private async guessPool(source: string): Promise<Track[]> {
    const src = source.trim();
    if (!src || /^(liked|我喜欢|红心|收藏)$/i.test(src)) {
      const uid = (await this.api("/login/status"))?.data?.profile?.userId;
      if (!uid) throw new Error("网易云没登录，拿不到「我喜欢」歌单");
      const ids: number[] = (await this.api("/likelist", { uid }))?.ids ?? [];
      const pick = ids.sort(() => Math.random() - 0.5).slice(0, 40);
      if (!pick.length) return [];
      const d = await this.api("/song/detail", { ids: pick.join(",") });
      return (d?.songs ?? []).map((x: any) => ({ id: x.id, name: x.name, artists: (x.ar ?? []).map((a: any) => a.name).join("/"), album: x.al?.name, durationMs: x.dt, cover: x.al?.picUrl }));
    }
    const pl = src.match(/playlist\?id=(\d+)|^歌单[:：]?\s*(\d+)$/);
    const list = pl ? await this.playlist((pl[1] ?? pl[2])!) : await this.search(src, 30);
    return list.sort(() => Math.random() - 0.5);
  }

  private async guessRound(ch: VoiceBasedChannel, g: GuessState, seconds = 10): Promise<object> {
    const s = this.state(ch.guild);
    for (let tries = 0; tries < 6 && g.pool.length; tries++) {
      const t = g.pool.shift()!;
      const u = await this.songUrl(t.id);
      if (!u.url || u.trial) continue;
      g.answer = t; g.round++; g.tries = 0;
      await this.join(ch);
      s.clip = s.player.state.status !== AudioPlayerStatus.Idle;
      s.player.play(oggResource(u.url, { start: 0, seconds }));
      s.clip = true;
      log.info(`猜歌第 ${g.round} 轮：${t.name} - ${t.artists}`);
      return { ok: true, round: g.round, score: g.score, clip_seconds: seconds, note: "前奏已在语音频道播放。不要说出歌名或歌手，等主人猜；她猜了就用 check。" };
    }
    return { ok: false, reason: "歌单里没有能播放的歌了", score: g.score, rounds: g.round };
  }

  async guess(m: MessageRecord, args: Record<string, unknown>): Promise<object> {
    const ch = this.findVoice(m);
    const action = String(args.action);
    const s = ch ? this.state(ch.guild) : undefined;
    if (action === "start") {
      if (!ch || !s) return { ok: false, reason: "主人先进语音频道，才能听前奏。" };
      const pool = await this.guessPool(String(args.source ?? ""));
      if (!pool.length) return { ok: false, reason: "没找到可以猜的歌" };
      if (s.current) { s.clip = true; s.player.stop(true); s.queue.unshift(s.current); s.current = undefined; this.updatePresence(); void this.retireCard(ch.guild.id, "猜歌中，音乐先停一下"); }
      s.guess = { pool, round: 0, score: 0, tries: 0, source: String(args.source ?? "我喜欢") };
      return this.guessRound(ch, s.guess);
    }
    const g = s?.guess;
    if (!ch || !s || !g) return { ok: false, reason: "现在没有在猜歌，用 start 开始" };
    const a = g.answer!;
    const reveal = { title: a.name, artist: a.artists, album: a.album };
    switch (action) {
      case "check": {
        const guessText = normTitle(String(args.guess ?? ""));
        const title = normTitle(a.name);
        const ok = guessText.length > 0 && (guessText === title || (guessText.length >= 2 && (title.includes(guessText) && guessText.length >= title.length * 0.6 || guessText.includes(title))));
        if (ok) { g.score++; return { correct: true, answer: reveal, score: g.score, round: g.round, note: "猜对了，可以夸她，然后用 next 进下一轮" }; }
        g.tries++;
        return { correct: false, tries: g.tries, note: g.tries >= 3 ? "已经错 3 次，可以给 hint 或问她要不要 reveal" : "不对，别透露答案" };
      }
      case "hint":
        g.tries++;
        return { hint: g.tries <= 2 ? `歌手：${a.artists}` : `歌名 ${[...a.name].length} 个字，第一个字是「${[...a.name][0]}」` };
      case "replay": {
        const u = await this.songUrl(a.id);
        if (!u.url) return { ok: false, reason: "这首拿不到音源了" };
        s.clip = s.player.state.status !== AudioPlayerStatus.Idle;
        s.player.play(oggResource(u.url, { start: 0, seconds: 20 })); s.clip = true;
        return { ok: true, clip_seconds: 20 };
      }
      case "reveal": return { answer: reveal, score: g.score, round: g.round };
      case "next": return this.guessRound(ch, g);
      case "end": {
        s.guess = undefined; s.clip = s.player.state.status !== AudioPlayerStatus.Idle; s.player.stop(true);
        const resume = s.queue.length > 0;
        if (resume) setTimeout(() => { s.clip = false; void this.next(ch.guild.id); }, 500);
        return { ended: true, score: g.score, rounds: g.round, last_answer: reveal, music_resumed: resume };
      }
      default: return { ok: false, reason: "未知操作" };
    }
  }

  /** Hand the voice connection back to the music player (after a call). */
  resubscribe(guildId: string): boolean {
    const s = this.states.get(guildId); const conn = getVoiceConnection(guildId);
    if (!s || !conn || (!s.current && s.queue.length === 0)) return false;
    conn.subscribe(s.player);
    return true;
  }

  toolsFor(m: MessageRecord): ToolDef[] {
    if (!this.allowed(m) || !this.deps.getClient()) return [];
    return [
      { name: "set_status", description: "修改你（Discord 机器人）平时头像旁边显示的自定义状态文字，最多128字，主人说改成什么就原样写。text=默认 恢复成「" + DEFAULT_STATUS + "」。放歌时自动显示正在听的歌，歌停了但还在语音频道时显示「" + WAITING_STATUS + "」，这两个不受这里影响。",
        inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 128 } }, required: ["text"], additionalProperties: false },
        execute: async (args) => JSON.stringify(this.setStatus(String(args.text ?? ""))) },
      { name: "music_play", description: "在 Discord 语音频道用网易云音乐放歌。主人必须已在某个语音频道里，机器人会自动加入主人所在频道。query 可以是歌名/歌手、网易云歌曲ID、或歌单链接。主人说「放我的歌」「放我喜欢的」「随便放点我歌单里的」就用 source=liked；说某个她自己的歌单名就用 source=my_playlist。mode=now 立即播放，queue 加到队列末尾。",
        inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 300 }, mode: { type: "string", enum: ["now", "queue"] },
          source: { type: "string", enum: ["search", "liked", "my_playlist"], description: "search=按 query 搜歌（默认）；liked=放主人网易云「我喜欢的音乐」红心歌单（不需要 query）；my_playlist=放主人自己的某个歌单，query 填歌单名" },
          shuffle: { type: "boolean", description: "放她的歌单时是否随机，默认随机" } }, additionalProperties: false },
        execute: async (args) => JSON.stringify(await this.play(m, args).catch((e) => ({ ok: false, reason: (e as Error).message }))) },
      { name: "music_control", description: "控制 Discord 里正在放的音乐：pause 暂停、resume 继续、skip 下一首、stop 停止并离开语音频道、status 查看正在放什么和队列。",
        inputSchema: { type: "object", properties: { action: { type: "string", enum: ["pause", "resume", "skip", "stop", "status"] } }, required: ["action"], additionalProperties: false },
        execute: async (args) => JSON.stringify(this.control(m, args)) },
      { name: "guess_song", description: "猜歌游戏：在 Discord 语音频道放 10 秒前奏让主人猜。start 开始（source 可选：默认「我喜欢」红心歌单，也可以是歌手/关键词/歌单链接）；主人说出猜测就用 check（guess=她说的歌名），绝不能自己说出答案；hint 给提示；replay 重放 20 秒；reveal 公布答案；next 下一轮；end 结束并恢复之前的音乐。",
        inputSchema: { type: "object", properties: { action: { type: "string", enum: ["start", "check", "hint", "replay", "reveal", "next", "end"] }, source: { type: "string", maxLength: 300 }, guess: { type: "string", maxLength: 200 } }, required: ["action"], additionalProperties: false },
        execute: async (args) => JSON.stringify(await this.guess(m, args).catch((e) => ({ ok: false, reason: (e as Error).message }))) },
      { name: "netease_login", description: "网易云音乐账号登录。action=qr 生成登录二维码发给主人；主人说扫好了再用 check 确认；status 查看当前登录状态。",
        inputSchema: { type: "object", properties: { action: { type: "string", enum: ["qr", "check", "status"] } }, required: ["action"], additionalProperties: false },
        execute: async (args) => JSON.stringify(await this.login(m, args).catch((e) => ({ ok: false, reason: (e as Error).message }))) },
    ];
  }
}
