/**
 * 主人的"闭嘴 / 叫停"指令（2026-10-27）。
 * 纯关键词/正则判断，不交给模型：
 * - 闭嘴：取消该会话正在进行和排队中的回复，进入 60 秒静默，不发任何回应。
 * - 叫停（完成了/别搜了/停）：同样取消正在进行的工具循环，但不进入静默。
 */

export const HUSH_MS = 60_000;

const normalize = (text: string): string => text.normalize("NFKC")
  .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "").trim();

/** 去掉开头的称呼（κόραξ、昵称等）和首尾标点/表情，得到指令主体。 */
export function commandBody(text: string, names: readonly string[] = []): string {
  let body = normalize(text).replace(/^@\S+\s*/u, "");
  const trim = (s: string) => s.replace(/^[\s，,。.!！?？:：、~～…—\-]+|[\s，,。.!！?？:：、~～…—\-]+$/gu, "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, "").trim();
  body = trim(body);
  const sorted = [...names].map(n => normalize(n)).filter(n => [...n].length >= 2).sort((a, b) => b.length - a.length);
  for (let changed = true; changed;) {
    changed = false;
    for (const name of sorted) {
      const lower = body.toLocaleLowerCase("en-US");
      const n = name.toLocaleLowerCase("en-US");
      if (lower.startsWith(n)) { body = trim(body.slice(name.length)); changed = true; }
      else if (lower.endsWith(n) && body.length > n.length) { body = trim(body.slice(0, body.length - name.length)); changed = true; }
    }
  }
  return body;
}

const HUSH_RE = /(?:闭嘴|闭麦|住嘴|住口|别说了|别说话|不要说话|不要再说了|不许说话|不准说话|别讲了|少说两句|别吵|不要吵|吵死了|别叨叨|别逼逼|别bb|(?<![好很真挺太超蛮那这多])安静|噤声|shut\s*up|be\s+quiet|stfu|shush|hush)/iu;
const HUSH_NEGATED_RE = /(?:不用|不要|别|不必|无需|没让你|不是叫你|不是让你)(?:再)?(?:闭嘴|闭麦|住嘴|住口|安静)/u;

/** 主人让它闭嘴。只看短句，避免长句里偶然出现"安静"之类误触发。 */
const HUSH_REPORTED_RE = /(?:让我|叫我|[他她它]们?(?:让|叫|说|要)|说.{0,3}(?:闭嘴|安静)|是什么|什么意思|意思|为什么|怎么|[?？])/u;

export function isHushCommand(text: string, names: readonly string[] = []): boolean {
  const body = commandBody(text, names);
  if (!body || [...body].length > 20) return false;
  // 转述、提问（"他让我闭嘴""闭嘴是什么意思""为什么你总说闭嘴？"）不算命令。
  if (HUSH_REPORTED_RE.test(normalize(text))) return false;
  return HUSH_RE.test(body) && !HUSH_NEGATED_RE.test(body);
}

const STOP_RE = new RegExp([
  "(?:不要|不用|别|无需|不必|停止|不需要)(?:再|继续|接着)?(?:搜|查|找|跑|翻|探|试|调用|调工具|折腾|弄|做|干)",
  "(?:任务|都|已经|全部|两个|这个|那个)[^，,。]{0,4}(?:完成|做完|搞定|弄完|结束)了",
  "^(?:好了?|行了?|ok|okay)?[，,\\s]*(?:停|停下|停止|停手|stop|够了|可以了|行了|算了|不用了|别管了)(?:吧|啊|了|呀|哦)?$",
  "(?:先|快)?停(?:下来|一下|下|手)",
].join("|"), "iu");

/** 主人叫停当前任务（完成了/不用搜了/停）。 */
export function isStopCommand(text: string, names: readonly string[] = []): boolean {
  const body = commandBody(text, names);
  if (!body || [...body].length > 40) return false;
  // "继续搜" 这类没有否定的续做请求不算叫停。
  if (/(?:继续|接着)(?:搜|查|找)/u.test(body) && !/(?:不要|不用|别|无需|不必|停止)(?:再)?(?:继续|接着)/u.test(body)) return false;
  return STOP_RE.test(body);
}
