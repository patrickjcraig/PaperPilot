import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const enumMigration = readFileSync(
  new URL(
    "../../prisma/migrations/20260830183000_supabase_storage_provider/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const custodyMigration = readFileSync(
  new URL(
    "../../prisma/migrations/20260830184500_supabase_storage_custody_guards/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("Supabase Storage enum commits in an earlier column-free migration", () => {
  assert.match(
    enumMigration,
    /ALTER TYPE "AssetStorageProvider" ADD VALUE IF NOT EXISTS 'SUPABASE_STORAGE';/u,
  );
  assert.doesNotMatch(enumMigration, /Asset_supabase_storage_shape_check/u);
  assert.doesNotMatch(enumMigration, /(?:ADD|DROP) COLUMN|CREATE TABLE/iu);
});

test("Supabase assets have an exact private object shape and immutable admission", () => {
  assert.match(custodyMigration, /CONSTRAINT "Asset_supabase_storage_shape_check"/u);
  assert.match(custodyMigration, /"bucket" IS NOT NULL/u);
  assert.match(custodyMigration, /"bucket" = 'paperpilot-private-pdfs'/u);
  assert.match(custodyMigration, /"physicalLocator" IS NULL/u);
  assert.match(
    custodyMigration,
    /\^tenants\/\[a-f0-9\]\{64\}\/assets\/\[a-f0-9\]\{64\}\/attempts\/\[a-f0-9\]\{64\}\/original\[\.\]pdf\$/u,
  );
  assert.match(custodyMigration, /"status" NOT IN \('QUARANTINED', 'SCANNING', 'READY'\)/u);
  assert.match(custodyMigration, /"mimeType" IS NOT NULL/u);
  assert.match(custodyMigration, /octet_length\("etag"\) BETWEEN 1 AND 255/u);
  assert.match(custodyMigration, /CREATE FUNCTION "Asset_supabase_storage_update_guard"/u);
  assert.match(custodyMigration, /OLD\."status" <> 'UPLOADING'/u);
  assert.match(custodyMigration, /NEW\."status" = 'UPLOADING'/u);
  assert.match(
    custodyMigration,
    /NEW\."storageProvider"[\s\S]*NEW\."bucket"[\s\S]*NEW\."objectKey"[\s\S]*NEW\."createdAt"[\s\S]*OLD\."storageProvider"[\s\S]*OLD\."bucket"[\s\S]*OLD\."objectKey"[\s\S]*OLD\."createdAt"/u,
  );
  assert.match(
    custodyMigration,
    /OLD\."status" <> 'UPLOADING'[\s\S]*NEW\."sizeBytes"[\s\S]*NEW\."sha256"[\s\S]*NEW\."etag"/u,
  );
});

test("upload attempt identity and observed receipt fields are immutable", () => {
  assert.match(custodyMigration, /CREATE FUNCTION "UploadAttempt_update_guard"/u);
  for (const field of [
    "id",
    "organizationId",
    "uploadSessionId",
    "assetId",
    "attemptNumber",
    "storageKey",
    "expectedSizeBytes",
    "createdAt",
  ]) {
    assert.match(custodyMigration, new RegExp(`NEW\\."${field}"`, "u"));
    assert.match(custodyMigration, new RegExp(`OLD\\."${field}"`, "u"));
  }
  assert.match(custodyMigration, /OLD\."status" = 'COMMITTED'/u);
  assert.match(
    custodyMigration,
    /FROM public\."DocumentIngestReceipt" AS receipt[\s\S]*receipt\."uploadAttemptId" = OLD\."id"/u,
  );
  assert.match(
    custodyMigration,
    /NEW\."receivedSizeBytes"[\s\S]*NEW\."sha256"[\s\S]*NEW\."storedAt"[\s\S]*OLD\."receivedSizeBytes"[\s\S]*OLD\."sha256"[\s\S]*OLD\."storedAt"/u,
  );
  assert.match(
    custodyMigration,
    /CONSTRAINT = 'UploadAttempt_receipt_immutable_check'/u,
  );
});

test("Supabase ingest receipts bind the immutable asset ETag and protocol", () => {
  assert.match(
    custodyMigration,
    /CREATE FUNCTION "DocumentIngestReceipt_supabase_storage_guard"/u,
  );
  assert.match(
    custodyMigration,
    /NEW\."storageVersion" <> 'supabase-private-object-v1'/u,
  );
  assert.match(custodyMigration, /NEW\."sourceEtag" IS NULL/u);
  assert.match(custodyMigration, /NEW\."storageAuthorityGeneration" IS NOT NULL/u);
  assert.match(custodyMigration, /asset\."etag" = NEW\."sourceEtag"/u);
  assert.match(
    custodyMigration,
    /asset\."status" IN \('QUARANTINED', 'SCANNING', 'READY'\)/u,
  );
  assert.match(
    custodyMigration,
    /ELSIF NEW\."storageVersion" = 'supabase-private-object-v1'/u,
  );
});

test("custody migration is additive, column-free, and contains no capability secret", () => {
  assert.doesNotMatch(custodyMigration, /(?:ADD|DROP) COLUMN|CREATE TABLE|DROP TABLE/iu);
  assert.doesNotMatch(custodyMigration, /signed[_ -]?url|service[_ -]?role|upload[_ -]?token/iu);
  assert.match(custodyMigration, /\bBEGIN;/u);
  assert.match(
    custodyMigration.trimEnd(),
    /ADD CONSTRAINT "Asset_supabase_storage_shape_check"[\s\S]*\);\s*COMMIT;$/u,
  );
});
