import assert from "node:assert/strict";
import test from "node:test";
import { focusTrapTarget } from "./focus-trap";

test("focus trap wraps from a programmatically focused title or outside element", () => {
  assert.equal(focusTrapTarget(3, -1, false), "first");
  assert.equal(focusTrapTarget(3, -1, true), "last");
});

test("focus trap keeps both edges inside and uses native movement in the middle", () => {
  assert.equal(focusTrapTarget(3, 0, true), "last");
  assert.equal(focusTrapTarget(3, 2, false), "first");
  assert.equal(focusTrapTarget(3, 1, false), "native");
  assert.equal(focusTrapTarget(3, 1, true), "native");
});

test("focus trap falls back to its container when saving disables every control", () => {
  assert.equal(focusTrapTarget(0, -1, false), "container");
  assert.equal(focusTrapTarget(0, -1, true), "container");
});
