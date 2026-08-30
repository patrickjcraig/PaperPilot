import "server-only";

import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import type {
  ZoteroCollection,
  ZoteroConditionalResponse,
  ZoteroReadOnlyClient,
  ZoteroResponse,
  ZoteroResponseMeta,
  ZoteroVersion,
  ZoteroVersionManifest,
} from "@/server/integrations/zotero/contracts";
import { ZoteroAdapterError } from "@/server/integrations/zotero/errors";
import {
  chunkZoteroItemKeys,
  normalizeZoteroItemKey,
  toZoteroVersion,
} from "@/server/integrations/zotero/protocol";
import {
  normalizeZoteroItemForSync,
  zoteroContentHash,
  zoteroParentKey,
} from "@/server/integrations/zotero/normalization";
import { createZoteroReadOnlyClient } from "@/server/integrations/zotero/client-factory";
import {
  claimNextZoteroSyncJob,
  completeZoteroSyncLease,
  DEFAULT_ZOTERO_SYNC_LEASE_TTL_MS,
  DEFAULT_ZOTERO_SYNC_CADENCE_MS,
  failZoteroSyncLease,
  heartbeatZoteroSyncLease,
  scheduleDueZoteroSyncs,
  stageZoteroSyncObjects,
  type ZoteroSyncFailureCode,
  type ZoteroSyncLease,
  type ZoteroSyncStageInput,
} from "@/server/integrations/zotero/sync-jobs";

const DEFAULT_IDLE_POLL_MS = 1_000;
const MAX_WORKER_ID_BYTES = 200;
const MAX_CHANGED_OBJECTS_PER_PASS = 10_000;
const MAX_OBJECT_DATA_BYTES_PER_PASS = 64 * 1024 * 1024;

export interface ZoteroSyncWorkerOptions {
  workerId?: string;
  leaseTtlMs?: number;
  client?: ZoteroReadOnlyClient;
  scheduleIntervalMs?: number;
  syncCadenceMs?: number;
  signal?: AbortSignal;
}

export type ZoteroSyncWorkerOnceResult =
  | { kind: "idle" }
  | {
      kind: "succeeded";
      jobId: string;
      runId: string;
      outcome: "applied" | "replayed";
    }
  | {
      kind: "retrying" | "failed" | "dead-letter" | "lease-lost";
      jobId: string;
      runId: string;
    };

export class ZoteroStableVersionChangedError extends Error {
  readonly code = "stable_version_changed" as const;

  constructor() {
    super("The Zotero library changed during the synchronization pass.");
    this.name = "ZoteroStableVersionChangedError";
  }
}

export class ZoteroProviderPauseError extends Error {
  readonly code: ZoteroSyncFailureCode;

  constructor(
    readonly retryAt: Date,
    readonly connectionWide: boolean,
    code: Extract<
      ZoteroSyncFailureCode,
      "zotero_rate_limited" | "zotero_unavailable"
    >,
  ) {
    super("Zotero requested that synchronization pause.");
    this.name = "ZoteroProviderPauseError";
    this.code = code;
  }
}

class ZoteroLeaseLostError extends Error {
  constructor() {
    super("The Zotero synchronization lease was lost.");
    this.name = "ZoteroLeaseLostError";
  }
}

class ZoteroPassResponseError extends Error {
  readonly code = "zotero_bad_response" as const;

  constructor() {
    super("Zotero returned an inconsistent synchronization response.");
    this.name = "ZoteroPassResponseError";
  }
}

export class ZoteroPassResourceLimitError extends Error {
  readonly code = "zotero_sync_resource_limit" as const;

  constructor() {
    super("The Zotero synchronization pass exceeded its safe admission limit.");
    this.name = "ZoteroPassResourceLimitError";
  }
}

interface PassPersistence {
  stage: (
    lease: ZoteroSyncLease,
    stages: readonly ZoteroSyncStageInput[],
  ) => Promise<boolean>;
  complete: (
    lease: ZoteroSyncLease,
    targetVersion: ZoteroVersion,
  ) => Promise<"applied" | "replayed" | "lease-lost">;
}

function defaultWorkerId(): string {
  return (hostname() || "paperpilot") + ":" + process.pid + ":" + randomUUID();
}

function workerId(value: string | undefined): string {
  const normalized = (value ?? defaultWorkerId()).trim();
  if (
    !normalized
    || Buffer.byteLength(normalized, "utf8") > MAX_WORKER_ID_BYTES
    || /[\r\n]/.test(normalized)
  ) throw new Error("PAPERPILOT_ZOTERO_WORKER_ID is invalid.");
  return normalized;
}

function retryDate(meta: ZoteroResponseMeta): {
  retryAt: Date;
  connectionWide: boolean;
  code: "zotero_rate_limited" | "zotero_unavailable";
} | null {
  const backoff = meta.backoffSeconds;
  const retryAfter = meta.retryAfterSeconds;
  if (
    (backoff === undefined || backoff <= 0)
    && (retryAfter === undefined || retryAfter <= 0)
  ) return null;
  const retrieved = Date.parse(meta.retrievedAt);
  if (!Number.isFinite(retrieved)) throw new ZoteroPassResponseError();
  const seconds = Math.max(backoff ?? 0, retryAfter ?? 0);
  const parsedRetryAt = meta.retryAt ? Date.parse(meta.retryAt) : Number.NaN;
  const retryAt = Number.isFinite(parsedRetryAt)
    ? new Date(Math.max(parsedRetryAt, retrieved + seconds * 1_000))
    : new Date(retrieved + seconds * 1_000);
  return {
    retryAt,
    connectionWide: backoff !== undefined && backoff > 0,
    code: retryAfter !== undefined && retryAfter > 0
      ? "zotero_rate_limited"
      : "zotero_unavailable",
  };
}

function observeVersion(
  meta: ZoteroResponseMeta,
  observed: ZoteroVersion | undefined,
): ZoteroVersion {
  if (!meta.libraryVersion) throw new ZoteroPassResponseError();
  const version = toZoteroVersion(meta.libraryVersion);
  const pause = retryDate(meta);
  if (pause) {
    throw new ZoteroProviderPauseError(
      pause.retryAt,
      pause.connectionWide,
      pause.code,
    );
  }
  if (observed !== undefined && observed !== version) {
    throw new ZoteroStableVersionChangedError();
  }
  return version;
}

function conditionalData<T>(
  response: ZoteroConditionalResponse<T>,
  empty: T,
): T {
  return response.outcome === "not_modified" ? empty : response.data;
}

function verifyBatch<T extends { key: string; version: ZoteroVersion }>(
  response: ZoteroResponse<T[]>,
  requestedKeys: readonly string[],
  manifest: ZoteroVersionManifest,
): void {
  const requested = new Set(requestedKeys);
  if (
    response.data.length !== requested.size
    || response.data.some((object) =>
      !requested.has(object.key)
      || manifest[object.key] !== object.version
    )
    || new Set(response.data.map((object) => object.key)).size !== response.data.length
  ) throw new ZoteroPassResponseError();
}

function normalizeCollectionForStage(
  collection: ZoteroCollection,
): ZoteroSyncStageInput {
  const parentKey = zoteroParentKey({
    parentItem: collection.data.parentCollection,
  });
  return {
    objectType: "COLLECTION",
    zoteroKey: normalizeZoteroItemKey(collection.key),
    parentKey,
    version: collection.version,
    isDeleted: false,
    data: collection.data,
    contentHash: zoteroContentHash(collection.data),
  };
}

function admitObjectDataBytes(current: number, values: readonly unknown[]): number {
  let total = current;
  for (const value of values) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new ZoteroPassResponseError();
    total += Buffer.byteLength(serialized, "utf8");
    if (total > MAX_OBJECT_DATA_BYTES_PER_PASS) {
      throw new ZoteroPassResourceLimitError();
    }
  }
  return total;
}

export async function runZoteroMetadataPass(
  client: ZoteroReadOnlyClient,
  lease: ZoteroSyncLease,
  persistence: PassPersistence = {
    stage: (currentLease, stages) =>
      stageZoteroSyncObjects({ lease: currentLease, stages }),
    complete: (currentLease, targetVersion) =>
      completeZoteroSyncLease({ lease: currentLease, targetVersion }),
  },
): Promise<"applied" | "replayed"> {
  const connection = {
    organizationId: lease.organizationId,
    connectionId: lease.connectionId,
  };
  const library = {
    kind: lease.libraryType === "USER" ? "user" as const : "group" as const,
    id: lease.externalLibraryId,
  };
  const versionRequest = {
    ...connection,
    library,
    sinceVersion: lease.fromVersion,
    ifModifiedSinceVersion: lease.fromVersion,
  };
  let observed: ZoteroVersion | undefined;

  const itemManifestResponse = await client.listLibraryItemVersions(
    versionRequest,
  );
  observed = observeVersion(itemManifestResponse.meta, observed);
  const itemManifest = conditionalData(itemManifestResponse, {});

  const collectionManifestResponse =
    await client.listLibraryCollectionVersions(versionRequest);
  observed = observeVersion(collectionManifestResponse.meta, observed);
  const collectionManifest = conditionalData(collectionManifestResponse, {});
  const itemKeys = Object.keys(itemManifest);
  const collectionKeys = Object.keys(collectionManifest);
  let admittedObjectCount = itemKeys.length + collectionKeys.length;
  let admittedObjectDataBytes = 0;
  if (admittedObjectCount > MAX_CHANGED_OBJECTS_PER_PASS) {
    throw new ZoteroPassResourceLimitError();
  }

  for (const keys of chunkZoteroItemKeys(itemKeys)) {
    const response = await client.getLibraryItemsByKeys({
      ...connection,
      library,
      itemKeys: keys,
    });
    observed = observeVersion(response.meta, observed);
    verifyBatch(response, keys, itemManifest);
    admittedObjectDataBytes = admitObjectDataBytes(
      admittedObjectDataBytes,
      response.data,
    );
    const stages = response.data.map((item) => {
      const normalized = normalizeZoteroItemForSync({
        item,
        library,
        retrievedAt: response.meta.retrievedAt,
      });
      return {
        objectType: "ITEM" as const,
        zoteroKey: normalized.key,
        parentKey: normalized.parentKey,
        version: normalized.version,
        isDeleted: false,
        data: normalized.data,
        contentHash: normalized.contentHash,
      };
    });
    if (!await persistence.stage(lease, stages)) {
      throw new ZoteroLeaseLostError();
    }
  }

  for (const keys of chunkZoteroItemKeys(collectionKeys)) {
    const response = await client.getLibraryCollectionsByKeys({
      ...connection,
      library,
      collectionKeys: keys,
    });
    observed = observeVersion(response.meta, observed);
    verifyBatch(response, keys, collectionManifest);
    admittedObjectDataBytes = admitObjectDataBytes(
      admittedObjectDataBytes,
      response.data,
    );
    if (!await persistence.stage(
      lease,
      response.data.map(normalizeCollectionForStage),
    )) throw new ZoteroLeaseLostError();
  }

  const deletedResponse = await client.getLibraryDeletions(versionRequest);
  observed = observeVersion(deletedResponse.meta, observed);
  const deleted = conditionalData(deletedResponse, {
    collections: [],
    items: [],
    searches: [],
    tags: [],
  });
  const changedItemKeys = new Set(Object.keys(itemManifest));
  const changedCollectionKeys = new Set(Object.keys(collectionManifest));
  if (
    deleted.items.some((key) => changedItemKeys.has(key))
    || deleted.collections.some((key) => changedCollectionKeys.has(key))
  ) throw new ZoteroPassResponseError();

  const tombstones: ZoteroSyncStageInput[] = [
    ...deleted.items.map((key) => ({
      objectType: "ITEM" as const,
      zoteroKey: key,
      version: observed!,
      isDeleted: true,
    })),
    ...deleted.collections.map((key) => ({
      objectType: "COLLECTION" as const,
      zoteroKey: key,
      version: observed!,
      isDeleted: true,
    })),
  ];
  admittedObjectCount += tombstones.length;
  if (admittedObjectCount > MAX_CHANGED_OBJECTS_PER_PASS) {
    throw new ZoteroPassResourceLimitError();
  }
  for (let index = 0; index < tombstones.length; index += 50) {
    if (!await persistence.stage(lease, tombstones.slice(index, index + 50))) {
      throw new ZoteroLeaseLostError();
    }
  }
  if (!observed) throw new ZoteroPassResponseError();
  const completed = await persistence.complete(lease, observed);
  if (completed === "lease-lost") throw new ZoteroLeaseLostError();
  return completed;
}

async function withLeaseHeartbeat<T>(input: {
  lease: ZoteroSyncLease;
  leaseTtlMs: number;
  operation: () => Promise<T>;
}): Promise<T> {
  const intervalMs = Math.max(
    5_000,
    Math.min(30_000, Math.floor(input.leaseTtlMs / 3)),
  );
  let heartbeatRunning = false;
  let heartbeatTask: Promise<void> = Promise.resolve();
  let leaseLost = false;
  const interval = setInterval(() => {
    if (heartbeatRunning || leaseLost) return;
    heartbeatRunning = true;
    heartbeatTask = heartbeatZoteroSyncLease({
      lease: input.lease,
      leaseTtlMs: input.leaseTtlMs,
    }).then((retained) => {
      if (!retained) leaseLost = true;
    }).catch(() => {
      leaseLost = true;
    }).finally(() => {
      heartbeatRunning = false;
    });
  }, intervalMs);
  interval.unref?.();
  try {
    const result = await input.operation();
    if (leaseLost) throw new ZoteroLeaseLostError();
    return result;
  } finally {
    clearInterval(interval);
    await heartbeatTask.catch(() => undefined);
  }
}

function failure(error: unknown): {
  code: ZoteroSyncFailureCode;
  retryable: boolean;
  retryAt?: Date;
  connectionWideBackoff?: boolean;
} {
  if (error instanceof ZoteroProviderPauseError) {
    return {
      code: error.code,
      retryable: true,
      retryAt: error.retryAt,
      connectionWideBackoff: error.connectionWide,
    };
  }
  if (error instanceof ZoteroStableVersionChangedError) {
    return { code: error.code, retryable: true };
  }
  if (error instanceof ZoteroPassResponseError) {
    return { code: error.code, retryable: true };
  }
  if (error instanceof ZoteroPassResourceLimitError) {
    return { code: error.code, retryable: false };
  }
  if (error instanceof ZoteroAdapterError) {
    if (error.code === "zotero_response_too_large") {
      return {
        code: "zotero_sync_resource_limit",
        retryable: false,
        retryAt: error.retryAt ? new Date(error.retryAt) : undefined,
        connectionWideBackoff:
          error.backoffSeconds !== undefined && error.backoffSeconds > 0,
      };
    }
    const retryAt = error.retryAt
      ? new Date(error.retryAt)
      : error.retryAfterSeconds !== undefined
        ? new Date(Date.now() + error.retryAfterSeconds * 1_000)
        : undefined;
    return {
      code: error.code,
      retryable: error.retryable,
      retryAt,
      connectionWideBackoff:
        error.backoffSeconds !== undefined && error.backoffSeconds > 0,
    };
  }
  return { code: "internal_error", retryable: true };
}

export async function runZoteroSyncWorkerOnce(
  options: ZoteroSyncWorkerOptions = {},
): Promise<ZoteroSyncWorkerOnceResult> {
  const configuredWorkerId = workerId(
    options.workerId ?? process.env.PAPERPILOT_ZOTERO_WORKER_ID,
  );
  const leaseTtlMs = options.leaseTtlMs
    ?? DEFAULT_ZOTERO_SYNC_LEASE_TTL_MS;
  // Validate the credential/keyring boundary before taking a durable lease.
  const client = options.client ?? createZoteroReadOnlyClient();
  const lease = await claimNextZoteroSyncJob({
    workerId: configuredWorkerId,
    leaseTtlMs,
  });
  if (!lease) return { kind: "idle" };
  if (options.signal?.aborted) {
    const result = await failZoteroSyncLease({
      lease,
      code: "internal_error",
      retryable: true,
    });
    return { kind: result, jobId: lease.jobId, runId: lease.runId };
  }

  try {
    const outcome = await withLeaseHeartbeat({
      lease,
      leaseTtlMs,
      operation: () => runZoteroMetadataPass(client, lease),
    });
    return {
      kind: "succeeded",
      jobId: lease.jobId,
      runId: lease.runId,
      outcome,
    };
  } catch (error) {
    if (error instanceof ZoteroLeaseLostError) {
      return { kind: "lease-lost", jobId: lease.jobId, runId: lease.runId };
    }
    let normalized = failure(error);
    if (
      normalized.code === "zotero_forbidden"
      && !normalized.connectionWideBackoff
    ) {
      try {
        const identity = await client.getCurrentIdentity({
          organizationId: lease.organizationId,
          connectionId: lease.connectionId,
        });
        const pause = retryDate(identity.meta);
        if (pause) {
          normalized = {
            code: pause.code,
            retryable: true,
            retryAt: pause.retryAt,
            connectionWideBackoff: pause.connectionWide,
          };
        } else if (identity.data.userId !== lease.externalAccountId) {
          normalized = {
            code: "zotero_authentication_failed",
            retryable: false,
          };
        }
      } catch (identityError) {
        normalized = failure(identityError);
      }
    }
    const result = await failZoteroSyncLease({
      lease,
      ...normalized,
    });
    return { kind: result, jobId: lease.jobId, runId: lease.runId };
  }
}

function waitForNextPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

export async function runZoteroSyncWorker(
  options: ZoteroSyncWorkerOptions = {},
): Promise<void> {
  const scheduleIntervalMs = options.scheduleIntervalMs ?? 60_000;
  const syncCadenceMs = options.syncCadenceMs ?? DEFAULT_ZOTERO_SYNC_CADENCE_MS;
  if (
    !Number.isSafeInteger(scheduleIntervalMs)
    || scheduleIntervalMs < 5_000
    || scheduleIntervalMs > 15 * 60_000
  ) throw new Error("The Zotero scheduler interval is invalid.");
  let nextScheduleAt = 0;
  while (!options.signal?.aborted) {
    if (Date.now() >= nextScheduleAt) {
      await scheduleDueZoteroSyncs({ cadenceMs: syncCadenceMs });
      nextScheduleAt = Date.now() + scheduleIntervalMs;
    }
    const result = await runZoteroSyncWorkerOnce(options);
    if (result.kind === "idle") {
      await waitForNextPoll(DEFAULT_IDLE_POLL_MS, options.signal);
    }
  }
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isEntrypoint) {
  runZoteroSyncWorker().catch(() => {
    process.exitCode = 1;
  });
}
