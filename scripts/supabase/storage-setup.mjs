import "dotenv/config";

import { pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { paperPilotSupabaseStorageConfiguration } from "../../src/lib/supabase-storage-config.mjs";

function storageClient(configuration, createClientImpl) {
  return createClientImpl(configuration.url, configuration.secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { "X-Client-Info": "paperpilot-storage-setup/1" } },
  });
}

function exactBucket(bucket, configuration) {
  return bucket
    && bucket.id === configuration.bucket
    && bucket.name === configuration.bucket
    && bucket.public === false
    && bucket.file_size_limit === configuration.maxFileSizeBytes
    && Array.isArray(bucket.allowed_mime_types)
    && bucket.allowed_mime_types.length === configuration.allowedMimeTypes.length
    && configuration.allowedMimeTypes.every((value) =>
      bucket.allowed_mime_types.includes(value));
}

export async function inspectOrApplyPaperPilotStorage({
  environment = process.env,
  apply = false,
  createClientImpl = createClient,
} = {}) {
  const configuration = paperPilotSupabaseStorageConfiguration(environment, {
    requireSecret: true,
  });
  const client = storageClient(configuration, createClientImpl);
  let result = await client.storage.getBucket(configuration.bucket);

  if (apply && result.error && result.error.status === 404) {
    const created = await client.storage.createBucket(configuration.bucket, {
      public: false,
      fileSizeLimit: configuration.maxFileSizeBytes,
      allowedMimeTypes: [...configuration.allowedMimeTypes],
    });
    if (created.error) throw new Error("The private Supabase bucket could not be created.");
    result = await client.storage.getBucket(configuration.bucket);
  } else if (apply && result.data && !exactBucket(result.data, configuration)) {
    const updated = await client.storage.updateBucket(configuration.bucket, {
      public: false,
      fileSizeLimit: configuration.maxFileSizeBytes,
      allowedMimeTypes: [...configuration.allowedMimeTypes],
    });
    if (updated.error) throw new Error("The private Supabase bucket could not be reconciled.");
    result = await client.storage.getBucket(configuration.bucket);
  }

  if (result.error || !exactBucket(result.data, configuration)) {
    throw new Error(
      apply
        ? "The private Supabase bucket did not reach its exact policy."
        : "The private Supabase bucket is absent or does not match its exact policy.",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    status: apply ? "private_storage_reconciled" : "private_storage_ready",
    projectRef: configuration.projectRef,
    bucket: configuration.bucket,
    public: false,
    maxFileSizeBytes: configuration.maxFileSizeBytes,
    allowedMimeTypes: configuration.allowedMimeTypes,
  });
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || (arguments_[0] && arguments_[0] !== "--apply")) {
    throw new Error("Usage: storage-setup.mjs [--apply]");
  }
  const result = await inspectOrApplyPaperPilotStorage({
    apply: arguments_[0] === "--apply",
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "blocked",
      code: "supabase_private_storage_not_ready",
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
