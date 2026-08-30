import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { after, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  claimNextZoteroAttachmentDownloadJob,
  completeZoteroAttachmentDownloadLease,
  failZoteroAttachmentDownloadLease,
  MAX_ZOTERO_ATTACHMENT_PROVIDER_BACKOFF_MS,
  reconcileZoteroAttachmentDownloadCleanup,
  recordWrittenZoteroAttachmentDownload,
  ZOTERO_ATTACHMENT_CLEANUP_ATTENTION_THRESHOLD,
} from "../attachment-download-jobs";
import { queueZoteroAttachmentImport } from "../attachment-service";

const METADATA_HASH = "a".repeat(64);
const PROVIDER_MD5 = "0123456789abcdef0123456789abcdef";
const SOURCE_VERSION = "7";

interface Fixture {
  organizationId: string;
  userId: string;
  connectionId: string;
  libraryId: string;
  attachmentId: string;
}

async function fixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const organizationId = `zotero-download-workspace-${suffix}`;
  const userId = `zotero-download-user-${suffix}`;
  const connectionId = `zotero-download-connection-${suffix}`;
  const libraryId = `zotero-download-library-${suffix}`;
  const attachmentId = `zotero-download-attachment-${suffix}`;
  await prisma.user.create({
    data: { id: userId, name: "Download user", email: `${userId}@example.test` },
  });
  await prisma.organization.create({
    data: { id: organizationId, name: "Download workspace", slug: organizationId },
  });
  await prisma.member.create({
    data: { organizationId, userId, role: "member" },
  });
  await prisma.integrationConnection.create({
    data: {
      id: connectionId,
      organizationId,
      provider: "ZOTERO",
      authType: "OAUTH1",
      status: "CONNECTED",
      externalAccountId: `provider-${suffix}`,
      credentialCiphertext: new Uint8Array([1, 2, 3]),
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
      zoteroLibraryId: "314159",
      isReadable: true,
      syncEnabled: true,
      fileAccessStatus: "UNKNOWN",
    },
  });
  await prisma.zoteroObject.create({
    data: {
      id: attachmentId,
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
      zoteroObjectId: attachmentId,
      organizationId,
      zoteroLibraryId: libraryId,
      parentKey: "PARENT01",
      linkMode: "imported_file",
      contentType: "application/pdf",
      fileName: "safe-paper.pdf",
      providerMd5: PROVIDER_MD5,
      providerMtime: "1730000000000",
      sourceVersion: SOURCE_VERSION,
      metadataHash: METADATA_HASH,
      eligibility: "DOWNLOADABLE",
    },
  });
  await prisma.zoteroAttachmentPolicy.create({
    data: {
      id: `zotero-download-policy-${suffix}`,
      organizationId,
      integrationConnectionId: connectionId,
      mode: "MANUAL",
      revision: 1,
      configuredById: userId,
      configuredAt: new Date("2026-08-29T12:00:00.000Z"),
    },
  });
  return { organizationId, userId, connectionId, libraryId, attachmentId };
}

async function queue(value: Fixture) {
  return queueZoteroAttachmentImport({
    userId: value.userId,
    workspaceId: value.organizationId,
    connectionId: value.connectionId,
    attachmentId: value.attachmentId,
    command: {
      clientOperationId: `operation-${randomUUID()}`,
      expectedPolicyRevision: 1,
      sourceVersion: SOURCE_VERSION,
      metadataHash: METADATA_HASH,
      providerMd5: PROVIDER_MD5,
    },
  }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } });
}

async function cleanup(value: Fixture): Promise<void> {
  const organizationId = value.organizationId;
  await prisma.$transaction(async (transaction) => {
    await transaction.auditEvent.deleteMany({ where: { organizationId } });
    await transaction.idempotencyRecord.deleteMany({ where: { organizationId } });
    await transaction.job.deleteMany({
      where: { organizationId, type: { not: "DOCUMENT_DOWNLOAD" } },
    });
    await transaction.documentIngestReceipt.deleteMany({ where: { organizationId } });
    await transaction.documentIngressAttempt.deleteMany({ where: { organizationId } });
    await transaction.zoteroAttachmentImport.deleteMany({ where: { organizationId } });
    await transaction.jobAttempt.deleteMany({ where: { organizationId } });
    await transaction.job.deleteMany({ where: { organizationId } });
    await transaction.documentIntake.deleteMany({ where: { organizationId } });
    await transaction.provenanceRecord.deleteMany({ where: { organizationId } });
    await transaction.documentAsset.deleteMany({ where: { organizationId } });
    await transaction.inboxEntry.deleteMany({ where: { organizationId } });
    await transaction.importBatch.deleteMany({ where: { organizationId } });
    await transaction.asset.deleteMany({ where: { organizationId } });
    await transaction.document.deleteMany({ where: { organizationId } });
    await transaction.zoteroAttachment.deleteMany({ where: { organizationId } });
    await transaction.zoteroObject.deleteMany({ where: { organizationId } });
    await transaction.zoteroAttachmentPolicy.deleteMany({ where: { organizationId } });
    await transaction.zoteroLibrary.deleteMany({ where: { organizationId } });
    await transaction.integrationConnection.deleteMany({ where: { organizationId } });
    await transaction.member.deleteMany({ where: { organizationId } });
    await transaction.organization.deleteMany({ where: { id: organizationId } });
  });
  await prisma.user.deleteMany({ where: { id: value.userId } });
}

after(async () => {
  await prisma.$disconnect();
});

test("claim admits UNKNOWN file access and creates one exact fenced ingress attempt", async () => {
  const value = await fixture();
  try {
    const queued = await queue(value);
    const lease = await claimNextZoteroAttachmentDownloadJob({
      workerId: "attachment-worker-integration",
      maximumDownloadBytes: 100,
      leaseTtlMs: 60_000,
      now: new Date("2030-01-01T00:00:00.000Z"),
    });
    assert.ok(lease);
    assert.equal(lease.attachmentImportId, queued.import.id);
    assert.equal(lease.zoteroObjectId, value.attachmentId);
    assert.equal(lease.maximumBytes, 100);
    const [storedImport, intake, jobAttempt, ingressAttempt] = await Promise.all([
      prisma.zoteroAttachmentImport.findUniqueOrThrow({ where: { id: queued.import.id } }),
      prisma.documentIntake.findUniqueOrThrow({ where: { id: queued.import.intakeId } }),
      prisma.jobAttempt.findUniqueOrThrow({ where: { id: lease.jobAttemptId } }),
      prisma.documentIngressAttempt.findUniqueOrThrow({ where: { id: lease.ingressAttemptId } }),
    ]);
    assert.equal(storedImport.status, "DOWNLOADING");
    assert.equal(intake.status, "RECEIVING");
    assert.equal(jobAttempt.leaseId, lease.leaseId);
    assert.equal(ingressAttempt.jobAttemptId, lease.jobAttemptId);
    assert.equal(ingressAttempt.providerMd5, PROVIDER_MD5);
    assert.equal(ingressAttempt.storageKey, lease.storageKey);
  } finally {
    await cleanup(value);
  }
});

test("claim rejects a queued command after file access becomes UNAVAILABLE and closes its ledger", async () => {
  const value = await fixture();
  try {
    const queued = await queue(value);
    await prisma.zoteroLibrary.update({
      where: { id: value.libraryId },
      data: { fileAccessStatus: "UNAVAILABLE", accessLostAt: new Date() },
    });
    assert.equal(await claimNextZoteroAttachmentDownloadJob({
      workerId: "attachment-worker-integration",
      maximumDownloadBytes: 100,
      leaseTtlMs: 60_000,
      now: new Date("2030-01-01T00:00:00.000Z"),
    }), null);
    const [storedImport, intake, job, inbox, batch] = await Promise.all([
      prisma.zoteroAttachmentImport.findUniqueOrThrow({ where: { id: queued.import.id } }),
      prisma.documentIntake.findUniqueOrThrow({ where: { id: queued.import.intakeId } }),
      prisma.job.findUniqueOrThrow({ where: { id: queued.import.downloadJobId! } }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: queued.import.inboxEntryId! } }),
      prisma.importBatch.findUniqueOrThrow({
        where: { organizationId_externalRequestId: {
          organizationId: value.organizationId,
          externalRequestId: queued.import.id,
        } },
      }),
    ]);
    assert.equal(storedImport.status, "FAILED");
    assert.equal(intake.status, "FAILED");
    assert.ok(intake.quotaReleasedAt);
    assert.equal(job.status, "DEAD_LETTER");
    assert.equal(inbox.status, "FAILED");
    assert.deepEqual(inbox.payload, {
      schemaVersion: 1,
      kind: "zotero-attachment-import",
      attachmentImportId: queued.import.id,
      importStatus: "FAILED",
    });
    assert.equal(batch.status, "FAILED");
    assert.equal(batch.processedCount, 1);
    assert.equal(batch.failureCount, 1);
    assert.ok(batch.completedAt);
  } finally {
    await cleanup(value);
  }
});

test("quarantine adoption advances the Inbox ledger but leaves batch success to validation", async () => {
  const value = await fixture();
  try {
    const queued = await queue(value);
    const claimTime = new Date("2030-01-01T00:00:00.000Z");
    const lease = await claimNextZoteroAttachmentDownloadJob({
      workerId: "attachment-worker-integration",
      maximumDownloadBytes: 100,
      leaseTtlMs: 60_000,
      now: claimTime,
    });
    assert.ok(lease);
    const written = {
      storageKey: lease.storageKey,
      sizeBytes: 50n,
      sha256: "c".repeat(64),
      md5: PROVIDER_MD5,
      mimeType: "application/pdf" as const,
      storedAt: new Date("2030-01-01T00:00:01.000Z"),
    };
    assert.equal(await recordWrittenZoteroAttachmentDownload({
      lease,
      written,
      now: new Date("2030-01-01T00:00:02.000Z"),
    }), true);
    assert.equal(await completeZoteroAttachmentDownloadLease({
      lease,
      written,
      now: new Date("2030-01-01T00:00:03.000Z"),
    }), "applied");
    const [storedImport, intake, inbox, batch, receipt, validationJob] = await Promise.all([
      prisma.zoteroAttachmentImport.findUniqueOrThrow({ where: { id: queued.import.id } }),
      prisma.documentIntake.findUniqueOrThrow({ where: { id: queued.import.intakeId } }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: queued.import.inboxEntryId! } }),
      prisma.importBatch.findUniqueOrThrow({
        where: { organizationId_externalRequestId: {
          organizationId: value.organizationId,
          externalRequestId: queued.import.id,
        } },
      }),
      prisma.documentIngestReceipt.findFirstOrThrow({
        where: { organizationId: value.organizationId, zoteroAttachmentImportId: queued.import.id },
      }),
      prisma.job.findFirstOrThrow({
        where: { organizationId: value.organizationId, type: "DOCUMENT_VALIDATE" },
      }),
    ]);
    assert.equal(storedImport.status, "QUARANTINED");
    assert.equal(intake.status, "QUARANTINED");
    assert.equal(inbox.status, "NEEDS_REVIEW");
    assert.deepEqual(inbox.payload, {
      schemaVersion: 1,
      kind: "zotero-attachment-import",
      attachmentImportId: queued.import.id,
      importStatus: "QUARANTINED",
    });
    assert.equal(batch.status, "RUNNING");
    assert.equal(batch.processedCount, 0);
    assert.equal(batch.successCount, 0);
    assert.equal(receipt.ingressAttemptId, lease.ingressAttemptId);
    assert.equal(validationJob.ingestReceiptId, receipt.id);
    assert.equal(validationJob.intakeId, intake.id);
  } finally {
    await cleanup(value);
  }
});

test("a stale leased credential cannot publish provider backoff onto a rotated generation", async () => {
  const value = await fixture();
  try {
    await queue(value);
    const lease = await claimNextZoteroAttachmentDownloadJob({
      workerId: "attachment-worker-integration",
      maximumDownloadBytes: 100,
      leaseTtlMs: 60_000,
      now: new Date("2030-01-01T00:00:00.000Z"),
    });
    assert.ok(lease);
    await prisma.integrationConnection.update({
      where: { id: value.connectionId },
      data: {
        credentialCiphertext: new Uint8Array([4, 5, 6]),
        credentialFingerprint: `rotated-${randomUUID()}`,
        credentialGeneration: { increment: 1 },
      },
    });
    assert.deepEqual(await failZoteroAttachmentDownloadLease({
      lease,
      failure: {
        code: "zotero_rate_limited",
        retryable: true,
        retryAt: new Date("2030-01-01T00:10:00.000Z"),
        connectionWideBackoff: true,
      },
      now: new Date("2030-01-01T00:00:01.000Z"),
    }), {
      outcome: "cleanup-required",
      ingressAttemptId: lease.ingressAttemptId,
      terminal: true,
    });
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: value.connectionId },
    });
    assert.equal(connection.credentialGeneration, lease.credentialGeneration + 1);
    assert.equal(connection.providerBackoffUntil, null);
  } finally {
    await cleanup(value);
  }
});

test("a payload naming another tenant's import never mutates that healthy import", async () => {
  const first = await fixture();
  const foreign = await fixture();
  try {
    const firstQueued = await queue(first);
    const foreignQueued = await queue(foreign);
    await prisma.job.update({
      where: { id: foreignQueued.import.downloadJobId! },
      data: { runAfter: new Date("2100-01-01T00:00:00.000Z") },
    });
    await prisma.job.update({
      where: { id: firstQueued.import.downloadJobId! },
      data: {
        payload: {
          schemaVersion: 1,
          attachmentImportId: foreignQueued.import.id,
        },
      },
    });

    assert.equal(await claimNextZoteroAttachmentDownloadJob({
      workerId: "attachment-worker-integration",
      maximumDownloadBytes: 100,
      leaseTtlMs: 60_000,
      now: new Date("2030-01-01T00:00:00.000Z"),
    }), null);

    const [firstImport, firstJob, foreignImport, foreignIntake, foreignJob] =
      await Promise.all([
        prisma.zoteroAttachmentImport.findUniqueOrThrow({
          where: { id: firstQueued.import.id },
        }),
        prisma.job.findUniqueOrThrow({
          where: { id: firstQueued.import.downloadJobId! },
        }),
        prisma.zoteroAttachmentImport.findUniqueOrThrow({
          where: { id: foreignQueued.import.id },
        }),
        prisma.documentIntake.findUniqueOrThrow({
          where: { id: foreignQueued.import.intakeId },
        }),
        prisma.job.findUniqueOrThrow({
          where: { id: foreignQueued.import.downloadJobId! },
        }),
      ]);
    assert.equal(firstImport.status, "FAILED");
    assert.equal(firstJob.status, "DEAD_LETTER");
    assert.equal(foreignImport.status, "QUEUED");
    assert.equal(foreignIntake.status, "QUEUED");
    assert.equal(foreignIntake.quotaReleasedAt, null);
    assert.equal(foreignJob.status, "QUEUED");
  } finally {
    await cleanup(first);
    await cleanup(foreign);
  }
});

test("a stray job without an exact import binding cannot fail typed healthy targets", async () => {
  const value = await fixture();
  try {
    const queued = await queue(value);
    await prisma.job.update({
      where: { id: queued.import.downloadJobId! },
      data: { runAfter: new Date("2100-01-01T00:00:00.000Z") },
    });
    const strayJob = await prisma.job.create({
      data: {
        organizationId: value.organizationId,
        type: "DOCUMENT_DOWNLOAD",
        status: "QUEUED",
        dedupeKey: `stray-zotero-download:${randomUUID()}`,
        payload: {
          schemaVersion: 1,
          attachmentImportId: queued.import.id,
        },
        attempts: 0,
        maxAttempts: 5,
        runAfter: new Date("2029-01-01T00:00:00.000Z"),
        integrationConnectionId: value.connectionId,
        zoteroLibraryId: value.libraryId,
        documentId: queued.import.documentId,
        assetId: queued.import.assetId,
        intakeId: queued.import.intakeId,
      },
    });

    assert.equal(await claimNextZoteroAttachmentDownloadJob({
      workerId: "attachment-worker-integration",
      maximumDownloadBytes: 100,
      leaseTtlMs: 60_000,
      now: new Date("2030-01-01T00:00:00.000Z"),
    }), null);

    const [storedImport, intake, asset, document, inbox, batch, storedStray] =
      await Promise.all([
        prisma.zoteroAttachmentImport.findUniqueOrThrow({
          where: { id: queued.import.id },
        }),
        prisma.documentIntake.findUniqueOrThrow({
          where: { id: queued.import.intakeId },
        }),
        prisma.asset.findUniqueOrThrow({ where: { id: queued.import.assetId } }),
        prisma.document.findUniqueOrThrow({
          where: { id: queued.import.documentId },
        }),
        prisma.inboxEntry.findUniqueOrThrow({
          where: { id: queued.import.inboxEntryId! },
        }),
        prisma.importBatch.findUniqueOrThrow({
          where: { organizationId_externalRequestId: {
            organizationId: value.organizationId,
            externalRequestId: queued.import.id,
          } },
        }),
        prisma.job.findUniqueOrThrow({ where: { id: strayJob.id } }),
      ]);
    assert.equal(storedStray.status, "DEAD_LETTER");
    assert.equal(storedImport.status, "QUEUED");
    assert.equal(intake.status, "QUEUED");
    assert.equal(intake.quotaReleasedAt, null);
    assert.equal(asset.status, "UPLOADING");
    assert.equal(document.status, "PENDING");
    assert.equal(inbox.status, "NEEDS_REVIEW");
    assert.equal(batch.status, "RUNNING");
  } finally {
    await cleanup(value);
  }
});

test("cleanup attention dead-letters logical state while retaining charge until deletion", async () => {
  const value = await fixture();
  try {
    const queued = await queue(value);
    const claimTime = new Date("2030-01-01T00:00:00.000Z");
    const lease = await claimNextZoteroAttachmentDownloadJob({
      workerId: "attachment-worker-integration",
      maximumDownloadBytes: 100,
      leaseTtlMs: 60_000,
      now: claimTime,
    });
    assert.ok(lease);
    assert.deepEqual(await failZoteroAttachmentDownloadLease({
      lease,
      failure: { code: "download_storage_unavailable", retryable: true },
      now: new Date("2030-01-01T00:00:01.000Z"),
    }), {
      outcome: "cleanup-required",
      ingressAttemptId: lease.ingressAttemptId,
      terminal: false,
    });
    await prisma.documentIngressAttempt.update({
      where: { id: lease.ingressAttemptId },
      data: {
        cleanupAttemptCount:
          ZOTERO_ATTACHMENT_CLEANUP_ATTENTION_THRESHOLD - 1,
        cleanupAfter: new Date("2030-01-01T00:00:01.000Z"),
      },
    });

    assert.deepEqual(await reconcileZoteroAttachmentDownloadCleanup({
      configuration: { quarantineRoot: "relative-root-is-invalid" },
      ingressAttemptId: lease.ingressAttemptId,
      now: new Date("2030-01-01T00:00:02.000Z"),
    }), {
      outcome: "dead-letter",
      jobId: lease.jobId,
      ingressAttemptId: lease.ingressAttemptId,
    });

    const [attentionJob, attentionAttempt, attentionImport, attentionIntake, inbox, batch] =
      await Promise.all([
        prisma.job.findUniqueOrThrow({ where: { id: lease.jobId } }),
        prisma.documentIngressAttempt.findUniqueOrThrow({
          where: { id: lease.ingressAttemptId },
        }),
        prisma.zoteroAttachmentImport.findUniqueOrThrow({
          where: { id: queued.import.id },
        }),
        prisma.documentIntake.findUniqueOrThrow({
          where: { id: queued.import.intakeId },
        }),
        prisma.inboxEntry.findUniqueOrThrow({
          where: { id: queued.import.inboxEntryId! },
        }),
        prisma.importBatch.findUniqueOrThrow({
          where: { organizationId_externalRequestId: {
            organizationId: value.organizationId,
            externalRequestId: queued.import.id,
          } },
        }),
      ]);
    assert.equal(attentionJob.status, "DEAD_LETTER");
    assert.equal(
      attentionAttempt.cleanupAttemptCount,
      ZOTERO_ATTACHMENT_CLEANUP_ATTENTION_THRESHOLD,
    );
    assert.equal(attentionAttempt.cleanupCompletedAt, null);
    assert.equal(attentionAttempt.cleanupFailureCode, "cleanup_attention_required");
    assert.equal(attentionImport.status, "FAILED");
    assert.equal(attentionIntake.status, "FAILED");
    assert.equal(attentionIntake.quotaReleasedAt, null);
    assert.equal(inbox.status, "FAILED");
    assert.deepEqual(inbox.payload, {
      schemaVersion: 1,
      kind: "zotero-attachment-import",
      attachmentImportId: queued.import.id,
      importStatus: "FAILED",
    });
    assert.equal(batch.status, "FAILED");
    assert.equal(batch.processedCount, 1);
    assert.equal(batch.failureCount, 1);

    assert.deepEqual(await reconcileZoteroAttachmentDownloadCleanup({
      configuration: { quarantineRoot: "relative-root-is-still-invalid" },
      ingressAttemptId: lease.ingressAttemptId,
      now: new Date("2030-01-01T00:16:03.000Z"),
    }), {
      outcome: "retrying",
      jobId: lease.jobId,
      ingressAttemptId: lease.ingressAttemptId,
    });
    const continuedAttempt = await prisma.documentIngressAttempt.findUniqueOrThrow({
      where: { id: lease.ingressAttemptId },
    });
    assert.equal(
      continuedAttempt.cleanupAttemptCount,
      ZOTERO_ATTACHMENT_CLEANUP_ATTENTION_THRESHOLD + 1,
    );
    assert.equal(continuedAttempt.cleanupCompletedAt, null);

    const emptyAbsoluteRoot = resolve(
      ".paperpilot-test-quarantine",
      randomUUID(),
    );
    assert.deepEqual(await reconcileZoteroAttachmentDownloadCleanup({
      configuration: { quarantineRoot: emptyAbsoluteRoot },
      ingressAttemptId: lease.ingressAttemptId,
      now: new Date("2030-01-01T00:32:04.000Z"),
    }), {
      outcome: "dead-letter",
      jobId: lease.jobId,
      ingressAttemptId: lease.ingressAttemptId,
    });
    const [cleanedAttempt, releasedIntake, finalJob] = await Promise.all([
      prisma.documentIngressAttempt.findUniqueOrThrow({
        where: { id: lease.ingressAttemptId },
      }),
      prisma.documentIntake.findUniqueOrThrow({
        where: { id: queued.import.intakeId },
      }),
      prisma.job.findUniqueOrThrow({ where: { id: lease.jobId } }),
    ]);
    assert.ok(cleanedAttempt.cleanupCompletedAt);
    assert.ok(releasedIntake.quotaReleasedAt);
    assert.equal(finalJob.status, "DEAD_LETTER");
  } finally {
    await cleanup(value);
  }
});

test("provider retry timestamps cannot park a job or connection beyond the maximum horizon", async () => {
  const value = await fixture();
  try {
    await queue(value);
    const now = new Date("2030-01-01T00:00:00.000Z");
    const lease = await claimNextZoteroAttachmentDownloadJob({
      workerId: "attachment-worker-integration",
      maximumDownloadBytes: 100,
      leaseTtlMs: 60_000,
      now,
    });
    assert.ok(lease);
    assert.deepEqual(await failZoteroAttachmentDownloadLease({
      lease,
      failure: {
        code: "zotero_rate_limited",
        retryable: true,
        retryAt: new Date("9999-12-31T23:59:59.000Z"),
        connectionWideBackoff: true,
      },
      now: new Date(now.getTime() + 1_000),
    }), {
      outcome: "cleanup-required",
      ingressAttemptId: lease.ingressAttemptId,
      terminal: false,
    });
    const maximumRetryAt = new Date(
      now.getTime() + 1_000 + MAX_ZOTERO_ATTACHMENT_PROVIDER_BACKOFF_MS,
    );
    const [job, connection, audit] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: lease.jobId } }),
      prisma.integrationConnection.findUniqueOrThrow({
        where: { id: value.connectionId },
      }),
      prisma.auditEvent.findFirstOrThrow({
        where: {
          organizationId: value.organizationId,
          action: "zotero.attachment-download.retrying",
          entityId: lease.jobId,
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    assert.equal(job.runAfter.getTime(), maximumRetryAt.getTime());
    assert.equal(connection.providerBackoffUntil?.getTime(), maximumRetryAt.getTime());
    assert.deepEqual(audit.metadata, {
      failureCode: "zotero_rate_limited",
      retryScheduled: true,
      providerRetryClamped: true,
      authorityCurrent: true,
    });
  } finally {
    await cleanup(value);
  }
});

test("a fast host clock cannot reject a valid lease commit", async (context) => {
  const value = await fixture();
  try {
    await queue(value);
    const lease = await claimNextZoteroAttachmentDownloadJob({
      workerId: "attachment-worker-integration",
      maximumDownloadBytes: 100,
      leaseTtlMs: 60_000,
      now: new Date("2030-01-01T00:00:00.000Z"),
    });
    assert.ok(lease);
    context.mock.timers.enable({
      apis: ["Date"],
      now: new Date("9999-01-01T00:00:00.000Z"),
    });
    const written = {
      storageKey: lease.storageKey,
      sizeBytes: 50n,
      sha256: "c".repeat(64),
      md5: PROVIDER_MD5,
      mimeType: "application/pdf" as const,
      storedAt: new Date("2030-01-01T00:00:01.000Z"),
    };
    assert.equal(await recordWrittenZoteroAttachmentDownload({
      lease,
      written,
    }), true);
  } finally {
    context.mock.timers.reset();
    await cleanup(value);
  }
});

test("a slow host clock cannot prevent the database from reaping an expired lease", async (context) => {
  const value = await fixture();
  try {
    await queue(value);
    const lease = await claimNextZoteroAttachmentDownloadJob({
      workerId: "attachment-worker-integration",
      maximumDownloadBytes: 100,
      leaseTtlMs: 60_000,
      now: new Date("2030-01-01T00:00:00.000Z"),
    });
    assert.ok(lease);
    const expiredAt = new Date("2000-01-01T00:00:00.000Z");
    await prisma.$transaction([
      prisma.job.update({
        where: { id: lease.jobId },
        data: {
          lockedAt: new Date("1999-12-31T23:59:00.000Z"),
          leaseExpiresAt: expiredAt,
        },
      }),
      prisma.documentIngressAttempt.update({
        where: { id: lease.ingressAttemptId },
        data: { leaseExpiresAt: expiredAt },
      }),
    ]);
    context.mock.timers.enable({
      apis: ["Date"],
      now: new Date("1900-01-01T00:00:00.000Z"),
    });
    assert.equal(await claimNextZoteroAttachmentDownloadJob({
      workerId: "attachment-worker-integration-reaper",
      maximumDownloadBytes: 100,
      leaseTtlMs: 60_000,
    }), null);
    const [job, attempt] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: lease.jobId } }),
      prisma.documentIngressAttempt.findUniqueOrThrow({
        where: { id: lease.ingressAttemptId },
      }),
    ]);
    assert.equal(job.status, "RETRYING");
    assert.equal(attempt.status, "ABANDONED");
    assert.ok(attempt.cleanupAfter);
    assert.ok(attempt.cleanupAfter.getTime() > new Date("2020-01-01").getTime());
  } finally {
    context.mock.timers.reset();
    await cleanup(value);
  }
});
