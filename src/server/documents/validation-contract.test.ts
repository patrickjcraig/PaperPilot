import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DocumentValidationContractError,
  parseExternalDocumentValidationResponse,
  type DocumentValidationContractFailure,
  type DocumentValidationResponseExpectations,
  type ExternalDocumentValidationResponse,
} from "./validation-contract";

const SHA256 = "a".repeat(64);
const TOOLCHAIN_DIGEST = "b".repeat(64);
const POLICY_VERSION = "paperpilot-document-validation-v1";
const STORAGE_VERSION = "local-quarantine-v2";
const NOW = new Date("2026-08-28T12:00:00.000Z");

interface MutableResponse extends Record<string, unknown> {
  input: Record<string, unknown>;
  malware: Record<string, unknown>;
  pdf: Record<string, unknown>;
}

const EXPECTATIONS: DocumentValidationResponseExpectations = {
  expectedSha256: SHA256,
  expectedSizeBytes: 123n,
  expectedStorageVersion: STORAGE_VERSION,
  expectedPolicyVersion: POLICY_VERSION,
  now: NOW,
  signatureMaxAgeMs: 24 * 60 * 60 * 1_000,
  futureClockSkewMs: 5 * 60 * 1_000,
  maxDurationMs: 30_000,
};

function acceptedResponse(): ExternalDocumentValidationResponse {
  return {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    storageVersion: STORAGE_VERSION,
    toolchainDigest: TOOLCHAIN_DIGEST,
    verdict: "accepted",
    rejectionCode: null,
    input: { sha256: SHA256, sizeBytes: "123" },
    malware: {
      verdict: "clean",
      engine: "clamav",
      engineVersion: "1.5.4",
      signatureVersion: "27712",
      signaturePublishedAt: "2026-08-28T06:00:00.000Z",
      scannedAt: "2026-08-28T11:59:00.000Z",
      detectionCount: 0,
      durationMs: 100,
    },
    pdf: {
      structuralVerdict: "valid",
      engine: "qpdf+poppler",
      engineVersion: "12.4.1+26.05.0",
      pdfVersion: "1.7",
      pageCount: 12,
      objectCount: 840,
      revisionCount: 1,
      warningCount: 0,
      checkedAt: "2026-08-28T11:59:10.000Z",
      durationMs: 200,
    },
    completedAt: "2026-08-28T11:59:20.000Z",
    totalDurationMs: 350,
  };
}

function cloneResponse(): MutableResponse {
  return JSON.parse(JSON.stringify(acceptedResponse())) as MutableResponse;
}

function assertContractFailure(
  action: () => unknown,
  failure: DocumentValidationContractFailure,
): void {
  assert.throws(action, (error: unknown) =>
    error instanceof DocumentValidationContractError
      && error.failure === failure,
  );
}

describe("external document validation response contract", () => {
  it("normalizes one accepted response into persistence-shaped bounded evidence", () => {
    const attestation = parseExternalDocumentValidationResponse(
      acceptedResponse(),
      EXPECTATIONS,
    );
    assert.equal(attestation.inputSha256, SHA256);
    assert.equal(attestation.inputSizeBytes, 123n);
    assert.equal(attestation.storageVersion, STORAGE_VERSION);
    assert.equal(attestation.policyVersion, POLICY_VERSION);
    assert.equal(attestation.toolchainDigest, TOOLCHAIN_DIGEST);
    assert.equal(attestation.verdict, "ACCEPTED");
    assert.equal(attestation.rejectionCode, null);
    assert.equal(attestation.malwareVerdict, "CLEAN");
    assert.equal(attestation.pdfStructuralVerdict, "VALID");
    assert.equal(attestation.pdfVersion, "1.7");
    assert.equal(attestation.pageCount, 12);
    assert.equal(attestation.objectCount, 840);
    assert.equal(attestation.revisionCount, 1);
    assert.equal(
      attestation.signaturePublishedAt.toISOString(),
      "2026-08-28T06:00:00.000Z",
    );
    assert.equal(attestation.checkedAt.toISOString(), "2026-08-28T11:59:10.000Z");
    assert.deepEqual(attestation.result, {
      schemaVersion: 1,
      detectionCount: 0,
      warningCount: 0,
      malwareDurationMs: 100,
      pdfDurationMs: 200,
      totalDurationMs: 350,
      completedAt: "2026-08-28T11:59:20.000Z",
    });
  });

  it("accepts only consistent fixed rejection combinations", () => {
    const malware = cloneResponse();
    malware.verdict = "rejected";
    malware.rejectionCode = "malware_detected";
    malware.malware.verdict = "infected";
    malware.malware.detectionCount = 1;
    const malwareAttestation = parseExternalDocumentValidationResponse(
      malware,
      EXPECTATIONS,
    );
    assert.equal(malwareAttestation.verdict, "REJECTED");
    assert.equal(malwareAttestation.malwareVerdict, "INFECTED");

    const policyViolation = cloneResponse();
    policyViolation.verdict = "rejected";
    policyViolation.rejectionCode = "pdf_policy_violation";
    assert.equal(
      parseExternalDocumentValidationResponse(policyViolation, EXPECTATIONS)
        .rejectionCode,
      "pdf_policy_violation",
    );

    for (const code of ["pdf_invalid", "pdf_resource_limit_exceeded"]) {
      const invalidPdf = cloneResponse();
      invalidPdf.verdict = "rejected";
      invalidPdf.rejectionCode = code;
      invalidPdf.pdf.structuralVerdict = "invalid";
      invalidPdf.pdf.pdfVersion = "unknown";
      invalidPdf.pdf.pageCount = null;
      invalidPdf.pdf.objectCount = null;
      invalidPdf.pdf.revisionCount = null;
      invalidPdf.pdf.warningCount = 1;
      assert.equal(
        parseExternalDocumentValidationResponse(invalidPdf, EXPECTATIONS).rejectionCode,
        code,
      );
    }

    const both = cloneResponse();
    both.verdict = "rejected";
    both.rejectionCode = "malware_and_pdf_invalid";
    both.malware.verdict = "infected";
    both.malware.detectionCount = 2;
    both.pdf.structuralVerdict = "invalid";
    both.pdf.pdfVersion = "unknown";
    both.pdf.pageCount = null;
    both.pdf.objectCount = null;
    both.pdf.revisionCount = null;
    assert.equal(
      parseExternalDocumentValidationResponse(both, EXPECTATIONS).rejectionCode,
      "malware_and_pdf_invalid",
    );
  });

  it("requires an exact closed schema at every object level", () => {
    for (const mutate of [
      (response: MutableResponse) => { response.providerMessage = "extra"; },
      (response: MutableResponse) => { delete response.completedAt; },
      (response: MutableResponse) => { response.input.extra = true; },
      (response: MutableResponse) => { delete response.malware.durationMs; },
      (response: MutableResponse) => { response.pdf.rawOutput = "parser details"; },
      (response: MutableResponse) => { response.schemaVersion = 2; },
    ]) {
      const response = cloneResponse();
      mutate(response);
      assertContractFailure(
        () => parseExternalDocumentValidationResponse(response, EXPECTATIONS),
        "invalid_response",
      );
    }
  });

  it("binds the attestation to exact SHA-256, size, storage, and policy", () => {
    for (const mutate of [
      (response: MutableResponse) => { response.input.sha256 = "c".repeat(64); },
      (response: MutableResponse) => { response.input.sizeBytes = "124"; },
    ]) {
      const response = cloneResponse();
      mutate(response);
      assertContractFailure(
        () => parseExternalDocumentValidationResponse(response, EXPECTATIONS),
        "content_binding_mismatch",
      );
    }

    const nonCanonicalSize = cloneResponse();
    nonCanonicalSize.input.sizeBytes = "0123";
    assertContractFailure(
      () => parseExternalDocumentValidationResponse(nonCanonicalSize, EXPECTATIONS),
      "invalid_response",
    );

    const storage = cloneResponse();
    storage.storageVersion = "other-storage-version";
    assertContractFailure(
      () => parseExternalDocumentValidationResponse(storage, EXPECTATIONS),
      "storage_binding_mismatch",
    );

    const policy = cloneResponse();
    policy.policyVersion = "other-policy-v1";
    assertContractFailure(
      () => parseExternalDocumentValidationResponse(policy, EXPECTATIONS),
      "policy_binding_mismatch",
    );
  });

  it("rejects verdict, scanner, parser, and rejection-code inconsistencies", () => {
    for (const mutate of [
      (response: MutableResponse) => {
        response.malware.verdict = "infected";
        response.malware.detectionCount = 1;
      },
      (response: MutableResponse) => {
        response.verdict = "rejected";
        response.rejectionCode = "pdf_invalid";
      },
      (response: MutableResponse) => {
        response.verdict = "rejected";
        response.rejectionCode = "pdf_policy_violation";
        response.pdf.structuralVerdict = "invalid";
        response.pdf.pdfVersion = "unknown";
        response.pdf.pageCount = null;
        response.pdf.objectCount = null;
        response.pdf.revisionCount = null;
      },
      (response: MutableResponse) => { response.malware.detectionCount = 1; },
      (response: MutableResponse) => { response.pdf.warningCount = 1; },
      (response: MutableResponse) => {
        response.verdict = "rejected";
        response.rejectionCode = "pdf_invalid";
        response.malware.verdict = "infected";
        response.malware.detectionCount = 1;
      },
      (response: MutableResponse) => {
        response.verdict = "rejected";
        response.rejectionCode = null;
        response.pdf.structuralVerdict = "invalid";
      },
    ]) {
      const response = cloneResponse();
      mutate(response);
      assertContractFailure(
        () => parseExternalDocumentValidationResponse(response, EXPECTATIONS),
        "invalid_response",
      );
    }
  });

  it("bounds identifiers, PDF fields, counts, durations, and canonical timestamps", () => {
    for (const mutate of [
      (response: MutableResponse) => { response.malware.engine = "x".repeat(65); },
      (response: MutableResponse) => { response.malware.engineVersion = "bad version"; },
      (response: MutableResponse) => { response.malware.detectionCount = 129; },
      (response: MutableResponse) => { response.pdf.pdfVersion = "1.8"; },
      (response: MutableResponse) => { response.pdf.pageCount = 0; },
      (response: MutableResponse) => { response.pdf.objectCount = 10_000_001; },
      (response: MutableResponse) => { response.pdf.revisionCount = 10_001; },
      (response: MutableResponse) => { response.pdf.warningCount = 10_001; },
      (response: MutableResponse) => { response.totalDurationMs = 30_001; },
      (response: MutableResponse) => { response.totalDurationMs = 99; },
      (response: MutableResponse) => {
        response.malware.signaturePublishedAt = "2026-08-28T06:00:00Z";
      },
      (response: MutableResponse) => {
        response.pdf.checkedAt = "not-a-timestamp";
      },
      (response: MutableResponse) => {
        response.toolchainDigest = "B".repeat(64);
      },
    ]) {
      const response = cloneResponse();
      mutate(response);
      assertContractFailure(
        () => parseExternalDocumentValidationResponse(response, EXPECTATIONS),
        "invalid_response",
      );
    }
  });

  it("fails closed for stale signatures, future clocks, and invalid chronology", () => {
    const stale = cloneResponse();
    stale.malware.signaturePublishedAt = "2026-08-27T11:59:59.999Z";
    assertContractFailure(
      () => parseExternalDocumentValidationResponse(stale, EXPECTATIONS),
      "signatures_stale",
    );

    for (const mutate of [
      (response: MutableResponse) => {
        response.malware.signaturePublishedAt = "2026-08-28T12:05:00.001Z";
        response.malware.scannedAt = "2026-08-28T12:05:00.001Z";
        response.pdf.checkedAt = "2026-08-28T12:05:00.001Z";
        response.completedAt = "2026-08-28T12:05:00.001Z";
      },
      (response: MutableResponse) => {
        response.pdf.checkedAt = "2026-08-28T12:05:00.001Z";
        response.completedAt = "2026-08-28T12:05:00.001Z";
      },
    ]) {
      const response = cloneResponse();
      mutate(response);
      assertContractFailure(
        () => parseExternalDocumentValidationResponse(response, EXPECTATIONS),
        "clock_invalid",
      );
    }

    for (const mutate of [
      (response: MutableResponse) => {
        response.malware.signaturePublishedAt = "2026-08-28T11:59:01.000Z";
      },
      (response: MutableResponse) => {
        response.completedAt = "2026-08-28T11:58:00.000Z";
      },
      (response: MutableResponse) => {
        response.pdf.checkedAt = "2026-08-28T11:58:59.999Z";
      },
    ]) {
      const response = cloneResponse();
      mutate(response);
      assertContractFailure(
        () => parseExternalDocumentValidationResponse(response, EXPECTATIONS),
        "invalid_response",
      );
    }
  });
});
