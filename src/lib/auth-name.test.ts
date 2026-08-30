import assert from "node:assert/strict";
import test from "node:test";
import { normalizePaperPilotUserName } from "./auth-name";

test("signup display-name policy is deterministic before account lookup", () => {
  assert.equal(normalizePaperPilotUserName("  Ada Lovelace  "), "Ada Lovelace");
  assert.equal(normalizePaperPilotUserName("A"), null);
  assert.equal(normalizePaperPilotUserName(" ".repeat(4)), null);
  assert.equal(normalizePaperPilotUserName("x".repeat(120)), "x".repeat(120));
  assert.equal(normalizePaperPilotUserName("x".repeat(121)), null);
  assert.equal(normalizePaperPilotUserName("Ada\u202ELovelace"), null);
  assert.equal(normalizePaperPilotUserName("Ada\u0000Lovelace"), null);
  assert.equal(normalizePaperPilotUserName("Ada\u2069Lovelace"), null);
  assert.equal(normalizePaperPilotUserName(undefined), null);
});
