/** Keyword news search over Google News RSS (no API key). Newline JSON-RPC MCP over stdio,
 * same shape as music-server.ts. Read-only; never prints anything but protocol lines to stdout. */
import { createInterface } from "node:readline";

type RpcId = string | number | null;
const obj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

const TOOLS = [{
  name: "news_search",
  description: "按关键词搜索最新新闻报道（Google 新闻聚合，含国内外媒体），返回标题、来源、发布时间和链接。用户问某件事/某公司/某人的新闻、最新进展、报道时优先用它；只想看各平台热榜时用 newsnow。",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "关键词，可用 OR、引号、-排除词" },
      days: { type: "integer", description: "只看最近 N 天（默认 7，1–30）" },
      lang: { type: "string", enum: ["zh", "en"], description: "zh=中文新闻（默认），en=英文新闻" },
      count: { type: "integer", description: "条数（默认 10，最多 20）" },
    },
    required: ["query"],
  },
}];

const decode = (s: string) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
  .replace(/<[^>]+>/g, "").trim();
const tag = (xml: string, t: string) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1] ?? "") : ""; };

function fmtDate(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

async function newsSearch(args: Record<string, unknown>): Promise<string> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("query 不能为空");
  const days = Math.min(30, Math.max(1, Number(args.days) || 7));
  const count = Math.min(20, Math.max(1, Number(args.count) || 10));
  const en = args.lang === "en";
  const loc = en ? "hl=en-US&gl=US&ceid=US:en" : "hl=zh-CN&gl=CN&ceid=CN:zh-Hans";
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${days}d`)}&${loc}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let xml: string;
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`新闻源 HTTP ${r.status}`);
    xml = await r.text();
  } finally { clearTimeout(timer); }
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1] ?? "").map(it => {
    const source = tag(it, "source");
    let title = tag(it, "title");
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return { title, source, date: tag(it, "pubDate"), link: tag(it, "link") };
  });
  items.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  const top = items.slice(0, count);
  if (top.length === 0) return `最近 ${days} 天没有找到「${query}」的新闻报道。可以放宽关键词或加大 days。`;
  return `「${query}」最近 ${days} 天新闻（按时间倒序，北京时间）：\n` + top.map((x, i) =>
    `${i + 1}. ${x.title}\n   来源：${x.source || "未知"} · ${fmtDate(x.date)}\n   ${x.link}`).join("\n");
}

async function handle(req: unknown): Promise<Record<string, unknown> | undefined> {
  if (!obj(req) || req.jsonrpc !== "2.0" || typeof req.method !== "string") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  if (!Object.hasOwn(req, "id")) return undefined;
  const id = req.id as RpcId;
  const ok = (result: Record<string, unknown>) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (req.method === "initialize") {
    const v = obj(req.params) ? req.params.protocolVersion : undefined;
    const sup = ["2024-11-05", "2025-03-26", "2025-06-18"];
    return ok({ protocolVersion: typeof v === "string" && sup.includes(v) ? v : "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "news-search", version: "0.1.0" } });
  }
  if (req.method === "ping") return ok({});
  if (req.method === "tools/list") return ok({ tools: TOOLS });
  if (req.method !== "tools/call") return err(-32601, "Method not found");
  const p = req.params;
  if (!obj(p) || p.name !== "news_search") return err(-32602, "Unknown tool");
  try {
    const text = await newsSearch(obj(p.arguments) ? p.arguments : {});
    return ok({ content: [{ type: "text", text }] });
  } catch (e) {
    const message = e instanceof Error ? (e.name === "AbortError" ? "新闻源超时" : e.message) : "新闻搜索失败";
    return ok({ content: [{ type: "text", text: message }], isError: true });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req: unknown;
  try { req = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); return; }
  const res = await handle(req);
  if (res) process.stdout.write(JSON.stringify(res) + "\n");
});
