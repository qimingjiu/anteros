import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import JSZip from "jszip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { DocumentService, safeDocumentFilename } from "../src/documents/index.js";
import { parseDocument } from "../src/documents/markdown.js";

const SAMPLE = `# 中文工作计划

这是**重要**的段落，包含 *斜体*、~~删除线~~ 和 \`code\`。

## 待办

1. 整理需求
2. 验证中文文档
   - 检查附件

- [x] 已完成
- [ ] 待完成

> 这是引用。

| 项目 | 状态 |
| --- | --- |
| 文档 | 已完成 |
| PDF | 中文正常 |

\`\`\`typescript
const message = "你好，世界";
console.log(message);
\`\`\`

[资料](https://example.com/docs)

![插图说明](https://127.0.0.1/never-fetch.png)
`;

async function temporary(t: Parameters<Parameters<typeof test>[1]>[0]): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qq-documents-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function extractPdf(data: Uint8Array): Promise<{ pages: number; text: string; positions: { text: string; y: number }[] }> {
  const pdf = await getDocument({ data: new Uint8Array(data), useSystemFonts: false }).promise;
  try {
    const texts: string[] = [];
    const positions: { text: string; y: number }[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      for (const item of content.items) if ("str" in item) {
        texts.push(item.str);
        positions.push({ text: item.str, y: item.transform[5] });
      }
    }
    return { pages: pdf.numPages, text: texts.join(" "), positions };
  } finally { await pdf.destroy(); }
}

test("文档：Markdown 原文、hash 与元数据一致，写入没有临时残留", async (t) => {
  const directory = await temporary(t);
  const service = new DocumentService({ outputDir: directory });
  const artifact = await service.create({ format: "md", markdown: SAMPLE, filename: "工作计划" });
  const data = await fs.readFile(artifact.path);
  assert.equal(data.toString("utf8"), SAMPLE);
  assert.equal(artifact.bytes, data.length);
  assert.equal(artifact.sha256, crypto.createHash("sha256").update(data).digest("hex"));
  assert.equal(artifact.filename, "工作计划.md");
  assert.equal(artifact.mimeType, "text/markdown; charset=utf-8");
  assert.ok(path.isAbsolute(artifact.path));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(artifact.path), "artifact.json"), "utf8")), artifact);
  assert.deepEqual((await fs.readdir(path.dirname(artifact.path))).sort(), ["artifact.json", "工作计划.md"]);
});

test("文档：相同文件名生成独立文件，不覆盖历史结果", async (t) => {
  const directory = await temporary(t);
  const service = new DocumentService({ outputDir: directory });
  const [first, second] = await Promise.all([
    service.create({ format: "md", filename: "计划.md", markdown: "第一版" }),
    service.create({ format: "md", filename: "计划.md", markdown: "第二版" }),
  ]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.path, second.path);
  assert.equal(await fs.readFile(first.path, "utf8"), "第一版");
  assert.equal(await fs.readFile(second.path, "utf8"), "第二版");
});

test("文档：文件名兼容 Windows，路径字符和设备名无法逃逸目录", () => {
  assert.equal(safeDocumentFilename("../../CON.pdf", "docx"), "_.._CON.docx");
  assert.equal(safeDocumentFilename("NUL.txt", "pdf"), "文档.pdf");
  assert.equal(safeDocumentFilename("COM¹", "pdf"), "文档.pdf");
  assert.equal(safeDocumentFilename("..", "md"), "文档.md");
  assert.equal(safeDocumentFilename("备忘录.pdf", "md"), "备忘录.md");
  assert.ok(Buffer.byteLength(safeDocumentFilename("中文".repeat(200), "docx")) < 190);
  assert.doesNotMatch(safeDocumentFilename('a\\b/:*?"<>|\0\u202epdf', "md"), /[\\/:*?"<>|\0\u202e]/);
});

test("文档：任务列表的勾选状态每项只出现一次", () => {
  const blocks = parseDocument("- [x] 已完成\n- [ ] 待完成");
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => block.kind === "paragraph" ? `${block.prefix}${block.runs.map((run) => run.text).join("")}` : ""), ["[x] 已完成", "[ ] 待完成"]);
});

test("文档：DOCX 内容、中文字体、标题、表格和代码均写入真实 OOXML", async (t) => {
  const service = new DocumentService({ outputDir: await temporary(t) });
  const artifact = await service.create({ format: "docx", title: "中文工作计划", markdown: SAMPLE });
  const zip = await JSZip.loadAsync(await fs.readFile(artifact.path));
  const xml = await zip.file("word/document.xml")!.async("text");
  assert.match(xml, /中文工作计划/);
  assert.match(xml, /整理需求/);
  assert.match(xml, /你好，世界/);
  assert.match(xml, /w:pStyle w:val="Heading1"/);
  assert.match(xml, /<w:tbl>/);
  assert.match(xml, /w:eastAsia="Microsoft YaHei"/);
  assert.match(xml, /https:\/\/example.com\/docs/);
  assert.match(xml, /插图说明/);
  assert.doesNotMatch(xml, /never-fetch\.png/);
  assert.match(xml, /<w:b\/>/);
});

test("文档：PDF 中文可提取，表格与代码没有丢字，图片地址不读取", async (t) => {
  const service = new DocumentService({ outputDir: await temporary(t) });
  const artifact = await service.create({ format: "pdf", title: "中文工作计划", markdown: SAMPLE });
  const data = await fs.readFile(artifact.path);
  assert.equal(data.subarray(0, 5).toString(), "%PDF-");
  const pdf = await extractPdf(data);
  const compact = pdf.text.replace(/\s/g, "");
  for (const text of ["中文工作计划", "整理需求", "中文正常", "你好，世界", "插图说明", "https://example.com/docs"]) assert.ok(compact.includes(text), `PDF 缺少 ${text}`);
  assert.equal(pdf.pages, 1);
  assert.doesNotMatch(pdf.text, /never-fetch/);
  assert.ok(pdf.positions.every((item) => item.y > 40), "PDF 文字不能跌到页面底部之外");
});

test("文档：多页 PDF 保留末段和跨页表格全部数据", async (t) => {
  const service = new DocumentService({ outputDir: await temporary(t) });
  const rows = Array.from({ length: 100 }, (_, i) => `| 项目${i} | 数据${i} |`).join("\n");
  const markdown = `# 长文档\n\n${"这是连续正文，跨页也要完整。\n\n".repeat(50)}| 项目 | 数据 |\n| --- | --- |\n${rows}\n\n最后一段完整保留。`;
  const artifact = await service.create({ format: "pdf", markdown });
  const pdf = await extractPdf(await fs.readFile(artifact.path));
  assert.ok(pdf.pages > 2);
  const compact = pdf.text.replace(/\s/g, "");
  for (let i = 0; i < 100; i++) assert.ok(compact.includes(`项目${i}`) && compact.includes(`数据${i}`));
  assert.ok(compact.includes("最后一段完整保留。"));
  assert.ok(pdf.positions.every((item) => item.y > 30), "表格跨页不能超出底部边界");
});

test("文档：超高表格单元格转为标注段落，完整保留内容", async (t) => {
  const service = new DocumentService({ outputDir: await temporary(t) });
  const text = "这是一段很长的中文说明。".repeat(180) + "说明终点";
  const artifact = await service.create({ format: "pdf", markdown: `| 项目 | 说明 |\n| --- | --- |\n| 示例 | ${text} |` });
  const pdf = await extractPdf(await fs.readFile(artifact.path));
  assert.ok(pdf.pages > 1);
  assert.ok(pdf.text.replace(/\s/g, "").includes("说明终点"));
});

test("文档：空内容、非法格式、超长内容和无效控制符都明确拒绝", async (t) => {
  const directory = await temporary(t);
  const service = new DocumentService({ outputDir: directory, maxInputChars: 10 });
  await assert.rejects(service.create({ format: "md", markdown: " \n " }), /不能为空/);
  await assert.rejects(service.create({ format: "exe" as "md", markdown: "正文" }), /只支持/);
  for (const format of [["md"], ["docx"], ["pdf"], null, { format: "md" }]) {
    await assert.rejects(service.create({ format: format as unknown as "md", markdown: "正文" }), /只支持/);
  }
  await assert.rejects(service.create({ format: "md", markdown: "a".repeat(11) }), /字符上限/);
  await assert.rejects(service.create({ format: "docx", markdown: "正文\0" }), /控制字符/);
  await assert.rejects(service.create({ format: "docx", markdown: "正文", title: "标题\0" }), /控制字符/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("文档：生成结果超限时清理失败产物，后续请求仍可成功", async (t) => {
  const directory = await temporary(t);
  const service = new DocumentService({ outputDir: directory, maxFileBytes: 10 });
  await assert.rejects(service.create({ format: "pdf", markdown: "中文 PDF" }), /大小上限/);
  await assert.rejects(service.create({ format: "docx", markdown: "中文 Word" }), /大小上限/);
  assert.deepEqual(await fs.readdir(directory), []);
  const artifact = await service.create({ format: "md", markdown: "好" });
  assert.equal(await fs.readFile(artifact.path, "utf8"), "好");
});

test("文档：并发请求在多个实例间仍遵守配额，不淘汰未过期文件", async (t) => {
  const directory = await temporary(t);
  const first = new DocumentService({ outputDir: directory, maxRetainedFiles: 1 });
  const second = new DocumentService({ outputDir: directory, maxRetainedFiles: 1 });
  const results = await Promise.allSettled([first.create({ format: "md", markdown: "第一份" }), second.create({ format: "md", markdown: "第二份" })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await fs.readdir(directory)).length, 1);
  const artifact = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<DocumentService["create"]>>>).value;
  assert.equal(await fs.readFile(artifact.path, "utf8"), "第一份");
});

test("文档：过期清理只清理本模块目录，保留其他文件与目录", async (t) => {
  const directory = await temporary(t);
  const service = new DocumentService({ outputDir: directory, maxRetainedFiles: 1, retentionHours: 1 });
  const old = await service.create({ format: "md", markdown: "旧文件" });
  await fs.mkdir(path.join(directory, "manual-files"));
  await fs.writeFile(path.join(directory, "manual-files", "important.txt"), "保留");
  await fs.writeFile(path.join(directory, "manual.txt"), "保留");
  const expired = new Date(Date.now() - 2 * 3600000);
  await fs.utimes(path.dirname(old.path), expired, expired);
  const fresh = await service.create({ format: "md", markdown: "新文件" });
  await assert.rejects(fs.access(old.path));
  assert.equal(await fs.readFile(fresh.path, "utf8"), "新文件");
  assert.equal(await fs.readFile(path.join(directory, "manual-files", "important.txt"), "utf8"), "保留");
  assert.equal(await fs.readFile(path.join(directory, "manual.txt"), "utf8"), "保留");
});

test("文档：深层 Markdown 被拒绝且不留下半成品", async (t) => {
  const directory = await temporary(t);
  const service = new DocumentService({ outputDir: directory });
  await assert.rejects(service.create({ format: "docx", markdown: `${"> ".repeat(30)}过度嵌套` }), /嵌套过深/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("文档：过期清理忽略同名符号链接，无法删除目录外文件", async (t) => {
  const directory = await temporary(t);
  const outside = await temporary(t);
  await fs.writeFile(path.join(outside, "important.txt"), "不能删除");
  const link = path.join(directory, `doc-${"a".repeat(32)}`);
  await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  const service = new DocumentService({ outputDir: directory, maxRetainedFiles: 1, retentionHours: 1 });
  await service.create({ format: "md", markdown: "正文" });
  assert.equal(await fs.readFile(path.join(outside, "important.txt"), "utf8"), "不能删除");
  assert.ok((await fs.lstat(link)).isSymbolicLink());
});
