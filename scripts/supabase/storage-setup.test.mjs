import assert from "node:assert/strict";
import test from "node:test";

import { inspectOrApplyPaperPilotStorage } from "./storage-setup.mjs";

const ENVIRONMENT = Object.freeze({
  PAPERPILOT_SUPABASE_PROJECT_REF: "avmcmmayvnjxrhrmgsdx",
  PAPERPILOT_SUPABASE_URL: "https://avmcmmayvnjxrhrmgsdx.supabase.co",
  PAPERPILOT_SUPABASE_STORAGE_BUCKET: "paperpilot-private-pdfs",
  PAPERPILOT_SUPABASE_SECRET_KEY: `sb_secret_${"a".repeat(32)}`,
});

const EXACT_BUCKET = Object.freeze({
  id: "paperpilot-private-pdfs",
  name: "paperpilot-private-pdfs",
  public: false,
  file_size_limit: 26_214_400,
  allowed_mime_types: ["application/pdf"],
});

function fakeClient(sequence, observations) {
  return () => ({
    storage: {
      async getBucket(bucket) {
        observations.push(["get", bucket]);
        const next = sequence.shift();
        assert.ok(next);
        return next;
      },
      async createBucket(bucket, policy) {
        observations.push(["create", bucket, policy]);
        return { data: { name: bucket }, error: null };
      },
      async updateBucket(bucket, policy) {
        observations.push(["update", bucket, policy]);
        return { data: { message: "Successfully updated" }, error: null };
      },
    },
  });
}

test("private Storage readiness is read-only and exact", async () => {
  const observations = [];
  const result = await inspectOrApplyPaperPilotStorage({
    environment: ENVIRONMENT,
    createClientImpl: fakeClient(
      [{ data: EXACT_BUCKET, error: null }],
      observations,
    ),
  });
  assert.equal(result.status, "private_storage_ready");
  assert.deepEqual(observations, [["get", "paperpilot-private-pdfs"]]);
});

test("apply creates only the exact missing private PDF bucket", async () => {
  const observations = [];
  const result = await inspectOrApplyPaperPilotStorage({
    environment: ENVIRONMENT,
    apply: true,
    createClientImpl: fakeClient([
      { data: null, error: { status: 404 } },
      { data: EXACT_BUCKET, error: null },
    ], observations),
  });
  assert.equal(result.status, "private_storage_reconciled");
  assert.deepEqual(observations, [
    ["get", "paperpilot-private-pdfs"],
    ["create", "paperpilot-private-pdfs", {
      public: false,
      fileSizeLimit: 26_214_400,
      allowedMimeTypes: ["application/pdf"],
    }],
    ["get", "paperpilot-private-pdfs"],
  ]);
});

test("readiness rejects drift while apply reconciles it exactly", async () => {
  const drifted = { ...EXACT_BUCKET, public: true };
  await assert.rejects(
    inspectOrApplyPaperPilotStorage({
      environment: ENVIRONMENT,
      createClientImpl: fakeClient(
        [{ data: drifted, error: null }],
        [],
      ),
    }),
    /absent or does not match/,
  );

  const observations = [];
  await inspectOrApplyPaperPilotStorage({
    environment: ENVIRONMENT,
    apply: true,
    createClientImpl: fakeClient([
      { data: drifted, error: null },
      { data: EXACT_BUCKET, error: null },
    ], observations),
  });
  assert.equal(observations[1][0], "update");
  assert.deepEqual(observations[1][2], {
    public: false,
    fileSizeLimit: 26_214_400,
    allowedMimeTypes: ["application/pdf"],
  });
});
