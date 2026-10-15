import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../src/db/index.js";
import { ModelSelection } from "../src/llm/selection.js";
import { ModelSwitcher } from "../src/llm/switcher.js";
import type { AppConfig, ModelProfile } from "../src/config.js";

const profiles: ModelProfile[] = [
  { name: "sora-shared", serviceName: "Sora", provider: "mock", baseUrl: "", apiKey: "", model: "shared-model" },
  { name: "sora-slash", serviceName: "Sora", provider: "mock", baseUrl: "", apiKey: "", model: "times/gemini-3.8-flash" },
  { name: "tale-shared", serviceName: "tale", provider: "mock", baseUrl: "", apiKey: "", model: "shared-model" },
  { name: "tale-cli", serviceName: "tale", provider: "mock", baseUrl: "", apiKey: "", model: "gemini-3.8-flash-cli", displayName: "CLI" },
  { name: "ctyun-one", serviceName: "天翼云", provider: "mock", baseUrl: "", apiKey: "", model: "ctyun-model" },
];

function fixture(t: { after(fn: () => void): void }, supplied = profiles) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cfg: AppConfig["model"] = {
    provider: "mock", baseUrl: "", apiKey: "", model: "default-model",
    fallbackModel: "", summaryModel: "", temperature: 0.7,
    maxContextChars: 6000, maxOutputChars: 2000, requestTimeoutMs: 5000,
    profiles: supplied,
  };
  const switcher = new ModelSwitcher(supplied, cfg, db);
  let time = 1_000_000;
  const menu = new ModelSelection(switcher, () => time);
  return { db, cfg, switcher, menu, advance: (ms: number) => { time += ms; } };
}

test("模型菜单：先列服务商，选服务商后才列具体模型，最终选择才持久化", t => {
  const { db, switcher, menu } = fixture(t);
  const first = menu.handle("owner", "列出可用的模型");
  assert.match(first!, /先选择模型商/);
  assert.match(first!, /Sora/);
  assert.match(first!, /tale/);
  assert.match(first!, /天翼云/);
  assert.doesNotMatch(first!, /shared-model|times\/gemini/);
  assert.equal(db.kvGet("active_model_profile"), undefined);
  const second = menu.handle("owner", "1");
  assert.match(second!, /Sora 的可选模型/);
  assert.match(second!, /times\/gemini-3\.8-flash/);
  assert.equal(switcher.activeName(), "默认（default-model）");
  menu.handle("owner", "2");
  assert.equal(switcher.activeName(), "sora-slash");
  assert.equal(db.kvGet("active_model_profile"), "sora-slash");
  assert.equal(menu.handle("owner", "1"), null, "成功后结束选择会话");
});

test("模型菜单：选择中仍允许其他斜线指令，且保留当前选择阶段", t => {
  const { switcher, menu } = fixture(t);
  menu.start("owner");
  assert.equal(menu.handle("owner", "/帮助"), null);
  menu.handle("owner", "Sora");
  assert.equal(menu.handle("owner", "/状态"), null);
  menu.handle("owner", "2");
  assert.equal(switcher.activeName(), "sora-slash");
});

test("模型菜单：服务商名称大小写与选择前缀，完整带斜杠模型 ID", t => {
  const { switcher, menu } = fixture(t);
  menu.handle("owner", "我想换个模型！");
  assert.match(menu.handle("owner", "选择 sOrA")!, /Sora 的可选模型/);
  menu.handle("owner", "换成 times/gemini-3.8-flash");
  assert.equal(switcher.activeName(), "sora-slash");
});

test("模型菜单：同名模型按已选服务商隔离，不能跨商选择", t => {
  const { switcher, menu } = fixture(t);
  menu.start("owner");
  menu.handle("owner", "tale");
  assert.match(menu.handle("owner", "times/gemini-3.8-flash")!, /tale 的列表/);
  assert.equal(switcher.activeName(), "默认（default-model）");
  menu.handle("owner", "shared-model");
  assert.equal(switcher.activeName(), "tale-shared");
});

test("模型菜单：支持档位名称和展示别名", t => {
  const { switcher, menu } = fixture(t);
  menu.start("owner");
  menu.handle("owner", "tale");
  menu.handle("owner", "CLI");
  assert.equal(switcher.activeName(), "tale-cli");
  menu.start("owner");
  menu.handle("owner", "Sora");
  menu.handle("owner", "sora-shared");
  assert.equal(switcher.activeName(), "sora-shared");
});

test("模型菜单：取消和返回不会切换；返回后模型编号重新代表服务商", t => {
  const { switcher, menu } = fixture(t);
  menu.start("owner");
  menu.handle("owner", "tale");
  assert.match(menu.handle("owner", "返回")!, /先选择模型商/);
  assert.match(menu.handle("owner", "1")!, /Sora 的可选模型/);
  assert.match(menu.handle("owner", "取消")!, /已取消/);
  assert.equal(switcher.activeName(), "默认（default-model）");
  assert.equal(menu.handle("owner", "2"), null);
});

test("模型菜单：无效编号、无效显式名称保留菜单，不会切换", t => {
  const { switcher, menu } = fixture(t);
  menu.start("owner");
  assert.match(menu.handle("owner", "0")!, /没有这个模型商/);
  assert.match(menu.handle("owner", "选择 不存在")!, /没有这个模型商/);
  menu.handle("owner", "天翼云");
  assert.match(menu.handle("owner", "99")!, /天翼云 的列表/);
  assert.equal(switcher.activeName(), "默认（default-model）");
  menu.handle("owner", "1");
  assert.equal(switcher.activeName(), "ctyun-one");
});

test("模型菜单：会话按账号和会话所有者隔离", t => {
  const { switcher, menu } = fixture(t);
  menu.start("acct-a:private-owner:owner");
  menu.handle("acct-a:private-owner:owner", "Sora");
  assert.equal(menu.handle("acct-b:private-owner:owner", "2"), null);
  menu.start("acct-a:private-other:other");
  menu.handle("acct-a:private-other:other", "tale");
  menu.handle("acct-a:private-other:other", "1");
  assert.equal(switcher.activeName(), "tale-shared");
  menu.handle("acct-a:private-owner:owner", "2");
  assert.equal(switcher.activeName(), "sora-slash");
});

test("模型菜单：十分钟过期，重列列表延长会话", t => {
  const { switcher, menu, advance } = fixture(t);
  menu.start("owner");
  menu.handle("owner", "Sora");
  advance(9 * 60_000);
  assert.match(menu.handle("owner", "重列")!, /Sora 的可选模型/);
  advance(9 * 60_000);
  menu.handle("owner", "2");
  assert.equal(switcher.activeName(), "sora-slash");
  menu.start("owner");
  menu.handle("owner", "tale");
  advance(10 * 60_000 + 1);
  assert.equal(menu.handle("owner", "1"), null);
  assert.equal(switcher.activeName(), "sora-slash");
});

test("模型菜单：旧的直接换模型请求必须先选服务商；模型阶段可改选服务商", t => {
  const { switcher, menu } = fixture(t);
  assert.match(menu.handle("owner", "换成 sora-slash")!, /先选择模型商/);
  assert.equal(switcher.activeName(), "默认（default-model）");
  menu.handle("owner", "Sora");
  assert.match(menu.handle("owner", "tale")!, /tale 的可选模型/);
  menu.handle("owner", "1");
  assert.equal(switcher.activeName(), "tale-shared");
});

test("模型菜单：选择持久化，重建选择器后保持且展示当前服务商", t => {
  const { db, cfg, menu } = fixture(t);
  menu.start("owner");
  menu.handle("owner", "tale");
  menu.handle("owner", "shared-model");
  const restarted = new ModelSwitcher(profiles, cfg, db);
  assert.equal(restarted.activeName(), "tale-shared");
  assert.match(restarted.listProviders(), /tale[^\n]*当前/);
  assert.match(restarted.list("tale"), /shared-model[^\n]*当前/);
});

test("模型菜单：服务商内名称匹配不唯一时必须用编号确认", t => {
  const duplicated: ModelProfile[] = [
    { ...profiles[0]!, name: "a", model: "prefix-a/shared-model", displayName: "shared-model" },
    { ...profiles[0]!, name: "b", model: "prefix-b/shared-model", displayName: "shared-model" },
  ];
  const { switcher, menu } = fixture(t, duplicated);
  menu.start("owner");
  menu.handle("owner", "Sora");
  assert.match(menu.handle("owner", "shared-model")!, /回复编号或完整名称/);
  assert.equal(switcher.activeName(), "默认（default-model）");
  menu.handle("owner", "2");
  assert.equal(switcher.activeName(), "b");
});

test("模型菜单：缺少密钥的模型不能切换，失败后仍能重新选择", t => {
  const { db, switcher, menu } = fixture(t, [
    { ...profiles[0]!, name: "no-key", provider: "openai_compatible", apiKey: "", baseUrl: "https://invalid.example/v1" },
    profiles[1]!,
  ]);
  menu.start("owner");
  menu.handle("owner", "Sora");
  assert.match(menu.handle("owner", "1")!, /API key 未配置/);
  assert.equal(switcher.activeName(), "默认（default-model）");
  assert.equal(db.kvGet("active_model_profile"), undefined);
  menu.handle("owner", "2");
  assert.equal(switcher.activeName(), "sora-slash");
});
