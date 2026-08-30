import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_DOCUMENT_EXTRACTION_FUTURE_CLOCK_SKEW_MS,
  DEFAULT_DOCUMENT_EXTRACTION_MAX_RESPONSE_BYTES,
  DEFAULT_DOCUMENT_EXTRACTION_RESULT_MAX_AGE_MS,
  DEFAULT_DOCUMENT_EXTRACTION_TIMEOUT_MS,
  DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
  documentExtractionServiceConfigurationFromEnvironment,
} from "./extraction-config";

const BASE_ENVIRONMENT = {
  NODE_ENV: "production",
  PAPERPILOT_EXTRACTION_SERVICE_ENDPOINT:
    "https://extractor.paperpilot.test/v1/extract-pdf",
  PAPERPILOT_EXTRACTION_SERVICE_BEARER_SECRET:
    "extraction-service-secret-with-more-than-32-characters",
  PAPERPILOT_EXTRACTION_POLICY_VERSION: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
  PAPERPILOT_EXTRACTION_EXPECTED_TOOLCHAIN_DIGEST: "b".repeat(64),
} as const;

describe("document extraction service configuration", () => {
  it("requires one exact HTTPS endpoint, same-origin readiness, and a strong secret", () => {
    assert.deepEqual(
      documentExtractionServiceConfigurationFromEnvironment(BASE_ENVIRONMENT),
      {
        endpoint: "https://extractor.paperpilot.test/v1/extract-pdf",
        readinessEndpoint: "https://extractor.paperpilot.test/readyz",
        bearerSecret: BASE_ENVIRONMENT.PAPERPILOT_EXTRACTION_SERVICE_BEARER_SECRET,
        policyVersion: DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
        expectedToolchainDigest: BASE_ENVIRONMENT.PAPERPILOT_EXTRACTION_EXPECTED_TOOLCHAIN_DIGEST,
        timeoutMs: DEFAULT_DOCUMENT_EXTRACTION_TIMEOUT_MS,
        maxResponseBytes: DEFAULT_DOCUMENT_EXTRACTION_MAX_RESPONSE_BYTES,
        resultMaxAgeMs: DEFAULT_DOCUMENT_EXTRACTION_RESULT_MAX_AGE_MS,
        futureClockSkewMs: DEFAULT_DOCUMENT_EXTRACTION_FUTURE_CLOCK_SKEW_MS,
      },
    );

    for (const endpoint of [
      "http://extractor.paperpilot.test/v1/extract-pdf",
      "https://user@extractor.paperpilot.test/v1/extract-pdf",
      "https://extractor.paperpilot.test/v1/extract-pdf?mode=fast",
      "https://extractor.paperpilot.test/v1/extract-pdf#fragment",
      " relative/extraction",
    ]) {
      assert.throws(() => documentExtractionServiceConfigurationFromEnvironment({
        ...BASE_ENVIRONMENT,
        PAPERPILOT_EXTRACTION_SERVICE_ENDPOINT: endpoint,
      }));
    }
    for (const readinessEndpoint of [
      "https://other.paperpilot.test/readyz",
      BASE_ENVIRONMENT.PAPERPILOT_EXTRACTION_SERVICE_ENDPOINT,
      "https://extractor.paperpilot.test/readyz?verbose=true",
    ]) {
      assert.throws(() => documentExtractionServiceConfigurationFromEnvironment({
        ...BASE_ENVIRONMENT,
        PAPERPILOT_EXTRACTION_SERVICE_READINESS_ENDPOINT: readinessEndpoint,
      }));
    }
  });

  it("allows HTTP only on exact loopback hosts outside production", () => {
    for (const endpoint of [
      "http://localhost:4020/v1/extract-pdf",
      "http://127.0.0.1:4020/v1/extract-pdf",
      "http://[::1]:4020/v1/extract-pdf",
    ]) {
      assert.equal(
        documentExtractionServiceConfigurationFromEnvironment({
          ...BASE_ENVIRONMENT,
          NODE_ENV: "test",
          PAPERPILOT_EXTRACTION_SERVICE_ENDPOINT: endpoint,
        }).endpoint,
        endpoint,
      );
    }
    for (const endpoint of [
      "http://extractor.test/v1/extract-pdf",
      "http://127.0.0.2/v1/extract-pdf",
    ]) {
      assert.throws(() => documentExtractionServiceConfigurationFromEnvironment({
        ...BASE_ENVIRONMENT,
        NODE_ENV: "test",
        PAPERPILOT_EXTRACTION_SERVICE_ENDPOINT: endpoint,
      }));
    }
  });

  it("rejects weak credentials, ambiguous policy, and expanded compiled bounds", () => {
    for (const environment of [
      { ...BASE_ENVIRONMENT, PAPERPILOT_EXTRACTION_SERVICE_BEARER_SECRET: "x".repeat(31) },
      {
        ...BASE_ENVIRONMENT,
        PAPERPILOT_EXTRACTION_SERVICE_BEARER_SECRET:
          "replace-me-with-an-extraction-service-secret",
      },
      { ...BASE_ENVIRONMENT, PAPERPILOT_EXTRACTION_POLICY_VERSION: "bad policy" },
      { ...BASE_ENVIRONMENT, PAPERPILOT_EXTRACTION_EXPECTED_TOOLCHAIN_DIGEST: "" },
      { ...BASE_ENVIRONMENT, PAPERPILOT_EXTRACTION_EXPECTED_TOOLCHAIN_DIGEST: "0".repeat(64) },
      { ...BASE_ENVIRONMENT, PAPERPILOT_EXTRACTION_EXPECTED_TOOLCHAIN_DIGEST: "B".repeat(64) },
      { ...BASE_ENVIRONMENT, PAPERPILOT_EXTRACTION_TIMEOUT_SECONDS: "0" },
      { ...BASE_ENVIRONMENT, PAPERPILOT_EXTRACTION_TIMEOUT_SECONDS: "181" },
      { ...BASE_ENVIRONMENT, PAPERPILOT_EXTRACTION_TIMEOUT_SECONDS: "075" },
      { ...BASE_ENVIRONMENT, PAPERPILOT_EXTRACTION_MAX_RESPONSE_BYTES: "1023" },
      { ...BASE_ENVIRONMENT, PAPERPILOT_EXTRACTION_MAX_RESPONSE_BYTES: "8388609" },
      {
        ...BASE_ENVIRONMENT,
        PAPERPILOT_EXTRACTION_RESULT_MAX_AGE_SECONDS: "300",
        PAPERPILOT_EXTRACTION_FUTURE_CLOCK_SKEW_SECONDS: "300",
      },
      { ...BASE_ENVIRONMENT, PAPERPILOT_EXTRACTION_RESULT_MAX_AGE_SECONDS: "3601" },
      { ...BASE_ENVIRONMENT, PAPERPILOT_EXTRACTION_FUTURE_CLOCK_SKEW_SECONDS: "901" },
    ]) {
      assert.throws(() => documentExtractionServiceConfigurationFromEnvironment(environment));
    }
  });

  it("accepts bounded lower deployment values", () => {
    const configured = documentExtractionServiceConfigurationFromEnvironment({
      ...BASE_ENVIRONMENT,
      PAPERPILOT_EXTRACTION_TIMEOUT_SECONDS: "60",
      PAPERPILOT_EXTRACTION_MAX_RESPONSE_BYTES: "1048576",
      PAPERPILOT_EXTRACTION_RESULT_MAX_AGE_SECONDS: "1200",
      PAPERPILOT_EXTRACTION_FUTURE_CLOCK_SKEW_SECONDS: "60",
    });
    assert.equal(configured.timeoutMs, 60_000);
    assert.equal(configured.maxResponseBytes, 1_048_576);
    assert.equal(configured.resultMaxAgeMs, 1_200_000);
    assert.equal(configured.futureClockSkewMs, 60_000);
  });
});
