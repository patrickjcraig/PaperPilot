import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  streamRequestToLocalQuarantine,
  withOpenLocalQuarantineObject,
} from "./storage";

// The local default is deliberately one connection, while these tests exercise
// two independent reconciler transactions at the same time.
process.env.DATABASE_POOL_MAX = "4";
const { prisma } = await import("@/lib/prisma");
const { documentValidationJobDedupeKey } = await import(
  "@/server/documents/validation-jobs"
);
const { reconcileUploadIntake } = await import("./reconciler");

const PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
);

after(async () => {
  await prisma.$disconnect();
});

async function temporaryQuarantineRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "paperpilot-upload-reconciler-"));
}

async function allFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: unknown }).code === "ENOENT"
      ) return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else files.push(candidate);
    }
  }
  await visit(root);
  return files.sort();
}

async function writeQuarantineObject(input: {
  root: string;
  organizationId: string;
  assetId: string;
  attemptId: string;
}) {
  return streamRequestToLocalQuarantine({
    request: new Request("https://paperpilot.test/upload", {
      method: "PUT",
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(PDF_BYTES.byteLength),
      },
      body: new Uint8Array(PDF_BYTES).buffer,
    }),
    configuration: {
      quarantineRoot: input.root,
      maxUploadBytes: 1024 * 1024,
      streamIdleTimeoutMs: 1_000,
      streamAbsoluteTimeoutMs: 5_000,
    },
    organizationId: input.organizationId,
    assetId: input.assetId,
    attemptId: input.attemptId,
    expectedSizeBytes: BigInt(PDF_BYTES.byteLength),
  });
}

async function removeOrganizations(ids: string[]): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    await transaction.auditEvent.deleteMany({
      where: { organizationId: { in: ids } },
    });
    await transaction.provenanceRecord.deleteMany({
      where: { organizationId: { in: ids } },
    });
    // Receipt rows remain immutable during normal operation. Explicit tenant
    // teardown follows the schema's cascade graph and removes the entire exact
    // integration fixture, including its jobs, before its temp root disappears.
    await transaction.organization.deleteMany({ where: { id: { in: ids } } });
  });
}

async function removeTemporaryRoot(root: string): Promise<void> {
  assert.equal(path.isAbsolute(root), true);
  assert.equal(path.relative(os.tmpdir(), root).startsWith(".."), false);
  await rm(root, { recursive: true, force: true });
}

async function withFixtureCleanup(
  organizationIds: string[],
  root: string,
  operation: () => Promise<void>,
): Promise<void> {
  let operationFailure: { error: unknown } | null = null;
  try {
    await operation();
  } catch (error) {
    operationFailure = { error };
  }

  let cleanupFailure: { error: unknown } | null = null;
  try {
    await removeOrganizations(organizationIds);
  } catch (error) {
    cleanupFailure = { error };
  }
  try {
    await removeTemporaryRoot(root);
  } catch (error) {
    cleanupFailure ??= { error };
  }

  if (operationFailure) throw operationFailure.error;
  if (cleanupFailure) throw cleanupFailure.error;
}

test("expiry is inclusive and replay emits one transition and audit event", async () => {
  const suffix = randomUUID();
  const organizationId = `reconcile-expiry-org-${suffix}`;
  const assetId = `reconcile-expiry-asset-${suffix}`;
  const documentId = `reconcile-expiry-document-${suffix}`;
  const inboxEntryId = `reconcile-expiry-inbox-${suffix}`;
  const uploadSessionId = `reconcile-expiry-upload-${suffix}`;
  const root = await temporaryQuarantineRoot();
  const now = new Date("2026-08-28T20:00:00.000Z");

  await withFixtureCleanup([organizationId], root, async () => {
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Reconciler inclusive expiry",
        slug: `reconcile-expiry-${suffix}`,
      },
    });
    await prisma.asset.create({
      data: {
        id: assetId,
        organizationId,
        storageProvider: "LOCAL",
        objectKey: `pending:${assetId}`,
        status: "UPLOADING",
      },
    });
    await prisma.document.create({
      data: {
        id: documentId,
        organizationId,
        kind: "PAPER_PDF",
        status: "PENDING",
      },
    });
    await prisma.documentAsset.create({
      data: { organizationId, documentId, assetId, role: "ORIGINAL" },
    });
    await prisma.inboxEntry.create({
      data: {
        id: inboxEntryId,
        organizationId,
        documentId,
        source: "FILE_UPLOAD",
        sourceKey: uploadSessionId,
        status: "NEEDS_REVIEW",
      },
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.documentIntake.create({
        data: {
          id: uploadSessionId,
          organizationId,
          source: "BROWSER_UPLOAD",
          status: "RESERVED",
          documentId,
          assetId,
          inboxEntryId,
          reservedBytes: BigInt(PDF_BYTES.byteLength),
        },
      });
      await transaction.uploadSession.create({
        data: {
          id: uploadSessionId,
          organizationId,
          intakeId: uploadSessionId,
          assetId,
          documentId,
          inboxEntryId,
          clientOperationId: `reconcile-expiry-operation-${suffix}`,
          requestHash: "a".repeat(64),
          status: "ISSUED",
          originalFileName: "expires-at-boundary.pdf",
          declaredMimeType: "application/pdf",
          expectedSizeBytes: BigInt(PDF_BYTES.byteLength),
          expiresAt: now,
        },
      });
    });

    // Prisma Dev serializes local transactions, so this fixture verifies
    // exact-once replay. Production overlap is guarded by FOR UPDATE SKIP LOCKED.
    const firstPass = await reconcileUploadIntake({
      now,
      configuration: { quarantineRoot: root },
    });
    const replay = await reconcileUploadIntake({
      now,
      configuration: { quarantineRoot: root },
    });
    assert.equal(firstPass.sessionsExpired, 1);
    assert.equal(firstPass.sessionsInspected, 1);
    assert.equal(replay.sessionsExpired, 0);
    assert.equal(replay.sessionsInspected, 0);

    const [session, asset, document, intake] = await Promise.all([
      prisma.uploadSession.findUniqueOrThrow({ where: { id: uploadSessionId } }),
      prisma.asset.findUniqueOrThrow({ where: { id: assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: documentId } }),
      prisma.documentIntake.findUniqueOrThrow({ where: { id: uploadSessionId } }),
    ]);
    assert.equal(session.status, "EXPIRED");
    assert.equal(session.rejectedAt?.getTime(), now.getTime());
    assert.equal(session.failureCode, "session_expired");
    assert.equal(asset.status, "REJECTED");
    assert.equal(asset.rejectionCode, "session_expired");
    assert.equal(document.status, "FAILED");
    assert.equal(document.failureCode, "session_expired");
    assert.equal(intake.status, "FAILED");
    assert.equal(intake.failureCode, "session_expired");
    assert.equal(intake.completedAt?.getTime(), now.getTime());
    assert.equal(intake.quotaReleasedAt?.getTime(), now.getTime());
    assert.equal(await prisma.auditEvent.count({
      where: {
        organizationId,
        action: "upload.session.expired",
        entityType: "upload-session",
        entityId: uploadSessionId,
      },
    }), 1);

    assert.equal(await prisma.auditEvent.count({
      where: {
        organizationId,
        action: "upload.session.expired",
        entityId: uploadSessionId,
      },
    }), 1);
  });
});

test("a stale receive lease is released and its written object is durably cleaned", async () => {
  const suffix = randomUUID();
  const organizationId = `reconcile-lease-org-${suffix}`;
  const assetId = `reconcile-lease-asset-${suffix}`;
  const documentId = `reconcile-lease-document-${suffix}`;
  const inboxEntryId = `reconcile-lease-inbox-${suffix}`;
  const uploadSessionId = `reconcile-lease-upload-${suffix}`;
  const attemptId = `reconcile-lease-attempt-${suffix}`;
  const root = await temporaryQuarantineRoot();
  const now = new Date("2026-08-28T20:15:00.000Z");
  const stored = await writeQuarantineObject({
    root,
    organizationId,
    assetId,
    attemptId,
  });

  await withFixtureCleanup([organizationId], root, async () => {
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Reconciler stale lease",
        slug: `reconcile-lease-${suffix}`,
      },
    });
    await prisma.asset.create({
      data: {
        id: assetId,
        organizationId,
        storageProvider: "LOCAL",
        objectKey: `pending:${assetId}`,
        status: "UPLOADING",
      },
    });
    await prisma.document.create({
      data: {
        id: documentId,
        organizationId,
        kind: "PAPER_PDF",
        status: "PENDING",
      },
    });
    await prisma.documentAsset.create({
      data: { organizationId, documentId, assetId, role: "ORIGINAL" },
    });
    await prisma.inboxEntry.create({
      data: {
        id: inboxEntryId,
        organizationId,
        documentId,
        source: "FILE_UPLOAD",
        sourceKey: uploadSessionId,
        status: "NEEDS_REVIEW",
      },
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.documentIntake.create({
        data: {
          id: uploadSessionId,
          organizationId,
          source: "BROWSER_UPLOAD",
          status: "RECEIVING",
          documentId,
          assetId,
          inboxEntryId,
          reservedBytes: stored.sizeBytes,
        },
      });
      await transaction.uploadSession.create({
        data: {
          id: uploadSessionId,
          organizationId,
          intakeId: uploadSessionId,
          assetId,
          documentId,
          inboxEntryId,
          clientOperationId: `reconcile-lease-operation-${suffix}`,
          requestHash: "b".repeat(64),
          status: "RECEIVING",
          originalFileName: "crashed-receive.pdf",
          declaredMimeType: "application/pdf",
          expectedSizeBytes: stored.sizeBytes,
          expiresAt: new Date(now.getTime() + 60_000),
          claimedAt: new Date(now.getTime() - 60_000),
          claimExpiresAt: now,
          claimId: attemptId,
          attemptCount: 1,
        },
      });
    });
    await prisma.uploadAttempt.create({
      data: {
        id: attemptId,
        organizationId,
        uploadSessionId,
        assetId,
        attemptNumber: 1,
        storageKey: stored.storageKey,
        status: "WRITTEN",
        expectedSizeBytes: stored.sizeBytes,
        receivedSizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        leaseExpiresAt: now,
        storedAt: new Date(now.getTime() - 1_000),
      },
    });
    assert.equal((await allFiles(root)).length, 1);

    const summary = await reconcileUploadIntake({
      now,
      configuration: { quarantineRoot: root },
    });
    assert.equal(summary.receiveLeasesReleased, 1);
    assert.equal(summary.cleanupClaimed, 1);
    assert.equal(summary.cleanupCompleted, 1);
    assert.equal(summary.cleanupDeferred, 0);

    const [session, attempt, intake] = await Promise.all([
      prisma.uploadSession.findUniqueOrThrow({ where: { id: uploadSessionId } }),
      prisma.uploadAttempt.findUniqueOrThrow({ where: { id: attemptId } }),
      prisma.documentIntake.findUniqueOrThrow({ where: { id: uploadSessionId } }),
    ]);
    assert.equal(session.status, "ISSUED");
    assert.equal(session.claimedAt, null);
    assert.equal(session.claimExpiresAt, null);
    assert.equal(session.claimId, null);
    assert.equal(attempt.status, "ABANDONED");
    assert.equal(attempt.failureCode, "receive_lease_expired");
    assert.equal(attempt.completedAt?.getTime(), now.getTime());
    assert.equal(attempt.cleanupCompletedAt?.getTime(), now.getTime());
    assert.equal(attempt.cleanupAfter, null);
    assert.equal(attempt.cleanupAttemptCount, 1);
    assert.equal(attempt.cleanupFailureCode, null);
    assert.equal(intake.status, "RECEIVING");
    assert.equal(intake.quotaReleasedAt, null);
    assert.deepEqual(await allFiles(root), []);
    assert.equal(await prisma.auditEvent.count({
      where: {
        organizationId,
        action: "upload.receive_lease.released",
        entityId: uploadSessionId,
      },
    }), 1);

    const replay = await reconcileUploadIntake({
      now,
      configuration: { quarantineRoot: root },
    });
    assert.equal(replay.receiveLeasesReleased, 0);
    assert.equal(replay.cleanupClaimed, 0);
    assert.equal(await prisma.uploadAttempt.count({ where: { id: attemptId } }), 1);
  });
});

test("a missing validation job is repaired exactly once", async () => {
  const suffix = randomUUID();
  const organizationId = `reconcile-job-org-${suffix}`;
  const assetId = `reconcile-job-asset-${suffix}`;
  const documentId = `reconcile-job-document-${suffix}`;
  const inboxEntryId = `reconcile-job-inbox-${suffix}`;
  const uploadSessionId = `reconcile-job-upload-${suffix}`;
  const attemptId = `reconcile-job-attempt-${suffix}`;
  const root = await temporaryQuarantineRoot();
  const now = new Date("2026-08-28T20:30:00.000Z");
  const stored = await writeQuarantineObject({
    root,
    organizationId,
    assetId,
    attemptId,
  });
  const dedupeKey = documentValidationJobDedupeKey(uploadSessionId);

  await withFixtureCleanup([organizationId], root, async () => {
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Reconciler missing validation job",
        slug: `reconcile-job-${suffix}`,
      },
    });
    await prisma.asset.create({
      data: {
        id: assetId,
        organizationId,
        storageProvider: "LOCAL",
        objectKey: stored.storageKey,
        physicalLocator: stored.storageKey,
        status: "QUARANTINED",
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
      },
    });
    await prisma.document.create({
      data: {
        id: documentId,
        organizationId,
        kind: "PAPER_PDF",
        status: "PENDING",
        mimeType: stored.mimeType,
        contentHash: stored.sha256,
      },
    });
    await prisma.documentAsset.create({
      data: { organizationId, documentId, assetId, role: "ORIGINAL" },
    });
    await prisma.inboxEntry.create({
      data: {
        id: inboxEntryId,
        organizationId,
        documentId,
        source: "FILE_UPLOAD",
        status: "NEEDS_REVIEW",
      },
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.documentIntake.create({
        data: {
          id: uploadSessionId,
          organizationId,
          source: "BROWSER_UPLOAD",
          status: "QUARANTINED",
          documentId,
          assetId,
          inboxEntryId,
          reservedBytes: stored.sizeBytes,
          committedBytes: stored.sizeBytes,
        },
      });
      await transaction.uploadSession.create({
        data: {
          id: uploadSessionId,
          organizationId,
          intakeId: uploadSessionId,
          assetId,
          documentId,
          inboxEntryId,
          clientOperationId: `reconcile-job-operation-${suffix}`,
          requestHash: "c".repeat(64),
          status: "STORED",
          originalFileName: "missing-job.pdf",
          declaredMimeType: "application/pdf",
          expectedSizeBytes: stored.sizeBytes,
          receivedSizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          expiresAt: new Date(now.getTime() - 60_000),
          storedAt: new Date(now.getTime() - 30_000),
          attemptCount: 1,
        },
      });
    });
    await prisma.uploadAttempt.create({
      data: {
        id: attemptId,
        organizationId,
        uploadSessionId,
        assetId,
        attemptNumber: 1,
        storageKey: stored.storageKey,
        status: "COMMITTED",
        expectedSizeBytes: stored.sizeBytes,
        receivedSizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        leaseExpiresAt: new Date(now.getTime() - 30_000),
        storedAt: new Date(now.getTime() - 30_000),
        completedAt: new Date(now.getTime() - 30_000),
      },
    });
    const first = await reconcileUploadIntake({
      now,
      configuration: { quarantineRoot: root },
    });
    const second = await reconcileUploadIntake({
      now,
      configuration: { quarantineRoot: root },
    });
    assert.equal(first.validationJobsEnqueued, 1);
    assert.equal(second.validationJobsEnqueued, 0);

    const localJobs = await prisma.job.findMany({
      where: { organizationId, type: "DOCUMENT_VALIDATE", dedupeKey },
    });
    assert.equal(localJobs.length, 1);
    assert.equal(localJobs[0].documentId, documentId);
    assert.equal(localJobs[0].assetId, assetId);
    assert.equal(localJobs[0].intakeId, uploadSessionId);
    assert.equal(await prisma.auditEvent.count({
      where: {
        organizationId,
        action: "document.validation.job_reconciled",
        entityId: uploadSessionId,
      },
    }), 1);
    const replay = await reconcileUploadIntake({
      now,
      configuration: { quarantineRoot: root },
    });
    assert.equal(replay.validationJobsEnqueued, 0);
    assert.equal(await prisma.job.count({
      where: { organizationId, type: "DOCUMENT_VALIDATE", dedupeKey },
    }), 1);
    assert.equal(await prisma.auditEvent.count({
      where: {
        organizationId,
        action: "document.validation.job_reconciled",
        entityId: uploadSessionId,
      },
    }), 1);
    assert.equal((await allFiles(root)).length, 1);
  });
});

test("cleanup never deletes an adopted object or a foreign tenant's authoritative object", async () => {
  const suffix = randomUUID();
  const organizationId = `reconcile-adopted-org-${suffix}`;
  const foreignOrganizationId = `reconcile-adopted-foreign-org-${suffix}`;
  const assetId = `reconcile-adopted-asset-${suffix}`;
  const foreignAssetId = `reconcile-adopted-foreign-asset-${suffix}`;
  const documentId = `reconcile-adopted-document-${suffix}`;
  const inboxEntryId = `reconcile-adopted-inbox-${suffix}`;
  const uploadSessionId = `reconcile-adopted-upload-${suffix}`;
  const adoptedAttemptId = `reconcile-adopted-attempt-${suffix}`;
  const mismatchedAttemptId = `reconcile-mismatch-attempt-${suffix}`;
  const foreignAttemptId = `reconcile-foreign-attempt-${suffix}`;
  const root = await temporaryQuarantineRoot();
  const now = new Date("2026-08-28T20:45:00.000Z");
  const [adopted, foreign] = await Promise.all([
    writeQuarantineObject({
      root,
      organizationId,
      assetId,
      attemptId: adoptedAttemptId,
    }),
    writeQuarantineObject({
      root,
      organizationId: foreignOrganizationId,
      assetId: foreignAssetId,
      attemptId: foreignAttemptId,
    }),
  ]);

  await withFixtureCleanup(
    [organizationId, foreignOrganizationId],
    root,
    async () => {
    await prisma.organization.createMany({
      data: [
        {
          id: organizationId,
          name: "Reconciler adopted object",
          slug: `reconcile-adopted-${suffix}`,
        },
        {
          id: foreignOrganizationId,
          name: "Reconciler protected foreign object",
          slug: `reconcile-adopted-foreign-${suffix}`,
        },
      ],
    });
    await prisma.asset.createMany({
      data: [
        {
          id: assetId,
          organizationId,
          storageProvider: "LOCAL",
          objectKey: adopted.storageKey,
          physicalLocator: adopted.storageKey,
          status: "QUARANTINED",
          mimeType: adopted.mimeType,
          sizeBytes: adopted.sizeBytes,
          sha256: adopted.sha256,
        },
        {
          id: foreignAssetId,
          organizationId: foreignOrganizationId,
          storageProvider: "LOCAL",
          objectKey: foreign.storageKey,
          physicalLocator: foreign.storageKey,
          status: "QUARANTINED",
          mimeType: foreign.mimeType,
          sizeBytes: foreign.sizeBytes,
          sha256: foreign.sha256,
        },
      ],
    });
    await prisma.document.create({
      data: {
        id: documentId,
        organizationId,
        kind: "PAPER_PDF",
        status: "PENDING",
        mimeType: adopted.mimeType,
        contentHash: adopted.sha256,
      },
    });
    await prisma.documentAsset.create({
      data: { organizationId, documentId, assetId, role: "ORIGINAL" },
    });
    await prisma.inboxEntry.create({
      data: {
        id: inboxEntryId,
        organizationId,
        documentId,
        source: "FILE_UPLOAD",
        sourceKey: uploadSessionId,
        status: "NEEDS_REVIEW",
      },
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.documentIntake.create({
        data: {
          id: uploadSessionId,
          organizationId,
          source: "BROWSER_UPLOAD",
          status: "VALIDATING",
          documentId,
          assetId,
          inboxEntryId,
          reservedBytes: adopted.sizeBytes,
          committedBytes: adopted.sizeBytes,
        },
      });
      await transaction.uploadSession.create({
        data: {
          id: uploadSessionId,
          organizationId,
          intakeId: uploadSessionId,
          assetId,
          documentId,
          inboxEntryId,
          clientOperationId: `reconcile-adopted-operation-${suffix}`,
          requestHash: "d".repeat(64),
          status: "STORED",
          originalFileName: "adopted.pdf",
          declaredMimeType: "application/pdf",
          expectedSizeBytes: adopted.sizeBytes,
          receivedSizeBytes: adopted.sizeBytes,
          sha256: adopted.sha256,
          expiresAt: new Date(now.getTime() - 60_000),
          storedAt: new Date(now.getTime() - 30_000),
          attemptCount: 2,
        },
      });
    });
    await prisma.uploadAttempt.createMany({
      data: [
        {
          id: adoptedAttemptId,
          organizationId,
          uploadSessionId,
          assetId,
          attemptNumber: 1,
          storageKey: adopted.storageKey,
          status: "ABANDONED",
          expectedSizeBytes: adopted.sizeBytes,
          receivedSizeBytes: adopted.sizeBytes,
          sha256: adopted.sha256,
          leaseExpiresAt: new Date(now.getTime() - 60_000),
          completedAt: new Date(now.getTime() - 30_000),
          failureCode: "receive_lease_expired",
          cleanupAfter: now,
        },
        {
          id: mismatchedAttemptId,
          organizationId,
          uploadSessionId,
          assetId,
          attemptNumber: 2,
          storageKey: foreign.storageKey,
          status: "ABANDONED",
          expectedSizeBytes: foreign.sizeBytes,
          receivedSizeBytes: foreign.sizeBytes,
          sha256: foreign.sha256,
          leaseExpiresAt: new Date(now.getTime() - 60_000),
          completedAt: new Date(now.getTime() - 30_000),
          failureCode: "receive_lease_expired",
          cleanupAfter: now,
        },
      ],
    });
    assert.equal((await allFiles(root)).length, 2);

    const summary = await reconcileUploadIntake({
      now,
      configuration: { quarantineRoot: root },
    });
    assert.equal(summary.cleanupClaimed, 2);
    assert.equal(summary.cleanupCompleted, 1);
    assert.equal(summary.cleanupDeferred, 1);

    const [adoptedAttempt, mismatchedAttempt, foreignAsset] = await Promise.all([
      prisma.uploadAttempt.findUniqueOrThrow({ where: { id: adoptedAttemptId } }),
      prisma.uploadAttempt.findUniqueOrThrow({ where: { id: mismatchedAttemptId } }),
      prisma.asset.findUniqueOrThrow({ where: { id: foreignAssetId } }),
    ]);
    assert.equal(adoptedAttempt.cleanupCompletedAt?.getTime(), now.getTime());
    assert.equal(adoptedAttempt.cleanupAfter, null);
    assert.equal(adoptedAttempt.cleanupFailureCode, "object_adopted");
    assert.equal(adoptedAttempt.cleanupAttemptCount, 1);
    assert.equal(mismatchedAttempt.cleanupCompletedAt, null);
    assert.equal(mismatchedAttempt.cleanupFailureCode, "quarantine_identity_mismatch");
    assert.equal(mismatchedAttempt.cleanupAttemptCount, 1);
    assert.ok(mismatchedAttempt.cleanupAfter && mismatchedAttempt.cleanupAfter > now);
    assert.equal(foreignAsset.objectKey, foreign.storageKey);
    assert.equal(foreignAsset.physicalLocator, foreign.storageKey);
    assert.equal((await allFiles(root)).length, 2);

    const adoptedBytes = await withOpenLocalQuarantineObject(
      { quarantineRoot: root },
      adopted.storageKey,
      { organizationId, assetId },
      async (object) => new Uint8Array(await object.handle.readFile()),
    );
    const foreignBytes = await withOpenLocalQuarantineObject(
      { quarantineRoot: root },
      foreign.storageKey,
      { organizationId: foreignOrganizationId, assetId: foreignAssetId },
      async (object) => new Uint8Array(await object.handle.readFile()),
    );
    assert.deepEqual(adoptedBytes, PDF_BYTES);
    assert.deepEqual(foreignBytes, PDF_BYTES);

    const replay = await reconcileUploadIntake({
      now,
      configuration: { quarantineRoot: root },
    });
    assert.equal(replay.cleanupClaimed, 0);
    assert.equal((await allFiles(root)).length, 2);
    },
  );
});
