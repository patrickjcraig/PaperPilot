import "server-only";

import {
  MAX_DOCUMENT_VALIDATION_RESPONSE_BYTES,
  MIN_DOCUMENT_VALIDATION_RESPONSE_BYTES,
  type DocumentValidationServiceConfiguration,
} from "./validation-config";
import {
  DocumentValidationContractError,
  parseExternalDocumentValidationResponse,
  type DocumentValidationAttestation,
} from "./validation-contract";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7E]+$/;

export type DocumentValidationBodyFactory = (
  signal: AbortSignal,
) => ReadableStream<Uint8Array>;

export interface ExternalDocumentValidationRequest {
  expectedSha256: string;
  expectedSizeBytes: bigint;
  expectedStorageVersion: string;
  bodyFactory: DocumentValidationBodyFactory;
  signal?: AbortSignal;
}

export interface StreamingDocumentValidationRequestInit extends RequestInit {
  duplex: "half";
  body: ReadableStream<Uint8Array>;
}

export type DocumentValidationFetch = (
  input: string,
  init: StreamingDocumentValidationRequestInit,
) => Promise<Response>;

export type DocumentValidationReadinessFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface DocumentValidationClientDependencies {
  fetch?: DocumentValidationFetch;
  readinessFetch?: DocumentValidationReadinessFetch;
  clock?: () => Date;
}

export type DocumentValidationServiceErrorCode =
  | "validation_request_invalid"
  | "validation_stream_unavailable"
  | "validation_request_aborted"
  | "validation_service_timeout"
  | "validation_service_unavailable"
  | "validation_service_configuration_error"
  | "validation_service_redirected"
  | "validation_service_endpoint_mismatch"
  | "validation_service_response_too_large"
  | "validation_service_invalid_response"
  | "validation_service_content_mismatch"
  | "validation_service_storage_mismatch"
  | "validation_service_policy_mismatch"
  | "validation_service_signatures_stale"
  | "validation_service_clock_invalid";

const ERROR_DETAILS: Record<
  DocumentValidationServiceErrorCode,
  { message: string; retryable: boolean }
> = {
  validation_request_invalid: {
    message: "Document validation could not be started.",
    retryable: false,
  },
  validation_stream_unavailable: {
    message: "The quarantined document could not be opened for validation.",
    retryable: true,
  },
  validation_request_aborted: {
    message: "Document validation was interrupted.",
    retryable: true,
  },
  validation_service_timeout: {
    message: "The document validation service did not respond in time.",
    retryable: true,
  },
  validation_service_unavailable: {
    message: "The document validation service is unavailable.",
    retryable: true,
  },
  validation_service_configuration_error: {
    message: "The document validation service is not configured correctly.",
    retryable: false,
  },
  validation_service_redirected: {
    message: "The document validation service attempted an unsupported redirect.",
    retryable: false,
  },
  validation_service_endpoint_mismatch: {
    message: "The document validation service responded from an unexpected endpoint.",
    retryable: false,
  },
  validation_service_response_too_large: {
    message: "The document validation service returned an oversized response.",
    retryable: false,
  },
  validation_service_invalid_response: {
    message: "The document validation service returned an invalid response.",
    retryable: false,
  },
  validation_service_content_mismatch: {
    message: "The validation attestation did not match the quarantined document.",
    retryable: false,
  },
  validation_service_storage_mismatch: {
    message: "The validation attestation did not match the quarantined storage version.",
    retryable: false,
  },
  validation_service_policy_mismatch: {
    message: "The validation attestation did not match the required policy.",
    retryable: false,
  },
  validation_service_signatures_stale: {
    message: "The validation service signature database is stale.",
    retryable: true,
  },
  validation_service_clock_invalid: {
    message: "The validation service clock could not be verified.",
    retryable: true,
  },
};

export class DocumentValidationServiceError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: DocumentValidationServiceErrorCode) {
    super(ERROR_DETAILS[code].message);
    this.name = "DocumentValidationServiceError";
    this.retryable = ERROR_DETAILS[code].retryable;
  }
}

class RequestCancellation extends Error {
  constructor(readonly kind: "timeout" | "aborted") {
    super("Document validation request cancellation.");
    this.name = "RequestCancellation";
  }
}

class ResponseBoundaryError extends Error {
  constructor(readonly kind: "too_large" | "invalid") {
    super("Document validation response boundary failure.");
    this.name = "ResponseBoundaryError";
  }
}

function fail(code: DocumentValidationServiceErrorCode): never {
  throw new DocumentValidationServiceError(code);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]";
}

function checkedEndpoint(rawEndpoint: unknown): string {
  if (typeof rawEndpoint !== "string") {
    return fail("validation_service_configuration_error");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    return fail("validation_service_configuration_error");
  }
  if (
    endpoint.toString() !== rawEndpoint
    || rawEndpoint.includes("?")
    || rawEndpoint.includes("#")
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.search !== ""
    || endpoint.hash !== ""
    || (
      endpoint.protocol !== "https:"
      && !(endpoint.protocol === "http:" && isLoopbackHostname(endpoint.hostname))
    )
  ) {
    return fail("validation_service_configuration_error");
  }
  return endpoint.toString();
}

function assertConfiguration(
  configuration: DocumentValidationServiceConfiguration,
): { endpoint: string; readinessEndpoint: string } {
  const endpoint = checkedEndpoint(configuration.endpoint);
  const readinessEndpoint = checkedEndpoint(configuration.readinessEndpoint);
  if (
    new URL(endpoint).origin !== new URL(readinessEndpoint).origin
    || endpoint === readinessEndpoint
    || typeof configuration.bearerSecret !== "string"
    || configuration.bearerSecret.length < 32
    || configuration.bearerSecret.length > 4 * 1_024
    || !VISIBLE_ASCII_PATTERN.test(configuration.bearerSecret)
    || typeof configuration.policyVersion !== "string"
    || configuration.policyVersion.length > 128
    || !SAFE_IDENTIFIER_PATTERN.test(configuration.policyVersion)
    || !Number.isSafeInteger(configuration.timeoutMs)
    || configuration.timeoutMs <= 0
    || configuration.timeoutMs > 120_000
    || !Number.isSafeInteger(configuration.maxResponseBytes)
    || configuration.maxResponseBytes < MIN_DOCUMENT_VALIDATION_RESPONSE_BYTES
    || configuration.maxResponseBytes > MAX_DOCUMENT_VALIDATION_RESPONSE_BYTES
    || !Number.isSafeInteger(configuration.signatureMaxAgeMs)
    || configuration.signatureMaxAgeMs <= 0
    || !Number.isSafeInteger(configuration.futureClockSkewMs)
    || configuration.futureClockSkewMs < 0
    || configuration.futureClockSkewMs >= configuration.signatureMaxAgeMs
  ) {
    return fail("validation_service_configuration_error");
  }
  return { endpoint, readinessEndpoint };
}

function assertRequest(input: ExternalDocumentValidationRequest): void {
  if (
    typeof input !== "object"
    || input === null
    || typeof input.expectedSha256 !== "string"
    || !SHA256_PATTERN.test(input.expectedSha256)
    || typeof input.expectedSizeBytes !== "bigint"
    || input.expectedSizeBytes <= 0n
    || input.expectedSizeBytes > BigInt(Number.MAX_SAFE_INTEGER)
    || typeof input.expectedStorageVersion !== "string"
    || input.expectedStorageVersion.length > 256
    || !SAFE_IDENTIFIER_PATTERN.test(input.expectedStorageVersion)
    || typeof input.bodyFactory !== "function"
    || (input.signal !== undefined && !(input.signal instanceof AbortSignal))
  ) {
    fail("validation_request_invalid");
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
        void reader.cancel().catch(() => undefined);
        throw new ResponseBoundaryError("too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ResponseBoundaryError || error instanceof RequestCancellation) {
      throw error;
    }
    throw new DocumentValidationServiceError("validation_service_unavailable");
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
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new ResponseBoundaryError("invalid");
  }
}

function assertResponseBoundary(response: Response, endpoint: string): void {
  if (
    response.type === "opaqueredirect"
    || response.redirected
    || (response.status >= 300 && response.status < 400)
  ) {
    fail("validation_service_redirected");
  }
  if (response.url !== endpoint) {
    fail("validation_service_endpoint_mismatch");
  }
  if (response.status !== 200) {
    if (response.status === 401 || response.status === 403) {
      fail("validation_service_configuration_error");
    }
    if (
      response.status === 408
      || response.status === 425
      || response.status === 429
      || response.status >= 500
    ) {
      fail("validation_service_unavailable");
    }
    fail("validation_service_invalid_response");
  }
  if (response.headers.get("content-type")?.toLowerCase() !== "application/json") {
    fail("validation_service_invalid_response");
  }
}

function assertReadinessResponseBoundary(
  response: Response,
  endpoint: string,
): void {
  if (
    response.type === "opaqueredirect"
    || response.redirected
    || (response.status >= 300 && response.status < 400)
  ) {
    fail("validation_service_redirected");
  }
  if (response.url !== endpoint) {
    fail("validation_service_endpoint_mismatch");
  }
  if (response.status === 200 || response.status === 204) return;
  if (response.status === 401 || response.status === 403) {
    fail("validation_service_configuration_error");
  }
  if (
    response.status === 408
    || response.status === 425
    || response.status === 429
    || response.status >= 500
  ) {
    fail("validation_service_unavailable");
  }
  fail("validation_service_invalid_response");
}

function mapContractError(error: DocumentValidationContractError): never {
  switch (error.failure) {
    case "content_binding_mismatch":
      return fail("validation_service_content_mismatch");
    case "storage_binding_mismatch":
      return fail("validation_service_storage_mismatch");
    case "policy_binding_mismatch":
      return fail("validation_service_policy_mismatch");
    case "signatures_stale":
      return fail("validation_service_signatures_stale");
    case "clock_invalid":
      return fail("validation_service_clock_invalid");
    case "invalid_response":
      return fail("validation_service_invalid_response");
  }
}

/**
 * Confirms that the isolated validator and its malware-signature/toolchain
 * dependencies are ready before a worker consumes a durable job attempt.
 * This is an optimization rather than an authorization decision; every
 * validation request still enforces the complete response contract.
 */
export async function probeExternalDocumentValidationReadiness(
  configuration: DocumentValidationServiceConfiguration,
  dependencies: Pick<DocumentValidationClientDependencies, "readinessFetch"> = {},
  signal?: AbortSignal,
): Promise<void> {
  const { readinessEndpoint } = assertConfiguration(configuration);
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    fail("validation_request_invalid");
  }
  if (signal?.aborted) fail("validation_request_aborted");

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

  const operation = async () => {
    let response: Response;
    try {
      const fetcher = dependencies.readinessFetch
        ?? (globalThis.fetch as DocumentValidationReadinessFetch);
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
      return fail("validation_service_unavailable");
    }
    try {
      assertReadinessResponseBoundary(response, readinessEndpoint);
    } finally {
      if (response.body) void response.body.cancel().catch(() => undefined);
    }
  };

  try {
    await Promise.race([operation(), cancellation]);
  } catch (error) {
    if (error instanceof DocumentValidationServiceError) throw error;
    if (error instanceof RequestCancellation) {
      return fail(
        error.kind === "timeout"
          ? "validation_service_timeout"
          : "validation_request_aborted",
      );
    }
    return fail("validation_service_unavailable");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

export async function requestExternalDocumentValidation(
  input: ExternalDocumentValidationRequest,
  configuration: DocumentValidationServiceConfiguration,
  dependencies: DocumentValidationClientDependencies = {},
): Promise<DocumentValidationAttestation> {
  assertRequest(input);
  const { endpoint } = assertConfiguration(configuration);
  if (input.signal?.aborted) fail("validation_request_aborted");

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

  const operation = async (): Promise<DocumentValidationAttestation> => {
    if (controller.signal.aborted) {
      throw new RequestCancellation(cancellationKind ?? "aborted");
    }
    let body: ReadableStream<Uint8Array>;
    try {
      body = input.bodyFactory(controller.signal);
    } catch {
      return fail("validation_stream_unavailable");
    }
    if (!isReadableStream(body) || body.locked) {
      return fail("validation_stream_unavailable");
    }

    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${configuration.bearerSecret}`,
      "Cache-Control": "no-store",
      "Content-Length": input.expectedSizeBytes.toString(),
      "Content-Type": "application/pdf",
      "X-PaperPilot-Content-SHA256": input.expectedSha256,
      "X-PaperPilot-Storage-Version": input.expectedStorageVersion,
      "X-PaperPilot-Validation-Policy": configuration.policyVersion,
    });

    let response: Response;
    try {
      const fetcher = dependencies.fetch
        ?? (globalThis.fetch as unknown as DocumentValidationFetch);
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
      return fail("validation_service_unavailable");
    }

    assertResponseBoundary(response, endpoint);
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
            ? "validation_service_response_too_large"
            : "validation_service_invalid_response",
        );
      }
      throw error;
    }

    const now = dependencies.clock?.() ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      return fail("validation_request_invalid");
    }
    try {
      return parseExternalDocumentValidationResponse(rawResponse, {
        expectedSha256: input.expectedSha256,
        expectedSizeBytes: input.expectedSizeBytes,
        expectedStorageVersion: input.expectedStorageVersion,
        expectedPolicyVersion: configuration.policyVersion,
        now,
        signatureMaxAgeMs: configuration.signatureMaxAgeMs,
        futureClockSkewMs: configuration.futureClockSkewMs,
        maxDurationMs: configuration.timeoutMs,
      });
    } catch (error) {
      if (error instanceof DocumentValidationContractError) {
        return mapContractError(error);
      }
      return fail("validation_service_invalid_response");
    }
  };

  try {
    return await Promise.race([operation(), cancellation]);
  } catch (error) {
    if (error instanceof DocumentValidationServiceError) throw error;
    if (error instanceof RequestCancellation) {
      return fail(
        error.kind === "timeout"
          ? "validation_service_timeout"
          : "validation_request_aborted",
      );
    }
    return fail("validation_service_unavailable");
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }
}
