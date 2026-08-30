import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Client } from "pg";

import { Prisma } from "@/generated/prisma/client";
import { validatedPaperPilotApplicationDatabaseUrl } from "@/lib/postgres-connection-url.mjs";
import { prisma } from "@/lib/prisma";

const VALIDATION_POLICY = "paperpilot-document-validation-v1";
const EXTRACTION_POLICY = "paperpilot-text-extraction-v1";
const STORAGE_VERSION = "local/quarantine+v2";
const VALIDATION_TOOLCHAIN = "a".repeat(64);
const EXTRACTION_TOOLCHAIN = "b".repeat(64);
const VALIDATION_CHECKED_AT = new Date("2026-08-28T12:00:00.000Z");
const SCANNED_AT = new Date("2026-08-28T11:59:00.000Z");
const SIGNATURE_PUBLISHED_AT = new Date("2026-08-28T10:00:00.000Z");
const EXTRACTED_AT = new Date("2026-08-28T12:00:01.000Z");
const EXTRACTION_COMPLETED_AT = new Date("2026-08-28T12:00:02.000Z");
const EXTRACTION_CHECKED_AT = new Date("2026-08-28T12:00:03.000Z");
const PREDECESSOR_CREATED_AT = new Date("2026-08-28T18:00:00.000Z");

const FIRST_TEXT = "Prefix 😀 q\u0307 finding";
const SECOND_TEXT = "continued café result";
const START_BYTE_OFFSET = Buffer.byteLength("Prefix ");
const END_TEXT = "continued café";
const END_BYTE_OFFSET = Buffer.byteLength(END_TEXT);
const EXPECTED_QUOTE = `${Buffer.from(FIRST_TEXT, "utf8")
  .subarray(START_BYTE_OFFSET)
  .toString("utf8")}\n\n${END_TEXT}`;

interface ChunkFixture {
  id: string;
  sequence: number;
  pageStart: number;
  pageEnd: number;
  paragraphId: string;
  text: string;
  contentHash: string;
}

interface GroundedFixture {
  organizationId: string;
  paperId: string;
  workspacePaperId: string;
  projectId: string;
  documentId: string;
  extractionId: string;
  manifestSha256: string;
  chunks: [ChunkFixture, ChunkFixture];
}

interface GroundedCreateOptions {
  noteId?: string;
  anchorId?: string;
  note?: Partial<Prisma.EvidenceNoteUncheckedCreateInput>;
  anchor?: Partial<Prisma.EvidenceTextAnchorUncheckedCreateInput>;
}

const organizationIds = new Set<string>();
const paperIds = new Set<string>();

after(async () => {
  await prisma.$disconnect();
});

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceLocator(pageNumber: number, paragraphId: string) {
  return {
    schemaVersion: 1,
    kind: "pdf-text",
    pageNumber,
    paragraphId,
  };
}

function errorDetails(error: unknown): string {
  const details: string[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || current === undefined || seen.has(current)) continue;
    if (typeof current === "string" || typeof current === "number") {
      details.push(String(current));
      continue;
    }
    if (typeof current !== "object") continue;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      let value: unknown;
      try {
        value = Reflect.get(current, key);
      } catch {
        continue;
      }
      if (
        typeof value === "string"
        && ["message", "code", "originalCode", "sqlState", "constraint", "database_error"]
          .includes(String(key))
      ) {
        details.push(value);
      }
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return details.join("\n");
}

function isInvariantFailure(error: unknown): boolean {
  const details = errorDetails(error);
  return (
    error instanceof Prisma.PrismaClientKnownRequestError
    && ["P2002", "P2003", "P2010"].includes(error.code)
  ) || ["22021", "22023", "23503", "23505", "23514", "55000"]
    .some((state) => details.includes(state));
}

async function rejectsInvariant(
  name: string,
  operation: () => Promise<unknown>,
  expectedDetail?: string,
): Promise<void> {
  try {
    await assert.rejects(operation, (error: unknown) => {
      if (!isInvariantFailure(error)) return false;
      return expectedDetail === undefined || errorDetails(error).includes(expectedDetail);
    }, name);
  } finally {
    // PGlite's PostgreSQL protocol can retain a failed unnamed prepared
    // statement after an intentional deferred-constraint error. Reconnect so
    // one negative assertion cannot contaminate the next invariant check.
    await prisma.$disconnect();
  }
}

async function createFixture(label: string): Promise<GroundedFixture> {
  const suffix = randomUUID();
  const organizationId = `grounded-integrity-org-${label}-${suffix}`;
  const paperId = `grounded-integrity-paper-${label}-${suffix}`;
  const workspacePaperId = `grounded-integrity-workspace-paper-${label}-${suffix}`;
  const projectId = `grounded-integrity-project-${label}-${suffix}`;
  const documentId = `grounded-integrity-document-${label}-${suffix}`;
  const assetId = `grounded-integrity-asset-${label}-${suffix}`;
  const intakeId = `grounded-integrity-intake-${label}-${suffix}`;
  const ingressJobId = `grounded-integrity-ingress-job-${label}-${suffix}`;
  const ingressJobAttemptId = `grounded-integrity-ingress-job-attempt-${label}-${suffix}`;
  const ingressAttemptId = `grounded-integrity-ingress-attempt-${label}-${suffix}`;
  const ingestReceiptId = `grounded-integrity-ingest-${label}-${suffix}`;
  const validationJobId = `grounded-integrity-validation-job-${label}-${suffix}`;
  const validationAttemptId = `grounded-integrity-validation-attempt-${label}-${suffix}`;
  const validationAttestationId = `grounded-integrity-attestation-${label}-${suffix}`;
  const extractionJobId = `grounded-integrity-extraction-job-${label}-${suffix}`;
  const extractionAttemptId = `grounded-integrity-extraction-attempt-${label}-${suffix}`;
  const extractionId = `grounded-integrity-extraction-${label}-${suffix}`;
  const inputSha256 = digest(`${organizationId}:${documentId}`);
  const computedMd5 = createHash("md5")
    .update(`${organizationId}:${documentId}`)
    .digest("hex");
  const inputSizeBytes = 4_096n;
  const objectKey = `grounded-integrity/${organizationId}/${assetId}`;
  const chunks: [ChunkFixture, ChunkFixture] = [
    {
      id: `grounded-integrity-chunk-0-${label}-${suffix}`,
      sequence: 0,
      pageStart: 1,
      pageEnd: 1,
      paragraphId: "p1-p1",
      text: FIRST_TEXT,
      contentHash: digest(FIRST_TEXT),
    },
    {
      id: `grounded-integrity-chunk-1-${label}-${suffix}`,
      sequence: 1,
      pageStart: 2,
      pageEnd: 2,
      paragraphId: "p2-p1",
      text: SECOND_TEXT,
      contentHash: digest(SECOND_TEXT),
    },
  ];

  assert.equal(FIRST_TEXT.normalize("NFC"), FIRST_TEXT);
  assert.equal(SECOND_TEXT.normalize("NFC"), SECOND_TEXT);

  await prisma.$transaction(async (transaction) => {
    await transaction.organization.create({
      data: {
        id: organizationId,
        name: `Grounded integrity ${label}`,
        slug: `grounded-integrity-${label}-${suffix}`,
      },
    });
    await transaction.paper.create({
      data: { id: paperId, title: `Grounded integrity paper ${label}` },
    });
    await transaction.workspacePaper.create({
      data: { id: workspacePaperId, organizationId, paperId },
    });
    await transaction.project.create({
      data: {
        id: projectId,
        organizationId,
        name: `Grounded integrity project ${label}`,
        slug: `grounded-integrity-project-${label}-${suffix}`,
      },
    });
    await transaction.projectPaper.create({
      data: { organizationId, projectId, workspacePaperId },
    });
    await transaction.document.create({
      data: {
        id: documentId,
        organizationId,
        paperId,
        workspacePaperId,
        kind: "PAPER_PDF",
        status: "READY",
        mimeType: "application/pdf",
        pageCount: 2,
        contentHash: inputSha256,
        validatedAt: VALIDATION_CHECKED_AT,
        validationPolicyVersion: VALIDATION_POLICY,
      },
    });
    await transaction.asset.create({
      data: {
        id: assetId,
        organizationId,
        storageProvider: "LOCAL",
        objectKey,
        status: "READY",
        mimeType: "application/pdf",
        sizeBytes: inputSizeBytes,
        sha256: inputSha256,
        scannedAt: SCANNED_AT,
        validatedAt: VALIDATION_CHECKED_AT,
        validationPolicyVersion: VALIDATION_POLICY,
      },
    });
    await transaction.documentAsset.create({
      data: { organizationId, documentId, assetId, role: "ORIGINAL" },
    });
    await transaction.documentIntake.create({
      data: {
        id: intakeId,
        organizationId,
        source: "WEB_MCP",
        status: "READY",
        documentId,
        assetId,
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
        dedupeKey: `grounded-ingress:${label}:${suffix}`,
        documentId,
        assetId,
        intakeId,
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
        leaseId: `grounded-integrity-ingress-lease-${suffix}`,
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
        sourceFingerprint: `test-grounded-integrity:${label}:${suffix}`,
        intakeId,
        assetId,
        documentId,
        ingressAttemptId,
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
        dedupeKey: `grounded-validation:${label}:${suffix}`,
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
        maxAttempts: 3,
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
        toolchainDigest: VALIDATION_TOOLCHAIN,
        verdict: "ACCEPTED",
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
        pageCount: 2,
        objectCount: 12,
        revisionCount: 1,
        checkedAt: VALIDATION_CHECKED_AT,
        result: { schemaVersion: 1 },
      },
    });
    await transaction.job.create({
      data: {
        id: extractionJobId,
        organizationId,
        type: "TEXT_EXTRACTION",
        status: "SUCCEEDED",
        dedupeKey: `grounded-extraction:${label}:${suffix}`,
        documentId,
        assetId,
        attempts: 1,
        maxAttempts: 3,
        completedAt: EXTRACTION_CHECKED_AT,
      },
    });
    await transaction.jobAttempt.create({
      data: {
        id: extractionAttemptId,
        organizationId,
        jobId: extractionJobId,
        attemptNumber: 1,
        status: "SUCCEEDED",
        completedAt: EXTRACTION_CHECKED_AT,
      },
    });
    await transaction.documentTextExtraction.create({
      data: {
        id: extractionId,
        organizationId,
        jobId: extractionJobId,
        jobAttemptId: extractionAttemptId,
        validationAttestationId,
        assetId,
        documentId,
        inputSha256,
        inputSizeBytes,
        storageVersion: STORAGE_VERSION,
        extractionPolicyVersion: EXTRACTION_POLICY,
        toolchainDigest: EXTRACTION_TOOLCHAIN,
        verdict: "EXTRACTED",
        engine: "poppler",
        engineVersion: "26.05.0",
        pageCount: 2,
        chunkCount: chunks.length,
        textBytes: chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.text), 0),
        extractedAt: EXTRACTED_AT,
        completedAt: EXTRACTION_COMPLETED_AT,
        durationMs: 900,
        totalDurationMs: 1_100,
        checkedAt: EXTRACTION_CHECKED_AT,
        result: { schemaVersion: 1 },
      },
    });
    await transaction.documentTextChunk.createMany({
      data: chunks.map((chunk) => ({
        ...chunk,
        organizationId,
        documentId,
        extractionId,
        locator: sourceLocator(chunk.pageStart, chunk.paragraphId),
      })),
    });
  });

  organizationIds.add(organizationId);
  paperIds.add(paperId);
  const admission = await prisma.documentTextManifestAdmission.findUniqueOrThrow({
    where: { extractionId },
  });
  return {
    organizationId,
    paperId,
    workspacePaperId,
    projectId,
    documentId,
    extractionId,
    manifestSha256: admission.manifestSha256,
    chunks,
  };
}

function noteData(
  fixture: GroundedFixture,
  noteId: string,
): Prisma.EvidenceNoteUncheckedCreateInput {
  return {
    id: noteId,
    organizationId: fixture.organizationId,
    workspacePaperId: fixture.workspacePaperId,
    projectId: fixture.projectId,
    documentId: fixture.documentId,
    documentChunkId: fixture.chunks[0].id,
    kind: "CLAIM",
    status: "CAPTURED",
    confidence: "UNSPECIFIED",
    title: "Exact grounded result",
    claim: "The exact source range supports this claim.",
    evidence: EXPECTED_QUOTE,
    interpretation: "Interpretation remains distinct from source custody.",
    quote: EXPECTED_QUOTE,
    text: "The exact source range supports this claim.",
    pageStart: fixture.chunks[0].pageStart,
    pageEnd: fixture.chunks[1].pageEnd,
    paragraphId: fixture.chunks[0].paragraphId,
    verifiedAt: null,
    groundingVersion: 1,
    createdAt: PREDECESSOR_CREATED_AT,
  };
}

function anchorData(
  fixture: GroundedFixture,
  noteId: string,
  anchorId: string,
): Prisma.EvidenceTextAnchorUncheckedCreateInput {
  return {
    id: anchorId,
    organizationId: fixture.organizationId,
    evidenceNoteId: noteId,
    workspacePaperId: fixture.workspacePaperId,
    documentId: fixture.documentId,
    extractionId: fixture.extractionId,
    schemaVersion: 1,
    manifestSha256: fixture.manifestSha256,
    startChunkId: fixture.chunks[0].id,
    endChunkId: fixture.chunks[1].id,
    startSequence: fixture.chunks[0].sequence,
    endSequence: fixture.chunks[1].sequence,
    startByteOffset: START_BYTE_OFFSET,
    endByteOffset: END_BYTE_OFFSET,
    startContentHash: fixture.chunks[0].contentHash,
    endContentHash: fixture.chunks[1].contentHash,
    quoteText: EXPECTED_QUOTE,
    quoteSha256: digest(EXPECTED_QUOTE),
    pageStart: fixture.chunks[0].pageStart,
    pageEnd: fixture.chunks[1].pageEnd,
    paragraphStartId: fixture.chunks[0].paragraphId,
    paragraphEndId: fixture.chunks[1].paragraphId,
  };
}

async function createGroundedNote(
  fixture: GroundedFixture,
  options: GroundedCreateOptions = {},
) {
  const noteId = options.noteId ?? `grounded-integrity-note-${randomUUID()}`;
  const anchorId = options.anchorId ?? `grounded-integrity-anchor-${randomUUID()}`;
  return prisma.$transaction(async (transaction) => {
    const note = await transaction.evidenceNote.create({
      data: { ...noteData(fixture, noteId), ...options.note },
    });
    const anchor = await transaction.evidenceTextAnchor.create({
      data: { ...anchorData(fixture, noteId, anchorId), ...options.anchor },
    });
    return { note, anchor };
  });
}

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;
  assert.ok(value, "DATABASE_URL must be configured for integration tests");
  return validatedPaperPilotApplicationDatabaseUrl(value, {
    databaseProfile: process.env.PAPERPILOT_DATABASE_PROFILE,
  }).connectionString;
}

async function rejectsSplitUtf8Boundary(fixture: GroundedFixture): Promise<void> {
  const client = new Client({ connectionString: databaseUrl() });
  const noteId = `grounded-integrity-split-utf8-note-${randomUUID()}`;
  const anchor = anchorData(
    fixture,
    noteId,
    `grounded-integrity-split-utf8-anchor-${randomUUID()}`,
  );
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO "EvidenceNote" (
        "id", "organizationId", "workspacePaperId", "projectId",
        "documentId", "documentChunkId", "kind", "status", "confidence",
        "title", "claim", "evidence", "interpretation", "quote", "text",
        "pageStart", "pageEnd", "paragraphId", "verifiedAt",
        "groundingVersion", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $21
      )`,
      [
        noteId,
        fixture.organizationId,
        fixture.workspacePaperId,
        fixture.projectId,
        fixture.documentId,
        fixture.chunks[0].id,
        "CLAIM",
        "CAPTURED",
        "UNSPECIFIED",
        "Exact grounded result",
        "The exact source range supports this claim.",
        EXPECTED_QUOTE,
        "Interpretation remains distinct from source custody.",
        EXPECTED_QUOTE,
        "The exact source range supports this claim.",
        fixture.chunks[0].pageStart,
        fixture.chunks[1].pageEnd,
        fixture.chunks[0].paragraphId,
        null,
        1,
        PREDECESSOR_CREATED_AT,
      ],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO "EvidenceTextAnchor" (
          "id", "organizationId", "evidenceNoteId", "workspacePaperId",
          "documentId", "extractionId", "schemaVersion", "manifestSha256",
          "startChunkId", "endChunkId", "startSequence", "endSequence",
          "startByteOffset", "endByteOffset", "startContentHash",
          "endContentHash", "quoteText", "quoteSha256", "pageStart",
          "pageEnd", "paragraphStartId", "paragraphEndId"
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
        )`,
        [
          anchor.id,
          anchor.organizationId,
          anchor.evidenceNoteId,
          anchor.workspacePaperId,
          anchor.documentId,
          anchor.extractionId,
          anchor.schemaVersion,
          anchor.manifestSha256,
          anchor.startChunkId,
          anchor.endChunkId,
          anchor.startSequence,
          anchor.endSequence,
          START_BYTE_OFFSET + 1,
          anchor.endByteOffset,
          anchor.startContentHash,
          anchor.endContentHash,
          anchor.quoteText,
          anchor.quoteSha256,
          anchor.pageStart,
          anchor.pageEnd,
          anchor.paragraphStartId,
          anchor.paragraphEndId,
        ],
      ),
      (error: unknown) => errorDetails(error).includes("22021"),
      "an offset inside the emoji must be rejected as invalid UTF-8",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

async function deleteTenantRoot(
  organizationId: string,
  removeRetainedRecords: boolean,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query("BEGIN");
    if (removeRetainedRecords) {
      await client.query(
        `DELETE FROM "ProvenanceRecord" WHERE "organizationId" = $1`,
        [organizationId],
      );
      await client.query(
        `DELETE FROM "AuditEvent" WHERE "organizationId" = $1`,
        [organizationId],
      );
    }
    await client.query(`DELETE FROM "Organization" WHERE "id" = $1`, [organizationId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function cleanup(): Promise<void> {
  for (const organizationId of organizationIds) {
    // Provenance and audit records intentionally use retention-oriented foreign
    // keys. Remove them explicitly before exercising the tenant erasure path.
    await deleteTenantRoot(organizationId, true);
  }
  if (paperIds.size > 0) {
    const client = new Client({ connectionString: databaseUrl() });
    await client.connect();
    try {
      await client.query(`DELETE FROM "Paper" WHERE "id" = ANY($1::text[])`, [[...paperIds]]);
    } finally {
      await client.end();
    }
  }
}

test("grounded evidence is byte-exact, immutable, revision-safe, tenant-bound, and erasable", async () => {
  try {
    const fixture = await createFixture("primary");
    const foreignFixture = await createFixture("foreign");

    let noteInsertReachedDeferredCommit = false;
    await rejectsInvariant(
      "grounding cardinality is checked at deferred commit",
      () => prisma.$transaction(async (transaction) => {
        await transaction.evidenceNote.create({
          data: noteData(fixture, `grounded-integrity-orphan-${randomUUID()}`),
        });
        noteInsertReachedDeferredCommit = true;
      }),
      "requires exactly one version-one anchor",
    );
    assert.equal(noteInsertReachedDeferredCommit, true);

    const predecessor = await createGroundedNote(fixture, {
      noteId: `grounded-integrity-predecessor-${randomUUID()}`,
    });
    assert.equal(predecessor.note.status, "CAPTURED");
    assert.equal(predecessor.note.verifiedAt, null);
    assert.equal(predecessor.anchor.startByteOffset, START_BYTE_OFFSET);
    assert.equal(predecessor.anchor.endByteOffset, END_BYTE_OFFSET);
    assert.equal(predecessor.anchor.quoteText, EXPECTED_QUOTE);
    assert.equal(predecessor.anchor.quoteSha256, digest(EXPECTED_QUOTE));
    assert.match(predecessor.anchor.quoteText, /😀/u);
    assert.ok(predecessor.anchor.quoteText.includes("q\u0307"));
    assert.ok(predecessor.anchor.quoteText.includes("\n\n"));
    assert.equal(predecessor.anchor.quoteText.includes("Prefix "), false);
    assert.equal(predecessor.anchor.quoteText.includes(" result"), false);

    await rejectsInvariant(
      "a grounded note's project-paper custody cannot be removed",
      () => prisma.projectPaper.delete({
        where: {
          projectId_workspacePaperId: {
            projectId: fixture.projectId,
            workspacePaperId: fixture.workspacePaperId,
          },
        },
      }),
      "EvidenceTextAnchor_project_paper_fkey",
    );
    assert.equal(await prisma.projectPaper.count({
      where: {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        workspacePaperId: fixture.workspacePaperId,
      },
    }), 1);

    const unrelatedProjectId = `grounded-integrity-unrelated-project-${randomUUID()}`;
    await prisma.project.create({
      data: {
        id: unrelatedProjectId,
        organizationId: fixture.organizationId,
        name: "Unrelated grounded integrity project",
        slug: unrelatedProjectId,
      },
    });

    const forgedCases: Array<{
      name: string;
      expected: string;
      note?: Partial<Prisma.EvidenceNoteUncheckedCreateInput>;
      anchor?: Partial<Prisma.EvidenceTextAnchorUncheckedCreateInput>;
    }> = [
      {
        name: "canonical project does not contain the paper",
        expected: "EvidenceTextAnchor_project_paper_fkey",
        note: { projectId: unrelatedProjectId },
      },
      {
        name: "forged manifest digest",
        expected: "requires its exact admitted text manifest",
        anchor: { manifestSha256: digest("forged manifest") },
      },
      {
        name: "forged start content hash",
        expected: "must name its exact endpoint chunks",
        anchor: { startContentHash: digest("forged content") },
      },
      {
        name: "forged endpoint chunk",
        expected: "must name its exact endpoint chunks",
        anchor: { endChunkId: fixture.chunks[0].id },
      },
      {
        name: "forged page locator",
        expected: "must exactly match its note",
        anchor: { pageStart: 2 },
      },
      {
        name: "forged paragraph locator",
        expected: "must exactly match its note",
        anchor: { paragraphEndId: "p2-p2" },
      },
      {
        name: "non-canonical inter-chunk delimiter",
        expected: "must exactly match its note",
        anchor: {
          quoteText: EXPECTED_QUOTE.replace("\n\n", "\n"),
          quoteSha256: digest(EXPECTED_QUOTE.replace("\n\n", "\n")),
        },
      },
      {
        name: "CAPTURED note carrying a review timestamp",
        expected: "consistent review state",
        note: { verifiedAt: new Date("2026-08-28T18:01:00.000Z") },
      },
      {
        name: "VERIFIED note missing its review timestamp",
        expected: "consistent review state",
        note: { status: "VERIFIED", verifiedAt: null },
      },
      {
        name: "foreign tenant source document",
        expected: "EvidenceTextAnchor_document_fkey",
        anchor: {
          documentId: foreignFixture.documentId,
          extractionId: foreignFixture.extractionId,
          manifestSha256: foreignFixture.manifestSha256,
          startChunkId: foreignFixture.chunks[0].id,
          endChunkId: foreignFixture.chunks[1].id,
          startContentHash: foreignFixture.chunks[0].contentHash,
          endContentHash: foreignFixture.chunks[1].contentHash,
        },
      },
      {
        name: "foreign tenant note binding",
        expected: "EvidenceTextAnchor_note_fkey",
        anchor: {
          organizationId: foreignFixture.organizationId,
          workspacePaperId: foreignFixture.workspacePaperId,
          documentId: foreignFixture.documentId,
          extractionId: foreignFixture.extractionId,
          manifestSha256: foreignFixture.manifestSha256,
          startChunkId: foreignFixture.chunks[0].id,
          endChunkId: foreignFixture.chunks[1].id,
          startContentHash: foreignFixture.chunks[0].contentHash,
          endContentHash: foreignFixture.chunks[1].contentHash,
        },
      },
    ];
    for (const forged of forgedCases) {
      await rejectsInvariant(
        forged.name,
        () => createGroundedNote(fixture, { note: forged.note, anchor: forged.anchor }),
        forged.expected,
      );
    }
    await rejectsSplitUtf8Boundary(fixture);

    await rejectsInvariant(
      "grounded notes cannot be reviewed in place",
      () => prisma.evidenceNote.update({
        where: { id: predecessor.note.id },
        data: { status: "VERIFIED", verifiedAt: new Date("2026-08-28T18:02:00.000Z") },
      }),
      "Grounded evidence revisions are immutable",
    );
    await rejectsInvariant(
      "grounded notes cannot be directly deleted",
      () => prisma.evidenceNote.delete({ where: { id: predecessor.note.id } }),
      "Grounded evidence revisions are immutable",
    );
    await rejectsInvariant(
      "anchors cannot be updated",
      () => prisma.evidenceTextAnchor.update({
        where: { id: predecessor.anchor.id },
        data: { quoteText: "forged" },
      }),
      "Grounded evidence anchors are immutable",
    );
    await rejectsInvariant(
      "anchors cannot be directly deleted",
      () => prisma.evidenceTextAnchor.delete({ where: { id: predecessor.anchor.id } }),
      "Grounded evidence anchors are immutable",
    );

    await rejectsInvariant(
      "a successor cannot predate its predecessor",
      () => prisma.evidenceNote.create({
        data: {
          ...noteData(fixture, `grounded-integrity-backdated-${randomUUID()}`),
          supersedesId: predecessor.note.id,
          createdAt: new Date(PREDECESSOR_CREATED_AT.getTime() - 1),
        },
      }),
      "retain predecessor paper, project, and grounding custody",
    );

    const successorCreatedAt = new Date(PREDECESSOR_CREATED_AT.getTime() + 60_000);
    const successor = await createGroundedNote(fixture, {
      noteId: `grounded-integrity-successor-${randomUUID()}`,
      note: {
        supersedesId: predecessor.note.id,
        status: "VERIFIED",
        verifiedAt: successorCreatedAt,
        createdAt: successorCreatedAt,
      },
    });
    assert.equal(successor.note.supersedesId, predecessor.note.id);
    assert.equal(successor.note.status, "VERIFIED");
    assert.equal(successor.note.verifiedAt?.getTime(), successorCreatedAt.getTime());

    await rejectsInvariant(
      "one predecessor cannot branch to a second successor",
      () => prisma.evidenceNote.create({
        data: {
          ...noteData(fixture, `grounded-integrity-branch-${randomUUID()}`),
          supersedesId: predecessor.note.id,
          createdAt: new Date(successorCreatedAt.getTime() + 1),
        },
      }),
    );
    assert.equal(await prisma.evidenceNote.count({
      where: { organizationId: fixture.organizationId, supersedesId: predecessor.note.id },
    }), 1);

    assert.equal(await prisma.evidenceNote.count({
      where: { organizationId: fixture.organizationId },
    }), 2);
    assert.equal(await prisma.evidenceTextAnchor.count({
      where: { organizationId: fixture.organizationId },
    }), 2);

    await deleteTenantRoot(fixture.organizationId, false);
    organizationIds.delete(fixture.organizationId);
    assert.equal(await prisma.evidenceNote.count({
      where: { organizationId: fixture.organizationId },
    }), 0);
    assert.equal(await prisma.evidenceTextAnchor.count({
      where: { organizationId: fixture.organizationId },
    }), 0);
    assert.equal(await prisma.documentTextChunk.count({
      where: { organizationId: fixture.organizationId },
    }), 0);
    assert.equal(await prisma.documentTextExtraction.count({
      where: { organizationId: fixture.organizationId },
    }), 0);
    assert.equal(await prisma.documentTextManifestAdmission.count({
      where: { organizationId: fixture.organizationId },
    }), 0);
    assert.equal(await prisma.paper.count({ where: { id: fixture.paperId } }), 1);
  } finally {
    await cleanup();
  }
});
