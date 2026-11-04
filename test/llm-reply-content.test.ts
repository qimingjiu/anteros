import { test } from "node:test";
import assert from "node:assert/strict";
import { stripLeadingThinkBlocks } from "../src/llm/reply-content.js";

test("MiniMax 正文：去掉前置思考块，只留下最终回答", () => {
  assert.equal(stripLeadingThinkBlocks("<think>synthetic private thought</think>Visible answer"), "Visible answer");
});

test("MiniMax 正文：处理多行、大小写和标签内简单空白", () => {
  assert.equal(stripLeadingThinkBlocks("\uFEFF\n < ThInK >\nsynthetic\nreasoning\n< / tHiNk >\r\n\t正文\n"), "正文\n");
});

test("MiniMax 正文：移除连续思考块与块之间的空白", () => {
  assert.equal(stripLeadingThinkBlocks("  <think>first</think>\n\t<think>second</think>   answer \n"), "answer \n");
});

test("MiniMax 正文：嵌套标签必须全部闭合才开始正文", () => {
  assert.equal(stripLeadingThinkBlocks("<think>outer<think>inner</think>still outer</think> answer"), "answer");
  assert.equal(stripLeadingThinkBlocks("<think><think>inner</think></think><think>next</think>answer"), "answer");
});

test("MiniMax 正文：未闭合的前置块不泄露截断的思考", () => {
  assert.equal(stripLeadingThinkBlocks("<think>unfinished synthetic reasoning"), "");
  assert.equal(stripLeadingThinkBlocks(" \n<think>outer<think>inner</think>unfinished outer"), "");
  assert.equal(stripLeadingThinkBlocks("<think>complete</think> <think>unfinished second"), "");
});

test("MiniMax 正文：只有思考块和空白时结果为空", () => {
  assert.equal(stripLeadingThinkBlocks("<think></think>\n \t"), "");
  assert.equal(stripLeadingThinkBlocks("<think><think></think></think>"), "");
});

test("MiniMax 正文：没有前置思考协议时逐字保留", () => {
  for (const content of ["", " \n\t", "  普通正文\n", "First, consider the problem.\nAnswer: 42.", "思考一下再回答。\n这是正常正文。"])
    assert.equal(stripLeadingThinkBlocks(content), content);
});

test("MiniMax 正文：正文中的标签示例和后置标签不会被清除", () => {
  for (const content of ["Use <think>example</think> as a tag.", "正文\n<think>literal example</think>", "</think>ordinary unmatched closing tag"])
    assert.equal(stripLeadingThinkBlocks(content), content);
  assert.equal(stripLeadingThinkBlocks("<think>private prefix</think>Answer <think>literal example</think>"),
    "Answer <think>literal example</think>");
});

test("MiniMax 正文：代码围栏、行内代码和引用中的标签保持原样", () => {
  for (const content of [
    "```xml\n<think>example</think>\n```",
    "  `<think>example</think>`\n",
    "\"<think>example</think>\"",
    "'<think>example</think>'",
    "> <think>quoted example</think>",
    "<!-- <think>HTML comment</think> -->",
    "&lt;think&gt;escaped example&lt;/think&gt;",
  ]) assert.equal(stripLeadingThinkBlocks(content), content);
});

test("MiniMax 正文：其他 HTML 与相似但不同的标签保持原样", () => {
  for (const content of [
    "<div><think>nested markup example</think></div>",
    " <thinking>ordinary tag</thinking>",
    "<thinker>ordinary tag</thinker>",
    "<think data-example='true'>ordinary HTML</think>",
    "<think/>self-closing markup",
    "<th ink>malformed tag</th ink>",
    "<think", "< think / >",
  ]) assert.equal(stripLeadingThinkBlocks(content), content);
});

test("MiniMax 正文：清理协议后保留最终回答的代码与尾部空白", () => {
  const answer = "```xml\n<think>literal code sample</think>\n```\n  ";
  assert.equal(stripLeadingThinkBlocks("<think>synthetic prefix</think>\n  " + answer), answer);
});

test("MiniMax 正文：大量连续块和深层嵌套不递归或重复扫描已处理文本", () => {
  const count = 20_000;
  assert.equal(stripLeadingThinkBlocks("<think>x</think> \n".repeat(count) + "visible"), "visible");
  assert.equal(stripLeadingThinkBlocks("<think>".repeat(count) + "x" + "</think>".repeat(count) + "visible"), "visible");
  const unchanged = "<" + " ".repeat(200_000) + "ordinary answer";
  assert.equal(stripLeadingThinkBlocks(unchanged), unchanged);
});
