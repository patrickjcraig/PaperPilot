import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_DOCUMENT_VALIDATION_FUTURE_CLOCK_SKEW_MS,
  DEFAULT_DOCUMENT_VALIDATION_MAX_RESPONSE_BYTES,
  DEFAULT_DOCUMENT_VALIDATION_SIGNATURE_MAX_AGE_MS,
  DEFAULT_DOCUMENT_VALIDATION_TIMEOUT_MS,
  documentValidationServiceConfigurationFromEnvironment,
} from "./validation-config";

const BASE_ENVIRONMENT = {
  NODE_ENV: "production",
  PAPERPILOT_VALIDATION_SERVICE_ENDPOINT:
    "https://validator.paperpilot.test/v1/document-validation",
  PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET:
    "validation-service-secret-with-more-than-32-characters",
  PAPERPILOT_VALIDATION_POLICY_VERSION: "paperpilot-document-validation-v1",
} as const;

describe("document validation service configuration", () => {
  it("requires one credential-free production HTTPS endpoint and strong secret", () => {
    const configuration = documentValidationServiceConfigurationFromEnvironment(
      BASE_ENVIRONMENT,
    );
    assert.deepEqual(configuration, {
      endpoint: "https://validator.paperpilot.test/v1/document-validation",
      readinessEndpoint: "https://validator.paperpilot.test/readyz",
      bearerSecret: BASE_ENVIRONMENT.PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET,
      policyVersion: "paperpilot-document-validation-v1",
      timeoutMs: DEFAULT_DOCUMENT_VALIDATION_TIMEOUT_MS,
      maxResponseBytes: DEFAULT_DOCUMENT_VALIDATION_MAX_RESPONSE_BYTES,
      signatureMaxAgeMs: DEFAULT_DOCUMENT_VALIDATION_SIGNATURE_MAX_AGE_MS,
      futureClockSkewMs: DEFAULT_DOCUMENT_VALIDATION_FUTURE_CLOCK_SKEW_MS,
    });

    for (const endpoint of [
      "http://validator.paperpilot.test/v1/document-validation",
      "https://user@validator.paperpilot.test/v1/document-validation",
      "https://validator.paperpilot.test/v1/document-validation?",
      "https://validator.paperpilot.test/v1/document-validation?mode=fast",
      "https://validator.paperpilot.test/v1/document-validation#fragment",
      " https://validator.paperpilot.test/v1/document-validation",
      "relative/validation",
    ]) {
      assert.throws(() =>
        documentValidationServiceConfigurationFromEnvironment({
          ...BASE_ENVIRONMENT,
          PAPERPILOT_VALIDATION_SERVICE_ENDPOINT: endpoint,
        }), endpoint);
    }

    assert.equal(
      documentValidationServiceConfigurationFromEnvironment({
        ...BASE_ENVIRONMENT,
        PAPERPILOT_VALIDATION_SERVICE_READINESS_ENDPOINT:
          "https://validator.paperpilot.test/internal/readyz",
      }).readinessEndpoint,
      "https://validator.paperpilot.test/internal/readyz",
    );
    for (const readinessEndpoint of [
      "https://other.paperpilot.test/readyz",
      BASE_ENVIRONMENT.PAPERPILOT_VALIDATION_SERVICE_ENDPOINT,
      "https://validator.paperpilot.test/readyz?verbose=true",
      "https://user@validator.paperpilot.test/readyz",
    ]) {
      assert.throws(() =>
        documentValidationServiceConfigurationFromEnvironment({
          ...BASE_ENVIRONMENT,
          PAPERPILOT_VALIDATION_SERVICE_READINESS_ENDPOINT: readinessEndpoint,
        }), readinessEndpoint);
    }
  });

  it("allows HTTP only on exact loopback hosts outside production", () => {
    for (const endpoint of [
      "http://localhost:3310/validate",
      "http://127.0.0.1:3310/validate",
      "http://[::1]:3310/validate",
    ]) {
      assert.equal(
        documentValidationServiceConfigurationFromEnvironment({
          ...BASE_ENVIRONMENT,
          NODE_ENV: "test",
          PAPERPILOT_VALIDATION_SERVICE_ENDPOINT: endpoint,
        }).endpoint,
        endpoint,
      );
    }

    for (const environment of [
      {
        ...BASE_ENVIRONMENT,
        NODE_ENV: "test",
        PAPERPILOT_VALIDATION_SERVICE_ENDPOINT: "http://validator.test/validate",
      },
      {
        ...BASE_ENVIRONMENT,
        NODE_ENV: "test",
        PAPERPILOT_VALIDATION_SERVICE_ENDPOINT: "http://127.0.0.2/validate",
      },
      {
        ...BASE_ENVIRONMENT,
        PAPERPILOT_VALIDATION_SERVICE_ENDPOINT: "http://127.0.0.1/validate",
      },
    ]) {
      assert.throws(() =>
        documentValidationServiceConfigurationFromEnvironment(environment));
    }
  });

  it("rejects missing, short, placeholder, whitespace, control, and non-ASCII secrets", () => {
    for (const secret of [
      "",
      "x".repeat(31),
      "replace-me-with-a-long-validation-service-secret",
      ` ${"x".repeat(32)}`,
      `${"x".repeat(32)}\r\nInjected: value`,
      "é".repeat(32),
      "x".repeat(4 * 1_024 + 1),
    ]) {
      assert.throws(() =>
        documentValidationServiceConfigurationFromEnvironment({
          ...BASE_ENVIRONMENT,
          PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET: secret,
        }));
    }
    assert.equal(
      documentValidationServiceConfigurationFromEnvironment({
        ...BASE_ENVIRONMENT,
        PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET: "x".repeat(32),
      }).bearerSecret.length,
      32,
    );
  });

  it("bounds the policy, timeout, response, freshness, and clock-skew settings", () => {
    const configured = documentValidationServiceConfigurationFromEnvironment({
      ...BASE_ENVIRONMENT,
      PAPERPILOT_VALIDATION_TIMEOUT_SECONDS: "45",
      PAPERPILOT_VALIDATION_MAX_RESPONSE_BYTES: "8192",
      PAPERPILOT_VALIDATION_SIGNATURE_MAX_AGE_SECONDS: "7200",
      PAPERPILOT_VALIDATION_FUTURE_CLOCK_SKEW_SECONDS: "60",
    });
    assert.equal(configured.timeoutMs, 45_000);
    assert.equal(configured.maxResponseBytes, 8_192);
    assert.equal(configured.signatureMaxAgeMs, 7_200_000);
    assert.equal(configured.futureClockSkewMs, 60_000);

    for (const environment of [
      { ...BASE_ENVIRONMENT, PAPERPILOT_VALIDATION_POLICY_VERSION: "bad policy" },
      { ...BASE_ENVIRONMENT, PAPERPILOT_VALIDATION_POLICY_VERSION: "x".repeat(129) },
      { ...BASE_ENVIRONMENT, PAPERPILOT_VALIDATION_TIMEOUT_SECONDS: "0" },
      { ...BASE_ENVIRONMENT, PAPERPILOT_VALIDATION_TIMEOUT_SECONDS: "121" },
      { ...BASE_ENVIRONMENT, PAPERPILOT_VALIDATION_TIMEOUT_SECONDS: "01" },
      { ...BASE_ENVIRONMENT, PAPERPILOT_VALIDATION_MAX_RESPONSE_BYTES: "1023" },
      { ...BASE_ENVIRONMENT, PAPERPILOT_VALIDATION_MAX_RESPONSE_BYTES: "16385" },
      {
        ...BASE_ENVIRONMENT,
        PAPERPILOT_VALIDATION_SIGNATURE_MAX_AGE_SECONDS: "300",
        PAPERPILOT_VALIDATION_FUTURE_CLOCK_SKEW_SECONDS: "300",
      },
      {
        ...BASE_ENVIRONMENT,
        PAPERPILOT_VALIDATION_SIGNATURE_MAX_AGE_SECONDS: "604801",
      },
      {
        ...BASE_ENVIRONMENT,
        PAPERPILOT_VALIDATION_FUTURE_CLOCK_SKEW_SECONDS: "3601",
      },
    ]) {
      assert.throws(() =>
        documentValidationServiceConfigurationFromEnvironment(environment));
    }

    assert.equal(
      documentValidationServiceConfigurationFromEnvironment({
        ...BASE_ENVIRONMENT,
        PAPERPILOT_VALIDATION_MAX_RESPONSE_BYTES: "1024",
      }).maxResponseBytes,
      1_024,
    );
  });
});
