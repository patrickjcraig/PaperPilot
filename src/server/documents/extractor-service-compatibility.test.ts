import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtractorConfiguration } from "../../../services/document-extractor/src/config";
import { createDocumentExtractorService } from "../../../services/document-extractor/src/service";
import type {
  ExtractionRunner,
  PopplerExtraction,
} from "../../../services/document-extractor/src/types";
import {
  DocumentExtractionServiceError,
  probeExternalDocumentExtractionReadiness,
  requestExternalDocumentExtraction,
} from "./extraction-client";
import type { DocumentExtractionServiceConfiguration } from "./extraction-config";

const SECRET = "extractor-compatibility-secret-with-48-characters-x";
const POLICY_VERSION = "paperpilot-text-extraction-v1";
const STORAGE_VERSION = "local-quarantine-v2";
const TOOLCHAIN_DIGEST = "e".repeat(64);
const PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstartxref\n0\n%%EOF\n",
);

class CompatibilityExtractionRunner implements ExtractionRunner {
  extraction: PopplerExtraction = {
    outcome: "extracted",
    engine: "poppler",
    engineVersion: "26.05.0",
    pageCount: 2,
    chunkCount: 2,
    textBytes: Buffer.byteLength("First paragraphSecond paragraph", "utf8"),
    chunks: [
      { sequence: 0, pageNumber: 1, paragraphId: "p1-p1", text: "First paragraph" },
      { sequence: 1, pageNumber: 2, paragraphId: "p2-p1", text: "Second paragraph" },
    ],
  };

  async ready(): Promise<{ engine: "poppler"; engineVersion: string }> {
    return { engine: "poppler", engineVersion: "26.05.0" };
  }

  async inspect(): Promise<PopplerExtraction> {
    return {
      ...this.extraction,
      chunks: this.extraction.chunks.map((chunk) => ({ ...chunk })),
    };
  }
}

function extractorConfiguration(tempRoot: string): ExtractorConfiguration {
  return {
    production: false,
    unsafeWindowsDevelopment: process.platform === "win32",
    host: "127.0.0.1",
    port: 0,
    route: "/v1/extract-pdf",
    bearerSecret: SECRET,
    policyVersion: POLICY_VERSION,
    toolchainDigest: TOOLCHAIN_DIGEST,
    maxBodyBytes: 1 * 1_024 * 1_024,
    maxPageCount: 100,
    maxTextBytes: 64 * 1_024,
    maxChunkCount: 16,
    maxChunkBytes: 8 * 1_024,
    maxResponseBytes: 128 * 1_024,
    bodyIdleTimeoutMs: 1_000,
    bodyAbsoluteTimeoutMs: 2_000,
    extractionTimeoutMs: 2_000,
    readinessTimeoutMs: 1_000,
    readinessCacheMs: 0,
    gracefulShutdownMs: 1_000,
    maxConcurrentExtractions: 1,
    singleUse: false,
    maxHeaderBytes: 8 * 1_024,
    maxRequestsPerSocket: 10,
    tempRoot,
  };
}

function clientConfiguration(port: number): DocumentExtractionServiceConfiguration {
  return {
    endpoint: `http://127.0.0.1:${port}/v1/extract-pdf`,
    readinessEndpoint: `http://127.0.0.1:${port}/readyz`,
    bearerSecret: SECRET,
    policyVersion: POLICY_VERSION,
    expectedToolchainDigest: TOOLCHAIN_DIGEST,
    timeoutMs: 5_000,
    maxResponseBytes: 128 * 1_024,
    resultMaxAgeMs: 15 * 60 * 1_000,
    futureClockSkewMs: 5 * 60 * 1_000,
  };
}

function requestInput(expectedEngineVersion = "26.05.0") {
  return {
    expectedSha256: createHash("sha256").update(PDF_BYTES).digest("hex"),
    expectedSizeBytes: BigInt(PDF_BYTES.byteLength),
    expectedStorageVersion: STORAGE_VERSION,
    expectedEngineVersion,
    bodyFactory: () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PDF_BYTES);
        controller.close();
      },
    }),
  };
}

test("the production PaperPilot client accepts the standalone extractor's exact wire contract", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "paperpilot-extractor-compat-"));
  const extractionRunner = new CompatibilityExtractionRunner();
  const service = createDocumentExtractorService(
    extractorConfiguration(tempRoot),
    { extractionRunner },
  );

  try {
    const address = await service.listen();
    const configuration = clientConfiguration(address.port);

    const readiness = await probeExternalDocumentExtractionReadiness(configuration);
    const extracted = await requestExternalDocumentExtraction(
      requestInput(readiness.engineVersion),
      configuration,
    );
    assert.equal(extracted.verdict, "EXTRACTED");
    assert.equal(extracted.inputSha256, requestInput().expectedSha256);
    assert.equal(extracted.inputSizeBytes, BigInt(PDF_BYTES.byteLength));
    assert.equal(extracted.policyVersion, POLICY_VERSION);
    assert.equal(extracted.storageVersion, STORAGE_VERSION);
    assert.equal(extracted.toolchainDigest, TOOLCHAIN_DIGEST);
    assert.equal(extracted.engine, "poppler");
    assert.equal(extracted.pageCount, 2);
    assert.deepEqual(extracted.chunks.map((chunk) => ({ ...chunk })), [
      { sequence: 0, pageNumber: 1, paragraphId: "p1-p1", text: "First paragraph" },
      { sequence: 1, pageNumber: 2, paragraphId: "p2-p1", text: "Second paragraph" },
    ]);

    extractionRunner.extraction = {
      outcome: "no_text",
      engine: "poppler",
      engineVersion: "26.05.0",
      pageCount: 2,
      chunkCount: 0,
      textBytes: 0,
      chunks: [],
    };
    const noText = await requestExternalDocumentExtraction(
      requestInput(readiness.engineVersion),
      configuration,
    );
    assert.equal(noText.verdict, "NO_TEXT");
    assert.equal(noText.chunkCount, 0);
    assert.deepEqual(noText.chunks, []);

    extractionRunner.extraction = {
      ...extractionRunner.extraction,
      engineVersion: "26.06.0",
    };
    await assert.rejects(
      requestExternalDocumentExtraction(
        requestInput(readiness.engineVersion),
        configuration,
      ),
      (error: unknown) => {
        assert.ok(error instanceof DocumentExtractionServiceError);
        assert.equal(error.code, "extraction_service_engine_mismatch");
        assert.equal(error.retryable, true);
        return true;
      },
    );

    await assert.rejects(
      probeExternalDocumentExtractionReadiness({
        ...configuration,
        bearerSecret: "wrong-extractor-secret-with-more-than-32-characters",
      }),
      (error: unknown) => {
        assert.ok(error instanceof DocumentExtractionServiceError);
        assert.equal(error.code, "extraction_service_configuration_error");
        assert.equal(error.retryable, false);
        return true;
      },
    );
  } finally {
    await service.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
