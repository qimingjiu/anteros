import { Lexer, type Token, type Tokens } from "marked";

export interface InlineText {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

export type DocumentBlock =
  | { kind: "heading"; depth: number; runs: InlineText[] }
  | { kind: "paragraph"; runs: InlineText[]; indent: number; prefix?: string; quote?: boolean }
  | { kind: "code"; text: string }
  | { kind: "table"; rows: InlineText[][][]; align: ("left" | "center" | "right" | null)[] }
  | { kind: "rule" };

function children(token: Token): Token[] {
  return "tokens" in token ? token.tokens ?? [] : [];
}

function tokenText(token: Token): string {
  return "text" in token && typeof token.text === "string" ? token.text : token.raw;
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (full, decimal, hex, name) => {
    if (decimal || hex) {
      const value = Number.parseInt(decimal ?? hex, decimal ? 10 : 16);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : full;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[String(name).toLowerCase()] ?? full;
  });
}

function inline(tokens: Token[], style: Omit<InlineText, "text"> = {}, depth = 0): InlineText[] {
  if (depth > 24) throw new Error("Markdown 嵌套过深，请简化文档结构");
  return tokens.flatMap((token): InlineText[] => {
    switch (token.type) {
      case "strong": return inline(children(token), { ...style, bold: true }, depth + 1);
      case "em": return inline(children(token), { ...style, italic: true }, depth + 1);
      case "del": return inline(children(token), { ...style, strike: true }, depth + 1);
      case "codespan": return [{ ...style, code: true, text: token.text }];
      case "br": return [{ ...style, text: "\n" }];
      case "link": {
        const runs = inline(children(token), style, depth + 1);
        const label = runs.map((run) => run.text).join("");
        if (token.href !== label) runs.push({ ...style, text: ` (${token.href})` });
        return runs;
      }
      case "image": return [{ ...style, text: `[图片：${decodeEntities(token.text || "未提供说明")}]` }];
      case "checkbox": return [{ ...style, text: token.checked ? "[x] " : "[ ] " }];
      default:
        return children(token).length ? inline(children(token), style, depth + 1) : [{ ...style, text: decodeEntities(tokenText(token)) }];
    }
  });
}

export function plainText(runs: InlineText[]): string {
  return runs.map((run) => run.text).join("");
}

/** Parses Markdown as data. HTML stays literal and image URLs are never fetched. */
export function parseDocument(markdown: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  let count = 0;
  function walk(tokens: Token[], indent = 0, quote = false, depth = 0, prefix?: string): void {
    if (depth > 24) throw new Error("Markdown 嵌套过深，请简化文档结构");
    let nextPrefix = prefix;
    for (const token of tokens) {
      if (++count > 10000) throw new Error("Markdown 内容过于复杂，请减少段落或表格数量");
      switch (token.type) {
        case "space": case "def": case "checkbox": break;
        case "heading": blocks.push({ kind: "heading", depth: token.depth, runs: inline(children(token)) }); break;
        case "paragraph": case "text": case "html":
          blocks.push({ kind: "paragraph", runs: children(token).length ? inline(children(token)) : [{ text: decodeEntities(tokenText(token)) }], indent, quote, ...(nextPrefix ? { prefix: nextPrefix } : {}) });
          nextPrefix = undefined;
          break;
        case "code": blocks.push({ kind: "code", text: token.text }); break;
        case "hr": blocks.push({ kind: "rule" }); break;
        case "blockquote": walk(children(token), indent + 1, true, depth + 1); break;
        case "list": {
          const list = token as Tokens.List;
          list.items.forEach((item, i) => {
            const marker = item.task ? (item.checked ? "[x] " : "[ ] ") : list.ordered ? `${Number(list.start || 1) + i}. ` : "• ";
            walk(item.tokens, indent + 1, quote, depth + 1, marker);
          });
          break;
        }
        case "table": {
          const table = token as Tokens.Table;
          if (table.header.length > 12 || table.rows.length > 1000) throw new Error("表格最多支持 12 列、1000 行，请拆分表格");
          blocks.push({ kind: "table", rows: [table.header, ...table.rows].map((row) => row.map((cell) => inline(cell.tokens))), align: table.align });
          break;
        }
        default:
          if (children(token).length) walk(children(token), indent, quote, depth + 1);
          else if (token.raw) blocks.push({ kind: "paragraph", runs: [{ text: token.raw }], indent, quote });
      }
    }
  }
  walk(Lexer.lex(markdown, { gfm: true, breaks: false }));
  return blocks;
}
