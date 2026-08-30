import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import {
  CRAWLER_ACQUISITION_MODE_V1,
  CRAWLER_RETENTION_MODE_V1,
  CRAWLER_RIGHTS_ATTESTATION_V1,
  CRAWLER_ROBOTS_MODE_V1,
  type CrawlerAcquisitionCommandV1,
} from "@/server/integrations/web-source/crawler-command";
import { crawlerConfigurationFromEnvironment } from "@/server/integrations/web-source/crawler-config";
import {
  listCrawlerRequests,
  queueCrawlerRequest,
} from "@/server/integrations/web-source/crawler-service";

after(async () => {
  await prisma.$disconnect();
});

const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_WORKSPACE_BYTES = 8 * 1_024 * 1_024;
const ADMISSION_TIME = new Date("2030-01-02T03:04:05.678Z");

const crawler = crawlerConfigurationFromEnvironment(
  { maxUploadBytes: MAX_RESPONSE_BYTES },
  {
    PAPERPILOT_CRAWLER_POLICY_VERSION: "crawler-integration-v1",
    PAPERPILOT_CRAWLER_RATE_POLICY_VERSION: "crawler-rate-integration-v1",
    PAPERPILOT_CRAWLER_ROBOTS_USER_AGENT: "PaperPilotCrawler",
    PAPERPILOT_CRAWLER_WORKER_IDENTITY: "crawler-integration-worker",
  },
);

const dependencies = {
  crawler,
  maxRetainedBytesPerWorkspace: MAX_WORKSPACE_BYTES,
};

const serviceDependencies = {
  configuration: dependencies,
  // A deliberately future application override proves the database stores
  // one exact authority timestamp for both attestation and row chronology.
  now: () => new Date(ADMISSION_TIME),
};

function command(
  operationId: string,
  expectedVersion: number,
  sourceUrl: string,
): CrawlerAcquisitionCommandV1 {
  return {
    schemaVersion: 1,
    clientOperationId: operationId,
    expectedVersion,
    policyVersion: crawler.policyVersion,
    sourceUrl,
    displayFileName: "Governed evidence.pdf",
    rightsAttestation: {
      scope: CRAWLER_RIGHTS_ATTESTATION_V1,
      userDeclared: true,
    },
    robotsMode: CRAWLER_ROBOTS_MODE_V1,
    retentionMode: CRAWLER_RETENTION_MODE_V1,
    maxBytes: MAX_RESPONSE_BYTES,
  };
}

test("governed crawler queue is tenant-bound, replay-safe, private, and quarantine-first", async () => {
  const suffix = randomUUID();
  const ownerId = `crawler-owner-${suffix}`;
  const viewerId = `crawler-viewer-${suffix}`;
  const outsiderId = `crawler-outsider-${suffix}`;
  const workspaceId = `crawler-workspace-${suffix}`;
  const sourceUrl = `https://papers.example.org/research/${suffix}.pdf`;
  const operationId = `crawler-operation-${suffix}`;

  await prisma.user.createMany({
    data: [
      {
        id: ownerId,
        name: "Crawler Owner",
        email: `crawler-owner-${suffix}@example.test`,
        emailVerified: true,
      },
      {
        id: viewerId,
        name: "Crawler Viewer",
        email: `crawler-viewer-${suffix}@example.test`,
        emailVerified: true,
      },
      {
        id: outsiderId,
        name: "Crawler Outsider",
        email: `crawler-outsider-${suffix}@example.test`,
        emailVerified: true,
      },
    ],
  });
  await prisma.organization.create({
    data: {
      id: workspaceId,
      name: "Crawler integration",
      slug: `crawler-${suffix}`,
    },
  });
  await prisma.member.createMany({
    data: [
      { organizationId: workspaceId, userId: ownerId, role: "owner" },
      { organizationId: workspaceId, userId: viewerId, role: "viewer" },
    ],
  });

  try {
    const queued = await queueCrawlerRequest(
      {
        userId: ownerId,
        workspaceId,
        command: command(operationId, 0, sourceUrl),
        requestId: `request-${suffix}`,
      },
      serviceDependencies,
    );
    assert.equal(queued.outcome, "applied");
    assert.equal(queued.aggregateVersion, 1);
    assert.equal(queued.request.status, "QUEUED");
    assert.equal(queued.request.policyVersion, crawler.policyVersion);
    assert.equal(queued.request.maxBytes, MAX_RESPONSE_BYTES);
    assert.equal(queued.request.receivedBytes, null);
    assert.equal(queued.request.failureCode, null);

    const stored = await prisma.crawlerImport.findUniqueOrThrow({
      where: {
        organizationId_clientOperationId: {
          organizationId: workspaceId,
          clientOperationId: operationId,
        },
      },
      include: {
        intake: { include: { document: true, asset: true } },
        inboxEntry: true,
        crawlJob: true,
      },
    });
    assert.equal(stored.canonicalSourceUrl, sourceUrl);
    assert.match(stored.sourceUrlFingerprint, /^[a-f0-9]{64}$/);
    assert.match(stored.requestHash, /^[a-f0-9]{64}$/);
    assert.equal(stored.rightsGrant, "INDEFINITE_RESEARCH_CUSTODY");
    assert.equal(stored.rightsAttestationVersion, "paperpilot-crawler-rights-v1");
    assert.equal(stored.rightsAttestedAt.toISOString(), ADMISSION_TIME.toISOString());
    assert.equal(stored.createdAt.toISOString(), ADMISSION_TIME.toISOString());
    assert.equal(stored.updatedAt.toISOString(), ADMISSION_TIME.toISOString());
    assert.equal(stored.robotsPolicy, "RESPECT_RFC9309");
    assert.equal(stored.retentionPolicy, "INDEFINITE_UNTIL_USER_DELETION");
    assert.equal(stored.acquisitionMode, CRAWLER_ACQUISITION_MODE_V1);
    assert.equal(stored.policyVersion, crawler.policyVersion);
    assert.equal(stored.robotsUserAgent, crawler.robotsUserAgent);
    assert.equal(stored.ratePolicyVersion, crawler.ratePolicyVersion);
    assert.equal(stored.originRequestsPerMinute, crawler.originRequestsPerMinute);
    assert.equal(stored.originBurst, crawler.originBurst);
    assert.equal(stored.maximumSizeBytes, BigInt(MAX_RESPONSE_BYTES));
    assert.equal(stored.intake.source, "CRAWLER");
    assert.equal(stored.intake.status, "QUEUED");
    assert.equal(stored.intake.reservedBytes, BigInt(MAX_RESPONSE_BYTES));
    assert.equal(stored.intake.importBatchId, stored.inboxEntry.importBatchId);
    assert.equal(stored.importBatchId, stored.intake.importBatchId);
    assert.ok(stored.intake.importBatchId);
    assert.equal(stored.intake.document?.status, "PENDING");
    assert.equal(stored.intake.document?.sourceUri, sourceUrl);
    assert.equal(
      stored.intake.document?.sourceFingerprint,
      `crawler-import:${stored.id}`,
    );
    assert.equal(stored.intake.asset.status, "UPLOADING");
    assert.equal(stored.intake.asset.sizeBytes, null);
    assert.equal(stored.intake.asset.sha256, null);
    assert.equal(stored.inboxEntry.status, "NEEDS_REVIEW");
    assert.equal(stored.inboxEntry.source, "CRAWLER");
    assert.equal(stored.inboxEntry.sourceKey, `crawler-import:${stored.id}`);
    assert.equal(stored.inboxEntry.dedupeKey, `crawler-import:${stored.id}`);
    assert.equal(stored.crawlJob.type, "CRAWL");
    assert.equal(stored.crawlJob.status, "QUEUED");
    assert.deepEqual(stored.crawlJob.payload, {
      schemaVersion: 1,
      crawlerImportId: stored.id,
    });
    assert.equal(
      JSON.stringify(stored.crawlJob.payload).includes(sourceUrl),
      false,
      "durable job payload must never retain the source URL",
    );

    const batch = await prisma.importBatch.findUniqueOrThrow({
      where: { id: stored.intake.importBatchId ?? "missing" },
    });
    assert.equal(batch.organizationId, workspaceId);
    assert.equal(batch.source, "CRAWLER");
    assert.equal(batch.status, "RUNNING");
    assert.equal(batch.totalCount, 1);
    assert.equal(batch.externalRequestId, stored.id);

    const replayed = await queueCrawlerRequest(
      {
        userId: ownerId,
        workspaceId,
        command: command(operationId, 0, sourceUrl),
      },
      { configuration: dependencies },
    );
    assert.equal(replayed.outcome, "replayed");
    assert.equal(replayed.aggregateVersion, 1);
    assert.equal(replayed.request.id, stored.id);
    assert.equal(await prisma.crawlerImport.count({ where: { organizationId: workspaceId } }), 1);
    assert.equal(await prisma.job.count({ where: { organizationId: workspaceId, type: "CRAWL" } }), 1);

    const rolledCrawler = crawlerConfigurationFromEnvironment(
      { maxUploadBytes: MAX_RESPONSE_BYTES / 2 },
      {
        PAPERPILOT_CRAWLER_POLICY_VERSION: "crawler-integration-v2",
        PAPERPILOT_CRAWLER_RATE_POLICY_VERSION: "crawler-rate-integration-v2",
        PAPERPILOT_CRAWLER_ROBOTS_USER_AGENT: "PaperPilotCrawler",
        PAPERPILOT_CRAWLER_WORKER_IDENTITY: "crawler-integration-worker-v2",
      },
    );
    const replayedAfterPolicyRollout = await queueCrawlerRequest(
      {
        userId: ownerId,
        workspaceId,
        command: command(operationId, 0, sourceUrl),
      },
      {
        configuration: {
          crawler: rolledCrawler,
          maxRetainedBytesPerWorkspace: MAX_WORKSPACE_BYTES,
        },
      },
    );
    assert.equal(replayedAfterPolicyRollout.outcome, "replayed");
    assert.equal(replayedAfterPolicyRollout.request.id, stored.id);
    assert.equal(
      replayedAfterPolicyRollout.request.policyVersion,
      crawler.policyVersion,
      "a replay reports its frozen admitted policy, not the deployment's new policy",
    );

    await assert.rejects(
      queueCrawlerRequest(
        {
          userId: ownerId,
          workspaceId,
          command: {
            ...command(operationId, 0, sourceUrl),
            displayFileName: "Changed intent.pdf",
          },
        },
        { configuration: dependencies },
      ),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 409
        && error.code === "idempotency_conflict",
    );

    await assert.rejects(
      queueCrawlerRequest(
        {
          userId: ownerId,
          workspaceId,
          command: command(`crawler-duplicate-${suffix}`, 1, sourceUrl),
        },
        { configuration: dependencies },
      ),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 409
        && error.code === "crawler_source_already_active",
    );

    await assert.rejects(
      queueCrawlerRequest(
        {
          userId: ownerId,
          workspaceId,
          command: command(
            `crawler-stale-${suffix}`,
            0,
            `https://papers.example.org/research/stale-${suffix}.pdf`,
          ),
        },
        { configuration: dependencies },
      ),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 409
        && error.code === "version_conflict",
    );

    await assert.rejects(
      queueCrawlerRequest(
        {
          userId: viewerId,
          workspaceId,
          command: command(
            `crawler-viewer-${suffix}`,
            1,
            `https://papers.example.org/research/viewer-${suffix}.pdf`,
          ),
        },
        { configuration: dependencies },
      ),
      (error: unknown) => error instanceof HttpProblem && error.status === 403,
    );

    const viewerList = await listCrawlerRequests(
      { userId: viewerId, workspaceId },
      { configuration: dependencies },
    );
    assert.equal(viewerList.schemaVersion, 1);
    assert.equal(viewerList.requests.length, 1);
    assert.equal(viewerList.requests[0].id, stored.id);
    const publicJson = JSON.stringify(viewerList);
    assert.equal(publicJson.includes(sourceUrl), false);
    assert.equal(publicJson.includes(stored.sourceUrlFingerprint), false);
    assert.equal(publicJson.includes(stored.requestHash), false);
    assert.equal(publicJson.includes(stored.intakeId), false);
    assert.equal(publicJson.includes(stored.documentId), false);
    assert.equal(publicJson.includes(stored.assetId), false);
    assert.equal(publicJson.includes(stored.crawlJobId), false);

    await assert.rejects(
      listCrawlerRequests(
        { userId: outsiderId, workspaceId },
        { configuration: dependencies },
      ),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 404
        && error.code === "workspace_not_found",
    );

    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { revision: true },
    });
    assert.equal(organization.revision, 1);
    assert.equal(await prisma.retainedAuditPrincipal.count({
      where: { organizationId: workspaceId, liveUserId: ownerId },
    }), 1);
    assert.equal(await prisma.auditEvent.count({
      where: { organizationId: workspaceId, action: "crawler.import.queued" },
    }), 1);
    assert.equal(await prisma.provenanceRecord.count({
      where: { organizationId: workspaceId, sourceRecordId: stored.id },
    }), 1);
  } finally {
    await prisma.$transaction(async (transaction) => {
      await transaction.auditEvent.deleteMany({ where: { organizationId: workspaceId } });
      await transaction.provenanceRecord.deleteMany({ where: { organizationId: workspaceId } });
      // CrawlerImport deliberately retains its requester principal with a
      // restrictive compound FK. Remove the exact fixture authority before
      // tenant erasure; the remaining target graph is tenant-cascaded.
      await transaction.crawlerImport.deleteMany({ where: { organizationId: workspaceId } });
      await transaction.job.deleteMany({ where: { organizationId: workspaceId } });
      await transaction.documentIntake.deleteMany({ where: { organizationId: workspaceId } });
      await transaction.inboxEntry.deleteMany({ where: { organizationId: workspaceId } });
      await transaction.importBatch.deleteMany({ where: { organizationId: workspaceId } });
      await transaction.documentAsset.deleteMany({ where: { organizationId: workspaceId } });
      await transaction.document.deleteMany({ where: { organizationId: workspaceId } });
      await transaction.asset.deleteMany({ where: { organizationId: workspaceId } });
    });
    await prisma.retainedAuditPrincipal.deleteMany({ where: { organizationId: workspaceId } });
    await prisma.organization.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({
      where: { id: { in: [ownerId, viewerId, outsiderId] } },
    });
  }
});
