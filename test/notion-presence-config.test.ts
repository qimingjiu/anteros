import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";

function configuration(t: TestContext, mutate: (raw: Record<string, any>) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notion-presence-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const raw = YAML.parse(fs.readFileSync(fileURLToPath(new URL("../config.sim.yaml", import.meta.url)), "utf8"));
  mutate(raw);
  const filename = path.join(directory, "config.yaml");
  fs.writeFileSync(filename, YAML.stringify(raw));
  return () => loadConfig(filename);
}

test("Notion defaults remain disabled and phone group access requires explicit scope", t => {
  const cfg = configuration(t, () => {})();
  assert.equal(cfg.notion?.enabled, false);
  assert.deepEqual(cfg.presence?.allowedGroupIds, []);
  assert.equal(cfg.proactive?.includeDraw, false);
});

test("phone scope cannot add groups outside the existing bot allowlist", t => {
  assert.throws(configuration(t, raw => {
    raw.groups.allowlist = ["12345678"];
    raw.presence = { enabled: false, allowed_group_ids: ["87654321"] };
  }), /groups.allowlist/);
  const cfg = configuration(t, raw => {
    raw.groups.allowlist = ["12345678"];
    raw.presence = { enabled: false, allowed_group_ids: ["12345678", "12345678"] };
  })();
  assert.deepEqual(cfg.presence?.allowedGroupIds, ["12345678"]);
});

test("invalid phone scope is rejected rather than silently enabling all groups", t => {
  for (const value of ["all", [12345678], ["*"], [""], {}]) {
    assert.throws(configuration(t, raw => { raw.presence = { allowed_group_ids: value }; }), /allowed_group_ids/);
  }
});

test("Notion requires a dedicated parent and never echoes a credential in configuration errors", t => {
  const credential = "secret_not_a_real_private_test_key";
  const invalid = configuration(t, raw => {
    raw.notion = { enabled: true, api_key: credential, root_page_id: "https://example.com/" };
  });
  assert.throws(invalid, error => error instanceof Error && /root_page_id/.test(error.message) && !error.message.includes(credential));
  assert.throws(configuration(t, raw => {
    raw.notion = { enabled: true, api_key_env: "QQ_TEST_MISSING_NOTION_KEY", root_page_id: "11111111-2222-3333-4444-555555555555" };
  }), /api_key_env/);
});

test("Notion accepts private environment credentials and a bounded request timeout", t => {
  const name = "QQ_TEST_NOTION_KEY";
  const previous = process.env[name];
  process.env[name] = "secret_private_fixture_key";
  t.after(() => previous === undefined ? delete process.env[name] : process.env[name] = previous);
  const cfg = configuration(t, raw => {
    raw.notion = { enabled: true, api_key_env: name, root_page_id: "11111111-2222-3333-4444-555555555555", reminders_enabled: true, request_timeout_ms: 1500 };
  })();
  assert.equal(cfg.notion?.apiKey, process.env[name]);
  assert.equal(cfg.notion?.requestTimeoutMs, 1500);
  assert.equal(cfg.notion?.remindersEnabled, true);
  for (const value of [-1, 1.5, 30001, "10000"]) {
    assert.throws(configuration(t, raw => { raw.notion = { request_timeout_ms: value }; }), /request_timeout_ms/);
  }
});
