-- Bind governed crawler bytes and deletion proof to one immutable canonical
-- local-quarantine root generation. Existing pre-authority rows deliberately
-- remain NULL: they are readable for audit, but fail closed for new deletion
-- certification until an operator reconciles them at the original root.

ALTER TABLE "CrawlerImport"
  ADD COLUMN "storageAuthorityGeneration" CHAR(64),
  ADD COLUMN "deletionStorageAuthorityGeneration" CHAR(64),
  ADD COLUMN "deletionTombstoneDigest" CHAR(64);

ALTER TABLE "DocumentIngressAttempt"
  ADD COLUMN "storageAuthorityGeneration" CHAR(64);

ALTER TABLE "DocumentIngestReceipt"
  ADD COLUMN "storageAuthorityGeneration" CHAR(64);

DO $block$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "CrawlerImport"
    WHERE "custodyStatus" = 'DELETED'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Pre-authority crawler deletion proofs require explicit operator reconciliation at their original quarantine roots before this migration can proceed.';
  END IF;
END;
$block$;

ALTER TABLE "CrawlerImport"
  ADD CONSTRAINT "CrawlerImport_storage_authority_generation_check" CHECK (
    "storageAuthorityGeneration" IS NULL
    OR "storageAuthorityGeneration" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "CrawlerImport_deletion_storage_authority_check" CHECK (
    (
      "deletionStorageAuthorityGeneration" IS NULL
      AND "deletionTombstoneDigest" IS NULL
    )
    OR (
      "deletionStorageAuthorityGeneration" ~ '^[0-9a-f]{64}$'
      AND "deletionTombstoneDigest" ~ '^[0-9a-f]{64}$'
    )
  );

ALTER TABLE "DocumentIngressAttempt"
  ADD CONSTRAINT "DocumentIngressAttempt_storage_authority_generation_check" CHECK (
    "storageAuthorityGeneration" IS NULL
    OR "storageAuthorityGeneration" ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE "DocumentIngestReceipt"
  ADD CONSTRAINT "DocumentIngestReceipt_storage_authority_generation_check" CHECK (
    "storageAuthorityGeneration" IS NULL
    OR "storageAuthorityGeneration" ~ '^[0-9a-f]{64}$'
  );

COMMENT ON COLUMN "CrawlerImport"."storageAuthorityGeneration" IS
  'Immutable canonical local-quarantine root generation selected by the first governed crawler claim; NULL denotes unbound legacy authority.';
COMMENT ON COLUMN "CrawlerImport"."deletionStorageAuthorityGeneration" IS
  'Canonical local-quarantine root generation that emitted the custody tombstone and physical absence proof.';
COMMENT ON COLUMN "CrawlerImport"."deletionTombstoneDigest" IS
  'URL-free SHA-256 digest of the persistent asset-level local-quarantine deletion tombstone.';
COMMENT ON COLUMN "DocumentIngressAttempt"."storageAuthorityGeneration" IS
  'Immutable canonical local-quarantine root generation admitted before this crawler attempt could receive bytes.';
COMMENT ON COLUMN "DocumentIngestReceipt"."storageAuthorityGeneration" IS
  'Immutable canonical local-quarantine root generation copied from the adopted crawler attempt.';

CREATE FUNCTION "public"."CrawlerImport_storage_authority_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."storageAuthorityGeneration" IS NOT NULL
       OR NEW."deletionStorageAuthorityGeneration" IS NOT NULL
       OR NEW."deletionTombstoneDigest" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_initial_storage_authority_check',
        MESSAGE = 'Crawler storage authority is selected only by a durable worker claim.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."storageAuthorityGeneration" IS DISTINCT FROM OLD."storageAuthorityGeneration"
     AND NOT (
       OLD."storageAuthorityGeneration" IS NULL
       AND NEW."storageAuthorityGeneration" ~ '^[0-9a-f]{64}$'
       AND OLD."custodyStatus" = 'RETAINED'
       AND NEW."custodyStatus" = 'RETAINED'
       AND OLD."status" = 'QUEUED'
       AND NEW."status" = 'FETCHING'
       AND NOT EXISTS (
         SELECT 1
         FROM "public"."DocumentIngressAttempt" AS attempt
         WHERE attempt."organizationId" = OLD."organizationId"
           AND attempt."jobId" = OLD."crawlJobId"
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_storage_authority_immutable_check',
      MESSAGE = 'Crawler storage authority is immutable after its first worker claim.';
  END IF;

  IF ROW(
    NEW."deletionStorageAuthorityGeneration",
    NEW."deletionTombstoneDigest"
  ) IS DISTINCT FROM ROW(
    OLD."deletionStorageAuthorityGeneration",
    OLD."deletionTombstoneDigest"
  ) THEN
    IF NOT (
      OLD."custodyStatus" = 'DELETE_PENDING'
      AND NEW."custodyStatus" = 'DELETED'
      AND OLD."deletionStorageAuthorityGeneration" IS NULL
      AND OLD."deletionTombstoneDigest" IS NULL
      AND NEW."deletionStorageAuthorityGeneration" ~ '^[0-9a-f]{64}$'
      AND NEW."deletionTombstoneDigest" ~ '^[0-9a-f]{64}$'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_deletion_storage_proof_immutable_check',
        MESSAGE = 'Crawler storage deletion authority and tombstone proof are immutable.';
    END IF;
  END IF;

  IF OLD."custodyStatus" = 'DELETE_PENDING' AND NEW."custodyStatus" = 'DELETED' THEN
    IF NEW."deletionStorageAuthorityGeneration" IS NULL
       OR NEW."deletionTombstoneDigest" IS NULL
       OR (
         NEW."storageAuthorityGeneration" IS NOT NULL
         AND NEW."storageAuthorityGeneration" <> NEW."deletionStorageAuthorityGeneration"
       )
       OR EXISTS (
         SELECT 1
         FROM "public"."DocumentIngressAttempt" AS attempt
         WHERE attempt."organizationId" = NEW."organizationId"
           AND attempt."intakeId" = NEW."intakeId"
           AND attempt."storageAuthorityGeneration" IS DISTINCT FROM
             NEW."deletionStorageAuthorityGeneration"
       )
       OR EXISTS (
         SELECT 1
         FROM "public"."DocumentIngestReceipt" AS receipt
         WHERE receipt."organizationId" = NEW."organizationId"
           AND receipt."crawlerImportId" = NEW."id"
           AND receipt."storageAuthorityGeneration" IS DISTINCT FROM
             NEW."deletionStorageAuthorityGeneration"
       )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_deletion_storage_authority_proof_check',
        MESSAGE = 'Crawler deletion proof must match every immutable storage authority generation.';
    END IF;
  ELSIF NEW."custodyStatus" <> 'DELETED' AND (
    NEW."deletionStorageAuthorityGeneration" IS NOT NULL
    OR NEW."deletionTombstoneDigest" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_premature_deletion_storage_proof_check',
      MESSAGE = 'Crawler deletion storage proof is recorded only at proven deletion.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER "CrawlerImport_storage_authority_guard_trigger"
BEFORE INSERT OR UPDATE ON "CrawlerImport"
FOR EACH ROW
EXECUTE FUNCTION "public"."CrawlerImport_storage_authority_guard"();

CREATE FUNCTION "public"."DocumentIngressAttempt_storage_authority_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."storageAuthorityGeneration" IS DISTINCT FROM
       OLD."storageAuthorityGeneration" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'DocumentIngressAttempt_storage_authority_immutable_check',
        MESSAGE = 'Document ingress storage authority is immutable.';
    END IF;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."Job" AS job
    WHERE job."organizationId" = NEW."organizationId"
      AND job."id" = NEW."jobId"
      AND job."type" = 'CRAWL'
  ) AND NOT EXISTS (
    SELECT 1
    FROM "public"."CrawlerImport" AS crawler
    WHERE crawler."organizationId" = NEW."organizationId"
      AND crawler."crawlJobId" = NEW."jobId"
      AND crawler."intakeId" = NEW."intakeId"
      AND crawler."documentId" = NEW."documentId"
      AND crawler."assetId" = NEW."assetId"
      AND crawler."storageAuthorityGeneration" IS NOT NULL
      AND crawler."storageAuthorityGeneration" = NEW."storageAuthorityGeneration"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'DocumentIngressAttempt_crawler_storage_authority_check',
      MESSAGE = 'A crawler ingress attempt must match its immutable storage-root authority.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "DocumentIngressAttempt_storage_authority_guard_trigger"
BEFORE INSERT OR UPDATE OF "storageAuthorityGeneration" ON "DocumentIngressAttempt"
FOR EACH ROW
EXECUTE FUNCTION "public"."DocumentIngressAttempt_storage_authority_guard"();

-- Extend the existing crawler receipt admission guard with exact root
-- generation equality. Receipt immutability automatically protects the added
-- column because its guard compares the complete row via to_jsonb.
CREATE OR REPLACE FUNCTION "public"."DocumentIngestReceipt_crawler_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW."source" = 'CRAWLER' AND NOT EXISTS (
    SELECT 1
    FROM "public"."CrawlerImport" AS crawl
    JOIN "public"."DocumentIngressAttempt" AS attempt
      ON attempt."organizationId" = crawl."organizationId"
     AND attempt."id" = NEW."ingressAttemptId"
     AND attempt."intakeId" = crawl."intakeId"
     AND attempt."documentId" = crawl."documentId"
     AND attempt."assetId" = crawl."assetId"
    WHERE crawl."organizationId" = NEW."organizationId"
      AND crawl."id" = NEW."crawlerImportId"
      AND crawl."intakeId" = NEW."intakeId"
      AND crawl."documentId" = NEW."documentId"
      AND crawl."assetId" = NEW."assetId"
      AND crawl."inboxEntryId" = NEW."inboxEntryId"
      AND crawl."importBatchId" = NEW."importBatchId"
      AND NEW."sourceFingerprint" = 'crawler-import:' || crawl."id"
      AND crawl."requestedById" IS NOT DISTINCT FROM NEW."requestedById"
      AND NEW."integrationConnectionId" IS NULL
      AND NEW."sourceChecksumAlgorithm" IS NULL
      AND NEW."sourceChecksum" IS NULL
      AND NEW."declaredMimeType" = 'application/pdf'
      AND NEW."receivedSizeBytes" <= crawl."maximumSizeBytes"
      AND attempt."jobId" = crawl."crawlJobId"
      AND attempt."maximumSizeBytes" = crawl."maximumSizeBytes"
      AND attempt."receivedSizeBytes" = NEW."receivedSizeBytes"
      AND attempt."sha256" = NEW."sha256"
      AND attempt."storageVersion" = NEW."storageVersion"
      AND attempt."storageAuthorityGeneration" IS NOT NULL
      AND attempt."storageAuthorityGeneration" = crawl."storageAuthorityGeneration"
      AND attempt."storageAuthorityGeneration" = NEW."storageAuthorityGeneration"
      AND attempt."storedAt" = NEW."storedAt"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'DocumentIngestReceipt_crawler_authority_check',
      MESSAGE = 'The crawler receipt does not match its command and written ingress attempt.';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION "public"."DocumentIngestReceipt_crawler_guard"() IS
  'Binds one crawler receipt to its immutable command, ingress attempt, byte identity, and canonical local-storage root generation.';
