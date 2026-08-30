import "server-only";

import { createClient } from "@supabase/supabase-js";

import {
  PAPERPILOT_SUPABASE_PDF_BUCKET,
  PAPERPILOT_SUPABASE_URL,
  paperPilotSupabaseStorageConfiguration,
} from "../../lib/supabase-storage-config.mjs";
import {
  assertSupabasePdfObjectKeyForAttempt,
  SUPABASE_PDF_BUCKET,
} from "../uploads/exact-pdf-object";

const SIGNED_UPLOAD_LIFETIME_MS = 2 * 60 * 60 * 1_000;
const MIN_READ_LIFETIME_SECONDS = 30;
const MAX_READ_LIFETIME_SECONDS = 15 * 60;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

export interface PrivatePdfObjectAddress {
  readonly organizationId: string;
  readonly assetId: string;
  readonly attemptId: string;
  readonly bucket: typeof PAPERPILOT_SUPABASE_PDF_BUCKET;
  readonly objectKey: string;
}

export interface DirectPdfUploadCapability {
  readonly provider: "SUPABASE_STORAGE";
  readonly method: "PUT";
  readonly url: string;
  readonly headers: Readonly<{
    "cache-control": "max-age=0";
    "content-type": "application/pdf";
    "x-upsert": "false";
  }>;
  readonly expiresAt: Date;
}

export interface PrivatePdfObjectMetadata {
  readonly provider: "SUPABASE_STORAGE";
  readonly sizeBytes: bigint;
  readonly contentType: "application/pdf";
  readonly objectVersion: string;
  readonly etag: string | null;
}

export interface DirectPdfReadCapability {
  readonly provider: "SUPABASE_STORAGE";
  readonly method: "GET";
  readonly url: string;
  readonly headers: Readonly<Record<string, never>>;
  readonly expiresAt: Date;
  /**
   * Supabase's public SDK signs the current write-once path, not a version ID.
   * Consumers must verify the admitted SHA-256 before exposing PDF bytes.
   */
  readonly providerVersionPinned: false;
}

/** Metadata and ephemeral capabilities only; deliberately no byte-read API. */
export interface PrivatePdfObjectControlPlane {
  createNewObjectUploadCapability(
    address: PrivatePdfObjectAddress,
  ): Promise<DirectPdfUploadCapability>;
  headExactObject(
    address: PrivatePdfObjectAddress,
  ): Promise<PrivatePdfObjectMetadata>;
  createReadCapability(
    address: PrivatePdfObjectAddress,
    lifetimeSeconds: number,
  ): Promise<DirectPdfReadCapability>;
  deleteExactObject(
    address: PrivatePdfObjectAddress,
    expectedObjectVersion: string,
  ): Promise<void>;
}

export type PrivatePdfControlPlaneErrorCode =
  | "provider_unavailable"
  | "provider_contract_mismatch"
  | "object_missing"
  | "object_metadata_mismatch"
  | "object_changed";

export class PrivatePdfControlPlaneError extends Error {
  constructor(
    readonly code: PrivatePdfControlPlaneErrorCode,
    readonly retryable: boolean,
  ) {
    super("The private PDF storage operation could not be completed.");
    this.name = "PrivatePdfControlPlaneError";
  }
}

interface SupabaseResult<T> {
  data: T | null;
  error: unknown;
}

export interface SupabasePrivateBucketApi {
  createSignedUploadUrl(
    path: string,
    options: { upsert: boolean },
  ): Promise<SupabaseResult<{ signedUrl: string; token: string; path: string }>>;
  info(path: string): Promise<SupabaseResult<{
    id: string;
    version: string;
    name: string;
    bucketId: string;
    size?: number;
    contentType?: string;
    etag?: string;
  }>>;
  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<SupabaseResult<{ signedUrl: string }>>;
  remove(paths: string[]): Promise<SupabaseResult<unknown>>;
}

function assertAddress(address: PrivatePdfObjectAddress): void {
  if (
    !address
    || typeof address !== "object"
    || address.bucket !== SUPABASE_PDF_BUCKET
  ) {
    throw new TypeError("An exact private Supabase PDF address is required.");
  }
  assertSupabasePdfObjectKeyForAttempt(address);
}

function providerFailure(): PrivatePdfControlPlaneError {
  return new PrivatePdfControlPlaneError("provider_unavailable", true);
}

function contractFailure(): PrivatePdfControlPlaneError {
  return new PrivatePdfControlPlaneError("provider_contract_mismatch", false);
}

function exactSignedUrl(
  value: unknown,
  kind: "upload" | "read",
  objectKey: string,
): string {
  if (typeof value !== "string" || value.length > 16_384) throw contractFailure();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw contractFailure();
  }
  const operation = kind === "upload" ? "upload/sign" : "sign";
  const expectedPath = `/storage/v1/object/${operation}/${SUPABASE_PDF_BUCKET}/${objectKey}`;
  const entries = [...url.searchParams.entries()];
  if (
    url.origin !== PAPERPILOT_SUPABASE_URL
    || url.pathname !== expectedPath
    || url.username
    || url.password
    || url.port
    || url.hash
    || entries.length !== 1
    || entries[0]?.[0] !== "token"
    || !entries[0][1]
    || entries[0][1].length > 8_192
  ) throw contractFailure();
  return url.toString();
}

function validProviderField(value: unknown, maximumBytes = 512): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= maximumBytes
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function providerStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  for (const key of ["status", "statusCode"] as const) {
    const value = Reflect.get(error, key);
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d{3}$/u.test(value)) return Number(value);
  }
  return null;
}

export function createSupabasePrivatePdfControlPlane(
  bucket: SupabasePrivateBucketApi,
  clock: () => Date = () => new Date(),
): PrivatePdfObjectControlPlane {
  return Object.freeze({
    async createNewObjectUploadCapability(address: PrivatePdfObjectAddress) {
      assertAddress(address);
      const issuedAt = clock();
      let result: Awaited<ReturnType<SupabasePrivateBucketApi["createSignedUploadUrl"]>>;
      try {
        result = await bucket.createSignedUploadUrl(address.objectKey, { upsert: false });
      } catch {
        throw providerFailure();
      }
      if (result.error || !result.data) throw providerFailure();
      if (result.data.path !== address.objectKey || !result.data.token) throw contractFailure();
      const url = exactSignedUrl(result.data.signedUrl, "upload", address.objectKey);
      if (new URL(url).searchParams.get("token") !== result.data.token) throw contractFailure();
      return Object.freeze({
        provider: "SUPABASE_STORAGE" as const,
        method: "PUT" as const,
        url,
        headers: Object.freeze({
          "cache-control": "max-age=0" as const,
          "content-type": "application/pdf" as const,
          "x-upsert": "false" as const,
        }),
        expiresAt: new Date(issuedAt.getTime() + SIGNED_UPLOAD_LIFETIME_MS),
      });
    },

    async headExactObject(address: PrivatePdfObjectAddress) {
      assertAddress(address);
      let result: Awaited<ReturnType<SupabasePrivateBucketApi["info"]>>;
      try {
        result = await bucket.info(address.objectKey);
      } catch {
        throw providerFailure();
      }
      if (result.error && providerStatus(result.error) === 404) {
        throw new PrivatePdfControlPlaneError("object_missing", false);
      }
      if (result.error) throw providerFailure();
      if (!result.data) throw contractFailure();
      const { data } = result;
      if (
        data.name !== address.objectKey
        || data.bucketId !== SUPABASE_PDF_BUCKET
        || !Number.isSafeInteger(data.size)
        || (data.size ?? 0) <= 0
        || (data.size ?? 0) > MAX_PDF_BYTES
        || data.contentType !== "application/pdf"
        || !validProviderField(data.version)
        || (data.etag !== undefined && !validProviderField(data.etag))
      ) {
        throw new PrivatePdfControlPlaneError("object_metadata_mismatch", false);
      }
      return Object.freeze({
        provider: "SUPABASE_STORAGE" as const,
        sizeBytes: BigInt(data.size as number),
        contentType: "application/pdf" as const,
        objectVersion: data.version,
        etag: data.etag ?? null,
      });
    },

    async createReadCapability(
      address: PrivatePdfObjectAddress,
      lifetimeSeconds: number,
    ) {
      assertAddress(address);
      if (
        !Number.isSafeInteger(lifetimeSeconds)
        || lifetimeSeconds < MIN_READ_LIFETIME_SECONDS
        || lifetimeSeconds > MAX_READ_LIFETIME_SECONDS
      ) throw new TypeError("The private PDF read lifetime is invalid.");
      const issuedAt = clock();
      let result: Awaited<ReturnType<SupabasePrivateBucketApi["createSignedUrl"]>>;
      try {
        result = await bucket.createSignedUrl(address.objectKey, lifetimeSeconds);
      } catch {
        throw providerFailure();
      }
      if (result.error || !result.data) throw providerFailure();
      return Object.freeze({
        provider: "SUPABASE_STORAGE" as const,
        method: "GET" as const,
        url: exactSignedUrl(result.data.signedUrl, "read", address.objectKey),
        headers: Object.freeze({}),
        expiresAt: new Date(issuedAt.getTime() + lifetimeSeconds * 1_000),
        providerVersionPinned: false as const,
      });
    },

    async deleteExactObject(
      address: PrivatePdfObjectAddress,
      expectedObjectVersion: string,
    ) {
      assertAddress(address);
      if (!validProviderField(expectedObjectVersion)) {
        throw new TypeError("The expected private object version is invalid.");
      }
      const current = await this.headExactObject(address);
      if (current.objectVersion !== expectedObjectVersion) {
        throw new PrivatePdfControlPlaneError("object_changed", false);
      }
      let result: Awaited<ReturnType<SupabasePrivateBucketApi["remove"]>>;
      try {
        result = await bucket.remove([address.objectKey]);
      } catch {
        throw providerFailure();
      }
      if (result.error) throw providerFailure();
    },
  });
}

export function supabasePrivatePdfControlPlaneFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PrivatePdfObjectControlPlane {
  const configuration = paperPilotSupabaseStorageConfiguration(
    environment,
    { requireSecret: true },
  );
  const client = createClient(configuration.url, configuration.secretKey as string, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return createSupabasePrivatePdfControlPlane(
    client.storage.from(configuration.bucket) as SupabasePrivateBucketApi,
  );
}
