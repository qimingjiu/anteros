import type { MessageSegment } from "../types.js";
import { senderText } from "./conversation-control.js";

export interface SummonAliasOptions {
  wakeAliases?: readonly string[];
  ownerWakeAliases?: readonly { userId: string; aliases: readonly string[] }[];
}

export type SummonAliasMatch =
  | { kind: "owner_alias"; alias: string; userId: string }
  | { kind: "general_alias"; alias: string };

const normalize = (text: string): string => text.normalize("NFKC")
  .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "").trim().toLocaleLowerCase("en-US");

function summonText(segments: readonly MessageSegment[]): string {
  const source = senderText(segments);
  // 引用数据行和成对引号里的字面材料不能代替发送者本人召唤。
  // 数据行若以引号开始，仅遮住引文，保留收引号后本人另写的呼叫。
  const dataLines = source.replace(/^\s*(?:引用|转述|原话)\s*[:：](?!\s*["“「『'])[^\r\n]*$/gmu,
    value => "\u0000".repeat(value.length));
  const quoted = dataLines.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\r\n]*"/gu,
    value => "\u0000".repeat(value.length));
  const singleQuoted = quoted.replace(/(^|[^\p{Script=Latin}\p{Script=Greek}\p{N}_])'[^'\r\n]*'/gu,
    (_value, prefix: string) => prefix + "\u0000".repeat(_value.length - prefix.length));
  return normalize(singleQuoted);
}

function aliasPattern(value: string): string | null {
  const alias = normalize(value);
  if ([...alias].length < 2 || [...alias].length > 100 || !/[\p{L}\p{N}]/u.test(alias)) return null;
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/^[\p{Script=Latin}\p{Script=Greek}\p{N}_\s.'-]+$/u.test(alias)) {
    // 希腊语和拉丁语名字可紧接中文；英语、希腊语单词内部出现名字不算召唤。
    return `(?<![\\p{Script=Latin}\\p{Script=Greek}\\p{N}_])${escaped}(?![\\p{Script=Latin}\\p{Script=Greek}\\p{N}_])`;
  }
  return escaped;
}

function containsAlias(text: string, value: string): boolean {
  const pattern = aliasPattern(value);
  return pattern !== null && new RegExp(pattern, "u").test(text);
}

/** 未授权专属词占据的文字不能降级通过通用词的子串匹配。 */
function maskUnauthorizedAliases(text: string, senderId: string, options: SummonAliasOptions): string {
  const occupied = new Uint8Array(text.length);
  for (const binding of options.ownerWakeAliases ?? []) {
    if (binding.userId === senderId) continue;
    for (const alias of binding.aliases) {
      const pattern = aliasPattern(alias);
      if (pattern === null) continue;
      // 前瞻保留重叠词的位置：不能因先遮住短词而漏掉较长的专属词。
      for (const match of text.matchAll(new RegExp(`(?=(${pattern}))`, "gu"))) {
        occupied.fill(1, match.index, match.index + match[1]!.length);
      }
    }
  }
  return text.split("").map((character, index) => occupied[index] ? "\u0000" : character).join("");
}

/**
 * 仅匹配当前消息的 text 段；引用、转发、卡片、昵称和正文自报身份均不参与授权。
 * 专属绑定先于所有通用别名，通用别名始终保留 persona.name。
 */
export function matchSummonAlias(
  segments: readonly MessageSegment[],
  senderId: string,
  personaName: string,
  options: SummonAliasOptions = {},
): SummonAliasMatch | null {
  const text = summonText(segments);
  if (!text) return null;
  for (const binding of options.ownerWakeAliases ?? []) {
    if (binding.userId !== senderId) continue;
    for (const alias of binding.aliases) {
      if (containsAlias(text, alias)) return { kind: "owner_alias", alias, userId: senderId };
    }
  }
  const generalText = maskUnauthorizedAliases(text, senderId, options);
  for (const alias of [...(options.wakeAliases ?? []), personaName]) {
    if (containsAlias(generalText, alias)) return { kind: "general_alias", alias };
  }
  return null;
}
