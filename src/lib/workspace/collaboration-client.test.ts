import assert from "node:assert/strict";
import test from "node:test";
import {
  CollaborationHttpError,
  decodeReceivedInvitations,
  decodeWorkspaceCollaborators,
  decodeWorkspaceDirectory,
  HttpCollaborationClient,
} from "./collaboration-client";

const createdAt = "2026-08-29T12:00:00.000Z";
const expiresAt = "2026-09-05T12:00:00.000Z";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("collaboration list decoders accept only exact bounded authority records", () => {
  const directory = {
    schemaVersion: 1,
    activeWorkspaceId: "workspace:one",
    workspaces: [{
      id: "workspace:one",
      name: "Synthesis Lab",
      kind: "shared",
      role: "admin",
      memberCount: 3,
    }],
  };
  assert.deepEqual(decodeWorkspaceDirectory(directory), directory);
  assert.equal(decodeWorkspaceDirectory({ ...directory, unexpected: true }), null);
  assert.equal(decodeWorkspaceDirectory({ ...directory, activeWorkspaceId: "workspace:other" }), null);

  const invitations = {
    schemaVersion: 1,
    invitations: [{
      id: "invitation:one",
      workspace: { id: "workspace:two", name: "Replication Group" },
      inviter: { name: "Amina Chen" },
      role: "member",
      createdAt,
      expiresAt,
    }],
  };
  assert.deepEqual(decodeReceivedInvitations(invitations), invitations);
  assert.equal(decodeReceivedInvitations({
    ...invitations,
    invitations: [{ ...invitations.invitations[0], role: "owner" }],
  }), null);

  const collaborators = {
    schemaVersion: 1,
    workspaceId: "workspace:one",
    aggregateVersion: 7,
    currentRole: "admin",
    capabilities: { inviteRoles: ["admin", "member", "viewer"], canManageMembers: true },
    members: [{
      id: "member:one",
      name: "Pat Researcher",
      email: "pat@example.test",
      emailVerified: true,
      role: "admin",
      joinedAt: createdAt,
      isCurrentUser: true,
    }],
    pendingInvitations: [],
  };
  assert.deepEqual(decodeWorkspaceCollaborators(collaborators), collaborators);
  assert.equal(decodeWorkspaceCollaborators({
    ...collaborators,
    currentRole: "viewer",
  }), null, "the current member role must match currentRole");
  assert.equal(decodeWorkspaceCollaborators({
    ...collaborators,
    capabilities: { inviteRoles: [], canManageMembers: false },
    pendingInvitations: [{
      id: "invitation:hidden",
      email: "hidden@example.test",
      role: "viewer",
      createdAt,
      expiresAt,
    }],
  }), null, "a non-manager response cannot leak the pending invitation register");
});

test("collaborator registers remain bound to the requested workspace", async (context) => {
  context.mock.method(globalThis, "fetch", async () => jsonResponse({
    schemaVersion: 1,
    workspaceId: "workspace:other",
    aggregateVersion: 1,
    currentRole: "viewer",
    capabilities: { inviteRoles: [], canManageMembers: false },
    members: [{
      id: "member:one",
      name: "Pat Researcher",
      email: "pat@example.test",
      emailVerified: true,
      role: "viewer",
      joinedAt: createdAt,
      isCurrentUser: true,
    }],
    pendingInvitations: [],
  }));

  await assert.rejects(
    new HttpCollaborationClient().collaborators("workspace:one"),
    /another workspace/,
  );
});

test("workspace activation is ID-only and verifies the returned tenant", async (context) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse({ schemaVersion: 1, workspaceId: "workspace:one" });
  });

  const result = await new HttpCollaborationClient().activateWorkspace("workspace:one");
  assert.deepEqual(result, { schemaVersion: 1, workspaceId: "workspace:one" });
  assert.equal(calls[0]?.url, "/api/workspaces/workspace%3Aone/activate");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { schemaVersion: 1 });
  assert.equal(new Headers(calls[0]?.init?.headers).has("Idempotency-Key"), false);
});

test("collaboration mutations use exact PaperPilot routes, commands, and idempotency headers", async (context) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/decision")) {
      return jsonResponse({
        schemaVersion: 1,
        outcome: "applied",
        aggregateVersion: 8,
        invitation: { id: "invitation:one", status: "accepted" },
        membership: { workspaceId: "workspace:one", role: "member" },
      });
    }
    if (url.endsWith("/cancel")) {
      return jsonResponse({
        schemaVersion: 1,
        outcome: "applied",
        aggregateVersion: 9,
        invitation: { id: "invitation:one", status: "canceled" },
      });
    }
    if (url.endsWith("/role")) {
      return jsonResponse({
        schemaVersion: 1,
        outcome: "applied",
        aggregateVersion: 10,
        member: { id: "member:one", role: "viewer" },
      });
    }
    if (url.endsWith("/remove")) {
      return jsonResponse({
        schemaVersion: 1,
        outcome: "applied",
        aggregateVersion: 11,
        member: { id: "member:one", status: "removed" },
      });
    }
    return jsonResponse({
      schemaVersion: 1,
      outcome: "applied",
      aggregateVersion: 8,
      invitation: {
        id: "invitation:one",
        email: "colleague@example.test",
        role: "member",
        status: "pending",
        createdAt,
        expiresAt,
      },
    });
  });

  const client = new HttpCollaborationClient();
  await client.invite("workspace:one", {
    schemaVersion: 1,
    clientOperationId: "operation:invite",
    expectedVersion: 7,
    email: "colleague@example.test",
    role: "member",
  });
  await client.decideInvitation("invitation:one", {
    schemaVersion: 1,
    clientOperationId: "operation:decision",
    decision: "accept",
  });
  await client.cancelInvitation("workspace:one", "invitation:one", {
    schemaVersion: 1,
    clientOperationId: "operation:cancel",
    expectedVersion: 8,
  });
  await client.updateMemberRole("workspace:one", "member:one", {
    schemaVersion: 1,
    clientOperationId: "operation:role",
    expectedVersion: 9,
    role: "viewer",
  });
  await client.removeMember("workspace:one", "member:one", {
    schemaVersion: 1,
    clientOperationId: "operation:remove",
    expectedVersion: 10,
    confirmation: "REMOVE_MEMBER",
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "/api/workspaces/workspace%3Aone/invitations",
    "/api/invitations/invitation%3Aone/decision",
    "/api/workspaces/workspace%3Aone/invitations/invitation%3Aone/cancel",
    "/api/workspaces/workspace%3Aone/members/member%3Aone/role",
    "/api/workspaces/workspace%3Aone/members/member%3Aone/remove",
  ]);
  assert.deepEqual(calls.map((call) => new Headers(call.init?.headers).get("Idempotency-Key")), [
    "operation:invite",
    "operation:decision",
    "operation:cancel",
    "operation:role",
    "operation:remove",
  ]);
  assert.ok(calls.every((call) => call.init?.method === "POST"));
  assert.deepEqual(JSON.parse(String(calls[4]?.init?.body)), {
    schemaVersion: 1,
    clientOperationId: "operation:remove",
    expectedVersion: 10,
    confirmation: "REMOVE_MEMBER",
  });
});

test("collaboration mutations reject mismatched resource identities and legacy data wrappers", async (context) => {
  const client = new HttpCollaborationClient();
  context.mock.method(globalThis, "fetch", async () => jsonResponse({
    schemaVersion: 1,
    outcome: "applied",
    aggregateVersion: 3,
    data: { member: { id: "member:one", role: "viewer" } },
  }));
  await assert.rejects(
    client.updateMemberRole("workspace:one", "member:one", {
      schemaVersion: 1,
      clientOperationId: "operation:role",
      expectedVersion: 2,
      role: "viewer",
    }),
    /invalid collaborator role result/,
  );
});

test("collaboration HTTP errors expose only bounded problem details", async (context) => {
  context.mock.method(globalThis, "fetch", async () => jsonResponse({
    error: {
      code: "version_conflict",
      message: "The workspace ledger changed.",
      requestId: "request:one",
    },
  }, 409));
  const client = new HttpCollaborationClient();
  await assert.rejects(
    client.collaborators("workspace:one"),
    (cause: unknown) => {
      assert.ok(cause instanceof CollaborationHttpError);
      assert.equal(cause.status, 409);
      assert.equal(cause.code, "version_conflict");
      assert.equal(cause.requestId, "request:one");
      assert.equal(cause.message, "The workspace ledger changed.");
      return true;
    },
  );
});
