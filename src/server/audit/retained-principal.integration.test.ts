import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { proposeWebMcpWorkspaceImport } from "@/server/integrations/webmcp/intake-service";
import { resolveLiveRetainedAuditPrincipal } from "./retained-principal";

after(async () => {
  await prisma.$disconnect();
});

test("retained principals are tenant-bound, stable while live, and one-way pseudonymizable", async () => {
  const suffix = randomUUID();
  const owner = await prisma.user.create({
    data: {
      id: `retained-owner-${suffix}`,
      name: "Retained Owner",
      email: `retained-owner-${suffix}@example.test`,
    },
  });
  const replacement = await prisma.user.create({
    data: {
      id: `retained-replacement-${suffix}`,
      name: "Replacement Account",
      email: `retained-replacement-${suffix}@example.test`,
    },
  });
  const erasable = await prisma.user.create({
    data: {
      id: `retained-erasable-${suffix}`,
      name: "Erasable Account",
      email: `retained-erasable-${suffix}@example.test`,
    },
  });
  const timestamped = await prisma.user.create({
    data: {
      id: `retained-timestamped-${suffix}`,
      name: "Timestamp Guard Account",
      email: `retained-timestamped-${suffix}@example.test`,
    },
  });
  const organizations = await Promise.all(["a", "b"].map((label) =>
    prisma.organization.create({
      data: {
        name: `Retained principal ${label}`,
        slug: `retained-principal-${label}-${suffix}`,
        kind: "TEAM",
        members: { create: { userId: owner.id, role: "owner" } },
      },
    })));
  const [organizationA, organizationB] = organizations;
  assert.ok(organizationA);
  assert.ok(organizationB);

  try {
    const first = await prisma.$transaction(async (transaction) =>
      resolveLiveRetainedAuditPrincipal(transaction, organizationA.id, owner.id),
    { isolationLevel: "Serializable" });
    const replay = await prisma.$transaction(async (transaction) =>
      resolveLiveRetainedAuditPrincipal(transaction, organizationA.id, owner.id),
    { isolationLevel: "Serializable" });
    const foreign = await prisma.$transaction(async (transaction) =>
      resolveLiveRetainedAuditPrincipal(transaction, organizationB.id, owner.id),
    { isolationLevel: "Serializable" });
    const replacementPrincipal = await prisma.$transaction(async (transaction) =>
      resolveLiveRetainedAuditPrincipal(transaction, organizationA.id, replacement.id),
    { isolationLevel: "Serializable" });
    const erasablePrincipal = await prisma.$transaction(async (transaction) =>
      resolveLiveRetainedAuditPrincipal(transaction, organizationA.id, erasable.id),
    { isolationLevel: "Serializable" });

    assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(replay.id, first.id);
    assert.notEqual(foreign.id, first.id);
    assert.equal(await prisma.retainedAuditPrincipal.count({
      where: { organizationId: organizationA.id, liveUserId: owner.id },
    }), 1);

    const timestampPrincipalId = randomUUID();
    const beforeTimestampInsert = new Date();
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Kiritimati'");
      await transaction.$executeRaw`
        INSERT INTO "public"."RetainedAuditPrincipal" (
          "id", "organizationId", "liveUserId", "createdAt"
        ) VALUES (
          ${timestampPrincipalId}::uuid, ${organizationA.id}, ${timestamped.id},
          TIMESTAMP '2000-01-01 00:00:00'
        )
      `;
    });
    const timestampPrincipal = await prisma.retainedAuditPrincipal.findUniqueOrThrow({
      where: { id: timestampPrincipalId },
    });
    assert.ok(timestampPrincipal.createdAt.getTime() >= beforeTimestampInsert.getTime() - 1);

    await assert.rejects(
      prisma.$executeRaw`
        INSERT INTO "public"."RetainedAuditPrincipal" (
          "id", "organizationId", "liveUserId", "pseudonymizedAt"
        ) VALUES (
          ${randomUUID()}::uuid, ${organizationA.id}, NULL, pg_catalog.clock_timestamp()
        )
      `,
      /must be created as a live|live_insert_check|retained audit principal/i,
    );
    await assert.rejects(
      prisma.$executeRaw`
        INSERT INTO "public"."RetainedAuditPrincipal" (
          "id", "organizationId", "liveUserId", "pseudonymizedAt"
        ) VALUES (
          ${randomUUID()}::uuid, ${organizationA.id}, ${owner.id},
          pg_catalog.clock_timestamp()
        )
      `,
      /must be created as a live|live_insert_check|retained audit principal/i,
    );

    await assert.rejects(
      prisma.retainedAuditPrincipal.update({
        where: { id: first.id },
        data: { liveUserId: null },
      }),
      /detach only through deletion|fk_detach_only_check|retained audit principal/i,
    );
    await assert.rejects(
      prisma.retainedAuditPrincipal.update({
        where: { id: first.id },
        data: { liveUserId: null, pseudonymizedAt: new Date(0) },
      }),
      /cannot be rebound|rewrite_check|retained audit principal/i,
    );

    await assert.rejects(
      prisma.auditEvent.create({
        data: {
          organizationId: organizationA.id,
          actorUserId: owner.id,
          actorPrincipalId: replacementPrincipal.id,
          action: "retained-principal.actor-mismatch-test",
          entityType: "retained-audit-principal",
          entityId: replacementPrincipal.id,
        },
      }),
      /actor_alignment_check|must be live, tenant-bound|retained authority/i,
    );

    await assert.rejects(
      prisma.auditEvent.create({
        data: {
          organizationId: organizationA.id,
          actorPrincipalId: foreign.id,
          action: "retained-principal.cross-tenant-test",
          entityType: "retained-audit-principal",
          entityId: foreign.id,
        },
      }),
      /foreign key|constraint|must be a live User|actor_alignment_check/i,
    );

    const mutableAudit = await prisma.auditEvent.create({
      data: {
        organizationId: organizationA.id,
        actorUserId: owner.id,
        actorPrincipalId: first.id,
        action: "retained-principal.authority-immutable-test",
        entityType: "retained-audit-principal",
        entityId: first.id,
      },
    });
    await assert.rejects(
      prisma.auditEvent.update({
        where: { id: mutableAudit.id },
        data: { actorPrincipalId: null },
      }),
      /cannot be stripped|retained_actor_immutable_check|retained AuditEvent/i,
    );

    const erasedAudit = await prisma.auditEvent.create({
      data: {
        organizationId: organizationA.id,
        actorUserId: erasable.id,
        actorPrincipalId: erasablePrincipal.id,
        action: "retained-principal.erasure-test",
        entityType: "retained-audit-principal",
        entityId: erasablePrincipal.id,
      },
    });
    const beforeErasure = new Date();
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Kiritimati'");
      await transaction.user.delete({ where: { id: erasable.id } });
    });
    const afterErasure = new Date();
    const erasedPrincipal = await prisma.retainedAuditPrincipal.findUniqueOrThrow({
      where: { id: erasablePrincipal.id },
    });
    assert.equal(erasedPrincipal.liveUserId, null);
    assert.ok(erasedPrincipal.pseudonymizedAt instanceof Date);
    // PostgreSQL stores this column at millisecond precision, so tolerate the
    // sub-millisecond rounding boundary around the client-side timestamp.
    assert.ok(erasedPrincipal.pseudonymizedAt.getTime() >= beforeErasure.getTime() - 1);
    assert.ok(erasedPrincipal.pseudonymizedAt.getTime() <= afterErasure.getTime() + 1);
    const retainedAudit = await prisma.auditEvent.findUniqueOrThrow({
      where: { id: erasedAudit.id },
    });
    assert.equal(retainedAudit.actorUserId, null);
    assert.equal(retainedAudit.actorPrincipalId, erasablePrincipal.id);

    const staged = await proposeWebMcpWorkspaceImport(owner, organizationA.id, {
      schemaVersion: 1,
      clientOperationId: `retained-webmcp-${suffix}`,
      expectedVersion: 0,
      proposal: {
        title: "Retained principal authority is immutable",
        authors: ["Ada Evidence"],
        year: 2026,
        venue: "Journal of Durable Research",
        publicationType: "journal article",
        abstract: "A database guard binds staged authority to its retained actor.",
        identifiers: [{ scheme: "doi", value: `10.5555/retained-${suffix}` }],
        sourcePageUrl: "https://openalex.org/W2741809807",
        isOpenAccess: true,
      },
    });
    if (!staged.ok) throw new Error(staged.message);
    const stagedProvenance = await prisma.provenanceRecord.findFirstOrThrow({
      where: {
        organizationId: organizationA.id,
        inboxEntryId: staged.data.inboxEntry.id,
        kind: "WEB_MCP",
      },
    });
    assert.equal(stagedProvenance.actorPrincipalId, first.id);
    await assert.rejects(
      prisma.inboxEntry.update({
        where: { id: staged.data.inboxEntry.id },
        data: { createdByPrincipalId: null },
      }),
      /identity is immutable|WebMcpInboxEntry_identity_check/i,
    );
    await assert.rejects(
      prisma.provenanceRecord.update({
        where: { id: stagedProvenance.id },
        data: { actorPrincipalId: replacementPrincipal.id },
      }),
      /actor_alignment_check|must be live, tenant-bound|retained authority/i,
    );

    await prisma.$transaction(async (transaction) => {
      await transaction.auditEvent.deleteMany({
        where: { organizationId: organizationA.id },
      });
      await transaction.provenanceRecord.deleteMany({
        where: { organizationId: organizationA.id },
      });
      await transaction.inboxEntry.deleteMany({
        where: { organizationId: organizationA.id },
      });
      await transaction.idempotencyRecord.deleteMany({
        where: { organizationId: organizationA.id },
      });
      await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    });

    await prisma.user.delete({ where: { id: owner.id } });
    const pseudonymized = await prisma.retainedAuditPrincipal.findUniqueOrThrow({
      where: { id: first.id },
    });
    assert.equal(pseudonymized.liveUserId, null);
    assert.ok(pseudonymized.pseudonymizedAt instanceof Date);

    await assert.rejects(
      prisma.retainedAuditPrincipal.update({
        where: { id: first.id },
        data: { liveUserId: replacement.id, pseudonymizedAt: null },
      }),
      /cannot be rebound|immutable|retained audit principal/i,
    );
    const retained = await prisma.retainedAuditPrincipal.findUniqueOrThrow({
      where: { id: first.id },
    });
    assert.equal(retained.liveUserId, null);
    assert.equal(retained.pseudonymizedAt?.getTime(), pseudonymized.pseudonymizedAt?.getTime());
  } finally {
    await prisma.$transaction(async (transaction) => {
      const organizationIds = organizations.map(({ id }) => id);
      await transaction.auditEvent.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await transaction.provenanceRecord.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await transaction.inboxEntry.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await transaction.idempotencyRecord.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    });
    await prisma.retainedAuditPrincipal.deleteMany({
      where: { organizationId: { in: organizations.map(({ id }) => id) } },
    });
    await prisma.organization.deleteMany({
      where: { id: { in: organizations.map(({ id }) => id) } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [owner.id, replacement.id, erasable.id, timestamped.id] } },
    });
  }
});
