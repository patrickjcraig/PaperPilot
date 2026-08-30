import "server-only";

import {
  MAX_DOCUMENT_EXTRACTION_RESPONSE_BYTES,
  MIN_DOCUMENT_EXTRACTION_RESPONSE_BYTES,
  type DocumentExtractionServiceConfiguration,
} from "./extraction-config";
import {
  DocumentExtractionContractError,
  parseExternalDocumentExtractionResponse,
  type DocumentTextExtractionAttestation,
} from "./extraction-contract";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;
const POLICY_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7E]+$/;
const PLACEHOLDER_SECRET_PATTERN = /(change[-_ ]?me|example|placeholder|replace)/i;
const MAX_DOCUMENT_EXTRACTION_INPUT_BYTES = 25n * 1_024n * 1_024n;
const MAX_RESULT_AGE_MS = 60 * 60 * 1_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 15 * 60 * 1_000;
const MAX_READINESS_RESPONSE_BYTES = 1_024;
const MAX_SAFE_ERROR_RESPONSE_BYTES = 1_024;
const ENGINE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;

export type DocumentExtractionBodyFactory = (
  signal: AbortSignal,
) => ReadableStream<Uint8Array>;

export interface ExternalDocumentExtractionRequest {
  expectedSha256: string;
  expectedSizeBytes: bigint;
  expectedStorageVersion: string;
  expectedEngineVersion: string;
  bodyFactory: DocumentExtractionBodyFactory;
  signal?: AbortSignal;
}

export interface StreamingDocumentExtractionRequestInit extends RequestInit {
  duplex: "half";
  body: ReadableStream<Uint8Array>;
}

export type DocumentExtractionFetch = (
  input: string,
  init: StreamingDocumentExtractionRequestInit,
) => Promise<Response>;

export type DocumentExtractionReadinessFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface DocumentExtractionClientDependencies {
  fetch?: DocumentExtractionFetch;
  readinessFetch?: DocumentExtractionReadinessFetch;
  clock?: () => Date;
}

export interface DocumentExtractionReadinessIdentity {
  schemaVersion: 1;
  status: "ready";
  policyVersion: string;
  toolchainDigest: string;
  engine: "poppler";
  engineVersion: string;
}

export type DocumentExtractionServiceErrorCode =
  | "extraction_request_invalid"
  | "extraction_stream_unavailable"
  | "extraction_request_aborted"
  | "extraction_service_timeout"
  | "extraction_service_unavailable"
  | "extraction_service_configuration_error"
  | "extraction_service_redirected"
  | "extraction_service_endpoint_mismatch"
  | "extraction_service_response_too_large"
  | "extraction_service_invalid_response"
  | "extraction_service_input_mismatch"
  | "extraction_service_policy_mismatch"
  | "extraction_service_toolchain_mismatch"
  | "extraction_service_engine_mismatch"
  | "extraction_service_busy"
  | "extraction_input_unsupported"
  | "extraction_resource_limit"
  | "extraction_service_result_stale"
  | "extraction_service_clock_invalid";

const ERROR_DETAILS: Record<
  DocumentExtractionServiceErrorCode,
  { message: string; retryable: boolean }
> = {
  extraction_request_invalid: {
    message: "Document text extraction could not be started.",
    retryable: false,
  },
  extraction_stream_unavailable: {
    message: "The validated document could not be opened for text extraction.",
    retryable: true,
  },
  extraction_request_aborted: {
    message: "Document text extraction was interrupted.",
    retryable: true,
  },
  extraction_service_timeout: {
    message: "The document text extraction service did not respond in time.",
    retryable: true,
  },
  extraction_service_unavailable: {
    message: "The document text extraction service is unavailable.",
    retryable: true,
  },
  extraction_service_configuration_error: {
    message: "The document text extraction service is not configured correctly.",
    retryable: false,
  },
  extraction_service_redirected: {
    message: "The document text extraction service attempted an unsupported redirect.",
    retryable: false,
  },
  extraction_service_endpoint_mismatch: {
    message: "The document text extraction service responded from an unexpected endpoint.",
    retryable: false,
  },
  extraction_service_response_too_large: {
    message: "The document text extraction service returned an oversized response.",
    retryable: false,
  },
  extraction_service_invalid_response: {
    message: "The document text extraction service returned an invalid response.",
    retryable: false,
  },
  extraction_service_input_mismatch: {
    message: "The extraction attestation did not match the validated document.",
    retryable: false,
  },
  extraction_service_policy_mismatch: {
    message: "The extraction attestation did not match the required policy.",
    retryable: false,
  },
  extraction_service_toolchain_mismatch: {
    message: "The extraction attestation did not match the pinned toolchain.",
    retryable: false,
  },
  extraction_service_engine_mismatch: {
    message: "The extraction result did not match the authenticated extractor identity.",
    retryable: true,
  },
  extraction_service_busy: {
    message: "The document extraction service has not admitted this request yet.",
    retryable: true,
  },
  extraction_input_unsupported: {
    message: "The validated PDF is not supported by the configured text extractor.",
    retryable: false,
  },
  extraction_resource_limit: {
    message: "The validated PDF exceeded a supported text extraction limit.",
    retryable: false,
  },
  extraction_service_result_stale: {
    message: "The document text extraction result was stale.",
    retryable: true,
  },
  extraction_service_clock_invalid: {
    message: "The document text extraction service clock could not be verified.",
    retryable: true,
  },
};

export class DocumentExtractionServiceError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: DocumentExtractionServiceErrorCode) {
    super(ERROR_DETAILS[code].message);
    this.name = "DocumentExtractionServiceError";
    this.retryable = ERROR_DETAILS[code].retryable;
  }
}

class RequestCancellation extends Error {
  constructor(readonly kind: "timeout" | "aborted") {
    super("Document text extraction request cancellation.");
    this.name = "RequestCancellation";
  }
}

class ResponseBoundaryError extends Error {
  constructor(readonly kind: "too_large" | "invalid") {
    super("Document text extraction response boundary failure.");
    this.name = "ResponseBoundaryError";
  }
}

function fail(code: DocumentExtractionServiceErrorCode): never {
  throw new DocumentExtractionServiceError(code);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]";
}

function checkedEndpoint(rawEndpoint: unknown): string {
  if (typeof rawEndpoint !== "string") {
    return fail("extraction_service_configuration_error");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    return fail("extraction_service_configuration_error");
  }
  const developmentLoopback = process.env.NODE_ENV !== "production"
    && endpoint.protocol === "http:"
    && isLoopbackHostname(endpoint.hostname);
  if (
    endpoint.toString() !== rawEndpoint
    || rawEndpoint.includes("?")
    || rawEndpoint.includes("#")
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.search !== ""
    || endpoint.hash !== ""
    || (endpoint.protocol !== "https:" && !developmentLoopback)
  ) {
    return fail("extraction_service_configuration_error");
  }
  return endpoint.toString();
}

function assertConfiguration(
  configuration: DocumentExtractionServiceConfiguration,
): { endpoint: string; readinessEndpoint: string } {
  if (typeof configuration !== "object" || configuration === null) {
    return fail("extraction_service_configuration_error");
  }
  const endpoint = checkedEndpoint(configuration.endpoint);
  const readinessEndpoint = checkedEndpoint(configuration.readinessEndpoint);
  if (
    new URL(endpoint).origin !== new URL(readinessEndpoint).origin
    || endpoint === readinessEndpoint
    || typeof configuration.bearerSecret !== "string"
    || configuration.bearerSecret.length < 32
    || configuration.bearerSecret.length > 4 * 1_024
    || !VISIBLE_ASCII_PATTERN.test(configuration.bearerSecret)
    || PLACEHOLDER_SECRET_PATTERN.test(configuration.bearerSecret)
    || typeof configuration.policyVersion !== "string"
    || configuration.policyVersion.length > 128
    || !POLICY_IDENTIFIER_PATTERN.test(configuration.policyVersion)
    || typeof configuration.expectedToolchainDigest !== "string"
    || !SHA256_PATTERN.test(configuration.expectedToolchainDigest)
    || /^0{64}$/.test(configuration.expectedToolchainDigest)
    || !Number.isSafeInteger(configuration.timeoutMs)
    || configuration.timeoutMs <= 0
    || configuration.timeoutMs > 180_000
    || !Number.isSafeInteger(configuration.maxResponseBytes)
    || configuration.maxResponseBytes < MIN_DOCUMENT_EXTRACTION_RESPONSE_BYTES
    || configuration.maxResponseBytes > MAX_DOCUMENT_EXTRACTION_RESPONSE_BYTES
    || !Number.isSafeInteger(configuration.resultMaxAgeMs)
    || configuration.resultMaxAgeMs <= 0
    || configuration.resultMaxAgeMs > MAX_RESULT_AGE_MS
    || !Number.isSafeInteger(configuration.futureClockSkewMs)
    || configuration.futureClockSkewMs < 0
    || configuration.futureClockSkewMs > MAX_FUTURE_CLOCK_SKEW_MS
    || configuration.futureClockSkewMs >= configuration.resultMaxAgeMs
  ) {
    return fail("extraction_service_configuration_error");
  }
  return { endpoint, readinessEndpoint };
}

function assertRequest(input: ExternalDocumentExtractionRequest): void {
  if (
    typeof input !== "object"
    || input === null
    || typeof input.expectedSha256 !== "string"
    || !SHA256_PATTERN.test(input.expectedSha256)
    || typeof input.expectedSizeBytes !== "bigint"
    || input.expectedSizeBytes <= 0n
    || input.expectedSizeBytes > MAX_DOCUMENT_EXTRACTION_INPUT_BYTES
    || typeof input.expectedStorageVersion !== "string"
    || input.expectedStorageVersion.length > 256
    || !SAFE_IDENTIFIER_PATTERN.test(input.expectedStorageVersion)
    || typeof input.expectedEngineVersion !== "string"
    || !ENGINE_VERSION_PATTERN.test(input.expectedEngineVersion)
    || typeof input.bodyFactory !== "function"
    || (input.signal !== undefined && !(input.signal instanceof AbortSignal))
  ) {
    fail("extraction_request_invalid");
  }
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof value === "object"
    && value !== null
    && "getReader" in value
    && typeof (value as { getReader?: unknown }).getReader === "function"
    && "cancel" in value
    && typeof (value as { cancel?: unknown }).cancel === "function"
    && "locked" in value
    && typeof (value as { locked?: unknown }).locked === "boolean";
}

function responseContentLength(response: Response, maximum: number): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  if (raw.length > 16 || !/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new ResponseBoundaryError("invalid");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new ResponseBoundaryError("invalid");
  if (value > maximum) throw new ResponseBoundaryError("too_large");
  return value;
}

async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  cancellationKind: () => "timeout" | "aborted" | null,
): Promise<unknown> {
  const declaredLength = responseContentLength(response, maximumBytes);
  if (!response.body) throw new ResponseBoundaryError("invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      if (signal.aborted) {
        throw new RequestCancellation(cancellationKind() ?? "aborted");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new ResponseBoundaryError("invalid");
      total += value.byteLength;
      if (total > maximumBytes) {
        cancelReader();
        throw new ResponseBoundaryError("too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ResponseBoundaryError || error instanceof RequestCancellation) {
      throw error;
    }
    throw new DocumentExtractionServiceError("extraction_service_unavailable");
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  if (total === 0 || (declaredLength !== null && declaredLength !== total)) {
    throw new ResponseBoundaryError("invalid");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new ResponseBoundaryError("invalid");
  }
}

function assertResponseIdentity(response: Response, endpoint: string): void {
  if (
    response.type === "opaqueredirect"
    || response.redirected
    || (response.status >= 300 && response.status < 400)
  ) {
    fail("extraction_service_redirected");
  }
  if (response.url !== endpoint) {
    fail("extraction_service_endpoint_mismatch");
  }
}

function assertReadinessResponseBoundary(response: Response, endpoint: string): void {
  assertResponseIdentity(response, endpoint);
  if (response.status === 200) {
    if (response.headers.get("content-type") !== "application/json") {
      fail("extraction_service_invalid_response");
    }
    return;
  }
  if (response.status === 401 || response.status === 403) {
    fail("extraction_service_configuration_error");
  }
  if (
    response.status === 408
    || response.status === 425
    || response.status === 429
    || response.status >= 500
  ) {
    fail("extraction_service_unavailable");
  }
  fail("extraction_service_invalid_response");
}

function exactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function parseReadinessIdentity(
  value: unknown,
  configuration: DocumentExtractionServiceConfiguration,
): DocumentExtractionReadinessIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("extraction_service_invalid_response");
  }
  const readiness = value as Record<string, unknown>;
  if (
    !exactObjectKeys(readiness, [
      "schemaVersion",
      "status",
      "policyVersion",
      "toolchainDigest",
      "engine",
      "engineVersion",
    ])
    || readiness.schemaVersion !== 1
    || readiness.status !== "ready"
    || readiness.engine !== "poppler"
    || typeof readiness.engineVersion !== "string"
    || !ENGINE_VERSION_PATTERN.test(readiness.engineVersion)
    || typeof readiness.policyVersion !== "string"
    || typeof readiness.toolchainDigest !== "string"
  ) {
    return fail("extraction_service_invalid_response");
  }
  if (readiness.policyVersion !== configuration.policyVersion) {
    return fail("extraction_service_policy_mismatch");
  }
  if (readiness.toolchainDigest !== configuration.expectedToolchainDigest) {
    return fail("extraction_service_toolchain_mismatch");
  }
  return {
    schemaVersion: 1,
    status: "ready",
    policyVersion: readiness.policyVersion,
    toolchainDigest: readiness.toolchainDigest,
    engine: "poppler",
    engineVersion: readiness.engineVersion,
  };
}

const SAFE_SERVICE_ERRORS = Object.freeze({
  extractor_busy: {
    status: 503,
    message: "The document extractor is temporarily busy.",
    clientCode: "extraction_service_busy",
  },
  extraction_input_unsupported: {
    status: 422,
    message: "The document input is not supported for text extraction.",
    clientCode: "extraction_input_unsupported",
  },
  extraction_resource_limit: {
    status: 422,
    message: "The document exceeded a supported extraction resource limit.",
    clientCode: "extraction_resource_limit",
  },
  policy_mismatch: {
    status: 409,
    message: "The requested extraction policy is not available.",
    clientCode: "extraction_service_policy_mismatch",
  },
} satisfies Record<string, {
  status: number;
  message: string;
  clientCode: DocumentExtractionServiceErrorCode;
}>);

async function explicitServiceFailureCode(
  response: Response,
  signal: AbortSignal,
  cancellationKind: () => "timeout" | "aborted" | null,
): Promise<DocumentExtractionServiceErrorCode | null> {
  if (response.headers.get("content-type") !== "application/json") return null;
  let value: unknown;
  try {
    value = await readBoundedJsonResponse(
      response,
      MAX_SAFE_ERROR_RESPONSE_BYTES,
      signal,
      cancellationKind,
    );
  } catch (error) {
    if (error instanceof RequestCancellation) throw error;
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (!exactObjectKeys(envelope, ["error"])) return null;
  const nested = envelope.error;
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return null;
  const detail = nested as Record<string, unknown>;
  if (
    !exactObjectKeys(detail, ["code", "message"])
    || typeof detail.code !== "string"
    || typeof detail.message !== "string"
  ) return null;
  const known = SAFE_SERVICE_ERRORS[detail.code as keyof typeof SAFE_SERVICE_ERRORS];
  return known !== undefined
    && known.status === response.status
    && known.message === detail.message
    ? known.clientCode
    : null;
}

async function assertExtractionResponseBoundary(
  response: Response,
  endpoint: string,
  signal: AbortSignal,
  cancellationKind: () => "timeout" | "aborted" | null,
): Promise<void> {
  assertResponseIdentity(response, endpoint);
  if (response.status === 200) {
    if (response.headers.get("content-type") !== "application/json") {
      fail("extraction_service_invalid_response");
    }
    return;
  }
  if (response.status === 401 || response.status === 403) {
    fail("extraction_service_configuration_error");
  }
  const explicitCode = await explicitServiceFailureCode(
    response,
    signal,
    cancellationKind,
  );
  if (explicitCode !== null) fail(explicitCode);
  if (
    response.status === 408
    || response.status === 425
    || response.status === 429
    || response.status >= 500
  ) {
    fail("extraction_service_unavailable");
  }
  fail("extraction_service_invalid_response");
}

function mapContractError(error: DocumentExtractionContractError): never {
  switch (error.failure) {
    case "input_mismatch":
      return fail("extraction_service_input_mismatch");
    case "policy_mismatch":
      return fail("extraction_service_policy_mismatch");
    case "toolchain_mismatch":
      return fail("extraction_service_toolchain_mismatch");
    case "engine_mismatch":
      return fail("extraction_service_engine_mismatch");
    case "result_stale":
      return fail("extraction_service_result_stale");
    case "clock_invalid":
      return fail("extraction_service_clock_invalid");
    case "invalid_response":
      return fail("extraction_service_invalid_response");
  }
}

/**
 * Confirms that the isolated extraction service and its Poppler dependency are
 * ready before a worker consumes a durable attempt. Every extraction request
 * still verifies the complete, content-bound response contract.
 */
export async function probeExternalDocumentExtractionReadiness(
  configuration: DocumentExtractionServiceConfiguration,
  dependencies: Pick<DocumentExtractionClientDependencies, "readinessFetch"> = {},
  signal?: AbortSignal,
): Promise<DocumentExtractionReadinessIdentity> {
  const { readinessEndpoint } = assertConfiguration(configuration);
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    fail("extraction_request_invalid");
  }
  if (signal?.aborted) fail("extraction_request_aborted");

  const controller = new AbortController();
  let cancellationKind: "timeout" | "aborted" | null = null;
  let rejectCancellation!: (error: RequestCancellation) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (kind: "timeout" | "aborted") => {
    if (cancellationKind !== null) return;
    cancellationKind = kind;
    controller.abort();
    rejectCancellation(new RequestCancellation(kind));
  };
  const timeout = setTimeout(
    () => cancel("timeout"),
    Math.min(configuration.timeoutMs, 5_000),
  );
  const onCallerAbort = () => cancel("aborted");
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (signal?.aborted) cancel("aborted");

  const operation = async (): Promise<DocumentExtractionReadinessIdentity> => {
    let response: Response;
    try {
      const fetcher = dependencies.readinessFetch
        ?? (globalThis.fetch as DocumentExtractionReadinessFetch);
      response = await fetcher(readinessEndpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${configuration.bearerSecret}`,
          "Cache-Control": "no-store",
        },
        redirect: "manual",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch {
      if (cancellationKind !== null || controller.signal.aborted) {
        throw new RequestCancellation(cancellationKind ?? "aborted");
      }
      return fail("extraction_service_unavailable");
    }
    try {
      assertReadinessResponseBoundary(response, readinessEndpoint);
      let rawResponse: unknown;
      try {
        rawResponse = await readBoundedJsonResponse(
          response,
          MAX_READINESS_RESPONSE_BYTES,
          controller.signal,
          () => cancellationKind,
        );
      } catch (error) {
        if (error instanceof ResponseBoundaryError) {
          return fail("extraction_service_invalid_response");
        }
        throw error;
      }
      return parseReadinessIdentity(rawResponse, configuration);
    } finally {
      if (response.body && !response.body.locked) {
        void response.body.cancel().catch(() => undefined);
      }
    }
  };

  try {
    return await Promise.race([operation(), cancellation]);
  } catch (error) {
    if (error instanceof DocumentExtractionServiceError) throw error;
    if (error instanceof RequestCancellation) {
      return fail(
        error.kind === "timeout"
          ? "extraction_service_timeout"
          : "extraction_request_aborted",
      );
    }
    return fail("extraction_service_unavailable");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

export async function requestExternalDocumentExtraction(
  input: ExternalDocumentExtractionRequest,
  configuration: DocumentExtractionServiceConfiguration,
  dependencies: DocumentExtractionClientDependencies = {},
): Promise<DocumentTextExtractionAttestation> {
  assertRequest(input);
  const { endpoint } = assertConfiguration(configuration);
  if (input.signal?.aborted) fail("extraction_request_aborted");

  const controller = new AbortController();
  let cancellationKind: "timeout" | "aborted" | null = null;
  let rejectCancellation!: (error: RequestCancellation) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (kind: "timeout" | "aborted") => {
    if (cancellationKind !== null) return;
    cancellationKind = kind;
    controller.abort();
    rejectCancellation(new RequestCancellation(kind));
  };
  const timeout = setTimeout(() => cancel("timeout"), configuration.timeoutMs);
  const onCallerAbort = () => cancel("aborted");
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (input.signal?.aborted) cancel("aborted");

  const operation = async (): Promise<DocumentTextExtractionAttestation> => {
    if (controller.signal.aborted) {
      throw new RequestCancellation(cancellationKind ?? "aborted");
    }
    let body: ReadableStream<Uint8Array>;
    try {
      body = input.bodyFactory(controller.signal);
    } catch {
      return fail("extraction_stream_unavailable");
    }
    if (!isReadableStream(body) || body.locked) {
      return fail("extraction_stream_unavailable");
    }

    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${configuration.bearerSecret}`,
      "Cache-Control": "no-store",
      "Content-Length": input.expectedSizeBytes.toString(),
      "Content-Type": "application/pdf",
      "X-PaperPilot-Content-SHA256": input.expectedSha256,
      "X-PaperPilot-Storage-Version": input.expectedStorageVersion,
      "X-PaperPilot-Extraction-Policy": configuration.policyVersion,
    });

    let response: Response;
    try {
      const fetcher = dependencies.fetch
        ?? (globalThis.fetch as unknown as DocumentExtractionFetch);
      response = await fetcher(endpoint, {
        method: "POST",
        headers,
        body,
        duplex: "half",
        redirect: "manual",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch {
      if (cancellationKind !== null || controller.signal.aborted) {
        throw new RequestCancellation(cancellationKind ?? "aborted");
      }
      return fail("extraction_service_unavailable");
    }

    try {
      await assertExtractionResponseBoundary(
        response,
        endpoint,
        controller.signal,
        () => cancellationKind,
      );
      let rawResponse: unknown;
      try {
        rawResponse = await readBoundedJsonResponse(
          response,
          configuration.maxResponseBytes,
          controller.signal,
          () => cancellationKind,
        );
      } catch (error) {
        if (error instanceof ResponseBoundaryError) {
          return fail(
            error.kind === "too_large"
              ? "extraction_service_response_too_large"
              : "extraction_service_invalid_response",
          );
        }
        throw error;
      }

      const now = dependencies.clock?.() ?? new Date();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        return fail("extraction_request_invalid");
      }
      try {
        return parseExternalDocumentExtractionResponse(rawResponse, {
          inputSha256: input.expectedSha256,
          inputSizeBytes: input.expectedSizeBytes,
          storageVersion: input.expectedStorageVersion,
          policyVersion: configuration.policyVersion,
          toolchainDigest: configuration.expectedToolchainDigest,
          expectedEngineVersion: input.expectedEngineVersion,
          now,
          maxDurationMs: configuration.timeoutMs,
          resultMaxAgeMs: configuration.resultMaxAgeMs,
          futureClockSkewMs: configuration.futureClockSkewMs,
        });
      } catch (error) {
        if (error instanceof DocumentExtractionContractError) {
          return mapContractError(error);
        }
        return fail("extraction_service_invalid_response");
      }
    } finally {
      if (response.body && !response.body.locked) {
        void response.body.cancel().catch(() => undefined);
      }
    }
  };

  try {
    return await Promise.race([operation(), cancellation]);
  } catch (error) {
    if (error instanceof DocumentExtractionServiceError) throw error;
    if (error instanceof RequestCancellation) {
      return fail(
        error.kind === "timeout"
          ? "extraction_service_timeout"
          : "extraction_request_aborted",
      );
    }
    return fail("extraction_service_unavailable");
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }
}
