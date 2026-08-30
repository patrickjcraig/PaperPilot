import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { WorkspaceCommandResult } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { getWorkspaceUploadStatus } from "@/server/uploads/service";
import { workspaceBootstrap } from "@/server/workspaces/service";
import {
  applyDocumentPaperLinkIdempotencyHeader,
  linkValidatedDocumentToWorkspacePaper,
  validateLinkValidatedDocumentCommand,
  type LinkValidatedDocumentResult,
} from "./document-paper-link";
import {
  DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
  claimNextDocumentTextExtractionJob,
  completeDocumentTextExtractionLease,
  enqueueDocumentTextExtractionJob,
} from "./extraction-jobs";
import {
  DOCUMENT_VALIDATION_POLICY_VERSION,
  LOCAL_QUARANTINE_STORAGE_VERSION,
} from "./validation-jobs";

const TEST_EPOCH = new Date("2026-08-28T18:00:00.000Z");
const EXTRACTION_TOOLCHAIN_DIGEST = "e".repeat(64);

interface TestUser {
  id: string;
  name: string;
}

interface WorkspaceFixture {
  organizationId: string;
  owner: TestUser;
  member: TestUser;
  viewer: TestUser;
  userIds: string[];
  paperIds: string[];
}

interface PaperTarget {
  paperId: string;
  workspacePaperId: string;
  projectId?: string;
}

interface ValidatedDocumentTarget {
  uploadSessionId: string;
  documentId: string;
  assetId: string;
  inboxEntryId: string;
  validationJobId: string;
  validationJobAttemptId: string;
  validationAttestationId: string;
  sha256: string;
  sizeBytes: bigint;
  scannedAt: Date;
  validatedAt: Date;
}

after(async () => {
  await prisma.$disconnect();
});

function plusMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

function assertSuccess(
  result: WorkspaceCommandResult<LinkValidatedDocumentResult>,
): asserts result is Extract<
  WorkspaceCommandResult<LinkValidatedDocumentResult>,
  { ok: true }
> {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

function command(
  clientOperationId: string,
  paperId: string,
  expectedVersion = 0,
) {
  return { clientOperationId, expectedVersion, paperId };
}

async function createWorkspace(label: string): Promise<WorkspaceFixture> {
  const suffix = randomUUID();
  const organizationId = `document-link-${label}-${suffix}`;
  const owner = {
    id: `document-link-owner-${suffix}`,
    name: "Document Link Owner",
  };
  const member = {
    id: `document-link-member-${suffix}`,
    name: "Document Link Member",
  };
  const viewer = {
    id: `document-link-viewer-${suffix}`,
    name: "Document Link Viewer",
  };
  await prisma.user.createMany({
    data: [
      {
        id: owner.id,
        name: owner.name,
        email: `document-link-owner-${suffix}@example.test`,
        emailVerified: true,
      },
      {
        id: member.id,
        name: member.name,
        email: `document-link-member-${suffix}@example.test`,
        emailVerified: true,
      },
      {
        id: viewer.id,
        name: viewer.name,
        email: `document-link-viewer-${suffix}@example.test`,
        emailVerified: true,
      },
    ],
  });
  await prisma.organization.create({
    data: {
      id: organizationId,
      name: `Document link ${label}`,
      slug: organizationId,
    },
  });
  await prisma.member.createMany({
    data: [
      { organizationId, userId: owner.id, role: "owner" },
      { organizationId, userId: member.id, role: "member" },
      { organizationId, userId: viewer.id, role: "viewer" },
    ],
  });
  return {
    organizationId,
    owner,
    member,
    viewer,
    userIds: [owner.id, member.id, viewer.id],
    paperIds: [],
  };
}

async function createPaperTarget(
  fixture: WorkspaceFixture,
  label: string,
  project?: { visibility: "PRIVATE" | "WORKSPACE"; createdById: string },
): Promise<PaperTarget> {
  const suffix = randomUUID();
  const paper = await prisma.paper.create({
    data: { title: `${label} canonical paper ${suffix}` },
  });
  fixture.paperIds.push(paper.id);
  const workspacePaper = await prisma.workspacePaper.create({
    data: {
      organizationId: fixture.organizationId,
      paperId: paper.id,
      status: "SAVED",
      addedById: fixture.owner.id,
    },
  });
  if (!project) {
    return { paperId: paper.id, workspacePaperId: workspacePaper.id };
  }
  const projectId = `document-link-project-${suffix}`;
  await prisma.project.create({
    data: {
      id: projectId,
      organizationId: fixture.organizationId,
      name: `${label} project`,
      slug: `document-link-project-${suffix}`,
      visibility: project.visibility,
      createdById: project.createdById,
    },
  });
  await prisma.projectPaper.create({
    data: {
      organizationId: fixture.organizationId,
      projectId,
      workspacePaperId: workspacePaper.id,
      addedById: project.createdById,
    },
  });
  return {
    paperId: paper.id,
    workspacePaperId: workspacePaper.id,
    projectId,
  };
}

async function createValidatedDocument(
  fixture: WorkspaceFixture,
  label: string,
  verdict: "ACCEPTED" | "REJECTED" = "ACCEPTED",
): Promise<ValidatedDocumentTarget> {
  const suffix = randomUUID();
  const documentId = `document-link-document-${label}-${suffix}`;
  const intakeId = `document-link-intake-${label}-${suffix}`;
  const uploadSessionId = `document-link-upload-session-${label}-${suffix}`;
  const uploadAttemptId = `document-link-upload-attempt-${label}-${suffix}`;
  const assetId = `document-link-asset-${label}-${suffix}`;
  const inboxEntryId = `document-link-inbox-${label}-${suffix}`;
  const validationJobId = `document-link-validation-job-${label}-${suffix}`;
  const validationJobAttemptId = `document-link-validation-attempt-${label}-${suffix}`;
  const validationAttestationId = `document-link-attestation-${label}-${suffix}`;
  const sha256 = createHash("sha256")
    .update(`${fixture.organizationId}:${label}:${suffix}`)
    .digest("hex");
  const sizeBytes = 1_337n;
  const scannedAt = plusMilliseconds(TEST_EPOCH, -2_000);
  const validatedAt = plusMilliseconds(TEST_EPOCH, -1_000);
  const storedAt = plusMilliseconds(TEST_EPOCH, -4_000);
  const objectKey = [
    LOCAL_QUARANTINE_STORAGE_VERSION,
    fixture.organizationId,
    assetId,
    suffix,
  ].join(":");

  await prisma.$transaction(async (transaction) => {
    await transaction.document.create({
      data: {
        id: documentId,
        organizationId: fixture.organizationId,
        kind: "PAPER_PDF",
        status: "READY",
        title: `${label} validated PDF`,
        mimeType: "application/pdf",
        pageCount: 3,
        contentHash: sha256,
        validatedAt,
        validationPolicyVersion: DOCUMENT_VALIDATION_POLICY_VERSION,
      },
    });
    await transaction.asset.create({
      data: {
        id: assetId,
        organizationId: fixture.organizationId,
        storageProvider: "LOCAL",
        objectKey,
        physicalLocator: objectKey,
        status: "READY",
        originalFileName: `${label}.pdf`,
        mimeType: "application/pdf",
        sizeBytes,
        sha256,
        scannedAt,
        validatedAt,
        validationPolicyVersion: DOCUMENT_VALIDATION_POLICY_VERSION,
      },
    });
    await transaction.documentAsset.create({
      data: {
        organizationId: fixture.organizationId,
        documentId,
        assetId,
        role: "ORIGINAL",
      },
    });
    await transaction.inboxEntry.create({
      data: {
        id: inboxEntryId,
        organizationId: fixture.organizationId,
        documentId,
        source: "FILE_UPLOAD",
        sourceKey: `document-link-upload-${suffix}`,
        status: "NEEDS_REVIEW",
        payload: {
          schemaVersion: 1,
          kind: "document-upload",
          custody: "validated",
          verification: "accepted",
        },
        createdById: fixture.owner.id,
      },
    });
    await transaction.documentIntake.create({
      data: {
        id: intakeId,
        organizationId: fixture.organizationId,
        source: "BROWSER_UPLOAD",
        status: "EXTRACTING",
        documentId,
        assetId,
        inboxEntryId,
        createdById: fixture.owner.id,
        reservedBytes: sizeBytes,
        committedBytes: sizeBytes,
        completedAt: null,
      },
    });
    await transaction.uploadSession.create({
      data: {
        id: uploadSessionId,
        organizationId: fixture.organizationId,
        createdById: fixture.owner.id,
        intakeId,
        assetId,
        documentId,
        inboxEntryId,
        clientOperationId: `document-link-upload-operation-${suffix}`,
        requestHash: createHash("sha256").update(`upload:${suffix}`).digest("hex"),
        status: "STORED",
        originalFileName: `${label}.pdf`,
        declaredMimeType: "application/pdf",
        expectedSizeBytes: sizeBytes,
        receivedSizeBytes: sizeBytes,
        sha256,
        expiresAt: plusMilliseconds(TEST_EPOCH, 60_000),
        storedAt,
      },
    });
    await transaction.uploadAttempt.create({
      data: {
        id: uploadAttemptId,
        organizationId: fixture.organizationId,
        uploadSessionId,
        assetId,
        attemptNumber: 1,
        storageKey: objectKey,
        status: "COMMITTED",
        expectedSizeBytes: sizeBytes,
        receivedSizeBytes: sizeBytes,
        sha256,
        leaseExpiresAt: storedAt,
        storedAt,
        completedAt: storedAt,
      },
    });
    await transaction.documentIngestReceipt.create({
      data: {
        id: uploadSessionId,
        organizationId: fixture.organizationId,
        source: "BROWSER_UPLOAD",
        sourceFingerprint: `upload-session:${uploadSessionId}`,
        intakeId,
        assetId,
        documentId,
        inboxEntryId,
        uploadSessionId,
        uploadAttemptId,
        requestedById: fixture.owner.id,
        sourceVersion: uploadSessionId,
        sourceChecksumAlgorithm: "sha256",
        sourceChecksum: sha256,
        declaredMimeType: "application/pdf",
        receivedSizeBytes: sizeBytes,
        sha256,
        storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
        storedAt,
      },
    });
    await transaction.job.create({
      data: {
        id: validationJobId,
        organizationId: fixture.organizationId,
        type: "DOCUMENT_VALIDATE",
        status: "SUCCEEDED",
        dedupeKey: `document-link-validation:${suffix}`,
        attempts: 1,
        maxAttempts: 4,
        runAfter: plusMilliseconds(TEST_EPOCH, -5_000),
        completedAt: validatedAt,
        documentId,
        assetId,
        intakeId,
        ingestReceiptId: uploadSessionId,
        payload: {
          schemaVersion: 2,
          policyVersion: DOCUMENT_VALIDATION_POLICY_VERSION,
          storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
          source: "document-ingest",
          ingestReceiptId: uploadSessionId,
        },
      },
    });
    await transaction.jobAttempt.create({
      data: {
        id: validationJobAttemptId,
        organizationId: fixture.organizationId,
        jobId: validationJobId,
        attemptNumber: 1,
        status: "SUCCEEDED",
        workerId: `document-link-validator-${suffix}`,
        startedAt: plusMilliseconds(TEST_EPOCH, -3_000),
        completedAt: validatedAt,
      },
    });
    await transaction.documentValidationAttestation.create({
      data: {
        id: validationAttestationId,
        organizationId: fixture.organizationId,
        jobId: validationJobId,
        jobAttemptId: validationJobAttemptId,
        assetId,
        documentId,
        ingestReceiptId: uploadSessionId,
        inputSha256: sha256,
        inputSizeBytes: sizeBytes,
        storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
        policyVersion: DOCUMENT_VALIDATION_POLICY_VERSION,
        toolchainDigest: createHash("sha256")
          .update(`document-link-validator:${suffix}`)
          .digest("hex"),
        verdict,
        rejectionCode: verdict === "ACCEPTED" ? null : "pdf_policy_violation",
        malwareVerdict: "CLEAN",
        malwareEngine: "clamav",
        malwareEngineVersion: "1.5.4",
        signatureVersion: "20260828",
        signaturePublishedAt: plusMilliseconds(TEST_EPOCH, -60_000),
        scannedAt,
        pdfStructuralVerdict: "VALID",
        pdfEngine: "qpdf+poppler",
        pdfEngineVersion: "12.4.1+25.06.0",
        pdfVersion: "1.7",
        pageCount: 3,
        objectCount: 42,
        revisionCount: 1,
        checkedAt: validatedAt,
        result: {
          schemaVersion: 1,
          detectionCount: 0,
          warningCount: 0,
          malwareDurationMs: 100,
          pdfDurationMs: 150,
          totalDurationMs: 200,
          completedAt: validatedAt.toISOString(),
        },
      },
    });
  });

  return {
    uploadSessionId,
    documentId,
    assetId,
    inboxEntryId,
    validationJobId,
    validationJobAttemptId,
    validationAttestationId,
    sha256,
    sizeBytes,
    scannedAt,
    validatedAt,
  };
}

async function cleanupFixtures(fixtures: WorkspaceFixture[]): Promise<void> {
  const organizationIds = fixtures.map((fixture) => fixture.organizationId);
  const paperIds = fixtures.flatMap((fixture) => fixture.paperIds);
  const userIds = fixtures.flatMap((fixture) => fixture.userIds);
  if (organizationIds.length > 0) {
    const where = { organizationId: { in: organizationIds } };
    await prisma.$transaction(async (transaction) => {
      await transaction.provenanceRecord.deleteMany({ where });
      await transaction.auditEvent.deleteMany({ where });
      await transaction.organization.deleteMany({
        where: { id: { in: organizationIds } },
      });
    });
  }
  if (paperIds.length > 0) {
    await prisma.paper.deleteMany({ where: { id: { in: paperIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

test("document link commands are exact closed JSON and require a matching idempotency header", () => {
  const body = command("document-link-command", "paper-command", 3);
  assert.deepEqual(validateLinkValidatedDocumentCommand(body), body);
  const matchingRequest = new Request("https://paperpilot.test/link", {
    method: "POST",
    headers: { "Idempotency-Key": body.clientOperationId },
  });
  assert.equal(
    applyDocumentPaperLinkIdempotencyHeader(matchingRequest, body),
    body,
  );

  for (const invalid of [
    { ...body, extra: true },
    { clientOperationId: body.clientOperationId, expectedVersion: 3 },
    { ...body, expectedVersion: -1 },
    { ...body, paperId: "hidden paper id" },
  ]) {
    assert.throws(
      () => validateLinkValidatedDocumentCommand(invalid),
      (error: unknown) => error instanceof HttpProblem
        && error.status === 400
        && error.code === "validation",
    );
  }

  const mismatchedRequest = new Request("https://paperpilot.test/link", {
    method: "POST",
    headers: { "Idempotency-Key": "different-operation" },
  });
  assert.throws(
    () => applyDocumentPaperLinkIdempotencyHeader(mismatchedRequest, body),
    (error: unknown) => error instanceof HttpProblem
      && error.status === 400
      && error.code === "idempotency_mismatch",
  );
});

test("a current validated upload links atomically, replays once, and can later yield NO_TEXT", async () => {
  const fixture = await createWorkspace("success");
  try {
    const paper = await createPaperTarget(fixture, "success");
    const otherPaper = await createPaperTarget(fixture, "idempotency-conflict");
    const target = await createValidatedDocument(fixture, "success");
    const extractionJob = await prisma.$transaction((transaction) =>
      enqueueDocumentTextExtractionJob(transaction, {
        organizationId: fixture.organizationId,
        documentId: target.documentId,
        assetId: target.assetId,
        validationAttestationId: target.validationAttestationId,
        toolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
        now: TEST_EPOCH,
      }));
    const unlinkedProcessingStatus = await getWorkspaceUploadStatus(
      fixture.owner.id,
      fixture.organizationId,
      target.uploadSessionId,
    );
    assert.equal(unlinkedProcessingStatus.inboxEntry.upload.linkedPaperId, undefined);
    assert.equal(unlinkedProcessingStatus.inboxEntry.upload.extractionStage, "queued");
    assert.equal(unlinkedProcessingStatus.inboxEntry.upload.readerAvailable, false);
    const unlinkedBootstrap = await workspaceBootstrap(
      fixture.owner,
      null,
      fixture.organizationId,
    );
    const unlinkedEntry = unlinkedBootstrap.inboxEntries.find(
      (entry) => entry.id === target.inboxEntryId,
    );
    assert.ok(unlinkedEntry && unlinkedEntry.entryKind === "document-upload");
    assert.equal(unlinkedEntry.upload.linkedPaperId, undefined);
    assert.equal(unlinkedEntry.upload.extractionStage, "queued");
    assert.equal(unlinkedEntry.upload.readerAvailable, false);
    const operationId = `document-link-success-${randomUUID()}`;
    const requested = command(operationId, paper.paperId);

    const applied = await linkValidatedDocumentToWorkspacePaper(
      fixture.owner,
      fixture.organizationId,
      target.documentId,
      requested,
    );
    assertSuccess(applied);
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.aggregateVersion, 1);
    assert.deepEqual(applied.data, {
      paperId: paper.paperId,
      documentId: target.documentId,
    });
    assert.deepEqual(Object.keys(applied.data).sort(), ["documentId", "paperId"]);

    const [storedDocument, storedInbox, receipt, provenance, audit] = await Promise.all([
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: target.inboxEntryId } }),
      prisma.idempotencyRecord.findUniqueOrThrow({
        where: {
          organizationId_key: {
            organizationId: fixture.organizationId,
            key: operationId,
          },
        },
      }),
      prisma.provenanceRecord.findFirstOrThrow({
        where: {
          organizationId: fixture.organizationId,
          documentId: target.documentId,
          kind: "IMPORT",
          sourceProvider: "PaperPilot validated document link",
        },
      }),
      prisma.auditEvent.findFirstOrThrow({
        where: {
          organizationId: fixture.organizationId,
          action: "document.paper.linked",
          entityId: target.documentId,
        },
      }),
    ]);
    assert.equal(storedDocument.paperId, paper.paperId);
    assert.equal(storedDocument.workspacePaperId, paper.workspacePaperId);
    assert.equal(storedDocument.status, "READY");
    assert.equal(storedInbox.workspacePaperId, paper.workspacePaperId);
    assert.equal(storedInbox.status, "IMPORTED");
    assert.ok(storedInbox.resolvedAt);
    assert.equal(receipt.status, "COMPLETED");
    assert.equal(receipt.actorUserId, fixture.owner.id);
    assert.equal(receipt.command, "linkValidatedDocumentToWorkspacePaper");
    assert.match(receipt.requestHash, /^[0-9a-f]{64}$/);
    assert.equal(provenance.paperId, paper.paperId);
    assert.equal(provenance.workspacePaperId, paper.workspacePaperId);
    assert.equal(provenance.inboxEntryId, target.inboxEntryId);
    assert.equal(provenance.sourceRecordId, target.validationAttestationId);
    assert.equal(audit.requestId, operationId);
    assert.equal(await prisma.documentTextExtraction.count({
      where: { documentId: target.documentId },
    }), 0, "linking must not depend on extraction having completed");
    const processingStatus = await getWorkspaceUploadStatus(
      fixture.owner.id,
      fixture.organizationId,
      target.uploadSessionId,
    );
    assert.equal(processingStatus.inboxEntry.upload.linkedPaperId, paper.paperId);
    assert.equal(processingStatus.inboxEntry.upload.extractionStage, "queued");
    assert.equal(processingStatus.inboxEntry.upload.readerAvailable, false);

    const replayed = await linkValidatedDocumentToWorkspacePaper(
      fixture.owner,
      fixture.organizationId,
      target.documentId,
      requested,
    );
    assertSuccess(replayed);
    assert.equal(replayed.outcome, "replayed");
    assert.equal(replayed.aggregateVersion, 1);
    assert.deepEqual(replayed.data, applied.data);
    assert.equal(await prisma.provenanceRecord.count({
      where: {
        organizationId: fixture.organizationId,
        documentId: target.documentId,
        sourceProvider: "PaperPilot validated document link",
      },
    }), 1);
    assert.equal(await prisma.auditEvent.count({
      where: {
        organizationId: fixture.organizationId,
        action: "document.paper.linked",
        entityId: target.documentId,
      },
    }), 1);

    const idempotencyConflict = await linkValidatedDocumentToWorkspacePaper(
      fixture.owner,
      fixture.organizationId,
      target.documentId,
      command(operationId, otherPaper.paperId),
    );
    assert.equal(idempotencyConflict.ok, false);
    if (!idempotencyConflict.ok) {
      assert.equal(idempotencyConflict.code, "idempotency_conflict");
      assert.equal(idempotencyConflict.aggregateVersion, 1);
    }

    await prisma.job.update({
      where: { id: extractionJob.id },
      data: { priority: 10_000 },
    });
    const lease = await claimNextDocumentTextExtractionJob({
      workerId: `document-link-no-text-${randomUUID()}`,
      expectedPolicyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
      expectedToolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
      leaseTtlMs: 10_000,
      now: TEST_EPOCH,
    });
    assert.ok(lease);
    assert.equal(lease.jobId, extractionJob.id);
    const noText = await completeDocumentTextExtractionLease({
      lease,
      attestation: {
        inputSha256: lease.inputSha256,
        inputSizeBytes: lease.inputSizeBytes,
        storageVersion: lease.storageVersion,
        policyVersion: lease.policyVersion,
        toolchainDigest: lease.toolchainDigest,
        verdict: "NO_TEXT",
        engine: "poppler",
        engineVersion: "25.06.0",
        pageCount: lease.expectedPageCount,
        chunkCount: 0,
        textBytes: 0,
        extractedAt: plusMilliseconds(TEST_EPOCH, 100),
        completedAt: plusMilliseconds(TEST_EPOCH, 200),
        durationMs: 80,
        totalDurationMs: 100,
        chunks: [],
      },
      now: plusMilliseconds(TEST_EPOCH, 1_000),
    });
    assert.equal(noText?.verdict, "NO_TEXT");
    const afterNoText = await prisma.document.findUniqueOrThrow({
      where: { id: target.documentId },
    });
    assert.equal(afterNoText.status, "READY");
    assert.equal(afterNoText.paperId, paper.paperId);
    assert.equal(afterNoText.workspacePaperId, paper.workspacePaperId);

    const noTextStatus = await getWorkspaceUploadStatus(
      fixture.owner.id,
      fixture.organizationId,
      target.uploadSessionId,
    );
    assert.equal(noTextStatus.inboxEntry.upload.extractionStage, "no-text");
    assert.equal(noTextStatus.inboxEntry.upload.readerAvailable, false);
    const noTextBootstrap = await workspaceBootstrap(
      fixture.owner,
      null,
      fixture.organizationId,
    );
    const noTextEntry = noTextBootstrap.inboxEntries.find(
      (entry) => entry.id === target.inboxEntryId,
    );
    assert.ok(noTextEntry && noTextEntry.entryKind === "document-upload");
    assert.equal(noTextEntry.upload.extractionStage, "no-text");
    assert.equal(noTextEntry.upload.readerAvailable, false);

    // Mutable asset drift invalidates the otherwise successful extraction.
    // The upload surfaces must follow Reader's closed unavailable state rather
    // than trusting the shallow job/verdict rows that still say NO_TEXT.
    await prisma.asset.update({
      where: { id: target.assetId },
      data: { sha256: "f".repeat(64) },
    });
    const driftedStatus = await getWorkspaceUploadStatus(
      fixture.owner.id,
      fixture.organizationId,
      target.uploadSessionId,
    );
    assert.equal(driftedStatus.inboxEntry.upload.linkedPaperId, paper.paperId);
    assert.equal(driftedStatus.inboxEntry.upload.extractionStage, "failed");
    assert.equal(driftedStatus.inboxEntry.upload.readerAvailable, false);
    const driftedBootstrap = await workspaceBootstrap(
      fixture.owner,
      null,
      fixture.organizationId,
    );
    const driftedEntry = driftedBootstrap.inboxEntries.find(
      (entry) => entry.id === target.inboxEntryId,
    );
    assert.ok(driftedEntry && driftedEntry.entryKind === "document-upload");
    assert.equal(driftedEntry.upload.extractionStage, "failed");
    assert.equal(driftedEntry.upload.readerAvailable, false);
  } finally {
    await cleanupFixtures([fixture]);
  }
});

test("foreign and private-project-only targets fail with one non-enumerating result", async () => {
  const local = await createWorkspace("visibility-local");
  const foreign = await createWorkspace("visibility-foreign");
  try {
    const localPaper = await createPaperTarget(local, "local-visible");
    const localDocument = await createValidatedDocument(local, "local-visible");
    const foreignPaper = await createPaperTarget(foreign, "foreign-visible");
    const foreignDocument = await createValidatedDocument(foreign, "foreign-visible");
    const hiddenPaper = await createPaperTarget(local, "hidden-private", {
      visibility: "PRIVATE",
      createdById: local.owner.id,
    });

    const results = [
      await linkValidatedDocumentToWorkspacePaper(
        local.member,
        local.organizationId,
        foreignDocument.documentId,
        command(`document-link-foreign-document-${randomUUID()}`, localPaper.paperId),
      ),
      await linkValidatedDocumentToWorkspacePaper(
        local.member,
        local.organizationId,
        localDocument.documentId,
        command(`document-link-foreign-paper-${randomUUID()}`, foreignPaper.paperId),
      ),
      await linkValidatedDocumentToWorkspacePaper(
        local.member,
        local.organizationId,
        localDocument.documentId,
        command(`document-link-hidden-paper-${randomUUID()}`, hiddenPaper.paperId),
      ),
    ];
    const messages = new Set<string>();
    for (const result of results) {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "not_found");
        assert.equal(result.aggregateVersion, 0);
        messages.add(result.message);
      }
    }
    assert.deepEqual([...messages], ["Document link target was not found."]);
    assert.equal((await prisma.organization.findUniqueOrThrow({
      where: { id: local.organizationId },
    })).revision, 0);
    assert.equal(await prisma.idempotencyRecord.count({
      where: { organizationId: local.organizationId },
    }), 0);
  } finally {
    await cleanupFixtures([local, foreign]);
  }
});

test("a linked upload in an owner's private project is non-enumerating to another member", async () => {
  const fixture = await createWorkspace("private-reader-visibility");
  try {
    const privatePaper = await createPaperTarget(
      fixture,
      "private-reader-visibility",
      { visibility: "PRIVATE", createdById: fixture.owner.id },
    );
    const workspacePaper = await createPaperTarget(
      fixture,
      "private-inbox-visibility",
    );
    const target = await createValidatedDocument(
      fixture,
      "private-reader-visibility",
    );
    const privateInboxTarget = await createValidatedDocument(
      fixture,
      "private-inbox-visibility",
    );
    const linked = await linkValidatedDocumentToWorkspacePaper(
      fixture.owner,
      fixture.organizationId,
      target.documentId,
      command(
        `document-link-private-reader-${randomUUID()}`,
        privatePaper.paperId,
      ),
    );
    assertSuccess(linked);
    const privateInboxLinked = await linkValidatedDocumentToWorkspacePaper(
      fixture.owner,
      fixture.organizationId,
      privateInboxTarget.documentId,
      command(
        `document-link-private-inbox-${randomUUID()}`,
        workspacePaper.paperId,
        1,
      ),
    );
    assertSuccess(privateInboxLinked);
    assert.ok(privatePaper.projectId);
    await prisma.inboxEntry.update({
      where: { id: privateInboxTarget.inboxEntryId },
      data: { projectId: privatePaper.projectId },
    });
    await prisma.$transaction((transaction) =>
      enqueueDocumentTextExtractionJob(transaction, {
        organizationId: fixture.organizationId,
        documentId: target.documentId,
        assetId: target.assetId,
        validationAttestationId: target.validationAttestationId,
        toolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
        now: TEST_EPOCH,
      }));
    await prisma.$transaction((transaction) =>
      enqueueDocumentTextExtractionJob(transaction, {
        organizationId: fixture.organizationId,
        documentId: privateInboxTarget.documentId,
        assetId: privateInboxTarget.assetId,
        validationAttestationId: privateInboxTarget.validationAttestationId,
        toolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
        now: TEST_EPOCH,
      }));

    const ownerBootstrap = await workspaceBootstrap(
      fixture.owner,
      null,
      fixture.organizationId,
    );
    const ownerEntry = ownerBootstrap.inboxEntries.find(
      (entry) => entry.id === target.inboxEntryId,
    );
    assert.ok(ownerEntry && ownerEntry.entryKind === "document-upload");
    assert.equal(ownerEntry.upload.linkedPaperId, privatePaper.paperId);
    assert.equal(ownerEntry.upload.extractionStage, "queued");
    assert.equal(ownerEntry.upload.readerAvailable, false);

    const memberBootstrap = await workspaceBootstrap(
      fixture.member,
      null,
      fixture.organizationId,
    );
    assert.equal(
      memberBootstrap.inboxEntries.some((entry) => entry.id === target.inboxEntryId),
      false,
    );
    assert.equal(
      memberBootstrap.inboxEntries.some(
        (entry) => entry.id === privateInboxTarget.inboxEntryId,
      ),
      false,
    );
    assert.equal(
      memberBootstrap.papers.some((paper) => paper.id === privatePaper.paperId),
      false,
    );
    assert.equal(
      memberBootstrap.papers.some((paper) => paper.id === workspacePaper.paperId),
      true,
    );

    const ownerStatus = await getWorkspaceUploadStatus(
      fixture.owner.id,
      fixture.organizationId,
      target.uploadSessionId,
    );
    assert.equal(ownerStatus.inboxEntry.upload.linkedPaperId, privatePaper.paperId);
    assert.equal(ownerStatus.inboxEntry.upload.extractionStage, "queued");
    assert.equal(ownerStatus.inboxEntry.upload.readerAvailable, false);
    const privateInboxOwnerStatus = await getWorkspaceUploadStatus(
      fixture.owner.id,
      fixture.organizationId,
      privateInboxTarget.uploadSessionId,
    );
    assert.equal(
      privateInboxOwnerStatus.inboxEntry.upload.linkedPaperId,
      workspacePaper.paperId,
    );
    assert.equal(
      privateInboxOwnerStatus.inboxEntry.upload.extractionStage,
      "queued",
    );

    const hiddenMessages: string[] = [];
    for (const uploadSessionId of [
      target.uploadSessionId,
      privateInboxTarget.uploadSessionId,
      "missing-upload-session",
    ]) {
      await assert.rejects(
        getWorkspaceUploadStatus(
          fixture.member.id,
          fixture.organizationId,
          uploadSessionId,
        ),
        (error: unknown) => {
          if (!(error instanceof HttpProblem)) return false;
          assert.equal(error.status, 404);
          assert.equal(error.code, "upload_not_found");
          hiddenMessages.push(error.message);
          return true;
        },
      );
    }
    assert.deepEqual(hiddenMessages, [
      "Upload was not found.",
      "Upload was not found.",
      "Upload was not found.",
    ]);
  } finally {
    await cleanupFixtures([fixture]);
  }
});

test("viewer authorization and stale workspace versions fail before mutation", async () => {
  const fixture = await createWorkspace("authorization-version");
  try {
    const paper = await createPaperTarget(fixture, "authorization-version");
    const target = await createValidatedDocument(fixture, "authorization-version");

    await assert.rejects(
      linkValidatedDocumentToWorkspacePaper(
        fixture.viewer,
        fixture.organizationId,
        target.documentId,
        command(`document-link-viewer-${randomUUID()}`, paper.paperId),
      ),
      (error: unknown) => error instanceof HttpProblem
        && error.status === 403
        && error.code === "workspace_forbidden",
    );

    const stale = await linkValidatedDocumentToWorkspacePaper(
      fixture.owner,
      fixture.organizationId,
      target.documentId,
      command(`document-link-stale-${randomUUID()}`, paper.paperId, 1),
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.code, "version_conflict");
      assert.equal(stale.aggregateVersion, 0);
    }
    const [document, inbox, organization] = await Promise.all([
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: target.inboxEntryId } }),
      prisma.organization.findUniqueOrThrow({
        where: { id: fixture.organizationId },
      }),
    ]);
    assert.equal(document.paperId, null);
    assert.equal(document.workspacePaperId, null);
    assert.equal(inbox.workspacePaperId, null);
    assert.equal(inbox.status, "NEEDS_REVIEW");
    assert.equal(organization.revision, 0);
    assert.equal(await prisma.idempotencyRecord.count({
      where: { organizationId: fixture.organizationId },
    }), 0);
  } finally {
    await cleanupFixtures([fixture]);
  }
});

test("unready, rejected, drifted, and missing-original validation targets cannot link", async () => {
  const fixture = await createWorkspace("validation-guards");
  try {
    const paper = await createPaperTarget(fixture, "validation-guards");
    const unready = await createValidatedDocument(fixture, "unready");
    await prisma.document.update({
      where: { id: unready.documentId },
      data: { status: "PENDING" },
    });

    const drifted = await createValidatedDocument(fixture, "drifted-hash");
    await prisma.asset.update({
      where: { id: drifted.assetId },
      data: { sha256: "f".repeat(64) },
    });

    const rejected = await createValidatedDocument(
      fixture,
      "rejected-attestation",
      "REJECTED",
    );
    const missingOriginal = await createValidatedDocument(
      fixture,
      "missing-original",
    );
    await prisma.documentAsset.deleteMany({
      where: {
        organizationId: fixture.organizationId,
        documentId: missingOriginal.documentId,
        role: "ORIGINAL",
      },
    });

    for (const [label, target] of [
      ["unready", unready],
      ["drifted", drifted],
      ["rejected", rejected],
      ["missing-original", missingOriginal],
    ] as const) {
      const result = await linkValidatedDocumentToWorkspacePaper(
        fixture.owner,
        fixture.organizationId,
        target.documentId,
        command(`document-link-${label}-${randomUUID()}`, paper.paperId),
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "validation");
        assert.equal(result.aggregateVersion, 0);
        assert.equal(result.message, "The document is not a current validated PDF source.");
      }
      const document = await prisma.document.findUniqueOrThrow({
        where: { id: target.documentId },
      });
      assert.equal(document.paperId, null);
      assert.equal(document.workspacePaperId, null);
    }
    assert.equal((await prisma.organization.findUniqueOrThrow({
      where: { id: fixture.organizationId },
    })).revision, 0);
    assert.equal(await prisma.provenanceRecord.count({
      where: {
        organizationId: fixture.organizationId,
        sourceProvider: "PaperPilot validated document link",
      },
    }), 0);
    assert.equal(await prisma.auditEvent.count({
      where: {
        organizationId: fixture.organizationId,
        action: "document.paper.linked",
      },
    }), 0);
  } finally {
    await cleanupFixtures([fixture]);
  }
});

test("relinking and an existing active PAPER_PDF both fail without version movement", async () => {
  const fixture = await createWorkspace("conflicts");
  try {
    const requestedPaper = await createPaperTarget(fixture, "requested-paper");
    const priorPaper = await createPaperTarget(fixture, "prior-paper");

    const alreadyLinked = await createValidatedDocument(fixture, "already-linked");
    await prisma.document.update({
      where: { id: alreadyLinked.documentId },
      data: {
        paperId: priorPaper.paperId,
        workspacePaperId: priorPaper.workspacePaperId,
      },
    });
    const relink = await linkValidatedDocumentToWorkspacePaper(
      fixture.owner,
      fixture.organizationId,
      alreadyLinked.documentId,
      command(`document-link-relink-${randomUUID()}`, requestedPaper.paperId),
    );
    assert.equal(relink.ok, false);
    if (!relink.ok) assert.equal(relink.code, "duplicate");

    const active = await createValidatedDocument(fixture, "active-paper-pdf");
    await prisma.document.update({
      where: { id: active.documentId },
      data: {
        paperId: requestedPaper.paperId,
        workspacePaperId: requestedPaper.workspacePaperId,
      },
    });
    const candidate = await createValidatedDocument(fixture, "active-candidate");
    const conflict = await linkValidatedDocumentToWorkspacePaper(
      fixture.owner,
      fixture.organizationId,
      candidate.documentId,
      command(`document-link-active-conflict-${randomUUID()}`, requestedPaper.paperId),
    );
    assert.equal(conflict.ok, false);
    if (!conflict.ok) {
      assert.equal(conflict.code, "duplicate");
      assert.equal(conflict.aggregateVersion, 0);
      assert.equal(
        conflict.message,
        "The document or paper already has an active PDF link.",
      );
    }
    const unchanged = await prisma.document.findUniqueOrThrow({
      where: { id: candidate.documentId },
    });
    assert.equal(unchanged.paperId, null);
    assert.equal(unchanged.workspacePaperId, null);
    assert.equal((await prisma.organization.findUniqueOrThrow({
      where: { id: fixture.organizationId },
    })).revision, 0);
    assert.equal(await prisma.idempotencyRecord.count({
      where: { organizationId: fixture.organizationId },
    }), 0);
  } finally {
    await cleanupFixtures([fixture]);
  }
});
