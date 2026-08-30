-- A crawler receipt identifies one immutable acquisition attempt, not the
-- mutable remote URL across all time. CrawlerImport retains the canonical URL
-- and its domain-separated SHA-256 authority; the compound receipt FK binds
-- the attempt back to that private authority. Keeping the receipt fingerprint
-- attempt-specific preserves the global source-fingerprint uniqueness contract
-- while allowing a new explicit command after a post-quarantine terminal
-- failure at the same URL.
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
  'Binds one attempt-specific crawler receipt to its immutable CrawlerImport URL authority and written ingress attempt.';
