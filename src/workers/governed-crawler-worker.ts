import "server-only";

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  reconcileCrawlerCustodyDeletion,
} from "@/server/integrations/web-source/crawler-custody-deletion";
import {
  claimNextCrawlerJob,
  cleanupCrawlerJobAttempt,
  completeCrawlerJob,
  crawlerJobFailureFromUnknown,
  crawlerLeaseSupportsConfiguration,
  DEFAULT_CRAWLER_JOB_LEASE_TTL_MS,
  failCrawlerJob,
  heartbeatCrawlerJob,
  markCrawlerIngressWritten,
  reconcileCrawlerJobCleanup,
  writtenCrawlerDownloadFromStorage,
  type CrawlerJobFailure,
  type CrawlerJobLease,
  type WrittenCrawlerDownload,
} from "@/server/integrations/web-source/crawler-jobs";
import {
  crawlerConfigurationFromEnvironment,
  type CrawlerConfiguration,
} from "@/server/integrations/web-source/crawler-config";
import {
  fetchGovernedPdf,
  type GovernedPdfFetchInput,
  type GovernedPdfFetcherDependencies,
  type GovernedPdfFetchResult,
} from "@/server/integrations/web-source/governed-pdf-fetch";
import {
  CrawlerOriginRateLimitError,
  requireCrawlerOriginRequestRate,
  type CrawlerOriginRateAuthority,
} from "@/server/integrations/web-source/crawler-rate-limit";
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
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

type FetchPdf = (
  input: GovernedPdfFetchInput,
  dependencies?: GovernedPdfFetcherDependencies,
) => Promise<GovernedPdfFetchResult>;

type RequireOriginRate = typeof requireCrawlerOriginRequestRate;

export interface GovernedCrawlerWorkerDependencies {
  reconcileCustodyDeletion: typeof reconcileCrawlerCustodyDeletion;
  reconcileCleanup: typeof reconcileCrawlerJobCleanup;
  cleanupAttempt: typeof cleanupCrawlerJobAttempt;
  claim: typeof claimNextCrawlerJob;
  heartbeat: typeof heartbeatCrawlerJob;
  markWritten: typeof markCrawlerIngressWritten;
  complete: typeof completeCrawlerJob;
  fail: typeof failCrawlerJob;
  fetchPdf: FetchPdf;
  streamToQuarantine: typeof streamAuthorizedPdfToLocalQuarantine;
  requireOriginRate: RequireOriginRate;
  now: () => Date;
}

export interface GovernedCrawlerWorkerOptions {
  workerId?: string;
  leaseTtlMs?: number;
  uploadConfiguration?: UploadConfiguration;
  crawlerConfiguration?: Readonly<CrawlerConfiguration>;
  database?: PrismaClient;
  environment?: Readonly<Record<string, string | undefined>>;
  dependencies?: Partial<GovernedCrawlerWorkerDependencies>;
  signal?: AbortSignal;
}

export type GovernedCrawlerWorkerOnceResult =
  | { kind: "idle" }
  | { kind: "custody-deleted"; crawlerImportId: string }
  | { kind: "custody-deletion-retrying"; crawlerImportId: string }
  | { kind: "cleanup-retrying"; jobId: string }
  | { kind: "cleaned"; jobId: string }
  | { kind: "cleanup-failed" | "cleanup-dead-letter"; jobId: string }
  | {
      kind: "succeeded";
      jobId: string;
      crawlerImportId: string;
      outcome: "applied" | "replayed";
    }
  | {
      kind: "retrying" | "failed" | "dead-letter" | "lease-lost";
      jobId: string;
      crawlerImportId: string;
    };

class CrawlerLeaseLostError extends Error {
  constructor() {
    super("The crawler lease was lost.");
    this.name = "CrawlerLeaseLostError";
  }
}

class CrawlerPolicyChangedError extends Error {
  constructor() {
    super("The crawler execution policy is no longer supported.");
    this.name = "CrawlerPolicyChangedError";
  }
}

class CrawlerStreamIdentityError extends Error {
  constructor() {
    super("The crawler stream no longer matches its admitted identity.");
    this.name = "CrawlerStreamIdentityError";
  }
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

function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, milliseconds);
    timer.unref?.();
    const abort = () => {
      finish();
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * One acquisition can require several budgeted connections. A normal limiter
 * denial waits for its exact server-owned retry instant instead of discarding
 * the durable attempt after robots has already consumed the current burst.
 */
export async function waitForCrawlerOriginRequestRate(input: {
  hostname: string;
  authority: CrawlerOriginRateAuthority;
  signal: AbortSignal;
  requireRate?: RequireOriginRate;
  now?: () => Date;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const requireRate = input.requireRate ?? requireCrawlerOriginRequestRate;
  const now = input.now ?? (() => new Date());
  const wait = input.wait ?? waitForDelay;
  while (true) {
    if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      await requireRate({ hostname: input.hostname, authority: input.authority });
      return;
    } catch (caught) {
      if (!(caught instanceof CrawlerOriginRateLimitError)) throw caught;
      const current = now();
      if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
        throw new Error("The crawler rate wait clock is invalid.");
      }
      const retryAt = caught.retryAt;
      if (!(retryAt instanceof Date) || !Number.isFinite(retryAt.getTime())) {
        throw new Error("The crawler rate retry authority is invalid.");
      }
      await wait(Math.max(1, retryAt.getTime() - current.getTime()), input.signal);
    }
  }
}

function defaultWorkerId(prefix: string): string {
  return `${prefix}:${process.pid}:${randomUUID()}`;
}

function normalizedWorkerId(value: string | undefined, prefix: string): string {
  const workerId = (value ?? defaultWorkerId(prefix)).trim();
  if (
    !workerId
    || Buffer.byteLength(workerId, "utf8") > MAX_WORKER_ID_BYTES
    || !WORKER_ID_PATTERN.test(workerId)
  ) throw new Error("PAPERPILOT_CRAWLER_WORKER_ID is invalid.");
  return workerId;
}

function configuredLeaseTtlMs(
  explicit: number | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): number {
  if (explicit !== undefined) return explicit;
  const raw = environment.PAPERPILOT_CRAWLER_JOB_LEASE_TTL_MS;
  if (raw === undefined) return DEFAULT_CRAWLER_JOB_LEASE_TTL_MS;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error("PAPERPILOT_CRAWLER_JOB_LEASE_TTL_MS must be a canonical integer.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error("PAPERPILOT_CRAWLER_JOB_LEASE_TTL_MS is invalid.");
  }
  return value;
}

async function withLeaseHeartbeat<T>(input: {
  lease: CrawlerJobLease;
  leaseTtlMs: number;
  controller: AbortController;
  heartbeat: typeof heartbeatCrawlerJob;
  database?: PrismaClient;
  operation: () => Promise<T>;
}): Promise<T> {
  const intervalMs = Math.max(5_000, Math.min(30_000, Math.floor(input.leaseTtlMs / 3)));
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
    if (lost) throw new CrawlerLeaseLostError();
    return result;
  } finally {
    clearInterval(interval);
    await heartbeatTask.catch(() => undefined);
  }
}

function assertFetchedIdentity(
  lease: CrawlerJobLease,
  fetched: GovernedPdfFetchResult,
): void {
  if (
    fetched.expectedSizeBytes < 1n
    || fetched.expectedSizeBytes > BigInt(lease.maximumBytes)
    || BigInt(fetched.receipt.contentLength) !== fetched.expectedSizeBytes
    || fetched.receipt.contentType !== "application/pdf"
    || fetched.receipt.contentEncoding !== "identity"
    || fetched.receipt.userAgent !== `${lease.fetchPolicy.robotsUserAgent}/1.0`
  ) throw new CrawlerStreamIdentityError();
}

function assertStoredIdentity(
  lease: CrawlerJobLease,
  fetched: GovernedPdfFetchResult,
  stored: LocalQuarantineUploadResult,
): void {
  if (
    stored.storageKey !== lease.storageKey
    || stored.storageAuthorityGeneration !== lease.storageAuthorityGeneration
    || stored.mimeType !== "application/pdf"
    || stored.sizeBytes !== fetched.expectedSizeBytes
  ) throw new CrawlerStreamIdentityError();
}

export async function executeGovernedCrawlerImport(input: {
  lease: CrawlerJobLease;
  uploadConfiguration: UploadConfiguration;
  leaseTtlMs: number;
  controller: AbortController;
  database?: PrismaClient;
  heartbeat?: typeof heartbeatCrawlerJob;
  markWritten?: typeof markCrawlerIngressWritten;
  complete?: typeof completeCrawlerJob;
  fetchPdf?: FetchPdf;
  streamToQuarantine?: typeof streamAuthorizedPdfToLocalQuarantine;
  requireOriginRate?: RequireOriginRate;
  now?: () => Date;
}): Promise<"applied" | "replayed"> {
  const heartbeat = input.heartbeat ?? heartbeatCrawlerJob;
  const markWritten = input.markWritten ?? markCrawlerIngressWritten;
  const complete = input.complete ?? completeCrawlerJob;
  const fetchPdf = input.fetchPdf ?? fetchGovernedPdf;
  const streamToQuarantine = input.streamToQuarantine
    ?? streamAuthorizedPdfToLocalQuarantine;
  const requireOriginRate = input.requireOriginRate ?? requireCrawlerOriginRequestRate;
  const now = input.now ?? (() => new Date());

  return withLeaseHeartbeat({
    lease: input.lease,
    leaseTtlMs: input.leaseTtlMs,
    controller: input.controller,
    heartbeat,
    database: input.database,
    operation: async () => {
      let fetched: GovernedPdfFetchResult | undefined;
      try {
        fetched = await fetchPdf({
          url: input.lease.canonicalSourceUrl,
          policy: input.lease.fetchPolicy,
          signal: input.controller.signal,
        }, {
          beforePinnedRequest: ({ hostname: requestHostname, signal }) =>
            waitForCrawlerOriginRequestRate({
              hostname: requestHostname,
              authority: input.lease.rateAuthority,
              signal,
              requireRate: requireOriginRate,
              now,
            }),
        });
        assertFetchedIdentity(input.lease, fetched);
        const stored = await streamToQuarantine({
          body: fetched.body,
          configuration: input.uploadConfiguration,
          organizationId: input.lease.organizationId,
          assetId: input.lease.assetId,
          attemptId: input.lease.ingressAttemptId,
          expectedSizeBytes: fetched.expectedSizeBytes,
          expectedStorageAuthorityGeneration: input.lease.storageAuthorityGeneration,
          signal: input.controller.signal,
        });
        assertStoredIdentity(input.lease, fetched, stored);
        const written: WrittenCrawlerDownload = writtenCrawlerDownloadFromStorage(
          stored,
          now(),
          fetched.receipt,
        );
        const recorded = await markWritten({
          lease: input.lease,
          written,
          database: input.database,
        });
        if (!recorded) throw new CrawlerLeaseLostError();
        const completion = await complete({
          lease: input.lease,
          written,
          database: input.database,
        });
        if (completion === "lease-lost") throw new CrawlerLeaseLostError();
        return completion;
      } catch (caught) {
        if (fetched && !fetched.body.locked) {
          await fetched.body.cancel("PaperPilot crawler execution stopped").catch(() => undefined);
        }
        throw caught;
      }
    },
  });
}

function workerConfiguration(options: GovernedCrawlerWorkerOptions): {
  workerId: string;
  leaseTtlMs: number;
  upload: UploadConfiguration;
  crawler: Readonly<CrawlerConfiguration>;
} {
  const environment = options.environment ?? process.env;
  const upload = options.uploadConfiguration
    ?? uploadConfigurationFromEnvironment(environment);
  const crawler = options.crawlerConfiguration
    ?? crawlerConfigurationFromEnvironment(upload, environment);
  const leaseTtlMs = configuredLeaseTtlMs(options.leaseTtlMs, environment);
  if (
    !Number.isSafeInteger(leaseTtlMs)
    || leaseTtlMs < 10_000
    || leaseTtlMs > 15 * 60_000
    || upload.streamAbsoluteTimeoutMs >= leaseTtlMs
    || crawler.absoluteDeadlineMs >= leaseTtlMs
  ) throw new Error("The governed crawler worker lease configuration is invalid.");
  return {
    workerId: normalizedWorkerId(
      options.workerId ?? environment.PAPERPILOT_CRAWLER_WORKER_ID,
      crawler.workerIdentity,
    ),
    leaseTtlMs,
    upload,
    crawler,
  };
}

function workerDependencies(
  options: GovernedCrawlerWorkerOptions,
): GovernedCrawlerWorkerDependencies {
  const supplied = options.dependencies;
  return {
    reconcileCustodyDeletion: supplied?.reconcileCustodyDeletion
      ?? reconcileCrawlerCustodyDeletion,
    reconcileCleanup: supplied?.reconcileCleanup ?? reconcileCrawlerJobCleanup,
    cleanupAttempt: supplied?.cleanupAttempt ?? cleanupCrawlerJobAttempt,
    claim: supplied?.claim ?? claimNextCrawlerJob,
    heartbeat: supplied?.heartbeat ?? heartbeatCrawlerJob,
    markWritten: supplied?.markWritten ?? markCrawlerIngressWritten,
    complete: supplied?.complete ?? completeCrawlerJob,
    fail: supplied?.fail ?? failCrawlerJob,
    fetchPdf: supplied?.fetchPdf ?? fetchGovernedPdf,
    streamToQuarantine: supplied?.streamToQuarantine
      ?? streamAuthorizedPdfToLocalQuarantine,
    requireOriginRate: supplied?.requireOriginRate ?? requireCrawlerOriginRequestRate,
    now: supplied?.now ?? (() => new Date()),
  };
}

function failureForWorkerError(
  caught: unknown,
  stopping: boolean,
): CrawlerJobFailure {
  if (caught instanceof CrawlerPolicyChangedError) {
    return { code: "policy_changed", retryable: false };
  }
  if (caught instanceof CrawlerLeaseLostError) {
    return { code: "crawler_lease_expired", retryable: true };
  }
  if (caught instanceof CrawlerStreamIdentityError) {
    return { code: "crawler_integrity_mismatch", retryable: false };
  }
  if (stopping) return { code: "crawler_aborted", retryable: true };
  return crawlerJobFailureFromUnknown(caught);
}

export async function runGovernedCrawlerWorkerOnce(
  options: GovernedCrawlerWorkerOptions = {},
): Promise<GovernedCrawlerWorkerOnceResult> {
  if (options.signal?.aborted) return { kind: "idle" };
  // Parse every deployment and storage control before taking a durable lease.
  const configuration = workerConfiguration(options);
  const dependencies = workerDependencies(options);
  const custodyDeletion = await dependencies.reconcileCustodyDeletion({
    configuration: configuration.upload,
    database: options.database,
  });
  if (custodyDeletion.outcome === "deleted") {
    return {
      kind: "custody-deleted",
      crawlerImportId: custodyDeletion.crawlerImportId,
    };
  }
  if (custodyDeletion.outcome === "retrying") {
    return {
      kind: "custody-deletion-retrying",
      crawlerImportId: custodyDeletion.crawlerImportId,
    };
  }
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
  if (options.signal?.aborted) return { kind: "idle" };
  const lease = await dependencies.claim({
    workerId: configuration.workerId,
    configuration: configuration.upload,
    leaseTtlMs: configuration.leaseTtlMs,
    database: options.database,
  });
  if (!lease) return { kind: "idle" };

  const linked = linkedAbortController(options.signal);
  try {
    if (
      !crawlerLeaseSupportsConfiguration(lease, configuration.crawler)
      || lease.maximumBytes > configuration.upload.maxUploadBytes
    ) throw new CrawlerPolicyChangedError();
    const outcome = await executeGovernedCrawlerImport({
      lease,
      uploadConfiguration: configuration.upload,
      leaseTtlMs: configuration.leaseTtlMs,
      controller: linked.controller,
      database: options.database,
      heartbeat: dependencies.heartbeat,
      markWritten: dependencies.markWritten,
      complete: dependencies.complete,
      fetchPdf: dependencies.fetchPdf,
      streamToQuarantine: dependencies.streamToQuarantine,
      requireOriginRate: dependencies.requireOriginRate,
      now: dependencies.now,
    });
    return {
      kind: "succeeded",
      jobId: lease.jobId,
      crawlerImportId: lease.crawlerImportId,
      outcome,
    };
  } catch (caught) {
    const failure = failureForWorkerError(
      caught,
      options.signal?.aborted === true,
    );
    const failed = await dependencies.fail({
      lease,
      failure,
      database: options.database,
    });
    if (failed.outcome === "lease-lost") {
      return {
        kind: "lease-lost",
        jobId: lease.jobId,
        crawlerImportId: lease.crawlerImportId,
      };
    }
    const cleaned = await dependencies.cleanupAttempt({
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
      crawlerImportId: lease.crawlerImportId,
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

export async function runGovernedCrawlerWorker(
  options: GovernedCrawlerWorkerOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    while (!controller.signal.aborted) {
      const result = await runGovernedCrawlerWorkerOnce({
        ...options,
        signal: controller.signal,
      });
      if (
        result.kind === "idle"
        || result.kind === "cleanup-retrying"
        || result.kind === "custody-deletion-retrying"
      ) {
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
    const arguments_ = process.argv.slice(2);
    if (arguments_.length === 1 && arguments_[0] === "--once") {
      await runGovernedCrawlerWorkerOnce({ signal: controller.signal });
      return;
    }
    if (arguments_.length !== 0) {
      throw new Error("Usage: governed-crawler-worker [--once]");
    }
    await runGovernedCrawlerWorker({ signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  void main().catch((caught) => {
    const message = caught instanceof Error
      ? caught.message
      : "The governed crawler worker failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
