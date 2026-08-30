import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import {
  getZoteroAttachmentPolicy,
  listZoteroAttachments,
  parseZoteroAttachmentListQuery,
  queueZoteroAttachmentImport,
  updateZoteroAttachmentPolicy,
  type QueueZoteroAttachmentImportCommand,
} from "../attachment-service";
import { parseZoteroAttachmentDownloadJobPayload } from "../attachment-import-contract";

const METADATA_HASH = "a".repeat(64);
const PROVIDER_MD5 = "0123456789abcdef0123456789abcdef";
const SOURCE_VERSION = "7";

interface Fixture {
  suffix: string;
  workspaceId: string;
  connectionId: string;
  libraryId: string;
  attachmentId: string;
  ownerId: string;
  memberId: string;
  viewerId: string;
  outsiderId: string;
}

async function fixture(options: {
  policy?: "MANUAL" | "DISABLED" | null;
  fileAccessStatus?: "AVAILABLE" | "UNKNOWN" | "UNAVAILABLE";
} = {}): Promise<Fixture> {
  const suffix = randomUUID();
  const workspaceId = `zotero-attachment-workspace-${suffix}`;
  const connectionId = `zotero-attachment-connection-${suffix}`;
  const libraryId = `zotero-attachment-library-${suffix}`;
  const attachmentId = `zotero-attachment-object-${suffix}`;
  const ownerId = `zotero-attachment-owner-${suffix}`;
  const memberId = `zotero-attachment-member-${suffix}`;
  const viewerId = `zotero-attachment-viewer-${suffix}`;
  const outsiderId = `zotero-attachment-outsider-${suffix}`;

  await prisma.user.createMany({
    data: [
      { id: ownerId, name: "Attachment owner", email: `${ownerId}@example.test` },
      { id: memberId, name: "Attachment member", email: `${memberId}@example.test` },
      { id: viewerId, name: "Attachment viewer", email: `${viewerId}@example.test` },
      { id: outsiderId, name: "Attachment outsider", email: `${outsiderId}@example.test` },
    ],
  });
  await prisma.organization.create({
    data: { id: workspaceId, name: "Zotero attachment workspace", slug: workspaceId },
  });
  await prisma.member.createMany({
    data: [
      { organizationId: workspaceId, userId: ownerId, role: "owner" },
      { organizationId: workspaceId, userId: memberId, role: "member" },
      { organizationId: workspaceId, userId: viewerId, role: "viewer" },
    ],
  });
  await prisma.integrationConnection.create({
    data: {
      id: connectionId,
      organizationId: workspaceId,
      provider: "ZOTERO",
      authType: "OAUTH1",
      status: "CONNECTED",
      externalAccountId: `provider-${suffix}`,
      credentialCiphertext: new Uint8Array([1, 2, 3, 4]),
      credentialFingerprint: `credential-${suffix}`,
      credentialKeyVersion: "v1",
      credentialGeneration: 1,
      createdById: ownerId,
    },
  });
  await prisma.zoteroLibrary.create({
    data: {
      id: libraryId,
      organizationId: workspaceId,
      integrationConnectionId: connectionId,
      libraryType: "USER",
      zoteroLibraryId: "314159",
      name: "Stored files",
      isReadable: true,
      syncEnabled: true,
      fileAccessStatus: options.fileAccessStatus ?? "AVAILABLE",
    },
  });
  await prisma.zoteroObject.create({
    data: {
      id: attachmentId,
      organizationId: workspaceId,
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
      organizationId: workspaceId,
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
  const policy = options.policy === undefined ? "MANUAL" : options.policy;
  if (policy !== null) {
    await prisma.zoteroAttachmentPolicy.create({
      data: {
        id: `zotero-attachment-policy-${suffix}`,
        organizationId: workspaceId,
        integrationConnectionId: connectionId,
        mode: policy,
        revision: policy === "MANUAL" ? 1 : 0,
        configuredById: ownerId,
        configuredAt: new Date("2026-08-29T12:00:00.000Z"),
      },
    });
  }
  return {
    suffix,
    workspaceId,
    connectionId,
    libraryId,
    attachmentId,
    ownerId,
    memberId,
    viewerId,
    outsiderId,
  };
}

async function cleanup(value: Fixture): Promise<void> {
  const organizationId = value.workspaceId;
  await prisma.$transaction(async (transaction) => {
    await transaction.auditEvent.deleteMany({ where: { organizationId } });
    await transaction.idempotencyRecord.deleteMany({ where: { organizationId } });
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
  await prisma.user.deleteMany({
    where: {
      id: { in: [value.ownerId, value.memberId, value.viewerId, value.outsiderId] },
    },
  });
}

function command(
  operationId: string,
  overrides: Partial<QueueZoteroAttachmentImportCommand> = {},
): QueueZoteroAttachmentImportCommand {
  return {
    clientOperationId: operationId,
    expectedPolicyRevision: 1,
    sourceVersion: SOURCE_VERSION,
    metadataHash: METADATA_HASH,
    providerMd5: PROVIDER_MD5,
    ...overrides,
  };
}

function problem(code: string) {
  return (error: unknown) => error instanceof HttpProblem && error.code === code;
}

async function advanceImportToReadyOrAttention(
  importId: string,
  terminalStatus: "READY" | "ATTENTION",
): Promise<void> {
  await prisma.zoteroAttachmentImport.update({
    where: { id: importId },
    data: { status: "DOWNLOADING", startedAt: new Date("2026-08-29T14:00:00.000Z") },
  });
  await prisma.zoteroAttachmentImport.update({
    where: { id: importId },
    data: { status: "QUARANTINED", quarantinedAt: new Date("2026-08-29T14:01:00.000Z") },
  });
  await prisma.zoteroAttachmentImport.update({
    where: { id: importId },
    data: { status: "VALIDATING" },
  });
  if (terminalStatus === "READY") {
    await prisma.zoteroAttachmentImport.update({
      where: { id: importId },
      data: { status: "EXTRACTING" },
    });
  }
  await prisma.zoteroAttachmentImport.update({
    where: { id: importId },
    data: {
      status: terminalStatus,
      completedAt: new Date("2026-08-29T14:02:00.000Z"),
      ...(terminalStatus === "ATTENTION" ? { failureCode: "manual_review_required" } : {}),
    },
  });
}

after(async () => {
  await prisma.$disconnect();
});

test("attachment policy is tenant-bound, admin-controlled, and revision-stable on replay", async () => {
  const data = await fixture({ policy: null });
  try {
    await assert.rejects(
      getZoteroAttachmentPolicy({
        userId: data.outsiderId,
        workspaceId: data.workspaceId,
        connectionId: data.connectionId,
      }),
      problem("workspace_not_found"),
    );
    assert.deepEqual(await getZoteroAttachmentPolicy({
      userId: data.viewerId,
      workspaceId: data.workspaceId,
      connectionId: data.connectionId,
    }), { mode: "DISABLED", revision: 0, configuredAt: null });
    await assert.rejects(
      updateZoteroAttachmentPolicy({
        userId: data.memberId,
        workspaceId: data.workspaceId,
        connectionId: data.connectionId,
        command: { mode: "MANUAL", expectedRevision: 0 },
      }),
      problem("workspace_forbidden"),
    );
    const applied = await updateZoteroAttachmentPolicy({
      userId: data.ownerId,
      workspaceId: data.workspaceId,
      connectionId: data.connectionId,
      command: { mode: "MANUAL", expectedRevision: 0 },
    }, { now: () => new Date("2026-08-29T13:00:00.000Z") });
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.revision, 1);
    const replay = await updateZoteroAttachmentPolicy({
      userId: data.ownerId,
      workspaceId: data.workspaceId,
      connectionId: data.connectionId,
      command: { mode: "MANUAL", expectedRevision: 0 },
    });
    assert.equal(replay.outcome, "unchanged");
    assert.equal(replay.revision, 1);
    assert.equal(
      await prisma.auditEvent.count({
        where: { organizationId: data.workspaceId, action: "zotero.attachment_policy.updated" },
      }),
      1,
    );
  } finally {
    await cleanup(data);
  }
});

test("attachment list exposes only tenant-scoped sanitized projections and statuses", async () => {
  const data = await fixture();
  try {
    await assert.rejects(
      listZoteroAttachments({
        userId: data.outsiderId,
        workspaceId: data.workspaceId,
        connectionId: data.connectionId,
        query: parseZoteroAttachmentListQuery(new URLSearchParams()),
      }),
      problem("workspace_not_found"),
    );
    const result = await listZoteroAttachments({
      userId: data.viewerId,
      workspaceId: data.workspaceId,
      connectionId: data.connectionId,
      query: parseZoteroAttachmentListQuery(new URLSearchParams("limit=1")),
    });
    assert.equal(result.attachments.length, 1);
    assert.deepEqual(result.attachments[0], {
      id: data.attachmentId,
      libraryId: data.libraryId,
      parentKey: "PARENT01",
      linkMode: "imported_file",
      contentType: "application/pdf",
      fileName: "safe-paper.pdf",
      providerMd5: PROVIDER_MD5,
      providerMtime: "1730000000000",
      sourceVersion: SOURCE_VERSION,
      metadataHash: METADATA_HASH,
      eligibility: "DOWNLOADABLE",
      reasonCode: null,
      isDeleted: false,
      updatedAt: result.attachments[0]?.updatedAt,
      latestImport: null,
    });
    assert.equal(Object.hasOwn(result.attachments[0] ?? {}, "path"), false);
    assert.equal(Object.hasOwn(result.attachments[0] ?? {}, "signedUrl"), false);
  } finally {
    await cleanup(data);
  }
});

test("manual import rejects read-only roles, disabled policy, and unavailable file access", async () => {
  const roleFixture = await fixture();
  try {
    await assert.rejects(
      queueZoteroAttachmentImport({
        userId: roleFixture.viewerId,
        workspaceId: roleFixture.workspaceId,
        connectionId: roleFixture.connectionId,
        attachmentId: roleFixture.attachmentId,
        command: command(`viewer-${roleFixture.suffix}`),
      }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } }),
      problem("workspace_forbidden"),
    );
  } finally {
    await cleanup(roleFixture);
  }

  const disabledFixture = await fixture({ policy: "DISABLED" });
  try {
    await assert.rejects(
      queueZoteroAttachmentImport({
        userId: disabledFixture.memberId,
        workspaceId: disabledFixture.workspaceId,
        connectionId: disabledFixture.connectionId,
        attachmentId: disabledFixture.attachmentId,
        command: command(`disabled-${disabledFixture.suffix}`, { expectedPolicyRevision: 0 }),
      }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } }),
      problem("attachment_import_disabled"),
    );
  } finally {
    await cleanup(disabledFixture);
  }

  const unavailableFixture = await fixture({ fileAccessStatus: "UNAVAILABLE" });
  try {
    await assert.rejects(
      queueZoteroAttachmentImport({
        userId: unavailableFixture.memberId,
        workspaceId: unavailableFixture.workspaceId,
        connectionId: unavailableFixture.connectionId,
        attachmentId: unavailableFixture.attachmentId,
        command: command(`unavailable-${unavailableFixture.suffix}`),
      }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } }),
      problem("zotero_file_access_unavailable"),
    );
  } finally {
    await cleanup(unavailableFixture);
  }
});

test("manual import reserves conservative source-neutral quota and rolls back on exhaustion", async () => {
  const data = await fixture();
  try {
    const existingDocumentId = `quota-document-${data.suffix}`;
    const existingAssetId = `quota-asset-${data.suffix}`;
    await prisma.document.create({
      data: {
        id: existingDocumentId,
        organizationId: data.workspaceId,
        kind: "PAPER_PDF",
        status: "PENDING",
      },
    });
    await prisma.asset.create({
      data: {
        id: existingAssetId,
        organizationId: data.workspaceId,
        storageProvider: "LOCAL",
        objectKey: `quota:${data.suffix}`,
        status: "UPLOADING",
      },
    });
    await prisma.documentIntake.create({
      data: {
        id: `quota-intake-${data.suffix}`,
        organizationId: data.workspaceId,
        source: "WEB_MCP",
        status: "RESERVED",
        documentId: existingDocumentId,
        assetId: existingAssetId,
        reservedBytes: 30n,
      },
    });
    await assert.rejects(
      queueZoteroAttachmentImport({
        userId: data.memberId,
        workspaceId: data.workspaceId,
        connectionId: data.connectionId,
        attachmentId: data.attachmentId,
        command: command(`quota-${data.suffix}`),
      }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 120 } }),
      problem("storage_quota_exceeded"),
    );
    assert.equal(
      await prisma.zoteroAttachmentImport.count({ where: { organizationId: data.workspaceId } }),
      0,
    );
    assert.equal(
      await prisma.documentIntake.count({
        where: { organizationId: data.workspaceId, source: "ZOTERO_ATTACHMENT" },
      }),
      0,
    );
  } finally {
    await cleanup(data);
  }
});

test("manual import is atomically admitted, replay-safe, mismatch-safe, and source-coalescing", async () => {
  const data = await fixture({ fileAccessStatus: "UNKNOWN" });
  const firstCommand = command(`import-${data.suffix}`);
  try {
    const queued = await queueZoteroAttachmentImport({
      userId: data.memberId,
      workspaceId: data.workspaceId,
      connectionId: data.connectionId,
      attachmentId: data.attachmentId,
      command: firstCommand,
    }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } });
    assert.equal(queued.outcome, "applied");
    assert.equal(queued.import.status, "QUEUED");
    assert.ok(queued.import.downloadJobId);

    const [storedImport, intake, document, asset, job, inbox, batch] = await Promise.all([
      prisma.zoteroAttachmentImport.findUniqueOrThrow({ where: { id: queued.import.id } }),
      prisma.documentIntake.findUniqueOrThrow({ where: { id: queued.import.intakeId } }),
      prisma.document.findUniqueOrThrow({ where: { id: queued.import.documentId } }),
      prisma.asset.findUniqueOrThrow({ where: { id: queued.import.assetId } }),
      prisma.job.findUniqueOrThrow({ where: { id: queued.import.downloadJobId! } }),
      prisma.inboxEntry.findUniqueOrThrow({ where: { id: queued.import.inboxEntryId! } }),
      prisma.importBatch.findUniqueOrThrow({
        where: { organizationId_externalRequestId: {
          organizationId: data.workspaceId,
          externalRequestId: queued.import.id,
        } },
      }),
    ]);
    assert.equal(storedImport.credentialGeneration, 1);
    assert.equal(intake.status, "QUEUED");
    assert.equal(intake.source, "ZOTERO_ATTACHMENT");
    assert.equal(intake.reservedBytes, 100n);
    assert.equal(document.status, "PENDING");
    assert.equal(asset.status, "UPLOADING");
    assert.equal(job.type, "DOCUMENT_DOWNLOAD");
    assert.equal(job.status, "QUEUED");
    assert.deepEqual(parseZoteroAttachmentDownloadJobPayload(job.payload), {
      schemaVersion: 1,
      attachmentImportId: queued.import.id,
    });
    assert.deepEqual(Object.keys(job.payload as object).sort(), ["attachmentImportId", "schemaVersion"]);
    assert.equal(inbox.status, "NEEDS_REVIEW");
    assert.equal(inbox.importBatchId, batch.id);
    assert.equal(intake.importBatchId, batch.id);
    assert.deepEqual(inbox.payload, {
      schemaVersion: 1,
      kind: "zotero-attachment-import",
      attachmentImportId: queued.import.id,
      importStatus: "QUEUED",
    });

    const replay = await queueZoteroAttachmentImport({
      userId: data.memberId,
      workspaceId: data.workspaceId,
      connectionId: data.connectionId,
      attachmentId: data.attachmentId,
      command: firstCommand,
    }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } });
    assert.equal(replay.outcome, "replayed");
    assert.equal(replay.import.id, queued.import.id);
    await assert.rejects(
      queueZoteroAttachmentImport({
        userId: data.memberId,
        workspaceId: data.workspaceId,
        connectionId: data.connectionId,
        attachmentId: data.attachmentId,
        command: { ...firstCommand, expectedPolicyRevision: 2 },
      }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } }),
      problem("idempotency_conflict"),
    );

    const coalescedCommand = command(`coalesce-${data.suffix}`);
    const coalesced = await queueZoteroAttachmentImport({
      userId: data.memberId,
      workspaceId: data.workspaceId,
      connectionId: data.connectionId,
      attachmentId: data.attachmentId,
      command: coalescedCommand,
    }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } });
    assert.equal(coalesced.outcome, "coalesced");
    assert.equal(coalesced.import.id, queued.import.id);
    const coalescedReplay = await queueZoteroAttachmentImport({
      userId: data.memberId,
      workspaceId: data.workspaceId,
      connectionId: data.connectionId,
      attachmentId: data.attachmentId,
      command: coalescedCommand,
    }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } });
    assert.equal(coalescedReplay.outcome, "replayed");
    assert.equal(coalescedReplay.import.id, queued.import.id);
    assert.equal(
      await prisma.zoteroAttachmentImport.count({ where: { organizationId: data.workspaceId } }),
      1,
    );
  } finally {
    await cleanup(data);
  }
});

test("a new explicit command retries failed and cancelled generations without rewriting history", async () => {
  const data = await fixture();
  const firstCommand = command(`retry-failed-${data.suffix}`);
  try {
    const first = await queueZoteroAttachmentImport({
      userId: data.memberId,
      workspaceId: data.workspaceId,
      connectionId: data.connectionId,
      attachmentId: data.attachmentId,
      command: firstCommand,
    }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } });
    await prisma.integrationConnection.update({
      where: { id: data.connectionId },
      data: {
        credentialCiphertext: new Uint8Array([9, 8, 7, 6]),
        credentialFingerprint: `retry-credential-${data.suffix}`,
        credentialKeyVersion: "v2",
        credentialGeneration: { increment: 1 },
      },
    });
    await prisma.zoteroAttachmentImport.update({
      where: { id: first.import.id },
      data: {
        status: "FAILED",
        failureCode: "credential_generation_changed",
        completedAt: new Date("2026-08-29T14:00:00.000Z"),
      },
    });

    const replay = await queueZoteroAttachmentImport({
      userId: data.memberId,
      workspaceId: data.workspaceId,
      connectionId: data.connectionId,
      attachmentId: data.attachmentId,
      command: firstCommand,
    }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } });
    assert.equal(replay.outcome, "replayed");
    assert.equal(replay.import.id, first.import.id);
    assert.equal(replay.import.status, "FAILED");

    const second = await queueZoteroAttachmentImport({
      userId: data.memberId,
      workspaceId: data.workspaceId,
      connectionId: data.connectionId,
      attachmentId: data.attachmentId,
      command: command(`retry-cancelled-${data.suffix}`),
    }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } });
    assert.equal(second.outcome, "applied");
    assert.notEqual(second.import.id, first.import.id);
    assert.notEqual(second.import.documentId, first.import.documentId);
    assert.notEqual(second.import.inboxEntryId, first.import.inboxEntryId);
    const storedSecond = await prisma.zoteroAttachmentImport.findUniqueOrThrow({
      where: { id: second.import.id },
    });
    assert.equal(storedSecond.credentialGeneration, 2);

    await prisma.zoteroAttachmentImport.update({
      where: { id: second.import.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date("2026-08-29T14:01:00.000Z"),
        completedAt: new Date("2026-08-29T14:01:00.000Z"),
      },
    });
    const third = await queueZoteroAttachmentImport({
      userId: data.memberId,
      workspaceId: data.workspaceId,
      connectionId: data.connectionId,
      attachmentId: data.attachmentId,
      command: command(`retry-applied-${data.suffix}`),
    }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } });
    assert.equal(third.outcome, "applied");
    assert.notEqual(third.import.id, second.import.id);

    const storedAttempts = await prisma.zoteroAttachmentImport.findMany({
      where: { organizationId: data.workspaceId },
      include: {
        intake: { select: { document: { select: { sourceFingerprint: true } } } },
      },
    });
    const attempts = [first.import.id, second.import.id, third.import.id].map((attemptId) => {
      const attempt = storedAttempts.find((candidate) => candidate.id === attemptId);
      assert.ok(attempt);
      return attempt;
    });
    assert.equal(storedAttempts.length, 3);
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["FAILED", "CANCELLED", "QUEUED"]);
    assert.deepEqual(
      attempts.map((attempt) => attempt.intake.document.sourceFingerprint),
      attempts.map((attempt) => `zotero-attachment-import:${attempt.id}`),
    );
    assert.equal(new Set(attempts.map((attempt) => attempt.intake.document.sourceFingerprint)).size, 3);

    const inboxEntries = await prisma.inboxEntry.findMany({
      where: { organizationId: data.workspaceId, source: "ZOTERO" },
      select: { documentId: true, dedupeKey: true },
    });
    assert.deepEqual(
      attempts.map((attempt) => (
        inboxEntries.find((entry) => entry.documentId === attempt.documentId)?.dedupeKey
      )),
      attempts.map((attempt) => `zotero-attachment-import:${attempt.id}`),
    );
    assert.ok(attempts.every((attempt) => (
      attempt.sourceVersion === SOURCE_VERSION && attempt.providerMd5 === PROVIDER_MD5
    )));
  } finally {
    await cleanup(data);
  }
});

for (const terminalStatus of ["READY", "ATTENTION"] as const) {
  test(`${terminalStatus} imports continue to coalesce the exact source generation`, async () => {
    const data = await fixture();
    try {
      const first = await queueZoteroAttachmentImport({
        userId: data.memberId,
        workspaceId: data.workspaceId,
        connectionId: data.connectionId,
        attachmentId: data.attachmentId,
        command: command(`singleton-${terminalStatus.toLowerCase()}-${data.suffix}`),
      }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } });
      await advanceImportToReadyOrAttention(first.import.id, terminalStatus);

      const coalesced = await queueZoteroAttachmentImport({
        userId: data.memberId,
        workspaceId: data.workspaceId,
        connectionId: data.connectionId,
        attachmentId: data.attachmentId,
        command: command(`coalesce-${terminalStatus.toLowerCase()}-${data.suffix}`),
      }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } });
      assert.equal(coalesced.outcome, "coalesced");
      assert.equal(coalesced.import.id, first.import.id);
      assert.equal(coalesced.import.status, terminalStatus);
      assert.equal(
        await prisma.zoteroAttachmentImport.count({ where: { organizationId: data.workspaceId } }),
        1,
      );
    } finally {
      await cleanup(data);
    }
  });
}

test("new commands bind the current credential generation and reject a changed source snapshot", async () => {
  const data = await fixture();
  try {
    await prisma.integrationConnection.update({
      where: { id: data.connectionId },
      data: {
        credentialCiphertext: new Uint8Array([5, 6, 7, 8]),
        credentialFingerprint: `rotated-${data.suffix}`,
        credentialKeyVersion: "v2",
        credentialGeneration: { increment: 1 },
      },
    });
    const queued = await queueZoteroAttachmentImport({
      userId: data.memberId,
      workspaceId: data.workspaceId,
      connectionId: data.connectionId,
      attachmentId: data.attachmentId,
      command: command(`rotated-${data.suffix}`),
    }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } });
    const stored = await prisma.zoteroAttachmentImport.findUniqueOrThrow({
      where: { id: queued.import.id },
    });
    assert.equal(stored.credentialGeneration, 2);

    await prisma.zoteroObject.update({
      where: { id: data.attachmentId },
      data: { version: "8" },
    });
    await prisma.zoteroAttachment.update({
      where: { zoteroObjectId: data.attachmentId },
      data: {
        sourceVersion: "8",
        metadataHash: "c".repeat(64),
        providerMd5: "fedcba9876543210fedcba9876543210",
      },
    });
    await assert.rejects(
      queueZoteroAttachmentImport({
        userId: data.memberId,
        workspaceId: data.workspaceId,
        connectionId: data.connectionId,
        attachmentId: data.attachmentId,
        command: command(`stale-source-${data.suffix}`),
      }, { limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 } }),
      problem("zotero_attachment_source_changed"),
    );
  } finally {
    await cleanup(data);
  }
});

test("a late database failure rolls back every import, quota, document, inbox, and job row", async () => {
  const data = await fixture();
  const collisionId = `atomic-collision-${data.suffix}`;
  try {
    await prisma.auditEvent.create({
      data: {
        id: collisionId,
        organizationId: data.workspaceId,
        actorUserId: data.ownerId,
        action: "test.atomic-collision",
        entityType: "test",
      },
    });
    await assert.rejects(
      queueZoteroAttachmentImport({
        userId: data.memberId,
        workspaceId: data.workspaceId,
        connectionId: data.connectionId,
        attachmentId: data.attachmentId,
        command: command(`atomic-${data.suffix}`),
      }, {
        id: () => collisionId,
        limits: { maxPdfBytes: 100, maxRetainedBytes: 1_000 },
      }),
    );
    assert.equal(
      await prisma.zoteroAttachmentImport.count({ where: { organizationId: data.workspaceId } }),
      0,
    );
    assert.equal(
      await prisma.documentIntake.count({
        where: { organizationId: data.workspaceId, source: "ZOTERO_ATTACHMENT" },
      }),
      0,
    );
    assert.equal(
      await prisma.document.count({
        where: { organizationId: data.workspaceId, sourceFingerprint: { startsWith: "zotero-attachment:" } },
      }),
      0,
    );
    assert.equal(
      await prisma.asset.count({
        where: { organizationId: data.workspaceId, objectKey: { startsWith: "pending:zotero:" } },
      }),
      0,
    );
    assert.equal(
      await prisma.inboxEntry.count({
        where: { organizationId: data.workspaceId, sourceKey: { startsWith: "attachment-import:" } },
      }),
      0,
    );
    assert.equal(
      await prisma.importBatch.count({
        where: { organizationId: data.workspaceId, label: "Zotero stored PDF import" },
      }),
      0,
    );
    assert.equal(
      await prisma.job.count({ where: { organizationId: data.workspaceId, type: "DOCUMENT_DOWNLOAD" } }),
      0,
    );
    assert.equal(
      await prisma.idempotencyRecord.count({
        where: { organizationId: data.workspaceId, key: `atomic-${data.suffix}` },
      }),
      0,
    );
  } finally {
    await cleanup(data);
  }
});
