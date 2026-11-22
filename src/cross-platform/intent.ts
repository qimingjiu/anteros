import { normalizeAlias, type CrossPlatformKind } from "./config.js";

const platformNames = ["qq", "discord", "dc", "telegram", "tg"];
const clauseSeparator = /[，,。；;！!？?\r\n]+/u;
const action = /(?:转发|发送|发|传|投递|推送|送)(?:一[条段句份张个][^。！？:]{0,24}?)?\s*(?:到|去|给|至)\s*|\b(?:send|forward|post)\b[^.!?;]{0,120}?\bto\s+/giu;
const negative = /(?:不要|不用|无需|不想|不许|不准|禁止|别)\s*(?:再|这样|往|把|发|传|送|转|给|投递)|\b(?:don't|do not|never)\b/iu;
const reported = /我(?:刚|曾|已经|昨天|之前|以前|今天|今晚|明天|打算|计划|准备|会|想把)|\b(?:already|i will|i would|i plan to|i sent)\b/iu;
const reference = /怎么|如何|是否|支持(?:发|转发|投递)|(?:[她他]|其)原话|[她他](?:说|让)|引用|转述|\b(?:how|whether|said)\b/iu;
const conditional = /如果|假如|万一|假设|\b(?:if|unless|suppose)\b/iu;

function routeName(tail: string, names: readonly string[], strict: boolean): string | undefined {
  return names.find(name => {
    if (!tail.startsWith(name)) return false;
    const rest = tail.slice(name.length);
    return !rest || (strict
      ? /^(?:[\s，,。；;！!？?：:]|[上里吧哈啊呀哦吗嘛](?:$|[\s，,。；;！!？?]))/u.test(rest)
      : !/^[a-z0-9_-]/iu.test(rest));
  });
}

function contentKinds(clause: string): CrossPlatformKind[] {
  const matches: CrossPlatformKind[] = [];
  if (/文件|附件|文档|\b(?:docx?|pdf|markdown|file|document)\b/iu.test(clause)) matches.push("file");
  if (/图片|截图|照片|自拍|画(?:一?[张幅]|一只)|\b(?:image|photo|picture|screenshot)\b/iu.test(clause)) matches.push("image");
  if (/语音|音频|读出来|朗读|男声|\b(?:voice|speech|audio)\b/iu.test(clause)) matches.push("voice");
  if (/文字|文本|一句话|\btext\b/iu.test(clause) || (!matches.length && /消息|message/iu.test(clause))) matches.push("text");
  return matches;
}

function candidateNames(text: string, names: readonly string[], strict = true): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(action)) {
    const tail = text.slice(match.index + match[0].length).trimStart().replace(/^[“「『"'‘]\s*/u, "");
    const name = routeName(tail.replace(/[”」』"'’]/gu, " "), names, strict);
    if (name) candidates.push(name);
  }
  return candidates;
}

/** The source is the user's own text segments. Quotes, code and other input cannot authorize delivery. */
export function readDeliveryIntent(source: string, knownAliases: Iterable<string>): {
  requests: Map<string, Set<CrossPlatformKind>>;
  mentions: Set<string>;
  denied: Set<string>;
} {
  const names = [...new Set([...knownAliases, ...platformNames])].sort((a, b) => b.length - a.length);
  const requests = new Map<string, Set<CrossPlatformKind>>();
  const normal = source.normalize("NFKC").toLowerCase();
  const mentions = new Set(normal.split(clauseSeparator).flatMap(clause => candidateNames(normalizeAlias(clause), names, false)));
  const denied = new Set<string>();
  const direct = normal.replace(/\x60\x60\x60[\s\S]*?(?:\x60\x60\x60|$)|\x60[^\x60]*\x60|^[ \t]*>.*$/gmu, " ")
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|‘[^’]*’|(?<![a-z])'[^'\r\n]*'(?![a-z])/gu, quote => {
      const name = normalizeAlias(quote.slice(1, -1));
      return names.includes(name) ? name : " ";
    }).replace(/https?:\/\/\S+/giu, " ");
  const commands = direct.split(/[。；;！？!?\r\n]+/u).map(sentence => sentence.split(":", 1)[0]!);
  if (conditional.test(commands.join("\n")) || commands.some(command => command.split(clauseSeparator).some(clause =>
    /^\s*(?:(?:还是)?(?:不要|别|不用|不许)\s*(?:再)?\s*(?:发|转发|发送|投递)(?:了|吧)?|(?:don't|do not)\s+send(?:\s+it)?)\s*$/iu.test(clause)))) {
    return { requests, mentions, denied };
  }
  // Once a clause introduces a quotation or asks about an action, a comma does not make
  // another clause from the same sentence into a new send order.
  for (const command of commands) {
    if (reference.test(command)) continue;
    const clauses = command.split(clauseSeparator);
    const allKinds = contentKinds(command);
    let unfinishedNegation = false;
    for (const clause of clauses) {
      const candidates = candidateNames(normalizeAlias(clause), names);
      if (negative.test(clause)) {
        for (const name of candidates) denied.add(name);
        unfinishedNegation ||= !candidates.length;
        continue;
      }
      if (unfinishedNegation || reported.test(clause)) continue;
      if (!candidates.length) continue;
      const localKinds = contentKinds(clause);
      const kinds = localKinds.length ? localKinds : allKinds.length === 1 ? allKinds : [];
      for (const name of candidates) {
        const previous = requests.get(name) ?? new Set<CrossPlatformKind>();
        for (const kind of kinds) previous.add(kind);
        requests.set(name, previous);
      }
    }
  }
  return { requests, mentions, denied };
}
