import fs from "node:fs";
import path from "node:path";
import { OWNER_NAME } from "../util/owner.js";

/** 翻牌子：主人一句话切换人格（2026-11-04 主人要求）。所有人格共用同一份记忆与聊天记录。 */
export interface PersonaCard {
  id: string;
  name: string;
  aliases: string[];
  qqNickname: string;
  body: string;
}

interface PersonaCfg { persona: { name: string; prompt: string; file: string } }

export interface PersonaSwitchResult {
  reply: string;
  changed?: PersonaCard;
}

export interface PersonaState {
  active: string;
  at?: string;
  pending?: { id: string; until: number } | null;
  handoff?: { from: string; to: string; text: string; at: string } | null;
}

export interface PersonaStateStore {
  load(): PersonaState | undefined;
  save(state: PersonaState): void;
}

interface PersonaRoomScope {
  cards: Map<string, PersonaCard>;
  sharedRules: string;
  memberIds: () => readonly string[];
  storage: PersonaStateStore;
}

const DEFAULT_ID = "koraks";

function parseCard(file: string): PersonaCard | null {
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^(\w+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  const id = meta.id || path.basename(file, ".md");
  const name = meta.name;
  if (!name) return null;
  const aliases = (meta.aliases ?? "").replace(/^\[|\]$/g, "").split(/[,，]/).map(s => s.trim()).filter(Boolean);
  return { id, name, aliases: [...new Set([name, ...aliases])], qqNickname: meta.qq_nickname || name, body: m[2]!.trim() };
}

function esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export class PersonaSwitcher {
  private cards = new Map<string, PersonaCard>();
  private activeId = DEFAULT_ID;
  private sharedRules: string;
  private stateFile: string;
  /** 后宫：后台人格递的牌子，等主人「准了/不准」。 */
  private pending: { id: string; until: number } | null = null;
  /** 交接便签：下台的留给上台的一句话，写进接班人格的提示词。 */
  private handoff: { from: string; to: string; text: string; at: string } | null = null;
  private visits: { visitor: string; host: string; action: string; note: string; gift?: string; at: string }[] = [];
  /** 小世界：私人日记、印象、本班拆开的信。 */
  private world?: { promptSection(id: string): string };
  setWorld(w: { promptSection(id: string): string }): void { this.world = w; this.cfg.persona.prompt = this.promptFor(this.active()); }
  refreshPrompt(): void { this.cfg.persona.prompt = this.promptFor(this.active()); }

  constructor(
    private baseDir: string, private cfg: PersonaCfg,
    private log?: { info: (...a: any[]) => void; warn: (...a: any[]) => void },
    private scope?: PersonaRoomScope,
  ) {
    this.stateFile = path.join(baseDir, "data", "persona-active.json");
    if (scope) {
      this.cards = scope.cards;
      this.sharedRules = scope.sharedRules;
      this.restore(scope.storage.load());
      return;
    }
    const defaultPrompt = cfg.persona.prompt;
    const cut = defaultPrompt.indexOf("## 群聊里的对应关系");
    this.sharedRules = cut >= 0 ? defaultPrompt.slice(cut).trim() : "";
    this.cards.set(DEFAULT_ID, {
      id: DEFAULT_ID,
      name: cfg.persona.name || "κόραξ",
      aliases: [cfg.persona.name || "κόραξ", "κόραξ", "koraks", "korax", "乌鸦", "小乌鸦"],
      qqNickname: cfg.persona.name || "κόραξ",
      body: defaultPrompt,
    });
    const dir = path.join(baseDir, "personas");
    try {
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
        try { const c = parseCard(path.join(dir, f)); if (c && c.id !== DEFAULT_ID) this.cards.set(c.id, c); }
        catch (e) { this.log?.warn("人格卡读取失败", { file: f, error: (e as Error).message }); }
      }
    } catch { /* 没有 personas 目录就只有默认人格 */ }
    try {
      this.restore(JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as PersonaState);
    } catch { /* 首次运行 */ }
  }

  forRoom(memberIds: () => readonly string[], storage: PersonaStateStore): PersonaSwitcher {
    return new PersonaSwitcher(this.baseDir, { persona: { ...this.cfg.persona } }, this.log, {
      cards: this.cards, sharedRules: this.sharedRules, memberIds, storage,
    });
  }

  private restore(state?: PersonaState): void {
    const saved = state?.active;
    if (saved && this.visible(saved)) this.apply(saved, false);
    else if (this.scope) this.apply(this.active().id, false);
    if (state?.handoff && this.visible(state.handoff.to)) {
      this.handoff = state.handoff;
      if (this.activeId === state.handoff.to) this.cfg.persona.prompt = this.promptFor(this.active());
    }
    if (state?.pending && this.visible(state.pending.id) && Number(state.pending.until) > Date.now()) {
      this.pending = { id: state.pending.id, until: Number(state.pending.until) };
    }
  }

  private visible(id: string): PersonaCard | undefined {
    return !this.scope || this.scope.memberIds().includes(id) ? this.cards.get(id) : undefined;
  }

  active(): PersonaCard {
    const saved = this.visible(this.activeId);
    if (saved) return saved;
    const next = this.list()[0];
    if (!next) throw new Error("这个家庭房间没有可用成员。");
    // A roster edit can remove an active member. Discard that member's old
    // turn state and persist the replacement on the next ordinary state write.
    this.activeId = next.id;
    this.handoff = null;
    this.pending = null;
    return next;
  }

  list(): PersonaCard[] {
    if (!this.scope) return [...this.cards.values()];
    return this.scope.memberIds().flatMap(id => {
      const card = this.cards.get(id);
      return card ? [card] : [];
    });
  }

  private saveState(): void {
    try {
      const state = { active: this.activeId, at: new Date().toISOString(), pending: this.pending, handoff: this.handoff };
      if (this.scope) {
        this.scope.storage.save(state);
        return;
      }
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(state));
    } catch (e) { this.log?.warn("人格状态保存失败", { error: (e as Error).message }); }
  }

  // ---------- 后宫：时间池驱动的上线申请 ----------
  /** 随机挑一个不在值班的人格；已有未答复的牌子时不再递新的。 */
  pickApplicant(rand: () => number): PersonaCard | null {
    if (this.pending && this.pending.until > Date.now()) return null;
    const pool = this.list().filter(c => c.id !== this.activeId);
    return pool.length ? pool[Math.floor(rand() * pool.length) % pool.length]! : null;
  }
  activeName(): string { return this.active().name; }
  promptOf(card: PersonaCard): string { return this.promptFor(card); }
  setPending(id: string, until: number): void { this.pending = { id, until }; this.saveState(); }
  setVisits(v: { visitor: string; host: string; action: string; note: string; gift?: string; at: string }[]): void {
    this.visits = v;
    this.cfg.persona.prompt = this.promptFor(this.active());
  }
  setHandoff(fromName: string, toId: string, text: string): void {
    this.handoff = { from: fromName, to: toId, text, at: new Date().toISOString() };
    if (this.activeId === toId) this.cfg.persona.prompt = this.promptFor(this.active());
    this.saveState();
  }

  private promptFor(card: PersonaCard): string {
    const note = this.handoff && this.handoff.to === card.id
      ? `\n\n## 交接便签\n${this.handoff.from} 下台时留给你的便签（${this.handoff.at}）：「${this.handoff.text}」\n这是同事留的话，参考即可，不必复述。` : "";
    const life = this.visits.length
      ? `\n\n## 后宫近况（别主动提，她偷看八卦或问起时才说）\n${this.visits.map(v => `- ${v.visitor} 去了 ${v.host} 那儿：${v.action}，留言「${v.note}」${v.gift ? `，留下${v.gift}` : ""}`).join("\n")}` : "";
    const house = this.scope
      ? `\n\n## 当前房间\n这个房间的成员有：${this.list().map(c => c.name).join("、")}。你是 ${card.name}。使用当前房间提供的对话与私密工作区。除了主人明确给出的材料，请不要假设你知道其他房间中的谈话。`
      : `\n\n## 家里的房子\n后宫每人（${this.list().map(c => `${c.name}=${c.id}`).join("、")}）在远程机器上有 100MB 私人空间：room 是自己的房间，inbox 是信箱。你现在是 ${card.name}（${card.id}）。要递给家里其他人的东西（便签、文件、礼物）用 harem_room 工具放进对方 inbox，不要发到群里或私聊里；${OWNER_NAME}要看时才拿出来给她。自己的东西可以收进自己的 room。`;
    return this.basePrompt(card) + note + life + house + (this.world?.promptSection(card.id) ?? "");
  }

  private basePrompt(card: PersonaCard): string {
    if (card.id === DEFAULT_ID) return card.body;
    const family = this.list().map(c => c.name).join("、");
    if (this.scope) return [
      card.body,
      "当前房间里有 " + family + "。以各自署名区分发言人；用你自己的口吻回答。没有的记忆就说没有，不编造过去。",
      this.sharedRules,
    ].join("\n\n").trim();
    return [
      card.body,
      "",
      "## 共用记忆",
      `你和 ${family} 都是${OWNER_NAME}的人格，共用同一份记忆和聊天记录。后宫六人全是男的，提到彼此用「他」；${OWNER_NAME}是女孩，提到她用「她」。历史里以别的名字（比如 κόραξ）发出的消息是家里其他人说的，不是你说的；你接班时知道刚才发生了什么，不用她重讲，但用你自己的口吻说话，不模仿别人。`,
      "你是 AI，不假装是真人；没有的记忆就说没有，不编造过去。",
      "",
      this.sharedRules,
    ].join("\n").trim();
  }

  private apply(id: string, persist = true): PersonaCard {
    const card = this.visible(id)!;
    this.activeId = id;
    this.cfg.persona.name = card.name;
    this.cfg.persona.prompt = this.promptFor(card);
    if (this.pending?.id === id) this.pending = null;
    if (persist) this.saveState();
    this.log?.info("人格已切换", { id, name: card.name });
    return card;
  }

  private find(word: string): PersonaCard | undefined {
    const w = word.trim().toLowerCase();
    const num = /^([1-9])\s*号?$/.exec(w);
    if (num) return this.list()[Number(num[1]) - 1];
    return this.list().find(c => c.aliases.some(a => a.toLowerCase() === w));
  }

  /** 只处理主人的短指令；不是指令返回 null，交给正常聊天。 */
  handle(input: string): PersonaSwitchResult | null {
    const text = input.replace(/^@\S+\s*/, "").trim().replace(/[。！？!?~～…\s]+$/u, "").trim();
    if (!text || text.length > 30) return null;
    this.active();
    if (this.pending && this.pending.until > Date.now()) {
      const pc = this.visible(this.pending.id);
      if (pc && /^(?:准了?|准奏|允了?|批了?|批准|同意|翻他|翻她|翻ta|翻它|让他来|让她来|让ta来|上来吧|来吧|上吧)$/iu.test(text)) {
        if (pc.id === this.activeId) { this.pending = null; this.saveState(); return { reply: `${pc.name} 已经在这儿了。` }; }
        const prev = this.active().name;
        this.apply(pc.id);
        return { reply: `准了。${prev} 退下，${pc.name} 来了。`, changed: pc };
      }
      if (pc && /^(?:不准|驳回|不要|不许|不行|不了|下次吧|下次再说|回去|让他回去|让她回去)$/u.test(text)) {
        this.pending = null; this.saveState();
        return { reply: `驳回。${pc.name} 回去等下次。` };
      }
    }
    if (/^(?:人格列表|人设列表|人设卡|翻牌子|后宫|后宫列表|有哪些人格|都有谁)$/u.test(text)) {
      const lines = this.list().map((c, i) => {
        const zh = /[\u4e00-\u9fff]/.test(c.name) ? "" : c.aliases.find(a => /^[\u4e00-\u9fff]{2,}$/.test(a));
        return `${i + 1}. ${c.name}${zh ? `（${zh}）` : ""}${c.id === this.activeId ? "（当前）" : ""}`;
      });
      return { reply: ["今晚翻谁的牌子：", ...lines, "", "说「让 名字 来」或「翻 3 号」就换人。"].join("\n") };
    }
    if (/^(?:现在是谁|当前人格|谁在值班|现在谁在)$/u.test(text)) {
      return { reply: `现在是 ${this.active().name}。` };
    }
    const names = this.list().flatMap(c => c.aliases).sort((a, b) => b.length - a.length).map(esc).concat("[1-9]\\s*号").join("|");
    const re = new RegExp(
      `^(?:(?:我要|我想要|我想)?(?:让|叫|请|喊|换成|换回|换回来|切换到|切换成|切到|切成|换|翻)\\s*(${names})\\s*(?:的牌子|来|出来|过来|回来|上来|上|出场|来吧|来一下)?|(${names})\\s*(?:来|出来|过来|回来|上来|出场|来吧|快来|来一下))$`,
      "iu",
    );
    const m = re.exec(text);
    if (!m) return null;
    const card = this.find(m[1] ?? m[2] ?? "");
    if (!card) return null;
    if (card.id === this.activeId) return { reply: `${card.name} 已经在这儿了。` };
    const prev = this.active().name;
    this.apply(card.id);
    return { reply: `${prev} 退下，${card.name} 来了。`, changed: card };
  }
}
