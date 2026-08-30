import assert from "node:assert/strict";
import test from "node:test";
import { uploadStatusDto } from "./dto";
import type { UploadSessionForStatus } from "./dto";

type StatusFixture = {
  sessionStatus?: "ISSUED" | "RECEIVING" | "STORED" | "REJECTED" | "EXPIRED";
  sessionFailureCode?: string | null;
  assetStatus?: "UPLOADING" | "QUARANTINED" | "SCANNING" | "READY" | "REJECTED" | "DELETED";
  assetRejectionCode?: string | null;
  documentStatus?: "PENDING" | "PROCESSING" | "READY" | "FAILED" | "ARCHIVED";
  documentFailureCode?: string | null;
};

function statusFixture(overrides: StatusFixture = {}): UploadSessionForStatus {
  const createdAt = new Date("2026-08-28T12:00:00.000Z");
  const status = overrides.sessionStatus ?? "STORED";
  const failureCode = overrides.sessionFailureCode ?? null;
  const assetStatus = overrides.assetStatus ?? "QUARANTINED";
  const assetRejectionCode = overrides.assetRejectionCode ?? null;
  const documentStatus = overrides.documentStatus ?? "PENDING";
  const documentFailureCode = overrides.documentFailureCode ?? null;
  const lifecycle = {
    status,
    failureCode,
    asset: { status: assetStatus, rejectionCode: assetRejectionCode },
    document: { status: documentStatus, failureCode: documentFailureCode },
  };

  return {
    id: "upload-one",
    status,
    failureCode,
    expiresAt: new Date("2026-08-28T12:15:00.000Z"),
    sha256: "secret-upload-sha256",
    claimId: "secret-worker-claim",
    asset: {
      id: "asset-one",
      status: assetStatus,
      sizeBytes: 17n,
      rejectionCode: assetRejectionCode,
      objectKey: "private/organization-one/secret-object-key",
      sha256: "secret-asset-sha256",
      rejectedReason: "raw scanner output",
    },
    document: {
      id: "document-one",
      status: documentStatus,
      failureCode: documentFailureCode,
      contentHash: "secret-document-hash",
    },
    inboxEntry: {
      id: "inbox-one",
      organizationId: "organization-one",
      importBatchId: null,
      projectId: null,
      workspacePaperId: null,
      documentId: "document-one",
      source: "FILE_UPLOAD",
      sourceKey: "upload-one",
      dedupeKey: "upload-one",
      status: "PENDING",
      proposedTitle: null,
      proposedYear: null,
      sourceUri: null,
      payload: null,
      failureCode: null,
      failureMessage: "raw scanner output",
      createdById: "user-one",
      resolvedAt: null,
      createdAt,
      updatedAt: createdAt,
      provenanceRecords: [],
      uploadSession: {
        ...lifecycle,
        id: "upload-one",
        originalFileName: "paper.pdf",
        declaredMimeType: "application/pdf",
        expectedSizeBytes: 17n,
        receivedSizeBytes: 17n,
        expiresAt: new Date("2026-08-28T12:15:00.000Z"),
        documentId: "document-one",
      },
    },
  } as unknown as UploadSessionForStatus;
}

test("upload status DTO serializes validation, ready, deleted, and archived states honestly", () => {
  const cases: Array<{
    name: string;
    fixture: StatusFixture;
    stage: "quarantined" | "validating" | "ready" | "failed";
    inboxStatus: "processing" | "ready" | "blocked";
    assetStatus: "quarantined" | "scanning" | "ready" | "deleted";
    documentStatus: "pending" | "processing" | "ready" | "archived";
  }> = [
    {
      name: "stored quarantine",
      fixture: {},
      stage: "quarantined",
      inboxStatus: "processing",
      assetStatus: "quarantined",
      documentStatus: "pending",
    },
    {
      name: "active validation",
      fixture: { assetStatus: "SCANNING", documentStatus: "PROCESSING" },
      stage: "validating",
      inboxStatus: "processing",
      assetStatus: "scanning",
      documentStatus: "processing",
    },
    {
      name: "verified document",
      fixture: { assetStatus: "READY", documentStatus: "READY" },
      stage: "ready",
      inboxStatus: "ready",
      assetStatus: "ready",
      documentStatus: "ready",
    },
    {
      name: "deleted asset",
      fixture: { assetStatus: "DELETED", documentStatus: "READY" },
      stage: "failed",
      inboxStatus: "blocked",
      assetStatus: "deleted",
      documentStatus: "ready",
    },
    {
      name: "archived document",
      fixture: { assetStatus: "READY", documentStatus: "ARCHIVED" },
      stage: "failed",
      inboxStatus: "blocked",
      assetStatus: "ready",
      documentStatus: "archived",
    },
  ];

  for (const value of cases) {
    const dto = uploadStatusDto(statusFixture(value.fixture));
    assert.equal(dto.upload.status, value.stage, value.name);
    assert.equal(dto.inboxEntry.upload.stage, value.stage, value.name);
    assert.equal(dto.inboxEntry.status, value.inboxStatus, value.name);
    assert.equal(dto.asset.status, value.assetStatus, value.name);
    assert.equal(dto.document.status, value.documentStatus, value.name);
  }
});

test("upload status DTO never exposes storage, digest, worker, or scanner details", () => {
  const dto = uploadStatusDto(statusFixture({
    assetStatus: "REJECTED",
    assetRejectionCode: "malware_detected",
    documentStatus: "FAILED",
  }));
  const serialized = JSON.stringify(dto);

  assert.deepEqual(dto.inboxEntry.failure, {
    code: "malware_detected",
    message: "This file did not pass malware screening and remains unavailable.",
    retryable: false,
  });
  assert.equal(serialized.includes("secret-upload-sha256"), false);
  assert.equal(serialized.includes("secret-worker-claim"), false);
  assert.equal(serialized.includes("secret-object-key"), false);
  assert.equal(serialized.includes("secret-asset-sha256"), false);
  assert.equal(serialized.includes("secret-document-hash"), false);
  assert.equal(serialized.includes("raw scanner output"), false);
});
