import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ValidatorConfiguration } from "../../../services/document-validator/src/config";
import { createDocumentValidatorService } from "../../../services/document-validator/src/service";
import type {
  MalwareInspection,
  MalwareRunner,
  PdfInspection,
  PdfInspectionRunner,
} from "../../../services/document-validator/src/types";
import {
  DocumentValidationServiceError,
  probeExternalDocumentValidationReadiness,
  requestExternalDocumentValidation,
} from "./validation-client";
import type { DocumentValidationServiceConfiguration } from "./validation-config";

const SECRET = "validator-compatibility-secret-with-48-characters-x";
const POLICY_VERSION = "paperpilot-document-validation-v1";
const STORAGE_VERSION = "local-quarantine-v2";
const TOOLCHAIN_DIGEST = "d".repeat(64);
const PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstartxref\n0\n%%EOF\n",
);

class CompatibilityMalwareRunner implements MalwareRunner {
  async ready(): Promise<void> {}

  async inspect(): Promise<MalwareInspection> {
    return {
      verdict: "clean",
      engine: "clamav",
      engineVersion: "1.5.4",
      signatureVersion: "27712",
      signaturePublishedAt: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
      detectionCount: 0,
    };
  }
}

class CompatibilityPdfRunner implements PdfInspectionRunner {
  inspection: PdfInspection = {
    outcome: "valid",
    engine: "qpdf",
    engineVersion: "12.4.1",
    pdfVersion: "1.7",
    pageCount: 1,
    objectCount: 1,
    revisionCount: 1,
    warningCount: 0,
  };

  async ready(): Promise<void> {}

  async inspect(): Promise<PdfInspection> {
    return { ...this.inspection };
  }
}

function validatorConfiguration(tempRoot: string): ValidatorConfiguration {
  return {
    production: false,
    unsafeWindowsDevelopment: process.platform === "win32",
    host: "127.0.0.1",
    port: 0,
    route: "/v1/validate-pdf",
    bearerSecret: SECRET,
    policyVersion: POLICY_VERSION,
    toolchainDigest: TOOLCHAIN_DIGEST,
    maxBodyBytes: 1_024 * 1_024,
    maxAttestationBytes: 16 * 1_024,
    bodyIdleTimeoutMs: 1_000,
    bodyAbsoluteTimeoutMs: 2_000,
    validationTimeoutMs: 2_000,
    readinessTimeoutMs: 1_000,
    readinessCacheMs: 0,
    gracefulShutdownMs: 1_000,
    maxConcurrentValidations: 1,
    maxPageCount: 100_000,
    maxObjectCount: 10_000_000,
    maxRevisionCount: 10_000,
    signatureReadinessMaxAgeMs: 23 * 60 * 60 * 1_000,
    signatureFutureClockSkewMs: 5 * 60 * 1_000,
    maxHeaderBytes: 8 * 1_024,
    maxRequestsPerSocket: 10,
    tempRoot,
  };
}

function clientConfiguration(port: number): DocumentValidationServiceConfiguration {
  return {
    endpoint: `http://127.0.0.1:${port}/v1/validate-pdf`,
    readinessEndpoint: `http://127.0.0.1:${port}/readyz`,
    bearerSecret: SECRET,
    policyVersion: POLICY_VERSION,
    timeoutMs: 5_000,
    maxResponseBytes: 16 * 1_024,
    signatureMaxAgeMs: 24 * 60 * 60 * 1_000,
    futureClockSkewMs: 5 * 60 * 1_000,
  };
}

function requestInput() {
  return {
    expectedSha256: createHash("sha256").update(PDF_BYTES).digest("hex"),
    expectedSizeBytes: BigInt(PDF_BYTES.byteLength),
    expectedStorageVersion: STORAGE_VERSION,
    bodyFactory: () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PDF_BYTES);
        controller.close();
      },
    }),
  };
}

test("the production PaperPilot client accepts the standalone validator's exact wire contract", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "paperpilot-validator-compat-"));
  const pdfRunner = new CompatibilityPdfRunner();
  const service = createDocumentValidatorService(
    validatorConfiguration(tempRoot),
    {
      malwareRunner: new CompatibilityMalwareRunner(),
      pdfRunner,
    },
  );

  try {
    const address = await service.listen();
    const configuration = clientConfiguration(address.port);

    await probeExternalDocumentValidationReadiness(configuration);
    const accepted = await requestExternalDocumentValidation(
      requestInput(),
      configuration,
    );
    assert.equal(accepted.verdict, "ACCEPTED");
    assert.equal(accepted.rejectionCode, null);
    assert.equal(accepted.inputSha256, requestInput().expectedSha256);
    assert.equal(accepted.inputSizeBytes, BigInt(PDF_BYTES.byteLength));
    assert.equal(accepted.policyVersion, POLICY_VERSION);
    assert.equal(accepted.storageVersion, STORAGE_VERSION);
    assert.equal(accepted.toolchainDigest, TOOLCHAIN_DIGEST);

    pdfRunner.inspection = {
      outcome: "invalid",
      engine: "qpdf",
      engineVersion: "12.4.1",
      pdfVersion: "unknown",
      pageCount: null,
      objectCount: null,
      revisionCount: null,
      warningCount: 1,
    };
    const rejected = await requestExternalDocumentValidation(
      requestInput(),
      configuration,
    );
    assert.equal(rejected.verdict, "REJECTED");
    assert.equal(rejected.rejectionCode, "pdf_invalid");

    await assert.rejects(
      probeExternalDocumentValidationReadiness({
        ...configuration,
        bearerSecret: "wrong-validator-secret-with-more-than-32-characters",
      }),
      (error: unknown) => {
        assert.ok(error instanceof DocumentValidationServiceError);
        assert.equal(error.code, "validation_service_configuration_error");
        assert.equal(error.retryable, false);
        return true;
      },
    );
  } finally {
    await service.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
