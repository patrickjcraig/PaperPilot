import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION } from "./extraction-config";
import {
  DOCUMENT_VALIDATION_POLICY_VERSION,
  LOCAL_QUARANTINE_STORAGE_VERSION,
} from "./validation-jobs";
import {
  DEFAULT_READER_PAGE_LIMIT,
  getWorkspacePaperReader,
  MAX_READER_SERIALIZED_BYTES,
  parseReaderPageQuery,
  readerExtractionPolicyVersion,
  type WorkspacePaperReaderDto,
} from "./reader-service";
import { captureWorkspaceGroundedEvidence } from "@/server/workspaces/grounded-evidence-service";
import { reviseWorkspaceGroundedEvidence } from "@/server/workspaces/evidence-revision-service";
import { workspaceBootstrap, workspaceProject } from "@/server/workspaces/service";

const VALIDATION_POLICY = DOCUMENT_VALIDATION_POLICY_VERSION;
const STORAGE_VERSION = LOCAL_QUARANTINE_STORAGE_VERSION;
const VALIDATION_CHECKED_AT = new Date("2026-08-28T12:00:00.000Z");
const SCANNED_AT = new Date("2026-08-28T11:59:00.000Z");
const SIGNATURE_PUBLISHED_AT = new Date("2026-08-28T10:00:00.000Z");
process.env.PAPERPILOT_READER_CURSOR_SECRET = "reader-integration-cursor-secret-2026-08-28";

interface ReaderFixture {
  organizationId: string;
  ownerId: string;
  memberId: string;
  outsiderId: string;
  paperId: string;
  workspacePaperId: string;
  documentId: string;
  assetId: string;
  validationAttestationId: string;
  inputSha256: string;
  inputSizeBytes: bigint;
  pageCount: number;
}

interface GenerationChunk {
  pageNumber: number;
  paragraphId: string;
  text: string;
}

const organizationIds = new Set<string>();
const paperIds = new Set<string>();
const userIds = new Set<string>();

after(async () => {
  await prisma.$transaction(async (transaction) => {
    await transaction.provenanceRecord.deleteMany({
      where: { organizationId: { in: [...organizationIds] } },
    });
    await transaction.auditEvent.deleteMany({
      where: { organizationId: { in: [...organizationIds] } },
    });
    await transaction.organization.deleteMany({ where: { id: { in: [...organizationIds] } } });
  });
  await prisma.paper.deleteMany({ where: { id: { in: [...paperIds] } } });
  await prisma.user.deleteMany({ where: { id: { in: [...userIds] } } });
  await prisma.$disconnect();
});

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function plusMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

function fixtureId(kind: string, label: string, suffix: string): string {
  return `reader-${kind}-${label}-${suffix}`;
}

async function createUser(label: string, suffix: string): Promise<string> {
  const id = fixtureId("user", label, suffix);
  await prisma.user.create({
    data: {
      id,
      name: `Reader ${label}`,
      email: `reader-${label}-${suffix}@example.test`,
      emailVerified: true,
    },
  });
  userIds.add(id);
  return id;
}

async function createReaderFixture(
  label: string,
  options: { withDocument?: boolean; documentStatus?: "PENDING" | "READY" } = {},
): Promise<ReaderFixture> {
  const suffix = randomUUID();
  const organizationId = fixtureId("org", label, suffix);
  const ownerId = await createUser(`${label}-owner`, suffix);
  const memberId = await createUser(`${label}-member`, suffix);
  const outsiderId = await createUser(`${label}-outsider`, suffix);
  const paperId = fixtureId("paper", label, suffix);
  const workspacePaperId = fixtureId("workspace-paper", label, suffix);
  const documentId = fixtureId("document", label, suffix);
  const assetId = fixtureId("asset", label, suffix);
  const intakeId = fixtureId("intake", label, suffix);
  const ingressJobId = fixtureId("ingress-job", label, suffix);
  const ingressJobAttemptId = fixtureId("ingress-job-attempt", label, suffix);
  const ingressAttemptId = fixtureId("ingress-attempt", label, suffix);
  const ingestReceiptId = fixtureId("ingest", label, suffix);
  const validationJobId = fixtureId("validation-job", label, suffix);
  const validationAttemptId = fixtureId("validation-attempt", label, suffix);
  const validationAttestationId = fixtureId("validation", label, suffix);
  const inputSha256 = digest(`${organizationId}:${paperId}`);
  const computedMd5 = createHash("md5")
    .update(`${organizationId}:${paperId}`)
    .digest("hex");
  const inputSizeBytes = 8_192n;
  const pageCount = 2;
  const withDocument = options.withDocument ?? true;
  const documentStatus = options.documentStatus ?? "READY";
  const objectKey = `${STORAGE_VERSION}:${organizationId}:${assetId}`;

  organizationIds.add(organizationId);
  paperIds.add(paperId);
  await prisma.$transaction(async (transaction) => {
    await transaction.organization.create({
      data: {
        id: organizationId,
        name: `Reader integration ${label}`,
        slug: fixtureId("workspace", label, suffix),
      },
    });
    await transaction.member.createMany({
      data: [
        { id: fixtureId("member-owner", label, suffix), organizationId, userId: ownerId, role: "owner" },
        { id: fixtureId("member-reader", label, suffix), organizationId, userId: memberId, role: "member" },
      ],
    });
    await transaction.paper.create({
      data: { id: paperId, title: `Reader integration paper ${label}` },
    });
    await transaction.workspacePaper.create({
      data: {
        id: workspacePaperId,
        organizationId,
        paperId,
        addedById: ownerId,
      },
    });
    if (!withDocument) return;
    await transaction.document.create({
      data: {
        id: documentId,
        organizationId,
        paperId,
        workspacePaperId,
        kind: "PAPER_PDF",
        status: documentStatus,
        mimeType: "application/pdf",
        pageCount: documentStatus === "READY" ? pageCount : null,
        contentHash: documentStatus === "READY" ? inputSha256 : null,
        validatedAt: documentStatus === "READY" ? VALIDATION_CHECKED_AT : null,
        validationPolicyVersion: documentStatus === "READY" ? VALIDATION_POLICY : null,
      },
    });
    await transaction.asset.create({
      data: {
        id: assetId,
        organizationId,
        storageProvider: "LOCAL",
        objectKey,
        physicalLocator: objectKey,
        status: documentStatus === "READY" ? "READY" : "QUARANTINED",
        mimeType: "application/pdf",
        sizeBytes: documentStatus === "READY" ? inputSizeBytes : null,
        sha256: documentStatus === "READY" ? inputSha256 : null,
        scannedAt: documentStatus === "READY" ? SCANNED_AT : null,
        validatedAt: documentStatus === "READY" ? VALIDATION_CHECKED_AT : null,
        validationPolicyVersion: documentStatus === "READY" ? VALIDATION_POLICY : null,
      },
    });
    await transaction.documentAsset.create({
      data: { organizationId, documentId, assetId, role: "ORIGINAL" },
    });
    if (documentStatus !== "READY") return;
    await transaction.documentIntake.create({
      data: {
        id: intakeId,
        organizationId,
        source: "WEB_MCP",
        status: "READY",
        documentId,
        assetId,
        createdById: ownerId,
        reservedBytes: inputSizeBytes,
        committedBytes: inputSizeBytes,
        completedAt: VALIDATION_CHECKED_AT,
      },
    });
    await transaction.job.create({
      data: {
        id: ingressJobId,
        organizationId,
        type: "DOCUMENT_DOWNLOAD",
        status: "SUCCEEDED",
        dedupeKey: `reader-ingress:${label}:${suffix}`,
        documentId,
        assetId,
        intakeId,
        createdById: ownerId,
        attempts: 1,
        maxAttempts: 3,
        completedAt: SCANNED_AT,
      },
    });
    await transaction.jobAttempt.create({
      data: {
        id: ingressJobAttemptId,
        organizationId,
        jobId: ingressJobId,
        attemptNumber: 1,
        status: "SUCCEEDED",
        startedAt: SCANNED_AT,
        completedAt: SCANNED_AT,
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
        storageVersion: STORAGE_VERSION,
        status: "ADOPTED",
        maximumSizeBytes: inputSizeBytes,
        expectedSizeBytes: inputSizeBytes,
        receivedSizeBytes: inputSizeBytes,
        computedMd5,
        sha256: inputSha256,
        leaseId: fixtureId("ingress-lease", label, suffix),
        leaseExpiresAt: SCANNED_AT,
        storedAt: SCANNED_AT,
        completedAt: SCANNED_AT,
      },
    });
    await transaction.documentIngestReceipt.create({
      data: {
        id: ingestReceiptId,
        organizationId,
        source: "WEB_MCP",
        sourceFingerprint: `test-reader:${label}:${suffix}`,
        intakeId,
        assetId,
        documentId,
        ingressAttemptId,
        requestedById: ownerId,
        declaredMimeType: "application/pdf",
        receivedSizeBytes: inputSizeBytes,
        sha256: inputSha256,
        storageVersion: STORAGE_VERSION,
        storedAt: SCANNED_AT,
      },
    });
    await transaction.job.create({
      data: {
        id: validationJobId,
        organizationId,
        type: "DOCUMENT_VALIDATE",
        status: "SUCCEEDED",
        dedupeKey: `reader-validation:${label}:${suffix}`,
        documentId,
        assetId,
        intakeId,
        ingestReceiptId,
        payload: {
          schemaVersion: 2,
          policyVersion: VALIDATION_POLICY,
          storageVersion: STORAGE_VERSION,
          source: "document-ingest",
          ingestReceiptId,
        },
        attempts: 1,
        maxAttempts: 4,
        completedAt: VALIDATION_CHECKED_AT,
      },
    });
    await transaction.jobAttempt.create({
      data: {
        id: validationAttemptId,
        organizationId,
        jobId: validationJobId,
        attemptNumber: 1,
        status: "SUCCEEDED",
        completedAt: VALIDATION_CHECKED_AT,
      },
    });
    await transaction.documentValidationAttestation.create({
      data: {
        id: validationAttestationId,
        organizationId,
        jobId: validationJobId,
        jobAttemptId: validationAttemptId,
        assetId,
        documentId,
        ingestReceiptId,
        inputSha256,
        inputSizeBytes,
        storageVersion: STORAGE_VERSION,
        policyVersion: VALIDATION_POLICY,
        toolchainDigest: digest(`validator:${label}:${suffix}`),
        verdict: "ACCEPTED",
        rejectionCode: null,
        malwareVerdict: "CLEAN",
        malwareEngine: "clamav",
        malwareEngineVersion: "1.5.4",
        signatureVersion: "27712",
        signaturePublishedAt: SIGNATURE_PUBLISHED_AT,
        scannedAt: SCANNED_AT,
        pdfStructuralVerdict: "VALID",
        pdfEngine: "qpdf+poppler",
        pdfEngineVersion: "12.4.1+26.05.0",
        pdfVersion: "1.7",
        pageCount,
        objectCount: 12,
        revisionCount: 1,
        checkedAt: VALIDATION_CHECKED_AT,
        result: {
          schemaVersion: 1,
          detectionCount: 0,
          warningCount: 0,
          malwareDurationMs: 10,
          pdfDurationMs: 12,
          totalDurationMs: 20,
          completedAt: plusMilliseconds(VALIDATION_CHECKED_AT, 20).toISOString(),
        },
      },
    });
  });
  return {
    organizationId,
    ownerId,
    memberId,
    outsiderId,
    paperId,
    workspacePaperId,
    documentId,
    assetId,
    validationAttestationId,
    inputSha256,
    inputSizeBytes,
    pageCount,
  };
}

async function createGeneration(
  fixture: ReaderFixture,
  label: string,
  input: {
    verdict: "EXTRACTED" | "NO_TEXT";
    chunks?: readonly GenerationChunk[];
    createdAt?: Date;
    policyVersion?: string;
  },
): Promise<string> {
  const suffix = randomUUID();
  const jobId = fixtureId("extraction-job", label, suffix);
  const attemptId = fixtureId("extraction-attempt", label, suffix);
  const extractionId = fixtureId("extraction", label, suffix);
  const chunks = input.chunks ?? [];
  const extractedAt = plusMilliseconds(VALIDATION_CHECKED_AT, 1_000);
  const completedAt = plusMilliseconds(VALIDATION_CHECKED_AT, 2_000);
  const checkedAt = plusMilliseconds(VALIDATION_CHECKED_AT, 3_000);
  const textBytes = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.text, "utf8"), 0);
  const policyVersion = input.policyVersion ?? DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION;
  const toolchainDigest = digest(`extractor:${label}:${suffix}`);

  assert.equal(input.verdict === "NO_TEXT", chunks.length === 0);
  await prisma.$transaction(async (transaction) => {
    await transaction.job.create({
      data: {
        id: jobId,
        organizationId: fixture.organizationId,
        type: "TEXT_EXTRACTION",
        status: "SUCCEEDED",
        dedupeKey: `reader-extraction:${label}:${suffix}`,
        documentId: fixture.documentId,
        assetId: fixture.assetId,
        payload: {
          schemaVersion: 1,
          source: "accepted-document-validation",
          validationAttestationId: fixture.validationAttestationId,
          policyVersion,
          storageVersion: STORAGE_VERSION,
          toolchainDigest,
        },
        attempts: 1,
        maxAttempts: 4,
        completedAt: checkedAt,
        createdAt: input.createdAt,
      },
    });
    await transaction.jobAttempt.create({
      data: {
        id: attemptId,
        organizationId: fixture.organizationId,
        jobId,
        attemptNumber: 1,
        status: "SUCCEEDED",
        completedAt: checkedAt,
      },
    });
    await transaction.documentTextExtraction.create({
      data: {
        id: extractionId,
        organizationId: fixture.organizationId,
        jobId,
        jobAttemptId: attemptId,
        validationAttestationId: fixture.validationAttestationId,
        assetId: fixture.assetId,
        documentId: fixture.documentId,
        inputSha256: fixture.inputSha256,
        inputSizeBytes: fixture.inputSizeBytes,
        storageVersion: STORAGE_VERSION,
        extractionPolicyVersion: policyVersion,
        toolchainDigest,
        verdict: input.verdict,
        engine: "poppler",
        engineVersion: "26.05.0",
        pageCount: fixture.pageCount,
        chunkCount: chunks.length,
        textBytes,
        extractedAt,
        completedAt,
        durationMs: 900,
        totalDurationMs: 1_100,
        checkedAt,
        createdAt: input.createdAt,
        result: {
          schemaVersion: 1,
          engine: "poppler",
          engineVersion: "26.05.0",
          extractedAt: extractedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs: 900,
          totalDurationMs: 1_100,
        },
      },
    });
    if (chunks.length > 0) {
      await transaction.documentTextChunk.createMany({
        data: chunks.map((chunk, sequence) => ({
          id: fixtureId("chunk", `${label}-${sequence}`, suffix),
          organizationId: fixture.organizationId,
          documentId: fixture.documentId,
          extractionId,
          sequence,
          pageStart: chunk.pageNumber,
          pageEnd: chunk.pageNumber,
          paragraphId: chunk.paragraphId,
          text: chunk.text,
          contentHash: digest(chunk.text),
          locator: {
            schemaVersion: 1,
            kind: "pdf-text",
            pageNumber: chunk.pageNumber,
            paragraphId: chunk.paragraphId,
          },
        })),
      });
    }
  });
  return extractionId;
}

async function createExtractionJob(
  fixture: ReaderFixture,
  label: string,
  input: {
    status: "QUEUED" | "RUNNING" | "RETRYING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "DEAD_LETTER";
    attempts?: number;
    maxAttempts?: number;
    policyVersion?: string;
    payload?: Record<string, string | number>;
    createdAt?: Date;
    jobId?: string;
  },
): Promise<string> {
  const suffix = randomUUID();
  const jobId = input.jobId ?? fixtureId("extraction-job", label, suffix);
  const policyVersion = input.policyVersion ?? DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION;
  const toolchainDigest = digest(`extractor:${label}:${suffix}`);
  const createdAt = input.createdAt ?? plusMilliseconds(VALIDATION_CHECKED_AT, 500);
  const terminal = input.status === "SUCCEEDED"
    || input.status === "FAILED"
    || input.status === "CANCELLED"
    || input.status === "DEAD_LETTER";
  await prisma.job.create({
    data: {
      id: jobId,
      organizationId: fixture.organizationId,
      type: "TEXT_EXTRACTION",
      status: input.status,
      dedupeKey: `reader-extraction:${label}:${suffix}`,
      documentId: fixture.documentId,
      assetId: fixture.assetId,
      payload: input.payload ?? {
        schemaVersion: 1,
        source: "accepted-document-validation",
        validationAttestationId: fixture.validationAttestationId,
        policyVersion,
        storageVersion: STORAGE_VERSION,
        toolchainDigest,
      },
      attempts: input.attempts ?? 0,
      maxAttempts: input.maxAttempts ?? 4,
      createdAt,
      completedAt: terminal ? plusMilliseconds(createdAt, 1) : null,
      lockedAt: input.status === "RUNNING" ? createdAt : null,
      lockedBy: input.status === "RUNNING" ? "reader-integration-worker" : null,
      leaseId: input.status === "RUNNING" ? `reader-lease-${suffix}` : null,
      leaseExpiresAt: input.status === "RUNNING" ? plusMilliseconds(createdAt, 60_000) : null,
    },
  });
  return jobId;
}

function assertPaperNotFound(operation: Promise<unknown>): Promise<void> {
  return assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof HttpProblem);
    assert.equal(error.status, 404);
    assert.equal(error.code, "paper_not_found");
    assert.equal(error.message, "Paper was not found.");
    return true;
  });
}

function assertState<TState extends WorkspacePaperReaderDto["state"]>(
  dto: WorkspacePaperReaderDto,
  state: TState,
): asserts dto is Extract<WorkspacePaperReaderDto, { state: TState }> {
  assert.equal(dto.schemaVersion, 1);
  assert.equal(dto.state, state);
}

test("grounded capture is authoritative, idempotent, privacy-filtered, and source-state aware", async () => {
  const fixture = await createReaderFixture("grounded-capture");
  const visibleProjectId = fixtureId("project", "grounded-visible", randomUUID());
  const hiddenProjectId = fixtureId("project", "grounded-hidden", randomUUID());
  const visibleCollectionId = fixtureId("collection", "grounded-visible", randomUUID());
  const hiddenCollectionId = fixtureId("collection", "grounded-hidden", randomUUID());
  await prisma.$transaction(async (transaction) => {
    await transaction.project.createMany({
      data: [
        {
          id: visibleProjectId,
          organizationId: fixture.organizationId,
          name: "Visible grounded project",
          slug: `grounded-visible-${randomUUID()}`,
          visibility: "WORKSPACE",
          createdById: fixture.ownerId,
        },
        {
          id: hiddenProjectId,
          organizationId: fixture.organizationId,
          name: "Hidden filing project",
          slug: `grounded-hidden-${randomUUID()}`,
          visibility: "PRIVATE",
          createdById: fixture.ownerId,
        },
      ],
    });
    await transaction.projectPaper.createMany({
      data: [
        {
          organizationId: fixture.organizationId,
          projectId: visibleProjectId,
          workspacePaperId: fixture.workspacePaperId,
          addedById: fixture.ownerId,
        },
        {
          organizationId: fixture.organizationId,
          projectId: hiddenProjectId,
          workspacePaperId: fixture.workspacePaperId,
          addedById: fixture.ownerId,
        },
      ],
    });
    await transaction.collection.createMany({
      data: [
        {
          id: visibleCollectionId,
          organizationId: fixture.organizationId,
          projectId: visibleProjectId,
          name: "Visible results",
          color: "blue",
          createdById: fixture.ownerId,
        },
        {
          id: hiddenCollectionId,
          organizationId: fixture.organizationId,
          projectId: hiddenProjectId,
          name: "Private owner filing",
          color: "slate",
          createdById: fixture.ownerId,
        },
      ],
    });
  });
  const extractionId = await createGeneration(fixture, "grounded-current", {
    verdict: "EXTRACTED",
    chunks: [
      { pageNumber: 1, paragraphId: "p1-p1", text: "A result: α" },
      { pageNumber: 2, paragraphId: "p2-p1", text: "beta and context" },
    ],
  });
  const reader = await getWorkspacePaperReader(
    fixture.ownerId,
    fixture.organizationId,
    fixture.paperId,
    new URLSearchParams({ limit: "10" }),
  );
  assertState(reader, "ready");
  assert.equal(reader.generation.id, extractionId);
  assert.equal(reader.generation.manifestSchemaVersion, 1);
  assert.ok(reader.generation.manifestSha256);
  assert.equal(reader.chunks.length, 2);
  assert.ok(reader.chunks.every((chunkValue) => Boolean(chunkValue.contentHash)));
  const first = reader.chunks[0];
  const last = reader.chunks[1];
  assert.ok(first && last);
  const quote = "α\n\nbeta";
  const command = {
    clientOperationId: `grounded-capture-${randomUUID()}`,
    expectedVersion: 0,
    projectId: visibleProjectId,
    collectionIds: [visibleCollectionId],
    note: {
      kind: "direct-evidence" as const,
      title: "Grounded result",
      claim: "The paper reports alpha and beta.",
      interpretation: "The exact source range supports the claim.",
      confidence: "unspecified" as const,
      tags: ["result"],
    },
    selection: {
      documentId: reader.document.id,
      extractionId: reader.generation.id,
      manifestSha256: reader.generation.manifestSha256,
      start: {
        chunkId: first.id,
        sequence: first.sequence,
        byteOffset: Buffer.byteLength("A result: ", "utf8"),
        contentHash: first.contentHash,
      },
      end: {
        chunkId: last.id,
        sequence: last.sequence,
        byteOffset: Buffer.byteLength("beta", "utf8"),
        contentHash: last.contentHash,
      },
      expectedQuoteSha256: digest(quote),
    },
  };

  const applied = await captureWorkspaceGroundedEvidence(
    { id: fixture.ownerId, name: "Reader grounded-capture-owner" },
    fixture.organizationId,
    fixture.paperId,
    command,
  );
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.equal(applied.outcome, "applied");
  assert.equal(applied.aggregateVersion, 1);
  assert.equal(applied.data.note.evidence, quote);
  assert.equal(applied.data.note.status, "captured");
  assert.equal(applied.data.note.confidence, "unspecified");
  assert.equal(applied.data.note.provenance.sourceId, extractionId);
  assert.equal(applied.data.note.grounding?.state, "current");
  assert.equal(applied.data.grounding.quoteSha256, digest(quote));
  assert.deepEqual(applied.data.updatedCollectionIds, [visibleCollectionId]);

  const replay = await captureWorkspaceGroundedEvidence(
    { id: fixture.ownerId, name: "Reader grounded-capture-owner" },
    fixture.organizationId,
    fixture.paperId,
    command,
  );
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.outcome, "replayed");
    assert.equal(replay.data.note.id, applied.data.note.id);
  }
  const stored = await prisma.evidenceNote.findUniqueOrThrow({
    where: { id: applied.data.note.id },
    include: { textAnchor: true, provenanceRecords: true },
  });
  assert.equal(stored.status, "CAPTURED");
  assert.equal(stored.verifiedAt, null);
  assert.equal(stored.groundingVersion, 1);
  assert.equal(stored.textAnchor?.quoteText, quote);
  assert.equal(stored.textAnchor?.quoteSha256, digest(quote));
  assert.deepEqual(
    stored.provenanceRecords.map((record) => record.kind).sort(),
    ["EXTRACTION", "USER_ASSERTION"],
  );

  const wrongHash = await captureWorkspaceGroundedEvidence(
    { id: fixture.ownerId, name: "Reader grounded-capture-owner" },
    fixture.organizationId,
    fixture.paperId,
    {
      ...command,
      clientOperationId: `grounded-drift-${randomUUID()}`,
      expectedVersion: 1,
      selection: { ...command.selection, expectedQuoteSha256: digest("wrong quote") },
    },
  );
  assert.equal(wrongHash.ok, false);
  if (!wrongHash.ok) assert.equal(wrongHash.code, "selection_conflict");
  assert.equal(
    await prisma.evidenceNote.count({ where: { organizationId: fixture.organizationId } }),
    1,
  );

  // Simulate a legacy/corrective cross-project filing edge. The visible note
  // must not leak the private collection identifier to another member.
  await prisma.collectionEvidenceNote.create({
    data: {
      organizationId: fixture.organizationId,
      collectionId: hiddenCollectionId,
      evidenceNoteId: applied.data.note.id,
    },
  });
  const memberBootstrap = await workspaceBootstrap(
    { id: fixture.memberId, name: "Reader grounded-capture-member" },
    fixture.organizationId,
    fixture.organizationId,
  );
  const memberNote = memberBootstrap.notes.find((note) => note.id === applied.data.note.id);
  assert.ok(memberNote);
  assert.deepEqual(memberNote.collectionIds, [visibleCollectionId]);
  assert.equal(memberNote.grounding?.state, "current");

  const ownerDetail = await workspaceProject(
    { id: fixture.ownerId, name: "Reader grounded-capture-owner" },
    fixture.organizationId,
    visibleProjectId,
  );
  assert.equal(ownerDetail?.notes[0]?.grounding?.state, "current");

  await createGeneration(fixture, "grounded-successor", {
    verdict: "EXTRACTED",
    chunks: [{ pageNumber: 1, paragraphId: "p1-p1", text: "Replacement source text" }],
  });
  const supersededDetail = await workspaceProject(
    { id: fixture.ownerId, name: "Reader grounded-capture-owner" },
    fixture.organizationId,
    visibleProjectId,
  );
  assert.equal(supersededDetail?.notes[0]?.grounding?.state, "superseded");
});

test("grounded evidence revisions verify, re-anchor, replay current lineage, and remain tenant-safe", async () => {
  const fixture = await createReaderFixture("grounded-revisions");
  const projectId = fixtureId("project", "revision-visible", randomUUID());
  const collectionId = fixtureId("collection", "revision-visible", randomUUID());
  await prisma.$transaction(async (transaction) => {
    await transaction.project.create({
      data: {
        id: projectId,
        organizationId: fixture.organizationId,
        name: "Grounded revision project",
        slug: `grounded-revisions-${randomUUID()}`,
        visibility: "WORKSPACE",
        createdById: fixture.ownerId,
      },
    });
    await transaction.projectPaper.create({
      data: {
        organizationId: fixture.organizationId,
        projectId,
        workspacePaperId: fixture.workspacePaperId,
        addedById: fixture.ownerId,
      },
    });
    await transaction.collection.create({
      data: {
        id: collectionId,
        organizationId: fixture.organizationId,
        projectId,
        name: "Revision evidence",
        color: "blue",
        createdById: fixture.ownerId,
      },
    });
  });

  await createGeneration(fixture, "revision-original", {
    verdict: "EXTRACTED",
    chunks: [{ pageNumber: 1, paragraphId: "p1-p1", text: "Original alpha result." }],
    createdAt: new Date("2026-08-28T12:10:00.000Z"),
  });
  const originalReader = await getWorkspacePaperReader(
    fixture.ownerId,
    fixture.organizationId,
    fixture.paperId,
  );
  assertState(originalReader, "ready");
  const originalChunk = originalReader.chunks[0];
  assert.ok(originalChunk);
  const originalQuote = "alpha";
  const originalStart = Buffer.byteLength("Original ", "utf8");
  const originalSelection = {
    documentId: originalReader.document.id,
    extractionId: originalReader.generation.id,
    manifestSha256: originalReader.generation.manifestSha256,
    start: {
      chunkId: originalChunk.id,
      sequence: originalChunk.sequence,
      byteOffset: originalStart,
      contentHash: originalChunk.contentHash,
    },
    end: {
      chunkId: originalChunk.id,
      sequence: originalChunk.sequence,
      byteOffset: originalStart + Buffer.byteLength(originalQuote, "utf8"),
      contentHash: originalChunk.contentHash,
    },
    expectedQuoteSha256: digest(originalQuote),
  };
  const captureOperationId = `revision-capture-${randomUUID()}`;
  const captured = await captureWorkspaceGroundedEvidence(
    { id: fixture.ownerId, name: "Grounded revision owner" },
    fixture.organizationId,
    fixture.paperId,
    {
      clientOperationId: captureOperationId,
      expectedVersion: 0,
      projectId,
      collectionIds: [collectionId],
      note: {
        kind: "direct-evidence",
        title: "Stable semantic claim",
        claim: "The source reports the focal result.",
        interpretation: "The selected wording directly supports the claim.",
        openQuestion: "Does the replacement preserve the same result?",
        confidence: "medium",
        tags: ["revision", "result"],
      },
      selection: originalSelection,
    },
  );
  assert.equal(captured.ok, true);
  if (!captured.ok) throw new Error("Expected grounded capture to succeed.");
  const rootId = captured.data.note.id;
  assert.deepEqual(captured.data.note.revision, {
    rootId,
    number: 1,
    isLatest: true,
  });
  await prisma.collectionEvidenceNote.update({
    where: {
      collectionId_evidenceNoteId: {
        collectionId,
        evidenceNoteId: rootId,
      },
    },
    data: { position: 7 },
  });

  await createGeneration(fixture, "revision-replacement", {
    verdict: "EXTRACTED",
    chunks: [{ pageNumber: 2, paragraphId: "p2-p1", text: "Replacement beta result." }],
    createdAt: new Date("2026-08-28T12:20:00.000Z"),
  });
  const replacementReader = await getWorkspacePaperReader(
    fixture.ownerId,
    fixture.organizationId,
    fixture.paperId,
  );
  assertState(replacementReader, "ready");
  const replacementChunk = replacementReader.chunks[0];
  assert.ok(replacementChunk);
  const replacementQuote = "beta";
  const replacementStart = Buffer.byteLength("Replacement ", "utf8");
  const replacementSelection = {
    documentId: replacementReader.document.id,
    extractionId: replacementReader.generation.id,
    manifestSha256: replacementReader.generation.manifestSha256,
    start: {
      chunkId: replacementChunk.id,
      sequence: replacementChunk.sequence,
      byteOffset: replacementStart,
      contentHash: replacementChunk.contentHash,
    },
    end: {
      chunkId: replacementChunk.id,
      sequence: replacementChunk.sequence,
      byteOffset: replacementStart + Buffer.byteLength(replacementQuote, "utf8"),
      contentHash: replacementChunk.contentHash,
    },
    expectedQuoteSha256: digest(replacementQuote),
  };

  const verifyOperationId = `revision-verify-${randomUUID()}`;
  const verified = await reviseWorkspaceGroundedEvidence(
    { id: fixture.ownerId, name: "Grounded revision owner" },
    fixture.organizationId,
    rootId,
    {
      clientOperationId: verifyOperationId,
      expectedVersion: captured.aggregateVersion,
      action: "verify",
    },
  );
  assert.equal(verified.ok, true);
  if (!verified.ok) throw new Error("Expected grounded verification to succeed.");
  assert.equal(verified.outcome, "applied");
  const verifiedId = verified.data.note.id;
  assert.equal(verified.data.predecessorId, rootId);
  assert.equal(verified.data.note.status, "verified");
  assert.ok(verified.data.note.reviewedAt);
  assert.equal(verified.data.note.evidence, originalQuote);
  assert.equal(verified.data.note.grounding?.state, "superseded");
  assert.equal(
    verified.data.note.provenance.retrievedAt,
    captured.data.note.provenance.retrievedAt,
  );
  assert.deepEqual(verified.data.note.revision, {
    rootId,
    previousId: rootId,
    number: 2,
    isLatest: true,
  });
  assert.deepEqual(verified.data.linkedProjectIds, [projectId]);
  assert.deepEqual(verified.data.updatedCollectionIds, [collectionId]);
  assert.equal((await prisma.collectionEvidenceNote.findUniqueOrThrow({
    where: {
      collectionId_evidenceNoteId: {
        collectionId,
        evidenceNoteId: verifiedId,
      },
    },
    select: { position: true },
  })).position, 7);

  // The local integration adapter intentionally uses one physical database
  // connection. Keep independent assertions sequential so Prisma does not
  // batch them into overlapping pg client queries and contaminate the next
  // transaction's isolation setup.
  const storedRoot = await prisma.evidenceNote.findUniqueOrThrow({ where: { id: rootId } });
  const storedVerified = await prisma.evidenceNote.findUniqueOrThrow({ where: { id: verifiedId } });
  const rootAnchor = await prisma.evidenceTextAnchor.findFirstOrThrow({
    where: { organizationId: fixture.organizationId, evidenceNoteId: rootId },
  });
  const verifiedAnchor = await prisma.evidenceTextAnchor.findFirstOrThrow({
    where: { organizationId: fixture.organizationId, evidenceNoteId: verifiedId },
  });
  assert.equal(storedRoot.status, "CAPTURED");
  assert.equal(storedRoot.verifiedAt, null);
  assert.equal(storedVerified.status, "VERIFIED");
  assert.ok(storedVerified.verifiedAt);
  assert.equal(verifiedAnchor.quoteText, rootAnchor.quoteText);
  assert.equal(verifiedAnchor.quoteSha256, rootAnchor.quoteSha256);
  assert.equal(verifiedAnchor.extractionId, rootAnchor.extractionId);
  assert.equal(verifiedAnchor.manifestSha256, rootAnchor.manifestSha256);
  assert.ok(storedVerified.createdAt.getTime() > storedRoot.createdAt.getTime());

  const repeatedVerify = await reviseWorkspaceGroundedEvidence(
    { id: fixture.ownerId, name: "Grounded revision owner" },
    fixture.organizationId,
    verifiedId,
    {
      clientOperationId: `revision-repeat-verify-${randomUUID()}`,
      expectedVersion: verified.aggregateVersion,
      action: "verify",
    },
  );
  assert.equal(repeatedVerify.ok, false);
  if (!repeatedVerify.ok) assert.equal(repeatedVerify.code, "revision_conflict");
  assert.equal(
    (await prisma.organization.findUniqueOrThrow({
      where: { id: fixture.organizationId },
      select: { revision: true },
    })).revision,
    verified.aggregateVersion,
  );

  const verifiedReplay = await reviseWorkspaceGroundedEvidence(
    { id: fixture.ownerId, name: "Grounded revision owner" },
    fixture.organizationId,
    rootId,
    {
      clientOperationId: verifyOperationId,
      expectedVersion: captured.aggregateVersion,
      action: "verify",
    },
  );
  assert.equal(verifiedReplay.ok, true);
  if (!verifiedReplay.ok) throw new Error("Expected verification replay to succeed.");
  assert.equal(verifiedReplay.outcome, "replayed");
  assert.equal(verifiedReplay.data.note.id, verifiedId);

  const changedReplayPayload = await reviseWorkspaceGroundedEvidence(
    { id: fixture.ownerId, name: "Grounded revision owner" },
    fixture.organizationId,
    rootId,
    {
      clientOperationId: verifyOperationId,
      expectedVersion: verified.aggregateVersion,
      action: "reanchor",
      selection: replacementSelection,
    },
  );
  assert.equal(changedReplayPayload.ok, false);
  if (!changedReplayPayload.ok) {
    assert.equal(changedReplayPayload.code, "idempotency_conflict");
  }

  const reanchored = await reviseWorkspaceGroundedEvidence(
    { id: fixture.ownerId, name: "Grounded revision owner" },
    fixture.organizationId,
    verifiedId,
    {
      clientOperationId: `revision-reanchor-${randomUUID()}`,
      expectedVersion: verified.aggregateVersion,
      action: "reanchor",
      selection: replacementSelection,
    },
  );
  assert.equal(reanchored.ok, true);
  if (!reanchored.ok) throw new Error("Expected grounded re-anchor to succeed.");
  const reanchoredId = reanchored.data.note.id;
  assert.equal(reanchored.data.note.status, "captured");
  assert.equal(reanchored.data.note.reviewedAt, undefined);
  assert.equal(reanchored.data.note.evidence, replacementQuote);
  assert.equal(reanchored.data.note.claim, captured.data.note.claim);
  assert.equal(reanchored.data.note.interpretation, captured.data.note.interpretation);
  assert.equal(reanchored.data.note.grounding?.state, "current");
  assert.equal(reanchored.data.note.grounding?.extractionId, replacementReader.generation.id);
  assert.deepEqual(reanchored.data.note.revision, {
    rootId,
    previousId: verifiedId,
    number: 3,
    isLatest: true,
  });

  // Receipt membership IDs are not authoritative after later ACL/filing
  // changes. Replay must re-filter them from current visible join rows.
  await prisma.collectionEvidenceNote.delete({
    where: {
      collectionId_evidenceNoteId: {
        collectionId,
        evidenceNoteId: verifiedId,
      },
    },
  });
  await prisma.projectEvidenceNote.delete({
    where: {
      projectId_evidenceNoteId: {
        projectId,
        evidenceNoteId: verifiedId,
      },
    },
  });

  const verifyReplayAfterSuccessor = await reviseWorkspaceGroundedEvidence(
    { id: fixture.ownerId, name: "Grounded revision owner" },
    fixture.organizationId,
    rootId,
    {
      clientOperationId: verifyOperationId,
      expectedVersion: captured.aggregateVersion,
      action: "verify",
    },
  );
  assert.equal(verifyReplayAfterSuccessor.ok, true);
  if (!verifyReplayAfterSuccessor.ok) {
    throw new Error("Expected historical verification replay to succeed.");
  }
  assert.equal(verifyReplayAfterSuccessor.aggregateVersion, reanchored.aggregateVersion);
  assert.deepEqual(verifyReplayAfterSuccessor.data.note.revision, {
    rootId,
    previousId: rootId,
    nextId: reanchoredId,
    number: 2,
    isLatest: false,
  });
  assert.deepEqual(verifyReplayAfterSuccessor.data.updatedCollectionIds, []);
  assert.deepEqual(verifyReplayAfterSuccessor.data.note.collectionIds, []);
  assert.deepEqual(verifyReplayAfterSuccessor.data.linkedProjectIds, [projectId]);

  const captureReplayAfterSuccessors = await captureWorkspaceGroundedEvidence(
    { id: fixture.ownerId, name: "Grounded revision owner" },
    fixture.organizationId,
    fixture.paperId,
    {
      clientOperationId: captureOperationId,
      expectedVersion: 0,
      projectId,
      collectionIds: [collectionId],
      note: {
        kind: "direct-evidence",
        title: "Stable semantic claim",
        claim: "The source reports the focal result.",
        interpretation: "The selected wording directly supports the claim.",
        openQuestion: "Does the replacement preserve the same result?",
        confidence: "medium",
        tags: ["revision", "result"],
      },
      selection: originalSelection,
    },
  );
  assert.equal(captureReplayAfterSuccessors.ok, true);
  if (!captureReplayAfterSuccessors.ok) {
    throw new Error("Expected historical capture replay to succeed.");
  }
  assert.equal(captureReplayAfterSuccessors.outcome, "replayed");
  assert.deepEqual(captureReplayAfterSuccessors.data.note.revision, {
    rootId,
    nextId: verifiedId,
    number: 1,
    isLatest: false,
  });
  assert.equal(captureReplayAfterSuccessors.data.note.grounding?.state, "superseded");
  assert.deepEqual(
    captureReplayAfterSuccessors.data.grounding,
    captureReplayAfterSuccessors.data.note.grounding,
  );
  assert.equal(captureReplayAfterSuccessors.data.grounding.state, "superseded");
  assert.deepEqual(captureReplayAfterSuccessors.data.linkedProjectIds, [projectId]);

  const stalePredecessor = await reviseWorkspaceGroundedEvidence(
    { id: fixture.ownerId, name: "Grounded revision owner" },
    fixture.organizationId,
    rootId,
    {
      clientOperationId: `revision-stale-${randomUUID()}`,
      expectedVersion: reanchored.aggregateVersion,
      action: "verify",
    },
  );
  assert.equal(stalePredecessor.ok, false);
  if (!stalePredecessor.ok) assert.equal(stalePredecessor.code, "revision_conflict");

  await createGeneration(fixture, "revision-third", {
    verdict: "EXTRACTED",
    chunks: [{ pageNumber: 2, paragraphId: "p2-p1", text: "Third gamma result." }],
    createdAt: new Date("2026-08-28T12:30:00.000Z"),
  });
  const driftedSelection = await reviseWorkspaceGroundedEvidence(
    { id: fixture.ownerId, name: "Grounded revision owner" },
    fixture.organizationId,
    reanchoredId,
    {
      clientOperationId: `revision-drift-${randomUUID()}`,
      expectedVersion: reanchored.aggregateVersion,
      action: "reanchor",
      selection: replacementSelection,
    },
  );
  assert.equal(driftedSelection.ok, false);
  if (!driftedSelection.ok) assert.equal(driftedSelection.code, "selection_conflict");
  assert.equal(
    (await prisma.organization.findUniqueOrThrow({
      where: { id: fixture.organizationId },
      select: { revision: true },
    })).revision,
    reanchored.aggregateVersion,
  );

  const raceVersion = reanchored.aggregateVersion;
  const raceResults = await Promise.all([
    reviseWorkspaceGroundedEvidence(
      { id: fixture.ownerId, name: "Grounded revision owner" },
      fixture.organizationId,
      reanchoredId,
      {
        clientOperationId: `revision-race-a-${randomUUID()}`,
        expectedVersion: raceVersion,
        action: "verify",
      },
    ),
    reviseWorkspaceGroundedEvidence(
      { id: fixture.ownerId, name: "Grounded revision owner" },
      fixture.organizationId,
      reanchoredId,
      {
        clientOperationId: `revision-race-b-${randomUUID()}`,
        expectedVersion: raceVersion,
        action: "verify",
      },
    ),
  ]);
  const raceSuccesses = raceResults.filter((result) => result.ok);
  const raceFailures = raceResults.filter((result) => !result.ok);
  assert.equal(raceSuccesses.length, 1);
  assert.equal(raceFailures.length, 1);
  assert.ok(
    raceFailures.every((result) => !result.ok && result.code === "revision_conflict"),
  );
  assert.equal(await prisma.evidenceNote.count({
    where: { organizationId: fixture.organizationId, supersedesId: reanchoredId },
  }), 1);
  const raceWinner = raceSuccesses[0];
  assert.ok(raceWinner?.ok);
  if (!raceWinner?.ok) throw new Error("Expected one evidence revision race winner.");

  // A corrupt/imported future timestamp must not cause equal or backdated
  // successor chronology. The service advances by at least one millisecond
  // and aligns the review timestamp with the admitted VERIFIED revision.
  const futureRootId = fixtureId("evidence", "future-root", randomUUID());
  const futureCreatedAt = new Date(Date.now() + 60_000);
  const futureClaim = "A future-dated imported root still has strict successor chronology.";
  await prisma.$transaction(async (transaction) => {
    await transaction.evidenceNote.create({
      data: {
        id: futureRootId,
        organizationId: fixture.organizationId,
        workspacePaperId: fixture.workspacePaperId,
        projectId,
        documentId: originalReader.document.id,
        documentChunkId: originalChunk.id,
        createdById: fixture.ownerId,
        kind: "QUOTE",
        status: "CAPTURED",
        confidence: "MEDIUM",
        title: "Future chronology fixture",
        claim: futureClaim,
        evidence: originalQuote,
        interpretation: "The test exercises server chronology, not wall-clock trust.",
        linkedHighlightIds: [],
        tags: ["chronology"],
        quote: originalQuote,
        text: futureClaim,
        pageStart: 1,
        pageEnd: 1,
        paragraphId: originalChunk.paragraphId,
        groundingVersion: 1,
        createdAt: futureCreatedAt,
      },
    });
    await transaction.projectEvidenceNote.create({
      data: {
        organizationId: fixture.organizationId,
        projectId,
        evidenceNoteId: futureRootId,
      },
    });
    await transaction.evidenceTextAnchor.create({
      data: {
        organizationId: fixture.organizationId,
        evidenceNoteId: futureRootId,
        workspacePaperId: fixture.workspacePaperId,
        documentId: originalReader.document.id,
        extractionId: originalReader.generation.id,
        schemaVersion: 1,
        manifestSha256: originalReader.generation.manifestSha256,
        startChunkId: originalChunk.id,
        endChunkId: originalChunk.id,
        startSequence: originalChunk.sequence,
        endSequence: originalChunk.sequence,
        startByteOffset: originalSelection.start.byteOffset,
        endByteOffset: originalSelection.end.byteOffset,
        startContentHash: originalChunk.contentHash,
        endContentHash: originalChunk.contentHash,
        quoteText: originalQuote,
        quoteSha256: digest(originalQuote),
        pageStart: 1,
        pageEnd: 1,
        paragraphStartId: originalChunk.paragraphId,
        paragraphEndId: originalChunk.paragraphId,
      },
    });
    await transaction.provenanceRecord.createMany({
      data: [
        {
          organizationId: fixture.organizationId,
          kind: "USER_ASSERTION",
          paperId: fixture.paperId,
          workspacePaperId: fixture.workspacePaperId,
          evidenceNoteId: futureRootId,
          documentId: originalReader.document.id,
          actorUserId: fixture.ownerId,
          sourceProvider: "PaperPilot Reader",
          sourceRecordId: originalReader.generation.id,
          retrievedAt: new Date(),
          payload: {
            schemaVersion: 2,
            provenance: {
              sourceType: "uploaded-file",
              sourceId: originalReader.generation.id,
              sourceTitle: "Grounded revision chronology fixture",
              providerName: "PaperPilot Reader",
              retrievedAt: new Date().toISOString(),
              accessMethod: "upload",
              locator: { paperId: fixture.paperId, page: 1, paragraphId: originalChunk.paragraphId },
              excerpt: originalQuote,
              version: `manifest:${originalReader.generation.manifestSha256}`,
            },
          },
        },
        {
          organizationId: fixture.organizationId,
          kind: "EXTRACTION",
          paperId: fixture.paperId,
          workspacePaperId: fixture.workspacePaperId,
          evidenceNoteId: futureRootId,
          documentId: originalReader.document.id,
          actorUserId: fixture.ownerId,
          sourceProvider: "PaperPilot Reader",
          sourceRecordId: originalReader.generation.id,
          retrievedAt: new Date(),
          payload: {
            schemaVersion: 1,
            documentId: originalReader.document.id,
            extractionId: originalReader.generation.id,
            manifestSha256: originalReader.generation.manifestSha256,
            quoteSha256: digest(originalQuote),
          },
        },
      ],
    });
  });
  const futureVerifyOperationId = `revision-future-verify-${randomUUID()}`;
  const futureVerified = await reviseWorkspaceGroundedEvidence(
    { id: fixture.memberId, name: "Grounded revision member" },
    fixture.organizationId,
    futureRootId,
    {
      clientOperationId: futureVerifyOperationId,
      expectedVersion: raceWinner.aggregateVersion,
      action: "verify",
    },
  );
  assert.equal(futureVerified.ok, true);
  if (!futureVerified.ok) throw new Error("Expected future-dated root verification to succeed.");
  const storedFutureSuccessor = await prisma.evidenceNote.findUniqueOrThrow({
    where: { id: futureVerified.data.note.id },
  });
  assert.ok(storedFutureSuccessor.createdAt.getTime() > futureCreatedAt.getTime());
  assert.equal(
    storedFutureSuccessor.verifiedAt?.getTime(),
    storedFutureSuccessor.createdAt.getTime(),
  );

  const provenance = await prisma.provenanceRecord.findMany({
    where: {
      organizationId: fixture.organizationId,
      evidenceNoteId: { in: [rootId, verifiedId, reanchoredId] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const rootAssertion = provenance.find(
    (record) => record.evidenceNoteId === rootId && record.kind === "USER_ASSERTION",
  );
  const verifiedAssertion = provenance.find(
    (record) => record.evidenceNoteId === verifiedId && record.kind === "USER_ASSERTION",
  );
  const reanchoredAssertion = provenance.find(
    (record) => record.evidenceNoteId === reanchoredId && record.kind === "USER_ASSERTION",
  );
  const rootExtraction = provenance.find(
    (record) => record.evidenceNoteId === rootId && record.kind === "EXTRACTION",
  );
  const verifiedExtraction = provenance.find(
    (record) => record.evidenceNoteId === verifiedId && record.kind === "EXTRACTION",
  );
  const reanchoredExtraction = provenance.find(
    (record) => record.evidenceNoteId === reanchoredId && record.kind === "EXTRACTION",
  );
  assert.ok(rootAssertion);
  assert.ok(verifiedAssertion);
  assert.ok(reanchoredAssertion);
  assert.ok(rootExtraction);
  assert.ok(verifiedExtraction);
  assert.ok(reanchoredExtraction);
  assert.equal(verifiedAssertion?.supersedesId, rootAssertion?.id);
  assert.equal(reanchoredAssertion?.supersedesId, verifiedAssertion?.id);
  assert.equal(verifiedExtraction?.supersedesId, rootExtraction?.id);
  assert.equal(reanchoredExtraction?.supersedesId, verifiedExtraction?.id);
  assert.equal(verifiedAssertion.retrievedAt?.getTime(), rootAssertion.retrievedAt?.getTime());
  assert.equal(verifiedAssertion.sourceProvider, rootAssertion.sourceProvider);
  assert.equal(verifiedAssertion.sourceRecordId, rootAssertion.sourceRecordId);
  assert.equal(verifiedAssertion.sourceUri, rootAssertion.sourceUri);
  assert.equal(verifiedExtraction.retrievedAt?.getTime(), rootExtraction.retrievedAt?.getTime());
  assert.equal(verifiedExtraction.sourceProvider, rootExtraction.sourceProvider);
  assert.equal(verifiedExtraction.sourceRecordId, rootExtraction.sourceRecordId);
  assert.equal(verifiedExtraction.sourceUri, rootExtraction.sourceUri);

  const rootAssertionPayload = { ...jsonRecord(rootAssertion.payload) };
  const verifiedAssertionPayload = { ...jsonRecord(verifiedAssertion.payload) };
  delete rootAssertionPayload.revision;
  delete verifiedAssertionPayload.revision;
  assert.deepEqual(verifiedAssertionPayload, rootAssertionPayload);
  assert.notEqual(
    jsonRecord(verifiedAssertionPayload.grounding)?.state,
    "historical",
  );

  const rootExtractionPayload = { ...jsonRecord(rootExtraction.payload) };
  const verifiedExtractionPayload = { ...jsonRecord(verifiedExtraction.payload) };
  delete rootExtractionPayload.revision;
  delete verifiedExtractionPayload.revision;
  assert.deepEqual(verifiedExtractionPayload, rootExtractionPayload);

  await prisma.project.update({
    where: { id: projectId },
    data: { visibility: "PRIVATE" },
  });
  const revokedReplay = await reviseWorkspaceGroundedEvidence(
    { id: fixture.memberId, name: "Grounded revision member" },
    fixture.organizationId,
    futureRootId,
    {
      clientOperationId: futureVerifyOperationId,
      expectedVersion: raceWinner.aggregateVersion,
      action: "verify",
    },
  );
  assert.equal(revokedReplay.ok, false);
  if (!revokedReplay.ok) assert.equal(revokedReplay.code, "not_found");
  const privateDenied = await reviseWorkspaceGroundedEvidence(
    { id: fixture.memberId, name: "Grounded revision member" },
    fixture.organizationId,
    raceWinner.data.note.id,
    {
      clientOperationId: `revision-private-${randomUUID()}`,
      expectedVersion: raceWinner.aggregateVersion,
      action: "verify",
    },
  );
  assert.equal(privateDenied.ok, false);
  if (!privateDenied.ok) assert.equal(privateDenied.code, "not_found");

  const other = await createReaderFixture("grounded-revision-cross-tenant", {
    withDocument: false,
  });
  const crossTenantDenied = await reviseWorkspaceGroundedEvidence(
    { id: other.ownerId, name: "Other workspace owner" },
    other.organizationId,
    raceWinner.data.note.id,
    {
      clientOperationId: `revision-cross-tenant-${randomUUID()}`,
      expectedVersion: 0,
      action: "verify",
    },
  );
  assert.equal(crossTenantDenied.ok, false);
  if (!crossTenantDenied.ok) assert.equal(crossTenantDenied.code, "not_found");
  await assert.rejects(
    reviseWorkspaceGroundedEvidence(
      { id: fixture.outsiderId, name: "Grounded revision outsider" },
      fixture.organizationId,
      raceWinner.data.note.id,
      {
        clientOperationId: `revision-outsider-${randomUUID()}`,
        expectedVersion: raceWinner.aggregateVersion,
        action: "verify",
      },
    ),
    (error: unknown) => error instanceof HttpProblem
      && error.status === 404
      && error.code === "workspace_not_found",
  );
});

test("reader authorization conceals non-members, hidden project papers, and cross-tenant IDs", async () => {
  const fixture = await createReaderFixture("visibility");
  await createExtractionJob(fixture, "visibility-queued", { status: "QUEUED" });
  assertState(
    await getWorkspacePaperReader(fixture.memberId, fixture.organizationId, fixture.paperId),
    "processing",
  );
  await assertPaperNotFound(
    getWorkspacePaperReader(fixture.outsiderId, fixture.organizationId, fixture.paperId),
  );
  await assertPaperNotFound(
    getWorkspacePaperReader(fixture.ownerId, fixture.organizationId, "paper id with whitespace"),
  );
  await assertPaperNotFound(
    getWorkspacePaperReader("x".repeat(201), fixture.organizationId, fixture.paperId),
  );

  const privateProjectId = fixtureId("private-project", "visibility", randomUUID());
  await prisma.$transaction(async (transaction) => {
    await transaction.project.create({
      data: {
        id: privateProjectId,
        organizationId: fixture.organizationId,
        name: "Owner private project",
        slug: `owner-private-${randomUUID()}`,
        visibility: "PRIVATE",
        createdById: fixture.ownerId,
      },
    });
    await transaction.projectPaper.create({
      data: {
        organizationId: fixture.organizationId,
        projectId: privateProjectId,
        workspacePaperId: fixture.workspacePaperId,
        addedById: fixture.ownerId,
      },
    });
  });
  await assertPaperNotFound(
    getWorkspacePaperReader(fixture.memberId, fixture.organizationId, fixture.paperId),
  );
  assertState(
    await getWorkspacePaperReader(fixture.ownerId, fixture.organizationId, fixture.paperId),
    "processing",
  );

  const workspaceProjectId = fixtureId("workspace-project", "visibility", randomUUID());
  await prisma.$transaction(async (transaction) => {
    await transaction.project.create({
      data: {
        id: workspaceProjectId,
        organizationId: fixture.organizationId,
        name: "Visible project",
        slug: `workspace-visible-${randomUUID()}`,
        visibility: "WORKSPACE",
        createdById: fixture.ownerId,
      },
    });
    await transaction.projectPaper.create({
      data: {
        organizationId: fixture.organizationId,
        projectId: workspaceProjectId,
        workspacePaperId: fixture.workspacePaperId,
        addedById: fixture.ownerId,
      },
    });
  });
  assertState(
    await getWorkspacePaperReader(fixture.memberId, fixture.organizationId, fixture.paperId),
    "processing",
  );

  const other = await createReaderFixture("cross-tenant", { withDocument: false });
  await assertPaperNotFound(
    getWorkspacePaperReader(other.ownerId, fixture.organizationId, fixture.paperId),
  );
  await assertPaperNotFound(
    getWorkspacePaperReader(fixture.ownerId, other.organizationId, fixture.paperId),
  );
  await assertPaperNotFound(
    getWorkspacePaperReader(fixture.ownerId, fixture.organizationId, other.paperId),
  );
});

test("reader fails closed for absent, unready, unlinked, and drifted document custody", async () => {
  const absent = await createReaderFixture("absent", { withDocument: false });
  assert.deepEqual(
    await getWorkspacePaperReader(absent.ownerId, absent.organizationId, absent.paperId),
    { schemaVersion: 1, state: "unavailable" },
  );

  const unready = await createReaderFixture("unready", { documentStatus: "PENDING" });
  assert.deepEqual(
    await getWorkspacePaperReader(unready.ownerId, unready.organizationId, unready.paperId),
    { schemaVersion: 1, state: "unavailable" },
  );

  const unlinked = await createReaderFixture("unlinked");
  await prisma.documentAsset.deleteMany({
    where: { organizationId: unlinked.organizationId, documentId: unlinked.documentId },
  });
  assert.deepEqual(
    await getWorkspacePaperReader(unlinked.ownerId, unlinked.organizationId, unlinked.paperId),
    { schemaVersion: 1, state: "unavailable" },
  );

  const ambiguous = await createReaderFixture("ambiguous-original");
  const secondAssetId = fixtureId("asset-second", "ambiguous-original", randomUUID());
  await assert.rejects(
    prisma.$transaction(async (transaction) => {
      await transaction.asset.create({
        data: {
          id: secondAssetId,
          organizationId: ambiguous.organizationId,
          storageProvider: "LOCAL",
          objectKey: `${STORAGE_VERSION}:${ambiguous.organizationId}:${secondAssetId}`,
          physicalLocator: `${STORAGE_VERSION}:${ambiguous.organizationId}:${secondAssetId}`,
          status: "QUARANTINED",
          mimeType: "application/pdf",
        },
      });
      await transaction.documentAsset.create({
        data: {
          organizationId: ambiguous.organizationId,
          documentId: ambiguous.documentId,
          assetId: secondAssetId,
          role: "ORIGINAL",
        },
      });
    }),
    (error: unknown) => error instanceof Error
      && error.message.includes("DocumentAsset_one_original_per_document"),
    "PostgreSQL must reject an ambiguous second ORIGINAL before Reader admission",
  );
  assertState(
    await getWorkspacePaperReader(ambiguous.ownerId, ambiguous.organizationId, ambiguous.paperId),
    "unavailable",
  );

  const drifted = await createReaderFixture("drifted");
  await prisma.asset.update({
    where: { id: drifted.assetId },
    data: { sha256: digest("replacement bytes") },
  });
  assert.deepEqual(
    await getWorkspacePaperReader(drifted.ownerId, drifted.organizationId, drifted.paperId),
    { schemaVersion: 1, state: "unavailable" },
  );
  await prisma.asset.update({
    where: { id: drifted.assetId },
    data: {
      sha256: drifted.inputSha256,
      sizeBytes: drifted.inputSizeBytes + 1n,
    },
  });
  assert.deepEqual(
    await getWorkspacePaperReader(drifted.ownerId, drifted.organizationId, drifted.paperId),
    { schemaVersion: 1, state: "unavailable" },
  );
  await prisma.asset.update({
    where: { id: drifted.assetId },
    data: {
      sizeBytes: drifted.inputSizeBytes,
      validationPolicyVersion: "superseded-validation-policy",
    },
  });
  assert.deepEqual(
    await getWorkspacePaperReader(drifted.ownerId, drifted.organizationId, drifted.paperId),
    { schemaVersion: 1, state: "unavailable" },
  );
  await prisma.asset.update({
    where: { id: drifted.assetId },
    data: {
      validationPolicyVersion: VALIDATION_POLICY,
      scannedAt: plusMilliseconds(SCANNED_AT, 1),
    },
  });
  assert.deepEqual(
    await getWorkspacePaperReader(drifted.ownerId, drifted.organizationId, drifted.paperId),
    { schemaVersion: 1, state: "unavailable" },
  );
  await prisma.asset.update({
    where: { id: drifted.assetId },
    data: {
      scannedAt: SCANNED_AT,
      validatedAt: plusMilliseconds(VALIDATION_CHECKED_AT, 1),
    },
  });
  assert.deepEqual(
    await getWorkspacePaperReader(drifted.ownerId, drifted.organizationId, drifted.paperId),
    { schemaVersion: 1, state: "unavailable" },
  );

  const custodyDrift = await createReaderFixture("custody-drift");
  await prisma.asset.update({
    where: { id: custodyDrift.assetId },
    data: { objectKey: `foreign:${custodyDrift.organizationId}:${custodyDrift.assetId}` },
  });
  assert.deepEqual(
    await getWorkspacePaperReader(
      custodyDrift.ownerId,
      custodyDrift.organizationId,
      custodyDrift.paperId,
    ),
    { schemaVersion: 1, state: "unavailable" },
  );

  const mediaDrift = await createReaderFixture("media-drift");
  await prisma.document.update({
    where: { id: mediaDrift.documentId },
    data: { mimeType: "application/octet-stream" },
  });
  assert.deepEqual(
    await getWorkspacePaperReader(mediaDrift.ownerId, mediaDrift.organizationId, mediaDrift.paperId),
    { schemaVersion: 1, state: "unavailable" },
  );

  const processing = await createReaderFixture("processing");
  await createExtractionJob(processing, "processing-queued", { status: "QUEUED" });
  const response = await getWorkspacePaperReader(
    processing.ownerId,
    processing.organizationId,
    processing.paperId,
  );
  assertState(response, "processing");
  assert.deepEqual(Object.keys(response).sort(), [
    "document",
    "extractionPolicyVersion",
    "schemaVersion",
    "state",
  ]);
  assert.equal(response.extractionPolicyVersion, DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION);
  assert.equal(response.document.inputSizeBytes, processing.inputSizeBytes.toString());
  assert.equal(response.document.validationAttestationId, processing.validationAttestationId);
});

test("reader reports processing only for an exact active extraction job", async () => {
  const absent = await createReaderFixture("job-absent");
  assert.deepEqual(
    await getWorkspacePaperReader(absent.ownerId, absent.organizationId, absent.paperId),
    { schemaVersion: 1, state: "unavailable" },
  );

  for (const status of ["QUEUED", "RETRYING", "RUNNING"] as const) {
    const fixture = await createReaderFixture(`job-active-${status.toLowerCase()}`);
    await createExtractionJob(fixture, `job-active-${status.toLowerCase()}`, {
      status,
      attempts: status === "QUEUED" ? 0 : 1,
    });
    assertState(
      await getWorkspacePaperReader(fixture.ownerId, fixture.organizationId, fixture.paperId),
      "processing",
    );
  }

  const malformedRetry = await createReaderFixture("job-malformed-retry");
  await createExtractionJob(malformedRetry, "job-malformed-retry", {
    status: "RETRYING",
    attempts: 0,
  });
  assert.deepEqual(
    await getWorkspacePaperReader(
      malformedRetry.ownerId,
      malformedRetry.organizationId,
      malformedRetry.paperId,
    ),
    { schemaVersion: 1, state: "unavailable" },
  );

  const malformedId = await createReaderFixture("job-malformed-id");
  await createExtractionJob(malformedId, "job-malformed-id", {
    status: "QUEUED",
    attempts: 0,
    jobId: "malformed extraction job id",
  });
  assert.deepEqual(
    await getWorkspacePaperReader(
      malformedId.ownerId,
      malformedId.organizationId,
      malformedId.paperId,
    ),
    { schemaVersion: 1, state: "unavailable" },
  );

  for (const status of ["FAILED", "CANCELLED", "DEAD_LETTER"] as const) {
    const fixture = await createReaderFixture(`job-terminal-${status.toLowerCase()}`);
    await createExtractionJob(fixture, `job-terminal-${status.toLowerCase()}`, {
      status,
      attempts: 1,
    });
    assert.deepEqual(
      await getWorkspacePaperReader(fixture.ownerId, fixture.organizationId, fixture.paperId),
      { schemaVersion: 1, state: "unavailable" },
    );
  }

  const exhausted = await createReaderFixture("job-exhausted");
  await createExtractionJob(exhausted, "job-exhausted", {
    status: "RETRYING",
    attempts: 4,
    maxAttempts: 4,
  });
  assert.deepEqual(
    await getWorkspacePaperReader(exhausted.ownerId, exhausted.organizationId, exhausted.paperId),
    { schemaVersion: 1, state: "unavailable" },
  );

  const succeededWithoutGeneration = await createReaderFixture("job-succeeded-empty");
  await createExtractionJob(succeededWithoutGeneration, "job-succeeded-empty", {
    status: "SUCCEEDED",
    attempts: 1,
  });
  assert.deepEqual(
    await getWorkspacePaperReader(
      succeededWithoutGeneration.ownerId,
      succeededWithoutGeneration.organizationId,
      succeededWithoutGeneration.paperId,
    ),
    { schemaVersion: 1, state: "unavailable" },
  );

  const malformed = await createReaderFixture("job-malformed");
  await createExtractionJob(malformed, "job-malformed", {
    status: "QUEUED",
    payload: {
      schemaVersion: 1,
      source: "accepted-document-validation",
      validationAttestationId: malformed.validationAttestationId,
      policyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
      storageVersion: STORAGE_VERSION,
    },
  });
  assert.deepEqual(
    await getWorkspacePaperReader(malformed.ownerId, malformed.organizationId, malformed.paperId),
    { schemaVersion: 1, state: "unavailable" },
  );

  const wrongPolicy = await createReaderFixture("job-wrong-policy");
  await createExtractionJob(wrongPolicy, "job-wrong-policy", {
    status: "QUEUED",
    policyVersion: "paperpilot-text-extraction-v0",
  });
  assert.deepEqual(
    await getWorkspacePaperReader(wrongPolicy.ownerId, wrongPolicy.organizationId, wrongPolicy.paperId),
    { schemaVersion: 1, state: "unavailable" },
  );
});

test("latest current-policy NO_TEXT generation takes precedence over older extracted text", async () => {
  const fixture = await createReaderFixture("generation-precedence");
  const olderId = await createGeneration(fixture, "older-extracted", {
    verdict: "EXTRACTED",
    chunks: [{ pageNumber: 1, paragraphId: "p1-p1", text: "Older visible text." }],
    createdAt: new Date("2026-08-28T12:10:00.000Z"),
  });
  const newerId = await createGeneration(fixture, "newer-no-text", {
    verdict: "NO_TEXT",
    createdAt: new Date("2026-08-28T12:11:00.000Z"),
  });

  const response = await getWorkspacePaperReader(
    fixture.ownerId,
    fixture.organizationId,
    fixture.paperId,
  );
  assertState(response, "no-text");
  assert.equal(response.generation.id, newerId);
  assert.notEqual(response.generation.id, olderId);
  assert.equal(response.generation.verdict, "NO_TEXT");
  assert.deepEqual(Object.keys(response).sort(), ["document", "generation", "schemaVersion", "state"]);

  const otherPolicy = await createReaderFixture("policy-selection");
  const currentId = await createGeneration(otherPolicy, "current-policy", {
    verdict: "NO_TEXT",
    createdAt: new Date("2026-08-28T12:10:00.000Z"),
  });
  await createGeneration(otherPolicy, "future-policy", {
    verdict: "EXTRACTED",
    chunks: [{ pageNumber: 1, paragraphId: "p1-p1", text: "Future-policy text." }],
    policyVersion: "paperpilot-text-extraction-v2",
    createdAt: new Date("2026-08-28T12:12:00.000Z"),
  });
  const currentResponse = await getWorkspacePaperReader(
    otherPolicy.ownerId,
    otherPolicy.organizationId,
    otherPolicy.paperId,
  );
  assertState(currentResponse, "no-text");
  assert.equal(currentResponse.generation.id, currentId);
});

test("ready reader pages use generation-bound opaque cursors, preserve locators, and cap serialized bytes", async () => {
  const fixture = await createReaderFixture("pagination");
  const chunks: GenerationChunk[] = Array.from({ length: 125 }, (_, sequence) => ({
    pageNumber: sequence < 75 ? 1 : 2,
    paragraphId: sequence < 75 ? "p1-p1" : "p2-p1",
    text: `Chunk ${sequence.toString().padStart(3, "0")} has deterministic page-local text.`,
  }));
  const extractionId = await createGeneration(fixture, "pagination", {
    verdict: "EXTRACTED",
    chunks,
    createdAt: new Date("2026-08-28T12:20:00.000Z"),
  });

  const first = await getWorkspacePaperReader(
    fixture.memberId,
    fixture.organizationId,
    fixture.paperId,
  );
  assertState(first, "ready");
  assert.equal(first.generation.id, extractionId);
  assert.equal(first.chunks.length, DEFAULT_READER_PAGE_LIMIT);
  assert.match(first.nextCursor ?? "", /^r1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(first).sort(), [
    "chunks",
    "document",
    "generation",
    "nextCursor",
    "schemaVersion",
    "state",
  ]);
  assert.deepEqual(Object.keys(first.document).sort(), [
    "assetId",
    "id",
    "inputSha256",
    "inputSizeBytes",
    "pageCount",
    "paperId",
    "validatedAt",
    "validationAttestationId",
    "validationPolicyVersion",
    "workspacePaperId",
  ]);
  assert.deepEqual(Object.keys(first.generation).sort(), [
    "admittedAt",
    "checkedAt",
    "chunkCount",
    "completedAt",
    "engine",
    "engineVersion",
    "extractedAt",
    "id",
    "manifestSchemaVersion",
    "manifestSha256",
    "pageCount",
    "policyVersion",
    "textBytes",
    "toolchainDigest",
    "validationAttestationId",
    "verdict",
  ]);
  assert.deepEqual(first.chunks.map((chunk) => chunk.sequence), Array.from({ length: 50 }, (_, i) => i));
  assert.deepEqual(first.chunks[0]?.locator, {
    schemaVersion: 1,
    kind: "pdf-text",
    pageNumber: 1,
    paragraphId: "p1-p1",
  });
  assert.deepEqual(Object.keys(first.chunks[0] ?? {}).sort(), [
    "contentHash",
    "id",
    "locator",
    "pageNumber",
    "paragraphId",
    "sequence",
    "text",
  ]);
  assert.deepEqual(Object.keys(first.chunks[0]?.locator ?? {}).sort(), [
    "kind",
    "pageNumber",
    "paragraphId",
    "schemaVersion",
  ]);

  const second = await getWorkspacePaperReader(
    fixture.memberId,
    fixture.organizationId,
    fixture.paperId,
    new URLSearchParams({ cursor: first.nextCursor ?? "", limit: "50" }),
  );
  assertState(second, "ready");
  assert.equal(second.chunks[0]?.sequence, 50);
  assert.equal(second.chunks.at(-1)?.sequence, 99);
  assert.match(second.nextCursor ?? "", /^r1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.notEqual(second.nextCursor, first.nextCursor);
  const last = await getWorkspacePaperReader(
    fixture.memberId,
    fixture.organizationId,
    fixture.paperId,
    new URLSearchParams({ cursor: second.nextCursor ?? "", limit: "100" }),
  );
  assertState(last, "ready");
  assert.equal(last.chunks.length, 25);
  assert.equal(last.chunks[0]?.sequence, 100);
  assert.equal(last.chunks.at(-1)?.sequence, 124);
  assert.equal(last.nextCursor, null);

  const escapedFixture = await createReaderFixture("response-cap");
  const escapedChunks: GenerationChunk[] = Array.from({ length: 100 }, () => ({
    pageNumber: 1,
    paragraphId: "p1-p1",
    text: `quoted \\\"${"x".repeat(8_150)}\\\"`,
  }));
  await createGeneration(escapedFixture, "response-cap", {
    verdict: "EXTRACTED",
    chunks: escapedChunks,
  });
  const bounded = await getWorkspacePaperReader(
    escapedFixture.ownerId,
    escapedFixture.organizationId,
    escapedFixture.paperId,
    new URLSearchParams("limit=100"),
  );
  assertState(bounded, "ready");
  assert.ok(bounded.chunks.length < 100);
  assert.ok(bounded.chunks.length > 0);
  assert.match(bounded.nextCursor ?? "", /^r1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= MAX_READER_SERIALIZED_BYTES);

  await assert.rejects(
    getWorkspacePaperReader(
      fixture.ownerId,
      fixture.organizationId,
      fixture.paperId,
      new URLSearchParams({ cursor: first.nextCursor ?? "" }),
    ),
    (error: unknown) => error instanceof HttpProblem
      && error.status === 400
      && error.code === "validation",
    "a cursor cannot be replayed by a different authorized user",
  );

  await createGeneration(fixture, "pagination-new-generation", {
    verdict: "EXTRACTED",
    chunks: [{ pageNumber: 1, paragraphId: "p1-p1", text: "Replacement generation." }],
    createdAt: new Date("2026-08-28T12:30:00.000Z"),
  });
  await assert.rejects(
    getWorkspacePaperReader(
      fixture.memberId,
      fixture.organizationId,
      fixture.paperId,
      new URLSearchParams({ cursor: first.nextCursor ?? "" }),
    ),
    (error: unknown) => error instanceof HttpProblem
      && error.status === 409
      && error.code === "reader_cursor_stale",
    "a continuation cannot splice into a newly authoritative generation",
  );
});

test("reader query and extraction policy parsers reject non-canonical or unknown input", () => {
  assert.deepEqual(parseReaderPageQuery(new URLSearchParams()), {
    cursor: null,
    limit: DEFAULT_READER_PAGE_LIMIT,
  });
  const shapedCursor = `r1.${"p".repeat(40)}.${"s".repeat(43)}`;
  assert.deepEqual(parseReaderPageQuery(new URLSearchParams({ cursor: shapedCursor, limit: "100" })), {
    cursor: shapedCursor,
    limit: 100,
  });
  for (const query of [
    "unknown=1",
    "cursor=1&cursor=2",
    "limit=1&limit=2",
    "cursor=1",
    "cursor=r1.payload=.signature",
    `cursor=r1.${"p".repeat(470)}.${"s".repeat(43)}`,
    "limit=0",
    "limit=01",
    "limit=101",
    "limit=1.0",
  ]) {
    assert.throws(() => parseReaderPageQuery(new URLSearchParams(query)), (error: unknown) => {
      assert.ok(error instanceof HttpProblem);
      assert.equal(error.status, 400);
      assert.equal(error.code, "validation");
      return true;
    }, query);
  }
  assert.equal(
    readerExtractionPolicyVersion({}),
    DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
  );
  assert.equal(
    readerExtractionPolicyVersion({ PAPERPILOT_EXTRACTION_POLICY_VERSION: "extractor.v2" }),
    "extractor.v2",
  );
  for (const value of ["", " leading", "trailing ", "contains/slash", "x".repeat(129)]) {
    assert.throws(
      () => readerExtractionPolicyVersion({ PAPERPILOT_EXTRACTION_POLICY_VERSION: value }),
      /PAPERPILOT_EXTRACTION_POLICY_VERSION/,
    );
  }
});
