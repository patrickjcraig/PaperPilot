import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { WorkspaceCommandResult } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import type {
  DocumentExtractionClientDependencies,
  DocumentExtractionFetch,
  StreamingDocumentExtractionRequestInit,
} from "@/server/documents/extraction-client";
import {
  DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
  type DocumentExtractionServiceConfiguration,
} from "@/server/documents/extraction-config";
import type { ExternalDocumentExtractionResponse } from "@/server/documents/extraction-contract";
import { claimNextDocumentTextExtractionJob } from "@/server/documents/extraction-jobs";
import type {
  DocumentValidationFetch,
  StreamingDocumentValidationRequestInit,
} from "@/server/documents/validation-client";
import type { DocumentValidationServiceConfiguration } from "@/server/documents/validation-config";
import type { ExternalDocumentValidationResponse } from "@/server/documents/validation-contract";
import {
  createWorkspaceUploadSession,
  storeWorkspaceUploadContent,
} from "@/server/uploads/service";
import { runDocumentValidationWorkerOnce } from "./document-validation-worker";
import { runDocumentTextExtractionWorkerOnce } from "./document-extraction-worker";

const EXTRACTION_ENDPOINT = "https://extractor.paperpilot.test/v1/extract-pdf";
const EXTRACTION_READINESS_ENDPOINT = "https://extractor.paperpilot.test/readyz";
const EXTRACTION_SECRET = "extraction-service-secret-with-more-than-32-characters";
const EXTRACTION_TOOLCHAIN_DIGEST = "c".repeat(64);
const EXTRACTION_NOW = new Date("2026-08-28T17:00:10.000Z");
const VALIDATION_ENDPOINT = "https://validator.paperpilot.test/v1/document-validation";
const VALIDATION_READINESS_ENDPOINT = "https://validator.paperpilot.test/readyz";
const VALIDATION_SECRET = "validation-service-secret-with-more-than-32-characters";
const VALIDATION_POLICY_VERSION = "paperpilot-document-validation-v1";
const VALIDATION_NOW = new Date("2026-08-28T16:00:10.000Z");
const STORAGE_VERSION = "local-quarantine-v2";
const LEASE_TTL_MS = 10_000;

const DEFAULT_PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
);

interface WorkerFixture {
  quarantineRoot: string;
  previousQuarantineRoot: string | undefined;
  user: { id: string; name: string };
  organizationId: string;
  nextWorkspaceVersion: number;
}

interface ValidatedUpload {
  uploadId: string;
  assetId: string;
  documentId: string;
  validationAttestationId: string;
  extractionJobId: string;
  storageKey: string;
  sha256: string;
  sizeBytes: bigint;
  bytes: Uint8Array;
}

after(async () => {
  await prisma.$disconnect();
});

function assertSuccess<T>(
  result: WorkspaceCommandResult<T>,
): asserts result is Extract<WorkspaceCommandResult<T>, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

function pdfRequest(bytes: Uint8Array): Request {
  return new Request("https://paperpilot.test/upload", {
    method: "PUT",
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
    },
    body: new Uint8Array(bytes).buffer,
  });
}

function validationConfiguration(): DocumentValidationServiceConfiguration {
  return {
    endpoint: VALIDATION_ENDPOINT,
    readinessEndpoint: VALIDATION_READINESS_ENDPOINT,
    bearerSecret: VALIDATION_SECRET,
    policyVersion: VALIDATION_POLICY_VERSION,
    timeoutMs: 30_000,
    maxResponseBytes: 16 * 1_024,
    signatureMaxAgeMs: 24 * 60 * 60 * 1_000,
    futureClockSkewMs: 5 * 60 * 1_000,
  };
}

function extractionConfiguration(): DocumentExtractionServiceConfiguration {
  return {
    endpoint: EXTRACTION_ENDPOINT,
    readinessEndpoint: EXTRACTION_READINESS_ENDPOINT,
    bearerSecret: EXTRACTION_SECRET,
    policyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
    expectedToolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
    timeoutMs: 30_000,
    maxResponseBytes: 16 * 1_024,
    resultMaxAgeMs: 15 * 60 * 1_000,
    futureClockSkewMs: 5 * 60 * 1_000,
  };
}

async function readRequestBody(
  stream:
    | StreamingDocumentValidationRequestInit["body"]
    | StreamingDocumentExtractionRequestInit["body"],
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function responseAt(
  url: string,
  value: unknown,
  init: ResponseInit = {
    status: 200,
    headers: { "Content-Type": "application/json" },
  },
): Response {
  const response = new Response(JSON.stringify(value), init);
  Object.defineProperty(response, "url", { configurable: true, value: url });
  Object.defineProperty(response, "redirected", {
    configurable: true,
    value: false,
  });
  return response;
}

function rawResponseAt(url: string, body: string): Response {
  const response = new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  Object.defineProperty(response, "url", { configurable: true, value: url });
  Object.defineProperty(response, "redirected", {
    configurable: true,
    value: false,
  });
  return response;
}

function readinessResponse(url: string, status?: number): Response {
  const resolvedStatus = status ?? (
    url === EXTRACTION_READINESS_ENDPOINT ? 200 : 204
  );
  const extractionIdentity = url === EXTRACTION_READINESS_ENDPOINT
    && resolvedStatus === 200
    ? {
      schemaVersion: 1,
      status: "ready",
      policyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
      toolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
      engine: "poppler",
      engineVersion: "25.06.0",
    }
    : null;
  const response = new Response(
    extractionIdentity === null ? null : JSON.stringify(extractionIdentity),
    {
      status: resolvedStatus,
      ...(extractionIdentity === null
        ? {}
        : { headers: { "Content-Type": "application/json" } }),
    },
  );
  Object.defineProperty(response, "url", { configurable: true, value: url });
  Object.defineProperty(response, "redirected", {
    configurable: true,
    value: false,
  });
  return response;
}

function acceptedValidationResponse(input: {
  sha256: string;
  sizeBytes: number;
}): ExternalDocumentValidationResponse {
  return {
    schemaVersion: 1,
    policyVersion: VALIDATION_POLICY_VERSION,
    storageVersion: STORAGE_VERSION,
    toolchainDigest: "b".repeat(64),
    verdict: "accepted",
    rejectionCode: null,
    input: { sha256: input.sha256, sizeBytes: String(input.sizeBytes) },
    malware: {
      verdict: "clean",
      engine: "clamav",
      engineVersion: "1.5.4",
      signatureVersion: "27712",
      signaturePublishedAt: "2026-08-28T10:00:00.000Z",
      scannedAt: "2026-08-28T15:59:00.000Z",
      detectionCount: 0,
      durationMs: 100,
    },
    pdf: {
      structuralVerdict: "valid",
      engine: "qpdf+poppler",
      engineVersion: "12.4.1+26.05.0",
      pdfVersion: "1.7",
      pageCount: 2,
      objectCount: 1,
      revisionCount: 1,
      warningCount: 0,
      checkedAt: "2026-08-28T15:59:10.000Z",
      durationMs: 200,
    },
    completedAt: "2026-08-28T15:59:20.000Z",
    totalDurationMs: 350,
  };
}

function extractedResponse(
  target: ValidatedUpload,
  verdict: "extracted" | "no_text" = "extracted",
): ExternalDocumentExtractionResponse {
  const chunks = verdict === "extracted"
    ? [
        {
          sequence: 0,
          pageNumber: 1,
          paragraphId: "p1-p1",
          text: "First exact paragraph",
        },
        {
          sequence: 1,
          pageNumber: 2,
          paragraphId: "p2-p1",
          text: "Second exact paragraph",
        },
      ]
    : [];
  return {
    schemaVersion: 1,
    policyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
    storageVersion: STORAGE_VERSION,
    toolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
    verdict,
    input: {
      sha256: target.sha256,
      sizeBytes: target.sizeBytes.toString(),
    },
    extraction: {
      engine: "poppler",
      engineVersion: "25.06.0",
      pageCount: 2,
      chunkCount: chunks.length,
      textBytes: chunks.reduce(
        (total, chunk) => total + Buffer.byteLength(chunk.text, "utf8"),
        0,
      ),
      extractedAt: "2026-08-28T17:00:01.000Z",
      durationMs: 900,
    },
    chunks,
    completedAt: "2026-08-28T17:00:02.000Z",
    totalDurationMs: 1_000,
  };
}

function objectPath(root: string, storageKey: string): string {
  const parts = storageKey.split(":");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], STORAGE_VERSION);
  return path.join(
    root,
    "tenants",
    parts[1],
    "assets",
    parts[2],
    `${parts[3]}.quarantine`,
  );
}

async function createFixture(label: string): Promise<WorkerFixture> {
  const suffix = randomUUID();
  const quarantineRoot = await mkdtemp(
    path.join(os.tmpdir(), `paperpilot-extraction-worker-${label}-`),
  );
  const previousQuarantineRoot = process.env.PAPERPILOT_UPLOAD_QUARANTINE_ROOT;
  process.env.PAPERPILOT_UPLOAD_QUARANTINE_ROOT = quarantineRoot;
  const user = {
    id: `extraction-worker-user-${suffix}`,
    name: "Extraction Worker Owner",
  };
  const organizationId = `extraction-worker-org-${suffix}`;
  try {
    await prisma.user.create({
      data: {
        id: user.id,
        name: user.name,
        email: `extraction-worker-${suffix}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: `Extraction worker ${label}`,
        slug: `extraction-worker-${suffix}`,
      },
    });
    await prisma.member.create({
      data: { organizationId, userId: user.id, role: "owner" },
    });
    return {
      quarantineRoot,
      previousQuarantineRoot,
      user,
      organizationId,
      nextWorkspaceVersion: 0,
    };
  } catch (error) {
    if (previousQuarantineRoot === undefined) {
      delete process.env.PAPERPILOT_UPLOAD_QUARANTINE_ROOT;
    } else {
      process.env.PAPERPILOT_UPLOAD_QUARANTINE_ROOT = previousQuarantineRoot;
    }
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await rm(quarantineRoot, { recursive: true, force: true });
    throw error;
  }
}

async function cleanupFixture(fixture: WorkerFixture): Promise<void> {
  if (fixture.previousQuarantineRoot === undefined) {
    delete process.env.PAPERPILOT_UPLOAD_QUARANTINE_ROOT;
  } else {
    process.env.PAPERPILOT_UPLOAD_QUARANTINE_ROOT = fixture.previousQuarantineRoot;
  }
  try {
    await prisma.$transaction(async (transaction) => {
      await transaction.auditEvent.deleteMany({
        where: { organizationId: fixture.organizationId },
      });
      await transaction.provenanceRecord.deleteMany({
        where: { organizationId: fixture.organizationId },
      });
      await transaction.organization.delete({ where: { id: fixture.organizationId } });
    });
    await prisma.user.deleteMany({ where: { id: fixture.user.id } });
  } finally {
    await rm(fixture.quarantineRoot, { recursive: true, force: true });
  }
}

async function createValidatedUpload(
  fixture: WorkerFixture,
  label: string,
  inputBytes: Uint8Array = DEFAULT_PDF_BYTES,
): Promise<ValidatedUpload> {
  const bytes = new Uint8Array(inputBytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const created = await createWorkspaceUploadSession(
    fixture.user,
    fixture.organizationId,
    {
      clientOperationId: `extract-${label}-${randomUUID()}`,
      expectedVersion: fixture.nextWorkspaceVersion,
      fileName: `${label}.pdf`,
      sizeBytes: bytes.byteLength,
      declaredMimeType: "application/pdf",
    },
  );
  assertSuccess(created);
  fixture.nextWorkspaceVersion += 1;
  await storeWorkspaceUploadContent(
    fixture.user,
    fixture.organizationId,
    created.data.upload.id,
    pdfRequest(bytes),
  );

  const validator: DocumentValidationFetch = async (url, init) => {
    assert.equal(url, VALIDATION_ENDPOINT);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-paperpilot-content-sha256"), sha256);
    assert.deepEqual(await readRequestBody(init.body), bytes);
    return responseAt(
      VALIDATION_ENDPOINT,
      acceptedValidationResponse({ sha256, sizeBytes: bytes.byteLength }),
    );
  };
  const validated = await runDocumentValidationWorkerOnce({
    workerId: `fixture-validator-${label}-${randomUUID()}`,
    leaseTtlMs: LEASE_TTL_MS,
    validationConfiguration: validationConfiguration(),
    extractionExpectedToolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
    uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
    clientDependencies: {
      readinessFetch: async () => readinessResponse(VALIDATION_READINESS_ENDPOINT),
      fetch: validator,
      clock: () => VALIDATION_NOW,
    },
  });
  assert.equal(validated.kind, "accepted");

  const upload = await prisma.uploadSession.findUniqueOrThrow({
    where: {
      organizationId_id: {
        organizationId: fixture.organizationId,
        id: created.data.upload.id,
      },
    },
    include: { asset: true, document: true },
  });
  assert.ok(upload.document);
  const validationAttestation = await prisma.documentValidationAttestation.findFirstOrThrow({
    where: {
      organizationId: fixture.organizationId,
      assetId: upload.assetId,
      documentId: upload.document.id,
      verdict: "ACCEPTED",
    },
  });
  const extractionJob = await prisma.job.findFirstOrThrow({
    where: {
      organizationId: fixture.organizationId,
      type: "TEXT_EXTRACTION",
      assetId: upload.assetId,
      documentId: upload.document.id,
    },
  });
  assert.equal(extractionJob.status, "QUEUED");
  assert.equal(extractionJob.attempts, 0);

  return {
    uploadId: upload.id,
    assetId: upload.assetId,
    documentId: upload.document.id,
    validationAttestationId: validationAttestation.id,
    extractionJobId: extractionJob.id,
    storageKey: upload.asset.objectKey,
    sha256,
    sizeBytes: BigInt(bytes.byteLength),
    bytes,
  };
}

function extractionDependencies(
  fetch: DocumentExtractionFetch,
): DocumentExtractionClientDependencies {
  return {
    readinessFetch: async (url, init) => {
      assert.equal(url, EXTRACTION_READINESS_ENDPOINT);
      assert.equal(init.method, "GET");
      return readinessResponse(EXTRACTION_READINESS_ENDPOINT);
    },
    fetch,
    clock: () => EXTRACTION_NOW,
  };
}

async function assertReadyWithoutExtraction(
  target: ValidatedUpload,
  expected: {
    status: "RETRYING" | "DEAD_LETTER";
    errorCode: string;
  },
): Promise<void> {
  const [job, asset, document, extractionCount] = await Promise.all([
    prisma.job.findUniqueOrThrow({ where: { id: target.extractionJobId } }),
    prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
    prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
    prisma.documentTextExtraction.count({
      where: { jobId: target.extractionJobId },
    }),
  ]);
  assert.equal(job.status, expected.status);
  assert.equal(job.lastErrorCode, expected.errorCode);
  assert.equal(job.attempts, 1);
  assert.equal(asset.status, "READY");
  assert.equal(document.status, "READY");
  assert.equal(extractionCount, 0);
}

test("readiness is checked before claim and retryable outages consume no attempt", async () => {
  const fixture = await createFixture("readiness");
  try {
    const target = await createValidatedUpload(fixture, "readiness");
    let extractionCalled = false;
    const outage = await runDocumentTextExtractionWorkerOnce({
      workerId: `extraction-outage-${randomUUID()}`,
      leaseTtlMs: LEASE_TTL_MS,
      extractionConfiguration: extractionConfiguration(),
      uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
      clientDependencies: {
        readinessFetch: async (url, init) => {
          assert.equal(url, EXTRACTION_READINESS_ENDPOINT);
          assert.equal(init.method, "GET");
          const headers = new Headers(init.headers);
          assert.equal(headers.get("authorization"), `Bearer ${EXTRACTION_SECRET}`);
          const duringProbe = await prisma.job.findUniqueOrThrow({
            where: { id: target.extractionJobId },
          });
          assert.equal(duringProbe.status, "QUEUED");
          assert.equal(duringProbe.attempts, 0);
          return readinessResponse(EXTRACTION_READINESS_ENDPOINT, 503);
        },
        fetch: async () => {
          extractionCalled = true;
          throw new Error("Extraction must not run during a readiness outage.");
        },
      },
    });
    assert.equal(outage.kind, "service-unavailable");
    assert.equal(extractionCalled, false);

    const afterOutage = await prisma.job.findUniqueOrThrow({
      where: { id: target.extractionJobId },
    });
    assert.equal(afterOutage.status, "QUEUED");
    assert.equal(afterOutage.attempts, 0);
    assert.equal(await prisma.jobAttempt.count({
      where: { jobId: target.extractionJobId },
    }), 0);

    const caller = new AbortController();
    caller.abort();
    const aborted = await runDocumentTextExtractionWorkerOnce({
      workerId: `extraction-aborted-preclaim-${randomUUID()}`,
      leaseTtlMs: LEASE_TTL_MS,
      extractionConfiguration: extractionConfiguration(),
      uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
      signal: caller.signal,
      clientDependencies: {
        readinessFetch: async () => {
          throw new Error("An already-aborted caller must not probe readiness.");
        },
        fetch: async () => {
          throw new Error("An already-aborted caller must not extract.");
        },
      },
    });
    assert.equal(aborted.kind, "service-unavailable");
    const afterAbort = await prisma.job.findUniqueOrThrow({
      where: { id: target.extractionJobId },
    });
    assert.equal(afterAbort.status, "QUEUED");
    assert.equal(afterAbort.attempts, 0);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("worker leaves a valid older-policy job queued without charging an attempt", async () => {
  const fixture = await createFixture("policy-pinning");
  try {
    const target = await createValidatedUpload(fixture, "policy-pinning");
    await prisma.job.update({
      where: { id: target.extractionJobId },
      data: {
        priority: 10_000,
        payload: {
          schemaVersion: 1,
          source: "accepted-document-validation",
          validationAttestationId: target.validationAttestationId,
          policyVersion: "paperpilot-text-extraction-v0",
          storageVersion: STORAGE_VERSION,
          toolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
        },
      },
    });

    let extractionCalled = false;
    const result = await runDocumentTextExtractionWorkerOnce({
      workerId: `extraction-policy-pinning-${randomUUID()}`,
      leaseTtlMs: LEASE_TTL_MS,
      extractionConfiguration: extractionConfiguration(),
      uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
      clientDependencies: extractionDependencies(async () => {
        extractionCalled = true;
        throw new Error("A current-policy worker must not admit an older-policy job.");
      }),
    });
    assert.equal(result.kind, "idle");
    assert.equal(extractionCalled, false);

    const stored = await prisma.job.findUniqueOrThrow({
      where: { id: target.extractionJobId },
    });
    assert.equal(stored.status, "QUEUED");
    assert.equal(stored.attempts, 0);
    assert.equal(stored.lockedAt, null);
    assert.equal(stored.lockedBy, null);
    assert.equal(stored.leaseId, null);
    assert.equal(await prisma.jobAttempt.count({
      where: { jobId: target.extractionJobId },
    }), 0);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("successful streaming persists EXTRACTED evidence from the exact quarantined bytes", async () => {
  const fixture = await createFixture("extracted");
  try {
    const bytes = new TextEncoder().encode(
      "%PDF-1.7\nexact tenant bytes 1 0 obj\nendobj\n%%EOF\n",
    );
    const target = await createValidatedUpload(fixture, "extracted", bytes);
    let streamedBytes: Uint8Array | null = null;
    const extractor: DocumentExtractionFetch = async (url, init) => {
      assert.equal(url, EXTRACTION_ENDPOINT);
      assert.equal(init.method, "POST");
      assert.equal(init.duplex, "half");
      assert.equal(init.redirect, "manual");
      assert.equal(init.credentials, "omit");
      assert.equal(init.referrerPolicy, "no-referrer");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), `Bearer ${EXTRACTION_SECRET}`);
      assert.equal(headers.get("content-length"), target.sizeBytes.toString());
      assert.equal(headers.get("content-type"), "application/pdf");
      assert.equal(headers.get("x-paperpilot-content-sha256"), target.sha256);
      assert.equal(headers.get("x-paperpilot-storage-version"), STORAGE_VERSION);
      assert.equal(
        headers.get("x-paperpilot-extraction-policy"),
        DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
      );
      streamedBytes = await readRequestBody(init.body);
      return responseAt(EXTRACTION_ENDPOINT, extractedResponse(target));
    };

    const result = await runDocumentTextExtractionWorkerOnce({
      workerId: `extraction-success-${randomUUID()}`,
      leaseTtlMs: LEASE_TTL_MS,
      extractionConfiguration: extractionConfiguration(),
      uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
      clientDependencies: extractionDependencies(extractor),
    });
    assert.equal(result.kind, "extracted");
    assert.equal(result.outcome, "applied");
    assert.deepEqual(streamedBytes, bytes);
    assert.equal(
      createHash("sha256").update(streamedBytes).digest("hex"),
      target.sha256,
    );

    const [job, asset, document, extraction] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: target.extractionJobId } }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
      prisma.documentTextExtraction.findFirstOrThrow({
        where: { jobId: target.extractionJobId },
      }),
    ]);
    assert.equal(job.status, "SUCCEEDED");
    assert.equal(job.attempts, 1);
    assert.equal(asset.status, "READY");
    assert.equal(document.status, "READY");
    assert.equal(extraction.id, result.extractionId);
    assert.equal(extraction.documentId, target.documentId);
    assert.equal(extraction.assetId, target.assetId);
    assert.equal(extraction.validationAttestationId, target.validationAttestationId);
    assert.equal(extraction.inputSha256, target.sha256);
    assert.equal(extraction.inputSizeBytes, target.sizeBytes);
    assert.equal(extraction.verdict, "EXTRACTED");
    assert.equal(extraction.pageCount, 2);
    assert.equal(extraction.chunkCount, 2);

    const chunks = await prisma.documentTextChunk.findMany({
      where: { extractionId: extraction.id },
      orderBy: { sequence: "asc" },
    });
    const expectedChunks = extractedResponse(target).chunks;
    assert.equal(chunks.length, expectedChunks.length);
    for (const [index, chunk] of chunks.entries()) {
      const expected = expectedChunks[index];
      assert.ok(expected);
      assert.equal(chunk.pageStart, expected.pageNumber);
      assert.equal(chunk.pageEnd, expected.pageNumber);
      assert.equal(chunk.paragraphId, expected.paragraphId);
      assert.equal(chunk.text, expected.text);
      assert.equal(
        chunk.contentHash,
        createHash("sha256").update(expected.text, "utf8").digest("hex"),
      );
      assert.deepEqual(chunk.locator, {
        schemaVersion: 1,
        kind: "pdf-text",
        pageNumber: expected.pageNumber,
        paragraphId: expected.paragraphId,
      });
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

test("authenticated readiness identity is pinned across POST and mismatches persist no generation", async () => {
  const fixture = await createFixture("engine-identity-mismatch");
  try {
    const target = await createValidatedUpload(fixture, "engine-identity-mismatch");
    const mismatched = extractedResponse(target);
    mismatched.extraction.engineVersion = "26.01.0";

    const result = await runDocumentTextExtractionWorkerOnce({
      workerId: `extraction-engine-mismatch-${randomUUID()}`,
      leaseTtlMs: LEASE_TTL_MS,
      extractionConfiguration: extractionConfiguration(),
      uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
      clientDependencies: extractionDependencies(async () => responseAt(
        EXTRACTION_ENDPOINT,
        mismatched,
      )),
    });

    assert.equal(result.kind, "retrying");
    await assertReadyWithoutExtraction(target, {
      status: "RETRYING",
      errorCode: "extraction_response_invalid",
    });
    assert.equal(await prisma.documentTextExtraction.count({
      where: {
        organizationId: fixture.organizationId,
        documentId: target.documentId,
        assetId: target.assetId,
      },
    }), 0);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("NO_TEXT persists a zero-chunk manifest without changing READY state", async () => {
  const fixture = await createFixture("no-text");
  try {
    const target = await createValidatedUpload(fixture, "no-text");
    const result = await runDocumentTextExtractionWorkerOnce({
      workerId: `extraction-no-text-${randomUUID()}`,
      leaseTtlMs: LEASE_TTL_MS,
      extractionConfiguration: extractionConfiguration(),
      uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
      clientDependencies: extractionDependencies(async () => responseAt(
        EXTRACTION_ENDPOINT,
        extractedResponse(target, "no_text"),
      )),
    });
    assert.equal(result.kind, "no-text");
    assert.equal(result.outcome, "applied");

    const [job, asset, document, extraction] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: target.extractionJobId } }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
      prisma.documentTextExtraction.findFirstOrThrow({
        where: { jobId: target.extractionJobId },
      }),
    ]);
    assert.equal(job.status, "SUCCEEDED");
    assert.equal(asset.status, "READY");
    assert.equal(document.status, "READY");
    assert.equal(extraction.verdict, "NO_TEXT");
    assert.equal(extraction.chunkCount, 0);
    assert.equal(extraction.textBytes, 0);
    assert.equal(await prisma.documentTextChunk.count({
      where: { extractionId: extraction.id },
    }), 0);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("service, input-binding, and response failures use durable safe codes", async () => {
  const fixture = await createFixture("failures");
  try {
    const serviceTarget = await createValidatedUpload(fixture, "service-failure");
    const serviceResult = await runDocumentTextExtractionWorkerOnce({
      workerId: `extraction-service-failure-${randomUUID()}`,
      leaseTtlMs: LEASE_TTL_MS,
      extractionConfiguration: extractionConfiguration(),
      uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
      clientDependencies: extractionDependencies(async () => {
        throw new Error("connection reset containing private upstream detail");
      }),
    });
    assert.equal(serviceResult.kind, "retrying");
    await assertReadyWithoutExtraction(serviceTarget, {
      status: "RETRYING",
      errorCode: "extraction_service_unavailable",
    });
    await prisma.job.update({
      where: { id: serviceTarget.extractionJobId },
      data: { runAfter: new Date("2099-01-01T00:00:00.000Z") },
    });

    const busyTarget = await createValidatedUpload(fixture, "busy-before-admission");
    const busyResult = await runDocumentTextExtractionWorkerOnce({
      workerId: `extraction-busy-${randomUUID()}`,
      leaseTtlMs: LEASE_TTL_MS,
      extractionConfiguration: extractionConfiguration(),
      uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
      clientDependencies: extractionDependencies(async () => responseAt(
        EXTRACTION_ENDPOINT,
        {
          error: {
            code: "extractor_busy",
            message: "The document extractor is temporarily busy.",
          },
        },
        { status: 503, headers: { "Content-Type": "application/json" } },
      )),
    });
    assert.equal(busyResult.kind, "service-unavailable");
    const busyJob = await prisma.job.findUniqueOrThrow({
      where: { id: busyTarget.extractionJobId },
    });
    assert.equal(busyJob.status, "RETRYING");
    assert.equal(busyJob.attempts, 0);
    assert.equal(busyJob.lastErrorCode, "extraction_service_busy");
    assert.equal(await prisma.jobAttempt.count({
      where: { jobId: busyTarget.extractionJobId },
    }), 0);
    assert.equal(await prisma.auditEvent.count({
      where: {
        organizationId: fixture.organizationId,
        action: "document.text_extraction.admission_deferred",
        entityId: busyTarget.extractionJobId,
      },
    }), 1);
    // Keep this deliberately deferred target from becoming the next eligible
    // job while the remainder of this multi-target worker test runs.
    await prisma.job.update({
      where: { id: busyTarget.extractionJobId },
      data: { runAfter: new Date("2099-01-01T00:00:00.000Z") },
    });

    const unsupportedTarget = await createValidatedUpload(fixture, "unsupported-input");
    const unsupportedResult = await runDocumentTextExtractionWorkerOnce({
      workerId: `extraction-unsupported-${randomUUID()}`,
      leaseTtlMs: LEASE_TTL_MS,
      extractionConfiguration: extractionConfiguration(),
      uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
      clientDependencies: extractionDependencies(async () => responseAt(
        EXTRACTION_ENDPOINT,
        {
          error: {
            code: "extraction_input_unsupported",
            message: "The document input is not supported for text extraction.",
          },
        },
        { status: 422, headers: { "Content-Type": "application/json" } },
      )),
    });
    assert.equal(unsupportedResult.kind, "dead-letter");
    await assertReadyWithoutExtraction(unsupportedTarget, {
      status: "DEAD_LETTER",
      errorCode: "extraction_input_unsupported",
    });

    const inputTarget = await createValidatedUpload(fixture, "input-failure");
    const mismatched = extractedResponse(inputTarget);
    mismatched.input.sha256 = "d".repeat(64);
    const inputResult = await runDocumentTextExtractionWorkerOnce({
      workerId: `extraction-input-failure-${randomUUID()}`,
      leaseTtlMs: LEASE_TTL_MS,
      extractionConfiguration: extractionConfiguration(),
      uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
      clientDependencies: extractionDependencies(async () => responseAt(
        EXTRACTION_ENDPOINT,
        mismatched,
      )),
    });
    assert.equal(inputResult.kind, "dead-letter");
    await assertReadyWithoutExtraction(inputTarget, {
      status: "DEAD_LETTER",
      errorCode: "extraction_input_changed",
    });

    const responseTarget = await createValidatedUpload(fixture, "response-failure");
    const responseResult = await runDocumentTextExtractionWorkerOnce({
      workerId: `extraction-response-failure-${randomUUID()}`,
      leaseTtlMs: LEASE_TTL_MS,
      extractionConfiguration: extractionConfiguration(),
      uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
      clientDependencies: extractionDependencies(async () => rawResponseAt(
        EXTRACTION_ENDPOINT,
        "{not-json",
      )),
    });
    assert.equal(responseResult.kind, "dead-letter");
    await assertReadyWithoutExtraction(responseTarget, {
      status: "DEAD_LETTER",
      errorCode: "extraction_response_invalid",
    });

    const persistedMessages = await prisma.job.findMany({
      where: {
        id: {
          in: [
            serviceTarget.extractionJobId,
            busyTarget.extractionJobId,
            unsupportedTarget.extractionJobId,
            inputTarget.extractionJobId,
            responseTarget.extractionJobId,
          ],
        },
      },
      select: { lastErrorMessage: true },
    });
    assert.ok(persistedMessages.every((job) =>
      !job.lastErrorMessage?.includes("private upstream detail")));
  } finally {
    await cleanupFixture(fixture);
  }
});

test("a changed quarantine object is hashed and rejected before any extraction request", async () => {
  const fixture = await createFixture("tamper");
  try {
    const target = await createValidatedUpload(fixture, "tamper");
    const quarantinedPath = objectPath(fixture.quarantineRoot, target.storageKey);
    const changedBytes = new Uint8Array(target.bytes);
    changedBytes[12] ^= 1;
    assert.equal(changedBytes.byteLength, target.bytes.byteLength);
    await chmod(quarantinedPath, 0o600);
    await writeFile(quarantinedPath, changedBytes);
    await chmod(quarantinedPath, 0o400);

    let extractionCalled = false;
    const result = await runDocumentTextExtractionWorkerOnce({
      workerId: `extraction-tamper-${randomUUID()}`,
      leaseTtlMs: LEASE_TTL_MS,
      extractionConfiguration: extractionConfiguration(),
      uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
      clientDependencies: extractionDependencies(async () => {
        extractionCalled = true;
        throw new Error("Mismatched bytes must not cross the service boundary.");
      }),
    });
    assert.equal(result.kind, "dead-letter");
    assert.equal(extractionCalled, false);
    await assertReadyWithoutExtraction(target, {
      status: "DEAD_LETTER",
      errorCode: "extraction_input_changed",
    });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("caller cancellation fails safely after claim without persisting extraction", async () => {
  const fixture = await createFixture("caller-abort");
  try {
    const target = await createValidatedUpload(fixture, "caller-abort");
    const caller = new AbortController();
    const result = await runDocumentTextExtractionWorkerOnce({
      workerId: `extraction-caller-abort-${randomUUID()}`,
      leaseTtlMs: LEASE_TTL_MS,
      extractionConfiguration: extractionConfiguration(),
      uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
      signal: caller.signal,
      clientDependencies: extractionDependencies(async (_url, init) => {
        caller.abort();
        assert.equal(init.signal?.aborted, true);
        throw new DOMException("caller cancelled", "AbortError");
      }),
    });
    assert.equal(result.kind, "retrying");
    await assertReadyWithoutExtraction(target, {
      status: "RETRYING",
      errorCode: "extraction_service_unavailable",
    });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("a reclaimed lease fences the original worker from extraction persistence", async () => {
  const fixture = await createFixture("lease-fence");
  try {
    const target = await createValidatedUpload(fixture, "lease-fence");
    let rivalAttemptId: string | null = null;
    const result = await runDocumentTextExtractionWorkerOnce({
      workerId: `extraction-original-${randomUUID()}`,
      leaseTtlMs: LEASE_TTL_MS,
      extractionConfiguration: extractionConfiguration(),
      uploadConfiguration: { quarantineRoot: fixture.quarantineRoot },
      clientDependencies: extractionDependencies(async () => {
        const running = await prisma.job.findUniqueOrThrow({
          where: { id: target.extractionJobId },
        });
        assert.equal(running.status, "RUNNING");
        assert.ok(running.lockedAt);
        const forcedExpiry = new Date(running.lockedAt.getTime() + 1);
        await prisma.job.update({
          where: { id: target.extractionJobId },
          data: { leaseExpiresAt: forcedExpiry },
        });
        const rival = await claimNextDocumentTextExtractionJob({
          workerId: `extraction-rival-${randomUUID()}`,
          expectedPolicyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
          expectedToolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
          leaseTtlMs: LEASE_TTL_MS,
          now: new Date(forcedExpiry.getTime() + 1),
        });
        assert.ok(rival);
        assert.equal(rival.jobId, target.extractionJobId);
        assert.equal(rival.attemptNumber, 2);
        rivalAttemptId = rival.jobAttemptId;
        return responseAt(EXTRACTION_ENDPOINT, extractedResponse(target));
      }),
    });
    assert.equal(result.kind, "lease-lost");
    assert.ok(rivalAttemptId);

    const [job, attempts, asset, document] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: target.extractionJobId } }),
      prisma.jobAttempt.findMany({
        where: { jobId: target.extractionJobId },
        orderBy: { attemptNumber: "asc" },
      }),
      prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } }),
      prisma.document.findUniqueOrThrow({ where: { id: target.documentId } }),
    ]);
    assert.equal(job.status, "RUNNING");
    assert.equal(job.attempts, 2);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.status, "FAILED");
    assert.equal(attempts[0]?.errorCode, "worker_lease_expired");
    assert.equal(attempts[1]?.id, rivalAttemptId);
    assert.equal(attempts[1]?.status, "RUNNING");
    assert.equal(asset.status, "READY");
    assert.equal(document.status, "READY");
    assert.equal(await prisma.documentTextExtraction.count({
      where: { jobId: target.extractionJobId },
    }), 0);
    assert.equal(await prisma.documentTextChunk.count({
      where: { organizationId: fixture.organizationId },
    }), 0);
  } finally {
    await cleanupFixture(fixture);
  }
});
