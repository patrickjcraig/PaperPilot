import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, it } from "node:test";
import os from "node:os";
import path from "node:path";

import {
  LOCAL_QUARANTINE_BUCKET,
  PDF_STORAGE_PROTOCOLS,
  PdfObjectReadError,
  withVerifiedPdf,
  type StorageObjectReference,
} from "./exact-pdf-object";
import { createLocalQuarantineObjectStore } from "./local-quarantine-object-store";
import {
  localQuarantineStorageAuthority,
  streamAuthorizedPdfToLocalQuarantine,
} from "./storage";

const BYTES = new TextEncoder().encode("%PDF-1.7\nlocal adapter boundary\n%%EOF\n");

function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
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

describe("local quarantine exact-object adapter", () => {
  it("wraps the existing held-handle and root-generation protections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperpilot-local-object-store-"));
    const organizationId = "org-1";
    const assetId = "asset-1";
    try {
      const authority = await localQuarantineStorageAuthority({ quarantineRoot: root });
      const stored = await streamAuthorizedPdfToLocalQuarantine({
        organizationId,
        assetId,
        attemptId: "attempt-1",
        expectedSizeBytes: BigInt(BYTES.byteLength),
        body: body(BYTES),
        configuration: {
          quarantineRoot: root,
          maxUploadBytes: 1024 * 1024,
          streamIdleTimeoutMs: 5_000,
          streamAbsoluteTimeoutMs: 10_000,
        },
        expectedStorageAuthorityGeneration: authority.generation,
      });
      const reference: StorageObjectReference = {
        organizationId,
        assetId,
        storageProvider: "LOCAL",
        bucket: LOCAL_QUARANTINE_BUCKET,
        objectKey: stored.storageKey,
        storageProtocolVersion: PDF_STORAGE_PROTOCOLS.LOCAL,
        objectVersion: null,
        storageAuthorityGeneration: authority.generation,
      };
      const store = createLocalQuarantineObjectStore({
        configuration: { quarantineRoot: root },
      });

      const result = await withVerifiedPdf(store, {
        object: reference,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        mimeType: "application/pdf",
      }, async (pdf) => collect(pdf.body()));

      assert.deepEqual(result, BYTES);

      const consumerFailure = new Error("consumer failed");
      await assert.rejects(
        store.withPinnedObject(reference, async () => {
          throw consumerFailure;
        }),
        (error: unknown) => error === consumerFailure,
      );

      await assert.rejects(
        withVerifiedPdf(store, {
          object: { ...reference, organizationId: "another-org" },
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          mimeType: "application/pdf",
        }, async () => undefined),
        (error: unknown) =>
          error instanceof PdfObjectReadError && error.code === "object_changed",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
