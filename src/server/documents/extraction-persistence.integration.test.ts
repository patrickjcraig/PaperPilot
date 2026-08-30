import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { Prisma } from "@/generated/prisma/client";
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

interface ExtractionTarget {
  organizationId: string;
  documentId: string;
  assetId: string;
  validationAttestationId: string;
  extractionJobId: string;
  extractionAttemptId: string;
  inputSha256: string;
  inputSizeBytes: bigint;
  pageCount: number;
}

after(async () => {
  await prisma.$disconnect();
});

function digest(value: string): string {
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

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = Reflect.get(current, "cause");
  }
  return chain;
}

function isSqlState(error: unknown, state: string): boolean {
  return errorChain(error).some((entry) => {
    const code = Reflect.get(entry as object, "code");
    const originalCode = Reflect.get(entry as object, "originalCode");
    const sqlState = Reflect.get(entry as object, "sqlState");
    const message = Reflect.get(entry as object, "message");
    return code === state
      || originalCode === state
      || sqlState === state
      || (typeof message === "string" && message.includes(`Code: \`${state}\``));
  });
}

function hasErrorMessage(error: unknown, expected: string): boolean {
  return errorChain(error).some((entry) => {
    const message = Reflect.get(entry as object, "message");
    const originalMessage = Reflect.get(entry as object, "originalMessage");
    return (typeof message === "string" && message.includes(expected))
      || (typeof originalMessage === "string" && originalMessage.includes(expected));
  });
}

function isConstraintFailure(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError
    && (
      error.code === "P2002"
      || error.code === "P2003"
    )
  )
    || isSqlState(error, "23514")
    || isSqlState(error, "55000");
}

function isAggregateConstraintFailure(error: unknown): boolean {
  return isSqlState(error, "23514")
    && [
      "Text extraction chunks must exactly match their manifest at commit.",
      "A manifest admission must exactly match its extraction header.",
      "A manifest admission requires canonical extraction-owned chunks.",
      "A manifest admission requires ordered pages and paragraphs.",
      "A manifest admission requires canonical NFC text.",
    ].some((message) => hasErrorMessage(error, message));
}

async function rejectsConstraint(
  name: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  await assert.rejects(operation, isConstraintFailure, name);
}

async function rejectsAggregateConstraint(
  name: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  await assert.rejects(operation, isAggregateConstraintFailure, name);
}

async function createOrganization(label: string): Promise<string> {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      id: `extraction-persistence-org-${label}-${suffix}`,
      name: `Extraction persistence ${label}`,
      slug: `extraction-persistence-${label}-${suffix}`,
    },
  });
  return organization.id;
}

async function createExtractionJobAttempt(
  target: Pick<ExtractionTarget, "organizationId" | "documentId" | "assetId">,
  label: string,
): Promise<{ jobId: string; attemptId: string }> {
  const suffix = randomUUID();
  const jobId = `text-extraction-job-${label}-${suffix}`;
  const attemptId = `text-extraction-attempt-${label}-${suffix}`;
  await prisma.$transaction(async (transaction) => {
    await transaction.job.create({
      data: {
        id: jobId,
        organizationId: target.organizationId,
        type: "TEXT_EXTRACTION",
        status: "SUCCEEDED",
        dedupeKey: `text-extraction:${label}:${suffix}`,
        documentId: target.documentId,
        assetId: target.assetId,
        attempts: 1,
        maxAttempts: 3,
        completedAt: EXTRACTION_CHECKED_AT,
      },
    });
    await transaction.jobAttempt.create({
      data: {
        id: attemptId,
        organizationId: target.organizationId,
        jobId,
        attemptNumber: 1,
        status: "SUCCEEDED",
        completedAt: EXTRACTION_CHECKED_AT,
      },
    });
  });
  return { jobId, attemptId };
}

async function createExtractionTarget(
  organizationId: string,
  label: string,
  validationVerdict: "ACCEPTED" | "REJECTED" = "ACCEPTED",
): Promise<ExtractionTarget> {
  const suffix = randomUUID();
  const documentId = `extraction-document-${label}-${suffix}`;
  const assetId = `extraction-asset-${label}-${suffix}`;
  const intakeId = `extraction-intake-${label}-${suffix}`;
  const ingressJobId = `extraction-ingress-job-${label}-${suffix}`;
  const ingressJobAttemptId = `extraction-ingress-job-attempt-${label}-${suffix}`;
  const ingressAttemptId = `extraction-ingress-attempt-${label}-${suffix}`;
  const ingestReceiptId = `extraction-ingest-${label}-${suffix}`;
  const validationJobId = `extraction-validation-job-${label}-${suffix}`;
  const validationAttemptId = `extraction-validation-attempt-${label}-${suffix}`;
  const validationAttestationId = `extraction-validation-attestation-${label}-${suffix}`;
  const inputSha256 = digest(`${organizationId}:${label}:${suffix}`);
  const computedMd5 = createHash("md5")
    .update(`${organizationId}:${label}:${suffix}`)
    .digest("hex");
  const inputSizeBytes = 4_096n;
  const pageCount = 2;
  const objectKey = `extraction/${organizationId}/${assetId}`;

  await prisma.$transaction(async (transaction) => {
    await transaction.document.create({
      data: {
        id: documentId,
        organizationId,
        kind: "PAPER_PDF",
        status: "READY",
        mimeType: "application/pdf",
        pageCount,
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
      data: {
        organizationId,
        documentId,
        assetId,
        role: "ORIGINAL",
      },
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
        dedupeKey: `document-ingress:${label}:${suffix}`,
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
        leaseId: `document-ingress-lease-${suffix}`,
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
        sourceFingerprint: `test-extraction-persistence:${label}:${suffix}`,
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
        dedupeKey: `document-validation:${label}:${suffix}`,
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
        toolchainDigest: validationVerdict === "ACCEPTED"
          ? VALIDATION_TOOLCHAIN
          : digest(`rejected:${label}:${suffix}`),
        verdict: validationVerdict,
        rejectionCode: validationVerdict === "REJECTED" ? "invalid_pdf_structure" : null,
        malwareVerdict: "CLEAN",
        malwareEngine: "clamav",
        malwareEngineVersion: "1.5.4",
        signatureVersion: "27712",
        signaturePublishedAt: SIGNATURE_PUBLISHED_AT,
        scannedAt: SCANNED_AT,
        pdfStructuralVerdict: validationVerdict === "ACCEPTED" ? "VALID" : "INVALID",
        pdfEngine: "qpdf+poppler",
        pdfEngineVersion: "12.4.1+26.05.0",
        pdfVersion: "1.7",
        pageCount,
        objectCount: 12,
        revisionCount: 1,
        checkedAt: VALIDATION_CHECKED_AT,
        result: { schemaVersion: 1 },
      },
    });
  });

  const extraction = await createExtractionJobAttempt(
    { organizationId, documentId, assetId },
    label,
  );
  return {
    organizationId,
    documentId,
    assetId,
    validationAttestationId,
    extractionJobId: extraction.jobId,
    extractionAttemptId: extraction.attemptId,
    inputSha256,
    inputSizeBytes,
    pageCount,
  };
}

function extractionData(
  target: ExtractionTarget,
  overrides: Partial<Prisma.DocumentTextExtractionUncheckedCreateInput> = {},
): Prisma.DocumentTextExtractionUncheckedCreateInput {
  return {
    id: `text-extraction-${randomUUID()}`,
    organizationId: target.organizationId,
    jobId: target.extractionJobId,
    jobAttemptId: target.extractionAttemptId,
    validationAttestationId: target.validationAttestationId,
    assetId: target.assetId,
    documentId: target.documentId,
    inputSha256: target.inputSha256,
    inputSizeBytes: target.inputSizeBytes,
    storageVersion: STORAGE_VERSION,
    extractionPolicyVersion: EXTRACTION_POLICY,
    toolchainDigest: EXTRACTION_TOOLCHAIN,
    verdict: "NO_TEXT",
    engine: "poppler",
    engineVersion: "26.05.0",
    pageCount: target.pageCount,
    chunkCount: 0,
    textBytes: 0,
    extractedAt: EXTRACTED_AT,
    completedAt: EXTRACTION_COMPLETED_AT,
    durationMs: 900,
    totalDurationMs: 1_100,
    checkedAt: EXTRACTION_CHECKED_AT,
    result: { schemaVersion: 1 },
    ...overrides,
  };
}

async function cleanup(organizationIds: string[], paperIds: string[]): Promise<void> {
  // Extraction provenance is immutable during normal operation. Deleting the
  // tenant is the explicit erasure path and cascades through manifests/chunks.
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.paper.deleteMany({ where: { id: { in: paperIds } } });
}

test("PostgreSQL enforces extraction manifests, provenance-owned chunks, jobs, and active paper links", async () => {
  const organizationIds: string[] = [];
  const paperIds: string[] = [];
  try {
    const organizationId = await createOrganization("primary");
    const otherOrganizationId = await createOrganization("other");
    organizationIds.push(organizationId, otherOrganizationId);

    const extractedTarget = await createExtractionTarget(organizationId, "extracted");
    const noTextTarget = await createExtractionTarget(organizationId, "no-text");
    const forgedAdmissionTarget = await createExtractionTarget(organizationId, "forged-admission");
    const semanticManifestTarget = await createExtractionTarget(organizationId, "semantic-manifest");
    const otherDocumentTarget = await createExtractionTarget(organizationId, "other-document");
    const otherTenantTarget = await createExtractionTarget(otherOrganizationId, "other-tenant");
    const rejectedValidationTarget = await createExtractionTarget(
      organizationId,
      "rejected-validation",
      "REJECTED",
    );

    await rejectsConstraint("TEXT_EXTRACTION job without a target", () => prisma.job.create({
      data: {
        organizationId,
        type: "TEXT_EXTRACTION",
        dedupeKey: `missing-target-${randomUUID()}`,
      },
    }));
    await rejectsConstraint("cross-tenant TEXT_EXTRACTION job target", () => prisma.job.create({
      data: {
        organizationId,
        type: "TEXT_EXTRACTION",
        dedupeKey: `cross-tenant-target-${randomUUID()}`,
        documentId: otherTenantTarget.documentId,
        assetId: otherTenantTarget.assetId,
      },
    }));

    const invalidManifests: Array<[string, Prisma.DocumentTextExtractionUncheckedCreateInput]> = [
      [
        "cross-tenant manifest",
        extractionData(extractedTarget, { organizationId: otherOrganizationId }),
      ],
      [
        "cross-document manifest",
        extractionData(extractedTarget, { documentId: otherDocumentTarget.documentId }),
      ],
      [
        "attempt belonging to another job",
        extractionData(extractedTarget, {
          jobAttemptId: otherDocumentTarget.extractionAttemptId,
        }),
      ],
      [
        "rejected validation attestation",
        extractionData(rejectedValidationTarget),
      ],
      [
        "input identity mismatch",
        extractionData(extractedTarget, { inputSha256: "c".repeat(64) }),
      ],
      [
        "non-lowercase toolchain digest",
        extractionData(extractedTarget, { toolchainDigest: "D".repeat(64) }),
      ],
      [
        "zero input size",
        extractionData(extractedTarget, { inputSizeBytes: 0n }),
      ],
      [
        "zero page count",
        extractionData(extractedTarget, { pageCount: 0 }),
      ],
      [
        "unbounded chunk count",
        extractionData(extractedTarget, { chunkCount: 4_097 }),
      ],
      [
        "EXTRACTED without chunks",
        extractionData(extractedTarget, { verdict: "EXTRACTED" }),
      ],
      [
        "NO_TEXT retaining text",
        extractionData(extractedTarget, { chunkCount: 1, textBytes: 4 }),
      ],
      [
        "non-Poppler engine",
        extractionData(extractedTarget, { engine: "other" }),
      ],
      [
        "stage duration longer than total duration",
        extractionData(extractedTarget, { durationMs: 1_101 }),
      ],
      [
        "completion before extraction",
        extractionData(extractedTarget, { completedAt: new Date(EXTRACTED_AT.getTime() - 1) }),
      ],
      [
        "oversized result JSON",
        extractionData(extractedTarget, { result: { detail: "x".repeat(65_536) } }),
      ],
    ];
    for (const [name, data] of invalidManifests) {
      await rejectsConstraint(name, () => prisma.documentTextExtraction.create({ data }));
    }

    await rejectsConstraint("forged manifest admission", () => prisma.$transaction(
      async (transaction) => {
        const generation = await transaction.documentTextExtraction.create({
          data: extractionData(forgedAdmissionTarget),
        });
        await transaction.documentTextManifestAdmission.create({
          data: {
            extractionId: generation.id,
            organizationId,
            documentId: forgedAdmissionTarget.documentId,
            schemaVersion: 1,
            verdict: generation.verdict,
            pageCount: generation.pageCount,
            chunkCount: generation.chunkCount,
            textBytes: generation.textBytes,
            manifestSha256: "c".repeat(64),
          },
        });
      },
    ));

    const firstText = "A bounded first paragraph.";
    const secondText = "A second page paragraph.";
    await rejectsAggregateConstraint("incomplete extracted manifest at commit", () => prisma.$transaction(
      async (transaction) => {
        const incomplete = await transaction.documentTextExtraction.create({
          data: extractionData(extractedTarget, {
            verdict: "EXTRACTED",
            chunkCount: 2,
            textBytes: Buffer.byteLength(firstText) + Buffer.byteLength(secondText),
          }),
        });
        await transaction.documentTextChunk.create({
          data: {
            organizationId,
            documentId: extractedTarget.documentId,
            extractionId: incomplete.id,
            sequence: 0,
            pageStart: 1,
            pageEnd: 1,
            paragraphId: "p1-p1",
            text: firstText,
            contentHash: digest(firstText),
            locator: sourceLocator(1, "p1-p1"),
          },
        });
      },
    ));

    await rejectsAggregateConstraint("manifest textBytes must equal its chunk aggregate", () => prisma.$transaction(
      async (transaction) => {
        const wrongBytes = await transaction.documentTextExtraction.create({
          data: extractionData(extractedTarget, {
            verdict: "EXTRACTED",
            chunkCount: 2,
            textBytes: Buffer.byteLength(firstText) + Buffer.byteLength(secondText) + 1,
          }),
        });
        await transaction.documentTextChunk.createMany({
          data: [
            {
              organizationId,
              documentId: extractedTarget.documentId,
              extractionId: wrongBytes.id,
              sequence: 0,
              pageStart: 1,
              pageEnd: 1,
              paragraphId: "p1-p1",
              text: firstText,
              contentHash: digest(firstText),
              locator: sourceLocator(1, "p1-p1"),
            },
            {
              organizationId,
              documentId: extractedTarget.documentId,
              extractionId: wrongBytes.id,
              sequence: 1,
              pageStart: 2,
              pageEnd: 2,
              paragraphId: "p2-p1",
              text: secondText,
              contentHash: digest(secondText),
              locator: sourceLocator(2, "p2-p1"),
            },
          ],
        });
      },
    ));

    await rejectsAggregateConstraint("chunk sequences must be contiguous from zero", () => prisma.$transaction(
      async (transaction) => {
        const gapped = await transaction.documentTextExtraction.create({
          data: extractionData(extractedTarget, {
            verdict: "EXTRACTED",
            chunkCount: 2,
            textBytes: Buffer.byteLength(firstText) + Buffer.byteLength(secondText),
          }),
        });
        await transaction.documentTextChunk.createMany({
          data: [
            {
              organizationId,
              documentId: extractedTarget.documentId,
              extractionId: gapped.id,
              sequence: 0,
              pageStart: 1,
              pageEnd: 1,
              paragraphId: "p1-p1",
              text: firstText,
              contentHash: digest(firstText),
              locator: sourceLocator(1, "p1-p1"),
            },
            {
              organizationId,
              documentId: extractedTarget.documentId,
              extractionId: gapped.id,
              sequence: 2,
              pageStart: 2,
              pageEnd: 2,
              paragraphId: "p2-p1",
              text: secondText,
              contentHash: digest(secondText),
              locator: sourceLocator(2, "p2-p1"),
            },
          ],
        });
      },
    ));

    await rejectsAggregateConstraint("chunk contentHash must match its exact UTF-8 text", () => prisma.$transaction(
      async (transaction) => {
        const wrongHash = await transaction.documentTextExtraction.create({
          data: extractionData(extractedTarget, {
            verdict: "EXTRACTED",
            chunkCount: 2,
            textBytes: Buffer.byteLength(firstText) + Buffer.byteLength(secondText),
          }),
        });
        await transaction.documentTextChunk.createMany({
          data: [
            {
              organizationId,
              documentId: extractedTarget.documentId,
              extractionId: wrongHash.id,
              sequence: 0,
              pageStart: 1,
              pageEnd: 1,
              paragraphId: "p1-p1",
              text: firstText,
              contentHash: digest("different first paragraph"),
              locator: sourceLocator(1, "p1-p1"),
            },
            {
              organizationId,
              documentId: extractedTarget.documentId,
              extractionId: wrongHash.id,
              sequence: 1,
              pageStart: 2,
              pageEnd: 2,
              paragraphId: "p2-p1",
              text: secondText,
              contentHash: digest(secondText),
              locator: sourceLocator(2, "p2-p1"),
            },
          ],
        });
      },
    ));

    const semanticManifestCases: Array<{
      name: string;
      chunks: Array<{ pageNumber: number; paragraphId: string; text: string }>;
    }> = [
      {
        name: "manifest pages cannot decrease",
        chunks: [
          { pageNumber: 2, paragraphId: "p2-p1", text: "Page two comes first." },
          { pageNumber: 1, paragraphId: "p1-p1", text: "Page one cannot follow." },
        ],
      },
      {
        name: "same-page paragraph ordinals cannot jump",
        chunks: [
          { pageNumber: 1, paragraphId: "p1-p1", text: "First paragraph." },
          { pageNumber: 1, paragraphId: "p1-p3", text: "Skipped paragraph." },
        ],
      },
      {
        name: "manifest text cannot contain doubled ASCII spaces",
        chunks: [{ pageNumber: 1, paragraphId: "p1-p1", text: "Double  space." }],
      },
      {
        name: "manifest text must be NFC",
        chunks: [{ pageNumber: 1, paragraphId: "p1-p1", text: "Cafe\u0301" }],
      },
    ];
    for (const semanticCase of semanticManifestCases) {
      await rejectsAggregateConstraint(semanticCase.name, () => prisma.$transaction(
        async (transaction) => {
          const textBytes = semanticCase.chunks.reduce(
            (total, chunk) => total + Buffer.byteLength(chunk.text, "utf8"),
            0,
          );
          const generation = await transaction.documentTextExtraction.create({
            data: extractionData(semanticManifestTarget, {
              verdict: "EXTRACTED",
              chunkCount: semanticCase.chunks.length,
              textBytes,
            }),
          });
          await transaction.documentTextChunk.createMany({
            data: semanticCase.chunks.map((chunk, sequence) => ({
              organizationId,
              documentId: semanticManifestTarget.documentId,
              extractionId: generation.id,
              sequence,
              pageStart: chunk.pageNumber,
              pageEnd: chunk.pageNumber,
              paragraphId: chunk.paragraphId,
              text: chunk.text,
              contentHash: digest(chunk.text),
              locator: sourceLocator(chunk.pageNumber, chunk.paragraphId),
            })),
          });
        },
      ));
    }

    const extracted = await prisma.$transaction(async (transaction) => {
      const manifest = await transaction.documentTextExtraction.create({
        data: extractionData(extractedTarget, {
          verdict: "EXTRACTED",
          chunkCount: 2,
          textBytes: Buffer.byteLength(firstText) + Buffer.byteLength(secondText),
        }),
      });
      await transaction.documentTextChunk.createMany({
        data: [
          {
            organizationId,
            documentId: extractedTarget.documentId,
            extractionId: manifest.id,
            sequence: 0,
            pageStart: 1,
            pageEnd: 1,
            paragraphId: "p1-p1",
            text: firstText,
            contentHash: digest(firstText),
            locator: sourceLocator(1, "p1-p1"),
          },
          {
            organizationId,
            documentId: extractedTarget.documentId,
            extractionId: manifest.id,
            sequence: 1,
            pageStart: 2,
            pageEnd: 2,
            paragraphId: "p2-p1",
            text: secondText,
            contentHash: digest(secondText),
            locator: sourceLocator(2, "p2-p1"),
          },
        ],
      });
      return manifest;
    });
    const noText = await prisma.documentTextExtraction.create({
      data: extractionData(noTextTarget, {
        // The service may be within the accepted future-clock-skew window.
        checkedAt: new Date(EXTRACTION_COMPLETED_AT.getTime() - 500),
      }),
    });
    assert.equal(extracted.verdict, "EXTRACTED");
    assert.equal(extracted.engine, "poppler");
    assert.equal(extracted.engineVersion, "26.05.0");
    assert.equal(extracted.extractedAt.getTime(), EXTRACTED_AT.getTime());
    assert.equal(extracted.completedAt.getTime(), EXTRACTION_COMPLETED_AT.getTime());
    assert.equal(extracted.durationMs, 900);
    assert.equal(extracted.totalDurationMs, 1_100);
    assert.equal(noText.verdict, "NO_TEXT");
    assert.equal(noText.chunkCount, 0);
    assert.equal(noText.textBytes, 0);

    const admissions = await prisma.documentTextManifestAdmission.findMany({
      where: { extractionId: { in: [extracted.id, noText.id] } },
      orderBy: { extractionId: "asc" },
    });
    assert.equal(admissions.length, 2);
    for (const admission of admissions) {
      const generation = admission.extractionId === extracted.id ? extracted : noText;
      assert.equal(admission.organizationId, organizationId);
      assert.equal(admission.documentId, generation.documentId);
      assert.equal(admission.schemaVersion, 1);
      assert.equal(admission.verdict, generation.verdict);
      assert.equal(admission.pageCount, generation.pageCount);
      assert.equal(admission.chunkCount, generation.chunkCount);
      assert.equal(admission.textBytes, generation.textBytes);
      assert.match(admission.manifestSha256, /^[0-9a-f]{64}$/);
      assert.notEqual(admission.manifestSha256, "0".repeat(64));
    }
    const extractedAdmission = admissions.find((item) => item.extractionId === extracted.id);
    assert.ok(extractedAdmission);
    const [{ digest: recomputedDigest }] = await prisma.$queryRaw<Array<{ digest: string }>>`
      SELECT compute_document_text_manifest_v1(
        ${organizationId},
        ${extracted.documentId},
        ${extracted.id}
      ) AS digest
    `;
    assert.equal(extractedAdmission.manifestSha256, recomputedDigest);
    await rejectsConstraint("manifest admission update", () =>
      prisma.documentTextManifestAdmission.update({
        where: { extractionId: extracted.id },
        data: { admittedAt: new Date() },
      }));
    await rejectsConstraint("manifest admission delete", () =>
      prisma.documentTextManifestAdmission.delete({
        where: { extractionId: extracted.id },
      }));

    const persistedChunks = await prisma.documentTextChunk.findMany({
      where: { organizationId, extractionId: extracted.id },
      orderBy: { sequence: "asc" },
      select: { sequence: true, text: true, contentHash: true },
    });
    assert.deepEqual(persistedChunks, [
      { sequence: 0, text: firstText, contentHash: digest(firstText) },
      { sequence: 1, text: secondText, contentHash: digest(secondText) },
    ]);

    let appendStatementReachedTransactionEnd = false;
    await rejectsAggregateConstraint(
      "later sequence=chunkCount append is rejected by the deferred aggregate",
      () => prisma.$transaction(async (transaction) => {
        await transaction.documentTextChunk.create({
          data: {
            organizationId,
            documentId: extractedTarget.documentId,
            extractionId: extracted.id,
            sequence: extracted.chunkCount,
            pageStart: 2,
            pageEnd: 2,
            paragraphId: "p2-p2",
            text: "A forbidden post-generation append.",
            contentHash: digest("A forbidden post-generation append."),
            locator: sourceLocator(2, "p2-p2"),
          },
        });
        appendStatementReachedTransactionEnd = true;
      }),
    );
    assert.equal(
      appendStatementReachedTransactionEnd,
      true,
      "the append statement must succeed before the deferred commit check rejects it",
    );
    assert.equal(await prisma.documentTextChunk.count({
      where: { organizationId, extractionId: extracted.id },
    }), 2);
    assert.equal(
      (await prisma.documentTextManifestAdmission.findUniqueOrThrow({
        where: { extractionId: extracted.id },
      })).manifestSha256,
      extractedAdmission.manifestSha256,
    );

    const overlongParagraphId = `p1-p${"1".repeat(64)}`;
    const invalidChunks: Array<[string, Prisma.DocumentTextChunkUncheckedCreateInput]> = [
      [
        "cross-document extraction chunk",
        {
          organizationId,
          documentId: otherDocumentTarget.documentId,
          extractionId: extracted.id,
          sequence: 0,
          pageStart: 1,
          pageEnd: 1,
          paragraphId: "p1-p1",
          text: "wrong document",
          contentHash: digest("wrong document"),
          locator: sourceLocator(1, "p1-p1"),
        },
      ],
      [
        "cross-tenant extraction chunk",
        {
          organizationId: otherOrganizationId,
          documentId: otherTenantTarget.documentId,
          extractionId: extracted.id,
          sequence: 0,
          pageStart: 1,
          pageEnd: 1,
          paragraphId: "p1-p1",
          text: "wrong tenant",
          contentHash: digest("wrong tenant"),
          locator: sourceLocator(1, "p1-p1"),
        },
      ],
      [
        "chunk attached to NO_TEXT manifest",
        {
          organizationId,
          documentId: noTextTarget.documentId,
          extractionId: noText.id,
          sequence: 0,
          pageStart: 1,
          pageEnd: 1,
          paragraphId: "p1-p1",
          text: "unexpected text",
          contentHash: digest("unexpected text"),
          locator: sourceLocator(1, "p1-p1"),
        },
      ],
      [
        "sequence beyond manifest append sentinel",
        {
          organizationId,
          documentId: extractedTarget.documentId,
          extractionId: extracted.id,
          sequence: 3,
          pageStart: 2,
          pageEnd: 2,
          paragraphId: "p2-p2",
          text: "extra sequence",
          contentHash: digest("extra sequence"),
          locator: sourceLocator(2, "p2-p2"),
        },
      ],
      [
        "page outside manifest count",
        {
          organizationId,
          documentId: extractedTarget.documentId,
          extractionId: extracted.id,
          sequence: 0,
          pageStart: 3,
          pageEnd: 3,
          paragraphId: "p3-p1",
          text: "extra page",
          contentHash: digest("extra page"),
          locator: sourceLocator(3, "p3-p1"),
        },
      ],
      [
        "negative sequence",
        {
          organizationId,
          documentId: extractedTarget.documentId,
          extractionId: extracted.id,
          sequence: -1,
          pageStart: 1,
          pageEnd: 1,
          paragraphId: "p1-p1",
          text: "negative sequence",
          contentHash: digest("negative sequence"),
          locator: sourceLocator(1, "p1-p1"),
        },
      ],
      [
        "partial character offsets",
        {
          organizationId,
          documentId: extractedTarget.documentId,
          extractionId: extracted.id,
          sequence: 0,
          pageStart: 1,
          pageEnd: 1,
          paragraphId: "p1-p1",
          charStart: 0,
          text: "partial offsets",
          contentHash: digest("partial offsets"),
          locator: sourceLocator(1, "p1-p1"),
        },
      ],
      [
        "empty extracted text",
        {
          organizationId,
          documentId: extractedTarget.documentId,
          extractionId: extracted.id,
          sequence: 0,
          pageStart: 1,
          pageEnd: 1,
          paragraphId: "p1-p1",
          text: "",
          contentHash: digest(""),
          locator: sourceLocator(1, "p1-p1"),
        },
      ],
      [
        "invalid extracted content hash",
        {
          organizationId,
          documentId: extractedTarget.documentId,
          extractionId: extracted.id,
          sequence: 0,
          pageStart: 1,
          pageEnd: 1,
          paragraphId: "p1-p1",
          text: "invalid hash",
          contentHash: "E".repeat(64),
          locator: sourceLocator(1, "p1-p1"),
        },
      ],
      [
        "cross-page extracted chunk",
        {
          organizationId,
          documentId: extractedTarget.documentId,
          extractionId: extracted.id,
          sequence: 0,
          pageStart: 1,
          pageEnd: 2,
          paragraphId: "p1-p1",
          text: "cross-page chunk",
          contentHash: digest("cross-page chunk"),
          locator: sourceLocator(1, "p1-p1"),
        },
      ],
      [
        "section metadata on extracted chunk",
        {
          organizationId,
          documentId: extractedTarget.documentId,
          extractionId: extracted.id,
          sequence: 0,
          pageStart: 1,
          pageEnd: 1,
          sectionId: "introduction",
          sectionTitle: "Introduction",
          paragraphId: "p1-p1",
          text: "section metadata",
          contentHash: digest("section metadata"),
          locator: sourceLocator(1, "p1-p1"),
        },
      ],
      [
        "paragraph page mismatch",
        {
          organizationId,
          documentId: extractedTarget.documentId,
          extractionId: extracted.id,
          sequence: 0,
          pageStart: 1,
          pageEnd: 1,
          paragraphId: "p2-p1",
          text: "paragraph page mismatch",
          contentHash: digest("paragraph page mismatch"),
          locator: sourceLocator(1, "p2-p1"),
        },
      ],
      [
        "missing source locator",
        {
          organizationId,
          documentId: extractedTarget.documentId,
          extractionId: extracted.id,
          sequence: 0,
          pageStart: 1,
          pageEnd: 1,
          paragraphId: "p1-p1",
          text: "missing locator",
          contentHash: digest("missing locator"),
        },
      ],
      [
        "source locator with an extra key",
        {
          organizationId,
          documentId: extractedTarget.documentId,
          extractionId: extracted.id,
          sequence: 0,
          pageStart: 1,
          pageEnd: 1,
          paragraphId: "p1-p1",
          text: "extra locator key",
          contentHash: digest("extra locator key"),
          locator: { ...sourceLocator(1, "p1-p1"), extra: true },
        },
      ],
      [
        "source locator row mismatch",
        {
          organizationId,
          documentId: extractedTarget.documentId,
          extractionId: extracted.id,
          sequence: 0,
          pageStart: 1,
          pageEnd: 1,
          paragraphId: "p1-p1",
          text: "locator mismatch",
          contentHash: digest("locator mismatch"),
          locator: sourceLocator(2, "p2-p1"),
        },
      ],
      [
        "overlong paragraph identifier",
        {
          organizationId,
          documentId: extractedTarget.documentId,
          extractionId: extracted.id,
          sequence: 0,
          pageStart: 1,
          pageEnd: 1,
          paragraphId: overlongParagraphId,
          text: "overlong paragraph identifier",
          contentHash: digest("overlong paragraph identifier"),
          locator: sourceLocator(1, overlongParagraphId),
        },
      ],
    ];
    for (const [name, data] of invalidChunks) {
      await rejectsConstraint(name, () => prisma.documentTextChunk.create({ data }));
    }

    const nextGenerationJob = await createExtractionJobAttempt(extractedTarget, "next-policy");
    const nextGenerationText = "A new policy can restart sequence zero.";
    const restartedSequence = await prisma.$transaction(async (transaction) => {
      const nextGeneration = await transaction.documentTextExtraction.create({
        data: extractionData(extractedTarget, {
          jobId: nextGenerationJob.jobId,
          jobAttemptId: nextGenerationJob.attemptId,
          extractionPolicyVersion: "paperpilot-text-extraction-v2",
          toolchainDigest: "f".repeat(64),
          verdict: "EXTRACTED",
          chunkCount: 1,
          textBytes: Buffer.byteLength(nextGenerationText),
        }),
      });
      return transaction.documentTextChunk.create({
        data: {
          organizationId,
          documentId: extractedTarget.documentId,
          extractionId: nextGeneration.id,
          sequence: 0,
          pageStart: 1,
          pageEnd: 1,
          paragraphId: "p1-p1",
          text: nextGenerationText,
          contentHash: digest(nextGenerationText),
          locator: sourceLocator(1, "p1-p1"),
        },
      });
    });
    assert.equal(restartedSequence.sequence, 0);

    const legacyChunk = await prisma.documentTextChunk.create({
      data: {
        organizationId,
        documentId: extractedTarget.documentId,
        extractionId: null,
        sequence: 0,
        text: "",
        contentHash: "legacy-unverified-hash",
      },
    });
    assert.equal(legacyChunk.extractionId, null);
    await rejectsConstraint("legacy sequence uniqueness", () => prisma.documentTextChunk.create({
      data: {
        organizationId,
        documentId: extractedTarget.documentId,
        extractionId: null,
        sequence: 0,
        text: "another legacy chunk",
        contentHash: "another-legacy-hash",
      },
    }));

    await rejectsConstraint("extraction manifest update", () => prisma.documentTextExtraction.update({
      where: { id: extracted.id },
      data: { result: { schemaVersion: 2 } },
    }));
    await rejectsConstraint("extraction manifest delete", () => prisma.documentTextExtraction.delete({
      where: { id: extracted.id },
    }));

    const extractedChunk = await prisma.documentTextChunk.findFirstOrThrow({
      where: { extractionId: extracted.id, sequence: 0 },
    });
    await rejectsConstraint("extraction-owned chunk update", () => prisma.documentTextChunk.update({
      where: { id: extractedChunk.id },
      data: { text: "mutated evidence" },
    }));
    await rejectsConstraint("extraction-owned chunk delete", () => prisma.documentTextChunk.delete({
      where: { id: extractedChunk.id },
    }));

    const paper = await prisma.paper.create({
      data: { title: `Persistence paper ${randomUUID()}` },
    });
    paperIds.push(paper.id);
    const workspacePaper = await prisma.workspacePaper.create({
      data: { organizationId, paperId: paper.id },
    });
    const otherWorkspacePaper = await prisma.workspacePaper.create({
      data: { organizationId: otherOrganizationId, paperId: paper.id },
    });
    await prisma.document.create({
      data: {
        organizationId,
        paperId: paper.id,
        workspacePaperId: workspacePaper.id,
        kind: "PAPER_PDF",
      },
    });
    await rejectsConstraint("duplicate active paper PDF link", () => prisma.document.create({
      data: {
        organizationId,
        paperId: paper.id,
        workspacePaperId: workspacePaper.id,
        kind: "PAPER_PDF",
      },
    }));
    const archivedLink = await prisma.document.create({
      data: {
        organizationId,
        paperId: paper.id,
        workspacePaperId: workspacePaper.id,
        kind: "PAPER_PDF",
        status: "ARCHIVED",
        archivedAt: EXTRACTION_CHECKED_AT,
      },
    });
    const supplementLink = await prisma.document.create({
      data: {
        organizationId,
        paperId: paper.id,
        workspacePaperId: workspacePaper.id,
        kind: "SUPPLEMENT",
      },
    });
    assert.equal(archivedLink.status, "ARCHIVED");
    assert.equal(supplementLink.kind, "SUPPLEMENT");
    await rejectsConstraint("cross-tenant workspace paper link", () => prisma.document.create({
      data: {
        organizationId,
        paperId: paper.id,
        workspacePaperId: otherWorkspacePaper.id,
        kind: "PAPER_PDF",
      },
    }));
  } finally {
    await cleanup(organizationIds, paperIds);
  }
});
