import assert from "node:assert/strict";
import test from "node:test";

import { safeRequestId } from "./request-id";

const fallback = "discover-3b5f801d-078d-4244-a6e0-3c4d35f8451d";

test("request IDs preserve bounded header-safe client correlation values", () => {
  assert.equal(safeRequestId("  client.run-42:retry_1  ", fallback), "client.run-42:retry_1");
  assert.equal(safeRequestId("a".repeat(200), fallback), "a".repeat(200));
});

test("request IDs replace control characters, unicode, and oversized values", () => {
  for (const value of [
    "client\r\nX-Injected: true",
    "client\0id",
    "client\u202Eid",
    "résumé-search",
    "a".repeat(201),
    "   ",
    null,
    42,
  ]) {
    assert.equal(safeRequestId(value, fallback), fallback);
  }
});

test("request IDs require a server fallback that is safe to emit", () => {
  assert.throws(
    () => safeRequestId("valid", "unsafe\r\nfallback"),
    /fallback must be a safe header value/,
  );
});

