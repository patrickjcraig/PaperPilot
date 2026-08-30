import "server-only";

import { HttpProblem } from "@/server/http/problem";
import type { UploadConfiguration } from "./config";
import {
  assertStorageObjectReference,
  PdfObjectReadError,
  type PinnedObjectRead,
  type PinnedObjectStore,
  type StorageObjectReference,
} from "./exact-pdf-object";
import { withOpenLocalQuarantineObject } from "./storage";

export interface LocalQuarantineObjectStoreOptions {
  configuration: Pick<UploadConfiguration, "quarantineRoot">;
}

function translateLocalStorageError(error: unknown): never {
  if (error instanceof PdfObjectReadError) throw error;
  if (error instanceof HttpProblem) {
    if (error.code === "quarantine_object_missing") {
      throw new PdfObjectReadError("object_missing", false);
    }
    if (
      error.code === "quarantine_object_changed"
      || error.code === "storage_authority_mismatch"
      || error.code === "invalid_storage_key"
      || error.code === "storage_key_mismatch"
      || error.code === "quarantine_custody_deleted"
    ) {
      throw new PdfObjectReadError("object_changed", false);
    }
  }
  throw new PdfObjectReadError("object_unavailable", true);
}

export function createLocalQuarantineObjectStore(
  options: LocalQuarantineObjectStoreOptions,
): PinnedObjectStore {
  if (
    !options
    || typeof options !== "object"
    || typeof options.configuration?.quarantineRoot !== "string"
  ) {
    throw new TypeError("A local quarantine object-store configuration is required.");
  }

  return Object.freeze({
    async withPinnedObject<T>(
      reference: StorageObjectReference,
      operation: (object: PinnedObjectRead) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      assertStorageObjectReference(reference);
      if (reference.storageProvider !== "LOCAL") {
        throw new PdfObjectReadError("object_unavailable", false);
      }
      signal?.throwIfAborted();
      let callbackFailed = false;
      let callbackError: unknown;
      try {
        return await withOpenLocalQuarantineObject(
          options.configuration,
          reference.objectKey,
          {
            organizationId: reference.organizationId,
            assetId: reference.assetId,
          },
          async ({ handle, sizeBytes }) => {
            const pinned: PinnedObjectRead = Object.freeze({
              sizeBytes,
              async readAt(
                offset: bigint,
                length: number,
                readSignal?: AbortSignal,
              ): Promise<Uint8Array> {
                readSignal?.throwIfAborted();
                if (
                  typeof offset !== "bigint"
                  || offset < 0n
                  || offset > BigInt(Number.MAX_SAFE_INTEGER)
                  || !Number.isSafeInteger(length)
                  || length < 0
                ) {
                  throw new PdfObjectReadError("object_unavailable", false);
                }
                if (length === 0) return new Uint8Array();
                const buffer = Buffer.allocUnsafe(length);
                const result = await handle.read(
                  buffer,
                  0,
                  length,
                  Number(offset),
                );
                return new Uint8Array(
                  buffer.buffer,
                  buffer.byteOffset,
                  result.bytesRead,
                );
              },
            });
            try {
              return await operation(pinned);
            } catch (error) {
              callbackFailed = true;
              callbackError = error;
              throw error;
            }
          },
          reference.storageAuthorityGeneration,
        );
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (callbackFailed && error === callbackError) throw error;
        translateLocalStorageError(error);
      }
    },
  });
}
