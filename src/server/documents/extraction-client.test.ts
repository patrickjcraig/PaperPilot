import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DocumentExtractionServiceError,
  probeExternalDocumentExtractionReadiness,
  requestExternalDocumentExtraction,
  type DocumentExtractionFetch,
  type DocumentExtractionReadinessFetch,
  type StreamingDocumentExtractionRequestInit,
} from "./extraction-client";
import type { DocumentExtractionServiceConfiguration } from "./extraction-config";
import type { ExternalDocumentExtractionResponse } from "./extraction-contract";

const ENDPOINT = "https://extractor.paperpilot.test/v1/extract-pdf";
const READINESS_ENDPOINT = "https://extractor.paperpilot.test/readyz";
const SECRET = "extraction-service-secret-with-more-than-32-characters";
const PRIVATE_PATH = "C:\\private\\tenant\\original.quarantine";
const SHA256 = "a".repeat(64);
const STORAGE_VERSION = "local-quarantine-v2";
const POLICY_VERSION = "paperpilot-text-extraction-v1";
const TOOLCHAIN_DIGEST = "b".repeat(64);
const ENGINE_VERSION = "25.06.0";
const NOW = new Date("2026-08-28T16:00:10.000Z");

const CONFIGURATION: DocumentExtractionServiceConfiguration = {
  endpoint: ENDPOINT,
  readinessEndpoint: READINESS_ENDPOINT,
  bearerSecret: SECRET,
  policyVersion: POLICY_VERSION,
  expectedToolchainDigest: TOOLCHAIN_DIGEST,
  timeoutMs: 30_000,
  maxResponseBytes: 4 * 1_024,
  resultMaxAgeMs: 15 * 60_000,
  futureClockSkewMs: 5 * 60_000,
};

function validResponse(): ExternalDocumentExtractionResponse {
  const texts = ["First paragraph", "Second paragraph", "Third paragraph"];
  return {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    storageVersion: STORAGE_VERSION,
    toolchainDigest: TOOLCHAIN_DIGEST,
    verdict: "extracted",
    input: { sha256: SHA256, sizeBytes: "123" },
    extraction: {
      engine: "poppler",
      engineVersion: ENGINE_VERSION,
      pageCount: 2,
      chunkCount: 3,
      textBytes: texts.reduce((total, text) => total + Buffer.byteLength(text), 0),
      extractedAt: "2026-08-28T16:00:01.000Z",
      durationMs: 900,
    },
    chunks: [
      { sequence: 0, pageNumber: 1, paragraphId: "p1-p1", text: texts[0] },
      { sequence: 1, pageNumber: 1, paragraphId: "p1-p2", text: texts[1] },
      { sequence: 2, pageNumber: 2, paragraphId: "p2-p1", text: texts[2] },
    ],
    completedAt: "2026-08-28T16:00:02.000Z",
    totalDurationMs: 1_000,
  };
}

function validReadiness() {
  return {
    schemaVersion: 1,
    status: "ready",
    policyVersion: POLICY_VERSION,
    toolchainDigest: TOOLCHAIN_DIGEST,
    engine: "poppler",
    engineVersion: ENGINE_VERSION,
  } as const;
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
  bodyFactory: (signal: AbortSignal) => ReadableStream<Uint8Array> = () =>
    new ReadableStream<Uint8Array>(),
) {
  return {
    expectedSha256: SHA256,
    expectedSizeBytes: 123n,
    expectedStorageVersion: STORAGE_VERSION,
    expectedEngineVersion: ENGINE_VERSION,
    bodyFactory,
  };
}

async function assertServiceError(
  promise: Promise<unknown>,
  code: DocumentExtractionServiceError["code"],
  retryable: boolean,
  forbidden: readonly string[] = [],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DocumentExtractionServiceError);
    assert.equal(error.name, "DocumentExtractionServiceError");
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    const publicError = String(error);
    for (const value of forbidden) {
      assert.equal(publicError.includes(value), false);
    }
    return true;
  });
}

describe("external document extraction client", () => {
  it("probes readiness with an authenticated, non-cacheable, redirect-safe GET", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetcher: DocumentExtractionReadinessFetch = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(validReadiness(), {}, READINESS_ENDPOINT);
    };

    const identity = await probeExternalDocumentExtractionReadiness(CONFIGURATION, {
      readinessFetch: fetcher,
    });

    assert.equal(capturedUrl, READINESS_ENDPOINT);
    assert.equal(capturedInit?.method, "GET");
    assert.equal(capturedInit?.redirect, "manual");
    assert.equal(capturedInit?.credentials, "omit");
    assert.equal(capturedInit?.cache, "no-store");
    assert.equal(capturedInit?.referrerPolicy, "no-referrer");
    assert.ok(capturedInit?.signal instanceof AbortSignal);
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("authorization"), `Bearer ${SECRET}`);
    assert.equal(headers.get("cache-control"), "no-store");
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("referer"), null);
    assert.deepEqual(identity, validReadiness());
  });

  it("accepts only the exact readiness endpoint and rejects every redirect signal", async () => {
    await assertServiceError(
      probeExternalDocumentExtractionReadiness(CONFIGURATION, {
        readinessFetch: async () => responseAt(
          null,
          { status: 302, headers: { Location: "https://other.test/readyz" } },
          READINESS_ENDPOINT,
        ),
      }),
      "extraction_service_redirected",
      false,
    );
    await assertServiceError(
      probeExternalDocumentExtractionReadiness(CONFIGURATION, {
        readinessFetch: async () => responseAt(
          null,
          { status: 204 },
          `${READINESS_ENDPOINT}/`,
        ),
      }),
      "extraction_service_endpoint_mismatch",
      false,
    );
    await assertServiceError(
      probeExternalDocumentExtractionReadiness(CONFIGURATION, {
        readinessFetch: async () => responseAt(
          null,
          { status: 204 },
          READINESS_ENDPOINT,
          true,
        ),
      }),
      "extraction_service_redirected",
      false,
    );
  });

  it("classifies readiness statuses without exposing private response bodies", async () => {
    for (const status of [401, 403]) {
      await assertServiceError(
        probeExternalDocumentExtractionReadiness(CONFIGURATION, {
          readinessFetch: async () => responseAt(
            `${PRIVATE_PATH} ${SECRET}`,
            { status },
            READINESS_ENDPOINT,
          ),
        }),
        "extraction_service_configuration_error",
        false,
        [PRIVATE_PATH, SECRET],
      );
    }
    for (const status of [408, 425, 429, 500, 503]) {
      await assertServiceError(
        probeExternalDocumentExtractionReadiness(CONFIGURATION, {
          readinessFetch: async () => responseAt(
            `${PRIVATE_PATH} ${SECRET}`,
            { status },
            READINESS_ENDPOINT,
          ),
        }),
        "extraction_service_unavailable",
        true,
        [PRIVATE_PATH, SECRET],
      );
    }
    await assertServiceError(
      probeExternalDocumentExtractionReadiness(CONFIGURATION, {
        readinessFetch: async () => responseAt(
          `${PRIVATE_PATH} ${SECRET}`,
          { status: 404 },
          READINESS_ENDPOINT,
        ),
      }),
      "extraction_service_invalid_response",
      false,
      [PRIVATE_PATH, SECRET],
    );
    await assertServiceError(
      probeExternalDocumentExtractionReadiness(CONFIGURATION, {
        readinessFetch: async () => responseAt(null, { status: 204 }, READINESS_ENDPOINT),
      }),
      "extraction_service_invalid_response",
      false,
    );
    await probeExternalDocumentExtractionReadiness(CONFIGURATION, {
      readinessFetch: async () => jsonResponse(validReadiness(), {}, READINESS_ENDPOINT),
    });
  });

  it("requires a closed readiness identity pinned to policy and toolchain", async () => {
    for (const mutate of [
      (value: Record<string, unknown>) => { value.extra = PRIVATE_PATH; },
      (value: Record<string, unknown>) => { value.schemaVersion = 2; },
      (value: Record<string, unknown>) => { value.status = "live"; },
      (value: Record<string, unknown>) => { value.engine = "other"; },
      (value: Record<string, unknown>) => { value.engineVersion = "bad version"; },
    ]) {
      const readiness: Record<string, unknown> = { ...validReadiness() };
      mutate(readiness);
      await assertServiceError(
        probeExternalDocumentExtractionReadiness(CONFIGURATION, {
          readinessFetch: async () => jsonResponse(readiness, {}, READINESS_ENDPOINT),
        }),
        "extraction_service_invalid_response",
        false,
        [PRIVATE_PATH],
      );
    }

    await assertServiceError(
      probeExternalDocumentExtractionReadiness(CONFIGURATION, {
        readinessFetch: async () => jsonResponse(
          { ...validReadiness(), policyVersion: "other-policy-v1" },
          {},
          READINESS_ENDPOINT,
        ),
      }),
      "extraction_service_policy_mismatch",
      false,
    );
    await assertServiceError(
      probeExternalDocumentExtractionReadiness(CONFIGURATION, {
        readinessFetch: async () => jsonResponse(
          { ...validReadiness(), toolchainDigest: "c".repeat(64) },
          {},
          READINESS_ENDPOINT,
        ),
      }),
      "extraction_service_toolchain_mismatch",
      false,
    );
    await assertServiceError(
      probeExternalDocumentExtractionReadiness(CONFIGURATION, {
        readinessFetch: async () => responseAt("x".repeat(1_025), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }, READINESS_ENDPOINT),
      }),
      "extraction_service_invalid_response",
      false,
    );
  });

  it("enforces readiness timeout and caller abort even when fetch ignores abort", async () => {
    const never: DocumentExtractionReadinessFetch = async () =>
      new Promise<Response>(() => undefined);
    await assertServiceError(
      probeExternalDocumentExtractionReadiness(
        { ...CONFIGURATION, timeoutMs: 5 },
        { readinessFetch: never },
      ),
      "extraction_service_timeout",
      true,
    );

    const controller = new AbortController();
    const pending = probeExternalDocumentExtractionReadiness(
      CONFIGURATION,
      { readinessFetch: never },
      controller.signal,
    );
    controller.abort(`${PRIVATE_PATH} ${SECRET}`);
    await assertServiceError(
      pending,
      "extraction_request_aborted",
      true,
      [PRIVATE_PATH, SECRET],
    );
  });

  it("streams the raw PDF once with exact headers, endpoint, and transport policy", async () => {
    const requestBody = new ReadableStream<Uint8Array>();
    let bodyFactoryCalls = 0;
    let factorySignal: AbortSignal | undefined;
    let capturedUrl: string | undefined;
    let capturedInit: StreamingDocumentExtractionRequestInit | undefined;
    const fetcher: DocumentExtractionFetch = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(validResponse());
    };

    const attestation = await requestExternalDocumentExtraction(
      requestInput((signal) => {
        bodyFactoryCalls += 1;
        factorySignal = signal;
        return requestBody;
      }),
      CONFIGURATION,
      { fetch: fetcher, clock: () => NOW },
    );

    assert.equal(attestation.verdict, "EXTRACTED");
    assert.equal(attestation.inputSizeBytes, 123n);
    assert.equal(attestation.chunkCount, 3);
    assert.equal(attestation.chunks[2]?.paragraphId, "p2-p1");
    assert.equal(bodyFactoryCalls, 1);
    assert.equal(capturedUrl, ENDPOINT);
    assert.equal(capturedInit?.body, requestBody);
    assert.equal(capturedInit?.method, "POST");
    assert.equal(capturedInit?.duplex, "half");
    assert.equal(capturedInit?.redirect, "manual");
    assert.equal(capturedInit?.credentials, "omit");
    assert.equal(capturedInit?.cache, "no-store");
    assert.equal(capturedInit?.referrerPolicy, "no-referrer");
    assert.equal(factorySignal, capturedInit?.signal);
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("authorization"), `Bearer ${SECRET}`);
    assert.equal(headers.get("cache-control"), "no-store");
    assert.equal(headers.get("content-type"), "application/pdf");
    assert.equal(headers.get("content-length"), "123");
    assert.equal(headers.get("x-paperpilot-content-sha256"), SHA256);
    assert.equal(headers.get("x-paperpilot-storage-version"), STORAGE_VERSION);
    assert.equal(headers.get("x-paperpilot-extraction-policy"), POLICY_VERSION);
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("referer"), null);
  });

  it("rejects a POST result whose engine version differs from the authenticated readiness identity", async () => {
    const postResult = validResponse();
    postResult.extraction.engineVersion = "26.01.0";
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse(postResult),
        clock: () => NOW,
      }),
      "extraction_service_engine_mismatch",
      true,
    );
  });

  it("rejects extraction redirects and any final URL other than the configured endpoint", async () => {
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt(null, {
          status: 302,
          headers: { Location: "https://other.test/extract" },
        }),
        clock: () => NOW,
      }),
      "extraction_service_redirected",
      false,
    );
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse(validResponse(), {}, `${ENDPOINT}/`),
        clock: () => NOW,
      }),
      "extraction_service_endpoint_mismatch",
      false,
    );
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse(validResponse(), {}, ENDPOINT, true),
        clock: () => NOW,
      }),
      "extraction_service_redirected",
      false,
    );
  });

  it("requires status 200 and the exact literal application/json media type", async () => {
    for (const status of [201, 204, 206]) {
      await assertServiceError(
        requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
          fetch: async () => responseAt(
            status === 204 ? null : JSON.stringify(validResponse()),
            { status, headers: { "Content-Type": "application/json" } },
          ),
          clock: () => NOW,
        }),
        "extraction_service_invalid_response",
        false,
      );
    }
    for (const contentType of [
      "application/json; charset=utf-8",
      "Application/JSON",
      "text/json",
      "application/problem+json",
    ]) {
      await assertServiceError(
        requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
          fetch: async () => responseAt(JSON.stringify(validResponse()), {
            status: 200,
            headers: { "Content-Type": contentType },
          }),
          clock: () => NOW,
        }),
        "extraction_service_invalid_response",
        false,
      );
    }
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt(JSON.stringify(validResponse()), { status: 200 }),
        clock: () => NOW,
      }),
      "extraction_service_invalid_response",
      false,
    );
  });

  it("bounds canonical Content-Length and streamed bytes before parsing JSON", async () => {
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(CONFIGURATION.maxResponseBytes + 1),
          },
        }),
        clock: () => NOW,
      }),
      "extraction_service_response_too_large",
      false,
    );
    for (const contentLength of ["00", "+2", "-1", "1.5", "99999999999999999"] ) {
      await assertServiceError(
        requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
          fetch: async () => responseAt("{}", {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": contentLength,
            },
          }),
          clock: () => NOW,
        }),
        "extraction_service_invalid_response",
        false,
      );
    }
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "3",
          },
        }),
        clock: () => NOW,
      }),
      "extraction_service_invalid_response",
      false,
    );

    let oversizedBodyCancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(CONFIGURATION.maxResponseBytes + 1));
      },
      cancel() {
        oversizedBodyCancelled = true;
      },
    });
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt(oversized, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        clock: () => NOW,
      }),
      "extraction_service_response_too_large",
      false,
    );
    assert.equal(oversizedBodyCancelled, true);

    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt(null, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        clock: () => NOW,
      }),
      "extraction_service_invalid_response",
      false,
    );
  });

  it("rejects invalid UTF-8, malformed JSON, and closed-contract violations", async () => {
    const invalidUtf8 = new Uint8Array([0xc3, 0x28]);
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt(invalidUtf8, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        clock: () => NOW,
      }),
      "extraction_service_invalid_response",
      false,
    );
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt("{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        clock: () => NOW,
      }),
      "extraction_service_invalid_response",
      false,
    );
    const expanded = validResponse() as ExternalDocumentExtractionResponse & {
      privateDebug?: string;
    };
    expanded.privateDebug = `${PRIVATE_PATH} ${SECRET}`;
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse(expanded),
        clock: () => NOW,
      }),
      "extraction_service_invalid_response",
      false,
      [PRIVATE_PATH, SECRET],
    );
  });

  it("maps locked-contract binding, policy, freshness, and clock failures", async () => {
    for (const mutate of [
      (body: ExternalDocumentExtractionResponse) => { body.input.sha256 = "c".repeat(64); },
      (body: ExternalDocumentExtractionResponse) => { body.input.sizeBytes = "124"; },
      (body: ExternalDocumentExtractionResponse) => {
        body.storageVersion = "other-storage-v1";
      },
    ]) {
      const body = validResponse();
      mutate(body);
      await assertServiceError(
        requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
          fetch: async () => jsonResponse(body),
          clock: () => NOW,
        }),
        "extraction_service_input_mismatch",
        false,
      );
    }

    const wrongPolicy = validResponse();
    wrongPolicy.policyVersion = "other-policy-v1";
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse(wrongPolicy),
        clock: () => NOW,
      }),
      "extraction_service_policy_mismatch",
      false,
    );

    const wrongToolchain = validResponse();
    wrongToolchain.toolchainDigest = "c".repeat(64);
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse(wrongToolchain),
        clock: () => NOW,
      }),
      "extraction_service_toolchain_mismatch",
      false,
    );

    const stale = validResponse();
    stale.extraction.extractedAt = "2026-08-28T15:39:59.000Z";
    stale.completedAt = "2026-08-28T15:40:00.000Z";
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse(stale),
        clock: () => NOW,
      }),
      "extraction_service_result_stale",
      true,
    );

    const future = validResponse();
    future.extraction.extractedAt = "2026-08-28T16:06:00.000Z";
    future.completedAt = "2026-08-28T16:06:01.000Z";
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse(future),
        clock: () => NOW,
      }),
      "extraction_service_clock_invalid",
      true,
    );
  });

  it("classifies configuration, transport, authentication, overload, and route failures", async () => {
    await assertServiceError(
      requestExternalDocumentExtraction(
        requestInput(),
        { ...CONFIGURATION, endpoint: "http://extractor.paperpilot.test/extract" },
      ),
      "extraction_service_configuration_error",
      false,
    );
    await assertServiceError(
      requestExternalDocumentExtraction(
        requestInput(),
        { ...CONFIGURATION, maxResponseBytes: 1_023 },
      ),
      "extraction_service_configuration_error",
      false,
    );
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => {
          throw new Error(`${PRIVATE_PATH} ${SECRET}`);
        },
        clock: () => NOW,
      }),
      "extraction_service_unavailable",
      true,
      [PRIVATE_PATH, SECRET],
    );
    for (const status of [401, 403]) {
      await assertServiceError(
        requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
          fetch: async () => responseAt(`${PRIVATE_PATH} ${SECRET}`, { status }),
          clock: () => NOW,
        }),
        "extraction_service_configuration_error",
        false,
        [PRIVATE_PATH, SECRET],
      );
    }
    for (const status of [408, 425, 429, 500, 503]) {
      await assertServiceError(
        requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
          fetch: async () => responseAt(`${PRIVATE_PATH} ${SECRET}`, { status }),
          clock: () => NOW,
        }),
        "extraction_service_unavailable",
        true,
        [PRIVATE_PATH, SECRET],
      );
    }
    for (const status of [400, 404, 409, 415, 422]) {
      await assertServiceError(
        requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
          fetch: async () => responseAt(`${PRIVATE_PATH} ${SECRET}`, { status }),
          clock: () => NOW,
        }),
        "extraction_service_invalid_response",
        false,
        [PRIVATE_PATH, SECRET],
      );
    }
  });

  it("distinguishes only exact pre-admission and deterministic service failures", async () => {
    const cases = [
      {
        status: 503,
        serviceCode: "extractor_busy",
        message: "The document extractor is temporarily busy.",
        clientCode: "extraction_service_busy" as const,
        retryable: true,
      },
      {
        status: 422,
        serviceCode: "extraction_input_unsupported",
        message: "The document input is not supported for text extraction.",
        clientCode: "extraction_input_unsupported" as const,
        retryable: false,
      },
      {
        status: 422,
        serviceCode: "extraction_resource_limit",
        message: "The document exceeded a supported extraction resource limit.",
        clientCode: "extraction_resource_limit" as const,
        retryable: false,
      },
      {
        status: 409,
        serviceCode: "policy_mismatch",
        message: "The requested extraction policy is not available.",
        clientCode: "extraction_service_policy_mismatch" as const,
        retryable: false,
      },
    ];
    for (const entry of cases) {
      await assertServiceError(
        requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
          fetch: async () => jsonResponse({
            error: { code: entry.serviceCode, message: entry.message },
          }, { status: entry.status }),
          clock: () => NOW,
        }),
        entry.clientCode,
        entry.retryable,
      );
    }

    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse({
          error: {
            code: "extractor_busy",
            message: "Changed message",
          },
        }, { status: 503 }),
        clock: () => NOW,
      }),
      "extraction_service_unavailable",
      true,
    );
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse({
          error: {
            code: "extractor_busy",
            message: "The document extractor is temporarily busy.",
            detail: PRIVATE_PATH,
          },
        }, { status: 503 }),
        clock: () => NOW,
      }),
      "extraction_service_unavailable",
      true,
      [PRIVATE_PATH],
    );
  });

  it("enforces the deadline when fetch or response reading ignores abort", async () => {
    const neverFetch: DocumentExtractionFetch = async () =>
      new Promise<Response>(() => undefined);
    await assertServiceError(
      requestExternalDocumentExtraction(
        requestInput(),
        { ...CONFIGURATION, timeoutMs: 5 },
        { fetch: neverFetch, clock: () => NOW },
      ),
      "extraction_service_timeout",
      true,
    );

    let readStarted = false;
    const neverRead = new ReadableStream<Uint8Array>({
      pull() {
        readStarted = true;
        return new Promise<void>(() => undefined);
      },
    });
    await assertServiceError(
      requestExternalDocumentExtraction(
        requestInput(),
        { ...CONFIGURATION, timeoutMs: 5 },
        {
          fetch: async () => responseAt(neverRead, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
          clock: () => NOW,
        },
      ),
      "extraction_service_timeout",
      true,
    );
    assert.equal(readStarted, true);
  });

  it("honors caller abort before body creation and while fetch ignores abort", async () => {
    const controller = new AbortController();
    const neverFetch: DocumentExtractionFetch = async () =>
      new Promise<Response>(() => undefined);
    const pending = requestExternalDocumentExtraction(
      { ...requestInput(), signal: controller.signal },
      CONFIGURATION,
      { fetch: neverFetch, clock: () => NOW },
    );
    controller.abort(`${PRIVATE_PATH} ${SECRET}`);
    await assertServiceError(
      pending,
      "extraction_request_aborted",
      true,
      [PRIVATE_PATH, SECRET],
    );

    let bodyFactoryCalls = 0;
    let fetchCalls = 0;
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(`${PRIVATE_PATH} ${SECRET}`);
    await assertServiceError(
      requestExternalDocumentExtraction(
        {
          ...requestInput(() => {
            bodyFactoryCalls += 1;
            return new ReadableStream<Uint8Array>();
          }),
          signal: alreadyAborted.signal,
        },
        CONFIGURATION,
        {
          fetch: async () => {
            fetchCalls += 1;
            return jsonResponse(validResponse());
          },
          clock: () => NOW,
        },
      ),
      "extraction_request_aborted",
      true,
      [PRIVATE_PATH, SECRET],
    );
    assert.equal(bodyFactoryCalls, 0);
    assert.equal(fetchCalls, 0);
  });

  it("rejects body factory failures, non-stream bodies, and locked streams safely", async () => {
    let fetchCalls = 0;
    const fetcher: DocumentExtractionFetch = async () => {
      fetchCalls += 1;
      return jsonResponse(validResponse());
    };
    await assertServiceError(
      requestExternalDocumentExtraction(
        requestInput(() => {
          throw new Error(`${PRIVATE_PATH} ${SECRET}`);
        }),
        CONFIGURATION,
        { fetch: fetcher, clock: () => NOW },
      ),
      "extraction_stream_unavailable",
      true,
      [PRIVATE_PATH, SECRET],
    );
    await assertServiceError(
      requestExternalDocumentExtraction(
        requestInput(() => ({ locked: false }) as unknown as ReadableStream<Uint8Array>),
        CONFIGURATION,
        { fetch: fetcher, clock: () => NOW },
      ),
      "extraction_stream_unavailable",
      true,
    );

    const locked = new ReadableStream<Uint8Array>();
    const reader = locked.getReader();
    try {
      await assertServiceError(
        requestExternalDocumentExtraction(
          requestInput(() => locked),
          CONFIGURATION,
          { fetch: fetcher, clock: () => NOW },
        ),
        "extraction_stream_unavailable",
        true,
      );
    } finally {
      reader.releaseLock();
    }
    assert.equal(fetchCalls, 0);
  });

  it("never leaks secrets or private provider details from read and contract failures", async () => {
    const failedRead = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(`${PRIVATE_PATH} ${SECRET}`));
      },
    });
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt(failedRead, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        clock: () => NOW,
      }),
      "extraction_service_unavailable",
      true,
      [PRIVATE_PATH, SECRET],
    );

    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => responseAt(
          JSON.stringify({ rawError: `${PRIVATE_PATH} ${SECRET}` }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
        clock: () => NOW,
      }),
      "extraction_service_invalid_response",
      false,
      [PRIVATE_PATH, SECRET],
    );
  });

  it("rejects malformed request bindings and an invalid injected clock", async () => {
    for (const input of [
      { ...requestInput(), expectedSha256: "A".repeat(64) },
      { ...requestInput(), expectedSha256: "a".repeat(63) },
      { ...requestInput(), expectedSizeBytes: 0n },
      { ...requestInput(), expectedSizeBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
      { ...requestInput(), expectedStorageVersion: "bad storage version" },
      { ...requestInput(), expectedEngineVersion: "bad engine version" },
      { ...requestInput(), bodyFactory: null as never },
      { ...requestInput(), signal: {} as AbortSignal },
    ]) {
      await assertServiceError(
        requestExternalDocumentExtraction(input, CONFIGURATION),
        "extraction_request_invalid",
        false,
      );
    }
    await assertServiceError(
      requestExternalDocumentExtraction(requestInput(), CONFIGURATION, {
        fetch: async () => jsonResponse(validResponse()),
        clock: () => new Date(Number.NaN),
      }),
      "extraction_request_invalid",
      false,
    );
  });
});
