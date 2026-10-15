import { AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, type IParagraphOptions } from "docx";
import type { DocumentBlock, InlineText } from "./markdown.js";

const FONT = { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Microsoft YaHei", cs: "Calibri" };
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

function runs(content: InlineText[]): TextRun[] {
  return content.flatMap((run) => run.text.split("\n").map((text, i) => new TextRun({
    text,
    ...(i ? { break: 1 } : {}),
    bold: run.bold,
    italics: run.italic,
    strike: run.strike,
    font: run.code ? { ...FONT, ascii: "Consolas", hAnsi: "Consolas" } : FONT,
    ...(run.code ? { shading: { fill: "F2F3F5" } } : {}),
  })));
}

export async function renderDocx(blocks: DocumentBlock[], title: string): Promise<Buffer> {
  const children: (Paragraph | Table)[] = blocks.map((block) => {
    switch (block.kind) {
      case "heading": return new Paragraph({ heading: HEADINGS[Math.min(6, Math.max(1, block.depth)) - 1], children: runs(block.runs), spacing: { before: 240, after: 120 }, keepNext: true });
      case "paragraph": {
        const options: IParagraphOptions = {
          children: [...(block.prefix ? [new TextRun({ text: block.prefix, font: FONT })] : []), ...runs(block.runs)],
          spacing: { after: 140, line: 320 },
          ...(block.indent ? { indent: { left: Math.min(block.indent, 9) * 360 } } : {}),
          ...(block.quote ? { border: { left: { color: "A7ADB5", style: BorderStyle.SINGLE, size: 12, space: 10 } } } : {}),
        };
        return new Paragraph(options);
      }
      case "code": return new Paragraph({
        children: runs([{ text: block.text, code: true }]),
        shading: { fill: "F2F3F5" },
        spacing: { before: 100, after: 180, line: 270 },
      });
      case "rule": return new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, color: "D2D6DC", size: 4 } }, spacing: { before: 100, after: 100 } });
      case "table": return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: block.rows.map((row, i) => new TableRow({
          tableHeader: i === 0,
          children: row.map((cell, col) => new TableCell({
            ...(i === 0 ? { shading: { fill: "EEF0F3" } } : {}),
            margins: { top: 100, bottom: 100, left: 100, right: 100 },
            children: [new Paragraph({
              children: runs(cell.map((run) => ({ ...run, bold: i === 0 || run.bold }))),
              alignment: block.align[col] === "center" ? AlignmentType.CENTER : block.align[col] === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT,
              spacing: { after: 60, line: 280 },
            })],
          })),
        })),
      });
    }
  });
  const document = new Document({
    title,
    creator: "QQ Group Bot",
    styles: { default: { document: { run: { font: FONT, size: 22 }, paragraph: { spacing: { after: 140 } } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }],
  });
  return Packer.toBuffer(document);
}
