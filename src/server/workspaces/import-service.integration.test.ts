import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Paper, Provenance } from "@/lib/types";
import type {
  CreateProjectCommand,
  StageImportCommand,
  WorkspaceCommandResult,
} from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { readJsonObject } from "@/server/http/request";
import { proposeWebMcpWorkspaceImport } from "@/server/integrations/webmcp/intake-service";
import { createWorkspaceProject, workspaceBootstrap } from "./service";
import {
  fileWorkspaceImport,
  MAX_IMPORT_COMMAND_BYTES,
  stageWorkspaceImport,
} from "./import-service";

after(async () => {
  await prisma.$disconnect();
});

function assertSuccess<T>(
  result: WorkspaceCommandResult<T>,
): asserts result is Extract<WorkspaceCommandResult<T>, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

async function cleanupOrganizationGraphs(organizationIds: string[]): Promise<void> {
  if (organizationIds.length === 0) return;
  const scope = { organizationId: { in: organizationIds } };
  await prisma.$transaction(async (transaction) => {
    // WebMCP proposal and approval provenance is lifetime-retained with its
    // Inbox graph. Delete the tenant graph atomically so deferred guards never
    // observe a surviving Inbox or approval after its authority row is gone.
    await transaction.provenanceRecord.deleteMany({ where: scope });
    await transaction.webMcpProposalApproval.deleteMany({ where: scope });
    await transaction.webMcpApprovalChallenge.deleteMany({ where: scope });
    await transaction.inboxEntry.deleteMany({ where: scope });
    await transaction.auditEvent.deleteMany({ where: scope });
    await transaction.idempotencyRecord.deleteMany({ where: scope });
    await transaction.retainedAuditPrincipal.deleteMany({ where: scope });
    await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    await transaction.organization.deleteMany({ where: { id: { in: organizationIds } } });
  });
}

function projectCommand(operationId: string, expectedVersion: number): CreateProjectCommand {
  return {
    clientOperationId: operationId,
    expectedVersion,
    project: {
      name: `Import verification ${operationId.slice(-8)}`,
      question: "Can authenticated imports retain source identity and tenant boundaries?",
      description: "PostgreSQL import integration test project.",
      type: "literature-review",
      visibility: "private",
    },
  };
}

function providerPaper(suffix: string, doi: string, overrides: Partial<Paper> = {}): Paper {
  const openAlexId = `https://openalex.org/W${suffix.replaceAll("-", "")}`;
  return {
    id: `provider-paper-${suffix}`,
    title: "Durable scholarly import transactions",
    shortTitle: "Durable scholarly imports",
    authors: ["Ada Evidence", "Linus Provenance"],
    year: 2026,
    venue: "Journal of Reproducible Systems",
    type: "journal article",
    abstract: "A bounded provider snapshot is resolved into a canonical scholarly record.",
    abstractSnippet: "A bounded provider snapshot is resolved into a canonical record.",
    whyRead: "Verifies durable, source-grounded import behavior.",
    relevanceScore: 94,
    relevanceTags: ["provenance", "transactions"],
    evidenceStrength: "unassessed",
    readingStatus: "unread",
    readingProgress: 0,
    estimatedMinutes: 12,
    citationCount: 7,
    providerRelevanceScore: 18.5,
    identifiers: [
      { scheme: "doi", value: doi },
      { scheme: "provider", value: openAlexId },
    ],
    sourceUrl: `https://doi.org/${doi}`,
    access: {
      isOpenAccess: true,
      hasFullText: false,
      landingPageUrl: `https://doi.org/${doi}`,
      license: "cc-by",
      version: "publishedVersion",
    },
    isRetracted: false,
    providerUpdatedAt: "2026-08-20T12:00:00.000Z",
    isDemoRecord: false,
    ...overrides,
  };
}

function providerProvenance(paper: Paper, sourceId: string, providerName = "OpenAlex"): Provenance {
  return {
    id: `provenance-${sourceId.replace(/[^a-z0-9]/gi, "-")}`,
    sourceType: providerName === "Zotero" ? "citation-library" : "literature-index",
    sourceId,
    sourceTitle: paper.title,
    sourceUrl: sourceId.startsWith("http") ? sourceId : "https://www.zotero.org/",
    providerName,
    retrievedAt: "2026-08-28T16:00:00.000Z",
    accessMethod: providerName === "Zotero" ? "oauth" : "api",
    excerpt: paper.abstractSnippet,
    version: "provider-version-17",
  };
}

test("bounded import JSON rejects oversized request bodies before parsing", async () => {
  const oversized = JSON.stringify({ payload: "x".repeat(MAX_IMPORT_COMMAND_BYTES) });
  await assert.rejects(
    readJsonObject(new Request("http://paperpilot.test/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversized,
    }), MAX_IMPORT_COMMAND_BYTES),
    (error: unknown) =>
      error instanceof HttpProblem
      && error.status === 413
      && error.code === "request_too_large",
  );
});

test("browser import staging rejects server-managed sources and custody claims", async () => {
  const suffix = randomUUID();
  const paper = providerPaper(`guard-${suffix}`, `10.5555/guard-${suffix}`);
  const provenance = providerProvenance(paper, `https://openalex.org/WGUARD${suffix}`);
  const user = { id: `guard-user-${suffix}`, name: "Import Guard Test" };
  const workspaceId = `guard-workspace-${suffix}`;
  const message = "This import source requires a server-managed ingestion pipeline.";

  for (const sourceKind of ["zotero", "upload", "crawler", "webmcp"] as const) {
    await assert.rejects(
      stageWorkspaceImport(user, workspaceId, {
        clientOperationId: `guard-source-${sourceKind}-${suffix}`,
        expectedVersion: 0,
        sourceKind,
        paper,
        provenance,
      }),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 400
        && error.code === "validation"
        && error.message === message,
    );
  }

  for (const accessMethod of ["oauth", "upload", "crawler", "mcp", "webmcp"] as const) {
    await assert.rejects(
      stageWorkspaceImport(user, workspaceId, {
        clientOperationId: `guard-custody-${accessMethod}-${suffix}`,
        expectedVersion: 0,
        sourceKind: "discover",
        paper,
        provenance: { ...provenance, accessMethod },
      }),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 400
        && error.code === "validation"
        && error.message === message,
    );
  }

  await assert.rejects(
    stageWorkspaceImport(user, workspaceId, {
      clientOperationId: `guard-uploaded-file-${suffix}`,
      expectedVersion: 0,
      sourceKind: "identifier",
      paper,
      provenance: { ...provenance, sourceType: "uploaded-file", accessMethod: "api" },
    }),
    (error: unknown) =>
      error instanceof HttpProblem
      && error.status === 400
      && error.code === "validation"
      && error.message === message,
  );
});

test("file imports reject unready states and upload or document custody", async () => {
  const suffix = randomUUID();
  const doi = `10.5555/file-guard-${suffix}`;
  const user = await prisma.user.create({
    data: {
      id: `file-guard-user-${suffix}`,
      name: "File Guard Test",
      email: `file-guard-${suffix}@example.test`,
    },
  });
  let organizationId: string | undefined;

  try {
    const initial = await workspaceBootstrap(user);
    organizationId = initial.workspace.id;
    const createdProject = await createWorkspaceProject(
      user,
      organizationId,
      projectCommand(`file-guard-project-${suffix}`, initial.aggregateVersion),
    );
    assertSuccess(createdProject);

    const paper = providerPaper(`file-guard-${suffix}`, doi);
    const staged = await stageWorkspaceImport(user, organizationId, {
      clientOperationId: `file-guard-stage-${suffix}`,
      expectedVersion: createdProject.aggregateVersion,
      sourceKind: "discover",
      paper,
      provenance: providerProvenance(paper, `https://openalex.org/WFILEGUARD${suffix}`),
    });
    assertSuccess(staged);
    const expectedVersion = staged.aggregateVersion;
    const message = "This inbox entry is not eligible to be filed.";

    for (const status of ["NEEDS_REVIEW", "REJECTED", "FAILED"] as const) {
      await prisma.inboxEntry.update({
        where: { id: staged.data.inboxEntry.id },
        data: { status },
      });
      const result = await fileWorkspaceImport(
        user,
        organizationId,
        staged.data.inboxEntry.id,
        {
          clientOperationId: `file-guard-status-${status}-${suffix}`,
          expectedVersion,
          inboxEntryId: staged.data.inboxEntry.id,
          projectId: createdProject.data.project.id,
        },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "validation");
        assert.equal(result.message, message);
        assert.equal(result.aggregateVersion, expectedVersion);
      }
    }
    await prisma.inboxEntry.update({
      where: { id: staged.data.inboxEntry.id },
      data: { status: "PENDING" },
    });

    const fileUploadEntry = await prisma.inboxEntry.create({
      data: {
        organizationId,
        source: "FILE_UPLOAD",
        status: "PENDING",
        payload: { deliberately: "not a paper snapshot" },
        createdById: user.id,
      },
    });
    const fileUploadResult = await fileWorkspaceImport(
      user,
      organizationId,
      fileUploadEntry.id,
      {
        clientOperationId: `file-guard-upload-${suffix}`,
        expectedVersion,
        inboxEntryId: fileUploadEntry.id,
        projectId: createdProject.data.project.id,
      },
    );
    assert.equal(fileUploadResult.ok, false);
    if (!fileUploadResult.ok) {
      assert.equal(fileUploadResult.code, "validation");
      assert.equal(fileUploadResult.message, message);
    }

    const document = await prisma.document.create({
      data: {
        organizationId,
        kind: "PAPER_PDF",
      },
    });
    const documentEntry = await prisma.inboxEntry.create({
      data: {
        organizationId,
        documentId: document.id,
        source: "OPENALEX",
        status: "PENDING",
        payload: { deliberately: "not a paper snapshot" },
        createdById: user.id,
      },
    });
    const documentResult = await fileWorkspaceImport(
      user,
      organizationId,
      documentEntry.id,
      {
        clientOperationId: `file-guard-document-${suffix}`,
        expectedVersion,
        inboxEntryId: documentEntry.id,
        projectId: createdProject.data.project.id,
      },
    );
    assert.equal(documentResult.ok, false);
    if (!documentResult.ok) {
      assert.equal(documentResult.code, "validation");
      assert.equal(documentResult.message, message);
    }

    assert.equal((await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { revision: true },
    })).revision, expectedVersion);
    assert.equal(await prisma.workspacePaper.count({ where: { organizationId } }), 0);
    assert.equal(await prisma.paperIdentifier.count({
      where: { type: "DOI", normalizedValue: doi.toLowerCase() },
    }), 0);
  } finally {
    if (organizationId) {
      await cleanupOrganizationGraphs([organizationId]);
    }
    const identifiers = await prisma.paperIdentifier.findMany({
      where: { type: "DOI", normalizedValue: doi.toLowerCase() },
      select: { paperId: true },
    });
    await prisma.paper.deleteMany({
      where: { id: { in: identifiers.map((identifier) => identifier.paperId) } },
    });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("authenticated imports are atomic, replay-safe, canonical, refreshable, and tenant-isolated", async () => {
  const suffix = randomUUID();
  const doi = `10.5555/${suffix}`;
  const userA = await prisma.user.create({
    data: {
      id: `import-user-a-${suffix}`,
      name: "Import Test A",
      email: `import-a-${suffix}@example.test`,
    },
  });
  const userB = await prisma.user.create({
    data: {
      id: `import-user-b-${suffix}`,
      name: "Import Test B",
      email: `import-b-${suffix}@example.test`,
    },
  });

  const organizationIds: string[] = [];
  const canonicalPaperIds: string[] = [];
  try {
    const initialA = await workspaceBootstrap(userA);
    organizationIds.push(initialA.workspace.id);
    const createdProject = await createWorkspaceProject(
      userA,
      initialA.workspace.id,
      projectCommand(`project-${suffix}`, initialA.aggregateVersion),
    );
    assertSuccess(createdProject);
    assert.equal(createdProject.aggregateVersion, 1);
    const projectId = createdProject.data.project.id;

    const paper = providerPaper(suffix, doi.toUpperCase());
    const openAlexSourceId = paper.identifiers.find(
      (identifier) => identifier.scheme === "provider",
    )!.value;
    const provenance = providerProvenance(paper, openAlexSourceId);
    const stageCommand: StageImportCommand = {
      clientOperationId: `stage-${suffix}`,
      expectedVersion: 1,
      sourceKind: "discover",
      paper,
      provenance,
    };
    const staged = await stageWorkspaceImport(userA, initialA.workspace.id, stageCommand);
    assertSuccess(staged);
    assert.equal(staged.outcome, "applied");
    assert.equal(staged.aggregateVersion, 2);
    assert.equal(staged.data.inboxEntry.status, "awaiting-review");
    assert.equal(
      staged.data.inboxEntry.paper.identifiers.find((identifier) => identifier.scheme === "doi")?.value,
      doi.toLowerCase(),
    );

    const stageRows = await prisma.inboxEntry.findMany({
      where: { organizationId: initialA.workspace.id },
    });
    assert.equal(stageRows.length, 1);
    assert.deepEqual(stageRows[0].payload, {
      paper: staged.data.inboxEntry.paper,
      provenance: staged.data.inboxEntry.provenance,
    });
    assert.equal(await prisma.provenanceRecord.count({
      where: {
        organizationId: initialA.workspace.id,
        inboxEntryId: staged.data.inboxEntry.id,
        kind: "DISCOVERY",
      },
    }), 1);

    const replayedStage = await stageWorkspaceImport(userA, initialA.workspace.id, stageCommand);
    assertSuccess(replayedStage);
    assert.equal(replayedStage.outcome, "replayed");
    assert.equal(replayedStage.aggregateVersion, 2);
    assert.equal(replayedStage.data.inboxEntry.id, staged.data.inboxEntry.id);

    const changedPayload = await stageWorkspaceImport(userA, initialA.workspace.id, {
      ...stageCommand,
      paper: { ...paper, title: "A different client intent" },
    });
    assert.equal(changedPayload.ok, false);
    if (!changedPayload.ok) assert.equal(changedPayload.code, "idempotency_conflict");

    const semanticStage = await stageWorkspaceImport(userA, initialA.workspace.id, {
      ...stageCommand,
      clientOperationId: `stage-semantic-${suffix}`,
      expectedVersion: 2,
    });
    assertSuccess(semanticStage);
    assert.equal(semanticStage.outcome, "noop");
    assert.equal(semanticStage.aggregateVersion, 2);
    assert.equal(semanticStage.data.inboxEntry.id, staged.data.inboxEntry.id);

    const stalePaper = providerPaper(`stale-${suffix}`, `10.5555/stale-${suffix}`);
    const stale = await stageWorkspaceImport(userA, initialA.workspace.id, {
      clientOperationId: `stage-stale-${suffix}`,
      expectedVersion: 1,
      sourceKind: "discover",
      paper: stalePaper,
      provenance: providerProvenance(stalePaper, `https://openalex.org/WSTALE${suffix}`),
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "version_conflict");
    assert.equal(await prisma.inboxEntry.count({
      where: { organizationId: initialA.workspace.id },
    }), 1);

    const missingProject = await fileWorkspaceImport(
      userA,
      initialA.workspace.id,
      staged.data.inboxEntry.id,
      {
        clientOperationId: `file-missing-${suffix}`,
        expectedVersion: 2,
        inboxEntryId: staged.data.inboxEntry.id,
        projectId: `missing-${suffix}`,
      },
    );
    assert.equal(missingProject.ok, false);
    if (!missingProject.ok) assert.equal(missingProject.code, "not_found");
    assert.equal((await prisma.organization.findUniqueOrThrow({
      where: { id: initialA.workspace.id },
      select: { revision: true },
    })).revision, 2);
    assert.equal((await prisma.inboxEntry.findUniqueOrThrow({
      where: { id: staged.data.inboxEntry.id },
      select: { status: true, workspacePaperId: true },
    })).status, "PENDING");
    assert.equal(await prisma.workspacePaper.count({
      where: { organizationId: initialA.workspace.id },
    }), 0);

    const initialB = await workspaceBootstrap(userB);
    organizationIds.push(initialB.workspace.id);
    await assert.rejects(
      stageWorkspaceImport(userB, initialA.workspace.id, {
        ...stageCommand,
        clientOperationId: `cross-member-${suffix}`,
        expectedVersion: 2,
      }),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 404
        && error.code === "workspace_not_found",
    );
    const crossTenantFile = await fileWorkspaceImport(
      userB,
      initialB.workspace.id,
      staged.data.inboxEntry.id,
      {
        clientOperationId: `cross-file-${suffix}`,
        expectedVersion: 0,
        inboxEntryId: staged.data.inboxEntry.id,
        projectId,
      },
    );
    assert.equal(crossTenantFile.ok, false);
    if (!crossTenantFile.ok) assert.equal(crossTenantFile.code, "not_found");
    assert.equal((await prisma.organization.findUniqueOrThrow({
      where: { id: initialB.workspace.id },
      select: { revision: true },
    })).revision, 0);

    const fileCommand = {
      clientOperationId: `file-${suffix}`,
      expectedVersion: 2,
      inboxEntryId: staged.data.inboxEntry.id,
      projectId,
    };
    const filed = await fileWorkspaceImport(
      userA,
      initialA.workspace.id,
      staged.data.inboxEntry.id,
      fileCommand,
    );
    assertSuccess(filed);
    canonicalPaperIds.push(filed.data.paper.id);
    assert.equal(filed.outcome, "applied");
    assert.equal(filed.aggregateVersion, 3);
    assert.equal(filed.data.inboxEntry.status, "ready");
    assert.equal(filed.data.inboxEntry.destinationProjectId, projectId);
    assert.equal(filed.data.usedExistingPaper, false);
    assert.ok(filed.data.project.paperIds.includes(filed.data.paper.id));

    const replayedFile = await fileWorkspaceImport(
      userA,
      initialA.workspace.id,
      staged.data.inboxEntry.id,
      fileCommand,
    );
    assertSuccess(replayedFile);
    assert.equal(replayedFile.outcome, "replayed");
    assert.equal(replayedFile.aggregateVersion, 3);
    assert.equal(replayedFile.data.paper.id, filed.data.paper.id);

    const semanticFile = await fileWorkspaceImport(
      userA,
      initialA.workspace.id,
      staged.data.inboxEntry.id,
      {
        ...fileCommand,
        clientOperationId: `file-semantic-${suffix}`,
        expectedVersion: 3,
      },
    );
    assertSuccess(semanticFile);
    assert.equal(semanticFile.outcome, "noop");
    assert.equal(semanticFile.aggregateVersion, 3);

    const refreshed = await workspaceBootstrap(userA, null, initialA.workspace.id);
    assert.equal(refreshed.aggregateVersion, 3);
    assert.equal(refreshed.inboxEntries.length, 1);
    assert.equal(refreshed.inboxEntries[0].status, "ready");
    assert.ok(refreshed.papers.some((candidate) => candidate.id === filed.data.paper.id));
    assert.ok(
      refreshed.projects.find((candidate) => candidate.id === projectId)?.paperIds.includes(
        filed.data.paper.id,
      ),
    );

    const identifierPaper = providerPaper(`identifier-${suffix}`, `https://doi.org/${doi}`, {
      id: `identifier-paper-${suffix}`,
      title: "Durable scholarly import transactions (identifier lookup)",
      identifiers: [{ scheme: "doi", value: `https://doi.org/${doi}` }],
    });
    const identifierStage = await stageWorkspaceImport(userA, initialA.workspace.id, {
      clientOperationId: `stage-identifier-${suffix}`,
      expectedVersion: 3,
      sourceKind: "identifier",
      paper: identifierPaper,
      provenance: providerProvenance(
        identifierPaper,
        `https://openalex.org/WIDENTIFIER${suffix}`,
      ),
    });
    assertSuccess(identifierStage);
    assert.equal(identifierStage.outcome, "applied");
    assert.equal(identifierStage.aggregateVersion, 4);
    assert.equal(identifierStage.data.inboxEntry.status, "possible-duplicate");
    assert.equal(identifierStage.data.duplicatePaperId, filed.data.paper.id);

    const identifierFile = await fileWorkspaceImport(
      userA,
      initialA.workspace.id,
      identifierStage.data.inboxEntry.id,
      {
        clientOperationId: `file-identifier-${suffix}`,
        expectedVersion: 4,
        inboxEntryId: identifierStage.data.inboxEntry.id,
        projectId,
      },
    );
    assertSuccess(identifierFile);
    assert.equal(identifierFile.aggregateVersion, 5);
    assert.equal(identifierFile.data.paper.id, filed.data.paper.id);
    assert.equal(identifierFile.data.usedExistingPaper, true);

    assert.equal(await prisma.paperIdentifier.count({
      where: { type: "DOI", normalizedValue: doi.toLowerCase() },
    }), 1);
    assert.equal(await prisma.workspacePaper.count({
      where: { organizationId: initialA.workspace.id, paperId: filed.data.paper.id },
    }), 1);
    assert.equal(await prisma.projectPaper.count({
      where: { organizationId: initialA.workspace.id, projectId },
    }), 1);
    assert.equal(await prisma.provenanceRecord.count({
      where: {
        organizationId: initialA.workspace.id,
        paperId: filed.data.paper.id,
        kind: "IMPORT",
      },
    }), 2);
    assert.equal((await workspaceBootstrap(userA, null, initialA.workspace.id)).inboxEntries.length, 2);
  } finally {
    if (organizationIds.length > 0) {
      await cleanupOrganizationGraphs(organizationIds);
    }
    if (canonicalPaperIds.length > 0) {
      await prisma.paper.deleteMany({ where: { id: { in: canonicalPaperIds } } });
    } else {
      const identifiers = await prisma.paperIdentifier.findMany({
        where: { type: "DOI", normalizedValue: doi.toLowerCase() },
        select: { paperId: true },
      });
      await prisma.paper.deleteMany({
        where: { id: { in: identifiers.map((identifier) => identifier.paperId) } },
      });
    }
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  }
});

test("imports cannot bridge another member's private project through Inbox or canonical dedupe", async () => {
  const suffix = randomUUID();
  const doi = `10.5555/private-import-${suffix}`;
  const owner = await prisma.user.create({
    data: {
      id: `private-import-owner-${suffix}`,
      name: "Private Import Owner",
      email: `private-import-owner-${suffix}@example.test`,
    },
  });
  const member = await prisma.user.create({
    data: {
      id: `private-import-member-${suffix}`,
      name: "Private Import Member",
      email: `private-import-member-${suffix}@example.test`,
    },
  });
  let organizationId: string | undefined;
  let canonicalPaperId: string | undefined;

  try {
    const bootstrap = await workspaceBootstrap(owner);
    organizationId = bootstrap.workspace.id;
    await prisma.member.create({
      data: { organizationId, userId: member.id, role: "member" },
    });
    const ownerProject = await createWorkspaceProject(
      owner,
      organizationId,
      projectCommand(`private-owner-project-${suffix}`, bootstrap.aggregateVersion),
    );
    assertSuccess(ownerProject);

    const paper = providerPaper(`private-${suffix}`, doi);
    const provenance = providerProvenance(
      paper,
      `https://openalex.org/WPRIVATE${suffix.replaceAll("-", "")}`,
    );
    const staged = await stageWorkspaceImport(owner, organizationId, {
      clientOperationId: `private-owner-stage-${suffix}`,
      expectedVersion: ownerProject.aggregateVersion,
      sourceKind: "discover",
      paper,
      provenance,
    });
    assertSuccess(staged);
    const filed = await fileWorkspaceImport(
      owner,
      organizationId,
      staged.data.inboxEntry.id,
      {
        clientOperationId: `private-owner-file-${suffix}`,
        expectedVersion: staged.aggregateVersion,
        inboxEntryId: staged.data.inboxEntry.id,
        projectId: ownerProject.data.project.id,
      },
    );
    assertSuccess(filed);
    canonicalPaperId = filed.data.paper.id;

    const memberProject = await createWorkspaceProject(
      member,
      organizationId,
      projectCommand(`private-member-project-${suffix}`, filed.aggregateVersion),
    );
    assertSuccess(memberProject);
    assert.equal(memberProject.aggregateVersion, 4);

    const hiddenSemanticMatch = await stageWorkspaceImport(member, organizationId, {
      clientOperationId: `private-hidden-source-${suffix}`,
      expectedVersion: memberProject.aggregateVersion,
      sourceKind: "discover",
      paper,
      provenance,
    });
    assert.equal(hiddenSemanticMatch.ok, false);
    if (!hiddenSemanticMatch.ok) {
      assert.equal(hiddenSemanticMatch.code, "not_found");
      assert.equal(hiddenSemanticMatch.message, "The import target was not found.");
    }

    const identifierPaper = providerPaper(`private-identifier-${suffix}`, doi, {
      id: `private-identifier-paper-${suffix}`,
      identifiers: [{ scheme: "doi", value: doi }],
    });
    const hiddenCanonicalMatch = await stageWorkspaceImport(member, organizationId, {
      clientOperationId: `private-hidden-canonical-${suffix}`,
      expectedVersion: memberProject.aggregateVersion,
      sourceKind: "identifier",
      paper: identifierPaper,
      provenance: providerProvenance(
        identifierPaper,
        `https://crossref.example.org/works/${suffix}`,
        "Crossref",
      ),
    });
    assert.equal(hiddenCanonicalMatch.ok, false);
    if (!hiddenCanonicalMatch.ok) assert.equal(hiddenCanonicalMatch.code, "not_found");

    const memberBootstrap = await workspaceBootstrap(member, null, organizationId);
    assert.equal(memberBootstrap.aggregateVersion, memberProject.aggregateVersion);
    assert.equal(memberBootstrap.papers.some((value) => value.id === canonicalPaperId), false);
    assert.equal(
      memberBootstrap.inboxEntries.some((value) => value.id === staged.data.inboxEntry.id),
      false,
    );

    const unlinkedLegacyEntry = await prisma.inboxEntry.create({
      data: {
        organizationId,
        source: "DOI_URL",
        status: "PENDING",
        proposedTitle: identifierPaper.title,
        proposedYear: identifierPaper.year,
        sourceUri: identifierPaper.sourceUrl,
        payload: JSON.parse(JSON.stringify({
          paper: identifierPaper,
          provenance: providerProvenance(
            identifierPaper,
            `https://legacy.example.org/works/${suffix}`,
            "Legacy import",
          ),
        })),
        createdById: member.id,
      },
    });
    const hiddenCanonicalFile = await fileWorkspaceImport(
      member,
      organizationId,
      unlinkedLegacyEntry.id,
      {
        clientOperationId: `private-hidden-canonical-file-${suffix}`,
        expectedVersion: memberProject.aggregateVersion,
        inboxEntryId: unlinkedLegacyEntry.id,
        projectId: memberProject.data.project.id,
      },
    );
    assert.equal(hiddenCanonicalFile.ok, false);
    if (!hiddenCanonicalFile.ok) assert.equal(hiddenCanonicalFile.code, "not_found");

    const hiddenWorkspacePaper = await prisma.workspacePaper.findUniqueOrThrow({
      where: {
        organizationId_paperId: { organizationId, paperId: canonicalPaperId },
      },
      select: { id: true },
    });
    const linkedLegacyEntry = await prisma.inboxEntry.create({
      data: {
        organizationId,
        workspacePaperId: hiddenWorkspacePaper.id,
        source: "OTHER",
        status: "PENDING",
        proposedTitle: paper.title,
        proposedYear: paper.year,
        payload: JSON.parse(JSON.stringify({ paper, provenance })),
        createdById: member.id,
      },
    });
    const hiddenEntryFile = await fileWorkspaceImport(
      member,
      organizationId,
      linkedLegacyEntry.id,
      {
        clientOperationId: `private-hidden-entry-file-${suffix}`,
        expectedVersion: memberProject.aggregateVersion,
        inboxEntryId: linkedLegacyEntry.id,
        projectId: memberProject.data.project.id,
      },
    );
    assert.equal(hiddenEntryFile.ok, false);
    if (!hiddenEntryFile.ok) assert.equal(hiddenEntryFile.code, "not_found");

    assert.equal((await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { revision: true },
    })).revision, memberProject.aggregateVersion);
    assert.equal(await prisma.projectPaper.count({
      where: { organizationId, projectId: memberProject.data.project.id },
    }), 0);
    assert.equal(await prisma.projectPaper.count({
      where: { organizationId, projectId: ownerProject.data.project.id },
    }), 1);
  } finally {
    if (organizationId) {
      await cleanupOrganizationGraphs([organizationId]);
    }
    if (canonicalPaperId) {
      await prisma.paper.deleteMany({ where: { id: canonicalPaperId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
  }
});

test("WebMCP staging does not disclose cross-tenant upload or manual canonical metadata", async () => {
  const suffix = randomUUID();
  const sourceOwner = await prisma.user.create({
    data: {
      id: `private-canonical-source-${suffix}`,
      name: "Private Canonical Source Owner",
      email: `private-canonical-source-${suffix}@example.test`,
    },
  });
  const targetOwner = await prisma.user.create({
    data: {
      id: `private-canonical-target-${suffix}`,
      name: "Private Canonical Target Owner",
      email: `private-canonical-target-${suffix}@example.test`,
    },
  });
  const organizationIds: string[] = [];
  const paperIds: string[] = [];

  try {
    const sourceBootstrap = await workspaceBootstrap(sourceOwner);
    const targetBootstrap = await workspaceBootstrap(targetOwner);
    organizationIds.push(sourceBootstrap.workspace.id, targetBootstrap.workspace.id);

    const sourceProject = await createWorkspaceProject(
      sourceOwner,
      sourceBootstrap.workspace.id,
      projectCommand(`private-canonical-source-project-${suffix}`, sourceBootstrap.aggregateVersion),
    );
    assertSuccess(sourceProject);

    let targetVersion = targetBootstrap.aggregateVersion;
    for (const [index, primarySource] of (["UPLOAD", "MANUAL"] as const).entries()) {
      const label = primarySource.toLowerCase();
      const doi = `10.5555/private-${label}-${suffix}`;
      const privatePaper = await prisma.paper.create({
        data: {
          title: `Tenant-private ${label} canonical record`,
          abstractText: `Private ${label} metadata must not cross a tenant boundary.`,
          publicationYear: 2025 + index,
          venueName: "Private Workspace Notes",
          workType: "private record",
          primarySource,
          authors: {
            create: [{ position: 0, displayName: "Private Workspace Author" }],
          },
          identifiers: {
            create: [{
              type: "DOI",
              value: doi,
              normalizedValue: doi,
              source: primarySource,
            }],
          },
        },
      });
      paperIds.push(privatePaper.id);
      const sourceWorkspacePaper = await prisma.workspacePaper.create({
        data: {
          organizationId: sourceBootstrap.workspace.id,
          paperId: privatePaper.id,
          status: "SAVED",
          addedById: sourceOwner.id,
        },
      });
      await prisma.projectPaper.create({
        data: {
          organizationId: sourceBootstrap.workspace.id,
          projectId: sourceProject.data.project.id,
          workspacePaperId: sourceWorkspacePaper.id,
          addedById: sourceOwner.id,
        },
      });

      const staged = await proposeWebMcpWorkspaceImport(
        targetOwner,
        targetBootstrap.workspace.id,
        {
          schemaVersion: 1,
          clientOperationId: `private-canonical-webmcp-${label}-${suffix}`,
          expectedVersion: targetVersion,
          proposal: {
            title: `Attacker-supplied ${label} proposal`,
            authors: ["Untrusted Agent"],
            year: 2026,
            venue: "Attacker-provided venue",
            publicationType: "journal article",
            abstract: "An attacker-supplied proposal must not reveal the canonical private record.",
            identifiers: [{ scheme: "doi", value: doi }],
            sourcePageUrl: `https://example.org/guessed/${label}/${suffix}`,
          },
        },
      );
      assertSuccess(staged);
      targetVersion = staged.aggregateVersion;
      assert.equal(staged.data.duplicatePaperId, undefined);
      assert.equal(staged.data.inboxEntry.duplicateOfPaperId, undefined);
      assert.equal(staged.data.inboxEntry.sourceKind, "webmcp");
      assert.equal("duplicateCandidate" in staged.data.inboxEntry, false);

      const stagedAuthority = await prisma.provenanceRecord.findFirstOrThrow({
        where: {
          organizationId: targetBootstrap.workspace.id,
          inboxEntryId: staged.data.inboxEntry.id,
          kind: "WEB_MCP",
        },
      });
      assert.equal(stagedAuthority.paperId, null);
      assert.equal(stagedAuthority.workspacePaperId, null);
    }

    const targetState = await workspaceBootstrap(
      targetOwner,
      null,
      targetBootstrap.workspace.id,
    );
    assert.equal(targetState.papers.length, 0);
    assert.equal(targetState.inboxEntries.length, 2);
    assert.equal(JSON.stringify(targetState).includes("Private Workspace Notes"), false);
    assert.equal(JSON.stringify(targetState).includes("Tenant-private upload canonical record"), false);
    assert.equal(JSON.stringify(targetState).includes("Tenant-private manual canonical record"), false);
  } finally {
    if (organizationIds.length > 0) {
      await cleanupOrganizationGraphs(organizationIds);
    }
    await prisma.paper.deleteMany({ where: { id: { in: paperIds } } });
    await prisma.user.deleteMany({
      where: { id: { in: [sourceOwner.id, targetOwner.id] } },
    });
  }
});
