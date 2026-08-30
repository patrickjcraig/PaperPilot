import assert from "node:assert/strict";
import test from "node:test";
import { HttpProblem } from "@/server/http/problem";
import {
  invitationRolesFor,
  requireWorkspaceCollaborationManager,
} from "./collaboration-contract";
import { workspaceMembershipAuthorityLockKey } from "./membership-lock";

test("collaboration management roles grant only the closed role subset", () => {
  assert.deepEqual(invitationRolesFor("owner"), ["admin", "member", "viewer"]);
  assert.deepEqual(invitationRolesFor("admin"), ["member", "viewer"]);
  assert.deepEqual(invitationRolesFor("member"), []);
  assert.deepEqual(invitationRolesFor("viewer"), []);
  assert.equal(requireWorkspaceCollaborationManager("owner"), "owner");
  assert.equal(requireWorkspaceCollaborationManager("admin"), "admin");
  for (const role of ["member", "viewer", "admin,member", "editor"]) {
    assert.throws(
      () => requireWorkspaceCollaborationManager(role),
      (error: unknown) => error instanceof HttpProblem && [403, 409].includes(error.status),
    );
  }
});

test("membership authority lock keys are tenant/user scoped and domain separated", () => {
  const first = workspaceMembershipAuthorityLockKey("workspace-a", "user-a");
  assert.equal(first, workspaceMembershipAuthorityLockKey("workspace-a", "user-a"));
  assert.notEqual(first, workspaceMembershipAuthorityLockKey("workspace-b", "user-a"));
  assert.notEqual(first, workspaceMembershipAuthorityLockKey("workspace-a", "user-b"));
  assert.match(first, /^paperpilot:workspace-membership-authority:v1/);
});
