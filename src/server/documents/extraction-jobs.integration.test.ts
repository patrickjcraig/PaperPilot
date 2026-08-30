import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  DOCUMENT_VALIDATION_POLICY_VERSION,
  LOCAL_QUARANTINE_STORAGE_VERSION,
} from "./validation-jobs";
import { DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION } from "./extraction-config";
import type { DocumentTextExtractionAttestation } from "./extraction-contract";
import {
  DEFAULT_DOCUMENT_TEXT_EXTRACTION_LEASE_TTL_MS,
  DOCUMENT_TEXT_EXTRACTION_ADMISSION_RETRY_DELAY_MS,
  claimNextDocumentTextExtractionJob as claimNextDocumentTextExtractionJobWithPin,
  completeDocumentTextExtractionLease,
  documentTextExtractionJobDedupeKey,
  deferDocumentTextExtractionLeaseBeforeAdmission,
  enqueueDocumentTextExtractionJob,
  failDocumentTextExtractionLease,
  heartbeatDocumentTextExtractionLease,
  type DocumentTextExtractionLease,
} from "./extraction-jobs";

const TEST_EPOCH = new Date("2002-01-01T00:00:00.000Z");
const LEASE_TTL_MS = 10_000;
const EXTRACTION_TOOLCHAIN_DIGEST = "c".repeat(64);

function claimNextDocumentTextExtractionJob(
  input: Omit<
    Parameters<typeof claimNextDocumentTextExtractionJobWithPin>[0],
    "expectedPolicyVersion" | "expectedToolchainDigest"
  >,
) {
  return claimNextDocumentTextExtractionJobWithPin({
    ...input,
    expectedPolicyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
    expectedToolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
  });
}

interface ExtractionTarget {
  organizationId: string;
  documentId: string;
  assetId: string;
  intakeId: string;
  ingestReceiptId: string;
  validationJobId: string;
  validationJobAttemptId: string;
  validationAttestationId: string;
  sha256: string;
  sizeBytes: bigint;
  storageVersion: string;
  scannedAt: Date;
  validatedAt: Date;
  validationPolicyVersion: string;
}

after(async () => {
  await prisma.$disconnect();
});

function plusMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

async function createOrganization(label: string): Promise<string> {
  const suffix = randomUUID();
  const id = `extraction-it-${label}-${suffix}`;
  await prisma.organization.create({
    data: {
      id,
      name: `Extraction integration ${label}`,
      slug: id,
    },
  });
  return id;
}

async function createExtractionTarget(
  organizationId: string,
  label: string,
  verdict: "ACCEPTED" | "REJECTED" = "ACCEPTED",
): Promise<ExtractionTarget> {
  const suffix = randomUUID();
  const documentId = `extraction-document-${label}-${suffix}`;
  const assetId = `extraction-asset-${label}-${suffix}`;
  const intakeId = `extraction-intake-${label}-${suffix}`;
  const ingressJobId = `extraction-ingress-job-${label}-${suffix}`;
  const ingressJobAttemptId = `extraction-ingress-job-attempt-${label}-${suffix}`;
  const ingressAttemptId = `extraction-ingress-attempt-${label}-${suffix}`;
  const ingestReceiptId = `extraction-ingest-${label}-${suffix}`;
  const validationJobId = `extraction-validation-job-${label}-${suffix}`;
  const validationJobAttemptId = `extraction-validation-attempt-${label}-${suffix}`;
  const validationAttestationId = `extraction-validation-attestation-${label}-${suffix}`;
  const sha256 = createHash("sha256")
    .update(`${organizationId}:${label}:${suffix}`)
    .digest("hex");
  const computedMd5 = createHash("md5")
    .update(`${organizationId}:${label}:${suffix}`)
    .digest("hex");
  const sizeBytes = 987n;
  const scannedAt = plusMilliseconds(TEST_EPOCH, -2_000);
  const validatedAt = plusMilliseconds(TEST_EPOCH, -1_000);
  const objectKey = `${LOCAL_QUARANTINE_STORAGE_VERSION}:${organizationId}:${assetId}`;

  await prisma.$transaction(async (transaction) => {
    await transaction.document.create({
      data: {
        id: documentId,
        organizationId,
        kind: "PAPER_PDF",
        status: "READY",
        title: `${label} extraction target`,
        mimeType: "application/pdf",
        pageCount: 3,
        contentHash: sha256,
        validatedAt,
        validationPolicyVersion: DOCUMENT_VALIDATION_POLICY_VERSION,
        metadata: {
          custody: "private-validated",
          verification: "accepted",
          extraction: "not-started",
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
        status: "READY",
        originalFileName: `${label}.pdf`,
        mimeType: "application/pdf",
        sizeBytes,
        sha256,
        scannedAt,
        validatedAt,
        validationPolicyVersion: DOCUMENT_VALIDATION_POLICY_VERSION,
        metadata: {
          custody: "private-validated",
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
    await transaction.documentIntake.create({
      data: {
        id: intakeId,
        organizationId,
        source: "WEB_MCP",
        status: "EXTRACTING",
        documentId,
        assetId,
        reservedBytes: sizeBytes,
        committedBytes: sizeBytes,
      },
    });
    await transaction.job.create({
      data: {
        id: ingressJobId,
        organizationId,
        type: "DOCUMENT_DOWNLOAD",
        status: "SUCCEEDED",
        dedupeKey: `extraction-ingress:${label}:${suffix}`,
        attempts: 1,
        maxAttempts: 3,
        runAfter: plusMilliseconds(TEST_EPOCH, -6_000),
        completedAt: scannedAt,
        documentId,
        assetId,
        intakeId,
      },
    });
    await transaction.jobAttempt.create({
      data: {
        id: ingressJobAttemptId,
        organizationId,
        jobId: ingressJobId,
        attemptNumber: 1,
        status: "SUCCEEDED",
        startedAt: plusMilliseconds(scannedAt, -1_000),
        completedAt: scannedAt,
      },
    });
    await transaction.documentIngressAttempt.create({
      data: {
        id: ingressAttemptId,
        organizationId,
        intakeId,
        documentId,
        assetId,
        jobId: ingressJobId,
        jobAttemptId: ingressJobAttemptId,
        attemptNumber: 1,
        storageKey: objectKey,
        storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
        status: "ADOPTED",
        maximumSizeBytes: sizeBytes,
        expectedSizeBytes: sizeBytes,
        receivedSizeBytes: sizeBytes,
        computedMd5,
        sha256,
        leaseId: `extraction-ingress-lease-${suffix}`,
        leaseExpiresAt: scannedAt,
        storedAt: scannedAt,
        completedAt: scannedAt,
      },
    });
    await transaction.documentIngestReceipt.create({
      data: {
        id: ingestReceiptId,
        organizationId,
        source: "WEB_MCP",
        sourceFingerprint: `test-extraction:${label}:${suffix}`,
        intakeId,
        assetId,
        documentId,
        ingressAttemptId,
        declaredMimeType: "application/pdf",
        receivedSizeBytes: sizeBytes,
        sha256,
        storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
        storedAt: scannedAt,
      },
    });
    await transaction.job.create({
      data: {
        id: validationJobId,
        organizationId,
        type: "DOCUMENT_VALIDATE",
        status: "SUCCEEDED",
        dedupeKey: `extraction-fixture-validation:${suffix}`,
        attempts: 1,
        maxAttempts: 4,
        runAfter: plusMilliseconds(TEST_EPOCH, -5_000),
        completedAt: validatedAt,
        documentId,
        assetId,
        intakeId,
        ingestReceiptId,
        payload: {
          schemaVersion: 2,
          policyVersion: DOCUMENT_VALIDATION_POLICY_VERSION,
          storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
          source: "document-ingest",
          ingestReceiptId,
        },
        result: {
          schemaVersion: 1,
          verdict,
        },
      },
    });
    await transaction.jobAttempt.create({
      data: {
        id: validationJobAttemptId,
        organizationId,
        jobId: validationJobId,
        attemptNumber: 1,
        status: "SUCCEEDED",
        startedAt: plusMilliseconds(TEST_EPOCH, -3_000),
        completedAt: validatedAt,
        result: {
          schemaVersion: 1,
          verdict,
        },
      },
    });
    await transaction.documentValidationAttestation.create({
      data: {
        id: validationAttestationId,
        organizationId,
        jobId: validationJobId,
        jobAttemptId: validationJobAttemptId,
        assetId,
        documentId,
        ingestReceiptId,
        inputSha256: sha256,
        inputSizeBytes: sizeBytes,
        storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
        policyVersion: DOCUMENT_VALIDATION_POLICY_VERSION,
        toolchainDigest: createHash("sha256")
          .update(`validator:${organizationId}:${label}:${suffix}`)
          .digest("hex"),
        verdict,
        rejectionCode: verdict === "ACCEPTED" ? null : "pdf_policy_violation",
        malwareVerdict: "CLEAN",
        malwareEngine: "clamav",
        malwareEngineVersion: "1.4.2",
        signatureVersion: "20261231",
        signaturePublishedAt: plusMilliseconds(TEST_EPOCH, -60_000),
        scannedAt,
        pdfStructuralVerdict: "VALID",
        pdfEngine: "qpdf",
        pdfEngineVersion: "11.9.1",
        pdfVersion: "1.7",
        pageCount: 3,
        objectCount: 42,
        revisionCount: 1,
        checkedAt: validatedAt,
        result: {
          schemaVersion: 1,
          detectionCount: 0,
          warningCount: 0,
          malwareDurationMs: 10,
          pdfDurationMs: 20,
          totalDurationMs: 25,
          completedAt: plusMilliseconds(validatedAt, 25).toISOString(),
        },
      },
    });
  });

  return {
    organizationId,
    documentId,
    assetId,
    intakeId,
    ingestReceiptId,
    validationJobId,
    validationJobAttemptId,
    validationAttestationId,
    sha256,
    sizeBytes,
    storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
    scannedAt,
    validatedAt,
    validationPolicyVersion: DOCUMENT_VALIDATION_POLICY_VERSION,
  };
}

async function enqueueTarget(target: ExtractionTarget, now = TEST_EPOCH) {
  return prisma.$transaction((transaction) =>
    enqueueDocumentTextExtractionJob(transaction, {
      organizationId: target.organizationId,
      documentId: target.documentId,
      assetId: target.assetId,
      validationAttestationId: target.validationAttestationId,
      toolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
      now,
    }));
}

async function cleanupOrganizations(organizationIds: string[]): Promise<void> {
  const where = { organizationId: { in: organizationIds } };
  await prisma.$transaction(async (transaction) => {
    await transaction.provenanceRecord.deleteMany({ where });
    await transaction.auditEvent.deleteMany({ where });
    // Extraction evidence and owned chunks are immutable to direct DML. Tenant
    // erasure is the intentional cleanup path and cascades through their graph.
    await transaction.organization.deleteMany({ where: { id: { in: organizationIds } } });
  });
}

function extractedAttestation(
  lease: DocumentTextExtractionLease,
  overrides: Partial<DocumentTextExtractionAttestation> = {},
): DocumentTextExtractionAttestation {
  const chunks = [
    { sequence: 0, pageNumber: 1, paragraphId: "p1-p1", text: "First paragraph" },
    { sequence: 1, pageNumber: 1, paragraphId: "p1-p2", text: "Second paragraph" },
    { sequence: 2, pageNumber: 2, paragraphId: "p2-p1", text: "Third paragraph" },
  ] as const;
  return {
    inputSha256: lease.inputSha256,
    inputSizeBytes: lease.inputSizeBytes,
    storageVersion: lease.storageVersion,
    policyVersion: lease.policyVersion,
    toolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
    verdict: "EXTRACTED",
    engine: "poppler",
    engineVersion: "25.06.0",
    pageCount: 3,
    chunkCount: chunks.length,
    textBytes: chunks.reduce(
      (total, chunk) => total + Buffer.byteLength(chunk.text, "utf8"),
      0,
    ),
    extractedAt: plusMilliseconds(TEST_EPOCH, 100),
    completedAt: plusMilliseconds(TEST_EPOCH, 200),
    durationMs: 80,
    totalDurationMs: 100,
    chunks,
    ...overrides,
  };
}

function noTextAttestation(
  lease: DocumentTextExtractionLease,
): DocumentTextExtractionAttestation {
  return extractedAttestation(lease, {
    verdict: "NO_TEXT",
    chunkCount: 0,
    textBytes: 0,
    chunks: [],
  });
}

test("enqueue is exactly idempotent and binds one accepted validation generation", async () => {
  const organizationId = await createOrganization("enqueue");
  try {
    const target = await createExtractionTarget(organizationId, "enqueue");
    const otherTarget = await createExtractionTarget(organizationId, "enqueue-other");

    const first = await enqueueTarget(target);
    const replayed = await enqueueTarget(target);

    assert.equal(replayed.id, first.id);
    assert.equal(replayed.organizationId, organizationId);
    assert.equal(replayed.type, "TEXT_EXTRACTION");
    assert.equal(replayed.documentId, target.documentId);
    assert.equal(replayed.assetId, target.assetId);
    assert.equal(replayed.intakeId, target.intakeId);
    assert.equal(replayed.ingestReceiptId, target.ingestReceiptId);
    assert.equal(
      replayed.dedupeKey,
      documentTextExtractionJobDedupeKey(
        target.validationAttestationId,
        DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
        EXTRACTION_TOOLCHAIN_DIGEST,
      ),
    );
    assert.equal(
      replayed.dedupeKey,
      `accepted-validation:${target.validationAttestationId}:${DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION}:${EXTRACTION_TOOLCHAIN_DIGEST}`,
    );
    assert.deepEqual(replayed.payload, {
      schemaVersion: 1,
      source: "accepted-document-validation",
      validationAttestationId: target.validationAttestationId,
      policyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
      storageVersion: target.storageVersion,
      toolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
    });
    assert.equal(await prisma.job.count({
      where: {
        organizationId,
        type: "TEXT_EXTRACTION",
        dedupeKey: replayed.dedupeKey,
      },
    }), 1);

    await assert.rejects(prisma.$transaction((transaction) =>
      enqueueDocumentTextExtractionJob(transaction, {
        organizationId,
        documentId: otherTarget.documentId,
        assetId: otherTarget.assetId,
        validationAttestationId: target.validationAttestationId,
        toolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
        now: TEST_EPOCH,
      })));
    assert.equal(await prisma.job.count({
      where: { organizationId, type: "TEXT_EXTRACTION" },
    }), 1);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("claim admits only the configured extraction policy without charging older policies", async () => {
  const organizationId = await createOrganization("policy-pinning");
  try {
    const oldPolicyTarget = await createExtractionTarget(
      organizationId,
      "policy-pinning-old",
    );
    const currentPolicyTarget = await createExtractionTarget(
      organizationId,
      "policy-pinning-current",
    );
    const oldPolicyJob = await prisma.$transaction((transaction) =>
      enqueueDocumentTextExtractionJob(transaction, {
        organizationId,
        documentId: oldPolicyTarget.documentId,
        assetId: oldPolicyTarget.assetId,
        validationAttestationId: oldPolicyTarget.validationAttestationId,
        policyVersion: "paperpilot-text-extraction-v0",
        toolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
        now: TEST_EPOCH,
      }));
    await prisma.job.update({
      where: { id: oldPolicyJob.id },
      data: { priority: 10_000 },
    });

    assert.equal(await claimNextDocumentTextExtractionJob({
      workerId: "current-policy-worker-before-current-job",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    }), null);
    assert.equal((await prisma.job.findUniqueOrThrow({
      where: { id: oldPolicyJob.id },
    })).attempts, 0);
    assert.equal(await prisma.jobAttempt.count({
      where: { jobId: oldPolicyJob.id },
    }), 0);

    const currentPolicyJob = await enqueueTarget(currentPolicyTarget);
    const lease = await claimNextDocumentTextExtractionJob({
      workerId: "current-policy-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(lease);
    assert.equal(lease.jobId, currentPolicyJob.id);
    assert.equal(lease.policyVersion, DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION);

    const [storedOldPolicyJob, storedCurrentPolicyJob] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: oldPolicyJob.id } }),
      prisma.job.findUniqueOrThrow({ where: { id: currentPolicyJob.id } }),
    ]);
    assert.equal(storedOldPolicyJob.status, "QUEUED");
    assert.equal(storedOldPolicyJob.attempts, 0);
    assert.equal(storedOldPolicyJob.lockedAt, null);
    assert.equal(storedOldPolicyJob.lockedBy, null);
    assert.equal(storedOldPolicyJob.leaseId, null);
    assert.equal(await prisma.jobAttempt.count({
      where: { jobId: oldPolicyJob.id },
    }), 0);
    assert.equal(storedCurrentPolicyJob.status, "RUNNING");
    assert.equal(storedCurrentPolicyJob.attempts, 1);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("concurrent claim has one winner with the complete authoritative validation binding", async () => {
  const organizationId = await createOrganization("concurrent-claim");
  try {
    const target = await createExtractionTarget(organizationId, "concurrent-claim");
    const job = await enqueueTarget(target);

    assert.equal(await claimNextDocumentTextExtractionJobWithPin({
      workerId: "wrong-toolchain-worker",
      expectedPolicyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
      expectedToolchainDigest: "f".repeat(64),
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    }), null);
    assert.equal((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).attempts, 0);

    const claims = await Promise.all([
      claimNextDocumentTextExtractionJob({
        workerId: "extraction-worker-a",
        leaseTtlMs: LEASE_TTL_MS,
        now: TEST_EPOCH,
      }),
      claimNextDocumentTextExtractionJob({
        workerId: "extraction-worker-b",
        leaseTtlMs: LEASE_TTL_MS,
        now: TEST_EPOCH,
      }),
    ]);
    const winners = claims.filter(
      (claim): claim is DocumentTextExtractionLease => claim !== null,
    );

    assert.equal(winners.length, 1);
    const lease = winners[0];
    assert.equal(lease.organizationId, organizationId);
    assert.equal(lease.jobId, job.id);
    assert.equal(lease.attemptNumber, 1);
    assert.equal(lease.intakeId, target.intakeId);
    assert.equal(lease.ingestReceiptId, target.ingestReceiptId);
    assert.equal(lease.documentId, target.documentId);
    assert.equal(lease.assetId, target.assetId);
    assert.equal(lease.validationAttestationId, target.validationAttestationId);
    assert.equal(lease.inputSha256, target.sha256);
    assert.equal(lease.inputSizeBytes, target.sizeBytes);
    assert.equal(lease.expectedPageCount, 3);
    assert.equal(lease.storageVersion, target.storageVersion);
    assert.equal(lease.policyVersion, DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION);
    assert.equal(lease.toolchainDigest, EXTRACTION_TOOLCHAIN_DIGEST);
    assert.equal(lease.leaseExpiresAt.getTime(), TEST_EPOCH.getTime() + LEASE_TTL_MS);

    const [storedJob, attempt, asset, document] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.jobAttempt.findFirstOrThrow({ where: { jobId: job.id } }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
    ]);
    assert.equal(storedJob.status, "RUNNING");
    assert.equal(storedJob.attempts, 1);
    assert.equal(storedJob.leaseId, lease.leaseId);
    assert.equal(storedJob.lockedBy, lease.workerId);
    assert.equal(attempt.status, "RUNNING");
    assert.equal(attempt.workerId, lease.workerId);
    assert.equal(attempt.leaseId, lease.leaseId);
    assert.equal(asset.status, "READY");
    assert.equal(asset.sha256, target.sha256);
    assert.equal(document.status, "READY");
    assert.equal(document.contentHash, target.sha256);
    assert.equal(await prisma.jobAttempt.count({ where: { jobId: job.id } }), 1);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("explicit pre-admission saturation releases the lease without consuming execution budget", async () => {
  const organizationId = await createOrganization("admission-deferral");
  try {
    const target = await createExtractionTarget(organizationId, "admission-deferral");
    const job = await enqueueTarget(target);
    const lease = await claimNextDocumentTextExtractionJob({
      workerId: "admission-worker-a",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(lease);

    const deferredAt = plusMilliseconds(TEST_EPOCH, 1_000);
    assert.equal(await deferDocumentTextExtractionLeaseBeforeAdmission({
      lease,
      now: deferredAt,
    }), "deferred");
    assert.equal(await deferDocumentTextExtractionLeaseBeforeAdmission({
      lease,
      now: deferredAt,
    }), "lease-lost");

    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(stored.status, "RETRYING");
    assert.equal(stored.attempts, 0);
    assert.equal(stored.lockedAt, null);
    assert.equal(stored.lockedBy, null);
    assert.equal(stored.leaseId, null);
    assert.equal(stored.leaseExpiresAt, null);
    assert.equal(stored.lastErrorCode, "extraction_service_busy");
    assert.equal(
      stored.runAfter.toISOString(),
      plusMilliseconds(
        deferredAt,
        DOCUMENT_TEXT_EXTRACTION_ADMISSION_RETRY_DELAY_MS,
      ).toISOString(),
    );
    assert.equal(await prisma.jobAttempt.count({ where: { jobId: job.id } }), 0);
    assert.equal(await prisma.auditEvent.count({
      where: {
        organizationId,
        action: "document.text_extraction.admission_deferred",
        entityId: job.id,
      },
    }), 1);

    assert.equal(await claimNextDocumentTextExtractionJob({
      workerId: "admission-worker-b",
      leaseTtlMs: LEASE_TTL_MS,
      now: plusMilliseconds(stored.runAfter, -1),
    }), null);
    const admitted = await claimNextDocumentTextExtractionJob({
      workerId: "admission-worker-b",
      leaseTtlMs: LEASE_TTL_MS,
      now: stored.runAfter,
    });
    assert.ok(admitted);
    assert.equal(admitted.attemptNumber, 1);
    assert.equal((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).attempts, 1);
    assert.equal(await prisma.jobAttempt.count({ where: { jobId: job.id } }), 1);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("claim fails closed for rejected, drifted, cross-tenant, and cross-target inputs", async () => {
  const organizationA = await createOrganization("target-a");
  const organizationB = await createOrganization("target-b");
  try {
    const targetA = await createExtractionTarget(organizationA, "target-a-primary");
    const otherTargetA = await createExtractionTarget(organizationA, "target-a-other");
    const rejectedTargetA = await createExtractionTarget(
      organizationA,
      "target-a-rejected",
      "REJECTED",
    );
    const targetB = await createExtractionTarget(organizationB, "target-b");

    await assert.rejects(prisma.$transaction((transaction) =>
      enqueueDocumentTextExtractionJob(transaction, {
        organizationId: organizationA,
        documentId: targetB.documentId,
        assetId: targetB.assetId,
        validationAttestationId: targetB.validationAttestationId,
        toolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
        now: TEST_EPOCH,
      })));
    assert.equal(await prisma.job.count({
      where: { organizationId: organizationA, type: "TEXT_EXTRACTION" },
    }), 0);

    const rejectedJob = await enqueueTarget(rejectedTargetA);

    const malformedJob = await prisma.job.create({
      data: {
        organizationId: organizationA,
        type: "TEXT_EXTRACTION",
        status: "QUEUED",
        dedupeKey: documentTextExtractionJobDedupeKey(
          `cross-target-${randomUUID()}`,
          DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
          EXTRACTION_TOOLCHAIN_DIGEST,
        ),
        priority: 100,
        payload: {
          schemaVersion: 1,
          source: "accepted-document-validation",
          validationAttestationId: targetA.validationAttestationId,
          policyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
          storageVersion: targetA.storageVersion,
        },
        attempts: 0,
        maxAttempts: 4,
        runAfter: TEST_EPOCH,
        documentId: targetA.documentId,
        assetId: otherTargetA.assetId,
      },
    });

    assert.equal(await claimNextDocumentTextExtractionJob({
      workerId: "extraction-malformed-target-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    }), null);
    const failedClosed = await prisma.job.findUniqueOrThrow({
      where: { id: malformedJob.id },
    });
    assert.equal(failedClosed.status, "DEAD_LETTER");
    assert.equal(failedClosed.lastErrorCode, "extraction_target_invalid");
    assert.equal(await prisma.jobAttempt.count({ where: { jobId: malformedJob.id } }), 0);
    assert.equal((await prisma.job.findUniqueOrThrow({
      where: { id: rejectedJob.id },
    })).lastErrorCode, "extraction_target_invalid");
    assert.equal(await prisma.jobAttempt.count({ where: { jobId: rejectedJob.id } }), 0);

    const driftedJob = await enqueueTarget(targetA, plusMilliseconds(TEST_EPOCH, 1));
    await prisma.asset.update({
      where: { id: targetA.assetId },
      data: { sha256: "d".repeat(64) },
    });
    assert.equal(await claimNextDocumentTextExtractionJob({
      workerId: "extraction-drifted-target-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: plusMilliseconds(TEST_EPOCH, 1),
    }), null);
    assert.equal((await prisma.job.findUniqueOrThrow({
      where: { id: driftedJob.id },
    })).lastErrorCode, "extraction_target_invalid");
    assert.equal((await prisma.asset.findUniqueOrThrow({
      where: { id: targetB.assetId },
    })).sha256, targetB.sha256);
  } finally {
    await cleanupOrganizations([organizationA, organizationB]);
  }
});

test("heartbeat is owner-fenced and an expired lease is reaped before reclaim", async () => {
  const organizationId = await createOrganization("heartbeat");
  try {
    const target = await createExtractionTarget(organizationId, "heartbeat");
    const job = await enqueueTarget(target);
    const lease = await claimNextDocumentTextExtractionJob({
      workerId: "extraction-heartbeat-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(lease);

    const heartbeatAt = plusMilliseconds(TEST_EPOCH, 1_000);
    assert.equal(await heartbeatDocumentTextExtractionLease({
      lease: { ...lease, workerId: "wrong-worker" },
      leaseTtlMs: LEASE_TTL_MS,
      now: heartbeatAt,
    }), false);
    assert.equal(await heartbeatDocumentTextExtractionLease({
      lease: { ...lease, leaseId: randomUUID() },
      leaseTtlMs: LEASE_TTL_MS,
      now: heartbeatAt,
    }), false);
    assert.equal(await heartbeatDocumentTextExtractionLease({
      lease,
      leaseTtlMs: LEASE_TTL_MS,
      now: heartbeatAt,
    }), true);

    const extendedExpiry = plusMilliseconds(heartbeatAt, LEASE_TTL_MS);
    assert.equal((await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
    })).leaseExpiresAt?.toISOString(), extendedExpiry.toISOString());
    assert.equal(await claimNextDocumentTextExtractionJob({
      workerId: "extraction-too-early-reclaim",
      leaseTtlMs: LEASE_TTL_MS,
      now: lease.leaseExpiresAt,
    }), null);

    const reclaimed = await claimNextDocumentTextExtractionJob({
      workerId: "extraction-reclaim-worker",
      leaseTtlMs: DEFAULT_DOCUMENT_TEXT_EXTRACTION_LEASE_TTL_MS,
      now: extendedExpiry,
    });
    assert.ok(reclaimed);
    assert.equal(reclaimed.jobId, job.id);
    assert.equal(reclaimed.attemptNumber, 2);
    assert.notEqual(reclaimed.leaseId, lease.leaseId);
    assert.equal(
      reclaimed.leaseExpiresAt.getTime(),
      extendedExpiry.getTime() + DEFAULT_DOCUMENT_TEXT_EXTRACTION_LEASE_TTL_MS,
    );

    assert.equal(await heartbeatDocumentTextExtractionLease({
      lease,
      leaseTtlMs: LEASE_TTL_MS,
      now: plusMilliseconds(extendedExpiry, 1),
    }), false);
    assert.equal(await completeDocumentTextExtractionLease({
      lease,
      attestation: extractedAttestation(lease),
      now: plusMilliseconds(extendedExpiry, 1),
    }), null);
    assert.equal(await failDocumentTextExtractionLease({
      lease,
      code: "extraction_service_timeout",
      retryable: true,
      now: plusMilliseconds(extendedExpiry, 1),
    }), "lease-lost");

    const staleAttempt = await prisma.jobAttempt.findUniqueOrThrow({
      where: { id: lease.jobAttemptId },
    });
    assert.equal(staleAttempt.status, "FAILED");
    assert.equal(staleAttempt.errorCode, "worker_lease_expired");
    assert.equal(await prisma.documentTextExtraction.count({
      where: { organizationId },
    }), 0);
    assert.equal(await prisma.documentTextChunk.count({
      where: { organizationId },
    }), 0);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("retryable failure observes backoff and a nonretryable failure dead-letters", async () => {
  const organizationId = await createOrganization("retry");
  try {
    const target = await createExtractionTarget(organizationId, "retry");
    const job = await enqueueTarget(target);
    const firstLease = await claimNextDocumentTextExtractionJob({
      workerId: "extraction-retry-worker-1",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(firstLease);

    const failureAt = plusMilliseconds(TEST_EPOCH, 1_000);
    assert.equal(await failDocumentTextExtractionLease({
      lease: firstLease,
      code: "extraction_service_timeout",
      retryable: true,
      now: failureAt,
    }), "retrying");

    const [retryingJob, failedAttempt, asset, document, retryingIntake] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.jobAttempt.findUniqueOrThrow({ where: { id: firstLease.jobAttemptId } }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
    ]);
    assert.equal(retryingJob.status, "RETRYING");
    assert.equal(retryingJob.lastErrorCode, "extraction_service_timeout");
    assert.equal(
      retryingJob.runAfter.toISOString(),
      plusMilliseconds(failureAt, 5_000).toISOString(),
    );
    assert.equal(failedAttempt.status, "FAILED");
    assert.equal(asset.status, "READY");
    assert.equal(document.status, "READY");
    assert.equal(retryingIntake.status, "EXTRACTING");
    assert.equal(retryingIntake.completedAt, null);
    assert.equal(await claimNextDocumentTextExtractionJob({
      workerId: "extraction-retry-worker-early",
      leaseTtlMs: LEASE_TTL_MS,
      now: plusMilliseconds(retryingJob.runAfter, -1),
    }), null);

    const secondLease = await claimNextDocumentTextExtractionJob({
      workerId: "extraction-retry-worker-2",
      leaseTtlMs: LEASE_TTL_MS,
      now: retryingJob.runAfter,
    });
    assert.ok(secondLease);
    assert.equal(secondLease.attemptNumber, 2);
    assert.equal(await failDocumentTextExtractionLease({
      lease: secondLease,
      code: "extraction_response_invalid",
      retryable: false,
      now: plusMilliseconds(retryingJob.runAfter, 1_000),
    }), "dead-letter");

    const [deadLettered, finalAsset, finalDocument, attentionIntake] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
    ]);
    assert.equal(deadLettered.status, "DEAD_LETTER");
    assert.equal(deadLettered.lastErrorCode, "extraction_response_invalid");
    assert.equal(finalAsset.status, "READY");
    assert.equal(finalDocument.status, "READY");
    assert.equal(attentionIntake.status, "ATTENTION");
    assert.equal(attentionIntake.failureCode, "extraction_response_invalid");
    assert.equal(attentionIntake.completedAt, null);
    assert.equal(await prisma.auditEvent.count({
      where: {
        organizationId,
        action: "document.text_extraction.dead_lettered",
        entityId: job.id,
      },
    }), 1);
    assert.equal(await prisma.documentTextExtraction.count({
      where: { organizationId },
    }), 0);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("retryable failures dead-letter exactly at the durable attempt budget", async () => {
  const organizationId = await createOrganization("budget");
  try {
    const target = await createExtractionTarget(organizationId, "budget");
    const job = await enqueueTarget(target);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    let dueAt = TEST_EPOCH;

    for (let attemptNumber = 1; attemptNumber <= stored.maxAttempts; attemptNumber += 1) {
      const lease = await claimNextDocumentTextExtractionJob({
        workerId: `extraction-budget-worker-${attemptNumber}`,
        leaseTtlMs: LEASE_TTL_MS,
        now: dueAt,
      });
      assert.ok(lease);
      assert.equal(lease.jobId, job.id);
      assert.equal(lease.attemptNumber, attemptNumber);

      const result = await failDocumentTextExtractionLease({
        lease,
        code: "extraction_service_unavailable",
        retryable: true,
        now: plusMilliseconds(dueAt, 1_000),
      });
      if (attemptNumber < stored.maxAttempts) {
        assert.equal(result, "retrying");
        const retrying = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        dueAt = retrying.runAfter;
      } else {
        assert.equal(result, "dead-letter");
      }
    }

    const [deadLettered, attempts, asset, document] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.jobAttempt.findMany({
        where: { jobId: job.id },
        orderBy: { attemptNumber: "asc" },
      }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
    ]);
    assert.equal(deadLettered.status, "DEAD_LETTER");
    assert.equal(deadLettered.attempts, stored.maxAttempts);
    assert.equal(attempts.length, stored.maxAttempts);
    assert.equal(attempts.at(-1)?.status, "DEAD_LETTER");
    assert.ok(attempts.slice(0, -1).every((attempt) => attempt.status === "FAILED"));
    assert.equal(asset.status, "READY");
    assert.equal(document.status, "READY");
    assert.equal(await prisma.documentTextExtraction.count({
      where: { organizationId },
    }), 0);
    assert.equal(await prisma.auditEvent.count({
      where: { organizationId, action: "document.text_extraction.dead_lettered" },
    }), 1);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("EXTRACTED completion atomically persists immutable evidence and deterministic chunks", async () => {
  const organizationId = await createOrganization("complete");
  try {
    const target = await createExtractionTarget(organizationId, "complete");
    const job = await enqueueTarget(target);
    const lease = await claimNextDocumentTextExtractionJob({
      workerId: "extraction-complete-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(lease);
    const attestation = extractedAttestation(lease);
    const completionAt = plusMilliseconds(TEST_EPOCH, 1_000);

    const applied = await completeDocumentTextExtractionLease({
      lease,
      attestation,
      now: completionAt,
    });
    assert.equal(applied?.outcome, "applied");
    assert.equal(applied?.verdict, "EXTRACTED");
    const replayed = await completeDocumentTextExtractionLease({
      lease,
      attestation,
      now: plusMilliseconds(completionAt, 1),
    });
    assert.equal(replayed?.outcome, "replayed");
    assert.equal(replayed?.verdict, "EXTRACTED");

    const driftedChunks = attestation.chunks.map((chunk, index) => ({
      ...chunk,
      text: index === 0 ? "Changed paragraph" : chunk.text,
    }));
    const drifted = extractedAttestation(lease, {
      chunks: driftedChunks,
      textBytes: driftedChunks.reduce(
        (total, chunk) => total + Buffer.byteLength(chunk.text, "utf8"),
        0,
      ),
    });
    assert.equal(await completeDocumentTextExtractionLease({
      lease,
      attestation: drifted,
      now: plusMilliseconds(completionAt, 2),
    }), null);

    const [storedJob, attempt, asset, document, intake, extractions, chunks] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.jobAttempt.findUniqueOrThrow({ where: { id: lease.jobAttemptId } }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
      prisma.documentTextExtraction.findMany({ where: { organizationId } }),
      prisma.documentTextChunk.findMany({
        where: { organizationId },
        orderBy: { sequence: "asc" },
      }),
    ]);
    assert.equal(storedJob.status, "SUCCEEDED");
    assert.equal(storedJob.completedAt?.toISOString(), completionAt.toISOString());
    assert.equal(attempt.status, "SUCCEEDED");
    assert.equal(intake.status, "READY");
    assert.equal(intake.completedAt?.toISOString(), completionAt.toISOString());
    assert.equal(intake.failureCode, null);
    assert.equal(intake.quotaReleasedAt, null);
    assert.equal(extractions.length, 1);
    const extraction = extractions[0];
    assert.equal(extraction.jobId, job.id);
    assert.equal(extraction.jobAttemptId, lease.jobAttemptId);
    assert.equal(extraction.validationAttestationId, target.validationAttestationId);
    assert.equal(extraction.documentId, target.documentId);
    assert.equal(extraction.assetId, target.assetId);
    assert.equal(extraction.inputSha256, target.sha256);
    assert.equal(extraction.inputSizeBytes, target.sizeBytes);
    assert.equal(extraction.storageVersion, target.storageVersion);
    assert.equal(
      extraction.extractionPolicyVersion,
      DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
    );
    assert.equal(extraction.toolchainDigest, attestation.toolchainDigest);
    assert.equal(extraction.verdict, "EXTRACTED");
    assert.equal(extraction.pageCount, attestation.pageCount);
    assert.equal(extraction.chunkCount, attestation.chunkCount);
    assert.equal(extraction.textBytes, attestation.textBytes);
    assert.equal(extraction.checkedAt.toISOString(), completionAt.toISOString());
    assert.equal(chunks.length, attestation.chunks.length);

    for (const [index, chunk] of chunks.entries()) {
      const expected = attestation.chunks[index];
      assert.equal(chunk.extractionId, extraction.id);
      assert.equal(chunk.documentId, target.documentId);
      assert.equal(chunk.sequence, expected.sequence);
      assert.equal(chunk.pageStart, expected.pageNumber);
      assert.equal(chunk.pageEnd, expected.pageNumber);
      assert.equal(chunk.sectionId, null);
      assert.equal(chunk.sectionTitle, null);
      assert.equal(chunk.paragraphId, expected.paragraphId);
      assert.equal(chunk.charStart, null);
      assert.equal(chunk.charEnd, null);
      assert.equal(chunk.text, expected.text);
      assert.equal(
        chunk.contentHash,
        createHash("sha256").update(expected.text, "utf8").digest("hex"),
      );
      assert.deepEqual(chunk.locator, {
        schemaVersion: 1,
        kind: "pdf-text",
        pageNumber: expected.pageNumber,
        paragraphId: expected.paragraphId,
      });
    }
    assert.equal(asset.status, "READY");
    assert.equal(asset.validatedAt?.toISOString(), target.validatedAt.toISOString());
    assert.equal(asset.validationPolicyVersion, target.validationPolicyVersion);
    assert.equal(document.status, "READY");
    assert.equal(document.validatedAt?.toISOString(), target.validatedAt.toISOString());
    assert.equal(document.validationPolicyVersion, target.validationPolicyVersion);
    assert.equal(await prisma.provenanceRecord.count({
      where: {
        organizationId,
        documentId: target.documentId,
        sourceProvider: "PaperPilot isolated document text extraction",
        sourceRecordId: lease.jobAttemptId,
      },
    }), 1);
    assert.equal(await prisma.auditEvent.count({
      where: {
        organizationId,
        action: "document.text_extraction.completed",
        entityId: target.documentId,
      },
    }), 1);

    await assert.rejects(prisma.documentTextExtraction.update({
      where: { id: extraction.id },
      data: { engineVersion: "mutated" },
    }));
    assert.equal(await prisma.documentTextExtraction.count({
      where: { organizationId },
    }), 1);
    assert.equal(await prisma.documentTextChunk.count({
      where: { organizationId },
    }), attestation.chunkCount);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("NO_TEXT completion persists a zero-chunk immutable manifest and preserves readiness", async () => {
  const organizationId = await createOrganization("no-text");
  try {
    const target = await createExtractionTarget(organizationId, "no-text");
    const job = await enqueueTarget(target);
    const lease = await claimNextDocumentTextExtractionJob({
      workerId: "extraction-no-text-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(lease);
    const attestation = noTextAttestation(lease);

    const completed = await completeDocumentTextExtractionLease({
      lease,
      attestation,
      now: plusMilliseconds(TEST_EPOCH, 1_000),
    });
    assert.equal(completed?.outcome, "applied");
    assert.equal(completed?.verdict, "NO_TEXT");

    const [extraction, asset, document] = await Promise.all([
      prisma.documentTextExtraction.findFirstOrThrow({
        where: { organizationId, jobId: job.id },
      }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
    ]);
    assert.equal(extraction.verdict, "NO_TEXT");
    assert.equal(extraction.pageCount, 3);
    assert.equal(extraction.chunkCount, 0);
    assert.equal(extraction.textBytes, 0);
    assert.equal(await prisma.documentTextChunk.count({
      where: { organizationId, extractionId: extraction.id },
    }), 0);
    assert.equal(asset.status, "READY");
    assert.equal(document.status, "READY");
    assert.equal(await prisma.auditEvent.count({
      where: { organizationId, action: "document.text_extraction.completed" },
    }), 1);
  } finally {
    await cleanupOrganizations([organizationId]);
  }
});

test("forged cross-tenant and wrong-target leases never persist extraction state", async () => {
  const organizationA = await createOrganization("lease-a");
  const organizationB = await createOrganization("lease-b");
  try {
    const targetA = await createExtractionTarget(organizationA, "lease-a-primary");
    const otherTargetA = await createExtractionTarget(organizationA, "lease-a-other");
    await createExtractionTarget(organizationB, "lease-b");
    await enqueueTarget(targetA);
    const lease = await claimNextDocumentTextExtractionJob({
      workerId: "extraction-forged-lease-worker",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(lease);

    const wrongTargetLease = {
      ...lease,
      documentId: otherTargetA.documentId,
      assetId: otherTargetA.assetId,
      validationAttestationId: otherTargetA.validationAttestationId,
    };
    assert.equal(await completeDocumentTextExtractionLease({
      lease: wrongTargetLease,
      attestation: extractedAttestation(wrongTargetLease),
      now: plusMilliseconds(TEST_EPOCH, 1_000),
    }), null);
    const foreignLease = { ...lease, organizationId: organizationB };
    assert.equal(await completeDocumentTextExtractionLease({
      lease: foreignLease,
      attestation: extractedAttestation(foreignLease),
      now: plusMilliseconds(TEST_EPOCH, 1_000),
    }), null);

    assert.equal(await prisma.documentTextExtraction.count({
      where: { organizationId: { in: [organizationA, organizationB] } },
    }), 0);
    assert.equal(await prisma.documentTextChunk.count({
      where: { organizationId: { in: [organizationA, organizationB] } },
    }), 0);
    assert.equal((await prisma.job.findUniqueOrThrow({
      where: { id: lease.jobId },
    })).status, "RUNNING");
  } finally {
    await cleanupOrganizations([organizationA, organizationB]);
  }
});
