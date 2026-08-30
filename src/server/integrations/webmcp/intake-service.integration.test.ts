import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { CreateProjectCommand, WorkspaceCommandResult } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { createWorkspaceProject, workspaceBootstrap } from "@/server/workspaces/service";
import { fileWorkspaceImport } from "@/server/workspaces/import-service";
import type { WebMcpProposalCommand } from "./intake-contract";
import { proposeWebMcpWorkspaceImport } from "./intake-service";

after(async () => {
  await prisma.$disconnect();
});

function assertSuccess<T>(
  result: WorkspaceCommandResult<T>,
): asserts result is Extract<WorkspaceCommandResult<T>, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

function projectCommand(operationId: string, expectedVersion: number): CreateProjectCommand {
  return {
    clientOperationId: operationId,
    expectedVersion,
    project: {
      name: `WebMCP verification ${operationId.slice(-8)}`,
      question: "Can agent-proposed metadata remain distinct from document custody?",
      description: "A production boundary test for WebMCP metadata intake.",
      type: "literature-review",
      visibility: "private",
    },
  };
}

function proposalCommand(
  suffix: string,
  expectedVersion: number,
  operationId = `webmcp-proposal-${suffix}`,
): WebMcpProposalCommand {
  const doi = `10.5555/webmcp-${suffix}`;
  return {
    schemaVersion: 1,
    clientOperationId: operationId,
    expectedVersion,
    proposal: {
      title: "A custody-safe interface for research agents",
      authors: ["Ada Evidence", "Linus Provenance"],
      year: 2026,
      venue: "Journal of Verifiable Research",
      publicationType: "journal article",
      abstract: "Agent-proposed metadata is reviewed before it becomes workspace state.",
      identifiers: [{ scheme: "doi", value: doi }],
      sourcePageUrl: `https://repository.example.org/papers/${suffix}`,
      candidatePdfUrl: `https://repository.example.org/papers/${suffix}.pdf`,
      isOpenAccess: true,
      license: "CC-BY-4.0",
      version: "published-version",
    },
  };
}

test("WebMCP proposals are tenant-safe, replay-safe, metadata-only, and cannot self-file", async () => {
  const suffix = randomUUID();
  const owner = await prisma.user.create({
    data: {
      id: `webmcp-owner-${suffix}`,
      name: "WebMCP Owner",
      email: `webmcp-owner-${suffix}@example.test`,
    },
  });
  const outsider = await prisma.user.create({
    data: {
      id: `webmcp-outsider-${suffix}`,
      name: "WebMCP Outsider",
      email: `webmcp-outsider-${suffix}@example.test`,
    },
  });
  const viewer = await prisma.user.create({
    data: {
      id: `webmcp-viewer-${suffix}`,
      name: "WebMCP Viewer",
      email: `webmcp-viewer-${suffix}@example.test`,
    },
  });
  let organizationId: string | undefined;

  try {
    const bootstrap = await workspaceBootstrap(owner);
    organizationId = bootstrap.workspace.id;
    const project = await createWorkspaceProject(
      owner,
      organizationId,
      projectCommand(`webmcp-project-${suffix}`, bootstrap.aggregateVersion),
    );
    assertSuccess(project);
    assert.equal(project.aggregateVersion, 1);

    await prisma.member.create({
      data: { organizationId, userId: viewer.id, role: "viewer" },
    });

    const command = proposalCommand(suffix, project.aggregateVersion);
    const staged = await proposeWebMcpWorkspaceImport(owner, organizationId, command);
    assertSuccess(staged);
    assert.equal(staged.outcome, "applied");
    assert.equal(staged.aggregateVersion, 2);
    assert.equal(staged.data.inboxEntry.sourceKind, "webmcp");
    assert.equal(staged.data.inboxEntry.status, "awaiting-review");
    assert.equal(staged.data.inboxEntry.provenance.sourceType, "web-source");
    assert.equal(staged.data.inboxEntry.provenance.accessMethod, "webmcp");
    assert.equal(staged.data.inboxEntry.provenance.providerName, "PaperPilot WebMCP");
    assert.equal(staged.data.inboxEntry.paper.access?.hasFullText, false);
    assert.equal(staged.data.inboxEntry.paper.access?.pdfUrl, command.proposal.candidatePdfUrl);

    const provenance = await prisma.provenanceRecord.findFirstOrThrow({
      where: {
        organizationId,
        inboxEntryId: staged.data.inboxEntry.id,
      },
    });
    assert.equal(provenance.kind, "WEB_MCP");
    assert.equal(provenance.actorUserId, owner.id);
    assert.ok(provenance.actorPrincipalId);
    const storedEntry = await prisma.inboxEntry.findUniqueOrThrow({
      where: { id: staged.data.inboxEntry.id },
      select: { createdByPrincipalId: true },
    });
    assert.equal(storedEntry.createdByPrincipalId, provenance.actorPrincipalId);
    const retainedPrincipal = await prisma.retainedAuditPrincipal.findUniqueOrThrow({
      where: { id: provenance.actorPrincipalId },
    });
    assert.equal(retainedPrincipal.organizationId, organizationId);
    assert.equal(retainedPrincipal.liveUserId, owner.id);
    assert.equal(retainedPrincipal.pseudonymizedAt, null);
    assert.equal(provenance.sourceProvider, "PaperPilot WebMCP");
    assert.equal(provenance.sourceRecordId, command.proposal.sourcePageUrl);
    assert.equal(await prisma.provenanceRecord.count({
      where: { organizationId, inboxEntryId: staged.data.inboxEntry.id },
    }), 1);
    assert.equal(await prisma.idempotencyRecord.count({
      where: { organizationId, command: "stageWebMcpProposal" },
    }), 1);
    const stagedAudit = await prisma.auditEvent.findFirstOrThrow({
      where: { organizationId, action: "webmcp.proposal.staged" },
    });
    assert.equal(stagedAudit.actorPrincipalId, retainedPrincipal.id);

    const replayed = await proposeWebMcpWorkspaceImport(owner, organizationId, command);
    assertSuccess(replayed);
    assert.equal(replayed.outcome, "replayed");
    assert.equal(replayed.aggregateVersion, 2);
    assert.equal(replayed.data.inboxEntry.id, staged.data.inboxEntry.id);

    const changedIntent = await proposeWebMcpWorkspaceImport(owner, organizationId, {
      ...command,
      proposal: { ...command.proposal, title: "A different proposal intent" },
    });
    assert.equal(changedIntent.ok, false);
    if (!changedIntent.ok) assert.equal(changedIntent.code, "idempotency_conflict");

    const semanticDuplicate = await proposeWebMcpWorkspaceImport(owner, organizationId, {
      ...command,
      clientOperationId: `webmcp-semantic-${suffix}`,
      expectedVersion: 2,
    });
    assertSuccess(semanticDuplicate);
    assert.equal(semanticDuplicate.outcome, "noop");
    assert.equal(semanticDuplicate.aggregateVersion, 2);
    assert.equal(semanticDuplicate.data.inboxEntry.id, staged.data.inboxEntry.id);
    assert.equal(await prisma.retainedAuditPrincipal.count({
      where: { organizationId, liveUserId: owner.id },
    }), 1);
    const noopAudit = await prisma.auditEvent.findFirstOrThrow({
      where: {
        organizationId,
        action: "webmcp.proposal.noop",
        requestId: `webmcp-semantic-${suffix}`,
      },
    });
    assert.equal(noopAudit.actorPrincipalId, retainedPrincipal.id);

    const changedSourceProposal = await proposeWebMcpWorkspaceImport(owner, organizationId, {
      ...command,
      clientOperationId: `webmcp-source-conflict-${suffix}`,
      expectedVersion: 2,
      proposal: {
        ...command.proposal,
        title: "Conflicting metadata for the same source page",
      },
    });
    assert.equal(changedSourceProposal.ok, false);
    if (!changedSourceProposal.ok) assert.equal(changedSourceProposal.code, "duplicate");
    assert.equal((await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { revision: true },
    })).revision, 2);

    const stale = await proposeWebMcpWorkspaceImport(
      owner,
      organizationId,
      proposalCommand(`stale-${suffix}`, 1, `webmcp-stale-${suffix}`),
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "version_conflict");

    await assert.rejects(
      proposeWebMcpWorkspaceImport(outsider, organizationId, {
        ...command,
        clientOperationId: `webmcp-outsider-${suffix}`,
        expectedVersion: 2,
      }),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 404
        && error.code === "workspace_not_found",
    );
    await assert.rejects(
      proposeWebMcpWorkspaceImport(viewer, organizationId, {
        ...command,
        clientOperationId: `webmcp-viewer-${suffix}`,
        expectedVersion: 2,
      }),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 403
        && error.code === "workspace_forbidden",
    );

    assert.equal(await prisma.importBatch.count({ where: { organizationId } }), 0);
    assert.equal(await prisma.document.count({ where: { organizationId } }), 0);
    assert.equal(await prisma.asset.count({ where: { organizationId } }), 0);
    assert.equal(await prisma.documentIntake.count({ where: { organizationId } }), 0);
    assert.equal(await prisma.documentIngressAttempt.count({ where: { organizationId } }), 0);
    assert.equal(await prisma.documentIngestReceipt.count({ where: { organizationId } }), 0);
    assert.equal(await prisma.job.count({ where: { organizationId } }), 0);

    const filed = await fileWorkspaceImport(
      owner,
      organizationId,
      staged.data.inboxEntry.id,
      {
        clientOperationId: `webmcp-file-${suffix}`,
        expectedVersion: 2,
        inboxEntryId: staged.data.inboxEntry.id,
        projectId: project.data.project.id,
      },
    );
    assert.equal(filed.ok, false);
    if (!filed.ok) {
      assert.equal(filed.code, "validation");
      assert.equal(
        filed.message,
        "WebMCP proposals require a separate reviewed approval before filing.",
      );
      assert.equal(filed.aggregateVersion, 2);
    }
    assert.equal(await prisma.workspacePaper.count({ where: { organizationId } }), 0);
    assert.equal(await prisma.projectPaper.count({ where: { organizationId } }), 0);
    assert.equal(await prisma.provenanceRecord.count({
      where: {
        organizationId,
        inboxEntryId: staged.data.inboxEntry.id,
        kind: "IMPORT",
      },
    }), 0);

    const refreshed = await workspaceBootstrap(owner, null, organizationId);
    const refreshedEntry = refreshed.inboxEntries.find(
      (entry) => entry.id === staged.data.inboxEntry.id,
    );
    assert.ok(refreshedEntry && refreshedEntry.entryKind !== "document-upload");
    assert.equal(refreshedEntry.sourceKind, "webmcp");
    assert.equal(refreshedEntry.status, "awaiting-review");
  } finally {
    if (organizationId) {
      await prisma.$transaction(async (transaction) => {
        // WebMCP staging authority is retained for the lifetime of its Inbox
        // entry. Erase the graph together so the deferred provenance guard
        // observes no retained entry, including if a future assertion advances
        // this fixture as far as approval.
        await transaction.provenanceRecord.deleteMany({ where: { organizationId } });
        await transaction.webMcpProposalApproval.deleteMany({ where: { organizationId } });
        await transaction.webMcpApprovalChallenge.deleteMany({ where: { organizationId } });
        await transaction.inboxEntry.deleteMany({ where: { organizationId } });
        await transaction.auditEvent.deleteMany({ where: { organizationId } });
        await transaction.retainedAuditPrincipal.deleteMany({ where: { organizationId } });
        await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
        await transaction.organization.deleteMany({ where: { id: organizationId } });
      });
    }
    await prisma.user.deleteMany({
      where: { id: { in: [owner.id, outsider.id, viewer.id] } },
    });
  }
});
