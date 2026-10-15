import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import type { DocumentBlock, InlineText } from "./markdown.js";
import { plainText } from "./markdown.js";

// src/ and dist/ have the same directory depth. Deploy the root assets/ folder.
export const DOCUMENT_FONT_PATH = fileURLToPath(new URL("../../assets/document-fonts/NotoSansCJKsc-Regular.otf", import.meta.url));

export function renderPdf(blocks: DocumentBlock[], title: string, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 52, info: { Title: title, Creator: "QQ Group Bot" }, font: DOCUMENT_FONT_PATH, compress: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const fail = (error: Error): void => {
      if (failed) return;
      failed = true;
      doc.destroy();
      reject(error);
    };
    doc.on("error", fail);
    doc.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) fail(new Error(`生成的 PDF 超过文件大小上限 (${maxBytes} 字节)`));
      else chunks.push(chunk);
    });
    doc.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });

    const availableWidth = doc.page.width - 104;
    function paragraph(runs: InlineText[], indent = 0, prefix = "", size = 11): void {
      const x = 52 + Math.min(indent, 9) * 16;
      doc.font(DOCUMENT_FONT_PATH).fontSize(size).fillColor("#22262C").strokeColor("#22262C");
      const content = prefix ? [{ text: prefix }, ...runs] : runs;
      content.forEach((run, i) => {
        const last = i === content.length - 1;
        doc.fillColor(run.code ? "#4B5563" : "#22262C");
        doc.lineWidth(run.bold ? 0.25 : 0);
        const options: PDFKit.Mixins.TextOptions = {
          width: availableWidth - (x - 52),
          lineGap: 3,
          continued: !last,
          stroke: !!run.bold,
          fill: true,
          strike: !!run.strike,
          oblique: run.italic ? 10 : 0,
        };
        if (i === 0) doc.text(run.text, x, doc.y, options);
        else doc.text(run.text, options);
      });
      doc.x = 52;
      doc.moveDown(0.65);
    }
    try {
      for (const block of blocks) {
        switch (block.kind) {
          case "heading": {
            const size = [23, 18, 15, 13, 12, 11][Math.min(6, Math.max(1, block.depth)) - 1] ?? 11;
            if (doc.y + size * 3 > doc.page.height - 52) doc.addPage();
            paragraph(block.runs.map((run) => ({ ...run, bold: true })), 0, "", size);
            break;
          }
          case "paragraph": paragraph(block.runs, block.indent, block.prefix ?? ""); break;
          case "code":
            doc.font(DOCUMENT_FONT_PATH).fontSize(9).fillColor("#4B5563");
            doc.text(block.text, 62, doc.y, { width: availableWidth - 20, lineGap: 3 });
            doc.x = 52;
            doc.moveDown(0.8);
            break;
          case "rule":
            if (doc.y + 14 > doc.page.height - 52) doc.addPage();
            doc.moveTo(52, doc.y).lineTo(doc.page.width - 52, doc.y).lineWidth(0.5).strokeColor("#D2D6DC").stroke();
            doc.moveDown(0.8);
            break;
          case "table": {
            doc.font(DOCUMENT_FONT_PATH).fontSize(9).fillColor("#22262C");
            const columnWidth = availableWidth / (block.rows[0]?.length || 1);
            // PDFKit cannot split one oversized table cell across pages. Preserve
            // its full content as labeled paragraphs rather than clipping it.
            const oversized = block.rows.some((row) => row.some((cell) => doc.heightOfString(plainText(cell), { width: Math.max(12, columnWidth - 12), lineGap: 2 }) > doc.page.height - 130));
            if (oversized) {
              const headers = block.rows[0]?.map(plainText) ?? [];
              for (const row of block.rows.slice(1)) row.forEach((cell, i) => paragraph(cell, 0, `${headers[i] || `第 ${i + 1} 列`}：`));
            } else {
              doc.table({
                position: { x: 52, y: doc.y },
                maxWidth: availableWidth,
                columnStyles: Array.from({ length: block.rows[0]?.length || 1 }, () => "*"),
                defaultStyle: { border: 0.5, borderColor: "#D2D6DC", padding: 6, textOptions: { lineGap: 2 } },
                data: block.rows.map((row, rowIndex) => row.map((cell, col) => ({
                  text: plainText(cell),
                  font: { src: DOCUMENT_FONT_PATH, size: 9 },
                  align: { x: block.align[col] ?? "left" },
                  ...(rowIndex === 0 ? { backgroundColor: "#EEF0F3", type: "TH" as const } : {}),
                }))),
              });
              doc.x = 52;
              doc.moveDown(0.8);
            }
            break;
          }
        }
      }
      doc.end();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
