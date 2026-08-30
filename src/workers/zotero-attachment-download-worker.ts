import "server-only";

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

import type { PrismaClient } from "@/generated/prisma/client";
import type { CredentialProtector } from "@/server/integrations/credential-protection";
import {
  claimNextZoteroAttachmentDownloadJob,
  completeZoteroAttachmentDownloadLease,
  createFencedZoteroAttachmentBinaryAdapter,
  DEFAULT_ZOTERO_ATTACHMENT_DOWNLOAD_LEASE_TTL_MS,
  failZoteroAttachmentDownloadLease,
  heartbeatZoteroAttachmentDownloadLease,
  reconcileZoteroAttachmentDownloadCleanup,
  recordWrittenZoteroAttachmentDownload,
  writtenDownloadFromStorage,
  zoteroAttachmentBlobAllowlistFromEnvironment,
  zoteroAttachmentDownloadFailureFromUnknown,
  type WrittenZoteroAttachmentDownload,
  type ZoteroAttachmentDownloadFailure,
  type ZoteroAttachmentDownloadLease,
} from "@/server/integrations/zotero/attachment-download-jobs";
import type {
  ZoteroAttachmentBinaryAdapter,
  ZoteroAttachmentBinaryDownload,
  ZoteroAttachmentBlobAllowlistEntry,
} from "@/server/integrations/zotero/attachment-binary-adapter";
import {
  credentialProtectorFromEnvironment,
} from "@/server/integrations/credential-protection";
import {
  uploadConfigurationFromEnvironment,
  type UploadConfiguration,
} from "@/server/uploads/config";
import {
  streamAuthorizedPdfToLocalQuarantine,
  type LocalQuarantineUploadResult,
} from "@/server/uploads/storage";

const DEFAULT_IDLE_POLL_MS = 1_000;
const MAX_WORKER_ID_BYTES = 200;

interface AttachmentBinaryClient {
  downloadAttachment(
    request: Parameters<ZoteroAttachmentBinaryAdapter["downloadAttachment"]>[0],
  ): Promise<ZoteroAttachmentBinaryDownload>;
}

export interface ZoteroAttachmentDownloadWorkerDependencies {
  reconcileCleanup: typeof reconcileZoteroAttachmentDownloadCleanup;
  claim: typeof claimNextZoteroAttachmentDownloadJob;
  heartbeat: typeof heartbeatZoteroAttachmentDownloadLease;
  recordWritten: typeof recordWrittenZoteroAttachmentDownload;
  complete: typeof completeZoteroAttachmentDownloadLease;
  fail: typeof failZoteroAttachmentDownloadLease;
  streamToQuarantine: typeof streamAuthorizedPdfToLocalQuarantine;
  createAdapter: (lease: ZoteroAttachmentDownloadLease) => AttachmentBinaryClient;
  now: () => Date;
}

export interface ZoteroAttachmentDownloadWorkerOptions {
  workerId?: string;
  leaseTtlMs?: number;
  uploadConfiguration?: UploadConfiguration;
  blobAllowlist?: readonly ZoteroAttachmentBlobAllowlistEntry[];
  credentialProtector?: CredentialProtector;
  database?: PrismaClient;
  environment?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  adapterTimeoutMs?: number;
  dependencies?: Partial<ZoteroAttachmentDownloadWorkerDependencies>;
  signal?: AbortSignal;
}

export type ZoteroAttachmentDownloadWorkerOnceResult =
  | { kind: "idle" }
  | { kind: "cleanup-retrying"; jobId: string }
  | { kind: "cleaned"; jobId: string }
  | { kind: "cleanup-failed" | "cleanup-dead-letter"; jobId: string }
  | {
      kind: "succeeded";
      jobId: string;
      attachmentImportId: string;
      outcome: "applied" | "replayed";
    }
  | {
      kind: "retrying" | "failed" | "dead-letter" | "lease-lost";
      jobId: string;
      attachmentImportId: string;
    };

class ZoteroAttachmentDownloadLeaseLostError extends Error {
  constructor() {
    super("The Zotero attachment download lease was lost.");
    this.name = "ZoteroAttachmentDownloadLeaseLostError";
  }
}

class ZoteroAttachmentProviderIdentityError extends Error {
  constructor() {
    super("The Zotero attachment no longer matches the admitted source identity.");
    this.name = "ZoteroAttachmentProviderIdentityError";
  }
}

function defaultWorkerId(): string {
  return `${hostname() || "paperpilot"}:${process.pid}:${randomUUID()}`;
}

function normalizedWorkerId(value: string | undefined): string {
  const normalized = (value ?? defaultWorkerId()).trim();
  if (
    !normalized
    || Buffer.byteLength(normalized, "utf8") > MAX_WORKER_ID_BYTES
    || /[\r\n]/.test(normalized)
  ) throw new Error("PAPERPILOT_ZOTERO_ATTACHMENT_WORKER_ID is invalid.");
  return normalized;
}

function linkedAbortController(signal: AbortSignal | undefined): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return {
    controller,
    dispose: () => signal?.removeEventListener("abort", abort),
  };
}

async function cancelDownload(download: ZoteroAttachmentBinaryDownload): Promise<void> {
  await download.body.cancel().catch(() => undefined);
  await download.integrity.catch(() => undefined);
}

function assertProviderIdentity(
  lease: ZoteroAttachmentDownloadLease,
  download: ZoteroAttachmentBinaryDownload,
): void {
  if (
    download.contentType !== "application/pdf"
    || download.file.compressed
    || download.file.md5 !== lease.providerMd5
    || download.file.sizeBytes < 1
    || download.file.sizeBytes > lease.maximumBytes
    || download.contentLength !== download.file.sizeBytes
    || (download.etagMd5 !== undefined && download.etagMd5 !== lease.providerMd5)
  ) throw new ZoteroAttachmentProviderIdentityError();
}

function assertStreamedIdentity(input: {
  lease: ZoteroAttachmentDownloadLease;
  download: ZoteroAttachmentBinaryDownload;
  result: LocalQuarantineUploadResult;
  integrity: Awaited<ZoteroAttachmentBinaryDownload["integrity"]>;
}): void {
  if (
    input.result.storageKey !== input.lease.storageKey
    || input.result.mimeType !== "application/pdf"
    || input.result.sizeBytes !== BigInt(input.download.file.sizeBytes)
    || input.result.md5 !== input.lease.providerMd5
    || input.integrity.md5 !== input.lease.providerMd5
    || input.integrity.sizeBytes !== input.download.file.sizeBytes
  ) throw new ZoteroAttachmentProviderIdentityError();
}

async function withLeaseHeartbeat<T>(input: {
  lease: ZoteroAttachmentDownloadLease;
  leaseTtlMs: number;
  controller: AbortController;
  heartbeat: typeof heartbeatZoteroAttachmentDownloadLease;
  database?: PrismaClient;
  operation: () => Promise<T>;
}): Promise<T> {
  const intervalMs = Math.max(
    5_000,
    Math.min(30_000, Math.floor(input.leaseTtlMs / 3)),
  );
  let heartbeatRunning = false;
  let heartbeatTask: Promise<void> = Promise.resolve();
  let lost = false;
  const interval = setInterval(() => {
    if (heartbeatRunning || input.controller.signal.aborted) return;
    heartbeatRunning = true;
    heartbeatTask = input.heartbeat({
      lease: input.lease,
      leaseTtlMs: input.leaseTtlMs,
      database: input.database,
    }).then((retained) => {
      if (!retained) {
        lost = true;
        input.controller.abort();
      }
    }).catch(() => {
      lost = true;
      input.controller.abort();
    }).finally(() => {
      heartbeatRunning = false;
    });
  }, intervalMs);
  interval.unref?.();
  try {
    const result = await input.operation();
    if (lost) throw new ZoteroAttachmentDownloadLeaseLostError();
    return result;
  } finally {
    clearInterval(interval);
    await heartbeatTask.catch(() => undefined);
  }
}

export async function executeZoteroAttachmentDownload(input: {
  lease: ZoteroAttachmentDownloadLease;
  adapter: AttachmentBinaryClient;
  uploadConfiguration: UploadConfiguration;
  leaseTtlMs: number;
  controller: AbortController;
  database?: PrismaClient;
  heartbeat?: typeof heartbeatZoteroAttachmentDownloadLease;
  recordWritten?: typeof recordWrittenZoteroAttachmentDownload;
  complete?: typeof completeZoteroAttachmentDownloadLease;
  streamToQuarantine?: typeof streamAuthorizedPdfToLocalQuarantine;
  now?: () => Date;
}): Promise<"applied" | "replayed"> {
  const heartbeat = input.heartbeat ?? heartbeatZoteroAttachmentDownloadLease;
  const recordWritten = input.recordWritten ?? recordWrittenZoteroAttachmentDownload;
  const complete = input.complete ?? completeZoteroAttachmentDownloadLease;
  const streamToQuarantine = input.streamToQuarantine
    ?? streamAuthorizedPdfToLocalQuarantine;
  const now = input.now ?? (() => new Date());
  return withLeaseHeartbeat({
    lease: input.lease,
    leaseTtlMs: input.leaseTtlMs,
    controller: input.controller,
    heartbeat,
    database: input.database,
    operation: async () => {
      const download = await input.adapter.downloadAttachment({
        organizationId: input.lease.organizationId,
        connectionId: input.lease.connectionId,
        library: {
          kind: input.lease.libraryType === "USER" ? "user" : "group",
          id: input.lease.externalLibraryId,
        },
        itemKey: input.lease.zoteroItemKey,
        maximumBytes: input.lease.maximumBytes,
        signal: input.controller.signal,
      });
      try {
        assertProviderIdentity(input.lease, download);
      } catch (error) {
        await cancelDownload(download);
        throw error;
      }
      const storageResult = await streamToQuarantine({
        body: download.body,
        configuration: input.uploadConfiguration,
        organizationId: input.lease.organizationId,
        assetId: input.lease.assetId,
        attemptId: input.lease.ingressAttemptId,
        expectedSizeBytes: BigInt(download.file.sizeBytes),
        expectedMd5: input.lease.providerMd5,
        signal: input.controller.signal,
      });
      const integrity = await download.integrity;
      assertStreamedIdentity({
        lease: input.lease,
        download,
        result: storageResult,
        integrity,
      });
      const written: WrittenZoteroAttachmentDownload = writtenDownloadFromStorage(
        storageResult,
        now(),
      );
      const recorded = await recordWritten({
        lease: input.lease,
        written,
        database: input.database,
      });
      if (!recorded) throw new ZoteroAttachmentDownloadLeaseLostError();
      const completion = await complete({
        lease: input.lease,
        written,
        database: input.database,
      });
      if (completion === "lease-lost") {
        throw new ZoteroAttachmentDownloadLeaseLostError();
      }
      return completion;
    },
  });
}

function workerDependencies(input: {
  options: ZoteroAttachmentDownloadWorkerOptions;
  upload: UploadConfiguration;
  allowlist?: readonly ZoteroAttachmentBlobAllowlistEntry[];
  protector?: CredentialProtector;
}): ZoteroAttachmentDownloadWorkerDependencies {
  const supplied = input.options.dependencies;
  return {
    reconcileCleanup: supplied?.reconcileCleanup
      ?? reconcileZoteroAttachmentDownloadCleanup,
    claim: supplied?.claim ?? claimNextZoteroAttachmentDownloadJob,
    heartbeat: supplied?.heartbeat ?? heartbeatZoteroAttachmentDownloadLease,
    recordWritten: supplied?.recordWritten
      ?? recordWrittenZoteroAttachmentDownload,
    complete: supplied?.complete ?? completeZoteroAttachmentDownloadLease,
    fail: supplied?.fail ?? failZoteroAttachmentDownloadLease,
    streamToQuarantine: supplied?.streamToQuarantine
      ?? streamAuthorizedPdfToLocalQuarantine,
    createAdapter: supplied?.createAdapter ?? ((lease) =>
      createFencedZoteroAttachmentBinaryAdapter({
        lease,
        database: input.options.database,
        credentialProtector: input.protector,
        blobAllowlist: input.allowlist,
        environment: input.options.environment,
        fetchImpl: input.options.fetchImpl,
        timeoutMs: input.options.adapterTimeoutMs,
      })),
    now: supplied?.now ?? (() => new Date()),
  };
}

function workerConfiguration(options: ZoteroAttachmentDownloadWorkerOptions): {
  workerId: string;
  leaseTtlMs: number;
  upload: UploadConfiguration;
  allowlist?: readonly ZoteroAttachmentBlobAllowlistEntry[];
  protector?: CredentialProtector;
} {
  const environment = options.environment ?? process.env;
  const upload = options.uploadConfiguration
    ?? uploadConfigurationFromEnvironment(environment);
  const leaseTtlMs = options.leaseTtlMs
    ?? DEFAULT_ZOTERO_ATTACHMENT_DOWNLOAD_LEASE_TTL_MS;
  if (
    !Number.isSafeInteger(leaseTtlMs)
    || leaseTtlMs < 10_000
    || leaseTtlMs > 15 * 60_000
    || upload.streamAbsoluteTimeoutMs >= leaseTtlMs
  ) throw new Error("The Zotero attachment download lease configuration is invalid.");
  const usesDefaultAdapter = options.dependencies?.createAdapter === undefined;
  return {
    workerId: normalizedWorkerId(
      options.workerId ?? environment.PAPERPILOT_ZOTERO_ATTACHMENT_WORKER_ID,
    ),
    leaseTtlMs,
    upload,
    allowlist: usesDefaultAdapter
      ? options.blobAllowlist
        ?? zoteroAttachmentBlobAllowlistFromEnvironment(environment)
      : options.blobAllowlist,
    protector: usesDefaultAdapter
      ? options.credentialProtector
        ?? credentialProtectorFromEnvironment(environment)
      : options.credentialProtector,
  };
}

function failureForWorkerError(
  error: unknown,
  now: Date,
): ZoteroAttachmentDownloadFailure {
  if (error instanceof ZoteroAttachmentProviderIdentityError) {
    return { code: "download_integrity_mismatch", retryable: false };
  }
  if (error instanceof ZoteroAttachmentDownloadLeaseLostError) {
    return { code: "download_authority_stale", retryable: false };
  }
  return zoteroAttachmentDownloadFailureFromUnknown(error, now);
}

export async function runZoteroAttachmentDownloadWorkerOnce(
  options: ZoteroAttachmentDownloadWorkerOptions = {},
): Promise<ZoteroAttachmentDownloadWorkerOnceResult> {
  if (options.signal?.aborted) return { kind: "idle" };
  // Validate private-storage, keyring, and redirect allowlist configuration
  // before taking a durable attempt lease.
  const configuration = workerConfiguration(options);
  const dependencies = workerDependencies({
    options,
    upload: configuration.upload,
    allowlist: configuration.allowlist,
    protector: configuration.protector,
  });
  const cleanup = await dependencies.reconcileCleanup({
    configuration: configuration.upload,
    database: options.database,
  });
  if (cleanup.outcome === "retrying") {
    return { kind: "cleanup-retrying", jobId: cleanup.jobId };
  }
  if (
    cleanup.outcome === "cleaned"
    || cleanup.outcome === "failed"
    || cleanup.outcome === "dead-letter"
  ) {
    return cleanup.outcome === "cleaned"
      ? { kind: "cleaned", jobId: cleanup.jobId }
      : {
        kind: cleanup.outcome === "failed"
          ? "cleanup-failed"
          : "cleanup-dead-letter",
        jobId: cleanup.jobId,
      };
  }
  // Cleanup can involve filesystem I/O. Re-check cancellation immediately
  // before the durable claim so a stopped host never starts new work.
  if (options.signal?.aborted) return { kind: "idle" };
  const lease = await dependencies.claim({
    workerId: configuration.workerId,
    maximumDownloadBytes: configuration.upload.maxUploadBytes,
    leaseTtlMs: configuration.leaseTtlMs,
    database: options.database,
  });
  if (!lease) return { kind: "idle" };
  const linked = linkedAbortController(options.signal);
  try {
    const outcome = await executeZoteroAttachmentDownload({
      lease,
      adapter: dependencies.createAdapter(lease),
      uploadConfiguration: configuration.upload,
      leaseTtlMs: configuration.leaseTtlMs,
      controller: linked.controller,
      database: options.database,
      heartbeat: dependencies.heartbeat,
      recordWritten: dependencies.recordWritten,
      complete: dependencies.complete,
      streamToQuarantine: dependencies.streamToQuarantine,
      now: dependencies.now,
    });
    return {
      kind: "succeeded",
      jobId: lease.jobId,
      attachmentImportId: lease.attachmentImportId,
      outcome,
    };
  } catch (error) {
    const failure = failureForWorkerError(error, dependencies.now());
    const failed = await dependencies.fail({
      lease,
      failure,
      database: options.database,
    });
    if (failed.outcome === "lease-lost") {
      return {
        kind: "lease-lost",
        jobId: lease.jobId,
        attachmentImportId: lease.attachmentImportId,
      };
    }
    const cleaned = await dependencies.reconcileCleanup({
      configuration: configuration.upload,
      ingressAttemptId: failed.ingressAttemptId,
      database: options.database,
    });
    const kind = cleaned.outcome === "failed" || cleaned.outcome === "dead-letter"
      ? cleaned.outcome
      : "retrying";
    return {
      kind,
      jobId: lease.jobId,
      attachmentImportId: lease.attachmentImportId,
    };
  } finally {
    linked.controller.abort();
    linked.dispose();
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

export async function runZoteroAttachmentDownloadWorker(
  options: ZoteroAttachmentDownloadWorkerOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    while (!controller.signal.aborted) {
      const result = await runZoteroAttachmentDownloadWorkerOnce({
        ...options,
        signal: controller.signal,
      });
      if (result.kind === "idle" || result.kind === "cleanup-retrying") {
        await waitForNextPoll(DEFAULT_IDLE_POLL_MS, controller.signal);
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", stop);
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runZoteroAttachmentDownloadWorker({ signal: controller.signal });
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
    const message = error instanceof Error
      ? error.message
      : "Zotero attachment download worker failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
