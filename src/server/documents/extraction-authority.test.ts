import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  authoritativeExtractionJobState,
  authoritativeExtractionPolicyVersion,
  currentExtractionJobPayload,
  extractionChunkIsSound,
  extractionChunkTransitionIsSound,
  extractionChunksAreSound,
  extractionGenerationIsSound,
  extractionManifestAdmissionIsSound,
  type ExtractionAuthorityGeneration,
} from "./extraction-authority";
import type { ValidationAuthorityAttestation } from "./validation-authority";

const POLICY_VERSION = "paperpilot-text-extraction-v1";
const VALIDATION_CHECKED_AT = new Date("2026-08-28T12:00:00.000Z");
const EXTRACTED_AT = new Date("2026-08-28T12:00:01.000Z");
const COMPLETED_AT = new Date("2026-08-28T12:00:02.000Z");
const EXTRACTION_CHECKED_AT = new Date("2026-08-28T12:00:03.000Z");

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validation(): ValidationAuthorityAttestation & { pageCount: number } {
  return {
    id: "validation-one",
    jobId: "validation-job-one",
    jobAttemptId: "validation-attempt-one",
    documentId: "document-one",
    assetId: "asset-one",
    inputSha256: digest("input"),
    inputSizeBytes: 1_337n,
    storageVersion: "paperpilot-local-quarantine-v1",
    policyVersion: "paperpilot-document-validation-v1",
    toolchainDigest: digest("validation-toolchain"),
    verdict: "ACCEPTED",
    rejectionCode: null,
    malwareVerdict: "CLEAN",
    signaturePublishedAt: new Date("2026-08-28T11:58:00.000Z"),
    scannedAt: new Date("2026-08-28T11:59:00.000Z"),
    pdfStructuralVerdict: "VALID",
    pageCount: 2,
    objectCount: 12,
    revisionCount: 1,
    checkedAt: VALIDATION_CHECKED_AT,
    result: null,
    job: {
      id: "validation-job-one",
      type: "DOCUMENT_VALIDATE",
      status: "SUCCEEDED",
      documentId: "document-one",
      assetId: "asset-one",
      attempts: 1,
    },
    jobAttempt: {
      id: "validation-attempt-one",
      jobId: "validation-job-one",
      status: "SUCCEEDED",
      attemptNumber: 1,
    },
  };
}

function generation(): ExtractionAuthorityGeneration {
  const chunks = [
    { id: "chunk-one", sequence: 0, text: "Alpha" },
    { id: "chunk-two", sequence: 1, text: "Beta" },
  ].map((chunk) => ({
    ...chunk,
    pageStart: 1,
    pageEnd: 1,
    sectionId: null,
    sectionTitle: null,
    paragraphId: "p1-p1",
    charStart: null,
    charEnd: null,
    contentHash: digest(chunk.text),
    locator: {
      schemaVersion: 1,
      kind: "pdf-text",
      pageNumber: 1,
      paragraphId: "p1-p1",
    },
  }));
  return {
    id: "generation-one",
    jobId: "extraction-job-one",
    jobAttemptId: "extraction-attempt-one",
    validationAttestationId: "validation-one",
    assetId: "asset-one",
    documentId: "document-one",
    inputSha256: digest("input"),
    inputSizeBytes: 1_337n,
    storageVersion: "paperpilot-local-quarantine-v1",
    extractionPolicyVersion: POLICY_VERSION,
    toolchainDigest: digest("extraction-toolchain"),
    verdict: "EXTRACTED",
    engine: "poppler",
    engineVersion: "25.06.0",
    pageCount: 2,
    chunkCount: chunks.length,
    textBytes: chunks.reduce(
      (total, chunk) => total + Buffer.byteLength(chunk.text, "utf8"),
      0,
    ),
    extractedAt: EXTRACTED_AT,
    completedAt: COMPLETED_AT,
    durationMs: 900,
    totalDurationMs: 1_000,
    checkedAt: EXTRACTION_CHECKED_AT,
    result: {
      schemaVersion: 1,
      engine: "poppler",
      engineVersion: "25.06.0",
      extractedAt: EXTRACTED_AT.toISOString(),
      completedAt: COMPLETED_AT.toISOString(),
      durationMs: 900,
      totalDurationMs: 1_000,
    },
    job: {
      id: "extraction-job-one",
      type: "TEXT_EXTRACTION",
      status: "SUCCEEDED",
      documentId: "document-one",
      assetId: "asset-one",
    },
    jobAttempt: {
      id: "extraction-attempt-one",
      jobId: "extraction-job-one",
      status: "SUCCEEDED",
    },
    chunks,
  };
}

test("extraction authority accepts only the exact current job binding", () => {
  const acceptedValidation = validation();
  const payload = {
    schemaVersion: 1,
    source: "accepted-document-validation",
    validationAttestationId: acceptedValidation.id,
    policyVersion: POLICY_VERSION,
    storageVersion: acceptedValidation.storageVersion,
    toolchainDigest: digest("extraction-toolchain"),
  };
  assert.deepEqual(
    currentExtractionJobPayload(payload, acceptedValidation, POLICY_VERSION),
    payload,
  );
  assert.equal(
    currentExtractionJobPayload({ ...payload, extra: true }, acceptedValidation, POLICY_VERSION),
    null,
  );
  assert.equal(
    currentExtractionJobPayload(
      { ...payload, validationAttestationId: "validation-other" },
      acceptedValidation,
      POLICY_VERSION,
    ),
    null,
  );
  assert.equal(
    currentExtractionJobPayload(
      { ...payload, toolchainDigest: "0".repeat(64) },
      acceptedValidation,
      POLICY_VERSION,
    ),
    null,
  );
});

test("extraction authority validates the complete generation and chunk manifest", () => {
  const acceptedValidation = validation();
  const extracted = generation();
  assert.equal(
    extractionGenerationIsSound(extracted, acceptedValidation, POLICY_VERSION),
    true,
  );
  assert.equal(extractionChunksAreSound(extracted), true);

  assert.equal(
    extractionGenerationIsSound(
      { ...extracted, inputSha256: digest("drift") },
      acceptedValidation,
      POLICY_VERSION,
    ),
    false,
  );
  assert.equal(
    extractionGenerationIsSound(
      { ...extracted, result: { ...(extracted.result as object), extra: true } },
      acceptedValidation,
      POLICY_VERSION,
    ),
    false,
  );
  assert.equal(extractionChunksAreSound({
    ...extracted,
    chunks: extracted.chunks.map((chunk, index) => index === 1
      ? { ...chunk, text: "Beta  drift" }
      : chunk),
  }), false);

  const noText: ExtractionAuthorityGeneration = {
    ...extracted,
    verdict: "NO_TEXT",
    chunkCount: 0,
    textBytes: 0,
    chunks: [],
  };
  assert.equal(
    extractionGenerationIsSound(noText, acceptedValidation, POLICY_VERSION),
    true,
  );
  assert.equal(extractionChunksAreSound(noText), true);
  assert.equal(extractionChunksAreSound({
    ...noText,
    textBytes: 1,
  }), false);
});

test("extraction authority validates a compact admission and bounded chunk transitions", () => {
  const extracted = generation();
  const admission = {
    extractionId: extracted.id,
    organizationId: "organization-one",
    documentId: extracted.documentId,
    schemaVersion: 1,
    verdict: extracted.verdict,
    pageCount: extracted.pageCount,
    chunkCount: extracted.chunkCount,
    textBytes: extracted.textBytes,
    manifestSha256: digest("manifest-v1"),
    admittedAt: new Date("2026-08-28T12:00:04.000Z"),
  };
  assert.equal(
    extractionManifestAdmissionIsSound(admission, extracted, "organization-one"),
    true,
  );
  assert.equal(
    extractionManifestAdmissionIsSound(
      { ...admission, chunkCount: admission.chunkCount + 1 },
      extracted,
      "organization-one",
    ),
    false,
  );
  assert.equal(extractionChunkIsSound(extracted, extracted.chunks[0]!), true);
  assert.equal(
    extractionChunkTransitionIsSound(extracted.chunks[0]!, extracted.chunks[1]!),
    true,
  );
  assert.equal(
    extractionChunkTransitionIsSound(
      extracted.chunks[0]!,
      { ...extracted.chunks[1]!, sequence: 2 },
    ),
    false,
  );
});

test("extraction authority policy selection is closed and environment-aware", () => {
  assert.equal(authoritativeExtractionPolicyVersion({}), POLICY_VERSION);
  assert.equal(
    authoritativeExtractionPolicyVersion({
      PAPERPILOT_EXTRACTION_POLICY_VERSION: "deployment-policy-v2",
    }),
    "deployment-policy-v2",
  );
  assert.throws(
    () => authoritativeExtractionPolicyVersion({
      PAPERPILOT_EXTRACTION_POLICY_VERSION: "invalid policy",
    }),
    /invalid for extraction authority/,
  );
});

test("extraction authority classifies durable job counters consistently", () => {
  assert.equal(authoritativeExtractionJobState("QUEUED", 0, 4), "queued");
  assert.equal(authoritativeExtractionJobState("RETRYING", 1, 4), "queued");
  assert.equal(authoritativeExtractionJobState("RUNNING", 1, 4), "extracting");
  assert.equal(authoritativeExtractionJobState("SUCCEEDED", 1, 4), "succeeded");
  assert.equal(authoritativeExtractionJobState("RETRYING", 0, 4), "failed");
  assert.equal(authoritativeExtractionJobState("RETRYING", 4, 4), "failed");
  assert.equal(authoritativeExtractionJobState("RUNNING", 0, 4), "failed");
  assert.equal(authoritativeExtractionJobState("SUCCEEDED", 0, 4), "failed");
  assert.equal(authoritativeExtractionJobState("FAILED", 1, 4), "failed");
});
