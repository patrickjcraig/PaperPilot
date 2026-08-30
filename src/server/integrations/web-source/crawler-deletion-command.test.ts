import assert from "node:assert/strict";
import test from "node:test";

import {
  crawlerCustodyDeletionRequestHash,
  parseCrawlerCustodyDeletionCommandV1,
} from "./crawler-deletion-command";

function command() {
  return {
    schemaVersion: 1,
    clientOperationId: "delete-operation-1",
    expectedVersion: 7,
    crawlerImportId: "crawler-request-1",
    confirmDeletion: true,
  };
}

test("crawler custody deletion parsing is closed, target-bound, and deterministic", () => {
  const parsed = parseCrawlerCustodyDeletionCommandV1(
    command(),
    "crawler-request-1",
  );
  assert.deepEqual(parsed.command, command());
  assert.equal(parsed.requestHash, crawlerCustodyDeletionRequestHash(parsed.command));
  assert.match(parsed.requestHash, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(parsed.command), true);
});

test("crawler custody deletion rejects implicit consent, target substitution, and extensions", () => {
  assert.throws(
    () => parseCrawlerCustodyDeletionCommandV1(
      { ...command(), confirmDeletion: false },
      "crawler-request-1",
    ),
    /explicit crawler custody deletion confirmation/i,
  );
  assert.throws(
    () => parseCrawlerCustodyDeletionCommandV1(command(), "crawler-request-2"),
    /must match/i,
  );
  assert.throws(
    () => parseCrawlerCustodyDeletionCommandV1(
      { ...command(), sourceUrl: "https://example.org/private.pdf" },
      "crawler-request-1",
    ),
    /shape is not supported/i,
  );
});

