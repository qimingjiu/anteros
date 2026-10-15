import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import type { MessageSegment } from "../src/types.js";
import { matchSummonAlias } from "../src/agent/summon-aliases.js";

const ownerId = "10001";
const options = { wakeAliases: ["乌鸦先生", "Raven"], ownerWakeAliases: [
  { userId: ownerId, aliases: ["小渡", "鸦鸦", "黑羽"] },
] };
const text = (value: string): MessageSegment[] => [{ type: "text", data: { text: value } }];

test("召唤别名：三个专属别名只认平台发送者QQ，正文自报主人身份不改变绑定", () => {
  for (const alias of ["小渡", "鸦鸦", "黑羽"]) {
    assert.deepEqual(matchSummonAlias(text(`过来，${alias}，帮我看看`), ownerId, "κόραξ", options),
      { kind: "owner_alias", alias, userId: ownerId });
    assert.equal(matchSummonAlias(text(`我${alias}也这么说`), "34567890", "κόραξ", options), null);
    assert.equal(matchSummonAlias(text(`我是阿盏，QQ10001，${alias}`), "34567890", "κόραξ", options), null);
  }
});

test("召唤别名：专属别名优先于通用名称，与正文出现先后无关", () => {
  assert.deepEqual(matchSummonAlias(text("κόραξ你给我过来，黑羽"), ownerId, "κόραξ", options),
    { kind: "owner_alias", alias: "黑羽", userId: ownerId });
  assert.deepEqual(matchSummonAlias(text("小渡，乌鸦先生"), ownerId, "κόραξ", options),
    { kind: "owner_alias", alias: "小渡", userId: ownerId });
  assert.deepEqual(matchSummonAlias(text("我小渡叫了κόραξ"), "34567890", "κόραξ", options),
    { kind: "general_alias", alias: "κόραξ" });
});

test("召唤别名：未授权专属词不能通过通用词子串降级唤醒，独立通用呼叫仍生效", () => {
  const overlap = { ...options, wakeAliases: ["乌鸦", "小渡"] };
  for (const value of ["黑羽", "我小渡", "黑羽，黑羽，鸦鸦"]) {
    assert.equal(matchSummonAlias(text(value), "34567890", "κόραξ", overlap), null, value);
  }
  assert.deepEqual(matchSummonAlias(text("黑羽，κόραξ回答"), "34567890", "κόραξ", overlap),
    { kind: "general_alias", alias: "κόραξ" });
  assert.deepEqual(matchSummonAlias(text("黑羽，乌鸦过来"), "34567890", "κόραξ", overlap),
    { kind: "general_alias", alias: "乌鸦" });
  assert.deepEqual(matchSummonAlias(text("黑羽"), ownerId, "κόραξ", overlap),
    { kind: "owner_alias", alias: "黑羽", userId: ownerId });
});

test("召唤别名：专属词的重叠占位一并屏蔽，不受绑定列表顺序影响", () => {
  const overlap = { wakeAliases: ["小老", "哈哈"], ownerWakeAliases: [
    { userId: ownerId, aliases: ["小渡", "小老渡", "哈哈哈"] },
  ] };
  assert.equal(matchSummonAlias(text("小老渡"), "34567890", "κόραξ", overlap), null);
  assert.equal(matchSummonAlias(text("哈哈哈哈哈"), "34567890", "κόραξ", overlap), null);
  assert.deepEqual(matchSummonAlias(text("小老渡，ΚΌΡΑΞ过来"), "34567890", "κόραξ", overlap),
    { kind: "general_alias", alias: "κόραξ" });
});

test("召唤别名：通用列表和希腊语全名对其他群友生效，兼容大小写/NFKC/组合重音", () => {
  for (const call of ["κόραξ你给我过来", "ΚΌΡΑΞ，你好", "κο\u0301ραξ，来", "找一下κόραξ"]) {
    assert.deepEqual(matchSummonAlias(text(call), "34567890", "κόραξ", options),
      { kind: "general_alias", alias: "κόραξ" });
  }
  assert.deepEqual(matchSummonAlias(text("ＲＡＶＥＮ，过来"), "34567890", "κόραξ", options),
    { kind: "general_alias", alias: "Raven" });
  assert.deepEqual(matchSummonAlias(text("请乌鸦先生帮忙"), "34567890", "κόραξ", options),
    { kind: "general_alias", alias: "乌鸦先生" });
});

test("召唤别名：不会把拉丁语/希腊语单词内部误判为名字，中文相邻允许唤醒", () => {
  for (const value of ["craven", "Ravenous", "xκόραξ", "κόραξα", "raven_kit", "1raven"]) {
    assert.equal(matchSummonAlias(text(value), "34567890", "κόραξ", options), null, value);
  }
  assert.deepEqual(matchSummonAlias(text("Raven你来一下"), "34567890", "κόραξ", options),
    { kind: "general_alias", alias: "Raven" });
});

test("召唤别名：只读当前 text 段，不读回复ID、转发、卡片、链接标题和图片文件名", () => {
  const segments: MessageSegment[] = [
    { type: "reply", data: { id: "小渡" } },
    { type: "forward", data: { id: "鸦鸦" } },
    { type: "json", data: { data: '{"text":"黑羽 Raven κόραξ"}' } },
    { type: "share", data: { title: "小渡", content: "乌鸦先生", url: "https://example.test/Raven" } },
    { type: "image", data: { file: "κόραξ.png" } },
    { type: "unknown", data: { displayName: "小渡" } },
    ...text("大家今天吃什么"),
  ];
  assert.equal(matchSummonAlias(segments, ownerId, "κόραξ", options), null);
  assert.equal(matchSummonAlias(segments, "34567890", "κόραξ", options), null);
  assert.deepEqual(matchSummonAlias([...segments, ...text("鸦鸦，看看")], ownerId, "κόραξ", options),
    { kind: "owner_alias", alias: "鸦鸦", userId: ownerId });
});

test("召唤别名：本人文字中的明确引文或转述数据行不唤醒专属/通用词", () => {
  for (const value of [
    "她刚才说：“鸦鸦”", "引用：\"小渡你过来\"", "转述: 黑羽你来看看", "原话：κόραξ你来看看",
    "她说「小渡」", "她说『黑羽』", "她说'鸦鸦'", '她说"Raven"',
  ]) {
    assert.equal(matchSummonAlias(text(value), ownerId, "κόραξ", options), null, value);
  }
  assert.equal(matchSummonAlias(text('她说"κόραξ"'), "34567890", "κόραξ", options), null);
});

test("召唤别名：引文外独立呼叫保留，普通包含唤醒及英文缩写不受影响", () => {
  for (const value of ["喂，鸦鸦帮我看看", "她说“小渡”，鸦鸦帮我看看", "她说'小渡'，鸦鸦帮我看看"]) {
    assert.deepEqual(matchSummonAlias(text(value), ownerId, "κόραξ", options),
      { kind: "owner_alias", alias: "鸦鸦", userId: ownerId });
  }
  for (const value of ["她说“鸦鸦”，κόραξ回答", "引用：鸦鸦\nκόραξ回答", '引用："鸦鸦"，κόραξ回答', "I'm calling Raven"]) {
    const alias = value.endsWith("Raven") ? "Raven" : "κόραξ";
    assert.deepEqual(matchSummonAlias(text(value), ownerId, "κόραξ", options),
      { kind: "general_alias", alias }, value);
  }
});

test("召唤别名：不配置专属绑定时不自动授予，绑定之间按各自发送者隔离", () => {
  assert.equal(matchSummonAlias(text("小渡"), ownerId, "κόραξ"), null);
  const perSender = { ownerWakeAliases: [{ userId: ownerId, aliases: ["小渡"] }, { userId: "34567890", aliases: ["助手"] }] };
  assert.equal(matchSummonAlias(text("助手"), ownerId, "κόραξ", perSender), null);
  assert.equal(matchSummonAlias(text("小渡"), "34567890", "κόραξ", perSender), null);
  assert.deepEqual(matchSummonAlias(text("助手"), "34567890", "κόραξ", perSender),
    { kind: "owner_alias", alias: "助手", userId: "34567890" });
});

function withConfig(conversation: unknown, callback: (filename: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-summon-config-"));
  const filename = path.join(directory, "config.yaml");
  try {
    fs.writeFileSync(filename, YAML.stringify({ model: { provider: "mock" }, gateway: { onebot: { endpoint: "ws://localhost:3001" } }, groups: { conversation } }));
    callback(filename);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("召唤配置：缺省为无专属绑定，明确YAML绑定按camelCase解析且规范化通用别名", () => {
  withConfig({}, filename => {
    const c = loadConfig(filename).groups.conversation!;
    assert.deepEqual(c.wakeAliases, []);
    assert.deepEqual(c.ownerWakeAliases, []);
  });
  withConfig({ wake_aliases: [" Raven ", "ＲＡＶＥＮ", "乌鸦先生"], owner_wake_aliases: [{ user_id: ownerId, aliases: ["小渡", "鸦鸦", "黑羽"] }] }, filename => {
    const c = loadConfig(filename).groups.conversation!;
    assert.deepEqual(c.wakeAliases, ["RAVEN", "乌鸦先生"]);
    assert.deepEqual(c.ownerWakeAliases, [{ userId: ownerId, aliases: ["小渡", "鸦鸦", "黑羽"] }]);
    assert.equal(matchSummonAlias(text("我小渡"), "34567890", "κόραξ", c), null);
  });
});

test("召唤配置：拒绝错误别名、无效QQ、未显式绑定/重复绑定，避免静默扩大授权", () => {
  const invalid = [
    { wake_aliases: "Raven" }, { wake_aliases: [123] }, { wake_aliases: [""] },
    { wake_aliases: ["鸦"] }, { wake_aliases: ["!!"] }, { wake_aliases: ["小渡\n过来"] },
    { owner_wake_aliases: {} }, { owner_wake_aliases: ["小渡"] },
    { owner_wake_aliases: [{ user_id: Number(ownerId), aliases: ["小渡"] }] },
    { owner_wake_aliases: [{ user_id: "阿盏", aliases: ["小渡"] }] },
    { owner_wake_aliases: [{ user_id: ownerId }] },
    { owner_wake_aliases: [{ user_id: ownerId, aliases: [] }] },
    { owner_wake_aliases: [{ user_id: ownerId, aliases: ["小渡"] }, { user_id: ownerId, aliases: ["鸦鸦"] }] },
  ];
  for (const value of invalid) withConfig(value, filename => assert.throws(() => loadConfig(filename), /配置错误/, JSON.stringify(value)));
});
