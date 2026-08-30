import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { workspaceBootstrap } from "@/server/workspaces/service";
import {
  CRAWLER_ACQUISITION_MODE_V1,
  CRAWLER_RETENTION_MODE_V1,
  CRAWLER_RIGHTS_ATTESTATION_V1,
  CRAWLER_ROBOTS_MODE_V1,
} from "@/server/integrations/web-source/crawler-command";
import type { CrawlerConfiguration } from "@/server/integrations/web-source/crawler-config";
import {
  claimNextCrawlerJob,
  completeCrawlerJob,
  failCrawlerJob,
  heartbeatCrawlerJob,
  markCrawlerIngressWritten,
  reconcileCrawlerJobCleanup,
  writtenCrawlerDownloadFromStorage,
  type CrawlerJobLease,
  type WrittenCrawlerDownload,
} from "@/server/integrations/web-source/crawler-jobs";
import { queueCrawlerRequest } from "@/server/integrations/web-source/crawler-service";
import type { GovernedPdfFetchReceipt } from "@/server/integrations/web-source/governed-pdf-fetch";
import {
  streamAuthorizedPdfToLocalQuarantine,
  withOpenLocalQuarantineObject,
} from "@/server/uploads/storage";

const MAX_BYTES = 1_024;
const LEASE_TTL_MS = 60_000;
const PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
);

const CRAWLER_CONFIGURATION = Object.freeze({
  acquisitionMode: CRAWLER_ACQUISITION_MODE_V1,
  policyVersion: "paperpilot-crawler-explicit-pdf-v1",
  robotsUserAgent: "PaperPilotCrawler",
  maxRedirects: 0,
  maxDnsAddresses: 8,
  dnsLookupTimeoutMs: 3_000,
  maxResponseBytes: MAX_BYTES,
  maxResponseHeaderBytes: 32 * 1_024,
  responseHeaderTimeoutMs: 5_000,
  responseIdleTimeoutMs: 10_000,
  absoluteDeadlineMs: 60_000,
  ratePolicyVersion: "paperpilot-crawler-origin-rate-v1",
  originRequestsPerMinute: 6,
  originBurst: 1,
  workerIdentity: "paperpilot-crawler-integration",
} satisfies CrawlerConfiguration);

interface Fixture {
  organizationId: string;
  userId: string;
  sourceUrl: string;
  quarantineRoot: string;
}

interface QueuedTarget {
  crawlerImportId: string;
  jobId: string;
  intakeId: string;
  documentId: string;
  assetId: string;
  inboxEntryId: string;
  importBatchId: string;
  runAfter: Date;
}

function addMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

async function fixture(label: string): Promise<Fixture> {
  const suffix = randomUUID();
  const organizationId = `crawler-it-workspace-${suffix}`;
  const userId = `crawler-it-user-${suffix}`;
  const quarantineRoot = await mkdtemp(
    path.join(process.cwd(), ".paperpilot-crawler-it-"),
  );
  await chmod(quarantineRoot, 0o700);
  await prisma.user.create({
    data: {
      id: userId,
      name: "Crawler integration user",
      email: `${userId}@example.test`,
    },
  });
  await prisma.organization.create({
    data: {
      id: organizationId,
      name: "Crawler integration workspace",
      slug: organizationId,
    },
  });
  await prisma.member.create({
    data: { organizationId, userId, role: "owner" },
  });
  return {
    organizationId,
    userId,
    sourceUrl: `https://example.com/${label}-${suffix}.pdf`,
    quarantineRoot,
  };
}

async function queue(value: Fixture): Promise<QueuedTarget> {
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: value.organizationId },
    select: { revision: true },
  });
  const queued = await queueCrawlerRequest({
    userId: value.userId,
    workspaceId: value.organizationId,
    command: {
      schemaVersion: 1,
      clientOperationId: `crawler-operation-${randomUUID()}`,
      expectedVersion: organization.revision,
      policyVersion: CRAWLER_CONFIGURATION.policyVersion,
      sourceUrl: value.sourceUrl,
      displayFileName: "governed-paper.pdf",
      rightsAttestation: {
        scope: CRAWLER_RIGHTS_ATTESTATION_V1,
        userDeclared: true,
      },
      robotsMode: CRAWLER_ROBOTS_MODE_V1,
      retentionMode: CRAWLER_RETENTION_MODE_V1,
      maxBytes: MAX_BYTES,
    },
  }, {
    configuration: {
      crawler: CRAWLER_CONFIGURATION,
      maxRetainedBytesPerWorkspace: MAX_BYTES * 10,
    },
  });
  const crawlerImport = await prisma.crawlerImport.findUniqueOrThrow({
    where: { id: queued.request.id },
    include: { crawlJob: { select: { runAfter: true } } },
  });
  // The production claimer is deliberately cross-tenant. Give this isolated
  // fixture scheduling precedence so unrelated local development jobs cannot
  // be consumed by the integration worker.
  await prisma.job.update({
    where: { id: crawlerImport.crawlJobId },
    data: { priority: 2_000_000_000 },
  });
  return {
    crawlerImportId: crawlerImport.id,
    jobId: crawlerImport.crawlJobId,
    intakeId: crawlerImport.intakeId,
    documentId: crawlerImport.documentId,
    assetId: crawlerImport.assetId,
    inboxEntryId: crawlerImport.inboxEntryId,
    importBatchId: crawlerImport.importBatchId,
    runAfter: crawlerImport.crawlJob.runAfter,
  };
}

function fetchReceipt(lease: CrawlerJobLease, retrievedAt: Date): GovernedPdfFetchReceipt {
  const urlDigest = createHash("sha256")
    .update(lease.canonicalSourceUrl, "utf8")
    .digest("hex");
  return {
    schemaVersion: 1,
    requestedUrlSha256: urlDigest,
    finalUrlSha256: urlDigest,
    redirectChainSha256: createHash("sha256")
      .update("paperpilot-crawler-integration:no-redirect", "utf8")
      .digest("hex"),
    redirectCount: 0,
    robotsCheckCount: 1,
    pinnedConnectionCount: 2,
    retrievedAt: retrievedAt.toISOString(),
    contentType: "application/pdf",
    contentEncoding: "identity",
    contentLength: PDF_BYTES.byteLength,
    userAgent: `${lease.fetchPolicy.robotsUserAgent}/1.0`,
  };
}

async function writeQuarantineBytes(
  value: Fixture,
  lease: CrawlerJobLease,
  storedAt: Date,
): Promise<WrittenCrawlerDownload> {
  const stored = await streamAuthorizedPdfToLocalQuarantine({
    body: new Response(PDF_BYTES).body!,
    configuration: {
      quarantineRoot: value.quarantineRoot,
      maxUploadBytes: MAX_BYTES,
      streamIdleTimeoutMs: 5_000,
      streamAbsoluteTimeoutMs: 30_000,
    },
    organizationId: lease.organizationId,
    assetId: lease.assetId,
    attemptId: lease.ingressAttemptId,
    expectedSizeBytes: BigInt(PDF_BYTES.byteLength),
    expectedStorageAuthorityGeneration: lease.storageAuthorityGeneration,
  });
  assert.equal(stored.storageKey, lease.storageKey);
  return writtenCrawlerDownloadFromStorage(
    stored,
    storedAt,
    fetchReceipt(lease, storedAt),
  );
}

async function assertQuarantineObjectExists(
  value: Fixture,
  lease: CrawlerJobLease,
  written: WrittenCrawlerDownload,
): Promise<void> {
  await withOpenLocalQuarantineObject(
    { quarantineRoot: value.quarantineRoot },
    written.storageKey,
    { organizationId: lease.organizationId, assetId: lease.assetId },
    async (object) => {
      assert.equal(object.sizeBytes, BigInt(PDF_BYTES.byteLength));
      const bytes = new Uint8Array(PDF_BYTES.byteLength);
      const read = await object.handle.read(bytes, 0, bytes.byteLength, 0);
      assert.equal(read.bytesRead, PDF_BYTES.byteLength);
      assert.deepEqual(bytes, PDF_BYTES);
    },
  );
}

async function cleanup(value: Fixture): Promise<void> {
  const organizationId = value.organizationId;
  try {
    await prisma.$transaction(async (transaction) => {
      await transaction.auditEvent.deleteMany({ where: { organizationId } });
      await transaction.provenanceRecord.deleteMany({ where: { organizationId } });
      await transaction.idempotencyRecord.deleteMany({ where: { organizationId } });
      await transaction.job.deleteMany({
        where: { organizationId, type: { not: "CRAWL" } },
      });
      await transaction.documentIngestReceipt.deleteMany({ where: { organizationId } });
      await transaction.documentIngressAttempt.deleteMany({ where: { organizationId } });
      await transaction.jobAttempt.deleteMany({ where: { organizationId } });
      await transaction.crawlerImport.deleteMany({ where: { organizationId } });
      await transaction.job.deleteMany({ where: { organizationId } });
      await transaction.documentIntake.deleteMany({ where: { organizationId } });
      await transaction.documentAsset.deleteMany({ where: { organizationId } });
      await transaction.inboxEntry.deleteMany({ where: { organizationId } });
      await transaction.importBatch.deleteMany({ where: { organizationId } });
      await transaction.asset.deleteMany({ where: { organizationId } });
      await transaction.document.deleteMany({ where: { organizationId } });
      await transaction.member.deleteMany({ where: { organizationId } });
      await transaction.retainedAuditPrincipal.deleteMany({ where: { organizationId } });
      await transaction.organization.deleteMany({ where: { id: organizationId } });
    });
    await prisma.user.deleteMany({ where: { id: value.userId } });
  } finally {
    const relative = path.relative(process.cwd(), value.quarantineRoot);
    if (
      relative.startsWith(".paperpilot-crawler-it-")
      && !relative.includes(path.sep)
      && !path.isAbsolute(relative)
    ) {
      await rm(value.quarantineRoot, { recursive: true, force: true });
    } else {
      throw new Error("Refusing to remove an unexpected crawler test directory.");
    }
  }
}

after(async () => {
  await prisma.$disconnect();
});

test("crawler claim is fenced and successful adoption creates one attempt-bound receipt and validation job", async () => {
  const value = await fixture("success");
  try {
    const target = await queue(value);
    const claimAt = addMilliseconds(target.runAfter, 1_000);
    const lease = await claimNextCrawlerJob({
      workerId: "crawler-integration-success",
      configuration: { quarantineRoot: value.quarantineRoot },
      leaseTtlMs: LEASE_TTL_MS,
      now: claimAt,
    });
    assert.ok(lease);
    assert.equal(lease.crawlerImportId, target.crawlerImportId);
    assert.equal(lease.attemptNumber, 1);

    const [claimedImport, claimedIntake, crawlJob, jobAttempt, ingressAttempt] =
      await Promise.all([
        prisma.crawlerImport.findUniqueOrThrow({ where: { id: target.crawlerImportId } }),
        prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
        prisma.job.findUniqueOrThrow({ where: { id: target.jobId } }),
        prisma.jobAttempt.findUniqueOrThrow({ where: { id: lease.jobAttemptId } }),
        prisma.documentIngressAttempt.findUniqueOrThrow({
          where: { id: lease.ingressAttemptId },
        }),
      ]);
    assert.equal(claimedImport.status, "FETCHING");
    assert.equal(claimedIntake.status, "RECEIVING");
    assert.equal(crawlJob.status, "RUNNING");
    assert.deepEqual(crawlJob.payload, {
      schemaVersion: 1,
      crawlerImportId: target.crawlerImportId,
    });
    assert.deepEqual(Object.keys(crawlJob.payload as object).sort(), [
      "crawlerImportId",
      "schemaVersion",
    ]);
    assert.equal(JSON.stringify(crawlJob.payload).includes(value.sourceUrl), false);
    assert.equal(jobAttempt.status, "RUNNING");
    assert.equal(jobAttempt.leaseId, lease.leaseId);
    assert.equal(ingressAttempt.status, "RECEIVING");
    assert.equal(ingressAttempt.jobAttemptId, lease.jobAttemptId);
    assert.equal(ingressAttempt.leaseId, lease.leaseId);
    assert.equal(ingressAttempt.storageKey, lease.storageKey);

    const heartbeatAt = addMilliseconds(claimAt, 1_000);
    assert.equal(await heartbeatCrawlerJob({
      lease,
      leaseTtlMs: LEASE_TTL_MS,
      now: heartbeatAt,
    }), true);

    const storedAt = addMilliseconds(claimAt, 2_000);
    const written = await writeQuarantineBytes(value, lease, storedAt);
    await assertQuarantineObjectExists(value, lease, written);

    const staleLease = { ...lease, leaseId: randomUUID() };
    const beforeStaleMutation = await prisma.documentIngressAttempt.findUniqueOrThrow({
      where: { id: lease.ingressAttemptId },
    });
    assert.equal(await heartbeatCrawlerJob({
      lease: staleLease,
      leaseTtlMs: LEASE_TTL_MS,
      now: addMilliseconds(claimAt, 3_000),
    }), false);
    assert.equal(await markCrawlerIngressWritten({
      lease: staleLease,
      written,
      now: addMilliseconds(claimAt, 3_000),
    }), false);
    assert.equal(await completeCrawlerJob({
      lease: staleLease,
      written,
      now: addMilliseconds(claimAt, 3_000),
    }), "lease-lost");
    assert.deepEqual(
      await prisma.documentIngressAttempt.findUniqueOrThrow({
        where: { id: lease.ingressAttemptId },
      }),
      beforeStaleMutation,
    );

    assert.equal(await markCrawlerIngressWritten({
      lease,
      written,
      now: addMilliseconds(claimAt, 3_000),
    }), true);
    assert.equal(await completeCrawlerJob({
      lease,
      written,
      now: addMilliseconds(claimAt, 4_000),
    }), "applied");

    const [storedImport, intake, asset, job, adoptedAttempt, receipt, validationJobs] =
      await Promise.all([
        prisma.crawlerImport.findUniqueOrThrow({ where: { id: target.crawlerImportId } }),
        prisma.documentIntake.findUniqueOrThrow({ where: { id: target.intakeId } }),
        prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
        prisma.job.findUniqueOrThrow({ where: { id: target.jobId } }),
        prisma.documentIngressAttempt.findUniqueOrThrow({
          where: { id: lease.ingressAttemptId },
        }),
        prisma.documentIngestReceipt.findFirstOrThrow({
          where: {
            organizationId: value.organizationId,
            crawlerImportId: target.crawlerImportId,
          },
        }),
        prisma.job.findMany({
          where: {
            organizationId: value.organizationId,
            type: "DOCUMENT_VALIDATE",
          },
        }),
      ]);
    assert.equal(storedImport.status, "QUARANTINED");
    assert.equal(intake.status, "QUARANTINED");
    assert.equal(intake.committedBytes, BigInt(PDF_BYTES.byteLength));
    assert.equal(asset.status, "QUARANTINED");
    assert.equal(asset.objectKey, lease.storageKey);
    assert.equal(job.status, "SUCCEEDED");
    assert.equal(adoptedAttempt.status, "ADOPTED");
    assert.equal(receipt.sourceFingerprint, `crawler-import:${target.crawlerImportId}`);
    assert.equal(receipt.ingressAttemptId, lease.ingressAttemptId);
    assert.equal(receipt.importBatchId, target.importBatchId);
    assert.equal(receipt.receivedSizeBytes, BigInt(PDF_BYTES.byteLength));
    assert.equal(validationJobs.length, 1);
    assert.equal(validationJobs[0].status, "QUEUED");
    assert.equal(validationJobs[0].ingestReceiptId, receipt.id);
    assert.equal(validationJobs[0].documentId, target.documentId);
    assert.equal(validationJobs[0].assetId, target.assetId);
    assert.equal(validationJobs[0].intakeId, target.intakeId);

    const bootstrap = await workspaceBootstrap(
      { id: value.userId, name: "Crawler integration user" },
      null,
      value.organizationId,
    );
    const crawlerInboxEntry = bootstrap.inboxEntries.find(
      (entry) => entry.id === target.inboxEntryId,
    );
    assert.ok(crawlerInboxEntry?.entryKind === "crawler-document");
    assert.equal(crawlerInboxEntry.crawler.id, target.crawlerImportId);
    assert.equal(crawlerInboxEntry.crawler.documentId, target.documentId);
    assert.equal(crawlerInboxEntry.crawler.stage, "quarantined");
    assert.equal(crawlerInboxEntry.crawler.fileName, "governed-paper.pdf");
    const serializedInboxEntry = JSON.stringify(crawlerInboxEntry);
    assert.equal(serializedInboxEntry.includes(value.sourceUrl), false);
    assert.equal(serializedInboxEntry.includes(written.storageKey), false);
    assert.equal(serializedInboxEntry.includes(written.sha256), false);
    assert.equal(serializedInboxEntry.includes(lease.workerId), false);

    await assert.rejects(
      prisma.crawlerImport.update({
        where: { id: target.crawlerImportId },
        data: { canonicalSourceUrl: "https://example.com/repurposed.pdf" },
      }),
    );
    assert.equal(
      (await prisma.crawlerImport.findUniqueOrThrow({
        where: { id: target.crawlerImportId },
      })).canonicalSourceUrl,
      value.sourceUrl,
    );
  } finally {
    await cleanup(value);
  }
});

test("retryable crawler failure is cleanup-gated, preserves its failed attempt, and later reclaims exactly on runAfter", async () => {
  const value = await fixture("retry");
  try {
    const target = await queue(value);
    const claimAt = addMilliseconds(target.runAfter, 1_000);
    const firstLease = await claimNextCrawlerJob({
      workerId: "crawler-integration-retry-one",
      configuration: { quarantineRoot: value.quarantineRoot },
      leaseTtlMs: LEASE_TTL_MS,
      now: claimAt,
    });
    assert.ok(firstLease);
    const written = await writeQuarantineBytes(
      value,
      firstLease,
      addMilliseconds(claimAt, 1_000),
    );
    assert.equal(await markCrawlerIngressWritten({
      lease: firstLease,
      written,
      now: addMilliseconds(claimAt, 2_000),
    }), true);

    const failedAt = addMilliseconds(claimAt, 3_000);
    const retryAt = addMilliseconds(claimAt, 20_000);
    assert.deepEqual(await failCrawlerJob({
      lease: firstLease,
      failure: {
        code: "crawler_timeout",
        retryable: true,
        retryAt,
      },
      now: failedAt,
    }), {
      outcome: "cleanup-required",
      ingressAttemptId: firstLease.ingressAttemptId,
      terminal: false,
      retryAt,
    });

    const [retryingImport, retryingJob, failedJobAttempt, failedIngressAttempt] =
      await Promise.all([
        prisma.crawlerImport.findUniqueOrThrow({ where: { id: target.crawlerImportId } }),
        prisma.job.findUniqueOrThrow({ where: { id: target.jobId } }),
        prisma.jobAttempt.findUniqueOrThrow({ where: { id: firstLease.jobAttemptId } }),
        prisma.documentIngressAttempt.findUniqueOrThrow({
          where: { id: firstLease.ingressAttemptId },
        }),
      ]);
    assert.equal(retryingImport.status, "FETCHING");
    assert.equal(retryingImport.retryAt?.getTime(), retryAt.getTime());
    assert.equal(retryingJob.status, "RETRYING");
    assert.equal(retryingJob.runAfter.getTime(), retryAt.getTime());
    assert.equal(failedJobAttempt.status, "FAILED");
    assert.equal(failedJobAttempt.errorCode, "crawler_timeout");
    assert.equal(failedIngressAttempt.status, "FAILED");
    assert.equal(failedIngressAttempt.cleanupCompletedAt, null);
    assert.equal(await claimNextCrawlerJob({
      workerId: "crawler-integration-too-early",
      configuration: { quarantineRoot: value.quarantineRoot },
      leaseTtlMs: LEASE_TTL_MS,
      now: retryAt,
    }), null);

    assert.deepEqual(await reconcileCrawlerJobCleanup({
      configuration: { quarantineRoot: value.quarantineRoot },
      ingressAttemptId: firstLease.ingressAttemptId,
      now: addMilliseconds(failedAt, 1_000),
    }), {
      outcome: "cleaned",
      jobId: target.jobId,
      ingressAttemptId: firstLease.ingressAttemptId,
    });
    await assert.rejects(
      withOpenLocalQuarantineObject(
        { quarantineRoot: value.quarantineRoot },
        written.storageKey,
        { organizationId: firstLease.organizationId, assetId: firstLease.assetId },
        async () => undefined,
      ),
    );
    assert.equal(await claimNextCrawlerJob({
      workerId: "crawler-integration-before-run-after",
      configuration: { quarantineRoot: value.quarantineRoot },
      leaseTtlMs: LEASE_TTL_MS,
      now: addMilliseconds(retryAt, -1),
    }), null);

    const secondLease = await claimNextCrawlerJob({
      workerId: "crawler-integration-retry-two",
      configuration: { quarantineRoot: value.quarantineRoot },
      leaseTtlMs: LEASE_TTL_MS,
      now: retryAt,
    });
    assert.ok(secondLease);
    assert.equal(secondLease.crawlerImportId, target.crawlerImportId);
    assert.equal(secondLease.attemptNumber, 2);
    assert.notEqual(secondLease.leaseId, firstLease.leaseId);
    assert.notEqual(secondLease.jobAttemptId, firstLease.jobAttemptId);
    assert.notEqual(secondLease.ingressAttemptId, firstLease.ingressAttemptId);
    assert.notEqual(secondLease.storageKey, firstLease.storageKey);

    assert.equal(await heartbeatCrawlerJob({
      lease: firstLease,
      leaseTtlMs: LEASE_TTL_MS,
      now: addMilliseconds(retryAt, 1_000),
    }), false);
    assert.equal(await markCrawlerIngressWritten({
      lease: firstLease,
      written,
      now: addMilliseconds(retryAt, 1_000),
    }), false);
    assert.equal(await completeCrawlerJob({
      lease: firstLease,
      written,
      now: addMilliseconds(retryAt, 1_000),
    }), "lease-lost");

    const [preservedJobAttempt, preservedIngressAttempt, runningJobAttempt, receivingAttempt] =
      await Promise.all([
        prisma.jobAttempt.findUniqueOrThrow({ where: { id: firstLease.jobAttemptId } }),
        prisma.documentIngressAttempt.findUniqueOrThrow({
          where: { id: firstLease.ingressAttemptId },
        }),
        prisma.jobAttempt.findUniqueOrThrow({ where: { id: secondLease.jobAttemptId } }),
        prisma.documentIngressAttempt.findUniqueOrThrow({
          where: { id: secondLease.ingressAttemptId },
        }),
      ]);
    assert.equal(preservedJobAttempt.status, "FAILED");
    assert.equal(preservedJobAttempt.errorCode, "crawler_timeout");
    assert.equal(preservedJobAttempt.completedAt?.getTime(), failedAt.getTime());
    assert.equal(preservedIngressAttempt.status, "FAILED");
    assert.ok(preservedIngressAttempt.cleanupCompletedAt);
    assert.equal(preservedIngressAttempt.cleanupFailureCode, null);
    assert.equal(runningJobAttempt.status, "RUNNING");
    assert.equal(runningJobAttempt.attemptNumber, 2);
    assert.equal(receivingAttempt.status, "RECEIVING");
    assert.equal(receivingAttempt.attemptNumber, 2);
  } finally {
    await cleanup(value);
  }
});
