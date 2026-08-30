import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DocumentValidationServiceError,
  probeExternalDocumentValidationReadiness,
  requestExternalDocumentValidation,
  type DocumentValidationFetch,
  type DocumentValidationReadinessFetch,
  type StreamingDocumentValidationRequestInit,
} from "./validation-client";
import type { DocumentValidationServiceConfiguration } from "./validation-config";
import type { ExternalDocumentValidationResponse } from "./validation-contract";

const ENDPOINT = "https://validator.paperpilot.test/v1/document-validation";
const READINESS_ENDPOINT = "https://validator.paperpilot.test/readyz";
const SECRET = "validation-service-secret-with-more-than-32-characters";
const SHA256 = "a".repeat(64);
const STORAGE_VERSION = "local-quarantine-v2";
const POLICY_VERSION = "paperpilot-document-validation-v1";
const NOW = new Date("2026-08-28T12:00:00.000Z");

const CONFIGURATION: DocumentValidationServiceConfiguration = {
  endpoint: ENDPOINT,
  readinessEndpoint: READINESS_ENDPOINT,
  bearerSecret: SECRET,
  policyVersion: POLICY_VERSION,
  timeoutMs: 30_000,
  maxResponseBytes: 16 * 1_024,
  signatureMaxAgeMs: 24 * 60 * 60 * 1_000,
  futureClockSkewMs: 5 * 60 * 1_000,
};

function validResponse(): ExternalDocumentValidationResponse {
  return {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    storageVersion: STORAGE_VERSION,
    toolchainDigest: "b".repeat(64),
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

function responseAt(
  body: BodyInit | null,
  init: ResponseInit = {},
  url = ENDPOINT,
  redirected = false,
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { configurable: true, value: url });
  Object.defineProperty(response, "redirected", {
    configurable: true,
    value: redirected,
  });
  return response;
}

function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
  url = ENDPOINT,
  redirected = false,
): Response {
  return responseAt(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  }, url, redirected);
}

function requestInput(
  bodyFactory = () => new ReadableStream<Uint8Array>(),
) {
  return {
    expectedSha256: SHA256,
    expectedSizeBytes: 123n,
    expectedStorageVersion: STORAGE_VERSION,
    bodyFactory,
  };
}

async function assertServiceError(
  promise: Promise<unknown>,
  code: DocumentValidationServiceError["code"],
  retryable: boolean,
  forbidden: readonly string[] = [],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DocumentValidationServiceError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    for (const value of forbidden) {
      assert.equal(error.message.includes(value), false);
    }
    return true;
  });
}

describe("external document validation client", () => {
  it("probes readiness with an authenticated, non-cacheable, redirect-safe GET", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    let bodyCancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true;
      },
    });
    const fetcher: DocumentValidationReadinessFetch = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return responseAt(responseBody, { status: 200 }, READINESS_ENDPOINT);
    };

    await probeExternalDocumentValidationReadiness(CONFIGURATION, {
      readinessFetch: fetcher,
    });

    assert.equal(capturedUrl, READINESS_ENDPOINT);
    assert.equal(capturedInit?.method, "GET");
    assert.equal(capturedInit?.redirect, "manual");
    assert.equal(capturedInit?.credentials, "omit");
    assert.equal(capturedInit?.cache, "no-store");
    assert.equal(capturedInit?.referrerPolicy, "no-referrer");
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("authorization"), `Bearer ${SECRET}`);
    assert.equal(headers.get("cache-control"), "no-store");
    assert.equal(bodyCancelled, true);
  });

  it("rejects readiness redirects and final-URL mismatches", async () => {
    await assertServiceError(
      probeExternalDocumentValidationReadiness(CONFIGURATION, {
        readinessFetch: async () => responseAt(
          null,
          { status: 302, headers: { Location: "https://other.test/readyz" } },
          READINESS_ENDPOINT,
        ),
      }),
      "validation_service_redirected",
      false,
    );
    await assertServiceError(
      probeExternalDocumentValidationReadiness(CONFIGURATION, {
        readinessFetch: async () => responseAt(
          null,
          { status: 204 },
          "https://other.test/readyz",
        ),
      }),
      "validation_service_endpoint_mismatch",
      false,
    );
    await assertServiceError(
      probeExternalDocumentValidationReadiness(CONFIGURATION, {
        readinessFetch: async () => responseAt(
          null,
          { status: 204 },
          READINESS_ENDPOINT,
          true,
        ),
      }),
      "validation_service_redirected",
      false,
    );
  });

  it("classifies readiness authentication, outage, and invalid-route responses", async () => {
    await assertServiceError(
      probeExternalDocumentValidationReadiness(CONFIGURATION, {
        readinessFetch: async () => responseAt(
          "private authentication details",
          { status: 401 },
          READINESS_ENDPOINT,
        ),
      }),
      "validation_service_configuration_error",
      false,
      ["private authentication details"],
    );
    await assertServiceError(
      probeExternalDocumentValidationReadiness(CONFIGURATION, {
        readinessFetch: async () => responseAt(
          "private outage details",
          { status: 503 },
          READINESS_ENDPOINT,
        ),
      }),
      "validation_service_unavailable",
      true,
      ["private outage details"],
    );
    await assertServiceError(
      probeExternalDocumentValidationReadiness(CONFIGURATION, {
        readinessFetch: async () => responseAt(
          "private route details",
          { status: 404 },
          READINESS_ENDPOINT,
        ),
      }),
      "validation_service_invalid_response",
      false,
      ["private route details"],
    );
  });

  it("enforces the readiness deadline even when fetch ignores abort", async () => {
    const never: DocumentValidationReadinessFetch = async () =>
      new Promise<Response>(() => undefined);
    await assertServiceError(
      probeExternalDocumentValidationReadiness(
        { ...CONFIGURATION, timeoutMs: 5 },
        { readinessFetch: never },
      ),
      "validation_service_timeout",
      true,
    );
  });

  it("streams the raw PDF once with exact headers, endpoint, and redirect policy", async () => {
    const requestBody = new ReadableStream<Uint8Array>();
    let bodyFactoryCalls = 0;
    let capturedUrl: string | undefined;
    let capturedInit: StreamingDocumentValidationRequestInit | undefined;
    const fetcher: DocumentValidationFetch = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(validResponse());
    };

    const attestation = await requestExternalDocumentValidation(
      requestInput(() => {
        bodyFactoryCalls += 1;
        return requestBody;
      }),
      CONFIGURATION,
      { fetch: fetcher, clock: () => NOW },
    );

    assert.equal(attestation.verdict, "ACCEPTED");
    assert.equal(attestation.inputSizeBytes, 123n);
    assert.equal(bodyFactoryCalls, 1);
    assert.equal(capturedUrl, ENDPOINT);
    assert.equal(capturedInit?.body, requestBody);
    assert.equal(capturedInit?.method, "POST");
    assert.equal(capturedInit?.duplex, "half");
    assert.equal(capturedInit?.redirect, "manual");
    assert.equal(capturedInit?.credentials, "omit");
    assert.equal(capturedInit?.cache, "no-store");
    assert.equal(capturedInit?.referrerPolicy, "no-referrer");
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get("content-type"), "application/pdf");
    assert.equal(headers.get("content-length"), "123");
    assert.equal(headers.get("authorization"), `Bearer ${SECRET}`);
    assert.equal(headers.get("x-paperpilot-content-sha256"), SHA256);
    assert.equal(headers.get("x-paperpilot-storage-version"), STORAGE_VERSION);
    assert.equal(headers.get("x-paperpilot-validation-policy"), POLICY_VERSION);
  });

  it("rejects redirects and any final URL other than the configured endpoint", async () => {
    await assertServiceError(
      requestExternalDocumentValidation(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt(null, {
          status: 302,
          headers: { Location: "https://other.test/validate" },
        }),
        clock: () => NOW,
      }),
      "validation_service_redirected",
      false,
    );
    await assertServiceError(
      requestExternalDocumentValidation(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse(
          validResponse(),
          {},
          "https://other.test/validate",
        ),
        clock: () => NOW,
      }),
      "validation_service_endpoint_mismatch",
      false,
    );
    await assertServiceError(
      requestExternalDocumentValidation(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse(validResponse(), {}, ENDPOINT, true),
        clock: () => NOW,
      }),
      "validation_service_redirected",
      false,
    );
  });

  it("bounds the response by declared and streamed bytes before JSON parsing", async () => {
    await assertServiceError(
      requestExternalDocumentValidation(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "16385",
          },
        }),
        clock: () => NOW,
      }),
      "validation_service_response_too_large",
      false,
    );

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1_024 + 1));
        controller.close();
      },
    });
    await assertServiceError(
      requestExternalDocumentValidation(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt(oversized, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        clock: () => NOW,
      }),
      "validation_service_response_too_large",
      false,
    );
  });

  it("enforces an abort deadline even when the injected fetch never resolves", async () => {
    const never: DocumentValidationFetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new Error(`provider failure ${SECRET} C:\\private\\input.pdf`));
        }, { once: true });
      });
    await assertServiceError(
      requestExternalDocumentValidation(
        requestInput(),
        { ...CONFIGURATION, timeoutMs: 5 },
        { fetch: never, clock: () => NOW },
      ),
      "validation_service_timeout",
      true,
      [SECRET, "C:\\private\\input.pdf"],
    );
  });

  it("honors caller abort without converting it to a timeout", async () => {
    const controller = new AbortController();
    const never: DocumentValidationFetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    const pending = requestExternalDocumentValidation(
      { ...requestInput(), signal: controller.signal },
      CONFIGURATION,
      { fetch: never, clock: () => NOW },
    );
    controller.abort("do not expose this reason");
    await assertServiceError(
      pending,
      "validation_request_aborted",
      true,
      ["do not expose this reason"],
    );

    let bodyFactoryCalls = 0;
    const alreadyAborted = new AbortController();
    alreadyAborted.abort("private abort reason");
    await assertServiceError(
      requestExternalDocumentValidation(
        {
          ...requestInput(() => {
            bodyFactoryCalls += 1;
            return new ReadableStream<Uint8Array>();
          }),
          signal: alreadyAborted.signal,
        },
        CONFIGURATION,
      ),
      "validation_request_aborted",
      true,
      ["private abort reason"],
    );
    assert.equal(bodyFactoryCalls, 0);
  });

  it("returns fixed safe errors for stream, transport, status, and provider-body failures", async () => {
    const privatePath = "C:\\private\\tenant\\original.quarantine";
    await assertServiceError(
      requestExternalDocumentValidation(
        requestInput(() => {
          throw new Error(`${privatePath} ${SECRET}`);
        }),
        CONFIGURATION,
        { fetch: async () => jsonResponse(validResponse()), clock: () => NOW },
      ),
      "validation_stream_unavailable",
      true,
      [privatePath, SECRET],
    );
    await assertServiceError(
      requestExternalDocumentValidation(requestInput(), CONFIGURATION, {
        fetch: async () => {
          throw new Error(`${privatePath} ${SECRET}`);
        },
        clock: () => NOW,
      }),
      "validation_service_unavailable",
      true,
      [privatePath, SECRET],
    );
    await assertServiceError(
      requestExternalDocumentValidation(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt(`${privatePath} ${SECRET}`, {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
        clock: () => NOW,
      }),
      "validation_service_unavailable",
      true,
      [privatePath, SECRET],
    );
    await assertServiceError(
      requestExternalDocumentValidation(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt(
          JSON.stringify({ raw: `${privatePath} ${SECRET}` }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
        clock: () => NOW,
      }),
      "validation_service_invalid_response",
      false,
      [privatePath, SECRET],
    );
  });

  it("classifies authentication, overload, media, binding, freshness, and clock errors", async () => {
    await assertServiceError(
      requestExternalDocumentValidation(
        requestInput(),
        { ...CONFIGURATION, endpoint: "http://validator.paperpilot.test/validate" },
      ),
      "validation_service_configuration_error",
      false,
    );
    await assertServiceError(
      requestExternalDocumentValidation(
        requestInput(),
        { ...CONFIGURATION, maxResponseBytes: 1_023 },
      ),
      "validation_service_configuration_error",
      false,
    );
    await assertServiceError(
      requestExternalDocumentValidation(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt(null, { status: 401 }),
        clock: () => NOW,
      }),
      "validation_service_configuration_error",
      false,
    );
    await assertServiceError(
      requestExternalDocumentValidation(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt(null, { status: 429 }),
        clock: () => NOW,
      }),
      "validation_service_unavailable",
      true,
    );
    await assertServiceError(
      requestExternalDocumentValidation(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt("{}", {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
        clock: () => NOW,
      }),
      "validation_service_invalid_response",
      false,
    );

    const wrongContent = validResponse();
    wrongContent.input.sha256 = "c".repeat(64);
    await assertServiceError(
      requestExternalDocumentValidation(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse(wrongContent),
        clock: () => NOW,
      }),
      "validation_service_content_mismatch",
      false,
    );

    const stale = validResponse();
    stale.malware.signaturePublishedAt = "2026-08-27T11:59:59.999Z";
    await assertServiceError(
      requestExternalDocumentValidation(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse(stale),
        clock: () => NOW,
      }),
      "validation_service_signatures_stale",
      true,
    );

    const future = validResponse();
    future.malware.signaturePublishedAt = "2026-08-28T12:05:00.001Z";
    future.malware.scannedAt = "2026-08-28T12:05:00.001Z";
    future.pdf.checkedAt = "2026-08-28T12:05:00.001Z";
    future.completedAt = "2026-08-28T12:05:00.001Z";
    await assertServiceError(
      requestExternalDocumentValidation(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse(future),
        clock: () => NOW,
      }),
      "validation_service_clock_invalid",
      true,
    );
  });
});
