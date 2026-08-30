import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authenticatedMutationRateLimitBoundaries,
  readerReadRateLimitBoundariesForTrustedSubjects,
  readerReadRateLimitPolicies,
  routeRateLimitPolicies,
} from "./routes";

test("pre-membership mutations never debit a workspace budget", () => {
  const boundaries = authenticatedMutationRateLimitBoundaries({
    request: new Request("https://paperpilot.example/api/invitations/invitation:one/decision"),
    userId: "invited-user",
  });
  assert.deepEqual(boundaries, [{
    policy: routeRateLimitPolicies.workspaceUserBurst,
    subject: { scope: "user", identifier: "invited-user" },
  }]);
  assert.ok(boundaries.every((boundary) => boundary.subject.scope !== "workspace"));
});

test("Reader read policies have dedicated validated deployment defaults", () => {
  const policies = readerReadRateLimitPolicies({});

  assert.deepEqual(policies, {
    readerIpBurst: {
      name: "reader.ip.burst",
      algorithm: "token-bucket",
      capacity: 600,
      refillTokens: 600,
      refillIntervalSeconds: 60,
    },
    readerUserBurst: {
      name: "reader.user.burst",
      algorithm: "token-bucket",
      capacity: 60,
      refillTokens: 60,
      refillIntervalSeconds: 60,
    },
    readerWorkspaceBurst: {
      name: "reader.workspace.burst",
      algorithm: "token-bucket",
      capacity: 300,
      refillTokens: 300,
      refillIntervalSeconds: 60,
    },
  });
});

test("Reader read policy environment overrides are exact and fail closed", () => {
  const policies = readerReadRateLimitPolicies({
    PAPERPILOT_READER_IP_PER_MINUTE: "900",
    PAPERPILOT_READER_USER_PER_MINUTE: "75",
    PAPERPILOT_READER_WORKSPACE_PER_MINUTE: "450",
  });
  assert.deepEqual(
    [
      policies.readerIpBurst.capacity,
      policies.readerIpBurst.refillTokens,
      policies.readerUserBurst.capacity,
      policies.readerUserBurst.refillTokens,
      policies.readerWorkspaceBurst.capacity,
      policies.readerWorkspaceBurst.refillTokens,
    ],
    [900, 900, 75, 75, 450, 450],
  );

  for (const invalid of ["0", "-1", "1.5", "not-a-number", "1000000001"]) {
    assert.throws(
      () => readerReadRateLimitPolicies({ PAPERPILOT_READER_USER_PER_MINUTE: invalid }),
      /PAPERPILOT_READER_USER_PER_MINUTE must be a positive integer/,
    );
  }
});

test("Reader boundaries always use authenticated user and canonical workspace subjects", () => {
  const boundaries = readerReadRateLimitBoundariesForTrustedSubjects({
    userId: "authenticated-user",
    workspaceId: "authorized-workspace",
    trustedClientIp: null,
  });

  assert.deepEqual(boundaries, [
    {
      policy: routeRateLimitPolicies.readerUserBurst,
      subject: { scope: "user", identifier: "authenticated-user" },
    },
    {
      policy: routeRateLimitPolicies.readerWorkspaceBurst,
      subject: { scope: "workspace", identifier: "authorized-workspace" },
    },
  ]);
  assert.ok(boundaries.every((boundary) => boundary.cost === undefined));
});

test("Reader boundaries add only the IP returned by the shared trusted resolver", () => {
  const boundaries = readerReadRateLimitBoundariesForTrustedSubjects({
    userId: "reader-user",
    workspaceId: "reader-workspace",
    trustedClientIp: "198.51.100.42",
  });

  assert.deepEqual(boundaries.at(-1), {
    policy: routeRateLimitPolicies.readerIpBurst,
    subject: { scope: "ip", identifier: "198.51.100.42" },
  });
  assert.equal(boundaries.length, 3);
});
