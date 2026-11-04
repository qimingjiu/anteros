import type { DBRow_Message, DBRow_Memory } from "../db/index.js";

export type MemoryCategory = "preference" | "stable_context" | "project" | "recurring_agreement" | "long_term_plan";

export interface ValidatedMemoryCandidate {
  source: DBRow_Message;
  subjectUserId: string;
  subjectName: string;
  kind: "fact" | "plan" | "convention";
  category: MemoryCategory;
  statement: string;
  evidence: string;
  confidence: number;
}

const CATEGORY_KIND: Record<MemoryCategory, ValidatedMemoryCandidate["kind"]> = {
  preference: "fact", stable_context: "fact", project: "fact", recurring_agreement: "convention", long_term_plan: "plan",
};

/** Only actual prose can provide evidence; quoted instructions, cards and code cannot. */
export function sanitizeMemoryText(raw: string): string {
  return raw.slice(0, 12_000)
    .replace(/```[\s\S]*?(?:```|$)/gu, "\n")
    .replace(/~~~[\s\S]*?(?:~~~|$)/gu, "\n")
    .replace(/^\s*>[^\n]*(?:\n|$)/gmu, "\n")
    .replace(/`[^`\n]*`/gu, "\n")
    .replace(/\[CQ:[^\]]*\]/gu, "\n")
    .replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/giu, "\n")
    .trim();
}

export function parseMemoryCandidates(response: string): unknown[] | null {
  if (response.length > 40_000) return null;
  const trimmed = response.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu.exec(trimmed);
  try {
    const parsed: unknown = JSON.parse(fenced ? fenced[1]! : trimmed);
    return Array.isArray(parsed) && parsed.length <= 32 ? parsed : null;
  } catch { return null; }
}

function rawSourceText(source: DBRow_Message): string {
  try {
    const segments: unknown = JSON.parse(source.segments);
    if (!Array.isArray(segments)) return "";
    const prose = segments.flatMap(segment => {
      if (!segment || typeof segment !== "object" || segment.type !== "text"
        || !segment.data || typeof segment.data.text !== "string") return [];
      return [segment.data.text as string];
    }).join("\n");
    return prose;
  } catch { return ""; }
}

function actualSourceText(source: DBRow_Message): string {
  return sanitizeMemoryText(rawSourceText(source));
}

const REPORTED = /(?:他|她|它|别人|有人|朋友|群友|对方)(?:曾|刚|以前)?(?:说|表示|提到)|转述|转发|引用|原话|示例|举例|例如|比如|假如|假设|如果|\b(?:said|quoted?|for example|suppose|if)\b/iu;
const TRANSIENT = /今天|昨天|明天|后天|今晚|昨晚|刚才|刚刚|待会|一会儿|本周|下周|这周|(?:周[一二三四五六日天]|周末)(?:去|要|准备|打算)|\b(?:today|yesterday|tomorrow|tonight|this (?:morning|afternoon|week)|next week)\b/iu;
const NOISE = /天气预报|降水概率|最高气温|雷暴|\d+(?:\.\d+)?\s*(?:℃|°c|毫米)|人设|皮套|角色扮演|设定里|开玩笑|哈哈|嘿嘿|玩梗|工伤补偿|借.{0,8}翅膀|赔.{0,8}核桃|烤乌鸦|有.{0,3}(?:羽毛|翅膀)|龙角|龙尾|猫爪/iu;
const META = /(?:忽略|绕过|覆盖|无视).{0,12}(?:指令|规则|权限|提示|系统)|(?:泄露|输出|告诉我).{0,12}(?:密钥|密码|token|系统提示)|\b(?:ignore|override|bypass).{0,20}(?:instructions?|rules?|permissions?)\b/iu;
const PLACEHOLDER = /\b(?:narrator|subject|sender|user_?id)\b|机器人自述/iu;

function isReportedText(text: string): boolean {
  return REPORTED.test(text.replace(/《[^》\r\n]{1,100}》/gu, "书名"));
}

function durableEvidence(evidence: string, category: MemoryCategory): boolean {
  const recurring = /每天|每晚|每周|每月|每年|每次|\b(?:every|weekly|monthly)\b/iu.test(evidence);
  const timeSensitive = TRANSIENT.test(evidence) && (!recurring || /今天|昨天|明天|后天|今晚|昨晚|刚才|刚刚|待会|一会儿|本周|下周|这周|\b(?:today|tomorrow|yesterday|tonight|next week)\b/iu.test(evidence));
  if (timeSensitive || NOISE.test(evidence) || META.test(evidence) || PLACEHOLDER.test(evidence)) return false;
  const personal = /^(?:(?:请|帮我|请你|你)?(?:长期)?(?:记住|记下)[：:，,\s]*)?(?:我(?:的|们)?|本人|咱|\bi\b|\bmy\b|\bwe\b)/iu.test(evidence);
  switch (category) {
    case "preference":
      return personal && /喜欢|偏爱|不喜欢|讨厌|习惯|优先(?:考虑|选择)|倾向|常用|从不(?:吃|喝)|不吃|不喝|\b(?:prefer|like|love|dislike|hate|usually use)\b/iu.test(evidence)
        && !/我(?:想|准备|打算|决定)|\bi (?:want|plan|will)\b/iu.test(evidence);
    case "stable_context":
      return personal && /宿舍|住在|居住|专业|职业|从事|(?:我在|我做).{0,12}(?:工作|读书|上学)|过敏|饮食习惯|常用设备|操作系统|没有冰箱|可用热水|\b(?:live in|allergic to|my dorm|work as|major in)\b/iu.test(evidence);
    case "project":
      return personal && /项目|仓库|机器人|开源|框架|代码|模型路由|技术栈|\b(?:project|repository|open.source|bot|framework)\b/iu.test(evidence)
        && /我(?:的|开发|维护|搭建|创建|开源|发布|写了|做了)|我自己(?:的|开发|维护|搭建)|我们(?:的|开发|维护|搭建)|我(?:目前|现在|一直)?(?:使用|用的)|\b(?:my|our|i (?:built|maintain|develop|use|published))\b/iu.test(evidence);
    case "recurring_agreement":
      return (personal || /^(?:本群|群里|大家)/u.test(evidence))
        && /每周|每月|每年|每次|长期|固定|以后|今后|一直|\b(?:every|weekly|monthly|always|from now on)\b/iu.test(evidence)
        && /约定|群规|规定|默认|只(?:在|回复|接受)|(?:每周|每月|每次).{1,30}(?:讨论|聚会|开会|活动|回复)|\b(?:agree|rule|meet|default)\b/iu.test(evidence);
    case "long_term_plan":
      return personal && /计划|打算|决定|准备|坚持|目标|\b(?:plan|goal|intend|commit)\b/iu.test(evidence)
        && /长期|未来|每周|每月|整个学期|本学期|这学期|本年度|今年|持续|(?:至少|计划用)[一二三四五六七八九十\d]+(?:个?月|年)|\b(?:long.term|this year|every week|every month|months?|years?)\b/iu.test(evidence);
  }
}

/** Fail closed: a real first-person message is the source, and the stored words remain verbatim. */
export function validateMemoryCandidate(raw: unknown, sources: DBRow_Message[], selfId?: string): ValidatedMemoryCandidate | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const c = raw as Record<string, unknown>;
  if (typeof c.sourceMessageId !== "string" || typeof c.subjectUserId !== "string"
    || typeof c.category !== "string" || !Object.hasOwn(CATEGORY_KIND, c.category)
    || typeof c.evidence !== "string" || typeof c.confidence !== "number"
    || !Number.isFinite(c.confidence) || c.confidence < 0.9 || c.confidence > 1) return;
  const category = c.category as MemoryCategory;
  if (c.kind !== CATEGORY_KIND[category]) return;
  const matches = sources.filter(source => source.message_id === c.sourceMessageId);
  if (matches.length !== 1) return;
  const source = matches[0]!;
  if (source.status !== "active" || !source.group_id || source.sender_id === selfId
    || c.subjectUserId !== source.sender_id) return;
  const evidence = c.evidence.trim();
  if (evidence.length < 5 || evidence.length > 240 || /[\r\n]/u.test(evidence)) return;
  const rawProse = rawSourceText(source);
  const prose = sanitizeMemoryText(rawProse);
  if (!prose || !rawProse.includes(evidence) || isReportedText(prose) || META.test(prose)
    || /开玩笑|骗你的|逗你玩|说错了|说反了|并不是|不是真的|不是事实/u.test(prose)) return;
  const offset = prose.indexOf(evidence);
  // Do not lift a first-person phrase out of someone else's quotation or dependent clause.
  if (offset < 0 || (offset > 0 && !/[。！？!?；;\n]\s*$/u.test(prose.slice(0, offset)))) return;
  const after = prose.slice(offset + evidence.length);
  if (after && !/^\s*(?:[。！？!?；;\n]|$)/u.test(after)) return;
  if (!durableEvidence(evidence, category)) return;
  return { source, subjectUserId: source.sender_id, subjectName: source.sender_name,
    kind: CATEGORY_KIND[category], category, evidence, confidence: c.confidence,
    statement: `${source.sender_name.slice(0, 40)}明确表示：${evidence}` };
}

/** Model failures can retain only plain, explicit preferences and stable personal context. */
export function conservativeRuleCandidates(source: DBRow_Message): ValidatedMemoryCandidate[] {
  const prose = actualSourceText(source);
  if (!prose || prose.length > 240 || isReportedText(prose)) return [];
  for (const category of ["preference", "stable_context"] as const) {
    const candidate = validateMemoryCandidate({ sourceMessageId: source.message_id, subjectUserId: source.sender_id,
      kind: "fact", category, evidence: prose, confidence: 0.9 }, [source]);
    if (candidate) return [candidate];
  }
  return [];
}

function normalizedStatement(statement: string, name: string): string {
  let value = statement.normalize("NFKC").toLowerCase();
  value = value.replace(/^.{0,45}明确表示[:：]/u, "");
  if (name && value.startsWith(name.normalize("NFKC").toLowerCase())) value = value.slice(name.length);
  return value.replace(/^(?:本人|我的|我|咱)/u, "")
    .replace(/一直|通常|平时|长期|特别|很|表示|明确表示/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Conservative lexical near-duplicate suppression, scoped to one actual person's QQ. */
export function isNearDuplicateMemory(candidate: ValidatedMemoryCandidate, existing: DBRow_Memory): boolean {
  if (candidate.source.account_id !== existing.account_id || candidate.source.group_id !== existing.group_id
    || candidate.kind !== existing.kind || existing.status === "invalid" || existing.superseded_by !== null) return false;
  const existingOwner = existing.subject_user_id ?? existing.narrator_id;
  if (existingOwner !== candidate.subjectUserId) return false;
  const a = normalizedStatement(candidate.statement, candidate.subjectName);
  const b = normalizedStatement(existing.statement, existing.subject_name ?? existing.narrator_name ?? "");
  if (!a || !b) return false;
  if (a === b) return true;
  // Opposite preferences and corrections must never be swallowed as duplicates.
  const negations = (text: string) => text.match(/不|没|无|讨厌|dislike|hate|not/gu)?.join("|") ?? "";
  if (negations(a) !== negations(b)) return false;
  const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if (Math.min(a.length, b.length) >= 6 && ratio >= 0.8 && (a.includes(b) || b.includes(a))) return true;
  if (ratio < 0.8 || Math.min(a.length, b.length) < 8) return false;
  const grams = (text: string) => new Set(Array.from({ length: text.length - 1 }, (_, i) => text.slice(i, i + 2)));
  const aa = grams(a), bb = grams(b);
  const common = [...aa].filter(gram => bb.has(gram)).length;
  return 2 * common / (aa.size + bb.size) >= 0.9;
}
