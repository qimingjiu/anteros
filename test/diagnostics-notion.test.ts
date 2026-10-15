import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeDiagnostics } from "../src/diagnostics/index.js";
import { classifyDiagnosticFailure, diagnosticComponent } from "../src/diagnostics/schema.js";
import { NotionError } from "../src/tools/notion.js";

test("Notion diagnostics classify fixed failures without retaining private upstream text", () => {
  const secret = "ntn_private_fixture_not_a_real_token";
  const cases = [["write_unknown", "delivery_unknown"], ["forbidden", "permission"], ["rate_limited", "rate_limit"], ["not_configured", "configuration"]] as const;
  for (const [reason, expected] of cases) {
    const error = new NotionError(reason);
    error.message = secret + " a private note and URL";
    const result = classifyDiagnosticFailure(error);
    assert.equal(result.reason, expected);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  assert.equal(diagnosticComponent("notion-reminders"), "notion");
});

test("group diagnostics do not reveal notebook aggregates from other conversations", () => {
  const diagnostics = new RuntimeDiagnostics({ subscribeLogs:false, currentStatus:()=>[
    {component:"notion",name:"notebook",enabled:true,configured:true,count:42},
    {component:"search",enabled:true,configured:true},
  ] });
  try {
    const request = {accountId:"fixture",conversationId:"group_12345678",scope:"conversation" as const};
    assert.equal(diagnostics.snapshot(request).current.some(item=>item.component==="notion"),false);
    assert.equal(diagnostics.snapshot({...request,scope:"global"}).current.find(item=>item.component==="notion")?.count,42);
  } finally { diagnostics.close(); }
});
