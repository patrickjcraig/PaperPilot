import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { WorkspaceCommandResult } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { fileWorkspaceImport } from "@/server/workspaces/import-service";
import {
  createWorkspaceUploadSession,
  getWorkspaceUploadStatus,
  storeWorkspaceUploadContent,
} from "./service";

after(async () => {
  await prisma.$disconnect();
});

function assertSuccess<T>(
  result: WorkspaceCommandResult<T>,
): asserts result is Extract<WorkspaceCommandResult<T>, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

function pdfRequest(bytes: Uint8Array): Request {
  const body = new Uint8Array(bytes).buffer;
  return new Request("https://paperpilot.test/upload", {
    method: "PUT",
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
    },
    body,
  });
}

async function retainedFiles(root: string): Promise<string[]> {
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
      else if (
        !entry.name.startsWith(".paperpilot-local-quarantine-authority-v1")
        && !/^\.[a-f0-9]{64}\.custody-(?:deleted-v1|tombstone\.)/.test(entry.name)
      ) files.push(candidate);
    }
  }
  await visit(root);
  return files;
}

test("authenticated PDF intake remains tenant-bound and quarantine-only", async () => {
  const suffix = randomUUID();
  const root = await mkdtemp(path.join(os.tmpdir(), "paperpilot-upload-service-"));
  const previousRoot = process.env.PAPERPILOT_UPLOAD_QUARANTINE_ROOT;
  process.env.PAPERPILOT_UPLOAD_QUARANTINE_ROOT = root;
  const user = { id: `upload-user-${suffix}`, name: "Upload Owner" };
  const foreignUser = { id: `upload-foreign-user-${suffix}`, name: "Foreign Owner" };
  const workspaceId = `upload-workspace-${suffix}`;
  const foreignWorkspaceId = `upload-foreign-workspace-${suffix}`;
  const operationId = `upload-${suffix}`;
  const validBytes = new TextEncoder().encode("%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n");
  const invalidBytes = new TextEncoder().encode("<html>not a pdf</html>");
  const initialPaperCount = await prisma.paper.count();

  try {
    await prisma.user.createMany({
      data: [
        {
          id: user.id,
          name: user.name,
          email: `upload-${suffix}@example.test`,
          emailVerified: true,
        },
        {
          id: foreignUser.id,
          name: foreignUser.name,
          email: `upload-foreign-${suffix}@example.test`,
          emailVerified: true,
        },
      ],
    });
    await prisma.organization.createMany({
      data: [
        { id: workspaceId, name: "Upload integration", slug: `upload-${suffix}` },
        {
          id: foreignWorkspaceId,
          name: "Foreign upload integration",
          slug: `upload-foreign-${suffix}`,
        },
      ],
    });
    await prisma.member.createMany({
      data: [
        { organizationId: workspaceId, userId: user.id, role: "owner" },
        { organizationId: foreignWorkspaceId, userId: foreignUser.id, role: "owner" },
      ],
    });

    const created = await createWorkspaceUploadSession(user, workspaceId, {
      clientOperationId: operationId,
      expectedVersion: 0,
      fileName: "Evidence paper.pdf",
      sizeBytes: validBytes.byteLength,
      declaredMimeType: "application/pdf",
    });
    assertSuccess(created);
    assert.equal(created.outcome, "applied");
    assert.equal(created.aggregateVersion, 1);
    assert.equal(created.data.inboxEntry.entryKind, "document-upload");
    assert.equal(created.data.inboxEntry.upload.stage, "awaiting-bytes");
    const uploadId = created.data.upload.id;

    const replayed = await createWorkspaceUploadSession(user, workspaceId, {
      clientOperationId: operationId,
      expectedVersion: 0,
      fileName: "Evidence paper.pdf",
      sizeBytes: validBytes.byteLength,
      declaredMimeType: "application/pdf",
    });
    assertSuccess(replayed);
    assert.equal(replayed.outcome, "replayed");
    assert.equal(replayed.data.upload.id, uploadId);
    assert.equal(await prisma.uploadSession.count({ where: { organizationId: workspaceId } }), 1);

    const conflicted = await createWorkspaceUploadSession(user, workspaceId, {
      clientOperationId: operationId,
      expectedVersion: 1,
      fileName: "Different intent.pdf",
      sizeBytes: validBytes.byteLength,
      declaredMimeType: "application/pdf",
    });
    assert.equal(conflicted.ok, false);
    if (!conflicted.ok) assert.equal(conflicted.code, "idempotency_conflict");

    const reserved = await prisma.uploadSession.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: workspaceId, id: uploadId } },
      include: { asset: true, document: true, inboxEntry: true, intake: true },
    });
    assert.equal(reserved.status, "ISSUED");
    assert.equal(reserved.intakeId, uploadId);
    assert.equal(reserved.intake.source, "BROWSER_UPLOAD");
    assert.equal(reserved.intake.status, "RESERVED");
    assert.equal(reserved.intake.reservedBytes, BigInt(validBytes.byteLength));
    assert.equal(reserved.intake.committedBytes, null);
    assert.equal(reserved.intake.quotaReleasedAt, null);
    assert.equal(reserved.asset.status, "UPLOADING");
    assert.equal(reserved.asset.sizeBytes, null);
    assert.equal(reserved.asset.sha256, null);
    assert.equal(reserved.asset.scannedAt, null);
    assert.equal(reserved.document?.status, "PENDING");
    assert.equal(reserved.inboxEntry?.source, "FILE_UPLOAD");
    assert.equal(reserved.inboxEntry?.status, "NEEDS_REVIEW");
    assert.equal(await prisma.paper.count(), initialPaperCount);
    assert.equal(await prisma.documentTextChunk.count({ where: { organizationId: workspaceId } }), 0);
    assert.equal(await prisma.job.count({ where: { organizationId: workspaceId } }), 0);

    const quarantined = await storeWorkspaceUploadContent(
      user,
      workspaceId,
      uploadId,
      pdfRequest(validBytes),
    );
    assert.equal(quarantined.upload.status, "quarantined");
    assert.equal(quarantined.inboxEntry.entryKind, "document-upload");
    assert.equal(quarantined.inboxEntry.upload.stage, "quarantined");
    assert.equal(quarantined.asset.status, "quarantined");
    assert.equal(quarantined.document.status, "pending");

    const stored = await prisma.uploadSession.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: workspaceId, id: uploadId } },
      include: { asset: true, document: true, inboxEntry: true, intake: true },
    });
    assert.equal(stored.status, "STORED");
    assert.equal(stored.receivedSizeBytes, BigInt(validBytes.byteLength));
    assert.match(stored.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(stored.asset.status, "QUARANTINED");
    assert.equal(stored.asset.scannedAt, null);
    assert.equal(stored.asset.rejectionCode, null);
    assert.equal(stored.document?.status, "PENDING");
    assert.equal(stored.inboxEntry?.status, "NEEDS_REVIEW");
    assert.equal(stored.intake.status, "QUARANTINED");
    assert.equal(stored.intake.committedBytes, BigInt(validBytes.byteLength));
    assert.equal(stored.intake.completedAt, null);
    assert.equal(stored.intake.quotaReleasedAt, null);
    assert.equal(await prisma.asset.count({ where: { organizationId: workspaceId, status: "READY" } }), 0);
    assert.equal(await prisma.document.count({ where: { organizationId: workspaceId, status: "READY" } }), 0);
    assert.equal(await prisma.documentTextChunk.count({ where: { organizationId: workspaceId } }), 0);
    const validationJobs = await prisma.job.findMany({
      where: { organizationId: workspaceId, type: "DOCUMENT_VALIDATE" },
    });
    assert.equal(validationJobs.length, 1);
    assert.equal(validationJobs[0].status, "QUEUED");
    assert.equal(validationJobs[0].documentId, stored.documentId);
    assert.equal(validationJobs[0].assetId, stored.assetId);
    assert.equal(validationJobs[0].intakeId, uploadId);
    assert.equal(validationJobs[0].attempts, 0);
    assert.equal((await retainedFiles(root)).length, 1);

    const status = await getWorkspaceUploadStatus(user.id, workspaceId, uploadId);
    assert.equal(status.inboxEntry.entryKind, "document-upload");
    assert.equal(status.inboxEntry.upload.fileName, "Evidence paper.pdf");
    assert.equal(status.upload.status, "quarantined");

    const project = await prisma.project.create({
      data: {
        organizationId: workspaceId,
        name: "Upload filing guard",
        slug: `upload-filing-${suffix}`,
        description: "Quarantined documents must never be filed as papers.",
        researchQuestion: "Does the server enforce document readiness?",
        visibility: "PRIVATE",
        createdById: user.id,
      },
    });
    const filing = await fileWorkspaceImport(user, workspaceId, stored.inboxEntryId ?? "", {
      clientOperationId: `file-${suffix}`,
      expectedVersion: 1,
      inboxEntryId: stored.inboxEntryId,
      projectId: project.id,
    });
    assert.equal(filing.ok, false);
    if (!filing.ok) {
      assert.equal(filing.code, "validation");
      assert.equal(filing.message, "This inbox entry is not eligible to be filed.");
    }
    assert.equal(await prisma.paper.count(), initialPaperCount);
    assert.equal(await prisma.workspacePaper.count({ where: { organizationId: workspaceId } }), 0);

    const rejectedCreation = await createWorkspaceUploadSession(user, workspaceId, {
      clientOperationId: `invalid-${suffix}`,
      expectedVersion: 1,
      fileName: "Renamed web page.pdf",
      sizeBytes: invalidBytes.byteLength,
      declaredMimeType: "application/pdf",
    });
    assertSuccess(rejectedCreation);
    const rejectedUploadId = rejectedCreation.data.upload.id;
    await assert.rejects(
      storeWorkspaceUploadContent(
        user,
        workspaceId,
        rejectedUploadId,
        pdfRequest(invalidBytes),
      ),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 422
        && error.code === "invalid_pdf_envelope",
    );
    const rejected = await prisma.uploadSession.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: workspaceId, id: rejectedUploadId } },
      include: { asset: true, document: true, inboxEntry: true, intake: true },
    });
    assert.equal(rejected.status, "REJECTED");
    assert.equal(rejected.failureCode, "invalid_pdf_envelope");
    assert.equal(rejected.asset.status, "REJECTED");
    assert.equal(rejected.asset.rejectionCode, "invalid_pdf_envelope");
    assert.equal(rejected.document?.status, "FAILED");
    assert.equal(rejected.inboxEntry?.status, "FAILED");
    assert.equal(rejected.intake.status, "FAILED");
    assert.equal(rejected.intake.failureCode, "invalid_pdf_envelope");
    assert.ok(rejected.intake.completedAt);
    assert.equal(rejected.intake.quotaReleasedAt, null);
    assert.equal((await retainedFiles(root)).length, 1, "invalid bytes must leave no object");

    await assert.rejects(
      getWorkspaceUploadStatus(foreignUser.id, workspaceId, uploadId),
      (error: unknown) => error instanceof HttpProblem && error.status === 404,
    );
    await assert.rejects(
      getWorkspaceUploadStatus(foreignUser.id, foreignWorkspaceId, uploadId),
      (error: unknown) => error instanceof HttpProblem && error.status === 404,
    );
    await assert.rejects(
      storeWorkspaceUploadContent(
        foreignUser,
        workspaceId,
        uploadId,
        pdfRequest(validBytes),
      ),
      (error: unknown) => error instanceof HttpProblem && error.status === 404,
    );
  } finally {
    if (previousRoot === undefined) delete process.env.PAPERPILOT_UPLOAD_QUARANTINE_ROOT;
    else process.env.PAPERPILOT_UPLOAD_QUARANTINE_ROOT = previousRoot;
    const receiptBearingWorkspace = await prisma.documentIngestReceipt.count({
      where: { organizationId: workspaceId },
    });
    assert.ok(receiptBearingWorkspace > 0);
    const fixtureWorkspaceIds = [workspaceId, foreignWorkspaceId];
    await prisma.$transaction(async (transaction) => {
      await transaction.auditEvent.deleteMany({
        where: { organizationId: { in: fixtureWorkspaceIds } },
      });
      await transaction.provenanceRecord.deleteMany({
        where: { organizationId: { in: fixtureWorkspaceIds } },
      });
      // Tenant teardown is the supported erasure path for otherwise immutable
      // custody receipts. Remove both exact fixture tenants before deleting the
      // quarantine root so no global worker can inherit objectless work.
      await transaction.organization.deleteMany({
        where: { id: { in: fixtureWorkspaceIds } },
      });
    });
    await prisma.user.deleteMany({
      where: { id: { in: [user.id, foreignUser.id] } },
    });
    assert.equal(path.isAbsolute(root), true);
    assert.equal(path.relative(os.tmpdir(), root).startsWith(".."), false);
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace quota uses the shared intake ledger and crash-cleanup holds", async () => {
  const suffix = randomUUID();
  const user = { id: `quota-user-${suffix}`, name: "Quota Owner" };
  const workspaceId = `quota-workspace-${suffix}`;
  const providerAssetId = `quota-provider-asset-${suffix}`;
  const providerDocumentId = `quota-provider-document-${suffix}`;
  const providerIntakeId = `quota-provider-intake-${suffix}`;
  const previousMaximum = process.env.PAPERPILOT_UPLOAD_MAX_BYTES;
  const previousRetained = process.env.PAPERPILOT_UPLOAD_MAX_RETAINED_BYTES_PER_WORKSPACE;
  process.env.PAPERPILOT_UPLOAD_MAX_BYTES = "100";
  process.env.PAPERPILOT_UPLOAD_MAX_RETAINED_BYTES_PER_WORKSPACE = "100";

  try {
    await prisma.user.create({
      data: {
        id: user.id,
        name: user.name,
        email: `quota-${suffix}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: {
        id: workspaceId,
        name: "Shared intake quota",
        slug: `shared-intake-quota-${suffix}`,
      },
    });
    await prisma.member.create({
      data: { organizationId: workspaceId, userId: user.id, role: "owner" },
    });
    await prisma.asset.create({
      data: {
        id: providerAssetId,
        organizationId: workspaceId,
        storageProvider: "LOCAL",
        objectKey: `provider:${providerAssetId}`,
        status: "QUARANTINED",
        sizeBytes: 20n,
      },
    });
    await prisma.document.create({
      data: {
        id: providerDocumentId,
        organizationId: workspaceId,
        kind: "PAPER_PDF",
        status: "PENDING",
      },
    });
    await prisma.documentIntake.create({
      data: {
        id: providerIntakeId,
        organizationId: workspaceId,
        source: "CRAWLER",
        status: "QUARANTINED",
        documentId: providerDocumentId,
        assetId: providerAssetId,
        reservedBytes: 90n,
        committedBytes: 20n,
      },
    });

    const first = await createWorkspaceUploadSession(user, workspaceId, {
      clientOperationId: `quota-first-${suffix}`,
      expectedVersion: 0,
      fileName: "first.pdf",
      sizeBytes: 40,
      declaredMimeType: "application/pdf",
    });
    assertSuccess(first);
    assert.equal(first.aggregateVersion, 1);
    const firstSession = await prisma.uploadSession.findUniqueOrThrow({
      where: { id: first.data.upload.id },
    });
    const orphanAttemptId = `quota-orphan-attempt-${suffix}`;
    await prisma.uploadAttempt.create({
      data: {
        id: orphanAttemptId,
        organizationId: workspaceId,
        uploadSessionId: firstSession.id,
        assetId: firstSession.assetId,
        attemptNumber: 1,
        storageKey: `quota-orphan:${suffix}`,
        status: "ABANDONED",
        expectedSizeBytes: 50n,
        leaseExpiresAt: new Date("2026-08-29T00:00:00.000Z"),
        completedAt: new Date("2026-08-29T00:00:00.000Z"),
        failureCode: "receive_lease_expired",
        cleanupAfter: new Date("2026-08-29T00:00:00.000Z"),
      },
    });

    const secondCommand = {
      clientOperationId: `quota-second-${suffix}`,
      expectedVersion: 1,
      fileName: "second.pdf",
      sizeBytes: 20,
      declaredMimeType: "application/pdf",
    } as const;
    await assert.rejects(
      createWorkspaceUploadSession(user, workspaceId, secondCommand),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 413
        && error.code === "storage_quota_exceeded",
    );
    assert.equal(await prisma.uploadSession.count({
      where: { organizationId: workspaceId },
    }), 1);

    await prisma.uploadAttempt.update({
      where: { id: orphanAttemptId },
      data: {
        cleanupCompletedAt: new Date("2026-08-29T00:01:00.000Z"),
        cleanupAfter: null,
      },
    });
    const afterCleanup = await createWorkspaceUploadSession(
      user,
      workspaceId,
      secondCommand,
    );
    assertSuccess(afterCleanup);
    assert.equal(afterCleanup.aggregateVersion, 2);
    assert.equal(await prisma.documentIntake.count({
      where: { organizationId: workspaceId, quotaReleasedAt: null },
    }), 3);
  } finally {
    if (previousMaximum === undefined) delete process.env.PAPERPILOT_UPLOAD_MAX_BYTES;
    else process.env.PAPERPILOT_UPLOAD_MAX_BYTES = previousMaximum;
    if (previousRetained === undefined) {
      delete process.env.PAPERPILOT_UPLOAD_MAX_RETAINED_BYTES_PER_WORKSPACE;
    } else {
      process.env.PAPERPILOT_UPLOAD_MAX_RETAINED_BYTES_PER_WORKSPACE = previousRetained;
    }
    await prisma.$transaction(async (transaction) => {
      await transaction.auditEvent.deleteMany({ where: { organizationId: workspaceId } });
      await transaction.provenanceRecord.deleteMany({ where: { organizationId: workspaceId } });
      await transaction.organization.deleteMany({ where: { id: workspaceId } });
    })
      .catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: user.id } })
      .catch(() => undefined);
  }
});
