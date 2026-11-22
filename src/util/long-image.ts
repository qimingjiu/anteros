// 2026-11-09：长回复转图片（Markdown → HTML → 无头 Chromium 截长图）。主人要求。
import { Marked } from "marked";
import puppeteer, { type Browser } from "puppeteer-core";
import { existsSync } from "node:fs";
import { logger } from "./logger.js";
const log = logger("long-image");

const CANDIDATES = [
  process.env.LONG_IMAGE_CHROME,
  "/root/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell",
  "/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
].filter(Boolean) as string[];

const md = new Marked({ gfm: true, breaks: true, renderer: { html(token: { text: string }) { return escapeHtml(token.text); } } as never });

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let queue: Promise<unknown> = Promise.resolve();

function chromePath(): string | null {
  for (const p of CANDIDATES) if (existsSync(p)) return p;
  return null;
}

async function getBrowser(): Promise<Browser> {
  if (browser?.connected) return browser;
  if (launching) return launching;
  const exe = chromePath();
  if (!exe) throw new Error("找不到 Chromium");
  launching = puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  }).then(b => { browser = b; launching = null; return b; }, e => { launching = null; throw e; });
  return launching;
}

function scheduleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { const b = browser; browser = null; b?.close().catch(() => {}); }, 5 * 60_000);
}

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;background:#f4f1ec}
body{font-family:"Noto Sans CJK SC","Noto Sans SC",sans-serif;color:#3a3f47;font-size:17px;line-height:1.78;-webkit-font-smoothing:antialiased}
.card{width:720px;margin:0;padding:40px 44px 34px;background:#fbfaf7}
.card>:first-child{margin-top:0}
h1,h2,h3,h4{color:#2e3440;line-height:1.4;margin:1.3em 0 .5em;font-weight:700}
h1{font-size:25px}h2{font-size:21px;padding-bottom:.25em;border-bottom:1px solid #e3ddd3}h3{font-size:18.5px}h4{font-size:17px}
p{margin:.55em 0}
a{color:#5a7a9a;text-decoration:none}
strong{color:#2e3440}
ul,ol{padding-left:1.4em;margin:.5em 0}li{margin:.22em 0}
blockquote{margin:.8em 0;padding:.35em 1em;border-left:3px solid #c9bfae;background:#f3efe8;color:#5b6068}
code{font-family:"Noto Sans Mono CJK SC",monospace;font-size:.88em;background:#eeeae3;padding:.1em .35em;border-radius:4px}
pre{background:#f0ece5;padding:14px 16px;border-radius:8px;overflow:hidden;white-space:pre-wrap;word-break:break-all;font-size:14.5px;line-height:1.6}
pre code{background:none;padding:0}
table{border-collapse:collapse;margin:.8em 0;width:100%;font-size:15.5px}
th,td{border:1px solid #e1dbd1;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f1ede6}
hr{border:none;border-top:1px solid #e3ddd3;margin:1.3em 0}
img{max-width:100%}
.foot{margin-top:26px;font-size:12.5px;color:#a6a29a;text-align:right;letter-spacing:.08em}
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

/** 把 Markdown 渲染成一张 PNG，返回 base64。失败时抛错，由调用方退回纯文本。 */
export async function renderLongImage(markdown: string, footer = "κόραξ"): Promise<string> {
  const job = queue.then(async () => {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      const body = await md.parse(markdown);
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div class="card">${body}<div class="foot">${escapeHtml(footer)}</div></div></body></html>`;
      await page.setViewport({ width: 720, height: 400, deviceScaleFactor: 2 });
      await page.setContent(html, { waitUntil: "load", timeout: 15_000 });
      const el = await page.$(".card");
      if (!el) throw new Error("渲染失败");
      const buf = await el.screenshot({ type: "png", encoding: "binary" });
      return Buffer.from(buf).toString("base64");
    } finally {
      await page.close().catch(() => {});
      scheduleClose();
    }
  });
  queue = job.catch(() => {});
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("长图渲染超时")), 30_000));
  try {
    return await Promise.race([job, timeout]);
  } catch (e) {
    log.warn("长图渲染失败，改发文字", { error: String(e) });
    throw e;
  }
}
