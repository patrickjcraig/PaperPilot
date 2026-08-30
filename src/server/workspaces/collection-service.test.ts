import assert from "node:assert/strict";
import test from "node:test";
import { HttpProblem } from "@/server/http/problem";
import {
  applyCollectionIdempotencyHeader,
  validateCreateCollectionCommand,
} from "./collection-command";

const validCommand = {
  clientOperationId: "collection-operation",
  expectedVersion: 3,
  projectId: "project-one",
  name: "Outcome claims",
  description: "Claims grouped by measured outcome.",
  color: "blue",
};

function rejectsValidation(value: unknown): void {
  assert.throws(
    () => validateCreateCollectionCommand(value),
    (error: unknown) =>
      error instanceof HttpProblem
      && error.status === 400
      && error.code === "validation",
  );
}

test("collection commands normalize bounded text and accept only the declared shape", () => {
  assert.deepEqual(validateCreateCollectionCommand({
    ...validCommand,
    clientOperationId: "  collection-operation  ",
    projectId: "  project-one  ",
    name: "  Outcome claims  ",
    description: "  Claims grouped by measured outcome.  ",
  }), validCommand);

  rejectsValidation({ ...validCommand, unexpected: true });
  rejectsValidation({ ...validCommand, expectedVersion: "3" });
  rejectsValidation({ ...validCommand, name: "x".repeat(121) });
  rejectsValidation({ ...validCommand, description: "x".repeat(5_001) });
  rejectsValidation({ ...validCommand, color: "magenta" });
  rejectsValidation({ ...validCommand, projectId: "" });
});

test("Idempotency-Key supplies a missing operation id and rejects mismatched intent", () => {
  const withoutBodyOperationId = { ...validCommand } as Record<string, unknown>;
  delete withoutBodyOperationId.clientOperationId;
  const request = new Request("http://localhost/api/workspaces/one/collections", {
    method: "POST",
    headers: { "Idempotency-Key": validCommand.clientOperationId },
  });
  assert.deepEqual(
    validateCreateCollectionCommand(
      applyCollectionIdempotencyHeader(request, withoutBodyOperationId),
    ),
    validCommand,
  );

  const mismatch = new Request("http://localhost/api/workspaces/one/collections", {
    method: "POST",
    headers: { "Idempotency-Key": "different-operation" },
  });
  assert.throws(
    () => applyCollectionIdempotencyHeader(mismatch, validCommand),
    (error: unknown) =>
      error instanceof HttpProblem
      && error.status === 400
      && error.code === "idempotency_mismatch",
  );
});
