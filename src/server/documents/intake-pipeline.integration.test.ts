import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
  claimNextDocumentTextExtractionJob,
  completeDocumentTextExtractionLease,
  failDocumentTextExtractionLease,
  heartbeatDocumentTextExtractionLease,
  type DocumentTextExtractionLease,
} from "./extraction-jobs";
import type { DocumentTextExtractionAttestation } from "./extraction-contract";
import {
  LOCAL_QUARANTINE_STORAGE_VERSION,
  claimNextDocumentValidationJob,
  completeDocumentValidationLease,
  enqueueDocumentValidationJob,
  failDocumentValidationLease,
  type DocumentValidationLease,
  type ValidatedDocumentAttestation,
} from "./validation-jobs";

// Keep this suite ahead of ambient development jobs and the existing
// validation/extraction suites (2001/2002) in the shared durable queue.
const TEST_EPOCH = new Date("2000-01-01T00:00:00.000Z");
const LEASE_TTL_MS = 10_000;
const EXTRACTION_TOOLCHAIN_DIGEST = "c".repeat(64);
const METADATA_HASH = "a".repeat(64);
const PROVIDER_MD5 = "0123456789abcdef0123456789abcdef";
const SOURCE_VERSION = "7";

interface ZoteroPipelineTarget {
  organizationId: string;
  userId: string;
  connectionId: string;
  libraryId: string;
  objectId: string;
  attachmentImportId: string;
  intakeId: string;
  documentId: string;
  assetId: string;
  inboxEntryId: string;
  importBatchId: string;
  ingestReceiptId: string;
  validationJobId: string;
}

function plusMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

async function createZoteroPipelineTarget(label: string): Promise<ZoteroPipelineTarget> {
  const suffix = randomUUID();
  const organizationId = `pipeline-zotero-org-${label}-${suffix}`;
  const userId = `pipeline-zotero-user-${label}-${suffix}`;
  const connectionId = `pipeline-zotero-connection-${label}-${suffix}`;
  const libraryId = `pipeline-zotero-library-${label}-${suffix}`;
  const objectId = `pipeline-zotero-object-${label}-${suffix}`;
  const attachmentImportId = `pipeline-zotero-import-${label}-${suffix}`;
  const intakeId = `pipeline-zotero-intake-${label}-${suffix}`;
  const documentId = `pipeline-zotero-document-${label}-${suffix}`;
  const assetId = `pipeline-zotero-asset-${label}-${suffix}`;
  const inboxEntryId = `pipeline-zotero-inbox-${label}-${suffix}`;
  const importBatchId = `pipeline-zotero-batch-${label}-${suffix}`;
  const ingressJobId = `pipeline-zotero-download-${label}-${suffix}`;
  const ingressJobAttemptId = `pipeline-zotero-download-attempt-${label}-${suffix}`;
  const ingressAttemptId = `pipeline-zotero-ingress-${label}-${suffix}`;
  const ingestReceiptId = `pipeline-zotero-receipt-${label}-${suffix}`;
  const objectKey = `${LOCAL_QUARANTINE_STORAGE_VERSION}:${organizationId}:${assetId}`;
  const sizeBytes = 456n;
  const sha256 = createHash("sha256").update(`${organizationId}:${label}`).digest("hex");
  const storedAt = plusMilliseconds(TEST_EPOCH, -1_000);

  await prisma.user.create({
    data: { id: userId, name: "Pipeline user", email: `${userId}@example.test` },
  });
  await prisma.organization.create({
    data: { id: organizationId, name: `Pipeline ${label}`, slug: organizationId },
  });
  await prisma.member.create({
    data: { organizationId, userId, role: "owner" },
  });
  await prisma.integrationConnection.create({
    data: {
      id: connectionId,
      organizationId,
      provider: "ZOTERO",
      authType: "OAUTH1",
      status: "CONNECTED",
      externalAccountId: `provider-${suffix}`,
      credentialCiphertext: new Uint8Array([1, 2, 3, 4]),
      credentialFingerprint: `credential-${suffix}`,
      credentialKeyVersion: "v1",
      credentialGeneration: 1,
      createdById: userId,
    },
  });
  await prisma.zoteroLibrary.create({
    data: {
      id: libraryId,
      organizationId,
      integrationConnectionId: connectionId,
      libraryType: "USER",
      zoteroLibraryId: `provider-library-${suffix}`,
      name: "Pipeline library",
      isReadable: true,
      syncEnabled: true,
      fileAccessStatus: "AVAILABLE",
    },
  });
  await prisma.zoteroObject.create({
    data: {
      id: objectId,
      organizationId,
      zoteroLibraryId: libraryId,
      objectType: "ATTACHMENT",
      zoteroKey: "PDF12345",
      version: SOURCE_VERSION,
      contentHash: "b".repeat(64),
      data: { itemType: "attachment" },
    },
  });
  await prisma.zoteroAttachment.create({
    data: {
      zoteroObjectId: objectId,
      organizationId,
      zoteroLibraryId: libraryId,
      parentKey: "PARENT01",
      linkMode: "imported_file",
      contentType: "application/pdf",
      fileName: "pipeline-paper.pdf",
      providerMd5: PROVIDER_MD5,
      providerMtime: "1730000000000",
      sourceVersion: SOURCE_VERSION,
      metadataHash: METADATA_HASH,
      eligibility: "DOWNLOADABLE",
    },
  });
  await prisma.zoteroAttachmentPolicy.create({
    data: {
      id: `pipeline-zotero-policy-${label}-${suffix}`,
      organizationId,
      integrationConnectionId: connectionId,
      mode: "MANUAL",
      revision: 1,
      configuredById: userId,
      configuredAt: plusMilliseconds(TEST_EPOCH, -10_000),
    },
  });

  const validationJob = await prisma.$transaction(async (transaction) => {
    await transaction.document.create({
      data: {
        id: documentId,
        organizationId,
        kind: "PAPER_PDF",
        status: "PENDING",
        title: `${label} paper`,
        mimeType: "application/pdf",
        contentHash: sha256,
        metadata: { custody: "private-quarantine", verification: "queued" },
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
        originalFileName: "pipeline-paper.pdf",
        mimeType: "application/pdf",
        sizeBytes,
        sha256,
        metadata: { custody: "private-quarantine", publicAccess: false },
      },
    });
    await transaction.documentAsset.create({
      data: { organizationId, documentId, assetId, role: "ORIGINAL" },
    });
    await transaction.importBatch.create({
      data: {
        id: importBatchId,
        organizationId,
        source: "ZOTERO",
        status: "RUNNING",
        label: "Zotero stored PDF import",
        integrationConnectionId: connectionId,
        requestedById: userId,
        externalRequestId: attachmentImportId,
        totalCount: 1,
        startedAt: storedAt,
      },
    });
    await transaction.inboxEntry.create({
      data: {
        id: inboxEntryId,
        organizationId,
        importBatchId,
        documentId,
        source: "ZOTERO",
        sourceKey: `attachment-import:${attachmentImportId}`,
        dedupeKey: `zotero-attachment-import:${attachmentImportId}`,
        status: "NEEDS_REVIEW",
        proposedTitle: "pipeline-paper.pdf",
        payload: {
          schemaVersion: 1,
          kind: "zotero-attachment-import",
          attachmentImportId,
          importStatus: "QUARANTINED",
        },
        createdById: userId,
      },
    });
    await transaction.documentIntake.create({
      data: {
        id: intakeId,
        organizationId,
        source: "ZOTERO_ATTACHMENT",
        status: "QUARANTINED",
        documentId,
        assetId,
        inboxEntryId,
        importBatchId,
        createdById: userId,
        reservedBytes: sizeBytes,
        committedBytes: sizeBytes,
        policyRevision: 1,
      },
    });
    await transaction.job.create({
      data: {
        id: ingressJobId,
        organizationId,
        type: "DOCUMENT_DOWNLOAD",
        status: "SUCCEEDED",
        dedupeKey: `pipeline-zotero-download:${attachmentImportId}`,
        attempts: 1,
        maxAttempts: 4,
        runAfter: storedAt,
        completedAt: storedAt,
        integrationConnectionId: connectionId,
        zoteroLibraryId: libraryId,
        documentId,
        assetId,
        intakeId,
        createdById: userId,
      },
    });
    await transaction.jobAttempt.create({
      data: {
        id: ingressJobAttemptId,
        organizationId,
        jobId: ingressJobId,
        attemptNumber: 1,
        status: "SUCCEEDED",
        startedAt: plusMilliseconds(storedAt, -100),
        completedAt: storedAt,
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
        providerMd5: PROVIDER_MD5,
        computedMd5: PROVIDER_MD5,
        sha256,
        leaseId: `pipeline-zotero-ingress-lease-${suffix}`,
        leaseExpiresAt: storedAt,
        storedAt,
        completedAt: storedAt,
      },
    });
    await transaction.zoteroAttachmentImport.create({
      data: {
        id: attachmentImportId,
        organizationId,
        integrationConnectionId: connectionId,
        zoteroLibraryId: libraryId,
        zoteroObjectId: objectId,
        intakeId,
        documentId,
        assetId,
        requestedById: userId,
        clientOperationId: `pipeline-operation-${suffix}`,
        requestHash: createHash("sha256").update(`request:${suffix}`).digest("hex"),
        policyRevision: 1,
        credentialGeneration: 1,
        sourceVersion: SOURCE_VERSION,
        sourceMetadataHash: METADATA_HASH,
        providerMd5: PROVIDER_MD5,
        status: "QUARANTINED",
        downloadJobId: ingressJobId,
        startedAt: plusMilliseconds(storedAt, -100),
        quarantinedAt: storedAt,
      },
    });
    await transaction.documentIngestReceipt.create({
      data: {
        id: ingestReceiptId,
        organizationId,
        source: "ZOTERO_ATTACHMENT",
        sourceFingerprint: `zotero-attachment-import:${attachmentImportId}`,
        intakeId,
        assetId,
        documentId,
        inboxEntryId,
        importBatchId,
        ingressAttemptId,
        integrationConnectionId: connectionId,
        zoteroLibraryId: libraryId,
        zoteroObjectId: objectId,
        zoteroAttachmentImportId: attachmentImportId,
        requestedById: userId,
        sourceVersion: SOURCE_VERSION,
        sourceChecksumAlgorithm: "md5",
        sourceChecksum: PROVIDER_MD5,
        declaredMimeType: "application/pdf",
        receivedSizeBytes: sizeBytes,
        sha256,
        storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
        storedAt,
      },
    });
    return enqueueDocumentValidationJob(transaction, {
      organizationId,
      documentId,
      assetId,
      ingestReceiptId,
      createdById: userId,
      storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
      now: TEST_EPOCH,
    });
  });

  return {
    organizationId,
    userId,
    connectionId,
    libraryId,
    objectId,
    attachmentImportId,
    intakeId,
    documentId,
    assetId,
    inboxEntryId,
    importBatchId,
    ingestReceiptId,
    validationJobId: validationJob.id,
  };
}

async function cleanup(targets: ZoteroPipelineTarget[]): Promise<void> {
  const where = {
    organizationId: { in: targets.map((target) => target.organizationId) },
  };
  await prisma.$transaction(async (transaction) => {
    await transaction.provenanceRecord.deleteMany({ where });
    await transaction.auditEvent.deleteMany({ where });
    await transaction.organization.deleteMany({
      where: { id: { in: targets.map((target) => target.organizationId) } },
    });
  });
  await prisma.user.deleteMany({
    where: { id: { in: targets.map((target) => target.userId) } },
  });
}

function validationAttestation(
  lease: DocumentValidationLease,
  verdict: "ACCEPTED" | "REJECTED" = "ACCEPTED",
): ValidatedDocumentAttestation {
  return {
    inputSha256: lease.inputSha256,
    inputSizeBytes: lease.inputSizeBytes,
    storageVersion: lease.storageVersion,
    policyVersion: lease.policyVersion,
    toolchainDigest: "b".repeat(64),
    verdict,
    rejectionCode: verdict === "REJECTED" ? "pdf_policy_violation" : null,
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
    pageCount: 2,
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
  };
}

function noTextAttestation(
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

async function claimExtraction(now: Date): Promise<DocumentTextExtractionLease | null> {
  return claimNextDocumentTextExtractionJob({
    workerId: "zotero-pipeline-extraction-worker",
    expectedPolicyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
    expectedToolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
    leaseTtlMs: LEASE_TTL_MS,
    now,
  });
}

after(async () => {
  await prisma.$disconnect();
});

test("Zotero validation retry stays source-bound and extraction closes READY", async () => {
  const target = await createZoteroPipelineTarget("ready");
  try {
    const firstLease = await claimNextDocumentValidationJob({
      workerId: "zotero-pipeline-validation-1",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(firstLease);
    assert.equal(firstLease.intakeId, target.intakeId);
    assert.equal(firstLease.ingestReceiptId, target.ingestReceiptId);

    let [intake, attachmentImport, inbox, batch] = await Promise.all([
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
      prisma.zoteroAttachmentImport.findUniqueOrThrow({ where: { id: target.attachmentImportId } }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: target.inboxEntryId } }),
      prisma.importBatch.findUniqueOrThrow({ where: { id: target.importBatchId } }),
    ]);
    assert.equal(intake.status, "VALIDATING");
    assert.equal(attachmentImport.status, "VALIDATING");
    assert.deepEqual(inbox.payload, {
      schemaVersion: 1,
      kind: "zotero-attachment-import",
      attachmentImportId: target.attachmentImportId,
      importStatus: "VALIDATING",
      phase: "validation",
    });
    assert.equal(batch.status, "RUNNING");
    assert.equal(batch.processedCount, 0);

    const retryAt = plusMilliseconds(TEST_EPOCH, 500);
    assert.equal(await failDocumentValidationLease({
      lease: firstLease,
      code: "validation_service_timeout",
      retryable: true,
      now: retryAt,
    }), "retrying");
    intake = await prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } });
    attachmentImport = await prisma.zoteroAttachmentImport.findUniqueOrThrow({
      where: { id: target.attachmentImportId },
    });
    assert.equal(intake.status, "VALIDATING");
    assert.equal(attachmentImport.status, "VALIDATING");

    const validationJob = await prisma.job.findUniqueOrThrow({ where: { id: target.validationJobId } });
    const secondLease = await claimNextDocumentValidationJob({
      workerId: "zotero-pipeline-validation-2",
      leaseTtlMs: LEASE_TTL_MS,
      now: validationJob.runAfter,
    });
    assert.ok(secondLease);
    assert.deepEqual(await completeDocumentValidationLease({
      lease: secondLease,
      attestation: validationAttestation(secondLease),
      extractionToolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
      now: plusMilliseconds(validationJob.runAfter, 1_000),
    }), { outcome: "applied", verdict: "ACCEPTED" });

    const extractionJob = await prisma.job.findFirstOrThrow({
      where: { organizationId: target.organizationId, type: "TEXT_EXTRACTION" },
    });
    assert.equal(extractionJob.intakeId, target.intakeId);
    assert.equal(extractionJob.ingestReceiptId, target.ingestReceiptId);
    [intake, attachmentImport, inbox, batch] = await Promise.all([
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
      prisma.zoteroAttachmentImport.findUniqueOrThrow({ where: { id: target.attachmentImportId } }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: target.inboxEntryId } }),
      prisma.importBatch.findUniqueOrThrow({ where: { id: target.importBatchId } }),
    ]);
    assert.equal(intake.status, "EXTRACTING");
    assert.equal(attachmentImport.status, "EXTRACTING");
    assert.equal(batch.status, "RUNNING");
    assert.deepEqual(inbox.payload, {
      schemaVersion: 1,
      kind: "zotero-attachment-import",
      attachmentImportId: target.attachmentImportId,
      importStatus: "EXTRACTING",
      phase: "extraction",
    });

    const extractionLease = await claimExtraction(extractionJob.runAfter);
    assert.ok(extractionLease);
    assert.equal(extractionLease.intakeId, target.intakeId);
    assert.equal(extractionLease.ingestReceiptId, target.ingestReceiptId);
    assert.equal(await heartbeatDocumentTextExtractionLease({
      lease: { ...extractionLease, ingestReceiptId: `forged-${target.ingestReceiptId}` },
      leaseTtlMs: LEASE_TTL_MS,
      now: plusMilliseconds(extractionJob.runAfter, 10),
    }), false);

    const completionAt = plusMilliseconds(extractionJob.runAfter, 1_000);
    const extractionEvidence = noTextAttestation(extractionLease, extractionJob.runAfter);
    assert.equal((await completeDocumentTextExtractionLease({
      lease: extractionLease,
      attestation: extractionEvidence,
      now: completionAt,
    }))?.outcome, "applied");
    assert.equal((await completeDocumentTextExtractionLease({
      lease: extractionLease,
      attestation: extractionEvidence,
      now: plusMilliseconds(completionAt, 1),
    }))?.outcome, "replayed");

    [intake, attachmentImport, inbox, batch] = await Promise.all([
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
      prisma.zoteroAttachmentImport.findUniqueOrThrow({ where: { id: target.attachmentImportId } }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: target.inboxEntryId } }),
      prisma.importBatch.findUniqueOrThrow({ where: { id: target.importBatchId } }),
    ]);
    assert.equal(intake.status, "READY");
    assert.ok(intake.completedAt);
    assert.equal(intake.quotaReleasedAt, null);
    assert.equal(attachmentImport.status, "READY");
    assert.ok(attachmentImport.completedAt);
    assert.equal(batch.status, "SUCCEEDED");
    assert.equal(batch.successCount, 1);
    assert.deepEqual(inbox.payload, {
      schemaVersion: 1,
      kind: "zotero-attachment-import",
      attachmentImportId: target.attachmentImportId,
      importStatus: "READY",
      phase: "ready",
    });
  } finally {
    await cleanup([target]);
  }
});

test("Zotero validation rejection closes FAILED without releasing adopted quota", async () => {
  const target = await createZoteroPipelineTarget("rejected");
  try {
    const lease = await claimNextDocumentValidationJob({
      workerId: "zotero-pipeline-rejection",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(lease);
    assert.deepEqual(await completeDocumentValidationLease({
      lease,
      attestation: validationAttestation(lease, "REJECTED"),
      extractionToolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
      now: plusMilliseconds(TEST_EPOCH, 1_000),
    }), { outcome: "applied", verdict: "REJECTED" });

    const [intake, attachmentImport, inbox, batch] = await Promise.all([
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
      prisma.zoteroAttachmentImport.findUniqueOrThrow({ where: { id: target.attachmentImportId } }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: target.inboxEntryId } }),
      prisma.importBatch.findUniqueOrThrow({ where: { id: target.importBatchId } }),
    ]);
    assert.equal(intake.status, "FAILED");
    assert.equal(intake.failureCode, "pdf_policy_violation");
    assert.ok(intake.completedAt);
    assert.equal(intake.quotaReleasedAt, null);
    assert.equal(attachmentImport.status, "FAILED");
    assert.equal(attachmentImport.failureCode, "pdf_policy_violation");
    assert.ok(attachmentImport.completedAt);
    assert.equal(inbox.status, "FAILED");
    assert.deepEqual(inbox.payload, {
      schemaVersion: 1,
      kind: "zotero-attachment-import",
      attachmentImportId: target.attachmentImportId,
      importStatus: "FAILED",
      phase: "failed",
    });
    assert.equal(batch.status, "FAILED");
    assert.equal(batch.failureCount, 1);
    assert.equal(await prisma.job.count({
      where: { organizationId: target.organizationId, type: "TEXT_EXTRACTION" },
    }), 0);
  } finally {
    await cleanup([target]);
  }
});

test("Zotero extraction dead-letter closes ATTENTION and can recover through EXTRACTING", async () => {
  const target = await createZoteroPipelineTarget("attention");
  try {
    const validationLease = await claimNextDocumentValidationJob({
      workerId: "zotero-pipeline-attention-validation",
      leaseTtlMs: LEASE_TTL_MS,
      now: TEST_EPOCH,
    });
    assert.ok(validationLease);
    await completeDocumentValidationLease({
      lease: validationLease,
      attestation: validationAttestation(validationLease),
      extractionToolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
      now: plusMilliseconds(TEST_EPOCH, 1_000),
    });
    const extractionJob = await prisma.job.findFirstOrThrow({
      where: { organizationId: target.organizationId, type: "TEXT_EXTRACTION" },
    });
    const firstLease = await claimExtraction(extractionJob.runAfter);
    assert.ok(firstLease);
    const failedAt = plusMilliseconds(extractionJob.runAfter, 1_000);
    assert.equal(await failDocumentTextExtractionLease({
      lease: firstLease,
      code: "extraction_response_invalid",
      retryable: false,
      now: failedAt,
    }), "dead-letter");

    let [intake, attachmentImport, inbox, batch] = await Promise.all([
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
      prisma.zoteroAttachmentImport.findUniqueOrThrow({ where: { id: target.attachmentImportId } }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: target.inboxEntryId } }),
      prisma.importBatch.findUniqueOrThrow({ where: { id: target.importBatchId } }),
    ]);
    assert.equal(intake.status, "ATTENTION");
    assert.equal(intake.completedAt, null);
    assert.equal(intake.failureCode, "extraction_response_invalid");
    assert.equal(attachmentImport.status, "ATTENTION");
    assert.ok(attachmentImport.completedAt);
    assert.equal(batch.status, "PARTIAL");
    assert.deepEqual(inbox.payload, {
      schemaVersion: 1,
      kind: "zotero-attachment-import",
      attachmentImportId: target.attachmentImportId,
      importStatus: "ATTENTION",
      phase: "attention",
    });

    const recoveryAt = plusMilliseconds(failedAt, 1_000);
    await prisma.job.update({
      where: { id: extractionJob.id },
      data: {
        status: "RETRYING",
        runAfter: recoveryAt,
        completedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    const recoveryLease = await claimExtraction(recoveryAt);
    assert.ok(recoveryLease);
    [intake, attachmentImport, inbox, batch] = await Promise.all([
      prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
      prisma.zoteroAttachmentImport.findUniqueOrThrow({ where: { id: target.attachmentImportId } }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: target.inboxEntryId } }),
      prisma.importBatch.findUniqueOrThrow({ where: { id: target.importBatchId } }),
    ]);
    assert.equal(intake.status, "EXTRACTING");
    assert.equal(intake.completedAt, null);
    assert.equal(attachmentImport.status, "EXTRACTING");
    assert.equal(attachmentImport.completedAt, null);
    assert.equal(batch.status, "RUNNING");
    assert.deepEqual(inbox.payload, {
      schemaVersion: 1,
      kind: "zotero-attachment-import",
      attachmentImportId: target.attachmentImportId,
      importStatus: "EXTRACTING",
      phase: "extraction",
    });

    const recoveryEvidence = noTextAttestation(recoveryLease, recoveryAt);
    assert.equal((await completeDocumentTextExtractionLease({
      lease: recoveryLease,
      attestation: recoveryEvidence,
      now: plusMilliseconds(recoveryAt, 1_000),
    }))?.outcome, "applied");
    intake = await prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } });
    attachmentImport = await prisma.zoteroAttachmentImport.findUniqueOrThrow({
      where: { id: target.attachmentImportId },
    });
    assert.equal(intake.status, "READY");
    assert.equal(attachmentImport.status, "READY");
  } finally {
    await cleanup([target]);
  }
});
