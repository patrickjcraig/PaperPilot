import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

import {
  claimNextDocumentValidationJob,
  completeDocumentValidationLease,
  DEFAULT_DOCUMENT_VALIDATION_LEASE_TTL_MS,
  DOCUMENT_VALIDATION_POLICY_VERSION,
  failDocumentValidationLease,
  heartbeatDocumentValidationLease,
  type DocumentValidationExecutionFailureCode,
  type DocumentValidationLease,
} from "@/server/documents/validation-jobs";
import {
  DocumentValidationServiceError,
  probeExternalDocumentValidationReadiness,
  requestExternalDocumentValidation,
  type DocumentValidationClientDependencies,
  type DocumentValidationServiceErrorCode,
} from "@/server/documents/validation-client";
import {
  documentValidationServiceConfigurationFromEnvironment,
  type DocumentValidationServiceConfiguration,
} from "@/server/documents/validation-config";
import {
  requireDocumentExtractionToolchainDigest,
} from "@/server/documents/extraction-config";
import { HttpProblem } from "@/server/http/problem";
import {
  uploadConfigurationFromEnvironment,
  type UploadConfiguration,
} from "@/server/uploads/config";
import { reconcileUploadIntake } from "@/server/uploads/reconciler";
import { withOpenLocalQuarantineObject } from "@/server/uploads/storage";

const FILE_READ_CHUNK_BYTES = 256 * 1_024;
const DEFAULT_IDLE_POLL_MS = 1_000;
const DEFAULT_SERVICE_UNAVAILABLE_POLL_MS = 5_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const MAX_WORKER_ID_BYTES = 200;

export interface DocumentValidationWorkerOptions {
  workerId?: string;
  leaseTtlMs?: number;
  validationConfiguration?: DocumentValidationServiceConfiguration;
  extractionExpectedToolchainDigest?: string;
  uploadConfiguration?: Pick<UploadConfiguration, "quarantineRoot">;
  clientDependencies?: DocumentValidationClientDependencies;
  signal?: AbortSignal;
}

export type DocumentValidationWorkerOnceResult =
  | { kind: "idle" }
  | { kind: "service-unavailable" }
  | { kind: "accepted" | "rejected"; jobId: string; outcome: "applied" | "replayed" }
  | { kind: "retrying" | "dead-letter" | "lease-lost"; jobId: string };

class QuarantineIntegrityError extends Error {
  constructor(readonly code: "validation_input_changed" | "validation_object_missing") {
    super("The quarantined validation input could not be verified.");
    this.name = "QuarantineIntegrityError";
  }
}

class WorkerLeaseAbortError extends Error {
  constructor() {
    super("The validation worker lease could not be retained.");
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
  ) throw new Error("PAPERPILOT_VALIDATION_WORKER_ID is invalid.");
  return value;
}

function requireWorkerConfiguration(
  options: DocumentValidationWorkerOptions,
): {
  workerId: string;
  leaseTtlMs: number;
  validation: DocumentValidationServiceConfiguration;
  extractionToolchainDigest: string;
  upload: Pick<UploadConfiguration, "quarantineRoot">;
} {
  const validation = options.validationConfiguration
    ?? documentValidationServiceConfigurationFromEnvironment();
  if (validation.policyVersion !== DOCUMENT_VALIDATION_POLICY_VERSION) {
    throw new Error(
      `PAPERPILOT_VALIDATION_POLICY_VERSION must be ${DOCUMENT_VALIDATION_POLICY_VERSION}.`,
    );
  }
  const upload = options.uploadConfiguration ?? uploadConfigurationFromEnvironment();
  const extractionToolchainDigest = requireDocumentExtractionToolchainDigest(
    options.extractionExpectedToolchainDigest
      ?? process.env.PAPERPILOT_EXTRACTION_EXPECTED_TOOLCHAIN_DIGEST,
  );
  if (process.env.NODE_ENV === "production" && process.platform === "win32") {
    throw new Error(
      "Production validation cannot use the local Windows quarantine adapter; deploy the worker on a protected Linux volume or add a hardened object-storage adapter.",
    );
  }
  return {
    workerId: requireWorkerId(options.workerId ?? process.env.PAPERPILOT_VALIDATION_WORKER_ID),
    leaseTtlMs: options.leaseTtlMs ?? DEFAULT_DOCUMENT_VALIDATION_LEASE_TTL_MS,
    validation,
    extractionToolchainDigest,
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
      throw new QuarantineIntegrityError("validation_input_changed");
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
        controller.error(new DOMException("Validation request aborted.", "AbortError"));
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
          throw new QuarantineIntegrityError("validation_input_changed");
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
  code: DocumentValidationServiceErrorCode,
): DocumentValidationExecutionFailureCode {
  switch (code) {
    case "validation_service_timeout":
      return "validation_service_timeout";
    case "validation_service_signatures_stale":
    case "validation_service_clock_invalid":
      return "validation_attestation_stale";
    case "validation_stream_unavailable":
      return "validation_object_missing";
    case "validation_service_content_mismatch":
      return "validation_input_changed";
    case "validation_service_unavailable":
    case "validation_request_aborted":
      return "validation_service_unavailable";
    case "validation_request_invalid":
    case "validation_service_configuration_error":
    case "validation_service_redirected":
    case "validation_service_endpoint_mismatch":
    case "validation_service_response_too_large":
    case "validation_service_invalid_response":
    case "validation_service_storage_mismatch":
    case "validation_service_policy_mismatch":
      return "validation_response_invalid";
  }
}

function failureFromUnknown(error: unknown): {
  code: DocumentValidationExecutionFailureCode;
  retryable: boolean;
} {
  if (error instanceof DocumentValidationServiceError) {
    return {
      code: executionFailureForServiceError(error.code),
      retryable: error.retryable,
    };
  }
  if (error instanceof QuarantineIntegrityError) {
    return { code: error.code, retryable: false };
  }
  if (error instanceof WorkerLeaseAbortError) {
    return { code: "validation_service_unavailable", retryable: true };
  }
  if (error instanceof HttpProblem) {
    if (error.code === "quarantine_object_changed") {
      return { code: "validation_input_changed", retryable: false };
    }
    if (error.code === "quarantine_object_missing") {
      return { code: "validation_object_missing", retryable: false };
    }
  }
  return { code: "validation_worker_internal", retryable: true };
}

async function validateOpenQuarantineObject(input: {
  lease: DocumentValidationLease;
  configuration: Pick<UploadConfiguration, "quarantineRoot">;
  validationConfiguration: DocumentValidationServiceConfiguration;
  clientDependencies?: DocumentValidationClientDependencies;
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
        throw new QuarantineIntegrityError("validation_input_changed");
      }
      const actualSha256 = await hashOpenFile(
        handle,
        input.lease.inputSizeBytes,
        input.signal,
      );
      if (actualSha256 !== input.lease.inputSha256) {
        throw new QuarantineIntegrityError("validation_input_changed");
      }
      let bodyCreated = false;
      return requestExternalDocumentValidation(
        {
          expectedSha256: input.lease.inputSha256,
          expectedSizeBytes: input.lease.inputSizeBytes,
          expectedStorageVersion: input.lease.storageVersion,
          bodyFactory: (signal) => {
            if (bodyCreated) {
              throw new QuarantineIntegrityError("validation_input_changed");
            }
            bodyCreated = true;
            return streamOpenFile(handle, input.lease.inputSizeBytes, signal);
          },
          signal: input.signal,
        },
        input.validationConfiguration,
        input.clientDependencies,
      );
    },
    input.lease.storageAuthorityGeneration,
  );
}

async function withLeaseHeartbeat<T>(input: {
  lease: DocumentValidationLease;
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
    heartbeatTask = heartbeatDocumentValidationLease({
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

export async function runDocumentValidationWorkerOnce(
  options: DocumentValidationWorkerOptions = {},
): Promise<DocumentValidationWorkerOnceResult> {
  // All external-service and storage configuration is validated before a job
  // is claimed, so a broken deployment never burns the attempt budget.
  const configuration = requireWorkerConfiguration(options);
  try {
    await probeExternalDocumentValidationReadiness(
      configuration.validation,
      options.clientDependencies,
      options.signal,
    );
  } catch (error) {
    if (error instanceof DocumentValidationServiceError && error.retryable) {
      return { kind: "service-unavailable" };
    }
    throw error;
  }
  const lease = await claimNextDocumentValidationJob({
    workerId: configuration.workerId,
    leaseTtlMs: configuration.leaseTtlMs,
  });
  if (!lease) return { kind: "idle" };
  const controller = new AbortController();
  try {
    const attestation = await withLeaseHeartbeat({
      lease,
      leaseTtlMs: configuration.leaseTtlMs,
      controller,
      operation: () => validateOpenQuarantineObject({
        lease,
        configuration: configuration.upload,
        validationConfiguration: configuration.validation,
        clientDependencies: options.clientDependencies,
        signal: controller.signal,
      }),
    });
    const completion = await completeDocumentValidationLease({
      lease,
      attestation: {
        ...attestation,
        result: { ...attestation.result },
      },
      extractionToolchainDigest: configuration.extractionToolchainDigest,
    });
    if (!completion) return { kind: "lease-lost", jobId: lease.jobId };
    return {
      kind: completion.verdict === "ACCEPTED" ? "accepted" : "rejected",
      jobId: lease.jobId,
      outcome: completion.outcome,
    };
  } catch (error) {
    const failure = failureFromUnknown(error);
    const outcome = await failDocumentValidationLease({
      lease,
      code: failure.code,
      retryable: failure.retryable,
    });
    return { kind: outcome, jobId: lease.jobId };
  } finally {
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

export async function runDocumentValidationWorkerLoop(
  options: DocumentValidationWorkerOptions = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const configuration = requireWorkerConfiguration(options);
  let lastReconciledAt = 0;
  while (!signal.aborted) {
    const now = Date.now();
    if (now - lastReconciledAt >= DEFAULT_RECONCILE_INTERVAL_MS) {
      await reconcileUploadIntake({ configuration: configuration.upload });
      lastReconciledAt = now;
    }
    const result = await runDocumentValidationWorkerOnce({
      ...options,
      workerId: configuration.workerId,
      leaseTtlMs: configuration.leaseTtlMs,
      validationConfiguration: configuration.validation,
      extractionExpectedToolchainDigest: configuration.extractionToolchainDigest,
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
    await runDocumentValidationWorkerLoop({}, controller.signal);
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
    const message = error instanceof Error ? error.message : "Validation worker failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
