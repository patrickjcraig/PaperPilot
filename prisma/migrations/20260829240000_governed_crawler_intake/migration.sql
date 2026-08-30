-- First-mode governed crawler admission. This migration adds durable command
-- authority only: it does not grant network access or make a job payload an
-- authorization source. Every fetch must later be implemented against the
-- immutable row and the existing intake/attempt/receipt custody graph.

CREATE TYPE "CrawlerRightsGrant" AS ENUM (
  'INDEFINITE_RESEARCH_CUSTODY'
);

CREATE TYPE "CrawlerRobotsPolicy" AS ENUM (
  'RESPECT_RFC9309'
);

CREATE TYPE "CrawlerRetentionPolicy" AS ENUM (
  'INDEFINITE_UNTIL_USER_DELETION'
);

CREATE TYPE "CrawlerImportStatus" AS ENUM (
  'QUEUED',
  'FETCHING',
  'QUARANTINED',
  'VALIDATING',
  'EXTRACTING',
  'READY',
  'ATTENTION',
  'FAILED',
  'CANCELLED'
);

CREATE TABLE "CrawlerImport" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "importBatchId" TEXT NOT NULL,
  "intakeId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "inboxEntryId" TEXT NOT NULL,
  "requestedById" TEXT,
  "requestedByPrincipalId" UUID NOT NULL,
  "clientOperationId" TEXT NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "canonicalSourceUrl" TEXT NOT NULL,
  "sourceUrlFingerprint" CHAR(64) NOT NULL,
  "displayFileName" VARCHAR(255) NOT NULL,
  "rightsGrant" "CrawlerRightsGrant" NOT NULL,
  "rightsAttestationVersion" VARCHAR(100) NOT NULL,
  "rightsAttestedAt" TIMESTAMPTZ(3) NOT NULL,
  "robotsPolicy" "CrawlerRobotsPolicy" NOT NULL,
  "robotsPolicyVersion" VARCHAR(100) NOT NULL,
  "retentionPolicy" "CrawlerRetentionPolicy" NOT NULL,
  "retentionPolicyVersion" VARCHAR(100) NOT NULL,
  "acquisitionMode" VARCHAR(100) NOT NULL,
  "policyVersion" VARCHAR(128) NOT NULL,
  "robotsUserAgent" VARCHAR(64) NOT NULL,
  "maxRedirects" INTEGER NOT NULL,
  "maxDnsAddresses" INTEGER NOT NULL,
  "dnsLookupTimeoutMs" INTEGER NOT NULL,
  "maxResponseHeaderBytes" INTEGER NOT NULL,
  "responseHeaderTimeoutMs" INTEGER NOT NULL,
  "responseIdleTimeoutMs" INTEGER NOT NULL,
  "absoluteDeadlineMs" INTEGER NOT NULL,
  "ratePolicyVersion" VARCHAR(100) NOT NULL,
  "originRequestsPerMinute" INTEGER NOT NULL,
  "originBurst" INTEGER NOT NULL,
  "maximumSizeBytes" BIGINT NOT NULL,
  "policyRevision" INTEGER NOT NULL,
  "status" "CrawlerImportStatus" NOT NULL DEFAULT 'QUEUED',
  "crawlJobId" TEXT NOT NULL,
  "failureCode" VARCHAR(100),
  "retryAt" TIMESTAMPTZ(3),
  "startedAt" TIMESTAMPTZ(3),
  "quarantinedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "cancelledAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "CrawlerImport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CrawlerImport_request_digest_check" CHECK (
    "requestHash" ~ '^[0-9a-f]{64}$'
    AND "sourceUrlFingerprint" ~ '^[0-9a-f]{64}$'
    AND "clientOperationId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  -- Query strings and fragments are outside first-mode authority. The fetcher
  -- must separately enforce public-address, redirect, DNS-rebinding, content,
  -- and robots decisions; this row admits only a canonical HTTPS locator.
  CONSTRAINT "CrawlerImport_canonical_url_check" CHECK (
    octet_length("canonicalSourceUrl") BETWEEN 9 AND 2048
    AND "canonicalSourceUrl" ~ '^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+/[^?#[:space:][:cntrl:]]*$'
    AND octet_length(
      pg_catalog.split_part(pg_catalog.substr("canonicalSourceUrl", 9), '/', 1)
    ) BETWEEN 3 AND 253
    AND position('?' IN "canonicalSourceUrl") = 0
    AND position('#' IN "canonicalSourceUrl") = 0
    AND pg_catalog.strpos("canonicalSourceUrl", pg_catalog.chr(92)) = 0
    AND "canonicalSourceUrl" !~* '%(0[0-9a-f]|1[0-9a-f]|7f|2f|5c|2e)'
    AND "canonicalSourceUrl" !~ '(^|/)[.]{1,2}(/|$)'
    AND "canonicalSourceUrl" !~ '[[:space:][:cntrl:]]'
    AND lower(right("canonicalSourceUrl", 4)) = '.pdf'
  ),
  CONSTRAINT "CrawlerImport_display_filename_check" CHECK (
    octet_length("displayFileName") BETWEEN 5 AND 255
    AND "displayFileName" !~ '[[:cntrl:]]'
    AND pg_catalog.strpos("displayFileName", '/') = 0
    AND pg_catalog.strpos("displayFileName", pg_catalog.chr(92)) = 0
    AND "displayFileName" NOT IN ('.', '..')
    AND lower(right("displayFileName", 4)) = '.pdf'
  ),
  CONSTRAINT "CrawlerImport_governance_contract_check" CHECK (
    "rightsGrant" = 'INDEFINITE_RESEARCH_CUSTODY'
    AND "rightsAttestationVersion" = 'paperpilot-crawler-rights-v1'
    AND "robotsPolicy" = 'RESPECT_RFC9309'
    AND "robotsPolicyVersion" = 'rfc9309-paperpilot-v1'
    AND "retentionPolicy" = 'INDEFINITE_UNTIL_USER_DELETION'
    AND "retentionPolicyVersion" = 'paperpilot-crawler-retention-v1'
    AND "acquisitionMode" = 'EXPLICIT_SINGLE_QUERY_FREE_HTTPS_PDF_V1'
  ),
  CONSTRAINT "CrawlerImport_policy_identity_check" CHECK (
    "policyVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND "robotsUserAgent" ~ '^[A-Za-z_-]{3,64}$'
    AND "ratePolicyVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
  ),
  CONSTRAINT "CrawlerImport_acquisition_bounds_check" CHECK (
    "maxRedirects" BETWEEN 0 AND 3
    AND "maxDnsAddresses" BETWEEN 1 AND 16
    AND "dnsLookupTimeoutMs" BETWEEN 100 AND 10000
    AND "maxResponseHeaderBytes" BETWEEN 1024 AND 65536
    AND "responseHeaderTimeoutMs" BETWEEN 100 AND 15000
    AND "responseIdleTimeoutMs" BETWEEN 100 AND 30000
    AND "absoluteDeadlineMs" BETWEEN 1000 AND 120000
    AND "dnsLookupTimeoutMs" < "absoluteDeadlineMs"
    AND "responseHeaderTimeoutMs" < "absoluteDeadlineMs"
    AND "responseIdleTimeoutMs" < "absoluteDeadlineMs"
    AND "dnsLookupTimeoutMs" + "responseHeaderTimeoutMs" < "absoluteDeadlineMs"
  ),
  CONSTRAINT "CrawlerImport_rate_authority_check" CHECK (
    "originRequestsPerMinute" BETWEEN 1 AND 600
    AND "originBurst" BETWEEN 1 AND 60
    AND "originBurst" <= "originRequestsPerMinute"
  ),
  CONSTRAINT "CrawlerImport_policy_bounds_check" CHECK (
    "maximumSizeBytes" > 0
    AND "policyRevision" >= 0
    AND "rightsAttestedAt" <= "createdAt"
    AND "rightsAttestedAt" >= "createdAt" - INTERVAL '5 minutes'
  ),
  CONSTRAINT "CrawlerImport_terminal_shape_check" CHECK (
    (
      "status" IN ('READY', 'ATTENTION', 'FAILED', 'CANCELLED')
      AND "completedAt" IS NOT NULL
    )
    OR (
      "status" NOT IN ('READY', 'ATTENTION', 'FAILED', 'CANCELLED')
      AND "completedAt" IS NULL
    )
  ),
  CONSTRAINT "CrawlerImport_failure_shape_check" CHECK (
    (
      "status" IN ('FAILED', 'ATTENTION')
      AND "failureCode" IS NOT NULL
      AND octet_length("failureCode") BETWEEN 1 AND 100
      AND "failureCode" !~ '[[:cntrl:]]'
    )
    OR (
      "status" NOT IN ('FAILED', 'ATTENTION')
      AND "failureCode" IS NULL
    )
  ),
  CONSTRAINT "CrawlerImport_retry_shape_check" CHECK (
    "retryAt" IS NULL
    OR (
      "status" = 'FETCHING'
      AND "startedAt" IS NOT NULL
      AND "completedAt" IS NULL
      AND "retryAt" >= "startedAt"
    )
  ),
  CONSTRAINT "CrawlerImport_cancel_shape_check" CHECK (
    ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL)
    OR ("status" <> 'CANCELLED' AND "cancelledAt" IS NULL)
  ),
  CONSTRAINT "CrawlerImport_progress_shape_check" CHECK (
    (
      "status" IN ('FETCHING', 'QUARANTINED', 'VALIDATING', 'EXTRACTING', 'READY', 'ATTENTION')
      AND "startedAt" IS NOT NULL
    )
    OR ("status" = 'QUEUED' AND "startedAt" IS NULL)
    OR "status" IN ('FAILED', 'CANCELLED')
  ),
  CONSTRAINT "CrawlerImport_quarantine_shape_check" CHECK (
    (
      "status" IN ('QUARANTINED', 'VALIDATING', 'EXTRACTING', 'READY', 'ATTENTION')
      AND "quarantinedAt" IS NOT NULL
    )
    OR (
      "status" IN ('QUEUED', 'FETCHING')
      AND "quarantinedAt" IS NULL
    )
    OR "status" IN ('FAILED', 'CANCELLED')
  ),
  CONSTRAINT "CrawlerImport_timestamp_order_check" CHECK (
    (
      "quarantinedAt" IS NULL
      OR ("startedAt" IS NOT NULL AND "quarantinedAt" >= "startedAt")
    )
    AND (
      "completedAt" IS NULL
      OR "startedAt" IS NULL
      OR "completedAt" >= "startedAt"
    )
    AND (
      "completedAt" IS NULL
      OR "quarantinedAt" IS NULL
      OR "completedAt" >= "quarantinedAt"
    )
    AND (
      "cancelledAt" IS NULL
      OR ("completedAt" IS NOT NULL AND "cancelledAt" = "completedAt")
    )
  )
);

COMMENT ON TABLE "CrawlerImport" IS
  'Immutable explicit user crawl authority plus guarded lifecycle; job payloads are non-authoritative.';
COMMENT ON COLUMN "CrawlerImport"."canonicalSourceUrl" IS
  'Canonical HTTPS URL without a query string, fragment, or credentials.';
COMMENT ON COLUMN "CrawlerImport"."sourceUrlFingerprint" IS
  'Domain-separated SHA-256 of the canonical URL; Document and Inbox identities remain attempt-specific.';
COMMENT ON COLUMN "CrawlerImport"."rightsGrant" IS
  'Exact user grant for indefinite PaperPilot research custody.';
COMMENT ON COLUMN "CrawlerImport"."policyVersion" IS
  'Frozen acquisition-policy version; retries must never substitute current deployment defaults.';
COMMENT ON COLUMN "CrawlerImport"."ratePolicyVersion" IS
  'Frozen per-origin rate-policy version paired with the admitted requests-per-minute and burst bounds.';
COMMENT ON COLUMN "CrawlerImport"."retryAt" IS
  'Non-null only while FETCHING is paused in exact Job RETRYING backoff; terminal failures are complete attempts.';

-- The receipt owns the immutable, one-to-one transport binding, matching the
-- established Zotero attachment pattern. Existing non-crawler receipts remain
-- NULL and retain their previous shape.
ALTER TABLE "DocumentIngestReceipt"
  ADD COLUMN "crawlerImportId" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."DocumentIngestReceipt" AS receipt
    WHERE receipt."source" = 'CRAWLER'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot install governed crawler authority over an unbound historical crawler receipt.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "public"."DocumentIntake" AS intake
    WHERE intake."source" = 'CRAWLER'
  ) OR EXISTS (
    SELECT 1
    FROM "public"."Job" AS job
    WHERE job."type" = 'CRAWL'
  ) OR EXISTS (
    SELECT 1
    FROM "public"."ImportBatch" AS batch
    WHERE batch."source" = 'CRAWLER'
  ) OR EXISTS (
    SELECT 1
    FROM "public"."InboxEntry" AS inbox
    WHERE inbox."source" = 'CRAWLER'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot install first-mode crawler authority over ungoverned historical crawler batches, Inbox entries, intake, or jobs.';
  END IF;
END;
$$;

ALTER TABLE "DocumentIngestReceipt"
  DROP CONSTRAINT "DocumentIngestReceipt_source_shape_check",
  ADD CONSTRAINT "DocumentIngestReceipt_source_shape_check" CHECK (
    (
      "source" = 'BROWSER_UPLOAD'
      AND "uploadSessionId" IS NOT NULL
      AND (
        ("uploadAttemptId" IS NOT NULL AND NOT "legacyTransportAttestation")
        OR ("uploadAttemptId" IS NULL AND "legacyTransportAttestation")
      )
      AND "ingressAttemptId" IS NULL
      AND "integrationConnectionId" IS NULL
      AND "zoteroLibraryId" IS NULL
      AND "zoteroObjectId" IS NULL
      AND "zoteroAttachmentImportId" IS NULL
      AND "crawlerImportId" IS NULL
    )
    OR (
      "source" = 'ZOTERO_ATTACHMENT'
      AND "uploadSessionId" IS NULL
      AND "uploadAttemptId" IS NULL
      AND "ingressAttemptId" IS NOT NULL
      AND "integrationConnectionId" IS NOT NULL
      AND "zoteroLibraryId" IS NOT NULL
      AND "zoteroObjectId" IS NOT NULL
      AND "zoteroAttachmentImportId" IS NOT NULL
      AND "crawlerImportId" IS NULL
      AND NOT "legacyTransportAttestation"
    )
    OR (
      "source" = 'CRAWLER'
      AND "uploadSessionId" IS NULL
      AND "uploadAttemptId" IS NULL
      AND "ingressAttemptId" IS NOT NULL
      AND "integrationConnectionId" IS NULL
      AND "zoteroLibraryId" IS NULL
      AND "zoteroObjectId" IS NULL
      AND "zoteroAttachmentImportId" IS NULL
      AND "crawlerImportId" IS NOT NULL
      AND "importBatchId" IS NOT NULL
      AND NOT "legacyTransportAttestation"
    )
    OR (
      "source" = 'WEB_MCP'
      AND "uploadSessionId" IS NULL
      AND "uploadAttemptId" IS NULL
      AND "ingressAttemptId" IS NOT NULL
      AND "zoteroLibraryId" IS NULL
      AND "zoteroObjectId" IS NULL
      AND "zoteroAttachmentImportId" IS NULL
      AND "crawlerImportId" IS NULL
      AND NOT "legacyTransportAttestation"
    )
  );

CREATE UNIQUE INDEX "CrawlerImport_intakeId_key"
  ON "CrawlerImport"("intakeId");
CREATE UNIQUE INDEX "CrawlerImport_importBatchId_key"
  ON "CrawlerImport"("importBatchId");
CREATE UNIQUE INDEX "CrawlerImport_inboxEntryId_key"
  ON "CrawlerImport"("inboxEntryId");
CREATE UNIQUE INDEX "CrawlerImport_crawlJobId_key"
  ON "CrawlerImport"("crawlJobId");
CREATE UNIQUE INDEX "CrawlerImport_organizationId_id_key"
  ON "CrawlerImport"("organizationId", "id");
CREATE UNIQUE INDEX "CrawlerImport_idempotency_key"
  ON "CrawlerImport"("organizationId", "clientOperationId");
CREATE UNIQUE INDEX "CrawlerImport_import_batch_binding_key"
  ON "CrawlerImport"("organizationId", "importBatchId");
CREATE UNIQUE INDEX "CrawlerImport_intake_binding_key"
  ON "CrawlerImport"("organizationId", "documentId", "assetId", "intakeId");
CREATE UNIQUE INDEX "CrawlerImport_inbox_binding_key"
  ON "CrawlerImport"("organizationId", "inboxEntryId");
CREATE UNIQUE INDEX "CrawlerImport_crawl_job_binding_key"
  ON "CrawlerImport"(
    "organizationId", "documentId", "assetId", "intakeId", "crawlJobId"
  );
CREATE UNIQUE INDEX "CrawlerImport_target_binding_key"
  ON "CrawlerImport"(
    "organizationId", "documentId", "assetId", "intakeId", "importBatchId", "id"
  );
CREATE INDEX "CrawlerImport_source_fingerprint_idx"
  ON "CrawlerImport"("organizationId", "sourceUrlFingerprint");
CREATE INDEX "CrawlerImport_organizationId_status_createdAt_idx"
  ON "CrawlerImport"("organizationId", "status", "createdAt");
CREATE INDEX "CrawlerImport_requestedById_idx"
  ON "CrawlerImport"("requestedById");
CREATE INDEX "CrawlerImport_requestedByPrincipalId_idx"
  ON "CrawlerImport"("requestedByPrincipalId");
CREATE INDEX "CrawlerImport_retryAt_idx"
  ON "CrawlerImport"("retryAt");

-- FAILED/CANCELLED immutable attempts release the source for a new explicit
-- command. READY and ATTENTION remain inside the live uniqueness boundary.
CREATE UNIQUE INDEX "CrawlerImport_live_source_fingerprint_key"
  ON "CrawlerImport"("organizationId", "sourceUrlFingerprint")
  WHERE "status" NOT IN ('FAILED', 'CANCELLED');

CREATE UNIQUE INDEX "DocumentIngestReceipt_organizationId_crawlerImportId_key"
  ON "DocumentIngestReceipt"("organizationId", "crawlerImportId");
CREATE UNIQUE INDEX "DocumentIngestReceipt_crawler_import_binding_key"
  ON "DocumentIngestReceipt"(
    "organizationId", "documentId", "assetId", "intakeId", "importBatchId", "crawlerImportId"
  );

ALTER TABLE "CrawlerImport"
  ADD CONSTRAINT "CrawlerImport_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrawlerImport_import_batch_fkey"
    FOREIGN KEY ("organizationId", "importBatchId")
    REFERENCES "ImportBatch"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "CrawlerImport_intake_target_fkey"
    FOREIGN KEY ("organizationId", "documentId", "assetId", "intakeId")
    REFERENCES "DocumentIntake"("organizationId", "documentId", "assetId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "CrawlerImport_organizationId_inboxEntryId_fkey"
    FOREIGN KEY ("organizationId", "inboxEntryId")
    REFERENCES "InboxEntry"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "CrawlerImport_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "CrawlerImport_retained_requester_fkey"
    FOREIGN KEY ("organizationId", "requestedByPrincipalId")
    REFERENCES "RetainedAuditPrincipal"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "CrawlerImport_crawl_job_target_fkey"
    FOREIGN KEY (
      "organizationId", "documentId", "assetId", "intakeId", "crawlJobId"
    ) REFERENCES "Job"(
      "organizationId", "documentId", "assetId", "intakeId", "id"
    ) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "DocumentIngestReceipt"
  ADD CONSTRAINT "DocumentIngestReceipt_crawler_import_target_fkey"
    FOREIGN KEY (
      "organizationId", "documentId", "assetId", "intakeId",
      "importBatchId", "crawlerImportId"
    ) REFERENCES "CrawlerImport"(
      "organizationId", "documentId", "assetId", "intakeId",
      "importBatchId", "id"
    ) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Reuse the retained-principal expand guard. The principal is mandatory for a
-- new crawler command; requestedById remains nullable only so later account
-- deletion can erase the live identity without deleting retained authority.
CREATE TRIGGER "CrawlerImport_00_requester_alignment_trigger"
BEFORE INSERT OR UPDATE ON "CrawlerImport"
FOR EACH ROW
EXECUTE FUNCTION "public"."RetainedAuditPrincipal_actor_alignment_guard"(
  'requestedByPrincipalId', 'requestedById'
);

CREATE FUNCTION "public"."CrawlerImport_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."requestedById" IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_live_requester_check',
        MESSAGE = 'A crawler command requires a live explicit requester.';
    END IF;

    IF NEW."status" <> 'QUEUED'
       OR NEW."failureCode" IS NOT NULL
       OR NEW."retryAt" IS NOT NULL
       OR NEW."startedAt" IS NOT NULL
       OR NEW."quarantinedAt" IS NOT NULL
       OR NEW."completedAt" IS NOT NULL
       OR NEW."cancelledAt" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_initial_lifecycle_check',
        MESSAGE = 'A crawler command must enter the lifecycle in a clean queued state.';
    END IF;

    -- Serialize same-fingerprint admission so the collision check and partial
    -- unique index cannot be raced by two explicit commands.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'paperpilot:crawler:source:' || NEW."organizationId" || ':' ||
          NEW."sourceUrlFingerprint",
        0
      )
    );
    IF EXISTS (
      SELECT 1
      FROM "public"."CrawlerImport" AS historical
      WHERE historical."organizationId" = NEW."organizationId"
        AND historical."sourceUrlFingerprint" = NEW."sourceUrlFingerprint"
        AND historical."canonicalSourceUrl" <> NEW."canonicalSourceUrl"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_source_fingerprint_collision_check',
        MESSAGE = 'A crawler URL fingerprint cannot identify two canonical URLs.';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM "public"."DocumentIntake" AS intake
      JOIN "public"."ImportBatch" AS batch
        ON batch."organizationId" = intake."organizationId"
       AND batch."id" = NEW."importBatchId"
      JOIN "public"."Document" AS document
        ON document."organizationId" = intake."organizationId"
       AND document."id" = intake."documentId"
      JOIN "public"."Asset" AS asset
        ON asset."organizationId" = intake."organizationId"
       AND asset."id" = intake."assetId"
      JOIN "public"."DocumentAsset" AS document_asset
        ON document_asset."organizationId" = intake."organizationId"
       AND document_asset."documentId" = intake."documentId"
       AND document_asset."assetId" = intake."assetId"
       AND document_asset."role" = 'ORIGINAL'
      JOIN "public"."InboxEntry" AS inbox
        ON inbox."organizationId" = intake."organizationId"
       AND inbox."id" = intake."inboxEntryId"
      JOIN "public"."Job" AS job
        ON job."organizationId" = intake."organizationId"
       AND job."id" = NEW."crawlJobId"
      WHERE intake."organizationId" = NEW."organizationId"
        AND intake."id" = NEW."intakeId"
        AND intake."source" = 'CRAWLER'
        AND intake."status" = 'QUEUED'
        AND intake."documentId" = NEW."documentId"
        AND intake."assetId" = NEW."assetId"
        AND intake."inboxEntryId" = NEW."inboxEntryId"
        AND intake."importBatchId" = NEW."importBatchId"
        AND intake."createdById" = NEW."requestedById"
        AND intake."reservedBytes" = NEW."maximumSizeBytes"
        AND intake."policyRevision" = NEW."policyRevision"
        AND document."kind" = 'PAPER_PDF'
        AND document."status" = 'PENDING'
        AND document."sourceUri" = NEW."canonicalSourceUrl"
        AND document."sourceFingerprint" = 'crawler-import:' || NEW."id"
        AND document."mimeType" = 'application/pdf'
        AND asset."status" = 'UPLOADING'
        AND asset."originalFileName" = NEW."displayFileName"
        AND asset."mimeType" = 'application/pdf'
        AND inbox."source" = 'CRAWLER'
        AND inbox."status" = 'NEEDS_REVIEW'
        AND inbox."importBatchId" = NEW."importBatchId"
        AND inbox."documentId" = NEW."documentId"
        AND inbox."sourceUri" = NEW."canonicalSourceUrl"
        AND inbox."sourceKey" = 'crawler-import:' || NEW."id"
        AND inbox."dedupeKey" = 'crawler-import:' || NEW."id"
        AND inbox."createdById" = NEW."requestedById"
        AND inbox."createdByPrincipalId" = NEW."requestedByPrincipalId"
        AND batch."source" = 'CRAWLER'
        AND batch."status" = 'RUNNING'
        AND batch."integrationConnectionId" IS NULL
        AND batch."requestedById" = NEW."requestedById"
        AND batch."externalRequestId" = NEW."id"
        AND batch."totalCount" = 1
        AND batch."processedCount" = 0
        AND batch."successCount" = 0
        AND batch."failureCount" = 0
        AND batch."startedAt" IS NOT NULL
        AND batch."completedAt" IS NULL
        AND job."type" = 'CRAWL'
        AND job."status" = 'QUEUED'
        AND job."documentId" = NEW."documentId"
        AND job."assetId" = NEW."assetId"
        AND job."intakeId" = NEW."intakeId"
        AND job."integrationConnectionId" IS NULL
        AND job."zoteroLibraryId" IS NULL
        AND job."ingestReceiptId" IS NULL
        AND job."createdById" = NEW."requestedById"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_admission_target_check',
        MESSAGE = 'The crawler command does not match one queued crawler target, one-row batch, and job.';
    END IF;
  ELSE
    IF ROW(
      NEW."id", NEW."organizationId", NEW."importBatchId", NEW."intakeId", NEW."documentId",
      NEW."assetId", NEW."inboxEntryId", NEW."requestedByPrincipalId",
      NEW."clientOperationId", NEW."requestHash", NEW."canonicalSourceUrl",
      NEW."sourceUrlFingerprint", NEW."displayFileName", NEW."rightsGrant",
      NEW."rightsAttestationVersion", NEW."rightsAttestedAt",
      NEW."robotsPolicy", NEW."robotsPolicyVersion", NEW."retentionPolicy",
      NEW."retentionPolicyVersion", NEW."acquisitionMode", NEW."policyVersion",
      NEW."robotsUserAgent", NEW."maxRedirects", NEW."maxDnsAddresses",
      NEW."dnsLookupTimeoutMs", NEW."maxResponseHeaderBytes",
      NEW."responseHeaderTimeoutMs", NEW."responseIdleTimeoutMs",
      NEW."absoluteDeadlineMs", NEW."ratePolicyVersion",
      NEW."originRequestsPerMinute", NEW."originBurst", NEW."maximumSizeBytes",
      NEW."policyRevision", NEW."crawlJobId", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
      OLD."id", OLD."organizationId", OLD."importBatchId", OLD."intakeId", OLD."documentId",
      OLD."assetId", OLD."inboxEntryId", OLD."requestedByPrincipalId",
      OLD."clientOperationId", OLD."requestHash", OLD."canonicalSourceUrl",
      OLD."sourceUrlFingerprint", OLD."displayFileName", OLD."rightsGrant",
      OLD."rightsAttestationVersion", OLD."rightsAttestedAt",
      OLD."robotsPolicy", OLD."robotsPolicyVersion", OLD."retentionPolicy",
      OLD."retentionPolicyVersion", OLD."acquisitionMode", OLD."policyVersion",
      OLD."robotsUserAgent", OLD."maxRedirects", OLD."maxDnsAddresses",
      OLD."dnsLookupTimeoutMs", OLD."maxResponseHeaderBytes",
      OLD."responseHeaderTimeoutMs", OLD."responseIdleTimeoutMs",
      OLD."absoluteDeadlineMs", OLD."ratePolicyVersion",
      OLD."originRequestsPerMinute", OLD."originBurst", OLD."maximumSizeBytes",
      OLD."policyRevision", OLD."crawlJobId", OLD."createdAt"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_immutable_authority_check',
        MESSAGE = 'Crawler admission, governance, target, and job authority are immutable.';
    END IF;

    IF NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
       AND NOT (
         OLD."requestedById" IS NOT NULL
         AND NEW."requestedById" IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM "public"."User" AS deleted_user
           WHERE deleted_user."id" = OLD."requestedById"
         )
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_requester_immutability_check',
        MESSAGE = 'The crawler requester may only detach through User deletion.';
    END IF;

    IF OLD."startedAt" IS NOT NULL
       AND NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_started_at_immutable_check',
        MESSAGE = 'Crawler fetch start time is immutable once recorded.';
    END IF;
    IF OLD."quarantinedAt" IS NOT NULL
       AND NEW."quarantinedAt" IS DISTINCT FROM OLD."quarantinedAt" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_quarantined_at_immutable_check',
        MESSAGE = 'Crawler quarantine time is immutable once recorded.';
    END IF;
    IF OLD."status" IN ('READY', 'FAILED', 'CANCELLED') AND ROW(
      NEW."status", NEW."failureCode", NEW."retryAt", NEW."startedAt",
      NEW."quarantinedAt", NEW."completedAt", NEW."cancelledAt"
    ) IS DISTINCT FROM ROW(
      OLD."status", OLD."failureCode", OLD."retryAt", OLD."startedAt",
      OLD."quarantinedAt", OLD."completedAt", OLD."cancelledAt"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_terminal_immutable_check',
        MESSAGE = 'A terminal crawler lifecycle cannot be reopened or rewritten.';
    END IF;
    IF OLD."status" = 'ATTENTION'
       AND NEW."status" = 'ATTENTION'
       AND ROW(
         NEW."failureCode", NEW."retryAt", NEW."startedAt",
         NEW."quarantinedAt", NEW."completedAt", NEW."cancelledAt"
       ) IS DISTINCT FROM ROW(
         OLD."failureCode", OLD."retryAt", OLD."startedAt",
         OLD."quarantinedAt", OLD."completedAt", OLD."cancelledAt"
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_attention_immutable_check',
        MESSAGE = 'An attention record changes only through an allowed lifecycle transition.';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
      (OLD."status" = 'QUEUED' AND NEW."status" IN ('FETCHING', 'FAILED', 'CANCELLED'))
      OR (OLD."status" = 'FETCHING' AND NEW."status" IN ('QUARANTINED', 'FAILED', 'CANCELLED'))
      OR (OLD."status" = 'QUARANTINED' AND NEW."status" IN ('VALIDATING', 'FAILED', 'CANCELLED'))
      OR (OLD."status" = 'VALIDATING' AND NEW."status" IN ('EXTRACTING', 'ATTENTION', 'FAILED', 'CANCELLED'))
      OR (OLD."status" = 'EXTRACTING' AND NEW."status" IN ('READY', 'ATTENTION', 'FAILED', 'CANCELLED'))
      OR (OLD."status" = 'ATTENTION' AND NEW."status" IN ('VALIDATING', 'EXTRACTING', 'READY', 'FAILED', 'CANCELLED'))
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_status_transition_check',
        MESSAGE = 'The crawler import status transition is not allowed.';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER "CrawlerImport_guard_trigger"
BEFORE INSERT OR UPDATE ON "CrawlerImport"
FOR EACH ROW
EXECUTE FUNCTION "public"."CrawlerImport_guard"();

-- A bound Job cannot be repurposed after crawler admission. The composite FK
-- already freezes target IDs; this reciprocal guard also freezes its job type.
CREATE FUNCTION "public"."CrawlerImport_job_authority_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."CrawlerImport" AS crawl
    WHERE crawl."organizationId" = NEW."organizationId"
      AND crawl."crawlJobId" = NEW."id"
      AND (
        NEW."type" <> 'CRAWL'
        OR NEW."documentId" IS DISTINCT FROM crawl."documentId"
        OR NEW."assetId" IS DISTINCT FROM crawl."assetId"
        OR NEW."intakeId" IS DISTINCT FROM crawl."intakeId"
        OR NEW."integrationConnectionId" IS NOT NULL
        OR NEW."zoteroLibraryId" IS NOT NULL
        OR NEW."ingestReceiptId" IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_job_authority_check',
      MESSAGE = 'A crawler job cannot be repurposed outside its admitted intake target.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "CrawlerImport_job_authority_guard_trigger"
BEFORE UPDATE ON "Job"
FOR EACH ROW
EXECUTE FUNCTION "public"."CrawlerImport_job_authority_guard"();

-- Commit-time status synchronization lets the worker update the source
-- lifecycle, shared intake, and receipt in either statement order inside one
-- transaction while preventing a durable split-brain state.
CREATE FUNCTION "public"."CrawlerImport_consistency_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."CrawlerImport" AS crawl
    JOIN "public"."DocumentIntake" AS intake
      ON intake."organizationId" = crawl."organizationId"
     AND intake."id" = crawl."intakeId"
     AND intake."documentId" = crawl."documentId"
     AND intake."assetId" = crawl."assetId"
    WHERE crawl."organizationId" = NEW."organizationId"
      AND crawl."id" = NEW."id"
      AND NOT (
        (crawl."status" = 'QUEUED' AND intake."status" = 'QUEUED')
        OR (crawl."status" = 'FETCHING' AND intake."status" = 'RECEIVING')
        OR (crawl."status" = 'QUARANTINED' AND intake."status" = 'QUARANTINED')
        OR (crawl."status" = 'VALIDATING' AND intake."status" = 'VALIDATING')
        OR (crawl."status" = 'EXTRACTING' AND intake."status" = 'EXTRACTING')
        OR (crawl."status" = 'READY' AND intake."status" = 'READY')
        OR (crawl."status" = 'ATTENTION' AND intake."status" = 'ATTENTION')
        OR (crawl."status" = 'FAILED' AND intake."status" = 'FAILED')
        OR (crawl."status" = 'CANCELLED' AND intake."status" = 'CANCELLED')
        OR (
          crawl."status" IN ('QUEUED', 'FETCHING', 'QUARANTINED', 'VALIDATING', 'EXTRACTING', 'ATTENTION')
          AND intake."status" = 'CANCEL_REQUESTED'
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_intake_status_check',
      MESSAGE = 'Crawler and source-neutral intake lifecycle states must agree at commit.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."CrawlerImport" AS crawl
    WHERE crawl."organizationId" = NEW."organizationId"
      AND crawl."id" = NEW."id"
      AND NOT EXISTS (
        SELECT 1
        FROM "public"."ImportBatch" AS batch
        WHERE batch."organizationId" = crawl."organizationId"
          AND batch."id" = crawl."importBatchId"
          AND batch."source" = 'CRAWLER'
          AND batch."integrationConnectionId" IS NULL
          AND batch."requestedById" IS NOT DISTINCT FROM crawl."requestedById"
          AND batch."externalRequestId" = crawl."id"
          AND batch."totalCount" = 1
          AND batch."startedAt" IS NOT NULL
          AND (
            (
              crawl."status" IN ('QUEUED', 'FETCHING', 'QUARANTINED', 'VALIDATING', 'EXTRACTING')
              AND batch."status" = 'RUNNING'
              AND batch."processedCount" = 0
              AND batch."successCount" = 0
              AND batch."failureCount" = 0
              AND batch."completedAt" IS NULL
            )
            OR (
              crawl."status" = 'READY'
              AND batch."status" = 'SUCCEEDED'
              AND batch."processedCount" = 1
              AND batch."successCount" = 1
              AND batch."failureCount" = 0
              AND (batch."completedAt" AT TIME ZONE 'UTC') = crawl."completedAt"
            )
            OR (
              crawl."status" = 'ATTENTION'
              AND batch."status" = 'PARTIAL'
              AND batch."processedCount" = 1
              AND batch."successCount" = 0
              AND batch."failureCount" = 1
              AND (batch."completedAt" AT TIME ZONE 'UTC') = crawl."completedAt"
            )
            OR (
              crawl."status" = 'FAILED'
              AND batch."status" = 'FAILED'
              AND batch."processedCount" = 1
              AND batch."successCount" = 0
              AND batch."failureCount" = 1
              AND (batch."completedAt" AT TIME ZONE 'UTC') = crawl."completedAt"
            )
            OR (
              crawl."status" = 'CANCELLED'
              AND batch."status" = 'CANCELLED'
              AND batch."processedCount" = 0
              AND batch."successCount" = 0
              AND batch."failureCount" = 0
              AND (batch."completedAt" AT TIME ZONE 'UTC') = crawl."completedAt"
            )
          )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_batch_lifecycle_check',
      MESSAGE = 'Crawler command and one-row import batch authority must agree at commit.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."CrawlerImport" AS crawl
    JOIN "public"."Job" AS job
      ON job."organizationId" = crawl."organizationId"
     AND job."id" = crawl."crawlJobId"
    WHERE crawl."organizationId" = NEW."organizationId"
      AND crawl."id" = NEW."id"
      AND NOT (
        (crawl."status" = 'QUEUED' AND crawl."retryAt" IS NULL AND job."status" = 'QUEUED')
        OR (
          crawl."status" = 'FETCHING'
          AND crawl."retryAt" IS NULL
          AND job."status" = 'RUNNING'
        )
        OR (
          crawl."status" = 'FETCHING'
          AND crawl."retryAt" IS NOT NULL
          AND job."status" = 'RETRYING'
          AND (job."runAfter" AT TIME ZONE 'UTC') = crawl."retryAt"
        )
        OR (
          crawl."status" IN ('QUARANTINED', 'VALIDATING', 'EXTRACTING', 'READY', 'ATTENTION')
          AND job."status" = 'SUCCEEDED'
        )
        OR (
          crawl."status" = 'FAILED'
          AND job."status" IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTER')
        )
        OR (
          crawl."status" = 'CANCELLED'
          AND job."status" IN ('SUCCEEDED', 'CANCELLED')
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_job_status_check',
      MESSAGE = 'Crawler command and crawl job lifecycle states must agree at commit.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."CrawlerImport" AS crawl
    WHERE crawl."organizationId" = NEW."organizationId"
      AND crawl."id" = NEW."id"
      AND (
        crawl."status" IN ('QUARANTINED', 'VALIDATING', 'EXTRACTING', 'READY', 'ATTENTION')
        OR (
          crawl."status" IN ('FAILED', 'CANCELLED')
          AND crawl."quarantinedAt" IS NOT NULL
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "public"."DocumentIngestReceipt" AS receipt
        WHERE receipt."organizationId" = crawl."organizationId"
          AND receipt."crawlerImportId" = crawl."id"
          AND receipt."source" = 'CRAWLER'
          AND receipt."documentId" = crawl."documentId"
          AND receipt."assetId" = crawl."assetId"
          AND receipt."intakeId" = crawl."intakeId"
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_receipt_required_check',
      MESSAGE = 'A quarantined or later crawler lifecycle requires its immutable ingest receipt.';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "CrawlerImport_consistency_constraint"
AFTER INSERT OR UPDATE ON "CrawlerImport"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "public"."CrawlerImport_consistency_check"();

-- Preserve the attempt-specific target envelope while still permitting each
-- target's ordinary lifecycle/status fields to advance.
CREATE FUNCTION "public"."CrawlerImport_target_identity_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'Document' THEN
    IF EXISTS (
      SELECT 1
      FROM "public"."Document" AS document
      JOIN "public"."CrawlerImport" AS crawl
        ON crawl."organizationId" = document."organizationId"
       AND crawl."documentId" = document."id"
      WHERE document."organizationId" = NEW."organizationId"
        AND document."id" = NEW."id"
        AND (
          document."kind" <> 'PAPER_PDF'
          OR document."sourceUri" IS DISTINCT FROM crawl."canonicalSourceUrl"
          OR document."sourceFingerprint" IS DISTINCT FROM 'crawler-import:' || crawl."id"
          OR document."mimeType" IS DISTINCT FROM 'application/pdf'
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_document_identity_check',
        MESSAGE = 'A crawler Document must retain its admitted URL and attempt-specific identity.';
    END IF;
  ELSIF TG_TABLE_NAME = 'Asset' THEN
    IF EXISTS (
      SELECT 1
      FROM "public"."Asset" AS asset
      JOIN "public"."CrawlerImport" AS crawl
        ON crawl."organizationId" = asset."organizationId"
       AND crawl."assetId" = asset."id"
      WHERE asset."organizationId" = NEW."organizationId"
        AND asset."id" = NEW."id"
        AND (
          asset."originalFileName" IS DISTINCT FROM crawl."displayFileName"
          OR asset."mimeType" IS DISTINCT FROM 'application/pdf'
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_asset_identity_check',
        MESSAGE = 'A crawler Asset must retain its admitted display filename and PDF type.';
    END IF;
  ELSIF TG_TABLE_NAME = 'InboxEntry' THEN
    IF EXISTS (
      SELECT 1
      FROM "public"."InboxEntry" AS inbox
      WHERE inbox."organizationId" = NEW."organizationId"
        AND inbox."id" = NEW."id"
        AND (
          inbox."source" = 'CRAWLER'
          OR EXISTS (
            SELECT 1
            FROM "public"."CrawlerImport" AS bound
            WHERE bound."organizationId" = inbox."organizationId"
              AND bound."inboxEntryId" = inbox."id"
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "public"."CrawlerImport" AS crawl
          WHERE crawl."organizationId" = inbox."organizationId"
            AND crawl."inboxEntryId" = inbox."id"
            AND inbox."source" = 'CRAWLER'
            AND inbox."importBatchId" = crawl."importBatchId"
            AND inbox."documentId" = crawl."documentId"
            AND inbox."sourceUri" IS NOT DISTINCT FROM crawl."canonicalSourceUrl"
            AND inbox."sourceKey" = 'crawler-import:' || crawl."id"
            AND inbox."dedupeKey" = 'crawler-import:' || crawl."id"
            AND inbox."createdById" IS NOT DISTINCT FROM crawl."requestedById"
            AND inbox."createdByPrincipalId" = crawl."requestedByPrincipalId"
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_inbox_identity_check',
        MESSAGE = 'A crawler Inbox entry must retain its exact batch, target, requester, and attempt identity.';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "CrawlerImport_document_identity_constraint"
AFTER INSERT OR UPDATE ON "Document"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "public"."CrawlerImport_target_identity_check"();

CREATE CONSTRAINT TRIGGER "CrawlerImport_asset_identity_constraint"
AFTER INSERT OR UPDATE ON "Asset"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "public"."CrawlerImport_target_identity_check"();

CREATE CONSTRAINT TRIGGER "CrawlerImport_inbox_identity_constraint"
AFTER INSERT OR UPDATE ON "InboxEntry"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "public"."CrawlerImport_target_identity_check"();

CREATE FUNCTION "public"."CrawlerImport_job_lifecycle_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."Job" AS job
    WHERE job."organizationId" = NEW."organizationId"
      AND job."id" = NEW."id"
      AND job."type" = 'CRAWL'
      AND NOT EXISTS (
        SELECT 1
        FROM "public"."CrawlerImport" AS crawl
        WHERE crawl."organizationId" = job."organizationId"
          AND crawl."crawlJobId" = job."id"
          AND crawl."documentId" = job."documentId"
          AND crawl."assetId" = job."assetId"
          AND crawl."intakeId" = job."intakeId"
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_job_binding_check',
      MESSAGE = 'A crawl job requires one exact governed crawler command at commit.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."CrawlerImport" AS crawl
    JOIN "public"."Job" AS job
      ON job."organizationId" = crawl."organizationId"
     AND job."id" = crawl."crawlJobId"
    WHERE crawl."organizationId" = NEW."organizationId"
      AND crawl."crawlJobId" = NEW."id"
      AND NOT (
        (crawl."status" = 'QUEUED' AND crawl."retryAt" IS NULL AND job."status" = 'QUEUED')
        OR (
          crawl."status" = 'FETCHING'
          AND crawl."retryAt" IS NULL
          AND job."status" = 'RUNNING'
        )
        OR (
          crawl."status" = 'FETCHING'
          AND crawl."retryAt" IS NOT NULL
          AND job."status" = 'RETRYING'
          AND (job."runAfter" AT TIME ZONE 'UTC') = crawl."retryAt"
        )
        OR (
          crawl."status" IN ('QUARANTINED', 'VALIDATING', 'EXTRACTING', 'READY', 'ATTENTION')
          AND job."status" = 'SUCCEEDED'
        )
        OR (
          crawl."status" = 'FAILED'
          AND job."status" IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTER')
        )
        OR (
          crawl."status" = 'CANCELLED'
          AND job."status" IN ('SUCCEEDED', 'CANCELLED')
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_job_status_check',
      MESSAGE = 'Crawler command and crawl job lifecycle states must agree at commit.';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "CrawlerImport_job_lifecycle_constraint"
AFTER INSERT OR UPDATE ON "Job"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "public"."CrawlerImport_job_lifecycle_check"();

-- A crawler ImportBatch is one command envelope, not an aggregate that may be
-- repurposed. Its counters and terminal clock project the command lifecycle.
CREATE FUNCTION "public"."CrawlerImport_batch_lifecycle_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."ImportBatch" AS batch
    WHERE batch."organizationId" = NEW."organizationId"
      AND batch."id" = NEW."id"
      AND (
        batch."source" = 'CRAWLER'
        OR EXISTS (
          SELECT 1
          FROM "public"."CrawlerImport" AS bound
          WHERE bound."organizationId" = batch."organizationId"
            AND bound."importBatchId" = batch."id"
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "public"."CrawlerImport" AS crawl
        WHERE crawl."organizationId" = batch."organizationId"
          AND crawl."importBatchId" = batch."id"
          AND batch."source" = 'CRAWLER'
          AND batch."integrationConnectionId" IS NULL
          AND batch."requestedById" IS NOT DISTINCT FROM crawl."requestedById"
          AND batch."externalRequestId" = crawl."id"
          AND batch."totalCount" = 1
          AND batch."startedAt" IS NOT NULL
          AND (
            (
              crawl."status" IN ('QUEUED', 'FETCHING', 'QUARANTINED', 'VALIDATING', 'EXTRACTING')
              AND batch."status" = 'RUNNING'
              AND batch."processedCount" = 0
              AND batch."successCount" = 0
              AND batch."failureCount" = 0
              AND batch."completedAt" IS NULL
            )
            OR (
              crawl."status" = 'READY'
              AND batch."status" = 'SUCCEEDED'
              AND batch."processedCount" = 1
              AND batch."successCount" = 1
              AND batch."failureCount" = 0
              AND (batch."completedAt" AT TIME ZONE 'UTC') = crawl."completedAt"
            )
            OR (
              crawl."status" = 'ATTENTION'
              AND batch."status" = 'PARTIAL'
              AND batch."processedCount" = 1
              AND batch."successCount" = 0
              AND batch."failureCount" = 1
              AND (batch."completedAt" AT TIME ZONE 'UTC') = crawl."completedAt"
            )
            OR (
              crawl."status" = 'FAILED'
              AND batch."status" = 'FAILED'
              AND batch."processedCount" = 1
              AND batch."successCount" = 0
              AND batch."failureCount" = 1
              AND (batch."completedAt" AT TIME ZONE 'UTC') = crawl."completedAt"
            )
            OR (
              crawl."status" = 'CANCELLED'
              AND batch."status" = 'CANCELLED'
              AND batch."processedCount" = 0
              AND batch."successCount" = 0
              AND batch."failureCount" = 0
              AND (batch."completedAt" AT TIME ZONE 'UTC') = crawl."completedAt"
            )
          )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_batch_lifecycle_check',
      MESSAGE = 'A crawler batch requires one exact crawler command and lifecycle projection.';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "CrawlerImport_batch_lifecycle_constraint"
AFTER INSERT OR UPDATE ON "ImportBatch"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "public"."CrawlerImport_batch_lifecycle_check"();

CREATE FUNCTION "public"."DocumentIntake_crawler_transport_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."DocumentIntake" AS intake
    WHERE intake."organizationId" = NEW."organizationId"
      AND intake."id" = NEW."id"
      AND intake."source" = 'CRAWLER'
      AND NOT EXISTS (
        SELECT 1
        FROM "public"."CrawlerImport" AS crawl
        WHERE crawl."organizationId" = intake."organizationId"
          AND crawl."intakeId" = intake."id"
          AND crawl."documentId" = intake."documentId"
          AND crawl."assetId" = intake."assetId"
          AND crawl."inboxEntryId" = intake."inboxEntryId"
          AND crawl."importBatchId" = intake."importBatchId"
          AND crawl."maximumSizeBytes" = intake."reservedBytes"
          AND crawl."policyRevision" = intake."policyRevision"
          AND (
            (crawl."status" = 'QUEUED' AND intake."status" = 'QUEUED')
            OR (crawl."status" = 'FETCHING' AND intake."status" = 'RECEIVING')
            OR (crawl."status" = 'QUARANTINED' AND intake."status" = 'QUARANTINED')
            OR (crawl."status" = 'VALIDATING' AND intake."status" = 'VALIDATING')
            OR (crawl."status" = 'EXTRACTING' AND intake."status" = 'EXTRACTING')
            OR (crawl."status" = 'READY' AND intake."status" = 'READY')
            OR (crawl."status" = 'ATTENTION' AND intake."status" = 'ATTENTION')
            OR (crawl."status" = 'FAILED' AND intake."status" = 'FAILED')
            OR (crawl."status" = 'CANCELLED' AND intake."status" = 'CANCELLED')
            OR (
              crawl."status" IN ('QUEUED', 'FETCHING', 'QUARANTINED', 'VALIDATING', 'EXTRACTING', 'ATTENTION')
              AND intake."status" = 'CANCEL_REQUESTED'
            )
          )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'DocumentIntake_crawler_transport_check',
      MESSAGE = 'A crawler intake requires one exact governed crawler command.';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "DocumentIntake_crawler_transport_constraint"
AFTER INSERT OR UPDATE ON "DocumentIntake"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "public"."DocumentIntake_crawler_transport_check"();

-- The existing source-neutral receipt guard already proves the exact written
-- ingress attempt and Document/Asset bytes. This source-specific guard adds
-- the explicit command, crawl job, requester, byte ceiling, and URL authority.
CREATE FUNCTION "public"."DocumentIngestReceipt_crawler_guard"()
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
      AND crawl."sourceUrlFingerprint" = NEW."sourceFingerprint"
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

CREATE TRIGGER "DocumentIngestReceipt_crawler_guard_trigger"
BEFORE INSERT ON "DocumentIngestReceipt"
FOR EACH ROW
EXECUTE FUNCTION "public"."DocumentIngestReceipt_crawler_guard"();

CREATE FUNCTION "public"."DocumentIngestReceipt_crawler_consistency_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW."source" = 'CRAWLER' AND NOT EXISTS (
    SELECT 1
    FROM "public"."CrawlerImport" AS crawl
    WHERE crawl."organizationId" = NEW."organizationId"
      AND crawl."id" = NEW."crawlerImportId"
      AND (
        crawl."status" IN ('QUARANTINED', 'VALIDATING', 'EXTRACTING', 'READY', 'ATTENTION')
        OR (
          crawl."status" IN ('FAILED', 'CANCELLED')
          AND crawl."quarantinedAt" IS NOT NULL
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'DocumentIngestReceipt_crawler_lifecycle_check',
      MESSAGE = 'A crawler receipt requires a byte-committed crawler lifecycle at commit.';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "DocumentIngestReceipt_crawler_consistency_constraint"
AFTER INSERT ON "DocumentIngestReceipt"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "public"."DocumentIngestReceipt_crawler_consistency_check"();
