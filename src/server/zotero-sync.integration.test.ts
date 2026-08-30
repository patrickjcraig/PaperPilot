import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import {
  claimNextZoteroSyncJob,
  completeZoteroSyncLease,
  failZoteroSyncLease,
  queueSelectedZoteroSyncs,
  scheduleDueZoteroSyncs,
  stageZoteroSyncObjects,
} from "./integrations/zotero/sync-jobs";
import { zoteroContentHash } from "./integrations/zotero/normalization";
import { toZoteroVersion } from "./integrations/zotero/protocol";

const PROVIDER_MD5 = "0123456789abcdef0123456789abcdef";

interface Fixture {
  suffix: string;
  userId: string;
  outsiderId: string;
  organizationId: string;
  connectionId: string;
  libraryId: string;
  paperId: string;
  workspacePaperId: string;
  evidenceNoteId: string;
}

async function fixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = "zsync-owner-" + suffix;
  const outsiderId = "zsync-outsider-" + suffix;
  const organizationId = "zsync-org-" + suffix;
  const connectionId = "zsync-connection-" + suffix;
  const libraryId = "zsync-library-" + suffix;
  const paperId = "zsync-paper-" + suffix;
  const workspacePaperId = "zsync-workspace-paper-" + suffix;
  const evidenceNoteId = "zsync-note-" + suffix;
  const deletedObjectId = "zsync-deleted-object-" + suffix;

  await prisma.user.createMany({
    data: [
      {
        id: userId,
        name: "Zotero sync owner",
        email: "zsync-owner-" + suffix + "@example.test",
        emailVerified: true,
      },
      {
        id: outsiderId,
        name: "Zotero sync outsider",
        email: "zsync-outsider-" + suffix + "@example.test",
        emailVerified: true,
      },
    ],
  });
  await prisma.organization.create({
    data: {
      id: organizationId,
      name: "Zotero sync workspace",
      slug: "zsync-" + suffix,
      members: {
        create: {
          id: "zsync-member-" + suffix,
          userId,
          role: "owner",
        },
      },
    },
  });
  await prisma.integrationConnection.create({
    data: {
      id: connectionId,
      organizationId,
      provider: "ZOTERO",
      authType: "OAUTH1",
      status: "CONNECTED",
      displayName: "Zotero test account",
      externalAccountId: "91234",
      credentialCiphertext: new Uint8Array([1, 2, 3]),
      credentialFingerprint: "test-fingerprint-" + suffix,
      credentialKeyVersion: "v1",
      credentialGeneration: 1,
      createdById: userId,
      zoteroLibrariesConfiguredAt: new Date(),
      zoteroSelectionRevision: 1,
    },
  });
  await prisma.zoteroLibrary.create({
    data: {
      id: libraryId,
      organizationId,
      integrationConnectionId: connectionId,
      libraryType: "USER",
      zoteroLibraryId: "91234",
      name: "My Library",
      isReadable: true,
      syncEnabled: true,
      lastSyncedVersion: "1",
    },
  });
  await prisma.paper.create({
    data: { id: paperId, title: "Durable local paper" },
  });
  await prisma.workspacePaper.create({
    data: {
      id: workspacePaperId,
      organizationId,
      paperId,
      status: "SAVED",
      addedById: userId,
    },
  });
  await prisma.evidenceNote.create({
    data: {
      id: evidenceNoteId,
      organizationId,
      workspacePaperId,
      createdById: userId,
      kind: "NOTE",
      status: "CAPTURED",
      text: "Evidence that must survive a remote source deletion.",
    },
  });
  const deletedData = {
    itemType: "journalArticle",
    title: "Remote source later deleted",
  };
  await prisma.zoteroObject.create({
    data: {
      id: deletedObjectId,
      organizationId,
      zoteroLibraryId: libraryId,
      objectType: "ITEM",
      zoteroKey: "DEAD1234",
      version: "1",
      paperId,
      workspacePaperId,
      data: deletedData,
      contentHash: zoteroContentHash(deletedData),
    },
  });
  await prisma.zoteroAttachment.create({
    data: {
      zoteroObjectId: deletedObjectId,
      organizationId,
      zoteroLibraryId: libraryId,
      sourceVersion: "1",
      metadataHash: "a".repeat(64),
      eligibility: "INELIGIBLE",
      reasonCode: "item_not_attachment",
    },
  });
  return {
    suffix,
    userId,
    outsiderId,
    organizationId,
    connectionId,
    libraryId,
    paperId,
    workspacePaperId,
    evidenceNoteId,
  };
}

async function cleanup(value: Fixture): Promise<void> {
  const organizationId = value.organizationId;
  await prisma.$transaction(async (transaction) => {
    await transaction.provenanceRecord.deleteMany({ where: { organizationId } });
    await transaction.evidenceTextAnchor.deleteMany({ where: { organizationId } });
    await transaction.evidenceNote.deleteMany({ where: { organizationId } });
    await transaction.projectPaper.deleteMany({ where: { organizationId } });
    await transaction.project.deleteMany({ where: { organizationId } });
    await transaction.inboxEntry.deleteMany({ where: { organizationId } });
    await transaction.idempotencyRecord.deleteMany({ where: { organizationId } });
    await transaction.auditEvent.deleteMany({ where: { organizationId } });
    await transaction.zoteroSyncStage.deleteMany({ where: { organizationId } });
    await transaction.zoteroAttachmentImport.deleteMany({ where: { organizationId } });
    await transaction.jobAttempt.deleteMany({ where: { organizationId } });
    await transaction.job.deleteMany({ where: { organizationId } });
    await transaction.zoteroSyncRun.deleteMany({ where: { organizationId } });
    await transaction.zoteroAttachment.deleteMany({ where: { organizationId } });
    await transaction.zoteroObject.deleteMany({ where: { organizationId } });
    await transaction.zoteroLibrary.deleteMany({ where: { organizationId } });
    await transaction.integrationConnection.deleteMany({ where: { organizationId } });
    await transaction.workspacePaper.deleteMany({ where: { organizationId } });
    await transaction.member.deleteMany({ where: { organizationId } });
    await transaction.organization.deleteMany({ where: { id: organizationId } });
  });
  await prisma.paper.deleteMany({ where: { id: value.paperId } });
  await prisma.user.deleteMany({
    where: { id: { in: [value.userId, value.outsiderId] } },
  });
}

test("a stable pass atomically publishes metadata, sanitized attachment projections, and tombstones", async () => {
  const data = await fixture();
  try {
    await assert.rejects(
      queueSelectedZoteroSyncs({
        userId: data.outsiderId,
        workspaceId: data.organizationId,
        connectionId: data.connectionId,
        clientOperationId: "foreign-" + data.suffix,
      }),
      (error: unknown) =>
        error instanceof Error && error.message === "Workspace was not found.",
    );

    const queueNow = new Date("2026-08-28T14:59:00.000Z");
    const queued = await queueSelectedZoteroSyncs({
      userId: data.userId,
      workspaceId: data.organizationId,
      connectionId: data.connectionId,
      clientOperationId: "queue-" + data.suffix,
    }, { now: () => queueNow });
    assert.equal(queued.outcome, "queued");
    assert.equal(queued.queuedCount, 1);
    assert.equal(queued.coalescedCount, 0);
    assert.equal(queued.runs.length, 1);
    assert.equal(queued.runs[0].fromVersion, "1");

    const replay = await queueSelectedZoteroSyncs({
      userId: data.userId,
      workspaceId: data.organizationId,
      connectionId: data.connectionId,
      clientOperationId: "queue-" + data.suffix,
    }, { now: () => queueNow });
    assert.deepEqual(replay, queued);

    const coalesced = await queueSelectedZoteroSyncs({
      userId: data.userId,
      workspaceId: data.organizationId,
      connectionId: data.connectionId,
      clientOperationId: "coalesce-" + data.suffix,
    }, { now: () => queueNow });
    assert.equal(coalesced.outcome, "coalesced");
    assert.equal(coalesced.queuedCount, 0);
    assert.equal(coalesced.coalescedCount, 1);
    assert.equal(coalesced.runs[0].id, queued.runs[0].id);

    const claimResults = await Promise.all([
      claimNextZoteroSyncJob({
        workerId: "integration-worker-a",
        now: new Date("2026-08-28T15:00:00.000Z"),
      }),
      claimNextZoteroSyncJob({
        workerId: "integration-worker-b",
        now: new Date("2026-08-28T15:00:00.000Z"),
      }),
    ]);
    const claimedLeases = claimResults.filter(
      (candidate): candidate is NonNullable<typeof candidate> => candidate !== null,
    );
    assert.equal(claimedLeases.length, 1);
    assert.equal(claimResults.filter((candidate) => candidate === null).length, 1);
    const lease = claimedLeases[0];
    assert.ok(lease);
    assert.equal(lease.organizationId, data.organizationId);
    assert.equal(lease.fromVersion, "1");

    const paperData = {
      itemType: "journalArticle",
      title: "Synced paper",
      creators: [
        { creatorType: "author", firstName: "Grace", lastName: "Hopper" },
      ],
      publicationTitle: "Journal of Durable Research",
      date: "2026",
      DOI: "10.7777/paperpilot.1",
      abstractNote: "A synchronized provider record.",
    };
    const collectionData = { key: "COLL1234", name: "Review corpus" };
    const downloadableAttachmentData = {
      itemType: "attachment",
      linkMode: "imported_file",
      contentType: "application/pdf",
      filename: "Cafe\u0301.PDF",
      md5: PROVIDER_MD5,
      mtime: 1_775_000_123_456,
      parentItem: "ABC12345",
      path: "C:\\Users\\researcher\\Private Study\\paper.pdf",
      signedUrl: "https://storage.invalid/private-signed-object",
    };
    const linkedAttachmentData = {
      itemType: "attachment",
      linkMode: "linked_file",
      contentType: "application/pdf",
      filename: "local-only.pdf",
      md5: "1".repeat(32),
      path: "C:\\Users\\researcher\\Private Study\\local-only.pdf",
    };
    const malformedAttachmentData = {
      itemType: "attachment",
      linkMode: "imported_file",
      contentType: "application/pdf",
      filename: "bad-md5.pdf",
      md5: "NOT-A-CANONICAL-MD5",
    };
    assert.equal(await stageZoteroSyncObjects({
      lease,
      now: new Date("2026-08-28T15:00:01.000Z"),
      stages: [
        {
          objectType: "ITEM",
          zoteroKey: "ABC12345",
          version: toZoteroVersion("4"),
          isDeleted: false,
          data: paperData,
          contentHash: zoteroContentHash(paperData),
        },
        {
          objectType: "COLLECTION",
          zoteroKey: "COLL1234",
          version: toZoteroVersion("3"),
          isDeleted: false,
          data: collectionData,
          contentHash: zoteroContentHash(collectionData),
        },
        {
          objectType: "ITEM",
          zoteroKey: "ATTACH01",
          parentKey: "ABC12345",
          version: toZoteroVersion("4"),
          isDeleted: false,
          data: downloadableAttachmentData,
          contentHash: zoteroContentHash(downloadableAttachmentData),
        },
        {
          objectType: "ITEM",
          zoteroKey: "LINKED01",
          version: toZoteroVersion("4"),
          isDeleted: false,
          data: linkedAttachmentData,
          contentHash: zoteroContentHash(linkedAttachmentData),
        },
        {
          objectType: "ITEM",
          zoteroKey: "BADMD501",
          version: toZoteroVersion("4"),
          isDeleted: false,
          data: malformedAttachmentData,
          contentHash: zoteroContentHash(malformedAttachmentData),
        },
        {
          objectType: "ITEM",
          zoteroKey: "DEAD1234",
          version: toZoteroVersion("5"),
          isDeleted: true,
        },
      ],
    }), true);

    assert.equal(await completeZoteroSyncLease({
      lease,
      targetVersion: toZoteroVersion("5"),
      now: new Date("2026-08-28T15:00:02.000Z"),
    }), "applied");

    const library = await prisma.zoteroLibrary.findUniqueOrThrow({
      where: { id: data.libraryId },
    });
    assert.equal(library.lastSyncedVersion, "5");
    assert.equal(library.lastItemVersion, "5");
    assert.equal(library.lastCollectionVersion, "5");
    assert.equal(library.lastDeletionVersion, "5");

    const objects = await prisma.zoteroObject.findMany({
      where: { organizationId: data.organizationId },
      orderBy: { zoteroKey: "asc" },
    });
    assert.equal(objects.length, 6);
    assert.equal(
      objects.find((object) => object.zoteroKey === "ABC12345")?.isDeleted,
      false,
    );
    const tombstone = objects.find((object) => object.zoteroKey === "DEAD1234");
    assert.equal(tombstone?.isDeleted, true);
    assert.equal(tombstone?.paperId, data.paperId);
    assert.equal(tombstone?.workspacePaperId, data.workspacePaperId);

    const attachments = await prisma.zoteroAttachment.findMany({
      where: { organizationId: data.organizationId },
      include: { object: { select: { zoteroKey: true } } },
      orderBy: { zoteroObjectId: "asc" },
    });
    assert.equal(attachments.length, 5);
    const downloadable = attachments.find(
      (attachment) => attachment.object.zoteroKey === "ATTACH01",
    );
    assert.ok(downloadable);
    assert.deepEqual({
      parentKey: downloadable.parentKey,
      linkMode: downloadable.linkMode,
      contentType: downloadable.contentType,
      fileName: downloadable.fileName,
      providerMd5: downloadable.providerMd5,
      providerMtime: downloadable.providerMtime,
      sourceVersion: downloadable.sourceVersion,
      eligibility: downloadable.eligibility,
      reasonCode: downloadable.reasonCode,
      isDeleted: downloadable.isDeleted,
    }, {
      parentKey: "ABC12345",
      linkMode: "imported_file",
      contentType: "application/pdf",
      fileName: "Café.PDF",
      providerMd5: PROVIDER_MD5,
      providerMtime: "1775000123456",
      sourceVersion: "4",
      eligibility: "DOWNLOADABLE",
      reasonCode: null,
      isDeleted: false,
    });
    assert.match(downloadable.metadataHash, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(
      JSON.stringify(downloadable),
      /Private Study|private-signed-object/i,
    );
    const linked = attachments.find(
      (attachment) => attachment.object.zoteroKey === "LINKED01",
    );
    assert.ok(linked);
    assert.equal(linked.eligibility, "INELIGIBLE");
    assert.equal(linked.reasonCode, "linked_file_not_downloadable");
    assert.equal(linked.linkMode, null);
    assert.equal(linked.fileName, null);
    assert.equal(linked.providerMd5, null);
    assert.doesNotMatch(JSON.stringify(linked), /Private Study|local-only\.pdf/i);
    const malformed = attachments.find(
      (attachment) => attachment.object.zoteroKey === "BADMD501",
    );
    assert.ok(malformed);
    assert.equal(malformed.eligibility, "MALFORMED");
    assert.equal(malformed.reasonCode, "invalid_md5");
    assert.equal(malformed.providerMd5, null);
    const deletedAttachment = attachments.find(
      (attachment) => attachment.object.zoteroKey === "DEAD1234",
    );
    assert.ok(deletedAttachment);
    assert.equal(deletedAttachment.isDeleted, true);
    assert.equal(deletedAttachment.sourceVersion, "1");
    assert.equal(deletedAttachment.metadataHash, "a".repeat(64));

    const inbox = await prisma.inboxEntry.findFirstOrThrow({
      where: {
        organizationId: data.organizationId,
        source: "ZOTERO",
        sourceKey: { contains: "ABC12345" },
      },
    });
    assert.equal(inbox.status, "PENDING");
    assert.equal(inbox.proposedTitle, "Synced paper");
    assert.doesNotMatch(JSON.stringify(inbox.payload), /credential|token/i);

    assert.ok(await prisma.paper.findUnique({ where: { id: data.paperId } }));
    assert.ok(await prisma.evidenceNote.findUnique({
      where: { id: data.evidenceNoteId },
    }));
    assert.ok(await prisma.provenanceRecord.count({
      where: {
        organizationId: data.organizationId,
        kind: "ZOTERO_SYNC",
      },
    }) >= 3);

    const run = await prisma.zoteroSyncRun.findUniqueOrThrow({
      where: { id: lease.runId },
    });
    assert.equal(run.status, "SUCCEEDED");
    assert.equal(run.toVersion, "5");
    assert.equal(run.objectsWritten, 5);
    assert.equal(run.objectsDeleted, 1);
    assert.equal(await prisma.zoteroSyncStage.count({
      where: { zoteroSyncRunId: lease.runId },
    }), 0);

    const secondQueued = await queueSelectedZoteroSyncs({
      userId: data.userId,
      workspaceId: data.organizationId,
      connectionId: data.connectionId,
      clientOperationId: "queue-second-cycle-" + data.suffix,
    }, { now: () => new Date("2026-08-28T15:10:00.000Z") });
    assert.equal(secondQueued.outcome, "queued");

    const secondLease = await claimNextZoteroSyncJob({
      workerId: "integration-worker",
      now: new Date("2026-08-28T15:11:00.000Z"),
    });
    assert.ok(secondLease);
    assert.equal(secondLease.jobId, lease.jobId);
    assert.equal(secondLease.attemptNumber, 2);
    const reorderedDownloadableAttachmentData = {
      signedUrl: "https://storage.invalid/a-different-signed-object",
      parentItem: "ABC12345",
      mtime: "1775000123456",
      md5: PROVIDER_MD5,
      filename: "Café.PDF",
      contentType: "application/pdf",
      linkMode: "imported_file",
      itemType: "attachment",
    };
    const restoredAttachmentData = {
      itemType: "attachment",
      linkMode: "imported_url",
      contentType: "application/pdf",
      filename: "restored.pdf",
      md5: "2".repeat(32),
      parentItem: false,
    };
    assert.equal(await stageZoteroSyncObjects({
      lease: secondLease,
      now: new Date("2026-08-28T15:11:00.500Z"),
      stages: [
        {
          objectType: "ITEM",
          zoteroKey: "ATTACH01",
          parentKey: "ABC12345",
          version: toZoteroVersion("6"),
          isDeleted: false,
          data: reorderedDownloadableAttachmentData,
          contentHash: zoteroContentHash(reorderedDownloadableAttachmentData),
        },
        {
          objectType: "ITEM",
          zoteroKey: "DEAD1234",
          version: toZoteroVersion("6"),
          isDeleted: false,
          data: restoredAttachmentData,
          contentHash: zoteroContentHash(restoredAttachmentData),
        },
      ],
    }), true);
    assert.equal(await completeZoteroSyncLease({
      lease: secondLease,
      targetVersion: toZoteroVersion("6"),
      now: new Date("2026-08-28T15:11:01.000Z"),
    }), "applied");
    const republishedDownloadable = await prisma.zoteroAttachment.findFirstOrThrow({
      where: {
        organizationId: data.organizationId,
        object: { zoteroKey: "ATTACH01" },
      },
    });
    assert.equal(republishedDownloadable.sourceVersion, "6");
    assert.equal(republishedDownloadable.metadataHash, downloadable.metadataHash);
    const restoredAttachment = await prisma.zoteroAttachment.findFirstOrThrow({
      where: {
        organizationId: data.organizationId,
        object: { zoteroKey: "DEAD1234" },
      },
    });
    assert.equal(restoredAttachment.isDeleted, false);
    assert.equal(restoredAttachment.sourceVersion, "6");
    assert.equal(restoredAttachment.eligibility, "DOWNLOADABLE");
    assert.equal(restoredAttachment.linkMode, "imported_url");
    assert.equal(restoredAttachment.fileName, "restored.pdf");
    assert.equal(restoredAttachment.providerMd5, "2".repeat(32));
    assert.notEqual(restoredAttachment.metadataHash, "a".repeat(64));
    assert.equal(await prisma.jobAttempt.count({
      where: { organizationId: data.organizationId, jobId: lease.jobId },
    }), 2);
    const reusedJob = await prisma.job.findUniqueOrThrow({
      where: { id: lease.jobId },
    });
    assert.equal(reusedJob.attempts, 2);
    assert.equal(reusedJob.maxAttempts, 9);
  } finally {
    await cleanup(data);
  }
});

test("unstable or throttled passes discard staging, preserve the cursor, and persist retry scheduling", async () => {
  const data = await fixture();
  try {
    await queueSelectedZoteroSyncs({
      userId: data.userId,
      workspaceId: data.organizationId,
      connectionId: data.connectionId,
      clientOperationId: "unstable-" + data.suffix,
    }, { now: () => new Date("2026-08-28T15:59:00.000Z") });
    const claimedAt = new Date("2026-08-28T16:00:00.000Z");
    const lease = await claimNextZoteroSyncJob({
      workerId: "unstable-worker",
      now: claimedAt,
    });
    assert.ok(lease);
    assert.equal(lease.credentialGeneration, 1);
    const item = { itemType: "journalArticle", title: "Never committed" };
    assert.equal(await stageZoteroSyncObjects({
      lease,
      now: new Date("2026-08-28T16:00:01.000Z"),
      stages: [{
        objectType: "ITEM",
        zoteroKey: "WAIT1234",
        version: toZoteroVersion("2"),
        isDeleted: false,
        data: item,
        contentHash: zoteroContentHash(item),
      }],
    }), true);
    const retryAt = new Date("2026-08-28T16:02:00.000Z");
    assert.equal(await failZoteroSyncLease({
      lease,
      code: "stable_version_changed",
      retryable: true,
      retryAt,
      connectionWideBackoff: true,
      now: new Date("2026-08-28T16:00:02.000Z"),
    }), "retrying");

    const library = await prisma.zoteroLibrary.findUniqueOrThrow({
      where: { id: data.libraryId },
    });
    assert.equal(library.lastSyncedVersion, "1");
    assert.equal(await prisma.zoteroObject.count({
      where: {
        zoteroLibraryId: data.libraryId,
        zoteroKey: "WAIT1234",
      },
    }), 0);
    assert.equal(await prisma.zoteroSyncStage.count({
      where: { zoteroSyncRunId: lease.runId },
    }), 0);
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: data.connectionId },
    });
    assert.equal(connection.providerBackoffUntil?.toISOString(), retryAt.toISOString());
    const run = await prisma.zoteroSyncRun.findUniqueOrThrow({
      where: { id: lease.runId },
    });
    assert.equal(run.status, "BACKING_OFF");
    assert.equal(run.errorCode, "stable_version_changed");
  } finally {
    await cleanup(data);
  }
});

test("a late lease fence rolls back attachment projection publication with the metadata cursor", async () => {
  const data = await fixture();
  try {
    await queueSelectedZoteroSyncs({
      userId: data.userId,
      workspaceId: data.organizationId,
      connectionId: data.connectionId,
      clientOperationId: "projection-rollback-" + data.suffix,
    }, { now: () => new Date("2026-08-28T16:29:00.000Z") });
    const lease = await claimNextZoteroSyncJob({
      workerId: "projection-rollback-worker",
      now: new Date("2026-08-28T16:30:00.000Z"),
    });
    assert.ok(lease);
    const attachmentData = {
      itemType: "attachment",
      linkMode: "imported_file",
      contentType: "application/pdf",
      filename: "must-roll-back.pdf",
      md5: "3".repeat(32),
    };
    assert.equal(await stageZoteroSyncObjects({
      lease,
      now: new Date("2026-08-28T16:30:01.000Z"),
      stages: [{
        objectType: "ITEM",
        zoteroKey: "ROLLBACK",
        version: toZoteroVersion("2"),
        isDeleted: false,
        data: attachmentData,
        contentHash: zoteroContentHash(attachmentData),
      }],
    }), true);

    // Simulate a late fencing race: the job lease still looks current, but
    // its exact attempt is no longer completable. The publisher will have
    // written the object and projection earlier in its transaction, then must
    // roll both back when this final compare-and-set misses.
    await prisma.jobAttempt.update({
      where: { id: lease.jobAttemptId },
      data: {
        status: "FAILED",
        errorCode: "superseded_attempt",
        completedAt: new Date("2026-08-28T16:30:01.500Z"),
      },
    });
    assert.equal(await completeZoteroSyncLease({
      lease,
      targetVersion: toZoteroVersion("2"),
      now: new Date("2026-08-28T16:30:02.000Z"),
    }), "lease-lost");

    assert.equal(await prisma.zoteroObject.count({
      where: {
        organizationId: data.organizationId,
        zoteroKey: "ROLLBACK",
      },
    }), 0);
    assert.equal(await prisma.zoteroAttachment.count({
      where: {
        organizationId: data.organizationId,
        object: { zoteroKey: "ROLLBACK" },
      },
    }), 0);
    const library = await prisma.zoteroLibrary.findUniqueOrThrow({
      where: { id: data.libraryId },
    });
    assert.equal(library.lastSyncedVersion, "1");
    const run = await prisma.zoteroSyncRun.findUniqueOrThrow({
      where: { id: lease.runId },
    });
    assert.equal(run.status, "RUNNING");
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: lease.jobId },
    });
    assert.equal(job.status, "RUNNING");
    assert.equal(await prisma.zoteroSyncStage.count({
      where: { zoteroSyncRunId: lease.runId },
    }), 1);
  } finally {
    await cleanup(data);
  }
});

test("the periodic scheduler coalesces one due run per selected library", async () => {
  const data = await fixture();
  try {
    await prisma.zoteroLibrary.update({
      where: { id: data.libraryId },
      data: { lastSyncedAt: new Date("2026-08-28T10:00:00.000Z") },
    });
    const now = new Date("2026-08-28T17:00:00.000Z");
    const first = await scheduleDueZoteroSyncs({
      now,
      cadenceMs: 15 * 60_000,
      id: randomUUID,
    });
    assert.equal(first.queued, 1);
    const second = await scheduleDueZoteroSyncs({
      now,
      cadenceMs: 15 * 60_000,
      id: randomUUID,
    });
    assert.equal(second.queued, 0);
    assert.equal(await prisma.job.count({
      where: {
        organizationId: data.organizationId,
        type: "ZOTERO_SYNC",
        status: "QUEUED",
      },
    }), 1);
    assert.equal(await prisma.zoteroSyncRun.count({
      where: {
        organizationId: data.organizationId,
        zoteroLibraryId: data.libraryId,
        status: "QUEUED",
      },
    }), 1);
  } finally {
    await cleanup(data);
  }
});

test("disconnect fences an in-flight worker and expired cleanup removes its staging", async () => {
  const data = await fixture();
  try {
    await queueSelectedZoteroSyncs({
      userId: data.userId,
      workspaceId: data.organizationId,
      connectionId: data.connectionId,
      clientOperationId: "disconnect-race-" + data.suffix,
    }, { now: () => new Date("2026-08-28T18:00:00.000Z") });
    const lease = await claimNextZoteroSyncJob({
      workerId: "disconnect-race-worker",
      now: new Date("2026-08-28T18:00:01.000Z"),
    });
    assert.ok(lease);
    assert.equal(lease.credentialGeneration, 1);
    const stagedData = { itemType: "journalArticle", title: "Stale staged item" };
    assert.equal(await stageZoteroSyncObjects({
      lease,
      now: new Date("2026-08-28T18:00:02.000Z"),
      stages: [{
        objectType: "ITEM",
        zoteroKey: "STALE123",
        version: toZoteroVersion("2"),
        isDeleted: false,
        data: stagedData,
        contentHash: zoteroContentHash(stagedData),
      }],
    }), true);

    await prisma.$transaction([
      prisma.integrationConnection.update({
        where: { id: data.connectionId },
        data: {
          status: "DISCONNECTED",
          credentialCiphertext: null,
          credentialFingerprint: null,
          credentialKeyVersion: null,
          credentialGeneration: { increment: 1 },
          revokedAt: new Date("2026-08-28T18:00:03.000Z"),
        },
      }),
      prisma.zoteroLibrary.update({
        where: { id: data.libraryId },
        data: { syncEnabled: false },
      }),
    ]);

    assert.equal(await failZoteroSyncLease({
      lease,
      code: "zotero_credential_unavailable",
      retryable: false,
      now: new Date("2026-08-28T18:00:04.000Z"),
    }), "lease-lost");
    assert.equal(
      (await prisma.integrationConnection.findUniqueOrThrow({
        where: { id: data.connectionId },
        select: { credentialGeneration: true },
      })).credentialGeneration,
      2,
    );
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: data.connectionId },
    });
    assert.equal(connection.status, "DISCONNECTED");
    assert.equal(connection.lastErrorCode, null);

    assert.equal(await claimNextZoteroSyncJob({
      workerId: "cleanup-worker",
      now: new Date("2026-08-28T18:02:00.000Z"),
    }), null);
    assert.equal(await prisma.zoteroSyncStage.count({
      where: { organizationId: data.organizationId },
    }), 0);
    const job = await prisma.job.findFirstOrThrow({
      where: { organizationId: data.organizationId, type: "ZOTERO_SYNC" },
    });
    assert.equal(job.status, "DEAD_LETTER");
  } finally {
    await cleanup(data);
  }
});

test("terminal failures retain provider Backoff and require a manual retry", async () => {
  const data = await fixture();
  try {
    await prisma.zoteroLibrary.update({
      where: { id: data.libraryId },
      data: { lastSyncedAt: new Date("2026-08-28T10:00:00.000Z") },
    });
    const scheduled = await scheduleDueZoteroSyncs({
      now: new Date("2026-08-28T19:00:00.000Z"),
      cadenceMs: 15 * 60_000,
    });
    assert.equal(scheduled.queued, 1);
    const lease = await claimNextZoteroSyncJob({
      workerId: "terminal-worker",
      now: new Date("2026-08-28T19:00:01.000Z"),
    });
    assert.ok(lease);
    const retryAt = new Date("2026-08-28T19:05:00.000Z");
    assert.equal(await failZoteroSyncLease({
      lease,
      code: "zotero_not_found",
      retryable: false,
      retryAt,
      connectionWideBackoff: true,
      now: new Date("2026-08-28T19:00:02.000Z"),
    }), "failed");
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: data.connectionId },
    });
    assert.equal(connection.providerBackoffUntil?.toISOString(), retryAt.toISOString());

    const automaticRetry = await scheduleDueZoteroSyncs({
      now: new Date("2026-08-28T19:06:00.000Z"),
      cadenceMs: 15 * 60_000,
    });
    assert.equal(automaticRetry.queued, 0);
    assert.equal(await prisma.zoteroSyncRun.count({
      where: { organizationId: data.organizationId },
    }), 1);
  } finally {
    await cleanup(data);
  }
});
