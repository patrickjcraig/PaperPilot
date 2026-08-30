import assert from "node:assert/strict";
import test from "node:test";

import {
  clearCrawlerRecovery,
  crawlerDefinitiveProblemCode,
  crawlerRecoveryStorageKey,
  parseCrawlerRecovery,
  persistCrawlerRecovery,
  restoreCrawlerRecovery,
  serializeCrawlerRecovery,
  type FrozenCrawlerRecoverySubmission,
  type StorageLike,
} from "./crawler-recovery";

const WORKSPACE_ID = "workspace-crawler-recovery";
const SOURCE_URL = "https://repository.example.org/papers/exact.pdf";
const POLICY = Object.freeze({
  acquisitionMode: "EXPLICIT_SINGLE_QUERY_FREE_HTTPS_PDF_V1" as const,
  policyVersion: "crawler-policy-v1",
  rightsAttestation: "INDEFINITE_RESEARCH_CUSTODY" as const,
  robotsMode: "REQUIRE_ALLOW" as const,
  retentionMode: "INDEFINITE_UNTIL_USER_DELETION" as const,
  maxResponseBytes: 2_000_000,
  maxRedirects: 0 as const,
});

function submission(): FrozenCrawlerRecoverySubmission {
  const clientOperationId = "crawler-operation-recovery";
  const expectedVersion = 7;
  const displayFileName = "Evidence packet.pdf";
  const maxBytes = 1_000_000;
  return Object.freeze({
    body: JSON.stringify({
      schemaVersion: 1,
      clientOperationId,
      expectedVersion,
      policyVersion: POLICY.policyVersion,
      sourceUrl: SOURCE_URL,
      displayFileName,
      rightsAttestation: {
        scope: "INDEFINITE_RESEARCH_CUSTODY",
        userDeclared: true,
      },
      robotsMode: "REQUIRE_ALLOW",
      retentionMode: "INDEFINITE_UNTIL_USER_DELETION",
      maxBytes,
    }),
    clientOperationId,
    displayFileName,
    expectedVersion,
    maxBytes,
    policy: POLICY,
    policyVersion: POLICY.policyVersion,
  });
}

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test("crawler recovery preserves the exact serialized command and only safe sibling metadata", () => {
  const original = submission();
  const serialized = serializeCrawlerRecovery(WORKSPACE_ID, original);
  const restored = parseCrawlerRecovery(serialized, WORKSPACE_ID);
  assert.ok(restored);
  assert.equal(restored.body, original.body);
  assert.equal(restored.clientOperationId, original.clientOperationId);
  assert.equal(restored.policyVersion, original.policyVersion);
  const outer = JSON.parse(serialized) as Record<string, unknown>;
  assert.equal(JSON.stringify({ ...outer, body: "[opaque command]" }).includes(SOURCE_URL), false);
  assert.equal(typeof outer.body, "string");
  assert.equal(outer.body, original.body);
  assert.equal(Object.isFrozen(restored), true);
  assert.equal(Object.isFrozen(restored.policy), true);
});

test("workspace-scoped session recovery round-trips and clears exactly one key", () => {
  const storage = new MemoryStorage();
  const original = submission();
  assert.equal(persistCrawlerRecovery(storage, WORKSPACE_ID, original), true);
  assert.equal(storage.values.size, 1);
  assert.equal(restoreCrawlerRecovery(storage, WORKSPACE_ID)?.body, original.body);
  assert.equal(restoreCrawlerRecovery(storage, "other-workspace"), null);
  assert.equal(storage.values.size, 1);
  clearCrawlerRecovery(storage, WORKSPACE_ID);
  assert.equal(storage.values.size, 0);
});

test("malformed, open, mismatched, and reconstructed recovery envelopes fail closed", () => {
  const original = submission();
  const baseline = JSON.parse(
    serializeCrawlerRecovery(WORKSPACE_ID, original),
  ) as Record<string, unknown>;
  const mutations: Record<string, unknown>[] = [
    { ...baseline, extra: true },
    { ...baseline, workspaceId: "another-workspace" },
    { ...baseline, clientOperationId: "different-operation" },
    { ...baseline, policyVersion: "different-policy" },
    { ...baseline, maxBytes: original.maxBytes + 1 },
    { ...baseline, body: `${original.body} ` },
    {
      ...baseline,
      policy: { ...(baseline.policy as Record<string, unknown>), maxRedirects: 1 },
    },
    {
      ...baseline,
      body: JSON.stringify({
        ...(JSON.parse(original.body) as Record<string, unknown>),
        sourceUrl: "https://repository.example.org/papers/changed.pdf",
        extra: true,
      }),
    },
  ];
  for (const mutation of mutations) {
    assert.equal(parseCrawlerRecovery(JSON.stringify(mutation), WORKSPACE_ID), null);
  }
  assert.equal(parseCrawlerRecovery("not-json", WORKSPACE_ID), null);
});

test("corrupt storage is removed and storage denial never throws", () => {
  const storage = new MemoryStorage();
  const key = crawlerRecoveryStorageKey(WORKSPACE_ID);
  storage.values.set(key, "not-json");
  assert.equal(restoreCrawlerRecovery(storage, WORKSPACE_ID), null);
  assert.equal(storage.values.has(key), false);

  const denied: StorageLike = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); },
  };
  assert.equal(persistCrawlerRecovery(denied, WORKSPACE_ID, submission()), false);
  assert.equal(restoreCrawlerRecovery(denied, WORKSPACE_ID), null);
  assert.doesNotThrow(() => clearCrawlerRecovery(denied, WORKSPACE_ID));
});

test("only a closed PaperPilot 4xx envelope is a definitive crawler outcome", () => {
  const payload = {
    error: {
      code: "version_conflict",
      message: "Workspace changed.",
      requestId: "request-123",
    },
  };
  assert.equal(crawlerDefinitiveProblemCode({
    status: 409,
    payload,
    responseRequestId: "request-123",
    contentType: "application/json",
    cacheControl: "private, no-store",
  }), "version_conflict");
  for (const status of [408, 425, 429, 500, 302, 200]) {
    assert.equal(crawlerDefinitiveProblemCode({
      status,
      payload,
      responseRequestId: "request-123",
      contentType: "application/json",
      cacheControl: "no-store",
    }), null);
  }
  assert.equal(crawlerDefinitiveProblemCode({
    status: 409,
    payload,
    responseRequestId: "intermediary-request",
    contentType: "application/json",
    cacheControl: "no-store",
  }), null);
  assert.equal(crawlerDefinitiveProblemCode({
    status: 400,
    payload: { ...payload, extra: true },
    responseRequestId: "request-123",
    contentType: "application/json",
    cacheControl: "no-store",
  }), null);
  assert.equal(crawlerDefinitiveProblemCode({
    status: 400,
    payload: { error: { ...payload.error, upstream: true } },
    responseRequestId: "request-123",
    contentType: "application/json",
    cacheControl: "no-store",
  }), null);
  assert.equal(crawlerDefinitiveProblemCode({
    status: 409,
    payload,
    responseRequestId: "request-123",
    contentType: "text/html",
    cacheControl: "no-store",
  }), null);
  assert.equal(crawlerDefinitiveProblemCode({
    status: 409,
    payload,
    responseRequestId: "request-123",
    contentType: "application/json",
    cacheControl: "private, max-age=0",
  }), null);
});
