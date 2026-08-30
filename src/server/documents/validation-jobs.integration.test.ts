import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION } from "./extraction-config";
import type { DocumentTextExtractionAttestation } from "./extraction-contract";
import {
  claimNextDocumentTextExtractionJob,
  completeDocumentTextExtractionLease,
  failDocumentTextExtractionLease,
  heartbeatDocumentTextExtractionLease,
  type DocumentTextExtractionLease,
} from "./extraction-jobs";
import {
  DOCUMENT_VALIDATION_MAX_ATTEMPTS,
  DOCUMENT_VALIDATION_POLICY_VERSION,
  LOCAL_QUARANTINE_STORAGE_VERSION,
  claimNextDocumentValidationJob,
  completeDocumentValidationLease as completeDocumentValidationLeaseWithExtractionPin,
  documentValidationJobDedupeKey,
  enqueueDocumentValidationJob,
  failDocumentValidationLease,
  type DocumentValidationLease,
  type ValidatedDocumentAttestation,
} from "./validation-jobs";

const TEST_EPOCH = new Date("2001-01-01T00:00:00.000Z");
const LEASE_TTL_MS = 10_000;
const EXTRACTION_TOOLCHAIN_DIGEST = "e".repeat(64);

function completeDocumentValidationLease(
  input: Omit<Parameters<typeof completeDocumentValidationLeaseWithExtractionPin>[0], "extractionToolchainDigest">,
) {
  return completeDocumentValidationLeaseWithExtractionPin({
    ...input,
    extractionToolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
  });
}

interface ValidationTarget {
  organizationId: string;
  documentId: string;
  assetId: string;
  inboxEntryId: string;
  importBatchId: string;
  intakeId: string;
  uploadSessionId: string;
  objectKey: string;
  sha256: string;
  sizeBytes: bigint;
}

after(async () => {
  await prisma.$disconnect();
});

function plusMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

function testIdentity(label: string): { id: string; slug: string } {
  const suffix = randomUUID();
  return {
    id: `validation-it-${label}-${suffix}`,
    slug: `validation-it-${label}-${suffix}`,
  };
}

async function createOrganization(label: string): Promise<string> {
  const identity = testIdentity(label);
  const organization = await prisma.organization.create({
    data: {
      id: identity.id,
      name: `Validation integration ${label}`,
      slug: identity.slug,
    },
  });
  return organization.id;
}

async function createValidationTarget(
  organizationId: string,
  label: string,
): Promise<ValidationTarget> {
  const suffix = randomUUID();
  const documentId = `validation-document-${label}-${suffix}`;
  const assetId = `validation-asset-${label}-${suffix}`;
  const inboxEntryId = `validation-inbox-${label}-${suffix}`;
  const importBatchId = `validation-batch-${label}-${suffix}`;
  const intakeId = `validation-intake-${label}-${suffix}`;
  const uploadSessionId = `validation-upload-${label}-${suffix}`;
  const uploadAttemptId = `validation-upload-attempt-${label}-${suffix}`;
  const sha256 = createHash("sha256")
    .update(`${organizationId}:${label}:${suffix}`)
    .digest("hex");
  const requestHash = createHash("sha256")
    .update(`request:${organizationId}:${label}:${suffix}`)
    .digest("hex");
  const objectKey = `${LOCAL_QUARANTINE_STORAGE_VERSION}:${organizationId}:${assetId}`;
  const sizeBytes = 321n;

  await prisma.$transaction(async (transaction) => {
    await transaction.document.create({
      data: {
        id: documentId,
        organizationId,
        kind: "PAPER_PDF",
        status: "PENDING",
        title: `${label} validation target`,
        mimeType: "application/pdf",
        contentHash: sha256,
        metadata: {
          custody: "private-quarantine",
          verification: "queued",
        },
      },
    });
    await transaction.asset.create({
      data: {
        id: assetId,
        organizationId,
        storageProvider: "LOCAL",
        objectKey,
        physicalLocator: objectKey,
        status: "QUARANTINED",
        originalFileName: `${label}.pdf`,
        mimeType: "application/pdf",
        sizeBytes,
        sha256,
        metadata: {
          custody: "private-quarantine",
          publicAccess: false,
        },
      },
    });
    await transaction.documentAsset.create({
      data: {
        organizationId,
        documentId,
        assetId,
        role: "ORIGINAL",
      },
    });
    await transaction.importBatch.create({
      data: {
        id: importBatchId,
        organizationId,
        source: "FILE_UPLOAD",
        status: "RUNNING",
        label: "Authenticated PDF upload",
        externalRequestId: uploadSessionId,
        totalCount: 1,
        startedAt: TEST_EPOCH,
      },
    });
    await transaction.inboxEntry.create({
      data: {
        id: inboxEntryId,
        organizationId,
        importBatchId,
        documentId,
        source: "FILE_UPLOAD",
        sourceKey: `validation-inbox:${label}:${suffix}`,
        status: "NEEDS_REVIEW",
        proposedTitle: `${label} validation target`,
        payload: {
          schemaVersion: 1,
          kind: "document-upload",
          custody: "quarantined",
          verification: "queued",
        },
      },
    });
    await transaction.documentIntake.create({
      data: {
        id: intakeId,
        organizationId,
        source: "BROWSER_UPLOAD",
        status: "QUARANTINED",
        documentId,
        assetId,
        inboxEntryId,
        importBatchId,
        reservedBytes: sizeBytes,
        committedBytes: sizeBytes,
      },
    });
    await transaction.uploadSession.create({
      data: {
        id: uploadSessionId,
        organizationId,
        intakeId,
        assetId,
        documentId,
        inboxEntryId,
        clientOperationId: `validation-operation-${label}-${suffix}`,
        requestHash,
        status: "STORED",
        originalFileName: `${label}.pdf`,
        declaredMimeType: "application/pdf",
        expectedSizeBytes: sizeBytes,
        receivedSizeBytes: sizeBytes,
        sha256,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        storedAt: TEST_EPOCH,
        attemptCount: 1,
      },
    });
    await transaction.uploadAttempt.create({
      data: {
        id: uploadAttemptId,
        organizationId,
        uploadSessionId,
        assetId,
        attemptNumber: 1,
        storageKey: objectKey,
        status: "COMMITTED",
        expectedSizeBytes: sizeBytes,
        receivedSizeBytes: sizeBytes,
        sha256,
        leaseExpiresAt: TEST_EPOCH,
        storedAt: TEST_EPOCH,
        completedAt: TEST_EPOCH,
      },
    });
  });

  return {
    organizationId,
    documentId,
    assetId,
    inboxEntryId,
    importBatchId,
    intakeId,
    uploadSessionId,
    objectKey,
    sha256,
    sizeBytes,
  };
}

async function enqueueTarget(target: ValidationTarget, now = TEST_EPOCH) {
  return prisma.$transaction((transaction) =>
    enqueueDocumentValidationJob(transaction, {
      organizationId: target.organizationId,
      documentId: target.documentId,
      assetId: target.assetId,
      uploadSessionId: target.uploadSessionId,
      now,
    }));
}

async function cleanupOrganizations(organizationIds: string[]): Promise<void> {
  const where = { organizationId: { in: organizationIds } };
  await prisma.$transaction(async (transaction) => {
    await transaction.provenanceRecord.deleteMany({ where });
    await transaction.auditEvent.deleteMany({ where });
    // Immutable custody records are removed only through whole-tenant erasure.
    await transaction.organization.deleteMany({ where: { id: { in: organizationIds } } });
  });
}

function acceptedAttestation(
  lease: DocumentValidationLease,
  overrides: Partial<ValidatedDocumentAttestation> = {},
): ValidatedDocumentAttestation {
  return {
    inputSha256: lease.inputSha256,
    inputSizeBytes: lease.inputSizeBytes,
    storageVersion: lease.storageVersion,
    policyVersion: lease.policyVersion,
    toolchainDigest: "b".repeat(64),
    verdict: "ACCEPTED",
    rejectionCode: null,
    malwareVerdict: "CLEAN",
    malwareEngine: "clamav",
    malwareEngineVersion: "1.4.2",
    signatureVersion: "20261231",
    signaturePublishedAt: plusMilliseconds(TEST_EPOCH, -60_000),
    scannedAt: plusMilliseconds(TEST_EPOCH, 100),
    pdfStructuralVerdict: "VALID",
    pdfEngine: "qpdf",
    pdfEngineVersion: "11.9.1",
    pdfVersion: "1.7",
    pageCount: 7,
    objectCount: 42,
    revisionCount: 1,
    checkedAt: plusMilliseconds(TEST_EPOCH, 200),
    result: {
      schemaVersion: 1,
      detectionCount: 0,
      warningCount: 0,
      malwareDurationMs: 50,
      pdfDurationMs: 75,
      totalDurationMs: 125,
      completedAt: plusMilliseconds(TEST_EPOCH, 300).toISOString(),
    },
    ...overrides,
  };
}

function noTextExtractionAttestation(
  lease: DocumentTextExtractionLease,
  at: Date,
): DocumentTextExtractionAttestation {
  return {
    inputSha256: lease.inputSha256,
    inputSizeBytes: lease.inputSizeBytes,
    storageVersion: lease.storageVersion,
    policyVersion: lease.policyVersion,
    toolchainDigest: lease.toolchainDigest,
    verdict: "NO_TEXT",
    engine: "poppler",
    engineVersion: "24.02.0",
    pageCount: lease.expectedPageCount,
    chunkCount: 0,
    textBytes: 0,
    extractedAt: plusMilliseconds(at, 100),
    completedAt: plusMilliseconds(at, 200),
    durationMs: 100,
    totalDurationMs: 200,
    chunks: [],
  };
}

function claimExtraction(now: Date) {
  return claimNextDocumentTextExtractionJob({
    workerId: "browser-pipeline-extraction-worker",
    expectedPolicyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
    expectedToolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
    leaseTtlMs: LEASE_TTL_MS,
    now,
  });
}

function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2003";
}

test("enqueue is exactly idempotent for one upload target", async () => {
  const organizationId = await createOrganization("enqueue");
  try {
    const target = await createValidationTarget(organizationId, "enqueue");

    const first = await enqueueTarget(target);
    const replayed = await enqueueTarget(target);

    assert.equal(replayed.id, first.id);
    assert.equal(replayed.organizationId, organizationId);
    assert.equal(replayed.documentId, target.documentId);
    assert.equal(replayed.assetId, target.assetId);
    assert.equal(replayed.intakeId, target.intakeId);
    assert.equal(replayed.ingestReceiptId, target.uploadSessionId);
    assert.equal(replayed.dedupeKey, documentValidationJobDedupeKey(target.uploadSessionId));
    assert.deepEqual(replayed.payload, {
      schemaVersion: 2,
      policyVersion: DOCUMENT_VALIDATION_POLICY_VERSION,
      storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
      source: "document-ingest",
      ingestReceiptId: target.uploadSessionId,
    });
    assert.equal(await prisma.job.count({
      where: {
        organizationId,
        type: "DOCUMENT_VALIDATE",
        dedupeKey: documentValidationJobDedupeKey(target.uploadSessionId),
      },
    }), 1);

    await assert.rejects(
      prisma.$transaction((transaction) =>
        enqueueDocumentValidationJob(transaction, {
          organizationId,
          documentId: `different-${target.documentId}`,
          assetId: `different-${target.assetId}`,
          uploadSessionId: target.uploadSessionId,
          now: TEST_EPOCH,
        })),
    );
    assert.equal(await prisma.job.count({ where: { organizationId } }), 1);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("concurrent claim has one winner and moves the queued target into scanning", async () => {
  const organizationId = await createOrganization("concurrent-claim");
  try {
    const target = await createValidationTarget(organizationId, "concurrent-claim");
    const job = await enqueueTarget(target);

    const claims = await Promise.all([
      claimNextDocumentValidationJob({
        workerId: "validation-worker-a",
        leaseTtlMs: LEASE_TTL_MS,
        now: TEST_EPOCH,
      }),
      claimNextDocumentValidationJob({
        workerId: "validation-worker-b",
        leaseTtlMs: LEASE_TTL_MS,
        now: TEST_EPOCH,
      }),
    ]);
    const winners = claims.filter((claim): claim is DocumentValidationLease => claim !== null);

    assert.equal(winners.length, 1);
    assert.equal(winners[0].jobId, job.id);
    assert.equal(winners[0].attemptNumber, 1);
    assert.equal(winners[0].inputSha256, target.sha256);
    assert.equal(winners[0].inputSizeBytes, target.sizeBytes);
    assert.equal(winners[0].storageKey, target.objectKey);
    assert.equal(winners[0].intakeId, target.intakeId);

    const [storedJob, attempt, asset, document] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.jobAttempt.findFirstOrThrow({ where: { jobId: job.id } }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
    ]);
    assert.equal(storedJob.status, "RUNNING");
    assert.equal(storedJob.attempts, 1);
    assert.equal(storedJob.leaseId, winners[0].leaseId);
    assert.equal(attempt.status, "RUNNING");
    assert.equal(attempt.workerId, winners[0].workerId);
    assert.equal(attempt.leaseId, winners[0].leaseId);
    assert.equal(asset.status, "SCANNING");
    assert.equal(document.status, "PROCESSING");
    assert.equal(await prisma.jobAttempt.count({ where: { jobId: job.id } }), 1);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("retryable failure restores quarantine and only the next due claim can run", async () => {
  const organizationId = await createOrganization("retry");
  try {
    const target = await createValidationTarget(organizationId, "retry");
    const job = await enqueueTarget(target);
    const firstLease = await claimNextDocumentValidationJob({
      workerId: "validation-retry-worker-1",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(firstLease);

    const failureAt = plusMilliseconds(TEST_EPOCH, 1_000);
    assert.equal(await failDocumentValidationLease({
      lease: firstLease,
      code: "validation_service_timeout",
      retryable: true,
      now: failureAt,
    }), "retrying");

    const [retryingJob, failedAttempt, quarantinedAsset, pendingDocument, validatingIntake] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.jobAttempt.findUniqueOrThrow({ where: { id: firstLease.jobAttemptId } }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
    ]);
    assert.equal(retryingJob.status, "RETRYING");
    assert.equal(retryingJob.lastErrorCode, "validation_service_timeout");
    assert.equal(retryingJob.runAfter.toISOString(), plusMilliseconds(failureAt, 5_000).toISOString());
    assert.equal(failedAttempt.status, "FAILED");
    assert.equal(quarantinedAsset.status, "QUARANTINED");
    assert.equal(pendingDocument.status, "PENDING");
    assert.equal(validatingIntake.status, "VALIDATING");
    assert.equal(validatingIntake.completedAt, null);

    assert.equal(await claimNextDocumentValidationJob({
      workerId: "validation-retry-worker-early",
      leaseTtlMs: LEASE_TTL_MS,
      now: plusMilliseconds(retryingJob.runAfter, -1),
    }), null);

    const nextLease = await claimNextDocumentValidationJob({
      workerId: "validation-retry-worker-2",
      leaseTtlMs: LEASE_TTL_MS,
      now: retryingJob.runAfter,
    });
    assert.ok(nextLease);
    assert.equal(nextLease.jobId, job.id);
    assert.equal(nextLease.attemptNumber, 2);
    assert.notEqual(nextLease.leaseId, firstLease.leaseId);
    assert.equal((await prisma.asset.findUniqueOrThrow({
      where: { id: target.assetId },
    })).status, "SCANNING");
    assert.equal((await prisma.document.findUniqueOrThrow({
      where: { id: target.documentId },
    })).status, "PROCESSING");
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("an expired lease is fenced and cannot complete after the target is reclaimed", async () => {
  const organizationId = await createOrganization("stale-lease");
  try {
    const target = await createValidationTarget(organizationId, "stale-lease");
    const job = await enqueueTarget(target);
    const staleLease = await claimNextDocumentValidationJob({
      workerId: "validation-stale-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(staleLease);

    const reclaimedLease = await claimNextDocumentValidationJob({
      workerId: "validation-reclaim-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: staleLease.leaseExpiresAt,
    });
    assert.ok(reclaimedLease);
    assert.equal(reclaimedLease.jobId, job.id);
    assert.equal(reclaimedLease.attemptNumber, 2);
    assert.notEqual(reclaimedLease.leaseId, staleLease.leaseId);

    assert.equal(await completeDocumentValidationLease({
      lease: staleLease,
      attestation: acceptedAttestation(staleLease),
      now: plusMilliseconds(staleLease.leaseExpiresAt, 1),
    }), null);

    const [staleAttempt, currentJob, asset, document] = await Promise.all([
      prisma.jobAttempt.findUniqueOrThrow({ where: { id: staleLease.jobAttemptId } }),
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
    ]);
    assert.equal(staleAttempt.status, "FAILED");
    assert.equal(staleAttempt.errorCode, "worker_lease_expired");
    assert.equal(currentJob.status, "RUNNING");
    assert.equal(currentJob.leaseId, reclaimedLease.leaseId);
    assert.equal(asset.status, "SCANNING");
    assert.equal(document.status, "PROCESSING");
    assert.equal(await prisma.documentValidationAttestation.count({
      where: { organizationId },
    }), 0);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("accepted completion atomically records one immutable attestation and promotes readiness", async () => {
  const organizationId = await createOrganization("accepted");
  try {
    const target = await createValidationTarget(organizationId, "accepted");
    const job = await enqueueTarget(target);
    const lease = await claimNextDocumentValidationJob({
      workerId: "validation-accepted-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(lease);
    const attestation = acceptedAttestation(lease);

    assert.deepEqual(await completeDocumentValidationLease({
      lease,
      attestation,
      now: plusMilliseconds(TEST_EPOCH, 1_000),
    }), { outcome: "applied", verdict: "ACCEPTED" });
    assert.deepEqual(await completeDocumentValidationLease({
      lease,
      attestation,
      now: plusMilliseconds(TEST_EPOCH, 1_001),
    }), { outcome: "replayed", verdict: "ACCEPTED" });
    assert.equal(await completeDocumentValidationLease({
      lease: { ...lease, intakeId: `different-${lease.intakeId}` },
      attestation,
      now: plusMilliseconds(TEST_EPOCH, 1_002),
    }), null);

    const differentToolchain = acceptedAttestation(lease, {
      toolchainDigest: "c".repeat(64),
    });
    assert.equal(await completeDocumentValidationLease({
      lease,
      attestation: differentToolchain,
      now: plusMilliseconds(TEST_EPOCH, 1_003),
    }), null);

    const [storedJob, attempt, asset, document, intake, attestations, inbox, extractionJobs] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.jobAttempt.findUniqueOrThrow({ where: { id: lease.jobAttemptId } }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
      prisma.documentValidationAttestation.findMany({ where: { jobId: job.id } }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: target.inboxEntryId } }),
      prisma.job.findMany({
        where: {
          organizationId,
          type: "TEXT_EXTRACTION",
          documentId: target.documentId,
          assetId: target.assetId,
        },
      }),
    ]);
    assert.equal(storedJob.status, "SUCCEEDED");
    assert.equal(storedJob.completedAt?.toISOString(), plusMilliseconds(TEST_EPOCH, 1_000).toISOString());
    assert.equal(attempt.status, "SUCCEEDED");
    assert.equal(asset.status, "READY");
    assert.equal(asset.scannedAt?.toISOString(), attestation.scannedAt.toISOString());
    assert.equal(asset.validationPolicyVersion, DOCUMENT_VALIDATION_POLICY_VERSION);
    assert.equal(document.status, "READY");
    assert.equal(document.pageCount, attestation.pageCount);
    assert.equal(document.validatedAt?.toISOString(), attestation.checkedAt.toISOString());
    assert.equal(intake.status, "EXTRACTING");
    assert.equal(intake.completedAt, null);
    assert.equal(intake.failureCode, null);
    assert.equal(intake.quotaReleasedAt, null);
    assert.equal(inbox.status, "NEEDS_REVIEW");
    assert.equal(attestations.length, 1);
    assert.equal(attestations[0].jobAttemptId, lease.jobAttemptId);
    assert.equal(attestations[0].toolchainDigest, attestation.toolchainDigest);
    assert.equal(attestations[0].verdict, "ACCEPTED");
    assert.equal(extractionJobs.length, 1);
    assert.equal(extractionJobs[0].status, "QUEUED");
    assert.equal(extractionJobs[0].intakeId, target.intakeId);
    assert.equal(extractionJobs[0].ingestReceiptId, target.uploadSessionId);
    assert.equal(extractionJobs[0].attempts, 0);
    assert.equal(
      extractionJobs[0].dedupeKey,
      `accepted-validation:${attestations[0].id}:${DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION}:${EXTRACTION_TOOLCHAIN_DIGEST}`,
    );
    assert.deepEqual(extractionJobs[0].payload, {
      schemaVersion: 1,
      source: "accepted-document-validation",
      validationAttestationId: attestations[0].id,
      policyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
      storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
      toolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
    });
    assert.equal(await prisma.provenanceRecord.count({
      where: { organizationId, documentId: target.documentId },
    }), 1);
    assert.equal(await prisma.auditEvent.count({
      where: { organizationId, action: "document.validation.accepted" },
    }), 1);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("browser intake stays RUNNING through validation and closes READY after extraction", async () => {
  const organizationId = await createOrganization("browser-ready");
  try {
    const target = await createValidationTarget(organizationId, "browser-ready");
    const validationJob = await enqueueTarget(target);
    const validationLease = await claimNextDocumentValidationJob({
      workerId: "browser-ready-validation-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(validationLease);
    assert.deepEqual(await completeDocumentValidationLease({
      lease: validationLease,
      attestation: acceptedAttestation(validationLease),
      now: plusMilliseconds(TEST_EPOCH, 1_000),
    }), { outcome: "applied", verdict: "ACCEPTED" });

    const extractionJob = await prisma.job.findFirstOrThrow({
      where: {
        organizationId,
        type: "TEXT_EXTRACTION",
        documentId: target.documentId,
      },
    });
    assert.equal(extractionJob.intakeId, target.intakeId);
    assert.equal(extractionJob.ingestReceiptId, target.uploadSessionId);
    let [intake, batch] = await Promise.all([
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
      prisma.importBatch.findUniqueOrThrow({ where: { id: target.importBatchId } }),
    ]);
    assert.equal(intake.status, "EXTRACTING");
    assert.equal(batch.status, "RUNNING");
    assert.equal(batch.processedCount, 0);

    const extractionLease = await claimExtraction(extractionJob.runAfter);
    assert.ok(extractionLease);
    assert.equal(extractionLease.intakeId, target.intakeId);
    assert.equal(extractionLease.ingestReceiptId, target.uploadSessionId);
    assert.equal(await heartbeatDocumentTextExtractionLease({
      lease: { ...extractionLease, intakeId: `forged-${target.intakeId}` },
      leaseTtlMs: LEASE_TTL_MS,
      now: plusMilliseconds(extractionJob.runAfter, 10),
    }), false);

    const completedAt = plusMilliseconds(extractionJob.runAfter, 1_000);
    assert.equal((await completeDocumentTextExtractionLease({
      lease: extractionLease,
      attestation: noTextExtractionAttestation(extractionLease, extractionJob.runAfter),
      now: completedAt,
    }))?.outcome, "applied");
    [intake, batch] = await Promise.all([
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
      prisma.importBatch.findUniqueOrThrow({ where: { id: target.importBatchId } }),
    ]);
    assert.equal(intake.status, "READY");
    assert.equal(intake.completedAt?.toISOString(), completedAt.toISOString());
    assert.equal(intake.quotaReleasedAt, null);
    assert.equal(batch.status, "SUCCEEDED");
    assert.equal(batch.processedCount, 1);
    assert.equal(batch.successCount, 1);
    assert.equal((await prisma.job.findUniqueOrThrow({
      where: { id: validationJob.id },
    })).status, "SUCCEEDED");
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("browser extraction dead-letter projects ATTENTION without closing the intake", async () => {
  const organizationId = await createOrganization("browser-attention");
  try {
    const target = await createValidationTarget(organizationId, "browser-attention");
    await enqueueTarget(target);
    const validationLease = await claimNextDocumentValidationJob({
      workerId: "browser-attention-validation-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(validationLease);
    await completeDocumentValidationLease({
      lease: validationLease,
      attestation: acceptedAttestation(validationLease),
      now: plusMilliseconds(TEST_EPOCH, 1_000),
    });
    const extractionJob = await prisma.job.findFirstOrThrow({
      where: { organizationId, type: "TEXT_EXTRACTION", documentId: target.documentId },
    });
    const extractionLease = await claimExtraction(extractionJob.runAfter);
    assert.ok(extractionLease);
    assert.equal(await failDocumentTextExtractionLease({
      lease: { ...extractionLease, jobAttemptId: `forged-${extractionLease.jobAttemptId}` },
      code: "extraction_response_invalid",
      retryable: false,
      now: plusMilliseconds(extractionJob.runAfter, 500),
    }), "lease-lost");
    assert.equal((await prisma.documentIntake.findUniqueOrThrow({
      where: { id: target.intakeId },
    })).status, "EXTRACTING");

    assert.equal(await failDocumentTextExtractionLease({
      lease: extractionLease,
      code: "extraction_response_invalid",
      retryable: false,
      now: plusMilliseconds(extractionJob.runAfter, 1_000),
    }), "dead-letter");
    const [intake, batch, inbox] = await Promise.all([
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
      prisma.importBatch.findUniqueOrThrow({ where: { id: target.importBatchId } }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: target.inboxEntryId } }),
    ]);
    assert.equal(intake.status, "ATTENTION");
    assert.equal(intake.completedAt, null);
    assert.equal(intake.failureCode, "extraction_response_invalid");
    assert.equal(intake.quotaReleasedAt, null);
    assert.equal(batch.status, "PARTIAL");
    assert.equal(inbox.status, "NEEDS_REVIEW");
    assert.equal(inbox.failureCode, "extraction_response_invalid");
    assert.deepEqual(inbox.payload, {
      schemaVersion: 1,
      kind: "document-upload",
      custody: "validated",
      verification: "accepted",
      extraction: "attention",
    });
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("rejected attestation rejects the asset and fails the document", async () => {
  const organizationId = await createOrganization("rejected");
  try {
    const target = await createValidationTarget(organizationId, "rejected");
    const job = await enqueueTarget(target);
    const lease = await claimNextDocumentValidationJob({
      workerId: "validation-rejected-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(lease);
    const attestation = acceptedAttestation(lease, {
      verdict: "REJECTED",
      rejectionCode: "pdf_policy_violation",
      pageCount: null,
    });

    assert.deepEqual(await completeDocumentValidationLease({
      lease,
      attestation,
      now: plusMilliseconds(TEST_EPOCH, 1_000),
    }), { outcome: "applied", verdict: "REJECTED" });

    const [storedJob, asset, document, intake, storedAttestation, inbox] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
      prisma.documentValidationAttestation.findUniqueOrThrow({
        where: { jobAttemptId: lease.jobAttemptId },
      }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: target.inboxEntryId } }),
    ]);
    assert.equal(storedJob.status, "SUCCEEDED");
    assert.equal(asset.status, "REJECTED");
    assert.equal(asset.rejectionCode, "pdf_policy_violation");
    assert.equal(document.status, "FAILED");
    assert.equal(document.failureCode, "pdf_policy_violation");
    assert.equal(intake.status, "FAILED");
    assert.equal(intake.failureCode, "pdf_policy_violation");
    assert.ok(intake.completedAt);
    assert.equal(intake.quotaReleasedAt, null);
    assert.equal(storedAttestation.verdict, "REJECTED");
    assert.equal(storedAttestation.rejectionCode, "pdf_policy_violation");
    assert.equal(inbox.status, "FAILED");
    assert.equal(inbox.failureCode, "pdf_policy_violation");
    assert.equal(await prisma.job.count({
      where: {
        organizationId,
        type: "TEXT_EXTRACTION",
        documentId: target.documentId,
      },
    }), 0);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("rejected completion preserves exact validator evidence while public state stays canonical", async () => {
  const organizationId = await createOrganization("rejected-evidence");
  try {
    const target = await createValidationTarget(organizationId, "rejected-evidence");
    const job = await enqueueTarget(target);
    const lease = await claimNextDocumentValidationJob({
      workerId: "validation-rejected-evidence-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(lease);
    const attestation = acceptedAttestation(lease, {
      verdict: "REJECTED",
      rejectionCode: "pdf_resource_limit_exceeded",
      pdfStructuralVerdict: "INVALID",
      pdfVersion: "unknown",
      pageCount: null,
      objectCount: null,
      revisionCount: null,
    });

    assert.deepEqual(await completeDocumentValidationLease({
      lease,
      attestation,
      now: plusMilliseconds(TEST_EPOCH, 1_000),
    }), { outcome: "applied", verdict: "REJECTED" });
    assert.deepEqual(await completeDocumentValidationLease({
      lease,
      attestation,
      now: plusMilliseconds(TEST_EPOCH, 1_001),
    }), { outcome: "replayed", verdict: "REJECTED" });

    const conflictingReplay = acceptedAttestation(lease, {
      ...attestation,
      rejectionCode: "pdf_invalid",
    });
    assert.equal(await completeDocumentValidationLease({
      lease,
      attestation: conflictingReplay,
      now: plusMilliseconds(TEST_EPOCH, 1_002),
    }), null);

    const [storedJob, asset, document, storedAttestation, inbox] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
      prisma.documentValidationAttestation.findUniqueOrThrow({
        where: { jobAttemptId: lease.jobAttemptId },
      }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: target.inboxEntryId } }),
    ]);
    assert.equal(storedJob.status, "SUCCEEDED");
    assert.deepEqual(storedJob.result, {
      schemaVersion: 1,
      verdict: "REJECTED",
      rejectionCode: "invalid_pdf_structure",
    });
    assert.equal(asset.rejectionCode, "invalid_pdf_structure");
    assert.equal(document.failureCode, "invalid_pdf_structure");
    assert.equal(inbox.failureCode, "invalid_pdf_structure");
    assert.equal(storedAttestation.rejectionCode, "pdf_resource_limit_exceeded");
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("tenant keys reject foreign targets and a cross-target job is never claimed", async () => {
  const organizationA = await createOrganization("tenant-a");
  const organizationB = await createOrganization("tenant-b");
  try {
    const targetA = await createValidationTarget(organizationA, "tenant-a-primary");
    const otherTargetA = await createValidationTarget(organizationA, "tenant-a-other");
    const targetB = await createValidationTarget(organizationB, "tenant-b");

    await assert.rejects(
      prisma.$transaction((transaction) =>
        enqueueDocumentValidationJob(transaction, {
          organizationId: organizationA,
          documentId: targetB.documentId,
          assetId: targetB.assetId,
          uploadSessionId: targetB.uploadSessionId,
          now: TEST_EPOCH,
        })),
    );
    assert.equal(await prisma.job.count({ where: { organizationId: organizationA } }), 0);

    const authorityJob = await enqueueTarget(otherTargetA);
    await prisma.job.delete({ where: { id: authorityJob.id } });
    await assert.rejects(
      () => prisma.job.create({
        data: {
          organizationId: organizationA,
          type: "DOCUMENT_VALIDATE",
          status: "QUEUED",
          dedupeKey: documentValidationJobDedupeKey(`cross-target-${randomUUID()}`),
          priority: 100,
          payload: {
            schemaVersion: 2,
            policyVersion: DOCUMENT_VALIDATION_POLICY_VERSION,
            storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
            source: "document-ingest",
            ingestReceiptId: otherTargetA.uploadSessionId,
          },
          attempts: 0,
          maxAttempts: DOCUMENT_VALIDATION_MAX_ATTEMPTS,
          runAfter: TEST_EPOCH,
          documentId: targetA.documentId,
          assetId: otherTargetA.assetId,
          intakeId: otherTargetA.intakeId,
          ingestReceiptId: otherTargetA.uploadSessionId,
        },
      }),
      isForeignKeyViolation,
    );

    assert.equal(await claimNextDocumentValidationJob({
      workerId: "validation-cross-target-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    }), null);

    const [
      primaryAsset,
      primaryDocument,
      otherAsset,
      otherDocument,
      foreignAsset,
      foreignDocument,
    ] =
      await Promise.all([
        prisma.asset.findUniqueOrThrow({ where: { id: targetA.assetId } }),
        prisma.document.findUniqueOrThrow({ where: { id: targetA.documentId } }),
        prisma.asset.findUniqueOrThrow({ where: { id: otherTargetA.assetId } }),
        prisma.document.findUniqueOrThrow({ where: { id: otherTargetA.documentId } }),
        prisma.asset.findUniqueOrThrow({ where: { id: targetB.assetId } }),
        prisma.document.findUniqueOrThrow({ where: { id: targetB.documentId } }),
      ]);
    assert.equal(await prisma.job.count({ where: { organizationId: organizationA } }), 0);
    assert.equal(primaryAsset.status, "QUARANTINED");
    assert.equal(primaryDocument.status, "PENDING");
    assert.equal(otherAsset.status, "QUARANTINED");
    assert.equal(otherDocument.status, "PENDING");
    assert.equal(foreignAsset.status, "QUARANTINED");
    assert.equal(foreignDocument.status, "PENDING");
  } finally {
    await cleanupOrganizations([organizationA, organizationB]);
  }
});

test("retryable failures dead-letter exactly at the attempt budget", async () => {
  const organizationId = await createOrganization("dead-letter");
  try {
    const target = await createValidationTarget(organizationId, "dead-letter");
    const job = await enqueueTarget(target);
    let dueAt = TEST_EPOCH;

    for (let attemptNumber = 1; attemptNumber <= DOCUMENT_VALIDATION_MAX_ATTEMPTS; attemptNumber += 1) {
      const lease = await claimNextDocumentValidationJob({
        workerId: `validation-budget-worker-${attemptNumber}`,
        leaseTtlMs: LEASE_TTL_MS,
        now: dueAt,
      });
      assert.ok(lease);
      assert.equal(lease.jobId, job.id);
      assert.equal(lease.attemptNumber, attemptNumber);

      const result = await failDocumentValidationLease({
        lease,
        code: "validation_service_unavailable",
        retryable: true,
        now: plusMilliseconds(dueAt, 1_000),
      });
      if (attemptNumber < DOCUMENT_VALIDATION_MAX_ATTEMPTS) {
        assert.equal(result, "retrying");
        const retrying = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        assert.equal(retrying.status, "RETRYING");
        dueAt = retrying.runAfter;
      } else {
        assert.equal(result, "dead-letter");
      }
    }

    const [deadLetteredJob, attempts, asset, document, intake, inbox] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.jobAttempt.findMany({
        where: { jobId: job.id },
        orderBy: { attemptNumber: "asc" },
      }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: target.inboxEntryId } }),
    ]);
    assert.equal(deadLetteredJob.status, "DEAD_LETTER");
    assert.equal(deadLetteredJob.attempts, DOCUMENT_VALIDATION_MAX_ATTEMPTS);
    assert.equal(deadLetteredJob.lastErrorCode, "validation_service_unavailable");
    assert.equal(attempts.length, DOCUMENT_VALIDATION_MAX_ATTEMPTS);
    assert.deepEqual(
      attempts.map((attempt) => attempt.status),
      ["FAILED", "FAILED", "FAILED", "DEAD_LETTER"],
    );
    assert.equal(asset.status, "QUARANTINED");
    assert.equal(document.status, "FAILED");
    assert.equal(document.failureCode, "validation_unavailable");
    assert.equal(intake.status, "FAILED");
    assert.equal(intake.failureCode, "validation_unavailable");
    assert.ok(intake.completedAt);
    assert.equal(intake.quotaReleasedAt, null);
    assert.equal(inbox.status, "FAILED");
    assert.equal(inbox.failureCode, "validation_unavailable");
    assert.equal(await prisma.documentValidationAttestation.count({
      where: { organizationId },
    }), 0);
    assert.equal(await prisma.auditEvent.count({
      where: { organizationId, action: "document.validation.dead_lettered" },
    }), 1);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});
