import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { linkValidatedDocumentToWorkspacePaper } from "@/server/documents/document-paper-link";
import { DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION } from "@/server/documents/extraction-config";
import type { DocumentTextExtractionAttestation } from "@/server/documents/extraction-contract";
import {
  claimNextDocumentTextExtractionJob,
  completeDocumentTextExtractionLease,
  type DocumentTextExtractionLease,
} from "@/server/documents/extraction-jobs";
import { getWorkspacePaperReader } from "@/server/documents/reader-service";
import {
  claimNextDocumentValidationJob,
  completeDocumentValidationLease,
  type DocumentValidationLease,
  type ValidatedDocumentAttestation,
} from "@/server/documents/validation-jobs";
import {
  CRAWLER_ACQUISITION_MODE_V1,
  CRAWLER_RETENTION_MODE_V1,
  CRAWLER_RIGHTS_ATTESTATION_V1,
  CRAWLER_ROBOTS_MODE_V1,
} from "@/server/integrations/web-source/crawler-command";
import type { CrawlerConfiguration } from "@/server/integrations/web-source/crawler-config";
import {
  deleteCrawlerCustody,
  reconcileCrawlerCustodyDeletion,
} from "@/server/integrations/web-source/crawler-custody-deletion";
import { HttpProblem } from "@/server/http/problem";
import {
  claimNextCrawlerJob,
  completeCrawlerJob,
  markCrawlerIngressWritten,
  writtenCrawlerDownloadFromStorage,
  type CrawlerJobLease,
  type WrittenCrawlerDownload,
} from "@/server/integrations/web-source/crawler-jobs";
import {
  listCrawlerRequests,
  queueCrawlerRequest,
} from "@/server/integrations/web-source/crawler-service";
import type { GovernedPdfFetchReceipt } from "@/server/integrations/web-source/governed-pdf-fetch";
import {
  localQuarantineStorageAuthority,
  streamAuthorizedPdfToLocalQuarantine,
  withOpenLocalQuarantineObject,
} from "@/server/uploads/storage";

const MAX_BYTES = 1_024;
const LEASE_TTL_MS = 60_000;
const EXTRACTION_TOOLCHAIN_DIGEST = "d".repeat(64);
const PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
);

const CRAWLER_CONFIGURATION = Object.freeze({
  acquisitionMode: CRAWLER_ACQUISITION_MODE_V1,
  policyVersion: "paperpilot-crawler-deletion-it-v1",
  robotsUserAgent: "PaperPilotCrawler",
  maxRedirects: 0,
  maxDnsAddresses: 8,
  dnsLookupTimeoutMs: 3_000,
  maxResponseBytes: MAX_BYTES,
  maxResponseHeaderBytes: 32 * 1_024,
  responseHeaderTimeoutMs: 5_000,
  responseIdleTimeoutMs: 10_000,
  absoluteDeadlineMs: 30_000,
  ratePolicyVersion: "paperpilot-crawler-origin-rate-v1",
  originRequestsPerMinute: 6,
  originBurst: 1,
  workerIdentity: "crawler-deletion-integration",
} satisfies CrawlerConfiguration);

interface Fixture {
  organizationId: string;
  ownerId: string;
  memberId: string;
  otherMemberId: string;
  viewerId: string;
  sourceUrl: string;
  quarantineRoot: string;
  paperIds: string[];
}

interface QueuedTarget {
  crawlerImportId: string;
  jobId: string;
  intakeId: string;
  documentId: string;
  assetId: string;
  inboxEntryId: string;
  importBatchId: string;
  createdAt: Date;
  runAfter: Date;
}

function addMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (key, candidate) => {
    void key;
    return typeof candidate === "bigint" ? candidate.toString() : candidate;
  });
}

async function assertDatabaseRejects(
  label: string,
  action: (database: Prisma.TransactionClient) => Promise<unknown>,
): Promise<void> {
  await assert.rejects(
    prisma.$transaction(async (transaction) => {
      // Prisma Dev's PGlite proxy treats a deferred constraint error emitted
      // by COMMIT as a fatal server error. Exercising the exact same deferred
      // trigger at the mutation statement keeps the assertion portable while
      // production PostgreSQL still validates the normal commit boundary.
      await transaction.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      return action(transaction);
    }),
    label,
  );
}

async function fixture(label: string): Promise<Fixture> {
  const suffix = randomUUID();
  const organizationId = `crawler-delete-workspace-${suffix}`;
  const ownerId = `crawler-delete-owner-${suffix}`;
  const memberId = `crawler-delete-member-${suffix}`;
  const otherMemberId = `crawler-delete-other-member-${suffix}`;
  const viewerId = `crawler-delete-viewer-${suffix}`;
  const quarantineRoot = await mkdtemp("E:\\paperpilot-crawler-delete-it-");
  await chmod(quarantineRoot, 0o700);
  await prisma.user.createMany({
    data: [
      { id: ownerId, name: "Crawler deletion owner", email: `${ownerId}@example.test` },
      { id: memberId, name: "Crawler deletion member", email: `${memberId}@example.test` },
      { id: otherMemberId, name: "Crawler deletion other member", email: `${otherMemberId}@example.test` },
      { id: viewerId, name: "Crawler deletion viewer", email: `${viewerId}@example.test` },
    ],
  });
  await prisma.organization.create({
    data: { id: organizationId, name: "Crawler deletion", slug: organizationId },
  });
  await prisma.member.createMany({
    data: [
      { organizationId, userId: ownerId, role: "owner" },
      { organizationId, userId: memberId, role: "member" },
      { organizationId, userId: otherMemberId, role: "member" },
      { organizationId, userId: viewerId, role: "viewer" },
    ],
  });
  return {
    organizationId,
    ownerId,
    memberId,
    otherMemberId,
    viewerId,
    sourceUrl: `https://papers.example.org/${label}-${suffix}.pdf`,
    quarantineRoot,
    paperIds: [],
  };
}

function serviceConfiguration() {
  return {
    crawler: CRAWLER_CONFIGURATION,
    maxRetainedBytesPerWorkspace: MAX_BYTES * 10,
  };
}

async function queue(value: Fixture, userId = value.ownerId): Promise<QueuedTarget> {
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: value.organizationId },
    select: { revision: true },
  });
  const queued = await queueCrawlerRequest({
    userId,
    workspaceId: value.organizationId,
    command: {
      schemaVersion: 1,
      clientOperationId: `crawler-operation-${randomUUID()}`,
      expectedVersion: organization.revision,
      policyVersion: CRAWLER_CONFIGURATION.policyVersion,
      sourceUrl: value.sourceUrl,
      displayFileName: "custody-evidence.pdf",
      rightsAttestation: {
        scope: CRAWLER_RIGHTS_ATTESTATION_V1,
        userDeclared: true,
      },
      robotsMode: CRAWLER_ROBOTS_MODE_V1,
      retentionMode: CRAWLER_RETENTION_MODE_V1,
      maxBytes: MAX_BYTES,
    },
  }, { configuration: serviceConfiguration() });
  const target = await prisma.crawlerImport.findUniqueOrThrow({
    where: { id: queued.request.id },
    include: { crawlJob: { select: { runAfter: true } } },
  });
  await prisma.job.update({
    where: { id: target.crawlJobId },
    data: { priority: 2_000_000_000 },
  });
  return {
    crawlerImportId: target.id,
    jobId: target.crawlJobId,
    intakeId: target.intakeId,
    documentId: target.documentId,
    assetId: target.assetId,
    inboxEntryId: target.inboxEntryId,
    importBatchId: target.importBatchId,
    createdAt: target.createdAt,
    runAfter: target.crawlJob.runAfter,
  };
}

function deletionCommand(target: QueuedTarget, operationId: string, expectedVersion: number) {
  return {
    schemaVersion: 1,
    clientOperationId: operationId,
    expectedVersion,
    crawlerImportId: target.crawlerImportId,
    confirmDeletion: true,
  };
}

function fetchReceipt(lease: CrawlerJobLease, retrievedAt: Date): GovernedPdfFetchReceipt {
  const digest = createHash("sha256")
    .update(lease.canonicalSourceUrl, "utf8")
    .digest("hex");
  return {
    schemaVersion: 1,
    requestedUrlSha256: digest,
    finalUrlSha256: digest,
    redirectChainSha256: createHash("sha256").update("no-redirect").digest("hex"),
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

async function writeBytes(
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
  return writtenCrawlerDownloadFromStorage(stored, storedAt, fetchReceipt(lease, storedAt));
}

function acceptedValidationAttestation(
  lease: DocumentValidationLease,
  at: Date,
): ValidatedDocumentAttestation {
  return {
    inputSha256: lease.inputSha256,
    inputSizeBytes: lease.inputSizeBytes,
    storageVersion: lease.storageVersion,
    policyVersion: lease.policyVersion,
    toolchainDigest: "b".repeat(64),
    verdict: "ACCEPTED",
    rejectionCode: null,
    malwareVerdict: "CLEAN",
    malwareEngine: "clamav",
    malwareEngineVersion: "1.4.2",
    signatureVersion: "20261231",
    signaturePublishedAt: addMilliseconds(at, -60_000),
    scannedAt: addMilliseconds(at, 100),
    pdfStructuralVerdict: "VALID",
    pdfEngine: "qpdf",
    pdfEngineVersion: "11.9.1",
    pdfVersion: "1.7",
    pageCount: 2,
    objectCount: 12,
    revisionCount: 1,
    checkedAt: addMilliseconds(at, 200),
    result: {
      schemaVersion: 1,
      detectionCount: 0,
      warningCount: 0,
      malwareDurationMs: 50,
      pdfDurationMs: 75,
      totalDurationMs: 125,
      completedAt: addMilliseconds(at, 300).toISOString(),
    },
  };
}

function extractedTextAttestation(
  lease: DocumentTextExtractionLease,
  at: Date,
): DocumentTextExtractionAttestation {
  const chunks = [
    { sequence: 0, pageNumber: 1, paragraphId: "p1-p1", text: "Deletion proof paragraph one." },
    { sequence: 1, pageNumber: 2, paragraphId: "p2-p1", text: "Deletion proof paragraph two." },
  ] as const;
  return {
    inputSha256: lease.inputSha256,
    inputSizeBytes: lease.inputSizeBytes,
    storageVersion: lease.storageVersion,
    policyVersion: lease.policyVersion,
    toolchainDigest: lease.toolchainDigest,
    verdict: "EXTRACTED",
    engine: "poppler",
    engineVersion: "25.06.0",
    pageCount: lease.expectedPageCount,
    chunkCount: chunks.length,
    textBytes: chunks.reduce(
      (total, chunk) => total + Buffer.byteLength(chunk.text, "utf8"),
      0,
    ),
    extractedAt: addMilliseconds(at, 100),
    completedAt: addMilliseconds(at, 200),
    durationMs: 80,
    totalDurationMs: 100,
    chunks,
  };
}

interface ReadyExtractedCrawler {
  ingressLease: CrawlerJobLease;
  extractionId: string;
  manifestSha256: string;
  chunks: Array<{
    id: string;
    sequence: number;
    text: string;
    contentHash: string;
  }>;
}

async function adoptAndExtractCrawler(
  value: Fixture,
  target: QueuedTarget,
  workerLabel: string,
): Promise<ReadyExtractedCrawler> {
  const crawlClaimAt = addMilliseconds(target.runAfter, 1_000);
  const ingressLease = await claimNextCrawlerJob({
    workerId: `${workerLabel}-crawler`,
    configuration: { quarantineRoot: value.quarantineRoot },
    leaseTtlMs: LEASE_TTL_MS,
    now: crawlClaimAt,
  });
  assert.ok(ingressLease);
  assert.equal(ingressLease.crawlerImportId, target.crawlerImportId);
  const storedAt = addMilliseconds(crawlClaimAt, 1_000);
  const written = await writeBytes(value, ingressLease, storedAt);
  assert.equal(await markCrawlerIngressWritten({
    lease: ingressLease,
    written,
    now: storedAt,
  }), true);
  assert.equal(await completeCrawlerJob({
    lease: ingressLease,
    written,
    now: addMilliseconds(storedAt, 1_000),
  }), "applied");

  const validationJob = await prisma.job.findFirstOrThrow({
    where: {
      organizationId: value.organizationId,
      documentId: target.documentId,
      assetId: target.assetId,
      type: "DOCUMENT_VALIDATE",
    },
  });
  await prisma.job.update({
    where: { id: validationJob.id },
    data: { priority: 2_000_000_000 },
  });
  const validationAt = addMilliseconds(validationJob.runAfter, 1_000);
  const validationLease = await claimNextDocumentValidationJob({
    workerId: `${workerLabel}-validation`,
    leaseTtlMs: LEASE_TTL_MS,
    now: validationAt,
  });
  assert.ok(validationLease);
  assert.equal(validationLease.documentId, target.documentId);
  assert.deepEqual(await completeDocumentValidationLease({
    lease: validationLease,
    attestation: acceptedValidationAttestation(validationLease, validationAt),
    extractionToolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
    now: addMilliseconds(validationAt, 1_000),
  }), { outcome: "applied", verdict: "ACCEPTED" });

  const extractionJob = await prisma.job.findFirstOrThrow({
    where: {
      organizationId: value.organizationId,
      documentId: target.documentId,
      assetId: target.assetId,
      type: "TEXT_EXTRACTION",
    },
  });
  await prisma.job.update({
    where: { id: extractionJob.id },
    data: { priority: 2_000_000_000 },
  });
  const extractionAt = addMilliseconds(extractionJob.runAfter, 1_000);
  const extractionLease = await claimNextDocumentTextExtractionJob({
    workerId: `${workerLabel}-extraction`,
    expectedPolicyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
    expectedToolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
    leaseTtlMs: LEASE_TTL_MS,
    now: extractionAt,
  });
  assert.ok(extractionLease);
  assert.equal(extractionLease.documentId, target.documentId);
  assert.equal((await completeDocumentTextExtractionLease({
    lease: extractionLease,
    attestation: extractedTextAttestation(extractionLease, extractionAt),
    now: addMilliseconds(extractionAt, 1_000),
  }))?.outcome, "applied");

  const extraction = await prisma.documentTextExtraction.findFirstOrThrow({
    where: {
      organizationId: value.organizationId,
      documentId: target.documentId,
    },
    include: {
      manifestAdmission: true,
      chunks: { orderBy: { sequence: "asc" } },
    },
  });
  assert.ok(extraction.manifestAdmission);
  assert.equal((await prisma.crawlerImport.findUniqueOrThrow({
    where: { id: target.crawlerImportId },
  })).status, "READY");
  return {
    ingressLease,
    extractionId: extraction.id,
    manifestSha256: extraction.manifestAdmission.manifestSha256,
    chunks: extraction.chunks.map((chunk) => ({
      id: chunk.id,
      sequence: chunk.sequence,
      text: chunk.text,
      contentHash: chunk.contentHash,
    })),
  };
}

async function retainFirstExtractedChunkForUserEvidence(
  value: Fixture,
  target: QueuedTarget,
  ready: ReadyExtractedCrawler,
): Promise<{ evidenceNoteId: string; paperId: string }> {
  const paper = await prisma.paper.create({
    data: { title: "Grounded crawler custody evidence" },
  });
  value.paperIds.push(paper.id);
  const workspacePaper = await prisma.workspacePaper.create({
    data: {
      organizationId: value.organizationId,
      paperId: paper.id,
      addedById: value.ownerId,
    },
  });
  const project = await prisma.project.create({
    data: {
      organizationId: value.organizationId,
      name: "Crawler custody evidence",
      slug: `crawler-custody-${randomUUID()}`,
      visibility: "PRIVATE",
      createdById: value.ownerId,
    },
  });
  await prisma.projectPaper.create({
    data: {
      organizationId: value.organizationId,
      projectId: project.id,
      workspacePaperId: workspacePaper.id,
      addedById: value.ownerId,
    },
  });
  const beforeLink = await prisma.organization.findUniqueOrThrow({
    where: { id: value.organizationId },
    select: { revision: true },
  });
  const link = await linkValidatedDocumentToWorkspacePaper(
    { id: value.ownerId, name: "Crawler deletion owner" },
    value.organizationId,
    target.documentId,
    {
      clientOperationId: `crawler-custody-link-${randomUUID()}`,
      expectedVersion: beforeLink.revision,
      paperId: paper.id,
    },
  );
  if (!link.ok) throw new Error(link.message);
  assert.equal(link.ok, true);

  const chunk = ready.chunks[0];
  const note = await prisma.evidenceNote.create({
    data: {
      organizationId: value.organizationId,
      workspacePaperId: workspacePaper.id,
      projectId: project.id,
      documentId: target.documentId,
      documentChunkId: chunk.id,
      createdById: value.ownerId,
      kind: "CLAIM",
      status: "CAPTURED",
      confidence: "HIGH",
      title: "Retained evidence-dependent excerpt",
      claim: "The retained source excerpt supports this claim.",
      evidence: chunk.text,
      interpretation: "Only the evidence-dependent generation should remain.",
      quote: chunk.text,
      text: "The retained source excerpt supports this claim.",
      groundingVersion: null,
    },
  });
  await prisma.projectEvidenceNote.create({
    data: {
      organizationId: value.organizationId,
      projectId: project.id,
      evidenceNoteId: note.id,
    },
  });
  return { evidenceNoteId: note.id, paperId: paper.id };
}

async function cleanup(value: Fixture): Promise<void> {
  try {
    await prisma.$transaction(async (transaction) => {
      const organizationId = value.organizationId;
      await transaction.auditEvent.deleteMany({ where: { organizationId } });
      await transaction.provenanceRecord.deleteMany({ where: { organizationId } });
      await transaction.idempotencyRecord.deleteMany({ where: { organizationId } });
      await transaction.collectionEvidenceNote.deleteMany({ where: { organizationId } });
      await transaction.projectEvidenceNote.deleteMany({ where: { organizationId } });
      await transaction.evidenceNote.deleteMany({ where: { organizationId } });
      // The crawler is already DELETE_PENDING/DELETED here, so the reviewed
      // derived-text retirement exception permits exact extraction teardown.
      await transaction.documentTextExtraction.deleteMany({ where: { organizationId } });
      await transaction.documentTextChunk.deleteMany({ where: { organizationId } });
      await transaction.documentValidationAttestation.deleteMany({ where: { organizationId } });
      // Remove downstream attempts/jobs while their immutable receipt binding
      // is still intact. This breaks Job -> receipt -> ingress-attempt -> Job
      // without mutating any admitted job authority.
      await transaction.jobAttempt.deleteMany({
        where: {
          organizationId,
          job: { type: { not: "CRAWL" } },
        },
      });
      await transaction.job.deleteMany({
        where: { organizationId, type: { not: "CRAWL" } },
      });
      await transaction.documentIngestReceipt.deleteMany({ where: { organizationId } });
      await transaction.documentIngressAttempt.deleteMany({ where: { organizationId } });
      await transaction.jobAttempt.deleteMany({
        where: { organizationId, job: { type: "CRAWL" } },
      });
      await transaction.crawlerImport.deleteMany({ where: { organizationId } });
      await transaction.job.deleteMany({ where: { organizationId, type: "CRAWL" } });
      await transaction.documentIntake.deleteMany({ where: { organizationId } });
      await transaction.documentAsset.deleteMany({ where: { organizationId } });
      await transaction.inboxEntry.deleteMany({ where: { organizationId } });
      await transaction.importBatch.deleteMany({ where: { organizationId } });
      await transaction.asset.deleteMany({ where: { organizationId } });
      await transaction.document.deleteMany({ where: { organizationId } });
      await transaction.retainedAuditPrincipal.deleteMany({ where: { organizationId } });
      await transaction.organization.deleteMany({ where: { id: organizationId } });
    });
    await prisma.user.deleteMany({
      where: {
        id: {
          in: [value.ownerId, value.memberId, value.otherMemberId, value.viewerId],
        },
      },
    });
    if (value.paperIds.length > 0) {
      await prisma.paper.deleteMany({ where: { id: { in: value.paperIds } } });
    }
  } finally {
    const root = path.parse(value.quarantineRoot).root;
    const relative = path.relative(root, value.quarantineRoot);
    if (
      root.toUpperCase() === "E:\\"
      && relative.startsWith("paperpilot-crawler-delete-it-")
      && !relative.includes(path.sep)
      && !path.isAbsolute(relative)
    ) {
      await rm(value.quarantineRoot, { recursive: true, force: true });
    } else {
      throw new Error("Refusing to remove an unexpected crawler deletion test directory.");
    }
  }
}

after(async () => {
  await prisma.$disconnect();
});

test("queued custody deletion is tenant/role bound, replay-safe, URL-free, and quota-gated until proof", async () => {
  const value = await fixture("queued");
  try {
    const target = await queue(value, value.memberId);
    const operationId = `crawler-delete-${randomUUID()}`;
    const deletionAt = addMilliseconds(target.createdAt, 1_000);

    const ownerList = await listCrawlerRequests(
      { userId: value.ownerId, workspaceId: value.organizationId },
      { configuration: serviceConfiguration() },
    );
    const memberList = await listCrawlerRequests(
      { userId: value.memberId, workspaceId: value.organizationId },
      { configuration: serviceConfiguration() },
    );
    const otherMemberList = await listCrawlerRequests(
      { userId: value.otherMemberId, workspaceId: value.organizationId },
      { configuration: serviceConfiguration() },
    );
    assert.equal(ownerList.requests[0].canDeleteCustody, true);
    assert.equal(memberList.requests[0].canDeleteCustody, true);
    assert.equal(otherMemberList.requests[0].canDeleteCustody, false);

    await assert.rejects(
      deleteCrawlerCustody({
        userId: value.viewerId,
        workspaceId: value.organizationId,
        crawlerImportId: target.crawlerImportId,
        command: deletionCommand(target, `viewer-delete-${randomUUID()}`, 1),
      }),
      (error: unknown) => (
        error instanceof HttpProblem
        && error.status === 403
        && error.code === "workspace_forbidden"
      ),
    );

    await assert.rejects(
      deleteCrawlerCustody({
        userId: value.otherMemberId,
        workspaceId: value.organizationId,
        crawlerImportId: target.crawlerImportId,
        command: deletionCommand(target, `other-member-delete-${randomUUID()}`, 1),
      }),
      (error: unknown) => (
        error instanceof HttpProblem
        && error.status === 403
        && error.code === "crawler_custody_delete_forbidden"
      ),
    );

    const applied = await deleteCrawlerCustody({
      userId: value.memberId,
      workspaceId: value.organizationId,
      crawlerImportId: target.crawlerImportId,
      command: deletionCommand(target, operationId, 1),
    }, { now: () => deletionAt });
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.aggregateVersion, 2);
    assert.equal(applied.request.status, "DELETING");
    assert.equal(applied.request.canDeleteCustody, false);

    const pending = await prisma.crawlerImport.findUniqueOrThrow({
      where: { id: target.crawlerImportId },
      include: { intake: true, crawlJob: true, inboxEntry: true },
    });
    const document = await prisma.document.findUniqueOrThrow({ where: { id: target.documentId } });
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } });
    const provenance = await prisma.provenanceRecord.findFirstOrThrow({
      where: { organizationId: value.organizationId, sourceRecordId: target.crawlerImportId },
    });
    assert.equal(pending.custodyStatus, "DELETE_PENDING");
    assert.equal(pending.canonicalSourceUrl, null);
    assert.equal(pending.crawlJob.status, "CANCELLED");
    assert.equal(pending.intake.quotaReleasedAt, null);
    assert.equal(document.status, "ARCHIVED");
    assert.equal(document.sourceUri, null);
    assert.equal(asset.status, "REJECTED");
    assert.equal(pending.inboxEntry.sourceUri, null);
    assert.equal(provenance.sourceUri, null);
    assert.equal(safeJson(pending).includes(value.sourceUrl), false);

    const listed = await listCrawlerRequests(
      { userId: value.viewerId, workspaceId: value.organizationId },
      { configuration: serviceConfiguration() },
    );
    assert.equal(listed.requests[0].status, "DELETING");
    assert.equal(listed.requests[0].canDeleteCustody, false);
    assert.equal(safeJson(listed).includes(value.sourceUrl), false);

    const reconciled = await reconcileCrawlerCustodyDeletion({
      configuration: { quarantineRoot: value.quarantineRoot },
      crawlerImportId: target.crawlerImportId,
      now: deletionAt,
    });
    assert.equal(reconciled.outcome, "deleted");
    const deleted = await prisma.crawlerImport.findUniqueOrThrow({
      where: { id: target.crawlerImportId },
      include: { intake: true },
    });
    assert.equal(deleted.custodyStatus, "DELETED");
    assert.match(deleted.deletionProofDigest ?? "", /^[0-9a-f]{64}$/);
    assert.ok(deleted.deletedAt);
    assert.ok(deleted.intake.quotaReleasedAt);
    assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } })).status, "DELETED");

    const replayed = await deleteCrawlerCustody({
      userId: value.memberId,
      workspaceId: value.organizationId,
      crawlerImportId: target.crawlerImportId,
      command: deletionCommand(target, operationId, 1),
    });
    assert.equal(replayed.outcome, "replayed");
    assert.equal(replayed.aggregateVersion, 2);
    assert.equal(replayed.request.status, "DELETED");
    assert.equal(replayed.request.receivedBytes, null);
    assert.equal(replayed.request.canDeleteCustody, false);

    const ownerTarget = await queue(value, value.memberId);
    const ownerDeletion = await deleteCrawlerCustody({
      userId: value.ownerId,
      workspaceId: value.organizationId,
      crawlerImportId: ownerTarget.crawlerImportId,
      command: deletionCommand(
        ownerTarget,
        `owner-delete-${randomUUID()}`,
        3,
      ),
    }, { now: () => addMilliseconds(ownerTarget.createdAt, 1_000) });
    assert.equal(ownerDeletion.outcome, "applied");
    assert.equal(ownerDeletion.aggregateVersion, 4);
    assert.equal(ownerDeletion.request.status, "DELETING");
    assert.equal(ownerDeletion.request.canDeleteCustody, false);
  } finally {
    await cleanup(value);
  }
});

test("deletion fences a written lease, retries failed storage cleanup, and prevents late adoption", async () => {
  const value = await fixture("fenced");
  let wrongRoot: string | null = null;
  try {
    const target = await queue(value);
    const claimAt = addMilliseconds(target.runAfter, 1_000);
    const lease = await claimNextCrawlerJob({
      workerId: "crawler-delete-fence-worker",
      configuration: { quarantineRoot: value.quarantineRoot },
      leaseTtlMs: LEASE_TTL_MS,
      now: claimAt,
    });
    assert.ok(lease);
    assert.equal(lease.crawlerImportId, target.crawlerImportId);
    const written = await writeBytes(value, lease, addMilliseconds(claimAt, 1_000));
    assert.equal(await markCrawlerIngressWritten({ lease, written, now: addMilliseconds(claimAt, 2_000) }), true);

    const operationId = `crawler-delete-${randomUUID()}`;
    const requestedAt = addMilliseconds(claimAt, 3_000);
    const applied = await deleteCrawlerCustody({
      userId: value.ownerId,
      workspaceId: value.organizationId,
      crawlerImportId: target.crawlerImportId,
      command: deletionCommand(target, operationId, 1),
    }, { now: () => requestedAt });
    assert.equal(applied.request.status, "DELETING");
    assert.equal(
      await completeCrawlerJob({ lease, written, now: addMilliseconds(requestedAt, 1_000) }),
      "lease-lost",
    );
    assert.equal((await prisma.documentIngestReceipt.count({
      where: { crawlerImportId: target.crawlerImportId },
    })), 0);

    const beforeLeaseExpiry = await reconcileCrawlerCustodyDeletion({
      configuration: { quarantineRoot: value.quarantineRoot },
      crawlerImportId: target.crawlerImportId,
      now: addMilliseconds(lease.leaseExpiresAt, -1),
    });
    assert.deepEqual(beforeLeaseExpiry, { outcome: "idle" });

    const firstAttemptAt = addMilliseconds(lease.leaseExpiresAt, 1);
    wrongRoot = await mkdtemp("E:\\paperpilot-crawler-delete-wrong-root-it-");
    await chmod(wrongRoot, 0o700);
    const wrongAuthority = await localQuarantineStorageAuthority({
      quarantineRoot: wrongRoot,
    });
    assert.notEqual(wrongAuthority.generation, lease.storageAuthorityGeneration);
    const failedCleanup = await reconcileCrawlerCustodyDeletion({
      configuration: { quarantineRoot: wrongRoot },
      crawlerImportId: target.crawlerImportId,
      now: firstAttemptAt,
    });
    assert.equal(failedCleanup.outcome, "retrying");
    const retrying = await prisma.crawlerImport.findUniqueOrThrow({
      where: { id: target.crawlerImportId },
      include: { intake: true },
    });
    assert.equal(retrying.custodyStatus, "DELETE_PENDING");
    assert.equal(retrying.deletionFailureCode, "crawler_custody_deletion_storage_unavailable");
    assert.equal(retrying.intake.quotaReleasedAt, null);
    assert.equal(retrying.deletionProofDigest, null);
    assert.equal(retrying.deletionStorageAuthorityGeneration, null);
    assert.equal(retrying.deletionTombstoneDigest, null);
    assert.ok(retrying.deletionAfter);
    const pendingAttempt = await prisma.documentIngressAttempt.findUniqueOrThrow({
      where: { id: lease.ingressAttemptId },
    });
    assert.equal(pendingAttempt.cleanupCompletedAt, null);
    await withOpenLocalQuarantineObject(
      { quarantineRoot: value.quarantineRoot },
      written.storageKey,
      { organizationId: value.organizationId, assetId: target.assetId },
      async () => undefined,
      lease.storageAuthorityGeneration,
    );

    const succeeded = await reconcileCrawlerCustodyDeletion({
      configuration: { quarantineRoot: value.quarantineRoot },
      crawlerImportId: target.crawlerImportId,
      now: addMilliseconds(retrying.deletionAfter!, 1),
    });
    assert.equal(succeeded.outcome, "deleted");
    await assert.rejects(
      withOpenLocalQuarantineObject(
        { quarantineRoot: value.quarantineRoot },
        written.storageKey,
        { organizationId: value.organizationId, assetId: target.assetId },
        async () => undefined,
      ),
    );
    const attempt = await prisma.documentIngressAttempt.findUniqueOrThrow({
      where: { id: lease.ingressAttemptId },
    });
    assert.equal(attempt.status, "ABANDONED");
    assert.ok(attempt.cleanupCompletedAt);
    const deleted = await prisma.crawlerImport.findUniqueOrThrow({
      where: { id: target.crawlerImportId },
      include: { intake: true },
    });
    assert.equal(deleted.custodyStatus, "DELETED");
    assert.equal(
      deleted.deletionStorageAuthorityGeneration,
      lease.storageAuthorityGeneration,
    );
    assert.match(deleted.deletionTombstoneDigest ?? "", /^[a-f0-9]{64}$/);
    assert.ok(deleted.intake.quotaReleasedAt);
  } finally {
    if (wrongRoot) {
      const root = path.parse(wrongRoot).root;
      const relative = path.relative(root, wrongRoot);
      if (
        root.toUpperCase() === "E:\\"
        && relative.startsWith("paperpilot-crawler-delete-wrong-root-it-")
        && !relative.includes(path.sep)
        && !path.isAbsolute(relative)
      ) await rm(wrongRoot, { recursive: true, force: true });
    }
    await cleanup(value);
  }
});

test("READY extracted crawler custody purges unreferenced full text and keeps immutable receipts", async () => {
  const value = await fixture("adopted");
  try {
    const target = await queue(value);
    const ready = await adoptAndExtractCrawler(value, target, "crawler-delete-ready");
    assert.equal(ready.chunks.length, 2);
    const receiptBefore = await prisma.documentIngestReceipt.findFirstOrThrow({
      where: { crawlerImportId: target.crawlerImportId },
    });

    const deletionAt = addMilliseconds(ready.ingressLease.leaseExpiresAt, 1_000);
    await deleteCrawlerCustody({
      userId: value.ownerId,
      workspaceId: value.organizationId,
      crawlerImportId: target.crawlerImportId,
      command: deletionCommand(target, `crawler-delete-${randomUUID()}`, 1),
    }, { now: () => deletionAt });

    const result = await reconcileCrawlerCustodyDeletion({
      configuration: { quarantineRoot: value.quarantineRoot },
      crawlerImportId: target.crawlerImportId,
      now: deletionAt,
    });
    assert.equal(result.outcome, "deleted");
    const receiptAfter = await prisma.documentIngestReceipt.findUniqueOrThrow({
      where: { id: receiptBefore.id },
    });
    assert.equal(receiptAfter.sha256, receiptBefore.sha256);
    assert.equal(receiptAfter.receivedSizeBytes, receiptBefore.receivedSizeBytes);
    assert.equal(receiptAfter.ingressAttemptId, ready.ingressLease.ingressAttemptId);
    assert.equal(await prisma.documentTextExtraction.count({
      where: { organizationId: value.organizationId, documentId: target.documentId },
    }), 0);
    assert.equal(await prisma.documentTextChunk.count({
      where: { organizationId: value.organizationId, documentId: target.documentId },
    }), 0);
    const deletedCrawler = await prisma.crawlerImport.findUniqueOrThrow({
      where: { id: target.crawlerImportId },
    });
    assert.equal(deletedCrawler.derivedTextDisposition, "PURGED");
    assert.equal(deletedCrawler.derivedTextPurgedChunkCount, ready.chunks.length);
    assert.equal(deletedCrawler.derivedTextRetainedChunkCount, 0);
    assert.equal(
      deletedCrawler.derivedTextDisposedAt?.toISOString(),
      deletedCrawler.deletedAt?.toISOString(),
    );
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } });
    assert.equal(asset.status, "DELETED");
    assert.equal(asset.physicalLocator, null);
    assert.equal(asset.sha256, null);
    const rawRows = [
      await prisma.crawlerImport.findUniqueOrThrow({ where: { id: target.crawlerImportId } }),
      await prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
      await prisma.inboxEntry.findUniqueOrThrow({ where: { id: target.inboxEntryId } }),
      await prisma.provenanceRecord.findMany({
        where: { organizationId: value.organizationId, sourceRecordId: target.crawlerImportId },
      }),
    ];
    assert.equal(safeJson(rawRows).includes(value.sourceUrl), false);
  } finally {
    await cleanup(value);
  }
});

test("FK-backed user evidence retains its supporting extraction while private PDF bytes are deleted", async () => {
  const value = await fixture("grounded");
  try {
    const target = await queue(value);
    const ready = await adoptAndExtractCrawler(value, target, "crawler-delete-grounded");
    const evidence = await retainFirstExtractedChunkForUserEvidence(value, target, ready);
    const revision = await prisma.organization.findUniqueOrThrow({
      where: { id: value.organizationId },
      select: { revision: true },
    });
    const deletionAt = addMilliseconds(ready.ingressLease.leaseExpiresAt, 1_000);
    const requested = await deleteCrawlerCustody({
      userId: value.ownerId,
      workspaceId: value.organizationId,
      crawlerImportId: target.crawlerImportId,
      command: deletionCommand(
        target,
        `crawler-grounded-delete-${randomUUID()}`,
        revision.revision,
      ),
    }, { now: () => deletionAt });
    assert.equal(requested.request.status, "DELETING");
    assert.equal((await prisma.document.findUniqueOrThrow({
      where: { id: target.documentId },
    })).status, "ARCHIVED");

    const reconciled = await reconcileCrawlerCustodyDeletion({
      configuration: { quarantineRoot: value.quarantineRoot },
      crawlerImportId: target.crawlerImportId,
      now: deletionAt,
    });
    assert.equal(reconciled.outcome, "deleted");

    const crawler = await prisma.crawlerImport.findUniqueOrThrow({
      where: { id: target.crawlerImportId },
    });
    assert.equal(crawler.derivedTextDisposition, "RETAINED_FOR_USER_EVIDENCE");
    assert.equal(crawler.derivedTextPurgedChunkCount, 0);
    assert.equal(crawler.derivedTextRetainedChunkCount, ready.chunks.length);
    assert.equal(await prisma.documentTextExtraction.count({
      where: { id: ready.extractionId },
    }), 1);
    assert.equal(await prisma.documentTextChunk.count({
      where: { extractionId: ready.extractionId },
    }), ready.chunks.length);
    assert.equal(await prisma.evidenceNote.count({
      where: { id: evidence.evidenceNoteId },
    }), 1);
    assert.equal(await prisma.evidenceTextAnchor.count({
      where: { organizationId: value.organizationId, documentId: target.documentId },
    }), 0);
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } });
    assert.equal(asset.status, "DELETED");
    assert.equal(asset.physicalLocator, null);
    assert.equal(asset.sha256, null);
    assert.ok((await prisma.documentIntake.findUniqueOrThrow({
      where: { id: target.intakeId },
    })).quotaReleasedAt);
    await assert.rejects(
      withOpenLocalQuarantineObject(
        { quarantineRoot: value.quarantineRoot },
        ready.ingressLease.storageKey,
        { organizationId: value.organizationId, assetId: target.assetId },
        async () => undefined,
      ),
    );
  } finally {
    await cleanup(value);
  }
});

test("DELETED crawler custody reciprocally rejects child proof reversal and new Reader authority", async () => {
  const value = await fixture("terminal-child-guards");
  try {
    const target = await queue(value);
    const ready = await adoptAndExtractCrawler(value, target, "crawler-delete-terminal-guards");
    const evidence = await retainFirstExtractedChunkForUserEvidence(value, target, ready);
    const revision = await prisma.organization.findUniqueOrThrow({
      where: { id: value.organizationId },
      select: { revision: true },
    });
    const deletionAt = addMilliseconds(ready.ingressLease.leaseExpiresAt, 1_000);
    await deleteCrawlerCustody({
      userId: value.ownerId,
      workspaceId: value.organizationId,
      crawlerImportId: target.crawlerImportId,
      command: deletionCommand(
        target,
        `crawler-terminal-guard-delete-${randomUUID()}`,
        revision.revision,
      ),
    }, { now: () => deletionAt });
    assert.equal((await reconcileCrawlerCustodyDeletion({
      configuration: { quarantineRoot: value.quarantineRoot },
      crawlerImportId: target.crawlerImportId,
      now: deletionAt,
    })).outcome, "deleted");

    const crawler = await prisma.crawlerImport.findUniqueOrThrow({
      where: { id: target.crawlerImportId },
    });
    const document = await prisma.document.findUniqueOrThrow({
      where: { id: target.documentId },
    });
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } });
    const documentAsset = await prisma.documentAsset.findFirstOrThrow({
      where: {
        organizationId: value.organizationId,
        documentId: target.documentId,
        assetId: target.assetId,
        role: "ORIGINAL",
      },
    });
    const inbox = await prisma.inboxEntry.findUniqueOrThrow({
      where: { id: target.inboxEntryId },
    });
    const provenance = await prisma.provenanceRecord.findFirstOrThrow({
      where: {
        organizationId: value.organizationId,
        kind: "CRAWL",
        sourceRecordId: target.crawlerImportId,
      },
    });
    const crawlJob = await prisma.job.findUniqueOrThrow({ where: { id: target.jobId } });
    const crawlAttempt = await prisma.jobAttempt.findFirstOrThrow({
      where: { organizationId: value.organizationId, jobId: target.jobId },
    });
    const ingressAttempt = await prisma.documentIngressAttempt.findUniqueOrThrow({
      where: { id: ready.ingressLease.ingressAttemptId },
    });
    const intake = await prisma.documentIntake.findUniqueOrThrow({
      where: { id: target.intakeId },
    });
    const receipt = await prisma.documentIngestReceipt.findFirstOrThrow({
      where: { crawlerImportId: target.crawlerImportId },
    });
    const validation = await prisma.documentValidationAttestation.findFirstOrThrow({
      where: {
        organizationId: value.organizationId,
        documentId: target.documentId,
        assetId: target.assetId,
      },
    });
    const manifest = await prisma.documentTextManifestAdmission.findUniqueOrThrow({
      where: { extractionId: ready.extractionId },
    });
    const unquotedRetainedChunk = ready.chunks[1];
    assert.ok(unquotedRetainedChunk);
    assert.equal(crawler.custodyStatus, "DELETED");
    assert.ok(crawler.deletionStorageAuthorityGeneration);
    assert.ok(crawler.deletionTombstoneDigest);
    assert.equal((await getWorkspacePaperReader(
      value.ownerId,
      value.organizationId,
      evidence.paperId,
      new URLSearchParams({ limit: "10" }),
      { PAPERPILOT_READER_CURSOR_SECRET: "crawler-terminal-guard-reader-secret" },
    )).state, "unavailable");

    await assertDatabaseRejects("Document cannot reactivate Reader after deletion", (database) => (
      database.document.update({
        where: { id: target.documentId },
        data: {
          status: "READY",
          sourceUri: value.sourceUrl,
          archivedAt: null,
          metadata: {
            schemaVersion: 1,
            custody: "restored",
            readerAvailable: true,
          },
        },
      })
    ));
    await assertDatabaseRejects("Asset terminal metadata rejects extra raw locator keys", (database) => (
      database.asset.update({
        where: { id: target.assetId },
        data: {
          metadata: {
            schemaVersion: 1,
            custody: "deleted",
            publicAccess: false,
            deletionProofDigest: crawler.deletionProofDigest,
            storageAuthorityGeneration: crawler.deletionStorageAuthorityGeneration,
            deletionTombstoneDigest: crawler.deletionTombstoneDigest,
            rawSourceUrl: value.sourceUrl,
          },
        },
      })
    ));
    await assertDatabaseRejects("the original DocumentAsset proof cannot be removed", (database) => (
      database.documentAsset.delete({ where: { id: documentAsset.id } })
    ));
    await assertDatabaseRejects("Inbox terminal payload must remain exact and URL-free", (database) => (
      database.inboxEntry.update({
        where: { id: target.inboxEntryId },
        data: {
          payload: {
            schemaVersion: 1,
            kind: "governed-crawler-import",
            crawlerImportId: target.crawlerImportId,
            importStatus: "DELETED",
            phase: "custody-deletion",
            rawSourceUrl: value.sourceUrl,
          },
        },
      })
    ));
    await assertDatabaseRejects("crawler provenance cannot unbind and retain a raw locator", (database) => (
      database.provenanceRecord.update({
        where: {
          organizationId_id: {
            organizationId: value.organizationId,
            id: provenance.id,
          },
        },
        data: {
          sourceRecordId: `detached-${randomUUID()}`,
          documentId: null,
          inboxEntryId: null,
          sourceUri: value.sourceUrl,
        },
      })
    ));
    await assertDatabaseRejects("a differently keyed CRAWL row cannot target the deleted graph", (database) => (
      database.provenanceRecord.create({
        data: {
          organizationId: value.organizationId,
          kind: "CRAWL",
          documentId: target.documentId,
          inboxEntryId: target.inboxEntryId,
          sourceRecordId: `different-crawler-${randomUUID()}`,
          sourceUri: value.sourceUrl,
          payload: { schemaVersion: 1, stage: "crawler-restored" },
        },
      })
    ));

    await assertDatabaseRejects("crawler job payload cannot gain a raw URL", (database) => (
      database.job.update({
        where: { id: target.jobId },
        data: {
          payload: {
            schemaVersion: 1,
            crawlerImportId: target.crawlerImportId,
            rawSourceUrl: value.sourceUrl,
          },
        },
      })
    ));
    await assertDatabaseRejects("terminal work cannot be requeued", (database) => (
      database.job.update({
        where: { id: target.jobId },
        data: { status: "QUEUED", completedAt: null },
      })
    ));
    await assertDatabaseRejects("new target work cannot be inserted", (database) => (
      database.job.create({
        data: {
          id: `deleted-crawler-job-${randomUUID()}`,
          organizationId: value.organizationId,
          type: "DOCUMENT_VALIDATE",
          status: "QUEUED",
          dedupeKey: `deleted-crawler-work-${randomUUID()}`,
          payload: { schemaVersion: 1 },
          documentId: target.documentId,
          assetId: target.assetId,
          intakeId: target.intakeId,
          ingestReceiptId: receipt.id,
        },
      })
    ));
    await assertDatabaseRejects("terminal attempt output cannot gain a raw locator", (database) => (
      database.jobAttempt.update({
        where: { id: crawlAttempt.id },
        data: { result: { schemaVersion: 1, rawSourceUrl: value.sourceUrl } },
      })
    ));
    await assertDatabaseRejects("a new running attempt cannot target deleted work", (database) => (
      database.jobAttempt.create({
        data: {
          id: `deleted-crawler-attempt-${randomUUID()}`,
          organizationId: value.organizationId,
          jobId: target.jobId,
          attemptNumber: 99,
          status: "RUNNING",
          workerId: "terminal-guard-adversary",
          leaseId: `deleted-crawler-lease-${randomUUID()}`,
        },
      })
    ));
    await assertDatabaseRejects("ingress cleanup proof cannot be reversed", (database) => (
      database.documentIngressAttempt.update({
        where: { id: ingressAttempt.id },
        data: { cleanupCompletedAt: null },
      })
    ));
    await assertDatabaseRejects("released intake quota cannot be reinstated", (database) => (
      database.documentIntake.update({
        where: { id: target.intakeId },
        data: { quotaReleasedAt: null },
      })
    ));
    await assertDatabaseRejects("the crawler receipt cannot be removed", (database) => (
      database.documentIngestReceipt.delete({ where: { id: receipt.id } })
    ));
    await assertDatabaseRejects("validation authority cannot be rewritten", (database) => (
      database.documentValidationAttestation.update({
        where: { id: validation.id },
        data: { createdAt: addMilliseconds(deletionAt, 1_000) },
      })
    ));
    await assertDatabaseRejects("retained extraction admission cannot be removed", (database) => (
      database.documentTextManifestAdmission.delete({
        where: { extractionId: manifest.extractionId },
      })
    ));
    await assertDatabaseRejects("retained extraction chunks cannot be removed", (database) => (
      database.documentTextChunk.delete({ where: { id: unquotedRetainedChunk.id } })
    ));
    await assertDatabaseRejects("new legacy text cannot be appended", (database) => (
      database.documentTextChunk.create({
        data: {
          organizationId: value.organizationId,
          documentId: target.documentId,
          sequence: 999,
          text: `Recovered from ${value.sourceUrl}`,
          contentHash: createHash("sha256").update("adversarial-text").digest("hex"),
          locator: { schemaVersion: 1, rawSourceUrl: value.sourceUrl },
        },
      })
    ));

    const preserved = await prisma.crawlerImport.findUniqueOrThrow({
      where: { id: target.crawlerImportId },
      include: {
        crawlJob: { include: { jobAttempts: true } },
        intake: { include: { attempts: true, receipt: true } },
        inboxEntry: true,
      },
    });
    const preservedDocument = await prisma.document.findUniqueOrThrow({
      where: { id: target.documentId },
      include: { assets: true, textChunks: true, textExtractions: true },
    });
    const preservedAsset = await prisma.asset.findUniqueOrThrow({
      where: { id: target.assetId },
    });
    const preservedProvenance = await prisma.provenanceRecord.findMany({
      where: {
        organizationId: value.organizationId,
        kind: "CRAWL",
        OR: [
          { sourceRecordId: target.crawlerImportId },
          { documentId: target.documentId },
          { inboxEntryId: target.inboxEntryId },
        ],
      },
    });
    assert.equal(preserved.custodyStatus, "DELETED");
    assert.equal(preserved.crawlJob.status, crawlJob.status);
    assert.deepEqual(preserved.crawlJob.payload, crawlJob.payload);
    assert.equal(preserved.crawlJob.jobAttempts.length, 1);
    assert.equal(preserved.intake.quotaReleasedAt?.toISOString(), intake.quotaReleasedAt?.toISOString());
    assert.equal(preserved.intake.attempts[0]?.cleanupCompletedAt?.toISOString(), ingressAttempt.cleanupCompletedAt?.toISOString());
    assert.equal(preserved.intake.receipt?.id, receipt.id);
    assert.deepEqual(preserved.inboxEntry.payload, inbox.payload);
    assert.equal(preservedDocument.status, document.status);
    assert.equal(preservedDocument.archivedAt?.toISOString(), document.archivedAt?.toISOString());
    assert.equal(preservedDocument.assets.length, 1);
    assert.equal(preservedDocument.textExtractions.length, 1);
    assert.equal(preservedDocument.textChunks.length, ready.chunks.length);
    assert.deepEqual(preservedAsset.metadata, asset.metadata);
    assert.equal(preservedProvenance.length, 1);
    assert.deepEqual(preservedProvenance[0]?.payload, provenance.payload);
    assert.equal(safeJson([
      preserved,
      preservedDocument,
      preservedAsset,
      preservedProvenance,
    ]).includes(value.sourceUrl), false);
    assert.equal((await getWorkspacePaperReader(
      value.ownerId,
      value.organizationId,
      evidence.paperId,
      new URLSearchParams({ limit: "10" }),
      { PAPERPILOT_READER_CURSOR_SECRET: "crawler-terminal-guard-reader-secret" },
    )).state, "unavailable");
  } finally {
    await cleanup(value);
  }
});
