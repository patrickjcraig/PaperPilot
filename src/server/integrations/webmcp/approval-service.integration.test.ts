import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type {
  CreateProjectCommand,
  WorkspaceCommandResult,
} from "@/lib/workspace";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { createWorkspaceProject, workspaceBootstrap } from "@/server/workspaces/service";
import type { WebMcpProposalCommand } from "./intake-contract";
import { proposeWebMcpWorkspaceImport } from "./intake-service";
import {
  approveWebMcpProposal as finalizeWebMcpProposal,
  prepareWebMcpApprovalChallenge,
} from "./approval-service";
import {
  OpenAlexWebMcpVerifier,
  webMcpVerificationEvidenceDigest,
} from "./openalex-verifier";

after(async () => {
  await prisma.$disconnect();
});

function assertSuccess<T>(
  result: WorkspaceCommandResult<T>,
): asserts result is Extract<WorkspaceCommandResult<T>, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

function supportsConcurrentDatabaseConnections(): boolean {
  const configuredPoolSize = Number(process.env.DATABASE_POOL_MAX);
  // This test deliberately needs two checked-out clients. Never infer pool
  // capacity from the URL: the adapter may be intentionally serialized even
  // against a non-template database. Run it only with an explicit pool >= 2.
  return Number.isSafeInteger(configuredPoolSize) && configuredPoolSize >= 2;
}

function projectCommand(operationId: string, expectedVersion: number): CreateProjectCommand {
  return {
    clientOperationId: operationId,
    expectedVersion,
    project: {
      name: `WebMCP ${operationId.slice(0, 48)} ${operationId.slice(-12)}`,
      question: "Can exact human authority promote independently verified metadata?",
      description: "A durable approval-bound canonical promotion test.",
      type: "literature-review",
      visibility: "private",
    },
  };
}

function proposalCommand(
  suffix: string,
  expectedVersion: number,
  options: { identifiers?: WebMcpProposalCommand["proposal"]["identifiers"]; sourceSuffix?: string } = {},
): WebMcpProposalCommand {
  return {
    schemaVersion: 1,
    clientOperationId: `webmcp-stage-${suffix}`,
    expectedVersion,
    proposal: {
      title: "Verified research systems",
      authors: ["Ada Evidence"],
      year: 2026,
      venue: "Agent Claims Quarterly",
      publicationType: "journal article",
      abstract: "This agent-authored abstract must not become provider authority.",
      identifiers: options.identifiers ?? [
        { scheme: "doi", value: `10.5555/${suffix}` },
        { scheme: "isbn", value: "9781234567890" },
      ],
      sourcePageUrl: `https://repository.example.org/${options.sourceSuffix ?? suffix}`,
    },
  };
}

function openAlexWorkId(doi: string): string {
  const numericDigest = BigInt(`0x${createHash("sha256").update(doi).digest("hex").slice(0, 16)}`);
  return `W${numericDigest.toString(10)}`;
}

function verifier(doi: string, overrides: Record<string, unknown> = {}) {
  const workId = openAlexWorkId(doi);
  return new OpenAlexWebMcpVerifier({
    apiKey: "integration-test-key",
    now: () => new Date("2026-08-29T15:00:00.000Z"),
    fetchImpl: async () => Response.json({
      id: `https://openalex.org/${workId}`,
      ids: {
        openalex: `https://openalex.org/${workId}`,
        doi: `https://doi.org/${doi}`,
      },
      doi: `https://doi.org/${doi}`,
      title: "Verified research systems",
      publication_year: 2026,
      publication_date: "2026-04-03",
      type: "article",
      language: "en",
      authorships: [{ author: { display_name: "Ada Evidence" } }],
      primary_location: { source: { display_name: "Trusted Systems Journal" } },
      cited_by_count: 73,
      abstract_inverted_index: { Independent: [0], provider: [1], metadata: [2] },
      is_retracted: false,
      updated_date: "2026-08-20T00:00:00.000Z",
      ...overrides,
    }),
  });
}

const preparedApprovalBindings = new Map<
  string,
  { challengeId: string; evidenceDigest: string }
>();

/**
 * Migrate the pre-cutover test vocabulary through the real two-step boundary.
 * Individual tests can keep describing their review intent while provider
 * failures now happen during preparation and final consent remains I/O-free.
 */
async function approveWebMcpProposal(
  user: Parameters<typeof finalizeWebMcpProposal>[0],
  workspaceId: string,
  inboxEntryId: string,
  rawCommand: unknown,
  options: Parameters<typeof prepareWebMcpApprovalChallenge>[4] = {},
) {
  if (!rawCommand || typeof rawCommand !== "object" || Array.isArray(rawCommand)) {
    return finalizeWebMcpProposal(user, workspaceId, inboxEntryId, rawCommand);
  }
  const record = rawCommand as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return finalizeWebMcpProposal(user, workspaceId, inboxEntryId, rawCommand);
  }
  const clientOperationId = String(record.clientOperationId);
  const cacheKey = `${workspaceId}\0${clientOperationId}`;
  let binding = preparedApprovalBindings.get(cacheKey);
  if (!binding) {
    const prepared = await prepareWebMcpApprovalChallenge(
      user,
      workspaceId,
      inboxEntryId,
      {
        schemaVersion: 1,
        expectedVersion: record.expectedVersion,
        inboxEntryId: record.inboxEntryId,
        proposalDigest: record.proposalDigest,
        destinationProjectId: record.destinationProjectId,
        duplicateDecision: record.duplicateDecision,
      },
      options,
    );
    if (!prepared.ok) return prepared;
    binding = {
      challengeId: prepared.data.challenge.challengeId,
      evidenceDigest: prepared.data.challenge.evidence.evidenceDigest,
    };
    preparedApprovalBindings.set(cacheKey, binding);
  }
  return finalizeWebMcpProposal(user, workspaceId, inboxEntryId, {
    schemaVersion: 2,
    clientOperationId,
    expectedVersion: record.expectedVersion,
    inboxEntryId: record.inboxEntryId,
    proposalDigest: record.proposalDigest,
    destinationProjectId: record.destinationProjectId,
    duplicateDecision: record.duplicateDecision,
    challengeId: binding.challengeId,
    evidenceDigest: binding.evidenceDigest,
  });
}

async function cleanup(organizationId: string, paperIds: string[]) {
  await prisma.$transaction(async (transaction) => {
    await transaction.auditEvent.deleteMany({ where: { organizationId } });
    await transaction.idempotencyRecord.deleteMany({ where: { organizationId } });
    await transaction.provenanceRecord.deleteMany({ where: { organizationId } });
    await transaction.webMcpProposalApproval.deleteMany({ where: { organizationId } });
    await transaction.webMcpApprovalChallenge.deleteMany({ where: { organizationId } });
    await transaction.projectPaper.deleteMany({ where: { organizationId } });
    await transaction.inboxEntry.deleteMany({ where: { organizationId } });
    await transaction.workspacePaper.deleteMany({ where: { organizationId } });
    await transaction.retainedAuditPrincipal.deleteMany({ where: { organizationId } });
    await transaction.organization.delete({ where: { id: organizationId } });
  });
  await prisma.paper.deleteMany({ where: { id: { in: paperIds } } });
}

test("digest-bound create-new approval persists provider metadata and immutable human authority", async () => {
  const suffix = randomUUID();
  const doi = `10.5555/${suffix}`;
  const openAlexId = openAlexWorkId(doi);
  const owner = await prisma.user.create({
    data: {
      id: `webmcp-approval-owner-${suffix}`,
      name: "Approval Owner",
      email: `webmcp-approval-owner-${suffix}@example.test`,
    },
  });
  const intruder = await prisma.user.create({
    data: {
      id: `webmcp-approval-intruder-${suffix}`,
      name: "Approval Intruder",
      email: `webmcp-approval-intruder-${suffix}@example.test`,
    },
  });
  let organizationId: string | undefined;
  const paperIds: string[] = [];
  try {
    const bootstrap = await workspaceBootstrap(owner);
    organizationId = bootstrap.workspace.id;
    const retainedOrganizationId = bootstrap.workspace.id;
    await prisma.member.create({
      data: { organizationId, userId: intruder.id, role: "member" },
    });
    const project = await createWorkspaceProject(
      owner,
      organizationId,
      projectCommand(`approval-project-${suffix}`, bootstrap.aggregateVersion),
    );
    assertSuccess(project);
    const staged = await proposeWebMcpWorkspaceImport(
      owner,
      organizationId,
      proposalCommand(suffix, project.aggregateVersion),
    );
    assertSuccess(staged);
    const inboxEntry = staged.data.inboxEntry;
    assert.equal(inboxEntry.sourceKind, "webmcp");
    assert.ok("proposalDigest" in inboxEntry);

    await assert.rejects(
      finalizeWebMcpProposal(owner, organizationId, inboxEntry.id, {
        schemaVersion: 1,
        clientOperationId: `closed-v1-${suffix}`,
        expectedVersion: staged.aggregateVersion,
        inboxEntryId: inboxEntry.id,
        proposalDigest: inboxEntry.proposalDigest,
        destinationProjectId: project.data.project.id,
        duplicateDecision: { kind: "create_new" },
      }),
      (error: unknown) => error instanceof HttpProblem
        && error.status === 409
        && error.code === "webmcp_approval_challenge_required",
    );

    const approved = await approveWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      {
        schemaVersion: 1,
        clientOperationId: `webmcp-approval-${suffix}`,
        expectedVersion: staged.aggregateVersion,
        inboxEntryId: inboxEntry.id,
        proposalDigest: inboxEntry.proposalDigest,
        destinationProjectId: project.data.project.id,
        duplicateDecision: { kind: "create_new" },
      },
      { verifier: verifier(doi) },
    );
    assertSuccess(approved);
    paperIds.push(approved.data.paper.id);
    assert.equal(approved.outcome, "applied");
    assert.equal(approved.data.inboxEntry.status, "ready");
    assert.equal(approved.data.inboxEntry.proposalDigest, inboxEntry.proposalDigest);
    assert.equal(approved.data.paper.title, "Verified research systems");
    assert.equal(approved.data.paper.venue, "Trusted Systems Journal");
    assert.equal(approved.data.paper.abstract, "Independent provider metadata");
    assert.deepEqual(approved.data.approval.verifiedIdentifiers.map(({ scheme, value }) => ({ scheme, value })), [
      { scheme: "doi", value: doi },
      { scheme: "provider", value: `openalex:${openAlexId}` },
    ]);

    const databasePaper = await prisma.paper.findUniqueOrThrow({
      where: { id: approved.data.paper.id },
      include: { identifiers: true },
    });
    assert.deepEqual(databasePaper.identifiers.map(({ type, value }) => ({ type, value })), [
      { type: "DOI", value: doi },
      { type: "OPENALEX", value: openAlexId },
    ]);
    assert.equal(JSON.stringify(databasePaper).includes("9781234567890"), false);
    assert.equal(JSON.stringify(databasePaper).includes("agent-authored"), false);

    const approval = await prisma.webMcpProposalApproval.findUniqueOrThrow({
      where: {
        organizationId_inboxEntryId: {
          organizationId,
          inboxEntryId: inboxEntry.id,
        },
      },
    });
    assert.equal(approval.approvedById, owner.id);
    assert.ok(approval.approvedByPrincipalId);
    assert.equal(approval.approvalCommandSchemaVersion, 2);
    assert.equal(approval.challengeId, approved.data.approval.challengeId);
    assert.equal(approval.proposalDigest, inboxEntry.proposalDigest);
    assert.equal(approval.verificationAuthority, "OPENALEX");
    assert.equal(approval.verificationEvidenceDigest, approved.data.approval.verifiedIdentifiers[0].evidenceDigest);
    assert.equal(approval.verificationEvidenceDigest, approved.data.approval.evidenceDigest);
    const consumedChallenge = await prisma.webMcpApprovalChallenge.findUniqueOrThrow({
      where: { id: approval.challengeId! },
    });
    assert.equal(consumedChallenge.actorUserId, owner.id);
    assert.equal(consumedChallenge.inboxEntryId, inboxEntry.id);
    assert.equal(consumedChallenge.proposalDigest, inboxEntry.proposalDigest);
    assert.equal(consumedChallenge.verificationEvidenceDigest, approval.verificationEvidenceDigest);
    assert.equal(consumedChallenge.consumedAt?.toISOString(), approval.approvedAt.toISOString());

    const provenance = await prisma.provenanceRecord.findMany({
      where: { organizationId, inboxEntryId: inboxEntry.id },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(provenance.map((record) => record.kind), ["WEB_MCP", "METADATA", "IMPORT"]);
    const metadata = provenance.find((record) => record.kind === "METADATA");
    const imported = provenance.find((record) => record.kind === "IMPORT");
    const stagedAuthority = provenance.find((record) => record.kind === "WEB_MCP");
    const storedInboxEntry = await prisma.inboxEntry.findUniqueOrThrow({
      where: { id: inboxEntry.id },
      select: { createdById: true, createdByPrincipalId: true },
    });
    assert.equal(storedInboxEntry.createdById, owner.id);
    assert.equal(storedInboxEntry.createdByPrincipalId, approval.approvedByPrincipalId);
    assert.equal(stagedAuthority?.actorPrincipalId, approval.approvedByPrincipalId);
    assert.equal(metadata?.actorPrincipalId, approval.approvedByPrincipalId);
    assert.equal(imported?.actorPrincipalId, approval.approvedByPrincipalId);
    const retainedPrincipal = await prisma.retainedAuditPrincipal.findUniqueOrThrow({
      where: { id: approval.approvedByPrincipalId },
    });
    assert.equal(retainedPrincipal.organizationId, organizationId);
    assert.equal(retainedPrincipal.liveUserId, owner.id);
    assert.equal(retainedPrincipal.pseudonymizedAt, null);
    assert.equal(metadata?.sourceProvider, "OpenAlex");
    assert.equal(metadata?.sourceRecordId, openAlexId);
    assert.equal(metadata?.payloadDigest, approval.verificationEvidenceDigest);
    assert.equal(JSON.stringify(metadata?.payload).includes("9781234567890"), false);
    assert.equal(imported?.sourceRecordId, approval.id);
    assert.equal((imported?.payload as { approvalId?: unknown })?.approvalId, approval.id);

    const historicalCommand = {
      schemaVersion: 1 as const,
      clientOperationId: `historical-v1-${suffix}`,
      expectedVersion: staged.aggregateVersion,
      inboxEntryId: inboxEntry.id,
      proposalDigest: inboxEntry.proposalDigest,
      destinationProjectId: project.data.project.id,
      duplicateDecision: { kind: "create_new" as const },
    };
    await prisma.idempotencyRecord.create({
      data: {
        organizationId,
        actorUserId: owner.id,
        key: historicalCommand.clientOperationId,
        command: "approveWebMcpProposal",
        requestHash: webMcpVerificationEvidenceDigest({
          command: "approveWebMcpProposal",
          payload: historicalCommand,
        }),
        response: approved as unknown as Prisma.InputJsonValue,
        status: "COMPLETED",
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const historicalReplay = await finalizeWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      historicalCommand,
    );
    assertSuccess(historicalReplay);
    assert.equal(historicalReplay.outcome, "replayed");
    assert.equal(historicalReplay.data.approval.id, approval.id);

    const unrelatedMutation = await createWorkspaceProject(
      owner,
      organizationId,
      projectCommand(`unrelated-project-${suffix}`, approved.aggregateVersion),
    );
    assertSuccess(unrelatedMutation);
    assert.equal(unrelatedMutation.aggregateVersion, approved.aggregateVersion + 1);

    const replay = await approveWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      {
        schemaVersion: 1,
        clientOperationId: `webmcp-approval-${suffix}`,
        expectedVersion: staged.aggregateVersion,
        inboxEntryId: inboxEntry.id,
        proposalDigest: inboxEntry.proposalDigest,
        destinationProjectId: project.data.project.id,
        duplicateDecision: { kind: "create_new" },
      },
      { verifier: { verify: async () => { throw new Error("replay must not call provider"); } } },
    );
    assertSuccess(replay);
    assert.equal(replay.outcome, "replayed");
    assert.equal(replay.aggregateVersion, approved.aggregateVersion);
    assert.equal(replay.data.approval.id, approval.id);

    const changedIntent = await approveWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      {
        schemaVersion: 1,
        clientOperationId: `webmcp-approval-${suffix}`,
        expectedVersion: staged.aggregateVersion,
        inboxEntryId: inboxEntry.id,
        proposalDigest: inboxEntry.proposalDigest,
        destinationProjectId: project.data.project.id,
        duplicateDecision: { kind: "use_existing", canonicalPaperId: approved.data.paper.id },
      },
    );
    assert.equal(changedIntent.ok, false);
    if (!changedIntent.ok) assert.equal(changedIntent.code, "idempotency_conflict");

    await assert.rejects(
      prisma.webMcpProposalApproval.update({
        where: { id: approval.id },
        data: { verificationAuthorityVersion: "rewritten" },
      }),
      /immutable|WebMCP/i,
    );
    await assert.rejects(
      prisma.retainedAuditPrincipal.update({
        where: { id: retainedPrincipal.id },
        data: { liveUserId: intruder.id },
      }),
      /cannot be rebound|immutable|retained audit principal/i,
    );
    // The expand phase dual-writes a pseudonymizable principal but deliberately
    // retains legacy live-user authority. Account deletion stays blocked until
    // the verified backfill/contract deployment removes all three legacy FKs.
    await assert.rejects(
      prisma.user.delete({ where: { id: owner.id } }),
      /foreign key|constraint|WebMCP/i,
    );
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.webMcpProposalApproval.delete({ where: { id: approval.id } });
        await transaction.webMcpProposalApproval.create({
          data: {
            organizationId: retainedOrganizationId,
            inboxEntryId: approval.inboxEntryId,
            destinationProjectId: approval.destinationProjectId,
            approvedById: approval.approvedById,
            approvedByPrincipalId: approval.approvedByPrincipalId,
            approvalCommandSchemaVersion: approval.approvalCommandSchemaVersion,
            challengeId: approval.challengeId,
            proposalDigest: approval.proposalDigest,
            decision: approval.decision,
            selectedCanonicalPaperId: approval.selectedCanonicalPaperId,
            canonicalPaperId: approval.canonicalPaperId,
            workspacePaperId: approval.workspacePaperId,
            verificationAuthority: approval.verificationAuthority,
            verificationAuthorityVersion: approval.verificationAuthorityVersion,
            verificationEvidenceDigest: approval.verificationEvidenceDigest,
            verifiedSnapshot: approval.verifiedSnapshot as Prisma.InputJsonValue,
            clientOperationId: `replacement-${suffix}`,
            approvedAt: approval.approvedAt,
          },
        });
        await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      }),
      /cannot lose its approval authority|WebMCP/i,
    );
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.webMcpProposalApproval.delete({ where: { id: approval.id } });
        await transaction.webMcpProposalApproval.create({
          data: {
            organizationId: retainedOrganizationId,
            inboxEntryId: approval.inboxEntryId,
            destinationProjectId: approval.destinationProjectId,
            approvedById: approval.approvedById,
            approvedByPrincipalId: approval.approvedByPrincipalId,
            approvalCommandSchemaVersion: approval.approvalCommandSchemaVersion,
            challengeId: approval.challengeId,
            proposalDigest: approval.proposalDigest,
            decision: approval.decision,
            selectedCanonicalPaperId: approval.selectedCanonicalPaperId,
            canonicalPaperId: approval.canonicalPaperId,
            workspacePaperId: approval.workspacePaperId,
            verificationAuthority: approval.verificationAuthority,
            verificationAuthorityVersion: approval.verificationAuthorityVersion,
            verificationEvidenceDigest: approval.verificationEvidenceDigest,
            verifiedSnapshot: {},
            clientOperationId: `empty-snapshot-${suffix}`,
            approvedAt: approval.approvedAt,
          },
        });
      }),
      /snapshot_shape_check|check constraint|closed verified identifier set|OpenAlex authority|exactly match its consumed review challenge/i,
    );
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.webMcpProposalApproval.delete({ where: { id: approval.id } });
        await transaction.webMcpProposalApproval.create({
          data: {
            organizationId: retainedOrganizationId,
            inboxEntryId: approval.inboxEntryId,
            destinationProjectId: approval.destinationProjectId,
            approvedById: intruder.id,
            approvedByPrincipalId: approval.approvedByPrincipalId,
            approvalCommandSchemaVersion: approval.approvalCommandSchemaVersion,
            challengeId: approval.challengeId,
            proposalDigest: approval.proposalDigest,
            decision: approval.decision,
            selectedCanonicalPaperId: approval.selectedCanonicalPaperId,
            canonicalPaperId: approval.canonicalPaperId,
            workspacePaperId: approval.workspacePaperId,
            verificationAuthority: approval.verificationAuthority,
            verificationAuthorityVersion: approval.verificationAuthorityVersion,
            verificationEvidenceDigest: approval.verificationEvidenceDigest,
            verifiedSnapshot: approval.verifiedSnapshot as Prisma.InputJsonValue,
            clientOperationId: `private-mismatch-${suffix}`,
            approvedAt: approval.approvedAt,
          },
        });
      }),
      /promoted inbox target|challenge|WebMCP/i,
    );
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`
          CREATE TEMP TABLE "Project" (
            "organizationId" text,
            "id" text,
            "visibility" text,
            "createdById" text
          ) ON COMMIT DROP
        `);
        await transaction.$executeRaw`
          INSERT INTO "Project" ("organizationId", "id", "visibility", "createdById")
          VALUES (${retainedOrganizationId}, ${approval.destinationProjectId}, 'WORKSPACE', ${intruder.id})
        `;
        await transaction.webMcpProposalApproval.delete({ where: { id: approval.id } });
        await transaction.webMcpProposalApproval.create({
          data: {
            organizationId: retainedOrganizationId,
            inboxEntryId: approval.inboxEntryId,
            destinationProjectId: approval.destinationProjectId,
            approvedById: intruder.id,
            approvedByPrincipalId: approval.approvedByPrincipalId,
            approvalCommandSchemaVersion: approval.approvalCommandSchemaVersion,
            challengeId: approval.challengeId,
            proposalDigest: approval.proposalDigest,
            decision: approval.decision,
            selectedCanonicalPaperId: approval.selectedCanonicalPaperId,
            canonicalPaperId: approval.canonicalPaperId,
            workspacePaperId: approval.workspacePaperId,
            verificationAuthority: approval.verificationAuthority,
            verificationAuthorityVersion: approval.verificationAuthorityVersion,
            verificationEvidenceDigest: approval.verificationEvidenceDigest,
            verifiedSnapshot: approval.verifiedSnapshot as Prisma.InputJsonValue,
            clientOperationId: `temp-shadow-${suffix}`,
            approvedAt: approval.approvedAt,
          },
        });
      }),
      /promoted inbox target|challenge|WebMCP/i,
    );
    const storedInbox = await prisma.inboxEntry.findUniqueOrThrow({ where: { id: inboxEntry.id } });
    await assert.rejects(
      prisma.inboxEntry.update({
        where: { id: inboxEntry.id, organizationId },
        data: { payload: { forged: true } },
      }),
      /proposal identity|WebMCP/i,
    );
    const forgedDocument = await prisma.document.create({
      data: {
        organizationId: retainedOrganizationId,
        kind: "PAPER_PDF",
        status: "PENDING",
        title: "Forged custody attachment",
      },
    });
    await assert.rejects(
      prisma.inboxEntry.update({
        where: { id: inboxEntry.id, organizationId },
        data: { documentId: forgedDocument.id },
      }),
      /proposal identity|WebMCP/i,
    );
    await assert.rejects(
      prisma.provenanceRecord.create({
        data: {
          organizationId: retainedOrganizationId,
          kind: "SYSTEM",
          inboxEntryId: inboxEntry.id,
          documentId: forgedDocument.id,
          actorUserId: owner.id,
          sourceProvider: "Forged custody assertion",
        },
      }),
      /cannot assert document custody|metadata.only|WebMCP/i,
    );
    const projectPaper = await prisma.projectPaper.findFirstOrThrow({
      where: {
        organizationId,
        projectId: project.data.project.id,
        workspacePaper: { paperId: approved.data.paper.id },
      },
    });
    if (supportsConcurrentDatabaseConnections()) {
      let markLockHeld!: () => void;
      let releaseLock!: () => void;
      const lockHeld = new Promise<void>((resolve) => { markLockHeld = resolve; });
      const release = new Promise<void>((resolve) => { releaseLock = resolve; });
      const lockHolder = prisma.$transaction(async (transaction) => {
        await transaction.$queryRawUnsafe(
          'SELECT "public"."WebMcpPaper_integrity_lock"($1)::text AS "locked"',
          approved.data.paper.id,
        );
        markLockHeld();
        await release;
      });
      await lockHeld;
      try {
        await assert.rejects(
          prisma.$transaction(async (transaction) => {
            await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '150ms'");
            await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '300ms'");
            await transaction.projectPaper.delete({ where: { id: projectPaper.id } });
          }),
          /lock timeout|statement timeout|canceling statement/i,
        );
      } finally {
        releaseLock();
        await lockHolder;
      }
    }
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.projectPaper.delete({ where: { id: projectPaper.id } });
        await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      }),
      /exact project edge|WebMCP/i,
    );
    const stagedProvenance = provenance.find((record) => record.kind === "WEB_MCP");
    assert.ok(stagedProvenance);
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.provenanceRecord.delete({ where: { id: stagedProvenance.id } });
        await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      }),
      /staged provenance|WebMCP/i,
    );
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.provenanceRecord.delete({ where: { id: stagedProvenance.id } });
        await transaction.provenanceRecord.create({
          data: {
            organizationId: retainedOrganizationId,
            kind: "WEB_MCP",
            paperId: stagedProvenance.paperId,
            workspacePaperId: stagedProvenance.workspacePaperId,
            inboxEntryId: stagedProvenance.inboxEntryId,
            evidenceNoteId: stagedProvenance.evidenceNoteId,
            documentId: stagedProvenance.documentId,
            zoteroObjectId: stagedProvenance.zoteroObjectId,
            integrationConnectionId: stagedProvenance.integrationConnectionId,
            actorUserId: stagedProvenance.actorUserId,
            supersedesId: stagedProvenance.supersedesId,
            sourceProvider: stagedProvenance.sourceProvider,
            sourceRecordId: stagedProvenance.sourceRecordId,
            sourceUri: stagedProvenance.sourceUri,
            retrievedAt: stagedProvenance.retrievedAt,
            payloadDigest: stagedProvenance.payloadDigest,
            payload: stagedProvenance.payload === null
              ? Prisma.JsonNull
              : stagedProvenance.payload as Prisma.InputJsonValue,
          },
        });
        await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      }),
      /staged provenance|WebMCP/i,
    );
    assert.ok(metadata);
    assert.ok(imported);
    for (const approvalProvenance of [metadata, imported]) {
      await assert.rejects(
        prisma.provenanceRecord.update({
          where: { id: approvalProvenance.id },
          data: { sourceProvider: "Forged replacement authority" },
        }),
        /authority provenance|immutable|WebMCP/i,
      );
      await assert.rejects(
        prisma.$transaction(async (transaction) => {
          await transaction.provenanceRecord.delete({ where: { id: approvalProvenance.id } });
          await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
        }),
        /approval provenance|WebMCP/i,
      );
    }
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.provenanceRecord.delete({ where: { id: imported.id } });
        await transaction.provenanceRecord.create({
          data: {
            organizationId: retainedOrganizationId,
            kind: imported.kind,
            paperId: imported.paperId,
            workspacePaperId: imported.workspacePaperId,
            inboxEntryId: imported.inboxEntryId,
            evidenceNoteId: imported.evidenceNoteId,
            documentId: imported.documentId,
            zoteroObjectId: imported.zoteroObjectId,
            integrationConnectionId: imported.integrationConnectionId,
            actorUserId: imported.actorUserId,
            supersedesId: imported.supersedesId,
            sourceProvider: imported.sourceProvider,
            sourceRecordId: imported.sourceRecordId,
            sourceUri: imported.sourceUri,
            retrievedAt: imported.retrievedAt,
            payloadDigest: imported.payloadDigest,
            payload: imported.payload === null
              ? Prisma.JsonNull
              : imported.payload as Prisma.InputJsonValue,
          },
        });
        await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      }),
      /approval provenance|WebMCP/i,
    );
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.provenanceRecord.create({
          data: {
            organizationId: retainedOrganizationId,
            kind: "IMPORT",
            paperId: approval.canonicalPaperId,
            workspacePaperId: approval.workspacePaperId,
            inboxEntryId: approval.inboxEntryId,
            actorUserId: approval.approvedById,
            sourceProvider: "Forged alternate WebMCP import",
            sourceRecordId: `forged-import-${suffix}`,
            payloadDigest: "0".repeat(64),
            payload: { forged: true },
          },
        });
        await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      }),
      /exact retained IMPORT and METADATA|approved WebMCP|reviewer retained principal/i,
    );
    assert.deepEqual(
      (await prisma.inboxEntry.findUniqueOrThrow({ where: { id: inboxEntry.id } })).payload,
      storedInbox.payload,
    );
    await assert.rejects(
      prisma.provenanceRecord.create({
        data: {
          organizationId,
          kind: "WEB_MCP",
          inboxEntryId: inboxEntry.id,
          actorUserId: owner.id,
          payloadDigest: inboxEntry.proposalDigest,
          payload: (provenance[0].payload ?? {}) as never,
        },
      }),
    );
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.paperIdentifier.create({
          data: {
            paperId: approved.data.paper.id,
            type: "ISBN",
            value: "9781234567890",
            normalizedValue: "9781234567890",
            source: "WEB_MCP",
          },
        });
        await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      }),
      /exact verified canonical identifiers|WebMCP/i,
    );
    assert.equal(await prisma.paperIdentifier.count({
      where: { paperId: approved.data.paper.id },
    }), 2);
    const driftPaper = await prisma.paper.create({ data: { title: "Drift target" } });
    paperIds.push(driftPaper.id);
    const workspacePaper = await prisma.workspacePaper.findUniqueOrThrow({
      where: {
        organizationId_paperId: {
          organizationId,
          paperId: approved.data.paper.id,
        },
      },
    });
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.workspacePaper.update({
          where: { id: workspacePaper.id },
          data: { paperId: driftPaper.id },
        });
        await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      }),
      /canonical workspace paper|WebMCP/i,
    );
  } finally {
    if (organizationId) await cleanup(organizationId, paperIds);
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, intruder.id] } } });
  }
});

test("use-existing accepts only the exact staged duplicate and never appends proposal identifiers", async () => {
  const suffix = randomUUID();
  const doi = `10.5555/existing-${suffix}`;
  const owner = await prisma.user.create({
    data: {
      id: `webmcp-existing-owner-${suffix}`,
      name: "Existing Owner",
      email: `webmcp-existing-owner-${suffix}@example.test`,
    },
  });
  const canonical = await prisma.paper.create({
    data: {
      title: "Verified research systems",
      primarySource: "CROSSREF",
      identifiers: {
        create: { type: "DOI", value: doi, normalizedValue: doi, source: "CROSSREF" },
      },
      authors: { create: { position: 0, displayName: "Ada Evidence" } },
    },
  });
  let organizationId: string | undefined;
  try {
    const bootstrap = await workspaceBootstrap(owner);
    organizationId = bootstrap.workspace.id;
    const project = await createWorkspaceProject(
      owner,
      organizationId,
      projectCommand(`existing-project-${suffix}`, bootstrap.aggregateVersion),
    );
    assertSuccess(project);
    const staged = await proposeWebMcpWorkspaceImport(
      owner,
      organizationId,
      proposalCommand(`existing-${suffix}`, project.aggregateVersion, {
        identifiers: [
          { scheme: "doi", value: doi },
          { scheme: "isbn", value: "9781234567890" },
        ],
      }),
    );
    assertSuccess(staged);
    const inboxEntry = staged.data.inboxEntry;
    assert.equal(inboxEntry.duplicateOfPaperId, canonical.id);
    assert.ok("proposalDigest" in inboxEntry);
    assert.equal("duplicateCandidate" in inboxEntry && inboxEntry.duplicateCandidate?.id, canonical.id);

    const createNew = await approveWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      {
        schemaVersion: 1,
        clientOperationId: `wrong-create-${suffix}`,
        expectedVersion: staged.aggregateVersion,
        inboxEntryId: inboxEntry.id,
        proposalDigest: inboxEntry.proposalDigest,
        destinationProjectId: project.data.project.id,
        duplicateDecision: { kind: "create_new" },
      },
      { verifier: { verify: async () => { throw new Error("duplicate must fail before provider I/O"); } } },
    );
    assert.equal(createNew.ok, false);
    if (!createNew.ok) assert.equal(createNew.code, "duplicate");

    const wrongExisting = await approveWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      {
        schemaVersion: 1,
        clientOperationId: `wrong-existing-${suffix}`,
        expectedVersion: staged.aggregateVersion,
        inboxEntryId: inboxEntry.id,
        proposalDigest: inboxEntry.proposalDigest,
        destinationProjectId: project.data.project.id,
        duplicateDecision: { kind: "use_existing", canonicalPaperId: "paper-not-staged" },
      },
    );
    assert.equal(wrongExisting.ok, false);
    if (!wrongExisting.ok) assert.equal(wrongExisting.code, "not_found");

    const approved = await approveWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      {
        schemaVersion: 1,
        clientOperationId: `right-existing-${suffix}`,
        expectedVersion: staged.aggregateVersion,
        inboxEntryId: inboxEntry.id,
        proposalDigest: inboxEntry.proposalDigest,
        destinationProjectId: project.data.project.id,
        duplicateDecision: { kind: "use_existing", canonicalPaperId: canonical.id },
      },
      { verifier: { verify: async () => { throw new Error("use-existing must not call provider"); } } },
    );
    assertSuccess(approved);
    assert.equal(approved.data.paper.id, canonical.id);
    assert.equal(approved.data.usedExistingPaper, true);
    assert.equal(approved.data.inboxEntry.duplicateOfPaperId, canonical.id);
    assert.equal(
      approved.data.inboxEntry.duplicateCandidate?.id,
      canonical.id,
    );
    assert.deepEqual(approved.data.approval.verifiedIdentifiers, []);
    assert.equal(await prisma.paperIdentifier.count({ where: { paperId: canonical.id } }), 1);
    assert.equal(await prisma.workspacePaper.count({
      where: { organizationId, paperId: canonical.id },
    }), 1);
    const storedApproval = await prisma.webMcpProposalApproval.findFirstOrThrow({
      where: { organizationId, inboxEntryId: inboxEntry.id },
    });
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.webMcpProposalApproval.delete({
          where: { id: storedApproval.id },
        });
        await transaction.webMcpProposalApproval.create({
          data: {
            organizationId: storedApproval.organizationId,
            inboxEntryId: storedApproval.inboxEntryId,
            destinationProjectId: storedApproval.destinationProjectId,
            approvedById: storedApproval.approvedById,
            approvedByPrincipalId: storedApproval.approvedByPrincipalId,
            approvalCommandSchemaVersion: storedApproval.approvalCommandSchemaVersion,
            challengeId: storedApproval.challengeId,
            proposalDigest: storedApproval.proposalDigest,
            decision: "USE_EXISTING",
            selectedCanonicalPaperId: null,
            canonicalPaperId: storedApproval.canonicalPaperId,
            workspacePaperId: storedApproval.workspacePaperId,
            verificationAuthority: storedApproval.verificationAuthority,
            verificationAuthorityVersion: storedApproval.verificationAuthorityVersion,
            verificationEvidenceDigest: storedApproval.verificationEvidenceDigest,
            verifiedSnapshot: storedApproval.verifiedSnapshot as Prisma.InputJsonValue,
            clientOperationId: `null-existing-selection-${suffix}`,
            approvedAt: storedApproval.approvedAt,
          },
        });
      }),
      /decision_check|existing selection|server-staged duplicate|WebMCP/i,
    );
  } finally {
    if (organizationId) await cleanup(organizationId, [canonical.id]);
    else await prisma.paper.delete({ where: { id: canonical.id } });
    await prisma.user.deleteMany({ where: { id: owner.id } });
  }
});

test("approval rechecks digest, version, role, project visibility, and deferred database authority", async () => {
  const suffix = randomUUID();
  const owner = await prisma.user.create({
    data: {
      id: `webmcp-guard-owner-${suffix}`,
      name: "Guard Owner",
      email: `webmcp-guard-owner-${suffix}@example.test`,
    },
  });
  const member = await prisma.user.create({
    data: {
      id: `webmcp-guard-member-${suffix}`,
      name: "Guard Member",
      email: `webmcp-guard-member-${suffix}@example.test`,
    },
  });
  const viewer = await prisma.user.create({
    data: {
      id: `webmcp-guard-viewer-${suffix}`,
      name: "Guard Viewer",
      email: `webmcp-guard-viewer-${suffix}@example.test`,
    },
  });
  let organizationId: string | undefined;
  const paperIds: string[] = [];
  try {
    const bootstrap = await workspaceBootstrap(owner);
    organizationId = bootstrap.workspace.id;
    const project = await createWorkspaceProject(
      owner,
      organizationId,
      projectCommand(`guard-project-${suffix}`, bootstrap.aggregateVersion),
    );
    assertSuccess(project);
    await prisma.member.createMany({
      data: [
        { organizationId, userId: member.id, role: "member" },
        { organizationId, userId: viewer.id, role: "viewer" },
      ],
    });
    const staged = await proposeWebMcpWorkspaceImport(
      owner,
      organizationId,
      proposalCommand(`guard-${suffix}`, project.aggregateVersion, { identifiers: [] }),
    );
    assertSuccess(staged);
    const inboxEntry = staged.data.inboxEntry;
    assert.ok("proposalDigest" in inboxEntry);
    const base = {
      schemaVersion: 1,
      clientOperationId: `guard-approval-${suffix}`,
      expectedVersion: staged.aggregateVersion,
      inboxEntryId: inboxEntry.id,
      proposalDigest: inboxEntry.proposalDigest,
      destinationProjectId: project.data.project.id,
      duplicateDecision: { kind: "create_new" as const },
    };

    let verifierCalls = 0;
    const digestDrift = await approveWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      { ...base, proposalDigest: "0".repeat(64) },
      { verifier: { verify: async () => { verifierCalls += 1; throw new Error("must not verify"); } } },
    );
    assert.equal(digestDrift.ok, false);
    if (!digestDrift.ok) assert.equal(digestDrift.code, "validation");
    assert.equal(verifierCalls, 0);

    const stale = await approveWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      { ...base, clientOperationId: `stale-${suffix}`, expectedVersion: 1 },
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "version_conflict");

    const hiddenProject = await approveWebMcpProposal(
      member,
      organizationId,
      inboxEntry.id,
      { ...base, clientOperationId: `hidden-${suffix}` },
    );
    assert.equal(hiddenProject.ok, false);
    if (!hiddenProject.ok) assert.equal(hiddenProject.code, "not_found");

    await assert.rejects(
      approveWebMcpProposal(
        viewer,
        organizationId,
        inboxEntry.id,
        { ...base, clientOperationId: `viewer-${suffix}` },
      ),
      /workspace role cannot make changes/i,
    );
    assert.equal((await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { revision: true },
    })).revision, staged.aggregateVersion);

    const stagedAuthority = await prisma.provenanceRecord.findFirstOrThrow({
      where: {
        organizationId,
        inboxEntryId: inboxEntry.id,
        kind: "WEB_MCP",
      },
    });
    const preApprovalForgedPaperId = `preapproval-forged-${suffix}`;
    paperIds.push(preApprovalForgedPaperId);
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.paper.create({
          data: { id: preApprovalForgedPaperId, title: "Forged staged duplicate target" },
        });
        await transaction.provenanceRecord.delete({ where: { id: stagedAuthority.id } });
        await transaction.provenanceRecord.create({
          data: {
            organizationId: stagedAuthority.organizationId,
            kind: "WEB_MCP",
            paperId: preApprovalForgedPaperId,
            workspacePaperId: stagedAuthority.workspacePaperId,
            inboxEntryId: stagedAuthority.inboxEntryId,
            evidenceNoteId: stagedAuthority.evidenceNoteId,
            documentId: stagedAuthority.documentId,
            zoteroObjectId: stagedAuthority.zoteroObjectId,
            integrationConnectionId: stagedAuthority.integrationConnectionId,
            actorUserId: stagedAuthority.actorUserId,
            supersedesId: stagedAuthority.supersedesId,
            sourceProvider: stagedAuthority.sourceProvider,
            sourceRecordId: stagedAuthority.sourceRecordId,
            sourceUri: stagedAuthority.sourceUri,
            retrievedAt: stagedAuthority.retrievedAt,
            payloadDigest: stagedAuthority.payloadDigest,
            payload: stagedAuthority.payload === null
              ? Prisma.JsonNull
              : stagedAuthority.payload as Prisma.InputJsonValue,
          },
        });
        await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      }),
      /exact staged provenance|WebMCP/i,
    );
    assert.equal(await prisma.paper.count({ where: { id: preApprovalForgedPaperId } }), 0);

    const preApprovalJunk = await prisma.provenanceRecord.create({
      data: {
        organizationId: stagedAuthority.organizationId,
        kind: "IMPORT",
        inboxEntryId: inboxEntry.id,
        actorUserId: owner.id,
        sourceProvider: "Forged preapproval import",
        sourceRecordId: `forged-preapproval-import-${suffix}`,
        payloadDigest: "0".repeat(64),
        payload: { forged: true },
      },
    });
    await assert.rejects(
      approveWebMcpProposal(owner, organizationId, inboxEntry.id, base),
      /unexpected IMPORT or METADATA|WebMCP approval/i,
    );
    assert.equal(await prisma.webMcpProposalApproval.count({
      where: { organizationId, inboxEntryId: inboxEntry.id },
    }), 0);
    await prisma.provenanceRecord.delete({ where: { id: preApprovalJunk.id } });

    const preparedBinding = preparedApprovalBindings.get(
      `${organizationId}\0${base.clientOperationId}`,
    );
    assert.ok(preparedBinding);
    const tamperedEvidence = await finalizeWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      {
        ...base,
        schemaVersion: 2,
        challengeId: preparedBinding.challengeId,
        evidenceDigest: "0".repeat(64),
      },
    );
    assert.equal(tamperedEvidence.ok, false);
    if (!tamperedEvidence.ok) assert.equal(tamperedEvidence.code, "validation");
    assert.equal((await prisma.webMcpApprovalChallenge.findUniqueOrThrow({
      where: { id: preparedBinding.challengeId },
      select: { consumedAt: true },
    })).consumedAt, null);

    const approved = await approveWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      base,
    );
    assertSuccess(approved);
    paperIds.push(approved.data.paper.id);
    assert.equal(approved.data.approval.verifiedIdentifiers.length, 0);
    assert.equal(await prisma.paperIdentifier.count({ where: { paperId: approved.data.paper.id } }), 0);
    const humanApproval = await prisma.webMcpProposalApproval.findFirstOrThrow({
      where: { organizationId, inboxEntryId: inboxEntry.id },
    });
    assert.equal(humanApproval.verificationAuthority, "HUMAN_REVIEW");
    const reusedChallenge = await finalizeWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      {
        ...base,
        schemaVersion: 2,
        clientOperationId: `reuse-consumed-${suffix}`,
        challengeId: preparedBinding.challengeId,
        evidenceDigest: preparedBinding.evidenceDigest,
      },
    );
    assert.equal(reusedChallenge.ok, false);
    if (!reusedChallenge.ok) assert.equal(reusedChallenge.code, "version_conflict");
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.provenanceRecord.create({
          data: {
            organizationId: humanApproval.organizationId,
            kind: "METADATA",
            paperId: humanApproval.canonicalPaperId,
            workspacePaperId: humanApproval.workspacePaperId,
            inboxEntryId: humanApproval.inboxEntryId,
            actorUserId: humanApproval.approvedById,
            sourceProvider: "OpenAlex",
            sourceRecordId: "W9999999999",
            sourceUri: "https://openalex.org/W9999999999",
            retrievedAt: new Date("2026-08-29T15:00:00.000Z"),
            payloadDigest: "0".repeat(64),
            payload: { forged: true },
          },
        });
        await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      }),
      /exact retained IMPORT and METADATA|approved WebMCP|reviewer retained principal/i,
    );
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await transaction.paperIdentifier.create({
          data: {
            paperId: approved.data.paper.id,
            type: "DOI",
            value: `10.5555/late-identifier-${suffix}`,
            normalizedValue: `10.5555/late-identifier-${suffix}`,
            source: "WEB_MCP",
          },
        });
        await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      }),
      /cannot gain a canonical identifier|WebMCP/i,
    );
    assert.equal(await prisma.paperIdentifier.count({
      where: { paperId: approved.data.paper.id },
    }), 0);

    const unapprovedStage = await proposeWebMcpWorkspaceImport(
      owner,
      organizationId,
      proposalCommand(`unguarded-${suffix}`, approved.aggregateVersion, {
        identifiers: [],
        sourceSuffix: `unguarded-${suffix}`,
      }),
    );
    assertSuccess(unapprovedStage);
    const unapprovedPaperId = `unguarded-paper-${suffix}`;
    paperIds.push(unapprovedPaperId);
    const retainedOrganizationId = organizationId;
    assert.ok(retainedOrganizationId);
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        const paper = await transaction.paper.create({
          data: { id: unapprovedPaperId, title: "Unapproved direct SQL target" },
        });
        const workspacePaper = await transaction.workspacePaper.create({
          data: {
            organizationId: retainedOrganizationId,
            paperId: paper.id,
            status: "SAVED",
            addedById: owner.id,
          },
        });
        await transaction.projectPaper.create({
          data: {
            organizationId: retainedOrganizationId,
            projectId: project.data.project.id,
            workspacePaperId: workspacePaper.id,
            addedById: owner.id,
          },
        });
        await transaction.inboxEntry.update({
          where: {
            id: unapprovedStage.data.inboxEntry.id,
            organizationId: retainedOrganizationId,
          },
          data: {
            status: "IMPORTED",
            projectId: project.data.project.id,
            workspacePaperId: workspacePaper.id,
            resolvedAt: new Date(),
          },
        });
        await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      }),
      /exactly one matching approval authority|WebMCP/i,
    );
    assert.equal(await prisma.paper.count({ where: { id: unapprovedPaperId } }), 0);
  } finally {
    if (organizationId) await cleanup(organizationId, paperIds);
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, member.id, viewer.id] } } });
  }
});

test("forged, mismatched, and unsupported verifier paths cannot create canonical state", async () => {
  const suffix = randomUUID();
  const doi = `10.5555/failclosed-${suffix}`;
  const openAlexId = openAlexWorkId(doi);
  const owner = await prisma.user.create({
    data: {
      id: `webmcp-failclosed-owner-${suffix}`,
      name: "Fail Closed Owner",
      email: `webmcp-failclosed-owner-${suffix}@example.test`,
    },
  });
  let organizationId: string | undefined;
  const paperIds: string[] = [];
  try {
    const bootstrap = await workspaceBootstrap(owner);
    organizationId = bootstrap.workspace.id;
    const project = await createWorkspaceProject(
      owner,
      organizationId,
      projectCommand(`failclosed-project-${suffix}`, bootstrap.aggregateVersion),
    );
    assertSuccess(project);
    const staged = await proposeWebMcpWorkspaceImport(
      owner,
      organizationId,
      proposalCommand(`failclosed-${suffix}`, project.aggregateVersion, {
        identifiers: [{ scheme: "doi", value: doi }],
      }),
    );
    assertSuccess(staged);
    const inboxEntry = staged.data.inboxEntry;
    assert.ok("proposalDigest" in inboxEntry);
    const approvalCommand = {
      schemaVersion: 1 as const,
      clientOperationId: `failclosed-approval-${suffix}`,
      expectedVersion: staged.aggregateVersion,
      inboxEntryId: inboxEntry.id,
      proposalDigest: inboxEntry.proposalDigest,
      destinationProjectId: project.data.project.id,
      duplicateDecision: { kind: "create_new" as const },
    };

    const mismatched = await approveWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      approvalCommand,
      { verifier: verifier(doi, { title: "Unrelated chemical assay" }) },
    );
    assert.equal(mismatched.ok, false);
    if (!mismatched.ok) assert.equal(mismatched.code, "validation");

    const delegate = verifier(doi);
    const forged = await approveWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      { ...approvalCommand, clientOperationId: `forged-${suffix}` },
      {
        verifier: {
          verify: async (snapshot) => {
            const result = await delegate.verify(snapshot);
            assert.equal(result.ok, true);
            if (!result.ok) return result;
            return {
              ok: true,
              verified: { ...result.verified, agentInjected: true },
            } as never;
          },
        },
      },
    );
    assert.equal(forged.ok, false);
    if (!forged.ok) assert.equal(forged.code, "validation");
    assert.equal(await prisma.paper.count({
      where: { identifiers: { some: { type: "DOI", normalizedValue: doi } } },
    }), 0);
    assert.equal(await prisma.workspacePaper.count({ where: { organizationId } }), 0);
    assert.equal(await prisma.webMcpProposalApproval.count({ where: { organizationId } }), 0);
    assert.equal((await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { revision: true },
    })).revision, staged.aggregateVersion);

    const unsupportedStage = await proposeWebMcpWorkspaceImport(
      owner,
      organizationId,
      proposalCommand(`unsupported-${suffix}`, staged.aggregateVersion, {
        identifiers: [{ scheme: "arxiv", value: "2601.12345" }],
      }),
    );
    assertSuccess(unsupportedStage);
    const unsupportedEntry = unsupportedStage.data.inboxEntry;
    assert.ok("proposalDigest" in unsupportedEntry);
    let fetchCalls = 0;
    const unsupported = await approveWebMcpProposal(
      owner,
      organizationId,
      unsupportedEntry.id,
      {
        schemaVersion: 1,
        clientOperationId: `unsupported-approval-${suffix}`,
        expectedVersion: unsupportedStage.aggregateVersion,
        inboxEntryId: unsupportedEntry.id,
        proposalDigest: unsupportedEntry.proposalDigest,
        destinationProjectId: project.data.project.id,
        duplicateDecision: { kind: "create_new" },
      },
      {
        verifier: new OpenAlexWebMcpVerifier({
          apiKey: "integration-test-key",
          fetchImpl: async () => {
            fetchCalls += 1;
            return Response.json({});
          },
        }),
      },
    );
    assert.equal(unsupported.ok, false);
    if (!unsupported.ok) assert.equal(unsupported.code, "validation");
    assert.equal(fetchCalls, 0);
    assert.equal(await prisma.workspacePaper.count({ where: { organizationId } }), 0);
    assert.equal(await prisma.webMcpProposalApproval.count({ where: { organizationId } }), 0);

    for (const [reason, status, code] of [
      ["provider_unavailable", 503, "openalex_unavailable"],
      ["provider_response_invalid", 502, "openalex_response_invalid"],
      ["not_configured", 503, "openalex_not_configured"],
    ] as const) {
      await assert.rejects(
        approveWebMcpProposal(
          owner,
          organizationId,
          inboxEntry.id,
          {
            ...approvalCommand,
            clientOperationId: `provider-${reason}-${suffix}`,
            expectedVersion: unsupportedStage.aggregateVersion,
          },
          { verifier: { verify: async () => ({ ok: false, reason }) } },
        ),
        (error: unknown) => error instanceof HttpProblem
          && error.status === status
          && error.code === code,
      );
    }
    assert.equal(await prisma.workspacePaper.count({ where: { organizationId } }), 0);
    assert.equal(await prisma.webMcpProposalApproval.count({ where: { organizationId } }), 0);

    // A canonical identifier owner can appear after staging but before review.
    // The command must not silently change CREATE_NEW into USE_EXISTING, and
    // the immutable staged decision cannot select a paper it never disclosed.
    // A future duplicate-refresh workflow is required to make this recoverable.
    const racedCanonical = await prisma.paper.create({
      data: {
        title: "Verified research systems",
        publicationYear: 2026,
        primarySource: "OPENALEX",
        identifiers: {
          create: [
            { type: "DOI", value: doi, normalizedValue: doi, source: "OPENALEX" },
            {
              type: "OPENALEX",
              value: openAlexId,
              normalizedValue: openAlexId.toLowerCase(),
              source: "OPENALEX",
            },
          ],
        },
      },
    });
    paperIds.push(racedCanonical.id);
    const racedCreate = await approveWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      {
        ...approvalCommand,
        clientOperationId: `raced-create-${suffix}`,
        expectedVersion: unsupportedStage.aggregateVersion,
      },
      { verifier: verifier(doi) },
    );
    assert.equal(racedCreate.ok, false);
    if (!racedCreate.ok) assert.equal(racedCreate.code, "duplicate");

    const racedSelection = await approveWebMcpProposal(
      owner,
      organizationId,
      inboxEntry.id,
      {
        ...approvalCommand,
        clientOperationId: `raced-existing-${suffix}`,
        expectedVersion: unsupportedStage.aggregateVersion,
        duplicateDecision: {
          kind: "use_existing",
          canonicalPaperId: racedCanonical.id,
        },
      },
    );
    assert.equal(racedSelection.ok, false);
    if (!racedSelection.ok) assert.equal(racedSelection.code, "not_found");
    assert.equal(await prisma.workspacePaper.count({ where: { organizationId } }), 0);
    assert.equal(await prisma.webMcpProposalApproval.count({ where: { organizationId } }), 0);
    assert.equal((await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { revision: true },
    })).revision, unsupportedStage.aggregateVersion);
  } finally {
    if (organizationId) await cleanup(organizationId, paperIds);
    else await prisma.paper.deleteMany({ where: { id: { in: paperIds } } });
    await prisma.user.deleteMany({ where: { id: owner.id } });
  }
});
