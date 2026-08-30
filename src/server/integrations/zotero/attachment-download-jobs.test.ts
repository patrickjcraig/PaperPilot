import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@/generated/prisma/client";
import type { CredentialProtector } from "@/server/integrations/credential-protection";
import { HttpProblem } from "@/server/http/problem";
import { ZoteroAdapterError } from "./errors";

process.env.DATABASE_URL ??= "postgresql://paperpilot_runtime:unit@127.0.0.1:1/paperpilot_unit?sslmode=disable";

const {
  clampZoteroAttachmentProviderRetryAt,
  createFencedZoteroAttachmentCredentialResolver,
  MAX_ZOTERO_ATTACHMENT_PROVIDER_BACKOFF_MS,
  writtenDownloadFromStorage,
  zoteroAttachmentCredentialFenceWhere,
  zoteroAttachmentBlobAllowlistFromEnvironment,
  zoteroAttachmentDownloadFailureFromUnknown,
  zoteroLibraryFileAccessPermitsDownload,
} = await import("./attachment-download-jobs");
import type { ZoteroAttachmentDownloadLease } from "./attachment-download-jobs";

function lease(
  overrides: Partial<ZoteroAttachmentDownloadLease> = {},
): ZoteroAttachmentDownloadLease {
  return {
    organizationId: "workspace-1",
    connectionId: "connection-1",
    zoteroLibraryId: "library-1",
    libraryType: "USER",
    externalLibraryId: "123",
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
    inboxEntryId: null,
    importBatchId: null,
    requestedById: "user-1",
    policyRevision: 3,
    credentialGeneration: 7,
    credentialFingerprint: "hmac-sha256:fingerprint",
    credentialKeyVersion: "v2",
    credentialExpiresAt: null,
    sourceVersion: "42",
    sourceMetadataHash: "a".repeat(64),
    providerMd5: "b".repeat(32),
    originalFileName: "paper.pdf",
    maximumBytes: 25 * 1024 * 1024,
    storageVersion: "local-quarantine-v2",
    storageKey: `local-quarantine-v2:${"1".repeat(64)}:${"2".repeat(64)}:${"3".repeat(64)}`,
    ...overrides,
  };
}

test("trusted Zotero attachment blob configuration is exact and closed", () => {
  const parsed = zoteroAttachmentBlobAllowlistFromEnvironment({
    PAPERPILOT_ZOTERO_ATTACHMENT_BLOB_ALLOWLIST: JSON.stringify([
      { kind: "exact-origin", origin: "https://files.example.org" },
      {
        kind: "s3-path-style",
        origin: "https://s3.amazonaws.com",
        bucket: "zotero-private-files",
      },
    ]),
  });
  assert.deepEqual(parsed, [
    { kind: "exact-origin", origin: "https://files.example.org" },
    {
      kind: "s3-path-style",
      origin: "https://s3.amazonaws.com",
      bucket: "zotero-private-files",
    },
  ]);

  const invalid: unknown[] = [
    undefined,
    "[]",
    JSON.stringify([{ kind: "exact-origin", origin: "http://files.example.org" }]),
    JSON.stringify([{ kind: "exact-origin", origin: "https://user@files.example.org" }]),
    JSON.stringify([{ kind: "exact-origin", origin: "https://files.example.org/path" }]),
    JSON.stringify([{ kind: "exact-origin", origin: "https://files.example.org?token=x" }]),
    JSON.stringify([{ kind: "exact-origin", origin: "https://localhost" }]),
    JSON.stringify([{ kind: "exact-origin", origin: "https://files.internal" }]),
    JSON.stringify([{ kind: "exact-origin", origin: "https://127.0.0.1" }]),
    JSON.stringify([{ kind: "exact-origin", origin: "https://*.example.org" }]),
    JSON.stringify([{ kind: "exact-origin", origin: "https://files.example.org\n" }]),
    JSON.stringify([{
      kind: "exact-origin",
      origin: "https://files.example.org",
      wildcard: true,
    }]),
    JSON.stringify([{
      kind: "s3-path-style",
      origin: "https://s3.amazonaws.com",
      bucket: "../other",
    }]),
  ];
  for (const raw of invalid) {
    assert.throws(() => zoteroAttachmentBlobAllowlistFromEnvironment({
      PAPERPILOT_ZOTERO_ATTACHMENT_BLOB_ALLOWLIST:
        typeof raw === "string" ? raw : undefined,
    }));
  }
});

test("UNKNOWN file access may probe the exact file endpoint while UNAVAILABLE is denied", () => {
  assert.equal(zoteroLibraryFileAccessPermitsDownload("AVAILABLE"), true);
  assert.equal(zoteroLibraryFileAccessPermitsDownload("UNKNOWN"), true);
  assert.equal(zoteroLibraryFileAccessPermitsDownload("UNAVAILABLE"), false);
});

test("connection-wide backoff is fenced to the leased credential tuple", () => {
  const credentialExpiresAt = new Date("2026-09-01T00:00:00.000Z");
  assert.deepEqual(zoteroAttachmentCredentialFenceWhere(lease({
    credentialExpiresAt,
  })), {
    id: "connection-1",
    organizationId: "workspace-1",
    provider: "ZOTERO",
    status: "CONNECTED",
    credentialGeneration: 7,
    credentialFingerprint: "hmac-sha256:fingerprint",
    credentialKeyVersion: "v2",
    credentialExpiresAt,
  });
});

test("credential resolution is fenced before and after the shared resolver", async () => {
  const current = {
    provider: "ZOTERO",
    status: "CONNECTED",
    credentialGeneration: 7,
    credentialFingerprint: "hmac-sha256:fingerprint",
    credentialKeyVersion: "v2",
    credentialExpiresAt: null,
    credentialCiphertext: new Uint8Array([1, 2, 3]),
  };
  let lookups = 0;
  const integrationConnection = {
    async findUnique() {
      lookups += 1;
      return { ...current };
    },
  };
  const database = {
    integrationConnection,
    async $transaction<T>(operation: (transaction: unknown) => Promise<T>) {
      return operation({
        integrationConnection,
        async $queryRaw() {
          return [{ now: new Date("2026-08-29T12:00:00.000Z") }];
        },
      });
    },
  } as unknown as PrismaClient;
  let reveals = 0;
  const protector = {
    reveal(ciphertext, keyVersion, binding) {
      reveals += 1;
      assert.deepEqual([...ciphertext], [1, 2, 3]);
      assert.equal(keyVersion, "v2");
      assert.deepEqual(binding, {
        organizationId: "workspace-1",
        provider: "ZOTERO",
        subjectId: "connection-1",
      });
      return "secret-token";
    },
    protect() {
      throw new Error("unused");
    },
    fingerprint() {
      throw new Error("unused");
    },
  } satisfies CredentialProtector;
  const resolver = createFencedZoteroAttachmentCredentialResolver({
    lease: lease(),
    database,
    credentialProtector: protector,
    now: () => new Date("2026-08-29T12:00:00.000Z"),
    authorityVerifier: async () => true,
  });
  assert.deepEqual(await resolver({
    organizationId: "workspace-1",
    connectionId: "connection-1",
  }), { accessToken: "secret-token" });
  assert.equal(lookups, 3);
  assert.equal(reveals, 1);
  assert.equal(await resolver({
    organizationId: "workspace-2",
    connectionId: "connection-1",
  }), null);
  assert.equal(lookups, 3);
});

test("a rotation observed after reveal discards the resolved plaintext", async () => {
  let lookups = 0;
  const integrationConnection = {
    async findUnique() {
      lookups += 1;
      return {
        provider: "ZOTERO",
        status: "CONNECTED",
        credentialGeneration: lookups < 3 ? 7 : 8,
        credentialFingerprint: lookups < 3
          ? "hmac-sha256:fingerprint"
          : "hmac-sha256:rotated",
        credentialKeyVersion: "v2",
        credentialExpiresAt: null,
        credentialCiphertext: new Uint8Array([1]),
      };
    },
  };
  const database = {
    integrationConnection,
    async $transaction<T>(operation: (transaction: unknown) => Promise<T>) {
      return operation({
        integrationConnection,
        async $queryRaw() {
          return [{ now: new Date("2026-08-29T12:00:00.000Z") }];
        },
      });
    },
  } as unknown as PrismaClient;
  const protector = {
    reveal: () => "secret-token",
    protect: () => { throw new Error("unused"); },
    fingerprint: () => { throw new Error("unused"); },
  } satisfies CredentialProtector;
  const resolver = createFencedZoteroAttachmentCredentialResolver({
    lease: lease(),
    database,
    credentialProtector: protector,
    authorityVerifier: async () => true,
  });
  assert.equal(await resolver({
    organizationId: "workspace-1",
    connectionId: "connection-1",
  }), null);
  assert.equal(lookups, 3);
});

test("worker-facing failures are bounded and preserve provider backoff", () => {
  const now = new Date("2026-08-29T12:00:00.000Z");
  assert.deepEqual(
    zoteroAttachmentDownloadFailureFromUnknown(
      new ZoteroAdapterError("provider detail must not persist", {
        code: "zotero_rate_limited",
        status: 429,
        retryable: true,
        backoffSeconds: 45,
      }),
      now,
    ),
    {
      code: "zotero_rate_limited",
      retryable: true,
      retryAt: new Date("2026-08-29T12:00:45.000Z"),
      connectionWideBackoff: true,
    },
  );
  assert.deepEqual(
    zoteroAttachmentDownloadFailureFromUnknown(
      new HttpProblem(409, "content_md5_mismatch", "unsafe detail"),
      now,
    ),
    { code: "download_integrity_mismatch", retryable: false },
  );
  assert.deepEqual(
    zoteroAttachmentDownloadFailureFromUnknown(new Error("secret"), now),
    { code: "download_worker_internal", retryable: true },
  );
});

test("provider retry timestamps are clamped to the operational horizon", () => {
  const now = new Date("2026-08-29T12:00:00.000Z");
  const withinHorizon = new Date("2026-08-29T12:30:00.000Z");
  assert.deepEqual(
    clampZoteroAttachmentProviderRetryAt(withinHorizon, now),
    { retryAt: withinHorizon, clamped: false },
  );
  assert.deepEqual(
    clampZoteroAttachmentProviderRetryAt(
      new Date("9999-12-31T23:59:59.000Z"),
      now,
    ),
    {
      retryAt: new Date(
        now.getTime() + MAX_ZOTERO_ATTACHMENT_PROVIDER_BACKOFF_MS,
      ),
      clamped: true,
    },
  );
  assert.deepEqual(
    clampZoteroAttachmentProviderRetryAt(new Date(Number.NaN), now),
    { retryAt: undefined, clamped: true },
  );
  assert.deepEqual(
    clampZoteroAttachmentProviderRetryAt(undefined, now),
    { retryAt: undefined, clamped: false },
  );
});

test("storage results become a path-free written identity", () => {
  const storedAt = new Date("2026-08-29T12:00:00.000Z");
  assert.deepEqual(writtenDownloadFromStorage({
    storageKey: "local-quarantine-v2:opaque",
    sizeBytes: 101n,
    sha256: "c".repeat(64),
    md5: "d".repeat(32),
      mimeType: "application/pdf",
      pdfVersion: "1.7",
      storageAuthorityGeneration: "a".repeat(64),
  }, storedAt), {
    storageKey: "local-quarantine-v2:opaque",
    sizeBytes: 101n,
    sha256: "c".repeat(64),
    md5: "d".repeat(32),
    mimeType: "application/pdf",
    storedAt,
  });
});
