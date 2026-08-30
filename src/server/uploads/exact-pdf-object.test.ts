import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  assertStorageObjectReference,
  assertSupabaseObjectReferenceForAttempt,
  assertSupabasePdfObjectKeyForAttempt,
  LOCAL_QUARANTINE_BUCKET,
  PDF_STORAGE_PROTOCOLS,
  PdfObjectReadError,
  SUPABASE_PDF_BUCKET,
  supabasePdfObjectKeyForAttempt,
  withVerifiedPdf,
  type AdmittedPdfIdentity,
  type PinnedObjectRead,
  type PinnedObjectStore,
  type StorageObjectReference,
} from "./exact-pdf-object";

const encoder = new TextEncoder();
const BYTES = encoder.encode("%PDF-1.7\nserverless exact object\n%%EOF\n");
const SHA256 = createHash("sha256").update(BYTES).digest("hex");

function localReference(
  overrides: Partial<StorageObjectReference> = {},
): StorageObjectReference {
  return {
    organizationId: "org-1",
    assetId: "asset-1",
    storageProvider: "LOCAL",
    bucket: LOCAL_QUARANTINE_BUCKET,
    objectKey: `local-quarantine-v2:${"a".repeat(64)}:${"b".repeat(64)}:${"c".repeat(64)}`,
    storageProtocolVersion: PDF_STORAGE_PROTOCOLS.LOCAL,
    objectVersion: null,
    storageAuthorityGeneration: "d".repeat(64),
    ...overrides,
  };
}

function expected(
  overrides: Partial<AdmittedPdfIdentity> = {},
): AdmittedPdfIdentity {
  return {
    object: localReference(),
    sizeBytes: BigInt(BYTES.byteLength),
    sha256: SHA256,
    mimeType: "application/pdf",
    ...overrides,
  };
}

function memoryStore(
  bytes = BYTES,
  options: { shortRead?: boolean; changedAfter?: boolean } = {},
): PinnedObjectStore {
  return {
    async withPinnedObject<T>(
      _reference: StorageObjectReference,
      operation: (object: PinnedObjectRead) => Promise<T>,
    ): Promise<T> {
      const result = await operation({
        sizeBytes: BigInt(bytes.byteLength),
        async readAt(offset, length) {
          const start = Number(offset);
          const requested = options.shortRead && length > 1 ? length - 1 : length;
          return bytes.slice(start, start + requested);
        },
      });
      if (options.changedAfter) {
        throw new PdfObjectReadError("object_changed", false);
      }
      return result;
    },
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe("exact private PDF object contract", () => {
  it("verifies the pinned size and SHA-256 before exposing a bounded body", async () => {
    let invoked = false;
    const result = await withVerifiedPdf(memoryStore(), expected(), async (pdf) => {
      invoked = true;
      assert.equal(pdf.sizeBytes, BigInt(BYTES.byteLength));
      assert.equal(pdf.sha256, SHA256);
      return collect(pdf.body());
    });

    assert.equal(invoked, true);
    assert.deepEqual(result, BYTES);
  });

  it("does not invoke the consumer for size, digest, or short-read drift", async () => {
    for (const scenario of [
      {
        store: memoryStore(),
        identity: expected({ sizeBytes: BigInt(BYTES.byteLength + 1) }),
        code: "content_size_mismatch",
      },
      {
        store: memoryStore(),
        identity: expected({ sha256: "0".repeat(64) }),
        code: "content_sha256_mismatch",
      },
      {
        store: memoryStore(BYTES, { shortRead: true }),
        identity: expected(),
        code: "content_size_mismatch",
      },
    ] as const) {
      let invoked = false;
      await assert.rejects(
        withVerifiedPdf(scenario.store, scenario.identity, async () => {
          invoked = true;
        }),
        (error: unknown) =>
          error instanceof PdfObjectReadError && error.code === scenario.code,
      );
      assert.equal(invoked, false);
    }
  });

  it("preserves a provider post-operation mutation failure", async () => {
    await assert.rejects(
      withVerifiedPdf(
        memoryStore(BYTES, { changedAfter: true }),
        expected(),
        async () => "processed",
      ),
      (error: unknown) =>
        error instanceof PdfObjectReadError && error.code === "object_changed",
    );
  });

  it("rejects mixed local and Supabase authority fields", () => {
    assert.throws(() => assertStorageObjectReference(localReference({
      objectVersion: "etag-1",
    })));

    assert.throws(() => assertStorageObjectReference({
      ...localReference(),
      storageProvider: "SUPABASE_STORAGE",
      bucket: SUPABASE_PDF_BUCKET,
      storageProtocolVersion: PDF_STORAGE_PROTOCOLS.SUPABASE_STORAGE,
      objectVersion: "etag-1",
      storageAuthorityGeneration: "d".repeat(64),
    }));

    assert.doesNotThrow(() => assertStorageObjectReference({
      ...localReference(),
      storageProvider: "SUPABASE_STORAGE",
      bucket: SUPABASE_PDF_BUCKET,
      objectKey: supabasePdfObjectKeyForAttempt({
        organizationId: "org-1",
        assetId: "asset-1",
        attemptId: "attempt-1",
      }),
      storageProtocolVersion: PDF_STORAGE_PROTOCOLS.SUPABASE_STORAGE,
      objectVersion: "etag-1",
      storageAuthorityGeneration: null,
    }));
  });

  it("binds each Supabase object key to its organization and asset", () => {
    const reference: StorageObjectReference = {
      ...localReference(),
      storageProvider: "SUPABASE_STORAGE",
      bucket: SUPABASE_PDF_BUCKET,
      objectKey: supabasePdfObjectKeyForAttempt({
        organizationId: "org-1",
        assetId: "asset-1",
        attemptId: "attempt-1",
      }),
      storageProtocolVersion: PDF_STORAGE_PROTOCOLS.SUPABASE_STORAGE,
      objectVersion: "version-1",
      storageAuthorityGeneration: null,
    };

    assert.doesNotThrow(() => assertStorageObjectReference(reference));
    assert.throws(() => assertStorageObjectReference({
      ...reference,
      organizationId: "org-2",
    }));
    assert.throws(() => assertStorageObjectReference({
      ...reference,
      assetId: "asset-2",
    }));
  });

  it("binds each Supabase object key to the exact upload attempt", () => {
    const reference: StorageObjectReference = {
      ...localReference(),
      storageProvider: "SUPABASE_STORAGE",
      bucket: SUPABASE_PDF_BUCKET,
      objectKey: supabasePdfObjectKeyForAttempt({
        organizationId: "org-1",
        assetId: "asset-1",
        attemptId: "attempt-current",
      }),
      storageProtocolVersion: PDF_STORAGE_PROTOCOLS.SUPABASE_STORAGE,
      objectVersion: "version-1",
      storageAuthorityGeneration: null,
    };

    assert.doesNotThrow(() => assertSupabaseObjectReferenceForAttempt(
      reference,
      "attempt-current",
    ));
    assert.throws(
      () => assertSupabaseObjectReferenceForAttempt(reference, "attempt-stale"),
      /not bound to this upload attempt/,
    );
    assert.throws(() => assertSupabasePdfObjectKeyForAttempt({
      organizationId: "org-1",
      assetId: "asset-1",
      attemptId: "attempt-current",
      objectKey: supabasePdfObjectKeyForAttempt({
        organizationId: "org-1",
        assetId: "asset-1",
        attemptId: "attempt-other",
      }),
    }));
  });

  it("returns a fixed path-free error message", () => {
    const error = new PdfObjectReadError("object_unavailable", true);
    assert.equal(error.message, "The private PDF object could not be verified.");
    assert.equal(error.message.includes("bucket"), false);
    assert.equal(error.message.includes("/"), false);
  });
});
