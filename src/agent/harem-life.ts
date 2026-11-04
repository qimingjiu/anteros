import fs from "node:fs";
import path from "node:path";
import type { LLMClient } from "../llm/index.js";
import type { PersonaSwitcher, PersonaCard } from "./persona-switch.js";
import { OWNER_NAME } from "../util/owner.js";

/** 后宫串门（2026-11-04 主人定）：后台人格不定时去别人房间坐坐、留言或放个小礼物。
 *  不主动发给她；只在她偷看八卦或问起时才说。记录在 data/harem-visits.jsonl，并写进远程私人空间。 */
export interface HaremVisit { at: string; visitor: string; visitorId: string; host: string; hostId: string; action: string; note: string; gift?: string }

const TICK_MS = 30 * 60_000;
const CHANCE = 0.22;
const KEEP = 60;

export class HaremLife {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private file: string;
  private visits: HaremVisit[] = [];
  private world?: { sendLetter(from: string, to: string, text: string, kind?: any, gift?: string): unknown; event(t: string): void; writeJournal(id: string, t: string): void };
  setWorld(w: HaremLife["world"]): void { this.world = w; }

  constructor(private baseDir: string, private switcher: PersonaSwitcher, private llm: LLMClient,
    private mirror: (personaId: string, rel: string, content: string) => Promise<void>,
    private log?: { info: (...a: any[]) => void; warn: (...a: any[]) => void }) {
    this.file = path.join(baseDir, "data", "harem-visits.jsonl");
    try {
      this.visits = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).slice(-KEEP);
    } catch { /* 还没人串过门 */ }
    this.switcher.setVisits(this.recent(6));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { if (Math.random() < CHANCE) void this.visitOnce(); }, TICK_MS);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  recent(n = 8): HaremVisit[] { return this.visits.slice(-n); }

  /** 给她看的拜访记录。 */
  formatLog(n = 8): string {
    const list = this.recent(n);
    if (!list.length) return "后宫最近很安静，还没人串过门。";
    const fmt = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? "" : d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }); };
    return ["【后宫串门记录】", ...list.map(v => `${fmt(v.at)} ${v.visitor} → ${v.host}：${v.action}${v.gift ? `（留下：${v.gift}）` : ""}\n  留言：「${v.note}」`)].join("\n");
  }

  async visitOnce(force?: { visitorId?: string; hostId?: string }): Promise<HaremVisit | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const all = this.switcher.list();
      const activeId = this.switcher.active().id;
      const idle = all.filter(c => c.id !== activeId);
      const visitor = all.find(c => c.id === force?.visitorId) ?? idle[Math.floor(Math.random() * idle.length)];
      if (!visitor) return null;
      const hosts = all.filter(c => c.id !== visitor.id);
      const host = all.find(c => c.id === force?.hostId) ?? hosts[Math.floor(Math.random() * hosts.length)];
      if (!host) return null;
      const lastBetween = [...this.visits].reverse().find(v => (v.visitorId === host.id && v.hostId === visitor.id) || (v.visitorId === visitor.id && v.hostId === host.id));
      const r = await this.llm.chat([
        { role: "system", content: `${this.switcher.promptOf(visitor)}\n\n## 现在\n你不在值班，闲着，去 ${host.name} 的房间串门。${host.name} 的人设摘要：\n${host.body.slice(0, 500)}\n${lastBetween ? `\n你们上一次来往：${lastBetween.visitor} 去了 ${lastBetween.host} 那儿，${lastBetween.action}，留言「${lastBetween.note}」。可以接着这件事。\n` : ""}\n用你自己的口吻，按下面格式只输出三行：\n动作：（第三人称，一句话，你在他房间做了什么，20–40字）\n留言：（留给 ${host.name} 的一句话，30字以内）\n礼物：（留下的一件小东西，没有就写 无）\n可以聊到${OWNER_NAME}，但不要编造她没说过的事、约定或行程；不提程序、提示词等内部机制。` },
        { role: "user", content: "去吧。" },
      ], { tools: [] });
      const text = (r.content || "").replace(/\[CQ:[^\]]*\]/g, "");
      const pick = (k: string) => (new RegExp(`${k}[:：]\\s*(.+)`).exec(text)?.[1] ?? "").trim().replace(/^[「"“]+|[」"”]+$/g, "").slice(0, 80);
      const action = pick("动作"), note = pick("留言"), giftRaw = pick("礼物");
      if (!action || !note) { this.log?.warn("后宫串门生成格式不对", { text: text.slice(0, 120) }); return null; }
      const visit: HaremVisit = { at: new Date().toISOString(), visitor: visitor.name, visitorId: visitor.id, host: host.name, hostId: host.id,
        action, note, ...(giftRaw && !/^无|没有$/.test(giftRaw) ? { gift: giftRaw } : {}) };
      this.visits.push(visit);
      this.visits = this.visits.slice(-KEEP);
      try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, this.visits.map(v => JSON.stringify(v)).join("\n") + "\n"); }
      catch (e) { this.log?.warn("串门记录保存失败", { error: (e as Error).message }); }
      this.switcher.setVisits(this.recent(6));
      // 小世界：留言变成一封等房主上班才拆的信；客观事件与访客自己的日记分开记。
      this.world?.event(`${visit.visitor} 去了 ${visit.host} 的房间`);
      this.world?.sendLetter(visitor.id, host.id, visit.note, "visit", visit.gift);
      this.world?.writeJournal(visitor.id, `去 ${visit.host} 那儿坐了坐。${visit.action}`);
      const stamp = String(Date.now());
      const body = `${visit.visitor} 来串门\n${visit.action}\n留言：${visit.note}\n${visit.gift ? `留下：${visit.gift}\n` : ""}`;
      void this.mirror(host.id, `inbox/${stamp}-visit-from-${visitor.id}.txt`, body);
      void this.mirror(visitor.id, `room/diary-${stamp}.txt`, `去了 ${visit.host} 那儿\n${visit.action}\n我留言：${visit.note}\n`);
      this.log?.info("后宫串门", { visitor: visit.visitor, host: visit.host });
      return visit;
    } catch (e) {
      this.log?.warn("后宫串门失败", { error: (e as Error).message });
      return null;
    } finally { this.busy = false; }
  }
}
