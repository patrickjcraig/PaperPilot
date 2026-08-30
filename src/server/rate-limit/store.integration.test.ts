import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { prisma } from "@/lib/prisma";
import {
  rateLimitBucketKey,
  type FixedWindowRateLimitPolicy,
  type RateLimitBoundary,
} from "./core";
import { consumeRateLimits } from "./store";

const secret = "integration-rate-limit-secret-with-at-least-32-bytes";
const keysToDelete = new Set<string>();

after(async () => {
  if (keysToDelete.size > 0) {
    await prisma.rateLimitBucket.deleteMany({ where: { key: { in: Array.from(keysToDelete) } } });
  }
  await prisma.$disconnect();
});

function trackedBoundary(boundary: RateLimitBoundary): RateLimitBoundary {
  keysToDelete.add(rateLimitBucketKey(boundary.policy, boundary.subject, secret));
  return boundary;
}

test("parallel consumers cannot cross a shared PostgreSQL fixed-window boundary", async () => {
  const suffix = randomUUID();
  const policy: FixedWindowRateLimitPolicy = {
    name: `integration.concurrent.${suffix}`,
    algorithm: "fixed-window",
    limit: 5,
    windowSeconds: 60,
  };
  const boundary = trackedBoundary({
    policy,
    subject: { scope: "user", identifier: `integration-user-${suffix}` },
  });
  const now = new Date();

  const results = await Promise.all(
    Array.from({ length: 20 }, () => consumeRateLimits([boundary], { now, secret })),
  );
  assert.equal(results.filter((result) => result.allowed).length, policy.limit);
  assert.equal(results.filter((result) => !result.allowed).length, 20 - policy.limit);

  const key = rateLimitBucketKey(policy, boundary.subject, secret);
  const stored = await prisma.rateLimitBucket.findUniqueOrThrow({ where: { key } });
  assert.equal(stored.policy, policy.name);
  assert.deepEqual(stored.state, {
    algorithm: "fixed-window",
    count: policy.limit,
    windowStartedAtMs: now.getTime(),
  });
});

test("multi-scope checks consume all boundaries or none", async () => {
  const suffix = randomUUID();
  const userPolicy: FixedWindowRateLimitPolicy = {
    name: `integration.user.${suffix}`,
    algorithm: "fixed-window",
    limit: 10,
    windowSeconds: 60,
  };
  const workspacePolicy: FixedWindowRateLimitPolicy = {
    name: `integration.workspace.${suffix}`,
    algorithm: "fixed-window",
    limit: 1,
    windowSeconds: 60,
  };
  const userBoundary = trackedBoundary({
    policy: userPolicy,
    subject: { scope: "user", identifier: `user-${suffix}` },
  });
  const workspaceBoundary = trackedBoundary({
    policy: workspacePolicy,
    subject: { scope: "workspace", identifier: `workspace-${suffix}` },
  });
  const now = new Date();

  assert.equal(
    (await consumeRateLimits([workspaceBoundary], { now, secret })).allowed,
    true,
  );
  const denied = await consumeRateLimits(
    [userBoundary, workspaceBoundary],
    { now: new Date(now.getTime() + 1), secret },
  );
  assert.equal(denied.allowed, false);

  const userKey = rateLimitBucketKey(userPolicy, userBoundary.subject, secret);
  assert.equal(
    await prisma.rateLimitBucket.findUnique({ where: { key: userKey } }),
    null,
    "an available user token must not be charged when the workspace quota denies the request",
  );
});

test("Better Auth's required bigint rate-limit record round-trips through Prisma", async () => {
  const key = `better-auth-integration-${randomUUID()}`;
  const lastRequest = BigInt(Date.now());
  try {
    const created = await prisma.rateLimit.create({ data: { key, count: 1, lastRequest } });
    assert.equal(created.key, key);
    assert.equal(created.count, 1);
    assert.equal(created.lastRequest, lastRequest);

    const incremented = await prisma.rateLimit.updateMany({
      where: { key, count: { lt: 2 } },
      data: { count: { increment: 1 } },
    });
    assert.equal(incremented.count, 1);
    assert.equal((await prisma.rateLimit.findUniqueOrThrow({ where: { key } })).count, 2);
  } finally {
    await prisma.rateLimit.deleteMany({ where: { key } });
  }
});
