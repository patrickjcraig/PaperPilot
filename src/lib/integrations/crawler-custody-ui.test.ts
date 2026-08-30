import assert from "node:assert/strict";
import test from "node:test";

import {
  clearCrawlerCustodyDeletionRecovery,
  createCrawlerCustodyDeletionSubmission,
  crawlerCustodyDeletionRecoveryStorageKey,
  crawlerCustodyDeletionRoute,
  parseCrawlerCustodyDeletionRecovery,
  parseCrawlerCustodyDeletionResponse,
  persistCrawlerCustodyDeletionRecovery,
  restoreCrawlerCustodyDeletionRecovery,
  serializeCrawlerCustodyDeletionRecovery,
  type CrawlerCustodyStorageLike,
} from "./crawler-custody-ui";

const WORKSPACE_ID = "workspace:custody-recovery";

const submission = createCrawlerCustodyDeletionSubmission({
  clientOperationId: "delete:operation-1",
  crawlerImportId: "crawler:request-1",
  expectedVersion: 7,
});

function request(status: "DELETING" | "DELETED") {
  return { id: "crawler:request-1", status, displayFileName: "paper.pdf" };
}

function parseRequest(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("invalid request");
  return value as ReturnType<typeof request>;
}

class MemoryStorage implements CrawlerCustodyStorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test("custody deletion freezes a URL-free exact command and encoded route", () => {
  assert.equal(
    crawlerCustodyDeletionRoute("workspace:one", "crawler:request-1"),
    "/api/workspaces/workspace%3Aone/integrations/crawler/requests/crawler%3Arequest-1/custody",
  );
  assert.equal(submission.body, JSON.stringify({
    schemaVersion: 1,
    clientOperationId: "delete:operation-1",
    expectedVersion: 7,
    crawlerImportId: "crawler:request-1",
    confirmDeletion: true,
  }));
  assert.equal(submission.body.includes("url"), false);
  assert.equal(Object.isFrozen(submission), true);
});

test("custody deletion recovery preserves the exact URL-free command across reload", () => {
  const serialized = serializeCrawlerCustodyDeletionRecovery(WORKSPACE_ID, submission);
  const restored = parseCrawlerCustodyDeletionRecovery(serialized, WORKSPACE_ID);
  assert.ok(restored);
  assert.equal(restored.body, submission.body);
  assert.equal(restored.clientOperationId, submission.clientOperationId);
  assert.equal(restored.crawlerImportId, submission.crawlerImportId);
  assert.equal(Object.isFrozen(restored), true);
  assert.equal(serialized.toLowerCase().includes("url"), false);

  const storage = new MemoryStorage();
  assert.equal(persistCrawlerCustodyDeletionRecovery(storage, WORKSPACE_ID, submission), true);
  assert.equal(
    restoreCrawlerCustodyDeletionRecovery(storage, WORKSPACE_ID)?.body,
    submission.body,
  );
  assert.equal(restoreCrawlerCustodyDeletionRecovery(storage, "workspace:other"), null);
  assert.equal(storage.values.size, 1);
  clearCrawlerCustodyDeletionRecovery(storage, WORKSPACE_ID);
  assert.equal(storage.values.size, 0);
});

test("custody deletion recovery rejects reconstruction, target drift, and storage denial", () => {
  const baseline = JSON.parse(
    serializeCrawlerCustodyDeletionRecovery(WORKSPACE_ID, submission),
  ) as Record<string, unknown>;
  const command = JSON.parse(submission.body) as Record<string, unknown>;
  const mutations: Record<string, unknown>[] = [
    { ...baseline, extra: true },
    { ...baseline, workspaceId: "workspace:other" },
    { ...baseline, crawlerImportId: "crawler:other" },
    { ...baseline, clientOperationId: "delete:other" },
    { ...baseline, expectedVersion: 8 },
    { ...baseline, body: `${submission.body} ` },
    { ...baseline, body: JSON.stringify({ ...command, confirmDeletion: false }) },
    { ...baseline, body: JSON.stringify({ ...command, extra: true }) },
  ];
  for (const mutation of mutations) {
    assert.equal(
      parseCrawlerCustodyDeletionRecovery(JSON.stringify(mutation), WORKSPACE_ID),
      null,
    );
  }

  const storage = new MemoryStorage();
  storage.values.set(crawlerCustodyDeletionRecoveryStorageKey(WORKSPACE_ID), "not-json");
  assert.equal(restoreCrawlerCustodyDeletionRecovery(storage, WORKSPACE_ID), null);
  assert.equal(storage.values.size, 0);
  const denied: CrawlerCustodyStorageLike = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); },
  };
  assert.equal(persistCrawlerCustodyDeletionRecovery(denied, WORKSPACE_ID, submission), false);
  assert.equal(restoreCrawlerCustodyDeletionRecovery(denied, WORKSPACE_ID), null);
  assert.doesNotThrow(() => clearCrawlerCustodyDeletionRecovery(denied, WORKSPACE_ID));
});

test("custody deletion admits applied scheduling and later completed replays", () => {
  const applied = parseCrawlerCustodyDeletionResponse({
    value: { outcome: "applied", aggregateVersion: 8, request: request("DELETING") },
    httpStatus: 202,
    submission,
    parseRequest,
  });
  assert.equal(applied.request.status, "DELETING");

  const replayed = parseCrawlerCustodyDeletionResponse({
    value: { outcome: "replayed", aggregateVersion: 11, request: request("DELETED") },
    httpStatus: 200,
    submission,
    parseRequest,
  });
  assert.equal(replayed.aggregateVersion, 11);
  assert.equal(replayed.request.status, "DELETED");
});

test("custody deletion rejects open, misbound, and impossible success responses", () => {
  const cases: Array<{ value: unknown; httpStatus: number }> = [
    {
      value: {
        outcome: "applied",
        aggregateVersion: 8,
        request: request("DELETING"),
        sourceUrl: "https://private.example/paper.pdf",
      },
      httpStatus: 202,
    },
    { value: { outcome: "applied", aggregateVersion: 9, request: request("DELETING") }, httpStatus: 202 },
    { value: { outcome: "applied", aggregateVersion: 8, request: request("DELETED") }, httpStatus: 202 },
    { value: { outcome: "applied", aggregateVersion: 8, request: request("DELETING") }, httpStatus: 200 },
    { value: { outcome: "replayed", aggregateVersion: 7, request: request("DELETING") }, httpStatus: 200 },
    {
      value: {
        outcome: "replayed",
        aggregateVersion: 8,
        request: { ...request("DELETED"), id: "crawler:other" },
      },
      httpStatus: 200,
    },
    {
      value: {
        outcome: "replayed",
        aggregateVersion: 8,
        request: { ...request("DELETED"), status: "READY" },
      },
      httpStatus: 200,
    },
  ];
  for (const candidate of cases) {
    assert.throws(() => parseCrawlerCustodyDeletionResponse({
      ...candidate,
      submission,
      parseRequest,
    }), /invalid crawler custody response/);
  }
});

test("custody deletion rejects invalid identifiers and revision overflow", () => {
  assert.throws(() => createCrawlerCustodyDeletionSubmission({
    clientOperationId: "delete operation",
    crawlerImportId: "crawler:request-1",
    expectedVersion: 7,
  }), /clientOperationId is invalid/);
  assert.throws(() => parseCrawlerCustodyDeletionResponse({
    value: { outcome: "applied", aggregateVersion: Number.MAX_SAFE_INTEGER, request: request("DELETING") },
    httpStatus: 202,
    submission: createCrawlerCustodyDeletionSubmission({
      clientOperationId: "delete:overflow",
      crawlerImportId: "crawler:request-1",
      expectedVersion: Number.MAX_SAFE_INTEGER,
    }),
    parseRequest,
  }), /invalid crawler custody response/);
});
