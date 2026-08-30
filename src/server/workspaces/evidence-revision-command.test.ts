import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { HttpProblem } from "@/server/http/problem";
import { validateGroundedEvidenceRevisionCommand } from "./evidence-revision-command";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function selection() {
  return {
    documentId: "document-1",
    extractionId: "extraction-1",
    manifestSha256: digest("manifest"),
    start: {
      chunkId: "chunk-1",
      sequence: 2,
      byteOffset: 1,
      contentHash: digest("first"),
    },
    end: {
      chunkId: "chunk-2",
      sequence: 3,
      byteOffset: 4,
      contentHash: digest("last"),
    },
    expectedQuoteSha256: digest("quote"),
  };
}

function expectValidation(value: unknown): void {
  assert.throws(
    () => validateGroundedEvidenceRevisionCommand(value),
    (error: unknown) => error instanceof HttpProblem
      && error.status === 400
      && error.code === "validation",
  );
}

test("verify revision command is an exact closed discriminator", () => {
  assert.deepEqual(validateGroundedEvidenceRevisionCommand({
    clientOperationId: "verify-operation",
    expectedVersion: 7,
    action: "verify",
  }), {
    clientOperationId: "verify-operation",
    expectedVersion: 7,
    action: "verify",
  });
  expectValidation({
    clientOperationId: "verify-operation",
    expectedVersion: 7,
    action: "verify",
    selection: selection(),
  });
  expectValidation({
    clientOperationId: "verify-operation",
    expectedVersion: 7,
    action: "approve",
  });
  expectValidation({
    clientOperationId: "verify-operation",
    expectedVersion: 7,
    action: "verify",
    unknown: true,
  });
});

test("reanchor revision command preserves only exact bounded source identity", () => {
  const command = {
    clientOperationId: "reanchor-operation",
    expectedVersion: 9,
    action: "reanchor" as const,
    selection: selection(),
  };
  assert.deepEqual(validateGroundedEvidenceRevisionCommand(command), command);

  expectValidation({ ...command, selection: { ...selection(), quoteText: "client supplied" } });
  expectValidation({
    ...command,
    selection: {
      ...selection(),
      start: { ...selection().start, sequence: 10 },
      end: { ...selection().end, sequence: 9 },
    },
  });
  expectValidation({
    ...command,
    selection: {
      ...selection(),
      start: { ...selection().start, sequence: 0 },
      end: { ...selection().end, sequence: 100 },
    },
  });
  expectValidation({
    ...command,
    selection: {
      ...selection(),
      start: { ...selection().start, contentHash: "A".repeat(64) },
    },
  });
});

test("revision envelope rejects non-canonical versions and operation IDs", () => {
  for (const expectedVersion of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
    expectValidation({
      clientOperationId: "verify-operation",
      expectedVersion,
      action: "verify",
    });
  }
  expectValidation({ clientOperationId: " ", expectedVersion: 0, action: "verify" });
  expectValidation(null);
  expectValidation([]);
});
