import JSZip from "jszip";
import { load } from "cheerio";

export interface IncomingParseLimits {
  maxBytes: number; maxPages: number; maxExpandedBytes: number; maxZipEntries: number;
  maxCharacters: number; maxSheetRows: number; maxSheetColumns: number; maxChunks: number;
}
export const DEFAULT_INCOMING_LIMITS: IncomingParseLimits = {
  maxBytes: 15 * 1024 * 1024, maxPages: 120, maxExpandedBytes: 40 * 1024 * 1024,
  maxZipEntries: 2000, maxCharacters: 240_000, maxSheetRows: 10_000, maxSheetColumns: 80, maxChunks: 240,
};
export interface IncomingChunk { index: number; source: string; text: string }
export interface ParsedIncomingDocument { format: "pdf" | "docx" | "xlsx"; chunks: IncomingChunk[]; truncated: boolean; notices: string[] }

function inspectZip(bytes: Buffer, limits: IncomingParseLimits): void {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw new Error("压缩文档结构无效");
  const count = bytes.readUInt16LE(end + 10), length = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  if (count > limits.maxZipEntries || count === 0xffff || offset + length > end) throw new Error("压缩文档条目超过限制或格式不受支持");
  let cursor = offset, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("压缩文档目录无效");
    const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    expanded += size;
    if ((bytes.readUInt16LE(cursor + 8) & 1) || size === 0xffffffff || compressed === 0xffffffff
      || expanded > limits.maxExpandedBytes || size > 12 * 1024 * 1024 || size > Math.max(1, compressed) * 250
      || /(?:^|[\\/])\.\.(?:[\\/]|$)|^[\\/]|\x00/.test(name)) throw new Error("压缩文档不符合安全体积限制");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (cursor > offset + length) throw new Error("压缩文档目录无效");
  }
}

function xml(value: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error("文档包含不允许的 XML 实体");
  return load(value, { xmlMode: true });
}

/** Text extraction only: no macros, formulas, links, scripts, embedded objects or external relationships execute. */
export async function parseIncomingDocument(input: Uint8Array, filename: string, overrides: Partial<IncomingParseLimits> = {}): Promise<ParsedIncomingDocument> {
  const limits = { ...DEFAULT_INCOMING_LIMITS, ...overrides };
  const bytes = Buffer.from(input);
  if (bytes.byteLength > limits.maxBytes) throw new Error("文件超过允许的体积");
  const extension = filename.toLowerCase().split(".").at(-1);
  if (extension !== "pdf" && extension !== "docx" && extension !== "xlsx") throw new Error("仅支持 PDF、DOCX 和 XLSX；旧版 DOC/XLS、宏文件暂不支持");
  const result: ParsedIncomingDocument = { format: extension, chunks: [], truncated: false, notices: [] };
  let characters = 0;
  function append(source: string, text: string) {
    const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/[ \t]+/g, " ").trim();
    for (let offset = 0; offset < clean.length; offset += 1400) {
      if (characters >= limits.maxCharacters || result.chunks.length >= limits.maxChunks) { result.truncated = true; return; }
      const part = clean.slice(offset, Math.min(offset + 1400, offset + limits.maxCharacters - characters));
      result.chunks.push({ index: result.chunks.length, source, text: part });
      characters += part.length;
      if (part.length < Math.min(1400, clean.length - offset)) result.truncated = true;
    }
  }
  if (extension === "pdf") {
    if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new Error("文件内容不是 PDF");
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true,
      useSystemFonts: false, maxImageSize: 0, stopAtErrors: true, verbosity: 0 });
    try {
      const pdf = await task.promise;
      const count = Math.min(pdf.numPages, limits.maxPages);
      if (pdf.numPages > count) { result.truncated = true; result.notices.push(`PDF 共 ${pdf.numPages} 页，仅处理前 ${count} 页`); }
      for (let page = 1; page <= count; page++) {
        const documentPage = await pdf.getPage(page);
        const content = await documentPage.getTextContent();
        append(`第 ${page} 页`, content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join(""));
        documentPage.cleanup();
        if (characters >= limits.maxCharacters || result.chunks.length >= limits.maxChunks) { result.truncated = true; break; }
      }
      await pdf.destroy();
    } finally { await task.destroy(); }
    if (!result.chunks.length) result.notices.push("未提取到文字；此文件可能是扫描件，当前不执行 OCR");
    return result;
  }
  if (bytes.readUInt32LE(0) !== 0x04034b50) throw new Error("文档内容与扩展名不符");
  inspectZip(bytes, limits);
  const zip = await JSZip.loadAsync(bytes, { createFolders: false });
  async function entry(name: string): Promise<string> {
    const file = zip.file(name);
    if (!file) throw new Error("文档缺少必要结构");
    return file.async("string");
  }
  if (extension === "docx") {
    const $ = xml(await entry("word/document.xml"));
    $("w\\:p").each((index, element) => {
      append(`正文第 ${index + 1} 段`, $(element).find("w\\:t,w\\:tab,w\\:br").map((_i, node) => {
        const name = (node as { name?: string }).name;
        return name === "w:tab" ? "\t" : name === "w:br" ? "\n" : $(node).text();
      }).get().join(""));
    });
    result.notices.push("DOCX 按正文段落定位；不读取批注、内嵌文件或图片，不推算排版页码");
    return result;
  }
  const shared: string[] = [];
  if (zip.file("xl/sharedStrings.xml")) {
    const $ = xml(await entry("xl/sharedStrings.xml"));
    $("si").each((_index, element) => { shared.push($(element).find("t").map((_i, node) => $(node).text()).get().join("")); });
  }
  const rels = xml(await entry("xl/_rels/workbook.xml.rels"));
  const targets = new Map<string, string>();
  rels("Relationship").each((_i, item) => {
    const element = rels(item), target = element.attr("Target") ?? "";
    if (element.attr("TargetMode") !== "External" && /^\/?(?:xl\/)?worksheets\/[a-zA-Z0-9_.-]+\.xml$/.test(target)) {
      targets.set(element.attr("Id") ?? "", target.replace(/^\//, "").replace(/^(?!xl\/)/, "xl/"));
    }
  });
  const workbook = xml(await entry("xl/workbook.xml"));
  const sheets = workbook("sheet").toArray();
  if (sheets.length > 100) throw new Error("工作表数量超过限制");
  for (const sheet of sheets) {
    const name = (workbook(sheet).attr("name") ?? "工作表").slice(0, 80);
    const target = targets.get(workbook(sheet).attr("r:id") ?? "");
    if (!target) continue;
    const $ = xml(await entry(target));
    const rows = $("sheetData > row").toArray();
    if (rows.length > limits.maxSheetRows) result.truncated = true;
    for (const [index, row] of rows.slice(0, limits.maxSheetRows).entries()) {
      const rowNumber = $(row).attr("r") ?? String(index + 1);
      const cells = $(row).children("c").toArray();
      if (cells.length > limits.maxSheetColumns) result.truncated = true;
      const values = cells.slice(0, limits.maxSheetColumns).map(cell => {
        const element = $(cell), value = element.find("v").first().text(), type = element.attr("t");
        const text = type === "s" ? shared[Number(value)] ?? "" : type === "inlineStr" ? element.find("is t").text() : value;
        const reference = element.attr("r") ?? "";
        return `${reference}: ${text}${element.find("f").length ? " [公式缓存值，未重算]" : ""}`;
      });
      append(`工作表「${name}」第 ${rowNumber} 行`, values.join(" | "));
      if (characters >= limits.maxCharacters || result.chunks.length >= limits.maxChunks) { result.truncated = true; break; }
    }
    if (characters >= limits.maxCharacters || result.chunks.length >= limits.maxChunks) break;
  }
  result.notices.push("Excel 保留单元格地址；公式只读取已有缓存值，不执行或重算公式；日期、百分比等数值保留底层原始值，未套用展示格式");
  return result;
}
