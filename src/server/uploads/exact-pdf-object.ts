import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

export const LOCAL_QUARANTINE_BUCKET = "private-quarantine-v1";
export const SUPABASE_PDF_BUCKET = "paperpilot-private-pdfs";

export const PDF_STORAGE_PROTOCOLS = Object.freeze({
  LOCAL: "local-quarantine-v2",
  SUPABASE_STORAGE: "supabase-private-object-v1",
} as const);

export type PaperPilotPdfStorageProvider = keyof typeof PDF_STORAGE_PROTOCOLS;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const LOCAL_AUTHORITY_PATTERN = /^[a-f0-9]{64}$/;
const SUPABASE_OBJECT_KEY_PATTERN = /^tenants\/([a-f0-9]{64})\/assets\/([a-f0-9]{64})\/attempts\/([a-f0-9]{64})\/original\.pdf$/;
const MAX_STORAGE_FIELD_BYTES = 1_024;
const VERIFY_READ_CHUNK_BYTES = 256 * 1_024;

export interface StorageObjectReference {
  organizationId: string;
  assetId: string;
  storageProvider: PaperPilotPdfStorageProvider;
  bucket: string;
  objectKey: string;
  /** PaperPilot custody protocol, not a content digest. */
  storageProtocolVersion: string;
  /** Provider-defined immutable object revision. Required for Supabase. */
  objectVersion: string | null;
  /** Local root authority. It is never overloaded with a provider ETag. */
  storageAuthorityGeneration: string | null;
}

export interface AdmittedPdfIdentity {
  object: StorageObjectReference;
  sizeBytes: bigint;
  sha256: string;
  mimeType: "application/pdf";
}

export interface PinnedObjectRead {
  readonly sizeBytes: bigint;
  /** Return zero only at EOF, never more than `length`. */
  readAt(
    offset: bigint,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

export interface PinnedObjectStore {
  /**
   * Pin one exact provider generation for the complete callback and verify that
   * generation again before returning success.
   */
  withPinnedObject<T>(
    reference: StorageObjectReference,
    operation: (object: PinnedObjectRead) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface VerifiedPdfRead extends PinnedObjectRead {
  readonly sha256: string;
  /** Must be consumed before the enclosing `withVerifiedPdf` callback returns. */
  body(signal?: AbortSignal): ReadableStream<Uint8Array>;
}

export type PdfObjectReadErrorCode =
  | "object_missing"
  | "object_changed"
  | "object_unavailable"
  | "content_size_mismatch"
  | "content_sha256_mismatch";

export class PdfObjectReadError extends Error {
  constructor(
    readonly code: PdfObjectReadErrorCode,
    readonly retryable: boolean,
  ) {
    super("The private PDF object could not be verified.");
    this.name = "PdfObjectReadError";
  }
}

function boundedField(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > MAX_STORAGE_FIELD_BYTES
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function opaqueId(value: string, label: string): string {
  if (!OPAQUE_ID_PATTERN.test(value) || Buffer.byteLength(value, "utf8") > 200) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function storageSegment(namespace: string, value: string): string {
  return createHash("sha256")
    .update(`paperpilot-${namespace}\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function supabasePdfObjectKeyForAttempt(input: {
  organizationId: string;
  assetId: string;
  attemptId: string;
}): string {
  const organizationId = opaqueId(input.organizationId, "organizationId");
  const assetId = opaqueId(input.assetId, "assetId");
  const attemptId = opaqueId(input.attemptId, "attemptId");
  return [
    "tenants",
    storageSegment("supabase-organization-v1", organizationId),
    "assets",
    storageSegment("supabase-asset-v1", assetId),
    "attempts",
    storageSegment("supabase-attempt-v1", attemptId),
    "original.pdf",
  ].join("/");
}

/**
 * Prove that one canonical Supabase key belongs to the exact durable upload
 * attempt. Organization and asset binding alone are insufficient because a
 * stale capability for another attempt of the same asset must fail closed.
 */
export function assertSupabasePdfObjectKeyForAttempt(input: {
  organizationId: string;
  assetId: string;
  attemptId: string;
  objectKey: string;
}): void {
  const expected = supabasePdfObjectKeyForAttempt(input);
  if (input.objectKey !== expected) {
    throw new TypeError("The Supabase PDF object key is not bound to this upload attempt.");
  }
}

export function assertSupabaseObjectReferenceForAttempt(
  reference: StorageObjectReference,
  attemptId: string,
): void {
  assertStorageObjectReference(reference);
  if (reference.storageProvider !== "SUPABASE_STORAGE") {
    throw new TypeError("A Supabase private object binding is required.");
  }
  assertSupabasePdfObjectKeyForAttempt({
    organizationId: reference.organizationId,
    assetId: reference.assetId,
    attemptId,
    objectKey: reference.objectKey,
  });
}

export function assertStorageObjectReference(
  reference: StorageObjectReference,
): void {
  if (!reference || typeof reference !== "object") {
    throw new TypeError("A private object reference is required.");
  }
  opaqueId(reference.organizationId, "organizationId");
  opaqueId(reference.assetId, "assetId");
  boundedField(reference.bucket, "bucket");
  boundedField(reference.objectKey, "objectKey");
  boundedField(reference.storageProtocolVersion, "storageProtocolVersion");

  if (reference.storageProvider === "LOCAL") {
    if (
      reference.bucket !== LOCAL_QUARANTINE_BUCKET
      || reference.storageProtocolVersion !== PDF_STORAGE_PROTOCOLS.LOCAL
      || reference.objectVersion !== null
      || typeof reference.storageAuthorityGeneration !== "string"
      || !LOCAL_AUTHORITY_PATTERN.test(reference.storageAuthorityGeneration)
    ) {
      throw new TypeError("The local private object binding is invalid.");
    }
    return;
  }

  if (reference.storageProvider === "SUPABASE_STORAGE") {
    const key = SUPABASE_OBJECT_KEY_PATTERN.exec(reference.objectKey);
    if (
      reference.bucket !== SUPABASE_PDF_BUCKET
      || reference.storageProtocolVersion !== PDF_STORAGE_PROTOCOLS.SUPABASE_STORAGE
      || typeof reference.objectVersion !== "string"
      || reference.objectVersion.length === 0
      || reference.objectVersion !== reference.objectVersion.trim()
      || Buffer.byteLength(reference.objectVersion, "utf8") > 512
      || /[\u0000-\u001f\u007f]/u.test(reference.objectVersion)
      || !key
      || key[1] !== storageSegment(
        "supabase-organization-v1",
        reference.organizationId,
      )
      || key[2] !== storageSegment("supabase-asset-v1", reference.assetId)
      || reference.storageAuthorityGeneration !== null
    ) {
      throw new TypeError("The Supabase private object binding is invalid.");
    }
    return;
  }

  throw new TypeError("The private object storage provider is unsupported.");
}

function assertAdmittedPdfIdentity(expected: AdmittedPdfIdentity): void {
  assertStorageObjectReference(expected.object);
  if (typeof expected.sizeBytes !== "bigint" || expected.sizeBytes <= 0n) {
    throw new TypeError("The admitted PDF size is invalid.");
  }
  if (!SHA256_PATTERN.test(expected.sha256)) {
    throw new TypeError("The admitted PDF SHA-256 is invalid.");
  }
  if (expected.mimeType !== "application/pdf") {
    throw new TypeError("The admitted PDF media type is invalid.");
  }
}

function sameSha256(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

async function readVerifiedChunk(
  object: PinnedObjectRead,
  offset: bigint,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  let chunk: Uint8Array;
  try {
    chunk = await object.readAt(offset, length, signal);
  } catch (error) {
    if (error instanceof PdfObjectReadError) throw error;
    if (signal?.aborted) throw signal.reason;
    throw new PdfObjectReadError("object_unavailable", true);
  }
  if (!(chunk instanceof Uint8Array) || chunk.byteLength !== length) {
    throw new PdfObjectReadError("content_size_mismatch", false);
  }
  return chunk;
}

function verifiedBody(
  object: PinnedObjectRead,
  sizeBytes: bigint,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let offset = 0n;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal?.throwIfAborted();
        if (offset === sizeBytes) {
          controller.close();
          return;
        }
        const remaining = sizeBytes - offset;
        const length = Number(
          remaining > BigInt(VERIFY_READ_CHUNK_BYTES)
            ? BigInt(VERIFY_READ_CHUNK_BYTES)
            : remaining,
        );
        const chunk = await readVerifiedChunk(object, offset, length, signal);
        offset += BigInt(chunk.byteLength);
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/**
 * Verify one pinned object against durable admission authority before exposing
 * it to validation, extraction, or Reader code. Provider-specific mutation
 * checks remain the store's responsibility around the complete callback.
 */
export async function withVerifiedPdf<T>(
  store: PinnedObjectStore,
  expected: AdmittedPdfIdentity,
  operation: (pdf: VerifiedPdfRead) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  assertAdmittedPdfIdentity(expected);
  signal?.throwIfAborted();

  return store.withPinnedObject(expected.object, async (object) => {
    if (object.sizeBytes !== expected.sizeBytes) {
      throw new PdfObjectReadError("content_size_mismatch", false);
    }

    const hash = createHash("sha256");
    let offset = 0n;
    while (offset < expected.sizeBytes) {
      const remaining = expected.sizeBytes - offset;
      const length = Number(
        remaining > BigInt(VERIFY_READ_CHUNK_BYTES)
          ? BigInt(VERIFY_READ_CHUNK_BYTES)
          : remaining,
      );
      const chunk = await readVerifiedChunk(object, offset, length, signal);
      hash.update(chunk);
      offset += BigInt(chunk.byteLength);
    }

    const actualSha256 = hash.digest("hex");
    if (!sameSha256(actualSha256, expected.sha256)) {
      throw new PdfObjectReadError("content_sha256_mismatch", false);
    }

    const verified: VerifiedPdfRead = Object.freeze({
      sizeBytes: object.sizeBytes,
      sha256: actualSha256,
      readAt: object.readAt.bind(object),
      body: (bodySignal?: AbortSignal) => {
        const effectiveSignal = signal && bodySignal && signal !== bodySignal
          ? AbortSignal.any([signal, bodySignal])
          : bodySignal ?? signal;
        return verifiedBody(object, expected.sizeBytes, effectiveSignal);
      },
    });
    return operation(verified);
  }, signal);
}
