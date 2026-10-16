#!/usr/bin/env node
/**
 * Render the sibling cards.html, or any matching card document, without a build step.
 *
 *   node render.mjs --input theme-proposals.html --out ./proofs
 *   node render.mjs --out ./export --scale 2 --columns 4 --mobile
 *
 * Requires an existing Puppeteer installation and Chrome/Edge. The resolver checks
 * this project, sibling tooling, and PUPPETEER_MODULE; no packages are installed.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join, extname, basename, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const options = { input: join(scriptDir, 'cards.html'), out: join(scriptDir, 'rendered'), scale: 1, columns: null, mobile: false, browser: process.env.CHROME_PATH, module: process.env.PUPPETEER_MODULE };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--help' || arg === '-h') {
    console.log('Usage: node render.mjs [--input FILE] [--out DIR] [--scale 1|2] [--columns N] [--mobile] [--browser EXE] [--module PUPPETEER_ENTRY]');
    process.exit(0);
  }
  if (arg === '--mobile') { options.mobile = true; continue; }
  const key = { '--input': 'input', '--out': 'out', '--scale': 'scale', '--columns': 'columns', '--browser': 'browser', '--module': 'module' }[arg];
  if (!key || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${arg}`);
  options[key] = process.argv[++i];
}
options.input = resolve(options.input);
options.out = resolve(options.out);
options.scale = Number(options.scale);
options.columns = options.columns === null ? null : Number(options.columns);
if (!(options.scale > 0 && options.scale <= 4)) throw new Error('--scale must be greater than 0 and at most 4.');
if (options.columns !== null && (!Number.isInteger(options.columns) || options.columns < 1)) throw new Error('--columns must be a positive integer.');
if (!existsSync(options.input)) throw new Error(`Input document not found: ${options.input}`);

async function loadPuppeteer() {
  const roots = [scriptDir, dirname(scriptDir), process.cwd(), join(scriptDir, '..', '..', 'glaukopis-promo', 'tools')];
  const entries = options.module ? [resolve(options.module)] : [];
  for (const root of roots) {
    const requireFromRoot = createRequire(join(root, '_card_render_resolver.cjs'));
    for (const name of ['puppeteer', 'puppeteer-core']) {
      try { entries.push(requireFromRoot.resolve(name)); } catch { /* Try the next existing installation. */ }
    }
  }
  for (const entry of [...new Set(entries)]) {
    try {
      const imported = await import(pathToFileURL(entry).href);
      return { api: imported.default ?? imported, entry };
    } catch (error) {
      if (options.module && entry === resolve(options.module)) throw error;
    }
  }
  throw new Error('No Puppeteer installation found. Set PUPPETEER_MODULE or pass --module with its entry file.');
}

function findBrowser(api) {
  const candidates = [
    options.browser,
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  try { candidates.push(api.executablePath()); } catch { /* puppeteer-core needs an explicit browser. */ }
  const executable = candidates.find(candidate => candidate && existsSync(candidate));
  if (!executable) throw new Error('No Chrome/Edge executable found. Set CHROME_PATH or pass --browser.');
  return executable;
}

async function waitForAssets(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(async image => {
      if (!image.complete) await new Promise(resolve => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); });
      try { await image.decode(); } catch { /* Report broken images in diagnostics. */ }
    }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };
const inputDir = dirname(options.input);
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const target = resolve(inputDir, `.${pathname}`);
    if (target !== inputDir && !target.startsWith(inputDir + sep)) { response.writeHead(403); response.end(); return; }
    if (!(await stat(target)).isFile()) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': types[extname(target).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(await readFile(target));
  } catch { response.writeHead(404); response.end(); }
});

const diagnostics = { generatedAt: new Date().toISOString(), input: options.input, output: options.out, cssSize: { width: 1080, height: 1440 }, deviceScaleFactor: options.scale, browser: null, puppeteerModule: null, cards: [], messages: [] };
let browser;
let phase = 'discovery';
try {
  await mkdir(options.out, { recursive: true });
  const loaded = await loadPuppeteer();
  diagnostics.puppeteerModule = loaded.entry;
  diagnostics.browser = findBrowser(loaded.api);
  browser = await loaded.api.launch({ executablePath: diagnostics.browser, headless: true, args: ['--allow-file-access-from-files', '--font-render-hinting=none'] });
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const base = `http://127.0.0.1:${server.address().port}/${encodeURIComponent(basename(options.input))}`;
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1440, deviceScaleFactor: options.scale });
  page.setDefaultTimeout(45000);
  page.on('console', message => { if (['warn', 'error'].includes(message.type())) diagnostics.messages.push({ phase, type: `console-${message.type()}`, text: message.text() }); });
  page.on('pageerror', error => diagnostics.messages.push({ phase, type: 'pageerror', text: error.message }));
  page.on('requestfailed', request => diagnostics.messages.push({ phase, type: 'requestfailed', url: request.url(), text: request.failure()?.errorText }));
  page.on('response', response => { if (response.status() >= 400) diagnostics.messages.push({ phase, type: 'http-error', status: response.status(), url: response.url() }); });
  await page.goto(`${base}?card=1`, { waitUntil: 'networkidle0', timeout: 60000 });
  const ids = await page.$$eval('.card[data-card]', cards => cards.map(card => card.dataset.card));
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Expected at least one .card[data-card] with unique card IDs.');
  if (ids.some(id => !/^\d+$/.test(id))) throw new Error('Card IDs must be numeric so export filenames remain safe.');

  for (const id of ids) {
    phase = `card${id}`;
    await page.goto(`${base}?card=${id}`, { waitUntil: 'networkidle0', timeout: 60000 });
    await waitForAssets(page);
    const selector = `.card[data-card="${id}"] .card-inner`;
    await page.waitForSelector(selector, { visible: true });
    const card = await page.$(selector);
    const geometry = await card.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const box = rect => ({ x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100, width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 });
      const outside = rect => rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1;
      const textOverflow = [];
      const localOverflow = [];
      for (const child of element.querySelectorAll('*')) {
        const style = getComputedStyle(child);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const ownText = [...child.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        if (ownText && outside(child.getBoundingClientRect())) textOverflow.push({ tag: child.tagName, class: child.className?.baseVal ?? child.className, text: child.textContent.trim().slice(0, 120), bounds: box(child.getBoundingClientRect()) });
        if (ownText && (child.scrollWidth > child.clientWidth + 2 || child.scrollHeight > child.clientHeight + 2) && child.clientWidth > 0 && child.clientHeight > 0) localOverflow.push({ tag: child.tagName, class: child.className?.baseVal ?? child.className, text: child.textContent.trim().slice(0, 120), client: [child.clientWidth, child.clientHeight], scroll: [child.scrollWidth, child.scrollHeight], overflow: [style.overflowX, style.overflowY] });
      }
      return { bounds: box(bounds), textOverflow, localOverflow, fonts: [...document.fonts].map(font => ({ family: font.family, weight: font.weight, style: font.style, status: font.status })), brokenImages: [...element.querySelectorAll('img')].filter(image => !image.complete || !image.naturalWidth).map(image => image.src) };
    });
    if (Math.abs(geometry.bounds.width - 1080) > 0.5 || Math.abs(geometry.bounds.height - 1440) > 0.5) throw new Error(`Card ${id} is ${geometry.bounds.width} x ${geometry.bounds.height}; expected 1080 x 1440 CSS pixels.`);
    const filename = `card${id}.png`;
    await card.screenshot({ path: join(options.out, filename), type: 'png', animations: 'disabled' });
    diagnostics.cards.push({ id, file: filename, ...geometry });
    console.log(`Rendered ${filename} (${1080 * options.scale} x ${1440 * options.scale})`);
  }

  phase = 'contact-sheet';
  const columns = Math.min(options.columns ?? (ids.length <= 4 ? 2 : 4), ids.length);
  const thumbWidth = 540;
  const thumbHeight = 720;
  const gap = 24;
  const pad = 24;
  const labelHeight = 32;
  const rows = Math.ceil(ids.length / columns);
  const width = pad * 2 + columns * thumbWidth + (columns - 1) * gap;
  const height = pad * 2 + rows * (thumbHeight + labelHeight) + (rows - 1) * gap;
  const thumbnails = await Promise.all(diagnostics.cards.map(async card => `<figure><figcaption>${String(card.id).padStart(2, '0')}</figcaption><img src="data:image/png;base64,${(await readFile(join(options.out, card.file))).toString('base64')}" alt="Card ${card.id}"></figure>`));
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;background:#fff4df}body{padding:${pad}px;display:grid;grid-template-columns:repeat(${columns},${thumbWidth}px);gap:${gap}px}figure{margin:0;width:${thumbWidth}px;height:${thumbHeight + labelHeight}px}figcaption{height:${labelHeight}px;color:#086849;font:15px/24px Arial,sans-serif;letter-spacing:2px}img{display:block;width:${thumbWidth}px;height:${thumbHeight}px}</style>${thumbnails.join('')}`, { waitUntil: 'load' });
  await page.evaluate(async () => { await Promise.all([...document.images].map(image => image.decode())); });
  await page.screenshot({ path: join(options.out, 'contact-sheet.png'), type: 'png', fullPage: false });
  diagnostics.contactSheet = { file: 'contact-sheet.png', width, height, columns, rows, background: '#fff4df', labelColor: '#086849' };
  if (options.mobile) {
    diagnostics.mobile = [];
    for (const viewport of [{ width: 412, height: 915 }, { width: 360, height: 800 }]) {
      phase = `mobile-${viewport.width}`;
      await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await page.goto(base, { waitUntil: 'networkidle0', timeout: 60000 });
      await waitForAssets(page);
      const geometry = await page.evaluate(() => {
        const root = document.documentElement;
        const box = element => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return { x: Math.round(rect.x * 100) / 100, y: Math.round((rect.y + scrollY) * 100) / 100, width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100, layoutWidth: element.offsetWidth, layoutHeight: element.offsetHeight, scaleX: element.offsetWidth ? Math.round(rect.width / element.offsetWidth * 10000) / 10000 : null, scaleY: element.offsetHeight ? Math.round(rect.height / element.offsetHeight * 10000) / 10000 : null, display: style.display, transform: style.transform };
        };
        const documentWidth = Math.max(root.scrollWidth, document.body.scrollWidth);
        const documentHeight = Math.max(root.scrollHeight, document.body.scrollHeight);
        const overflow = Math.max(0, documentWidth - root.clientWidth);
        const cards = [...document.querySelectorAll('.card[data-card]')].map(card => ({ id: card.dataset.card, card: box(card), inner: box(card.querySelector('.card-inner')) }));
        return { viewport: { width: innerWidth, height: innerHeight }, document: { width: documentWidth, height: documentHeight, clientWidth: root.clientWidth }, horizontalOverflow: overflow > 1, horizontalOverflowBy: overflow, cards, offscreenCards: cards.filter(card => card.card && card.card.display !== 'none' && (card.card.x < -1 || card.card.x + card.card.width > root.clientWidth + 1)).map(card => card.id), brokenImages: [...document.images].filter(image => !image.complete || !image.naturalWidth).map(image => image.src), fonts: [...document.fonts].map(font => ({ family: font.family, weight: font.weight, style: font.style, status: font.status })) };
      });
      const file = `mobile-${viewport.width}.png`;
      await page.screenshot({ path: join(options.out, file), type: 'png', fullPage: true });
      diagnostics.mobile.push({ file, requestedViewport: viewport, ...geometry });
      console.log(`Rendered ${file}; horizontal overflow: ${geometry.horizontalOverflowBy}px.`);
    }
  }
  diagnostics.summary = { cards: diagnostics.cards.length, textOverflow: diagnostics.cards.reduce((sum, card) => sum + card.textOverflow.length, 0), localOverflow: diagnostics.cards.reduce((sum, card) => sum + card.localOverflow.length, 0), brokenImages: diagnostics.cards.reduce((sum, card) => sum + card.brokenImages.length, 0), messages: diagnostics.messages.length, ...(options.mobile ? { mobileHorizontalOverflow: diagnostics.mobile.filter(check => check.horizontalOverflow).length } : {}) };
  console.log(`Rendered contact-sheet.png (${columns} columns x ${rows} rows). Diagnostics: ${join(options.out, 'render-diagnostics.json')}`);
} catch (error) {
  diagnostics.failure = { phase, message: error.message, stack: error.stack };
  process.exitCode = 1;
  console.error(error.message);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(options.out, 'render-diagnostics.json'), JSON.stringify(diagnostics, null, 2) + '\n');
}
