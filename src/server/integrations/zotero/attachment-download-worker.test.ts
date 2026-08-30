import assert from "node:assert/strict";
import test from "node:test";

import type { UploadConfiguration } from "@/server/uploads/config";
import type { ZoteroAttachmentDownloadLease } from "./attachment-download-jobs";
import { ZoteroAdapterError } from "./errors";

process.env.DATABASE_URL ??= "postgresql://paperpilot_runtime:unit@127.0.0.1:1/paperpilot_unit?sslmode=disable";

const {
  executeZoteroAttachmentDownload,
  runZoteroAttachmentDownloadWorkerOnce,
} = await import("@/workers/zotero-attachment-download-worker");

const upload: UploadConfiguration = {
  quarantineRoot: "E:\\paperpilot-test-quarantine",
  maxUploadBytes: 1_000_000,
  sessionTtlMs: 15 * 60_000,
  leaseTtlMs: 10 * 60_000,
  streamIdleTimeoutMs: 30_000,
  streamAbsoluteTimeoutMs: 5 * 60_000,
  maxConcurrentUploadsPerUser: 2,
  maxConcurrentUploadsPerWorkspace: 10,
  maxRetainedBytesPerWorkspace: 10_000_000,
};

function lease(): ZoteroAttachmentDownloadLease {
  return {
    organizationId: "workspace-1",
    connectionId: "connection-1",
    zoteroLibraryId: "library-1",
    libraryType: "GROUP",
    externalLibraryId: "456",
    zoteroObjectId: "object-1",
    zoteroItemKey: "ABCDEFGH",
    attachmentImportId: "import-1",
    jobId: "job-1",
    jobAttemptId: "job-attempt-1",
    ingressAttemptId: "ingress-1",
    attemptNumber: 1,
    workerId: "worker-1",
    leaseId: "lease-1",
    leaseExpiresAt: new Date("2026-08-29T12:10:00.000Z"),
    intakeId: "intake-1",
    documentId: "document-1",
    assetId: "asset-1",
    inboxEntryId: "inbox-1",
    importBatchId: "batch-1",
    requestedById: "user-1",
    policyRevision: 2,
    credentialGeneration: 4,
    credentialFingerprint: "hmac-sha256:fingerprint",
    credentialKeyVersion: "v1",
    credentialExpiresAt: null,
    sourceVersion: "9",
    sourceMetadataHash: "a".repeat(64),
    providerMd5: "b".repeat(32),
    originalFileName: "paper.pdf",
    maximumBytes: 1_000_000,
    storageVersion: "local-quarantine-v2",
    storageKey: `local-quarantine-v2:${"1".repeat(64)}:${"2".repeat(64)}:${"3".repeat(64)}`,
  };
}

function verifiedDownload(input: {
  md5?: string;
  onCancel?: () => void;
} = {}) {
  const md5 = input.md5 ?? "b".repeat(32);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    },
    cancel() {
      input.onCancel?.();
    },
  });
  return {
    body,
    file: {
      md5,
      sizeBytes: 101,
      compressed: false,
      modificationTimeMilliseconds: "1788004800000",
    },
    contentLength: 101,
    contentType: "application/pdf" as const,
    etagMd5: md5,
    integrity: Promise.resolve({ md5, sizeBytes: 101 }),
    meta: {
      retrievedAt: "2026-08-29T12:00:00.000Z",
      apiStatus: 302 as const,
      blobStatus: 200 as const,
    },
  };
}

test("execution carries the exact lease into provider, quarantine, receipt adoption, and validation enqueue", async () => {
  const currentLease = lease();
  const order: string[] = [];
  const controller = new AbortController();
  const outcome = await executeZoteroAttachmentDownload({
    lease: currentLease,
    adapter: {
      async downloadAttachment(request) {
        order.push("provider");
        assert.deepEqual({
          organizationId: request.organizationId,
          connectionId: request.connectionId,
          library: request.library,
          itemKey: request.itemKey,
          maximumBytes: request.maximumBytes,
        }, {
          organizationId: "workspace-1",
          connectionId: "connection-1",
          library: { kind: "group", id: "456" },
          itemKey: "ABCDEFGH",
          maximumBytes: 1_000_000,
        });
        assert.equal(request.signal, controller.signal);
        return verifiedDownload();
      },
    },
    uploadConfiguration: upload,
    leaseTtlMs: 10 * 60_000,
    controller,
    heartbeat: async () => true,
    streamToQuarantine: async (request) => {
      order.push("quarantine");
      assert.equal(request.organizationId, "workspace-1");
      assert.equal(request.assetId, "asset-1");
      assert.equal(request.attemptId, "ingress-1");
      assert.equal(request.expectedSizeBytes, 101n);
      assert.equal(request.expectedMd5, "b".repeat(32));
      assert.equal(request.signal, controller.signal);
      return {
        storageKey: currentLease.storageKey,
        sizeBytes: 101n,
        sha256: "c".repeat(64),
        md5: "b".repeat(32),
      mimeType: "application/pdf",
      pdfVersion: "1.7",
      storageAuthorityGeneration: "a".repeat(64),
      };
    },
    recordWritten: async (request) => {
      order.push("written");
      assert.equal(request.lease, currentLease);
      assert.equal(request.written.storageKey, currentLease.storageKey);
      assert.equal(request.written.sha256, "c".repeat(64));
      assert.equal(request.written.md5, currentLease.providerMd5);
      return true;
    },
    complete: async (request) => {
      order.push("adopt");
      assert.equal(request.lease, currentLease);
      assert.equal(request.written.sizeBytes, 101n);
      return "applied";
    },
    now: () => new Date("2026-08-29T12:00:01.000Z"),
  });
  assert.equal(outcome, "applied");
  assert.deepEqual(order, ["provider", "quarantine", "written", "adopt"]);
});

test("a provider digest drift is cancelled before storage sees bytes", async () => {
  let cancelled = false;
  let stored = false;
  await assert.rejects(
    executeZoteroAttachmentDownload({
      lease: lease(),
      adapter: {
        async downloadAttachment() {
          return verifiedDownload({
            md5: "d".repeat(32),
            onCancel: () => { cancelled = true; },
          });
        },
      },
      uploadConfiguration: upload,
      leaseTtlMs: 10 * 60_000,
      controller: new AbortController(),
      heartbeat: async () => true,
      streamToQuarantine: async () => {
        stored = true;
        throw new Error("must not run");
      },
    }),
    { name: "ZoteroAttachmentProviderIdentityError" },
  );
  assert.equal(cancelled, true);
  assert.equal(stored, false);
});

test("worker failure remains cleanup-pending until exact cleanup finalizes the target", async () => {
  const events: string[] = [];
  let cleanupCalls = 0;
  const currentLease = lease();
  const result = await runZoteroAttachmentDownloadWorkerOnce({
    workerId: "worker-1",
    leaseTtlMs: 10 * 60_000,
    uploadConfiguration: upload,
    dependencies: {
      async reconcileCleanup(request) {
        cleanupCalls += 1;
        events.push(cleanupCalls === 1 ? "cleanup-scan" : "cleanup-exact");
        if (cleanupCalls === 1) return { outcome: "idle" };
        assert.equal(request.ingressAttemptId, "ingress-1");
        return {
          outcome: "failed",
          jobId: "job-1",
          ingressAttemptId: "ingress-1",
        };
      },
      async claim() {
        events.push("claim");
        return currentLease;
      },
      heartbeat: async () => true,
      recordWritten: async () => {
        throw new Error("unused");
      },
      complete: async () => {
        throw new Error("unused");
      },
      streamToQuarantine: async () => {
        throw new Error("unused");
      },
      createAdapter() {
        return {
          async downloadAttachment() {
            events.push("provider");
            throw new ZoteroAdapterError("provider detail", {
              code: "zotero_not_found",
              status: 404,
              retryable: false,
            });
          },
        };
      },
      async fail(request) {
        events.push("fail-durable");
        assert.deepEqual(request.failure, {
          code: "zotero_not_found",
          retryable: false,
          retryAt: undefined,
          connectionWideBackoff: false,
        });
        return {
          outcome: "cleanup-required",
          ingressAttemptId: "ingress-1",
          terminal: true,
        };
      },
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    },
  });
  assert.deepEqual(result, {
    kind: "failed",
    jobId: "job-1",
    attachmentImportId: "import-1",
  });
  assert.deepEqual(events, [
    "cleanup-scan",
    "claim",
    "provider",
    "fail-durable",
    "cleanup-exact",
  ]);
});

test("an already-aborted worker performs no cleanup scan or durable claim", async () => {
  const controller = new AbortController();
  controller.abort();
  let cleanupCalls = 0;
  let claimCalls = 0;
  const result = await runZoteroAttachmentDownloadWorkerOnce({
    signal: controller.signal,
    uploadConfiguration: upload,
    dependencies: {
      async reconcileCleanup() {
        cleanupCalls += 1;
        return { outcome: "idle" };
      },
      async claim() {
        claimCalls += 1;
        return null;
      },
    },
  });
  assert.deepEqual(result, { kind: "idle" });
  assert.equal(cleanupCalls, 0);
  assert.equal(claimCalls, 0);
});

test("a stop received during cleanup performs no durable claim", async () => {
  const controller = new AbortController();
  let cleanupCalls = 0;
  let claimCalls = 0;
  const result = await runZoteroAttachmentDownloadWorkerOnce({
    signal: controller.signal,
    workerId: "worker-1",
    leaseTtlMs: 10 * 60_000,
    uploadConfiguration: upload,
    dependencies: {
      async reconcileCleanup() {
        cleanupCalls += 1;
        controller.abort();
        return { outcome: "idle" };
      },
      async claim() {
        claimCalls += 1;
        return null;
      },
      createAdapter() {
        return {
          async downloadAttachment() {
            throw new Error("must not execute");
          },
        };
      },
    },
  });
  assert.deepEqual(result, { kind: "idle" });
  assert.equal(cleanupCalls, 1);
  assert.equal(claimCalls, 0);
});
