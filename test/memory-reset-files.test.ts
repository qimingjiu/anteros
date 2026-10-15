import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/db/index.js";
import { prepareMemoryReset, executeMemoryReset } from "../scripts/reset-memory.mjs";

const OLD_TEXT = "RESET_FILES_OLD_MEMORY_5c05bedec7d04778";
const DOCUMENT = `doc-${"a".repeat(32)}`;

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qq-reset-files-"));
  t.after(async () => { await fs.rm(root, {recursive: true, force: true}); });
  const databasePath = path.join(root, "data", "bot.db");
  const db = new Database(databasePath);
  db.kvSet("forgotten_chat", OLD_TEXT);
  db.kvSet("active_model_profile", "fixture-model");
  db.close();
  for (const name of ["logs", "reports", "memory-reset-backups", "documents", "diagnostics", "fonts", "login"]) {
    await fs.mkdir(path.join(root, "data", name), {recursive: true});
  }
  for (const name of ["logs", "reports", "memory-reset-backups"]) await fs.writeFile(path.join(root, "data", name, "old.txt"), OLD_TEXT);
  await fs.mkdir(path.join(root, "data", "documents", DOCUMENT));
  await fs.writeFile(path.join(root, "data", "documents", DOCUMENT, "old.md"), OLD_TEXT);
  await fs.writeFile(path.join(root, "data", "diagnostics", "events.jsonl"), '{"code":"document_failed"}\n');
  await fs.writeFile(path.join(root, "data", "fonts", "fixture.font"), "FONT_FIXTURE");
  await fs.writeFile(path.join(root, "data", "login", "fixture.state"), "LOGIN_FIXTURE");
  await fs.writeFile(path.join(root, "config.yaml"), "CONFIG_FIXTURE");
  const cfg = {database: {path: "data/bot.db"}, logging: {dir: "data/logs"}, reports: {outputDir: "data/reports"}, documents: {outputDir: "data/documents"}};
  return {root, databasePath, cfg};
}

test("记忆清理文件：只读预检不改变DB；清掉旧日志、报告、备份与文档，保留安全诊断和运行资料", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "data", "documents", "fonts"));
  await fs.writeFile(path.join(f.root, "data", "documents", "fonts", "fixture.font"), "DOCUMENT_FONT_FIXTURE");
  await fs.symlink(path.join(f.root, "data", "fonts"), path.join(f.root, "data", "documents", DOCUMENT, "font-link"), process.platform === "win32" ? "junction" : "dir");
  const before = await fs.readFile(f.databasePath);
  const plan = await prepareMemoryReset(f.root, f.cfg);
  assert.deepEqual(plan.summary.directories, {logs: 1, reports: 1, memoryBackups: 1, documentArtifacts: 1, legacyArchives: 0});
  assert.equal(plan.summary.conversationKeys, 1);
  assert.equal(plan.summary.memoryBackupCreated, false);
  assert.ok(!JSON.stringify(plan.summary).includes(OLD_TEXT), "预检只报告数量，不打印旧正文或文件名");
  assert.deepEqual(await fs.readFile(f.databasePath), before);
  await fs.access(path.join(f.root, "data", "logs", "old.txt"));
  const result = await executeMemoryReset(plan);
  assert.equal(result.memoryBackupCreated, false);
  assert.equal(result.conversationKeysRemaining, 0);
  assert.deepEqual(result.removed, {logs: 1, reports: 1, memoryBackups: 1, documentArtifacts: 1});
  for (const name of ["logs", "reports", "memory-reset-backups", path.join("documents", DOCUMENT)]) {
    await assert.rejects(fs.access(path.join(f.root, "data", name)), {code: "ENOENT"});
  }
  for (const [name, contents] of [["diagnostics/events.jsonl", '{"code":"document_failed"}\n'], ["fonts/fixture.font", "FONT_FIXTURE"], ["login/fixture.state", "LOGIN_FIXTURE"]]) {
    assert.equal(await fs.readFile(path.join(f.root, "data", name!), "utf8"), contents);
  }
  assert.equal(await fs.readFile(path.join(f.root, "config.yaml"), "utf8"), "CONFIG_FIXTURE");
  assert.equal(await fs.readFile(path.join(f.root, "data", "documents", "fonts", "fixture.font"), "utf8"), "DOCUMENT_FONT_FIXTURE");
  const db = new Database(f.databasePath);
  try { assert.equal(db.kvGet("active_model_profile"), "fixture-model"); assert.equal(db.kvGet("forgotten_chat"), undefined); }
  finally { db.close(); }
  assert.ok(!(await fs.readFile(f.databasePath)).includes(Buffer.from(OLD_TEXT)));
});

test("记忆清理文件：危险或异常路径在任何删除前被拒绝，数据库及已有文件完整保留", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.databasePath);
  for (const loggingDirectory of ["data", "src", "data/diagnostics", "data/fonts", "data/login"]) {
    await assert.rejects(prepareMemoryReset(f.root, {...f.cfg, logging: {dir: loggingDirectory}}));
  }
  await assert.rejects(prepareMemoryReset(f.root, {...f.cfg, documents: {outputDir: path.join(os.tmpdir(), "unrelated-documents")}}));
  await fs.rm(path.join(f.root, "data", "reports"), {recursive: true});
  await fs.writeFile(path.join(f.root, "data", "reports"), "unexpected regular file");
  await assert.rejects(prepareMemoryReset(f.root, f.cfg), /unexpected reset target type/);
  assert.deepEqual(await fs.readFile(f.databasePath), before);
  assert.equal(await fs.readFile(path.join(f.root, "data", "logs", "old.txt"), "utf8"), OLD_TEXT);
  assert.equal(await fs.readFile(path.join(f.root, "data", "documents", DOCUMENT, "old.md"), "utf8"), OLD_TEXT);
});

test("记忆清理文件：拒绝被替换为符号链接的文档目录，执行前复验也不误删或清DB", async (t) => {
  const f = await fixture(t);
  const plan = await prepareMemoryReset(f.root, f.cfg);
  const before = await fs.readFile(f.databasePath);
  const target = path.join(f.root, "data", "documents", DOCUMENT);
  await fs.rm(target, {recursive: true});
  await fs.symlink(path.join(f.root, "data", "fonts"), target, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareMemoryReset(f.root, f.cfg), /symlink/);
  await assert.rejects(executeMemoryReset(plan), /symlink/);
  assert.deepEqual(await fs.readFile(f.databasePath), before);
  assert.equal(await fs.readFile(path.join(f.root, "data", "fonts", "fixture.font"), "utf8"), "FONT_FIXTURE");
});
