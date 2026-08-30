import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import type { CreateProjectCommand } from "@/lib/workspace";
import { HttpProblem } from "@/server/http/problem";

const { prisma } = await import("@/lib/prisma");
const {
  acquireWorkspaceMembershipAuthorityExclusive,
  acquireWorkspaceMembershipAuthorityShared,
} = await import("./membership-lock");
const { createWorkspaceProject } = await import("./service");

const ASYNC_DEADLINE_MS = 5_000;

function supportsConcurrentDatabaseConnections(): boolean {
  const configuredPoolSize = Number(process.env.DATABASE_POOL_MAX);
  // The local Prisma Dev profile deliberately exposes one serialized
  // connection. Do not infer concurrency from the URL; run this blocking-lock
  // proof only where the integration environment explicitly provisions it.
  return Number.isSafeInteger(configuredPoolSize) && configuredPoolSize >= 2;
}

after(async () => {
  await prisma.$disconnect();
});

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.catch((error: unknown) => {
        throw new Error(`${label} failed.`, { cause: error });
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} exceeded its bounded test deadline.`)),
          ASYNC_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isolatedDatabase(connectionString: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      connectionTimeoutMillis: ASYNC_DEADLINE_MS,
      max: 1,
    }),
  });
}

function projectCommand(
  operationId: string,
  expectedVersion: number,
  name = "Authority-fenced mutation",
): CreateProjectCommand {
  return {
    clientOperationId: operationId,
    expectedVersion,
    project: {
      name,
      question: "Does revocation wait for the authorized commit?",
      description: "Concurrency fixture for workspace membership authority.",
      type: "literature-review",
      visibility: "workspace",
    },
  };
}

test(
  "membership revocation waits for an in-flight mutation and fences later writes",
  { timeout: 15_000 },
  async (context) => {
    if (!supportsConcurrentDatabaseConnections()) {
      context.skip("requires DATABASE_POOL_MAX >= 2 for two checked-out transactions");
      return;
    }
    const suffix = randomUUID();
    const owner = await prisma.user.create({
      data: {
        id: `membership-lock-owner-${suffix}`,
        name: "Membership Lock Owner",
        email: `membership-lock-owner-${suffix}@example.test`,
      },
    });
    const member = await prisma.user.create({
      data: {
        id: `membership-lock-member-${suffix}`,
        name: "Membership Lock Member",
        email: `membership-lock-member-${suffix}@example.test`,
      },
    });
    const workspace = await prisma.organization.create({
      data: {
        name: "Membership lock concurrency fixture",
        slug: `membership-lock-${suffix}`,
        kind: "TEAM",
        members: {
          create: [
            { userId: owner.id, role: "owner" },
            { userId: member.id, role: "member" },
          ],
        },
      },
    });
    const membership = await prisma.member.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId: workspace.id,
          userId: member.id,
        },
      },
    });

    const mutationAuthorized = deferred();
    const allowMutationCommit = deferred();
    const revocationAttempting = deferred();
    const exclusiveRevocationApplied = deferred();
    const staleSnapshotPinned = deferred();
    const connectionString = process.env.DATABASE_URL;
    assert.ok(connectionString, "DATABASE_URL is required for the concurrency integration test");
    const mutationDatabase = isolatedDatabase(connectionString);
    const revocationDatabase = isolatedDatabase(connectionString);
    let mutation: Promise<{ id: string; name: string }> | undefined;
    let revocation: Promise<void> | undefined;
    let exclusiveFirstRevocation: Promise<void> | undefined;
    let staleSnapshotMutation: Promise<boolean> | undefined;
    let exclusiveAcquired = false;

    try {
      // Release the fixture client's idle pooled connection so the two
      // independently configured transaction clients own the concurrency.
      await prisma.$disconnect();
      const inFlightMutation = mutationDatabase.$transaction(async (transaction) => {
        await acquireWorkspaceMembershipAuthorityShared(
          transaction,
          workspace.id,
          member.id,
        );
        const current = await transaction.member.findUnique({
          where: { id: membership.id },
          select: { id: true, role: true },
        });
        assert.deepEqual(current, { id: membership.id, role: "member" });
        const project = await transaction.project.create({
          data: {
            organizationId: workspace.id,
            name: "Authority-fenced in-flight write",
            slug: `authority-fenced-in-flight-${suffix}`,
            visibility: "WORKSPACE",
            createdById: member.id,
          },
        });
        mutationAuthorized.resolve();
        await allowMutationCommit.promise;
        return project;
      }, { timeout: ASYNC_DEADLINE_MS });
      mutation = inFlightMutation;
      void inFlightMutation.catch(() => undefined);
      await bounded(mutationAuthorized.promise, "shared mutation authorization");

      const exclusiveRevocation = revocationDatabase.$transaction(async (transaction) => {
        revocationAttempting.resolve();
        await acquireWorkspaceMembershipAuthorityExclusive(
          transaction,
          workspace.id,
          member.id,
        );
        exclusiveAcquired = true;
        const current = await transaction.member.findUnique({
          where: { id: membership.id },
          select: { id: true },
        });
        assert.ok(
          current,
          "the in-flight mutation commits before revocation deletes authority",
        );
        await transaction.member.delete({ where: { id: membership.id } });
      }, { timeout: ASYNC_DEADLINE_MS });
      revocation = exclusiveRevocation;
      void exclusiveRevocation.catch(() => undefined);
      await bounded(revocationAttempting.promise, "revocation attempt");
      await delay(100);
      assert.equal(
        exclusiveAcquired,
        false,
        "exclusive revocation must wait while the mutation holds shared authority",
      );

      allowMutationCommit.resolve();
      const applied = await bounded(inFlightMutation, "authorized workspace mutation");
      assert.equal(applied.name, "Authority-fenced in-flight write");

      await bounded(exclusiveRevocation, "exclusive membership revocation");
      assert.equal(exclusiveAcquired, true);
      assert.equal(
        await prisma.member.findUnique({ where: { id: membership.id } }),
        null,
      );
      assert.ok(
        await prisma.project.findUnique({ where: { id: applied.id } }),
        "the already-authorized write commits before authority is revoked",
      );

      const restoredMembership = await revocationDatabase.$transaction(
        async (transaction) => {
          await acquireWorkspaceMembershipAuthorityExclusive(
            transaction,
            workspace.id,
            member.id,
          );
          return transaction.member.create({
            data: {
              organizationId: workspace.id,
              userId: member.id,
              role: "member",
            },
          });
        },
      );

      // Reverse the ordering: the exclusive remover changes the Member first
      // and keeps its authority lock until a SERIALIZABLE mutation has frozen
      // an older snapshot. The shared advisory-lock SELECT then waits. After
      // revocation commits, the helper's SELECT ... FOR SHARE freshness guard
      // must force a serialization failure instead of letting the old snapshot
      // authorize a post-revocation write.
      const exclusiveFirst = revocationDatabase.$transaction(async (transaction) => {
        await acquireWorkspaceMembershipAuthorityExclusive(
          transaction,
          workspace.id,
          member.id,
        );
        await transaction.member.delete({ where: { id: restoredMembership.id } });
        exclusiveRevocationApplied.resolve();
        await staleSnapshotPinned.promise;
      }, { timeout: ASYNC_DEADLINE_MS });
      exclusiveFirstRevocation = exclusiveFirst;
      void exclusiveFirst.catch(() => undefined);
      await bounded(exclusiveRevocationApplied.promise, "exclusive-first revocation");

      const staleMutation = mutationDatabase.$transaction(async (transaction) => {
        // This harmless first SELECT deliberately freezes the SERIALIZABLE
        // snapshot while the Member deletion is still uncommitted.
        await transaction.$queryRaw`SELECT pg_backend_pid()::text`;
        staleSnapshotPinned.resolve();
        await acquireWorkspaceMembershipAuthorityShared(
          transaction,
          workspace.id,
          member.id,
        );
        const current = await transaction.member.findUnique({
          where: { id: restoredMembership.id },
          select: { id: true },
        });
        if (!current) return false;
        await transaction.project.create({
          data: {
            organizationId: workspace.id,
            name: "Forbidden stale-snapshot write",
            slug: `forbidden-stale-snapshot-${suffix}`,
            visibility: "WORKSPACE",
            createdById: member.id,
          },
        });
        return true;
      }, {
        isolationLevel: "Serializable",
        timeout: ASYNC_DEADLINE_MS,
      });
      staleSnapshotMutation = staleMutation;
      void staleMutation.catch(() => undefined);

      await bounded(exclusiveFirst, "exclusive-first revocation commit");
      await assert.rejects(
        bounded(staleMutation, "stale-snapshot shared mutation"),
      );
      assert.equal(
        await prisma.project.count({
          where: {
            organizationId: workspace.id,
            name: "Forbidden stale-snapshot write",
          },
        }),
        0,
      );

      await assert.rejects(
        createWorkspaceProject(
          member,
          workspace.id,
          projectCommand(
            `membership-lock-post-revocation-${suffix}`,
            1,
            "Post-revocation write",
          ),
        ),
        (error: unknown) =>
          error instanceof HttpProblem
          && error.status === 404
          && error.code === "workspace_not_found",
      );
      assert.equal(
        await prisma.project.count({
          where: {
            organizationId: workspace.id,
            name: "Post-revocation write",
          },
        }),
        0,
      );
    } finally {
      allowMutationCommit.resolve();
      staleSnapshotPinned.resolve();
      if (mutation) await Promise.allSettled([mutation]);
      if (revocation) await Promise.allSettled([revocation]);
      if (exclusiveFirstRevocation) await Promise.allSettled([exclusiveFirstRevocation]);
      if (staleSnapshotMutation) await Promise.allSettled([staleSnapshotMutation]);
      await mutationDatabase.$disconnect().catch(() => undefined);
      await revocationDatabase.$disconnect().catch(() => undefined);
      await prisma.auditEvent.deleteMany({ where: { organizationId: workspace.id } });
      await prisma.organization.delete({ where: { id: workspace.id } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
    }
  },
);
