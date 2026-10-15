import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, cronMatches, backoffDelay, chunkText, extractUrls } from "../src/util/misc.js";
import { isPrivateAddress, extractReadable } from "../src/tools/reader.js";

test("cron: 基本匹配", () => {
  const c = parseCron("30 23 * * *");
  assert.equal(cronMatches(c, { minute: 30, hour: 23, day: 12, month: 10, weekday: 1 }), true);
  assert.equal(cronMatches(c, { minute: 31, hour: 23, day: 12, month: 10, weekday: 1 }), false);
  assert.equal(cronMatches(c, { minute: 30, hour: 22, day: 12, month: 10, weekday: 1 }), false);
});

test("cron: 步进与列表", () => {
  const c = parseCron("*/15 9-17 * * 1-5");
  assert.equal(cronMatches(c, { minute: 0, hour: 9, day: 5, month: 10, weekday: 1 }), true);
  assert.equal(cronMatches(c, { minute: 14, hour: 9, day: 5, month: 10, weekday: 1 }), false);
  assert.equal(cronMatches(c, { minute: 45, hour: 17, day: 10, month: 10, weekday: 5 }), true);
  assert.equal(cronMatches(c, { minute: 0, hour: 18, day: 10, month: 10, weekday: 5 }), false);
  assert.equal(cronMatches(c, { minute: 0, hour: 10, day: 10, month: 10, weekday: 0 }), false); // 周日
});

test("cron: 日+周都受限时命中其一", () => {
  const c = parseCron("0 12 1 * 1"); // 每月1日 或 每周一
  assert.equal(cronMatches(c, { minute: 0, hour: 12, day: 1, month: 10, weekday: 3 }), true);
  assert.equal(cronMatches(c, { minute: 0, hour: 12, day: 6, month: 10, weekday: 1 }), true);
  assert.equal(cronMatches(c, { minute: 0, hour: 12, day: 6, month: 10, weekday: 3 }), false);
});

test("cron: 非法表达式报错", () => {
  assert.throws(() => parseCron("30 23 * *"));
  assert.throws(() => parseCron("a b * * *"));
});

test("退避：指数增长 + 上限 + 抖动", () => {
  for (let i = 0; i < 50; i++) {
    const d1 = backoffDelay(1, 1000, 60000);
    assert.ok(d1 >= 1000 && d1 <= 1000, "第1次应为1s左右");
    const d5 = backoffDelay(5, 1000, 60000);
    assert.ok(d5 >= 1000 && d5 <= 60000);
  }
  const d20 = backoffDelay(20, 1000, 60000);
  assert.ok(d20 <= 60000, "不应超过上限");
});

test("分段：超长文本按句切分", () => {
  const text = "第一句。".repeat(500);
  const chunks = chunkText(text, 100);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 100, `分段超长: ${c.length}`);
  assert.equal(chunks.join(""), text.replace(/\n/g, ""), "内容不应丢失");
});

test("URL 提取", () => {
  const got = extractUrls("看看这个 https://example.com/a?b=1，还有 http://foo.bar/baz。");
  assert.deepEqual(got, ["https://example.com/a?b=1", "http://foo.bar/baz"]);
  assert.deepEqual(extractUrls("没有链接"), []);
});

test("SSRF：内网地址识别", () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.1.2.3"), true);
  assert.equal(isPrivateAddress("192.168.1.1"), true);
  assert.equal(isPrivateAddress("172.16.0.1"), true);
  assert.equal(isPrivateAddress("172.32.0.1"), false);
  assert.equal(isPrivateAddress("169.254.169.254"), true); // 云元数据
  assert.equal(isPrivateAddress("100.64.0.1"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("fe80::1"), true);
  assert.equal(isPrivateAddress("fd00::1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
});

test("正文提取：剥离脚本与样式", () => {
  const html = `<html><head><title>测试页面</title><style>body{color:red}</style></head>
  <body><script>var x=1;</script><nav>首页 登录</nav>
  <article><p>这是第一段正文内容，比较长一些。</p><p>这是第二段正文内容，也很长。</p></article>
  <footer>版权所有 ICP备123</footer></body></html>`;
  const r = extractReadable(html, 1000);
  assert.equal(r.title, "测试页面");
  assert.ok(r.text.includes("这是第一段正文内容"));
  assert.ok(!r.text.includes("var x=1"));
  assert.ok(!r.text.includes("color:red"));
  assert.ok(!r.text.includes("ICP备123"));
});
