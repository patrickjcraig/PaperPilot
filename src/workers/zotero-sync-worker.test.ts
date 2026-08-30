import assert from "node:assert/strict";
import test from "node:test";

import type {
  ZoteroReadOnlyClient,
  ZoteroResponseMeta,
  ZoteroVersion,
  ZoteroVersionManifest,
} from "@/server/integrations/zotero/contracts";
import type {
  ZoteroSyncLease,
  ZoteroSyncStageInput,
} from "@/server/integrations/zotero/sync-jobs";
import { toZoteroVersion } from "@/server/integrations/zotero/protocol";
process.env.DATABASE_URL ??= "postgresql://paperpilot_runtime:unit@127.0.0.1:1/paperpilot_unit?sslmode=disable";

const {
  runZoteroMetadataPass,
  ZoteroPassResourceLimitError,
  ZoteroProviderPauseError,
  ZoteroStableVersionChangedError,
} = await import("./zotero-sync-worker");

function meta(
  version: string,
  extra: Partial<ZoteroResponseMeta> = {},
): ZoteroResponseMeta {
  return {
    retrievedAt: "2026-08-28T12:00:00.000Z",
    providerStatus: 200,
    libraryVersion: toZoteroVersion(version),
    ...extra,
  };
}

function lease(): ZoteroSyncLease {
  return {
    organizationId: "workspace-1",
    connectionId: "connection-1",
    externalAccountId: "123",
    connectionUpdatedAt: new Date("2026-08-28T11:59:00.000Z"),
    credentialGeneration: 1,
    credentialFingerprint: "credential-fingerprint-1",
    credentialKeyVersion: "v1",
    zoteroLibraryId: "library-1",
    libraryType: "USER",
    externalLibraryId: "123",
    jobId: "job-1",
    jobAttemptId: "attempt-1",
    runId: "run-1",
    attemptNumber: 1,
    workerId: "worker-1",
    leaseId: "lease-1",
    leaseExpiresAt: new Date("2026-08-28T12:05:00.000Z"),
    fromVersion: toZoteroVersion("2"),
    actorUserId: "user-1",
  };
}

function unusedMethods(): Pick<
  ZoteroReadOnlyClient,
  "getCurrentIdentity" | "listLibraryItems" | "listUserGroups"
> {
  return {
    async getCurrentIdentity() {
      throw new Error("unused");
    },
    async listLibraryItems() {
      throw new Error("unused");
    },
    async listUserGroups() {
      throw new Error("unused");
    },
  };
}

test("a stable pass batches 50 keys, stages bodies and tombstones, then commits one observed version", async () => {
  const itemVersions: Record<string, ZoteroVersion> = {};
  for (let index = 0; index < 51; index += 1) {
    itemVersions["A" + String(index).padStart(7, "0")] = toZoteroVersion("8");
  }
  const collectionVersions: ZoteroVersionManifest = {
    COLL0001: toZoteroVersion("7"),
  };
  const itemBatchSizes: number[] = [];
  const staged: ZoteroSyncStageInput[] = [];
  let completedVersion: ZoteroVersion | undefined;

  const client: ZoteroReadOnlyClient = {
    ...unusedMethods(),
    async listLibraryItemVersions() {
      return { outcome: "data", data: itemVersions, meta: meta("10") };
    },
    async listLibraryCollectionVersions() {
      return { outcome: "data", data: collectionVersions, meta: meta("10") };
    },
    async getLibraryItemsByKeys(request) {
      itemBatchSizes.push(request.itemKeys.length);
      return {
        outcome: "data",
        data: request.itemKeys.map((key) => ({
          key,
          version: itemVersions[key],
          data: {
            itemType: "journalArticle",
            title: "Paper " + key,
          },
        })),
        meta: meta("10"),
      };
    },
    async getLibraryCollectionsByKeys(request) {
      return {
        outcome: "data",
        data: request.collectionKeys.map((key) => ({
          key,
          version: collectionVersions[key],
          data: { key, name: "Collection" },
        })),
        meta: meta("10"),
      };
    },
    async getLibraryDeletions() {
      return {
        outcome: "data",
        data: {
          items: ["DEAD0001"],
          collections: ["DEAD0002"],
          searches: [],
          tags: [],
        },
        meta: meta("10"),
      };
    },
  };

  const result = await runZoteroMetadataPass(client, lease(), {
    async stage(_lease, values) {
      staged.push(...values);
      return true;
    },
    async complete(_lease, targetVersion) {
      completedVersion = targetVersion;
      return "applied";
    },
  });
  assert.equal(result, "applied");
  assert.deepEqual(itemBatchSizes, [50, 1]);
  assert.equal(staged.filter((entry) => !entry.isDeleted).length, 52);
  assert.equal(staged.filter((entry) => entry.isDeleted).length, 2);
  assert.equal(completedVersion, "10");
});

test("a changed Last-Modified-Version aborts before any cursor commit", async () => {
  let completed = false;
  const client: ZoteroReadOnlyClient = {
    ...unusedMethods(),
    async listLibraryItemVersions() {
      return { outcome: "data", data: {}, meta: meta("10") };
    },
    async listLibraryCollectionVersions() {
      return { outcome: "data", data: {}, meta: meta("11") };
    },
    async getLibraryItemsByKeys() {
      throw new Error("unreachable");
    },
    async getLibraryCollectionsByKeys() {
      throw new Error("unreachable");
    },
    async getLibraryDeletions() {
      throw new Error("unreachable");
    },
  };
  await assert.rejects(
    runZoteroMetadataPass(client, lease(), {
      async stage() {
        return true;
      },
      async complete() {
        completed = true;
        return "applied";
      },
    }),
    ZoteroStableVersionChangedError,
  );
  assert.equal(completed, false);
});

test("a mandatory provider pause wins over a simultaneous version change", async () => {
  const client: ZoteroReadOnlyClient = {
    ...unusedMethods(),
    async listLibraryItemVersions() {
      return { outcome: "data", data: {}, meta: meta("10") };
    },
    async listLibraryCollectionVersions() {
      return {
        outcome: "data",
        data: {},
        meta: meta("11", { backoffSeconds: 45 }),
      };
    },
    async getLibraryItemsByKeys() {
      throw new Error("unreachable");
    },
    async getLibraryCollectionsByKeys() {
      throw new Error("unreachable");
    },
    async getLibraryDeletions() {
      throw new Error("unreachable");
    },
  };
  await assert.rejects(
    runZoteroMetadataPass(client, lease()),
    (error: unknown) => {
      assert.ok(error instanceof ZoteroProviderPauseError);
      assert.equal(error.retryAt.toISOString(), "2026-08-28T12:00:45.000Z");
      return true;
    },
  );
});

test("Backoff on a successful response stops the pass and retains an exact provider deadline", async () => {
  let secondCall = false;
  const client: ZoteroReadOnlyClient = {
    ...unusedMethods(),
    async listLibraryItemVersions() {
      return {
        outcome: "data",
        data: {},
        meta: meta("10", { backoffSeconds: 30 }),
      };
    },
    async listLibraryCollectionVersions() {
      secondCall = true;
      throw new Error("unreachable");
    },
    async getLibraryItemsByKeys() {
      throw new Error("unreachable");
    },
    async getLibraryCollectionsByKeys() {
      throw new Error("unreachable");
    },
    async getLibraryDeletions() {
      throw new Error("unreachable");
    },
  };
  await assert.rejects(
    runZoteroMetadataPass(client, lease(), {
      async stage() {
        return true;
      },
      async complete() {
        return "applied";
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ZoteroProviderPauseError);
      assert.equal(error.connectionWide, true);
      assert.equal(error.retryAt.toISOString(), "2026-08-28T12:00:30.000Z");
      return true;
    },
  );
  assert.equal(secondCall, false);
});

test("an oversized changed-object manifest stops before body downloads", async () => {
  const manifest: Record<string, ZoteroVersion> = {};
  for (let index = 0; index < 10_001; index += 1) {
    manifest["K" + String(index).padStart(7, "0")] = toZoteroVersion("10");
  }
  let bodyRequested = false;
  const client: ZoteroReadOnlyClient = {
    ...unusedMethods(),
    async listLibraryItemVersions() {
      return { outcome: "data", data: manifest, meta: meta("10") };
    },
    async listLibraryCollectionVersions() {
      return { outcome: "data", data: {}, meta: meta("10") };
    },
    async getLibraryItemsByKeys() {
      bodyRequested = true;
      throw new Error("unreachable");
    },
    async getLibraryCollectionsByKeys() {
      throw new Error("unreachable");
    },
    async getLibraryDeletions() {
      throw new Error("unreachable");
    },
  };
  await assert.rejects(
    runZoteroMetadataPass(client, lease()),
    ZoteroPassResourceLimitError,
  );
  assert.equal(bodyRequested, false);
});

test("missing or version-mismatched batch bodies fail closed", async () => {
  const client: ZoteroReadOnlyClient = {
    ...unusedMethods(),
    async listLibraryItemVersions() {
      return {
        outcome: "data",
        data: { ABC12345: toZoteroVersion("9") },
        meta: meta("10"),
      };
    },
    async listLibraryCollectionVersions() {
      return { outcome: "not_modified", data: null, meta: {
        ...meta("10"),
        providerStatus: 304,
      } };
    },
    async getLibraryItemsByKeys() {
      return { outcome: "data", data: [], meta: meta("10") };
    },
    async getLibraryCollectionsByKeys() {
      throw new Error("unreachable");
    },
    async getLibraryDeletions() {
      throw new Error("unreachable");
    },
  };
  await assert.rejects(
    runZoteroMetadataPass(client, lease(), {
      async stage() {
        return true;
      },
      async complete() {
        return "applied";
      },
    }),
    (error: unknown) =>
      error instanceof Error && error.name === "ZoteroPassResponseError",
  );
});
