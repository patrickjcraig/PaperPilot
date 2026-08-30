import assert from "node:assert/strict";
import test from "node:test";

import {
  PAPERPILOT_SUPABASE_PDF_MAX_BYTES,
  paperPilotSupabaseStorageConfiguration,
} from "./supabase-storage-config.mjs";

const BASE_ENVIRONMENT = Object.freeze({
  PAPERPILOT_SUPABASE_PROJECT_REF: "avmcmmayvnjxrhrmgsdx",
  PAPERPILOT_SUPABASE_URL: "https://avmcmmayvnjxrhrmgsdx.supabase.co",
  PAPERPILOT_SUPABASE_STORAGE_BUCKET: "paperpilot-private-pdfs",
});

test("the private PDF bucket is bound to one exact Supabase project", () => {
  const configuration = paperPilotSupabaseStorageConfiguration(BASE_ENVIRONMENT);
  assert.deepEqual(configuration, {
    projectRef: "avmcmmayvnjxrhrmgsdx",
    url: "https://avmcmmayvnjxrhrmgsdx.supabase.co",
    bucket: "paperpilot-private-pdfs",
    maxFileSizeBytes: PAPERPILOT_SUPABASE_PDF_MAX_BYTES,
    allowedMimeTypes: ["application/pdf"],
  });

  for (const environment of [
    { ...BASE_ENVIRONMENT, PAPERPILOT_SUPABASE_PROJECT_REF: "other" },
    { ...BASE_ENVIRONMENT, PAPERPILOT_SUPABASE_URL: "https://example.com" },
    { ...BASE_ENVIRONMENT, PAPERPILOT_SUPABASE_STORAGE_BUCKET: "public" },
  ]) {
    assert.throws(
      () => paperPilotSupabaseStorageConfiguration(environment),
      /approved PaperPilot Supabase value/,
    );
  }
});

test("Storage authority accepts only a server-side modern secret key", () => {
  const secretKey = `sb_secret_${"a".repeat(32)}`;
  assert.equal(
    paperPilotSupabaseStorageConfiguration(
      { ...BASE_ENVIRONMENT, PAPERPILOT_SUPABASE_SECRET_KEY: secretKey },
      { requireSecret: true },
    ).secretKey,
    secretKey,
  );
  assert.throws(
    () => paperPilotSupabaseStorageConfiguration(BASE_ENVIRONMENT, { requireSecret: true }),
    /server-only sb_secret_/,
  );
  for (const forbidden of [
    "NEXT_PUBLIC_SUPABASE_SECRET_KEY",
    "PAPERPILOT_SUPABASE_SERVICE_ROLE_KEY",
  ]) {
    assert.throws(
      () => paperPilotSupabaseStorageConfiguration({
        ...BASE_ENVIRONMENT,
        [forbidden]: "configured",
      }),
      /forbidden/,
    );
  }
});
