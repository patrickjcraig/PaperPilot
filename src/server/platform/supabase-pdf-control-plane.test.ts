import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { supabasePdfObjectKeyForAttempt } from "../uploads/exact-pdf-object";
import {
  createSupabasePrivatePdfControlPlane,
  PrivatePdfControlPlaneError,
  type SupabasePrivateBucketApi,
} from "./supabase-pdf-control-plane";

const NOW = new Date("2026-08-30T16:00:00.000Z");
const TOKEN = "signed-provider-token-value";
const address = Object.freeze({
  organizationId: "organization-1",
  assetId: "asset-1",
  attemptId: "attempt-1",
  bucket: "paperpilot-private-pdfs" as const,
  objectKey: supabasePdfObjectKeyForAttempt({
    organizationId: "organization-1",
    assetId: "asset-1",
    attemptId: "attempt-1",
  }),
});

function signedUrl(kind: "upload/sign" | "sign") {
  return `https://avmcmmayvnjxrhrmgsdx.supabase.co/storage/v1/object/${kind}/paperpilot-private-pdfs/${address.objectKey}?token=${TOKEN}`;
}

function fakeBucket(overrides: Partial<SupabasePrivateBucketApi> = {}) {
  const calls = {
    createUpload: [] as unknown[][],
    info: [] as unknown[][],
    createRead: [] as unknown[][],
    remove: [] as unknown[][],
  };
  const bucket: SupabasePrivateBucketApi = {
    async createSignedUploadUrl(...args) {
      calls.createUpload.push(args);
      return { data: { signedUrl: signedUrl("upload/sign"), token: TOKEN, path: address.objectKey }, error: null };
    },
    async info(...args) {
      calls.info.push(args);
      return { data: {
        id: "provider-id",
        version: "version-1",
        name: address.objectKey,
        bucketId: address.bucket,
        size: 17,
        contentType: "application/pdf",
        etag: "etag-1",
      }, error: null };
    },
    async createSignedUrl(...args) {
      calls.createRead.push(args);
      return { data: { signedUrl: signedUrl("sign") }, error: null };
    },
    async remove(...args) {
      calls.remove.push(args);
      return { data: [], error: null };
    },
    ...overrides,
  };
  return { bucket, calls };
}

describe("Supabase private PDF control plane", () => {
  it("mints a create-only upload capability without exposing a byte API", async () => {
    const { bucket, calls } = fakeBucket();
    const controlPlane = createSupabasePrivatePdfControlPlane(bucket, () => NOW);
    const capability = await controlPlane.createNewObjectUploadCapability(address);

    assert.deepEqual(calls.createUpload, [[address.objectKey, { upsert: false }]]);
    assert.deepEqual(capability, {
      provider: "SUPABASE_STORAGE",
      method: "PUT",
      url: signedUrl("upload/sign"),
      headers: {
        "cache-control": "max-age=0",
        "content-type": "application/pdf",
        "x-upsert": "false",
      },
      expiresAt: new Date("2026-08-30T18:00:00.000Z"),
    });
    assert.equal("download" in controlPlane, false);
    assert.equal("read" in controlPlane, false);
    assert.equal("body" in controlPlane, false);
  });

  it("reads only exact metadata and exposes the provider object version", async () => {
    const { bucket, calls } = fakeBucket();
    const controlPlane = createSupabasePrivatePdfControlPlane(bucket, () => NOW);
    assert.deepEqual(await controlPlane.headExactObject(address), {
      provider: "SUPABASE_STORAGE",
      sizeBytes: 17n,
      contentType: "application/pdf",
      objectVersion: "version-1",
      etag: "etag-1",
    });
    assert.deepEqual(calls.info, [[address.objectKey]]);
  });

  it("fails closed for an object from another attempt before calling Supabase", async () => {
    const { bucket, calls } = fakeBucket();
    const controlPlane = createSupabasePrivatePdfControlPlane(bucket, () => NOW);
    await assert.rejects(controlPlane.createNewObjectUploadCapability({
      ...address,
      attemptId: "attempt-stale",
    }), /not bound to this upload attempt/);
    assert.equal(calls.createUpload.length, 0);
  });

  it("rejects capability URL drift with a path-free error", async () => {
    const { bucket } = fakeBucket({
      async createSignedUploadUrl() {
        return { data: {
          signedUrl: `https://attacker.example/upload?token=${TOKEN}`,
          token: TOKEN,
          path: address.objectKey,
        }, error: null };
      },
    });
    const controlPlane = createSupabasePrivatePdfControlPlane(bucket, () => NOW);
    await assert.rejects(
      controlPlane.createNewObjectUploadCapability(address),
      (error: unknown) => error instanceof PrivatePdfControlPlaneError
        && error.code === "provider_contract_mismatch"
        && !error.message.includes("attacker")
        && !error.message.includes(address.objectKey),
    );
  });

  it("rejects missing, wrong-size, wrong-type, or versionless metadata", async () => {
    for (const data of [
      null,
      { id: "id", version: "version-1", name: address.objectKey, bucketId: address.bucket, size: 0, contentType: "application/pdf" },
      { id: "id", version: "version-1", name: address.objectKey, bucketId: address.bucket, size: 17, contentType: "text/plain" },
      { id: "id", version: "", name: address.objectKey, bucketId: address.bucket, size: 17, contentType: "application/pdf" },
    ]) {
      const { bucket } = fakeBucket({
        async info() {
          return {
            data,
            error: data ? null : Object.assign(new Error("missing"), { status: 404 }),
          };
        },
      });
      const controlPlane = createSupabasePrivatePdfControlPlane(bucket, () => NOW);
      await assert.rejects(controlPlane.headExactObject(address), PrivatePdfControlPlaneError);
    }
  });

  it("treats non-404 metadata failures as retryable provider outages", async () => {
    const { bucket } = fakeBucket({
      async info() {
        return {
          data: null,
          error: Object.assign(new Error("upstream unavailable"), { status: 503 }),
        };
      },
    });
    const controlPlane = createSupabasePrivatePdfControlPlane(bucket, () => NOW);
    await assert.rejects(
      controlPlane.headExactObject(address),
      (error: unknown) => error instanceof PrivatePdfControlPlaneError
        && error.code === "provider_unavailable"
        && error.retryable,
    );
  });

  it("mints a bounded path-based read capability and labels its limitation", async () => {
    const { bucket, calls } = fakeBucket();
    const controlPlane = createSupabasePrivatePdfControlPlane(bucket, () => NOW);
    assert.deepEqual(await controlPlane.createReadCapability(address, 300), {
      provider: "SUPABASE_STORAGE",
      method: "GET",
      url: signedUrl("sign"),
      headers: {},
      expiresAt: new Date("2026-08-30T16:05:00.000Z"),
      providerVersionPinned: false,
    });
    assert.deepEqual(calls.createRead, [[address.objectKey, 300]]);
    await assert.rejects(controlPlane.createReadCapability(address, 901), /lifetime/);
  });

  it("checks the exact provider version immediately before deleting one orphan key", async () => {
    const { bucket, calls } = fakeBucket();
    const controlPlane = createSupabasePrivatePdfControlPlane(bucket, () => NOW);
    await controlPlane.deleteExactObject(address, "version-1");
    assert.deepEqual(calls.remove, [[[address.objectKey]]]);

    await assert.rejects(
      controlPlane.deleteExactObject(address, "version-other"),
      (error: unknown) => error instanceof PrivatePdfControlPlaneError
        && error.code === "object_changed",
    );
    assert.equal(calls.remove.length, 1);
  });
});
