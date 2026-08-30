import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

import {
  claimNextDocumentTextExtractionJob,
  completeDocumentTextExtractionLease,
  DEFAULT_DOCUMENT_TEXT_EXTRACTION_LEASE_TTL_MS,
  deferDocumentTextExtractionLeaseBeforeAdmission,
  DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
  failDocumentTextExtractionLease,
  heartbeatDocumentTextExtractionLease,
  type DocumentTextExtractionExecutionFailureCode,
  type DocumentTextExtractionLease,
} from "@/server/documents/extraction-jobs";
import {
  DocumentExtractionServiceError,
  probeExternalDocumentExtractionReadiness,
  requestExternalDocumentExtraction,
  type DocumentExtractionClientDependencies,
  type DocumentExtractionReadinessIdentity,
  type DocumentExtractionServiceErrorCode,
} from "@/server/documents/extraction-client";
import {
  documentExtractionServiceConfigurationFromEnvironment,
  type DocumentExtractionServiceConfiguration,
} from "@/server/documents/extraction-config";
import { HttpProblem } from "@/server/http/problem";
import {
  uploadConfigurationFromEnvironment,
  type UploadConfiguration,
} from "@/server/uploads/config";
import { withOpenLocalQuarantineObject } from "@/server/uploads/storage";

const FILE_READ_CHUNK_BYTES = 256 * 1_024;
const DEFAULT_IDLE_POLL_MS = 1_000;
const DEFAULT_SERVICE_UNAVAILABLE_POLL_MS = 5_000;
const MAX_WORKER_ID_BYTES = 200;

export interface DocumentTextExtractionWorkerOptions {
  workerId?: string;
  leaseTtlMs?: number;
  extractionConfiguration?: DocumentExtractionServiceConfiguration;
  uploadConfiguration?: Pick<UploadConfiguration, "quarantineRoot">;
  clientDependencies?: DocumentExtractionClientDependencies;
  signal?: AbortSignal;
}

export type DocumentTextExtractionWorkerOnceResult =
  | { kind: "idle" }
  | { kind: "service-unavailable" }
  | {
    kind: "extracted" | "no-text";
    jobId: string;
    extractionId: string;
    outcome: "applied" | "replayed";
  }
  | { kind: "retrying" | "dead-letter" | "lease-lost"; jobId: string };

class ExtractionInputIntegrityError extends Error {
  constructor(readonly code: "extraction_input_changed" | "extraction_object_missing") {
    super("The validated extraction input could not be verified.");
    this.name = "ExtractionInputIntegrityError";
  }
}

class WorkerLeaseAbortError extends Error {
  constructor() {
    super("The text extraction worker lease could not be retained.");
    this.name = "WorkerLeaseAbortError";
  }
}

function defaultWorkerId(): string {
  return `${hostname() || "paperpilot"}:${process.pid}:${randomUUID()}`;
}

function requireWorkerId(rawWorkerId: string | undefined): string {
  const value = (rawWorkerId ?? defaultWorkerId()).trim();
  if (
    value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_WORKER_ID_BYTES
  ) throw new Error("PAPERPILOT_EXTRACTION_WORKER_ID is invalid.");
  return value;
}

function requireWorkerConfiguration(
  options: DocumentTextExtractionWorkerOptions,
): {
  workerId: string;
  leaseTtlMs: number;
  extraction: DocumentExtractionServiceConfiguration;
  upload: Pick<UploadConfiguration, "quarantineRoot">;
} {
  const extraction = options.extractionConfiguration
    ?? documentExtractionServiceConfigurationFromEnvironment();
  if (extraction.policyVersion !== DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION) {
    throw new Error(
      `PAPERPILOT_EXTRACTION_POLICY_VERSION must be ${DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION}.`,
    );
  }
  const upload = options.uploadConfiguration ?? uploadConfigurationFromEnvironment();
  if (process.env.NODE_ENV === "production" && process.platform === "win32") {
    throw new Error(
      "Production extraction cannot use the local Windows quarantine adapter; deploy the worker on a protected Linux volume or add a hardened object-storage adapter.",
    );
  }
  return {
    workerId: requireWorkerId(options.workerId ?? process.env.PAPERPILOT_EXTRACTION_WORKER_ID),
    leaseTtlMs: options.leaseTtlMs ?? DEFAULT_DOCUMENT_TEXT_EXTRACTION_LEASE_TTL_MS,
    extraction,
    upload,
  };
}

async function hashOpenFile(
  handle: FileHandle,
  expectedSizeBytes: bigint,
  signal: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  let position = 0n;
  while (position < expectedSizeBytes) {
    if (signal.aborted) throw new WorkerLeaseAbortError();
    const remaining = expectedSizeBytes - position;
    const requested = Number(
      remaining > BigInt(FILE_READ_CHUNK_BYTES)
        ? BigInt(FILE_READ_CHUNK_BYTES)
        : remaining,
    );
    const buffer = Buffer.allocUnsafe(requested);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      requested,
      Number(position),
    );
    if (bytesRead !== requested) {
      throw new ExtractionInputIntegrityError("extraction_input_changed");
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += BigInt(bytesRead);
  }
  return hash.digest("hex");
}

function streamOpenFile(
  handle: FileHandle,
  expectedSizeBytes: bigint,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let position = 0n;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) {
        controller.error(new DOMException("Extraction request aborted.", "AbortError"));
        return;
      }
      if (position >= expectedSizeBytes) {
        controller.close();
        return;
      }
      const remaining = expectedSizeBytes - position;
      const requested = Number(
        remaining > BigInt(FILE_READ_CHUNK_BYTES)
          ? BigInt(FILE_READ_CHUNK_BYTES)
          : remaining,
      );
      try {
        const buffer = Buffer.allocUnsafe(requested);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          requested,
          Number(position),
        );
        if (bytesRead !== requested) {
          throw new ExtractionInputIntegrityError("extraction_input_changed");
        }
        position += BigInt(bytesRead);
        controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function executionFailureForServiceError(
  code: DocumentExtractionServiceErrorCode,
): DocumentTextExtractionExecutionFailureCode {
  switch (code) {
    case "extraction_service_timeout":
      return "extraction_service_timeout";
    case "extraction_service_result_stale":
    case "extraction_service_clock_invalid":
      return "extraction_attestation_stale";
    case "extraction_stream_unavailable":
      return "extraction_object_missing";
    case "extraction_service_input_mismatch":
      return "extraction_input_changed";
    case "extraction_input_unsupported":
      return "extraction_input_unsupported";
    case "extraction_resource_limit":
      return "extraction_resource_limit";
    case "extraction_service_unavailable":
    case "extraction_service_busy":
    case "extraction_request_aborted":
      return "extraction_service_unavailable";
    case "extraction_request_invalid":
    case "extraction_service_configuration_error":
    case "extraction_service_redirected":
    case "extraction_service_endpoint_mismatch":
    case "extraction_service_response_too_large":
    case "extraction_service_invalid_response":
    case "extraction_service_policy_mismatch":
    case "extraction_service_toolchain_mismatch":
    case "extraction_service_engine_mismatch":
      return "extraction_response_invalid";
  }
}

function failureFromUnknown(error: unknown): {
  code: DocumentTextExtractionExecutionFailureCode;
  retryable: boolean;
} {
  if (error instanceof DocumentExtractionServiceError) {
    return {
      code: executionFailureForServiceError(error.code),
      retryable: error.retryable,
    };
  }
  if (error instanceof ExtractionInputIntegrityError) {
    return { code: error.code, retryable: false };
  }
  if (error instanceof WorkerLeaseAbortError) {
    return { code: "extraction_service_unavailable", retryable: true };
  }
  if (error instanceof HttpProblem) {
    if (error.code === "quarantine_object_changed") {
      return { code: "extraction_input_changed", retryable: false };
    }
    if (error.code === "quarantine_object_missing") {
      return { code: "extraction_object_missing", retryable: false };
    }
  }
  return { code: "extraction_worker_internal", retryable: true };
}

async function extractOpenValidatedObject(input: {
  lease: DocumentTextExtractionLease;
  configuration: Pick<UploadConfiguration, "quarantineRoot">;
  extractionConfiguration: DocumentExtractionServiceConfiguration;
  readinessIdentity: DocumentExtractionReadinessIdentity;
  clientDependencies?: DocumentExtractionClientDependencies;
  signal: AbortSignal;
}) {
  return withOpenLocalQuarantineObject(
    input.configuration,
    input.lease.storageKey,
    {
      organizationId: input.lease.organizationId,
      assetId: input.lease.assetId,
    },
    async ({ handle, sizeBytes }) => {
      if (sizeBytes !== input.lease.inputSizeBytes) {
        throw new ExtractionInputIntegrityError("extraction_input_changed");
      }
      const actualSha256 = await hashOpenFile(
        handle,
        input.lease.inputSizeBytes,
        input.signal,
      );
      if (actualSha256 !== input.lease.inputSha256) {
        throw new ExtractionInputIntegrityError("extraction_input_changed");
      }
      let bodyCreated = false;
      return requestExternalDocumentExtraction(
        {
          expectedSha256: input.lease.inputSha256,
          expectedSizeBytes: input.lease.inputSizeBytes,
          expectedStorageVersion: input.lease.storageVersion,
          expectedEngineVersion: input.readinessIdentity.engineVersion,
          bodyFactory: (signal) => {
            if (bodyCreated) {
              throw new ExtractionInputIntegrityError("extraction_input_changed");
            }
            bodyCreated = true;
            return streamOpenFile(handle, input.lease.inputSizeBytes, signal);
          },
          signal: input.signal,
        },
        input.extractionConfiguration,
        input.clientDependencies,
      );
    },
    input.lease.storageAuthorityGeneration,
  );
}

async function withLeaseHeartbeat<T>(input: {
  lease: DocumentTextExtractionLease;
  leaseTtlMs: number;
  controller: AbortController;
  operation: () => Promise<T>;
}): Promise<T> {
  const intervalMs = Math.max(5_000, Math.min(30_000, Math.floor(input.leaseTtlMs / 3)));
  let heartbeatRunning = false;
  let heartbeatTask: Promise<void> = Promise.resolve();
  const interval = setInterval(() => {
    if (heartbeatRunning || input.controller.signal.aborted) return;
    heartbeatRunning = true;
    heartbeatTask = heartbeatDocumentTextExtractionLease({
      lease: input.lease,
      leaseTtlMs: input.leaseTtlMs,
    }).then((retained) => {
      if (!retained) input.controller.abort();
    }).catch(() => {
      input.controller.abort();
    }).finally(() => {
      heartbeatRunning = false;
    });
  }, intervalMs);
  interval.unref?.();
  try {
    return await input.operation();
  } finally {
    clearInterval(interval);
    await heartbeatTask.catch(() => undefined);
  }
}

export async function runDocumentTextExtractionWorkerOnce(
  options: DocumentTextExtractionWorkerOptions = {},
): Promise<DocumentTextExtractionWorkerOnceResult> {
  // Fail configuration/readiness before claiming so deployment outages never
  // consume the durable attempt budget.
  const configuration = requireWorkerConfiguration(options);
  let readinessIdentity: DocumentExtractionReadinessIdentity;
  try {
    readinessIdentity = await probeExternalDocumentExtractionReadiness(
      configuration.extraction,
      options.clientDependencies,
      options.signal,
    );
  } catch (error) {
    if (error instanceof DocumentExtractionServiceError && error.retryable) {
      return { kind: "service-unavailable" };
    }
    throw error;
  }
  const lease = await claimNextDocumentTextExtractionJob({
    workerId: configuration.workerId,
    expectedPolicyVersion: configuration.extraction.policyVersion,
    expectedToolchainDigest: configuration.extraction.expectedToolchainDigest,
    leaseTtlMs: configuration.leaseTtlMs,
  });
  if (!lease) return { kind: "idle" };

  const controller = new AbortController();
  const abortForCaller = () => controller.abort();
  options.signal?.addEventListener("abort", abortForCaller, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const attestation = await withLeaseHeartbeat({
      lease,
      leaseTtlMs: configuration.leaseTtlMs,
      controller,
      operation: () => extractOpenValidatedObject({
        lease,
        configuration: configuration.upload,
        extractionConfiguration: configuration.extraction,
        readinessIdentity,
        clientDependencies: options.clientDependencies,
        signal: controller.signal,
      }),
    });
    const completion = await completeDocumentTextExtractionLease({ lease, attestation });
    if (!completion) return { kind: "lease-lost", jobId: lease.jobId };
    return {
      kind: completion.verdict === "EXTRACTED" ? "extracted" : "no-text",
      jobId: lease.jobId,
      extractionId: completion.extractionId,
      outcome: completion.outcome,
    };
  } catch (error) {
    if (
      error instanceof DocumentExtractionServiceError
      && error.code === "extraction_service_busy"
    ) {
      const deferred = await deferDocumentTextExtractionLeaseBeforeAdmission({ lease });
      return deferred === "deferred"
        ? { kind: "service-unavailable" }
        : { kind: "lease-lost", jobId: lease.jobId };
    }
    const failure = failureFromUnknown(error);
    const outcome = await failDocumentTextExtractionLease({
      lease,
      code: failure.code,
      retryable: failure.retryable,
    });
    return { kind: outcome, jobId: lease.jobId };
  } finally {
    options.signal?.removeEventListener("abort", abortForCaller);
    controller.abort();
  }
}

async function waitForNextPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      finish();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function runDocumentTextExtractionWorkerLoop(
  options: DocumentTextExtractionWorkerOptions = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const configuration = requireWorkerConfiguration(options);
  while (!signal.aborted) {
    const result = await runDocumentTextExtractionWorkerOnce({
      ...options,
      workerId: configuration.workerId,
      leaseTtlMs: configuration.leaseTtlMs,
      extractionConfiguration: configuration.extraction,
      uploadConfiguration: configuration.upload,
      signal,
    });
    if (result.kind === "idle") {
      await waitForNextPoll(DEFAULT_IDLE_POLL_MS, signal);
    } else if (result.kind === "service-unavailable") {
      await waitForNextPoll(DEFAULT_SERVICE_UNAVAILABLE_POLL_MS, signal);
    }
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runDocumentTextExtractionWorkerLoop({}, controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (entrypoint === import.meta.url) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : "Text extraction worker failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
