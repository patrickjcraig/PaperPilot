import assert from "node:assert/strict";
import test from "node:test";
import { HttpProblem } from "@/server/http/problem";
import {
  applyCollaborationIdempotencyHeader,
  normalizeCollaborationEmail,
  validateCancelWorkspaceInvitationCommand,
  validateCollaborationPathId,
  validateCreateWorkspaceInvitationCommand,
  validateInvitationDecisionCommand,
  validateWorkspaceMemberRemovalCommand,
  validateWorkspaceRoleUpdateCommand,
} from "./collaboration-contract";

function isValidation(error: unknown): boolean {
  return error instanceof HttpProblem && error.status === 400 && error.code === "validation";
}

test("collaboration email normalization is canonical and bounded", () => {
  assert.equal(normalizeCollaborationEmail("  Researcher@Example.TEST "), "researcher@example.test");
  assert.throws(() => normalizeCollaborationEmail("missing-domain@example"), isValidation);
  assert.throws(() => normalizeCollaborationEmail("two words@example.test"), isValidation);
  assert.throws(() => normalizeCollaborationEmail(`a@${"x".repeat(250)}.test`), isValidation);
});

test("invitation creation accepts only the versioned closed command", () => {
  assert.deepEqual(validateCreateWorkspaceInvitationCommand({
    schemaVersion: 1,
    clientOperationId: "invite:123",
    expectedVersion: 4,
    email: " Scientist@Example.TEST ",
    role: "viewer",
  }), {
    schemaVersion: 1,
    clientOperationId: "invite:123",
    expectedVersion: 4,
    email: "scientist@example.test",
    role: "viewer",
  });

  for (const role of ["owner", "editor", "admin,member", null]) {
    assert.throws(() => validateCreateWorkspaceInvitationCommand({
      schemaVersion: 1,
      clientOperationId: "invite:closed-role",
      expectedVersion: 0,
      email: "scientist@example.test",
      role,
    }), isValidation);
  }
  assert.throws(() => validateCreateWorkspaceInvitationCommand({
    schemaVersion: 1,
    clientOperationId: "invite:extra",
    expectedVersion: 0,
    email: "scientist@example.test",
    role: "member",
    organizationId: "foreign-tenant",
  }), isValidation);
  assert.throws(() => validateCreateWorkspaceInvitationCommand({
    schemaVersion: 2,
    clientOperationId: "invite:v2",
    expectedVersion: 0,
    email: "scientist@example.test",
    role: "member",
  }), isValidation);
});

test("decision, cancellation, role, and removal contracts reject loose fields", () => {
  assert.deepEqual(validateInvitationDecisionCommand({
    schemaVersion: 1,
    clientOperationId: "decision-1",
    decision: "accept",
  }), {
    schemaVersion: 1,
    clientOperationId: "decision-1",
    decision: "accept",
  });
  assert.throws(() => validateInvitationDecisionCommand({
    schemaVersion: 1,
    clientOperationId: "decision-2",
    decision: "ignore",
  }), isValidation);

  assert.equal(validateCancelWorkspaceInvitationCommand({
    schemaVersion: 1,
    clientOperationId: "cancel-1",
    expectedVersion: 8,
  }).expectedVersion, 8);
  assert.equal(validateWorkspaceRoleUpdateCommand({
    schemaVersion: 1,
    clientOperationId: "role-1",
    expectedVersion: 9,
    role: "admin",
  }).role, "admin");
  assert.equal(validateWorkspaceMemberRemovalCommand({
    schemaVersion: 1,
    clientOperationId: "remove-1",
    expectedVersion: 10,
    confirmation: "REMOVE_MEMBER",
  }).confirmation, "REMOVE_MEMBER");
  assert.throws(() => validateWorkspaceMemberRemovalCommand({
    schemaVersion: 1,
    clientOperationId: "remove-2",
    expectedVersion: 10,
    confirmation: true,
  }), isValidation);
});

test("Idempotency-Key is validated and cannot contradict the body", () => {
  const request = new Request("http://localhost/api/workspaces/example/invitations", {
    headers: { "Idempotency-Key": "invite:header" },
  });
  assert.deepEqual(
    applyCollaborationIdempotencyHeader(request, { schemaVersion: 1 }),
    { schemaVersion: 1, clientOperationId: "invite:header" },
  );
  assert.throws(() => applyCollaborationIdempotencyHeader(request, {
    schemaVersion: 1,
    clientOperationId: "invite:body",
  }), (error: unknown) =>
    error instanceof HttpProblem
    && error.status === 400
    && error.code === "idempotency_mismatch");
});

test("collaboration path identifiers are bounded opaque values", () => {
  assert.equal(validateCollaborationPathId("cm123_A-9", "memberId"), "cm123_A-9");
  assert.throws(() => validateCollaborationPathId("../other", "memberId"), isValidation);
  assert.throws(() => validateCollaborationPathId("x".repeat(201), "memberId"), isValidation);
});
