-- User-directed retirement of governed-crawler byte custody. Ingestion
-- history remains immutable; a separate custody lifecycle fences every worker,
-- redacts the raw locator, and releases retained quota only after exact local
-- object deletion has been proven.

CREATE TYPE "CrawlerCustodyStatus" AS ENUM (
  'RETAINED',
  'DELETE_PENDING',
  'DELETED'
);

ALTER TABLE "CrawlerImport"
  ALTER COLUMN "canonicalSourceUrl" DROP NOT NULL,
  ADD COLUMN "custodyStatus" "CrawlerCustodyStatus" NOT NULL DEFAULT 'RETAINED',
  ADD COLUMN "deletionRequestedById" TEXT,
  ADD COLUMN "deletionRequestedByPrincipalId" UUID,
  ADD COLUMN "deletionClientOperationId" VARCHAR(200),
  ADD COLUMN "deletionRequestHash" CHAR(64),
  ADD COLUMN "deletionRequestedAt" TIMESTAMPTZ(3),
  ADD COLUMN "deletionAfter" TIMESTAMPTZ(3),
  ADD COLUMN "deletionLeaseId" VARCHAR(200),
  ADD COLUMN "deletionLeaseExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "deletionAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deletionFailureCode" VARCHAR(100),
  ADD COLUMN "deletionProofDigest" CHAR(64),
  ADD COLUMN "deletedAt" TIMESTAMPTZ(3);

ALTER TABLE "CrawlerImport"
  DROP CONSTRAINT "CrawlerImport_canonical_url_check",
  ADD CONSTRAINT "CrawlerImport_canonical_url_check" CHECK (
    (
      "custodyStatus" = 'RETAINED'
      AND octet_length("canonicalSourceUrl") BETWEEN 9 AND 2048
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
    )
    OR (
      "custodyStatus" IN ('DELETE_PENDING', 'DELETED')
      AND "canonicalSourceUrl" IS NULL
    )
  ),
  ADD CONSTRAINT "CrawlerImport_custody_shape_check" CHECK (
    "deletionAttemptCount" >= 0
    AND (
      (
        "custodyStatus" = 'RETAINED'
        AND "deletionRequestedById" IS NULL
        AND "deletionRequestedByPrincipalId" IS NULL
        AND "deletionClientOperationId" IS NULL
        AND "deletionRequestHash" IS NULL
        AND "deletionRequestedAt" IS NULL
        AND "deletionAfter" IS NULL
        AND "deletionLeaseId" IS NULL
        AND "deletionLeaseExpiresAt" IS NULL
        AND "deletionAttemptCount" = 0
        AND "deletionFailureCode" IS NULL
        AND "deletionProofDigest" IS NULL
        AND "deletedAt" IS NULL
      )
      OR (
        "custodyStatus" = 'DELETE_PENDING'
        AND "deletionRequestedByPrincipalId" IS NOT NULL
        AND "deletionClientOperationId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
        AND "deletionRequestHash" ~ '^[0-9a-f]{64}$'
        AND "deletionRequestedAt" IS NOT NULL
        AND "deletionAfter" IS NOT NULL
        AND (
          ("deletionLeaseId" IS NULL AND "deletionLeaseExpiresAt" IS NULL)
          OR (
            octet_length("deletionLeaseId") BETWEEN 1 AND 200
            AND "deletionLeaseId" !~ '[[:cntrl:]]'
            AND "deletionLeaseExpiresAt" > "deletionRequestedAt"
          )
        )
        AND (
          "deletionFailureCode" IS NULL
          OR (
            octet_length("deletionFailureCode") BETWEEN 1 AND 100
            AND "deletionFailureCode" ~ '^[a-z][a-z0-9_]{0,99}$'
          )
        )
        AND "deletionProofDigest" IS NULL
        AND "deletedAt" IS NULL
      )
      OR (
        "custodyStatus" = 'DELETED'
        AND "deletionRequestedByPrincipalId" IS NOT NULL
        AND "deletionClientOperationId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
        AND "deletionRequestHash" ~ '^[0-9a-f]{64}$'
        AND "deletionRequestedAt" IS NOT NULL
        AND "deletionAfter" IS NULL
        AND "deletionLeaseId" IS NULL
        AND "deletionLeaseExpiresAt" IS NULL
        AND "deletionAttemptCount" >= 1
        AND "deletionFailureCode" IS NULL
        AND "deletionProofDigest" ~ '^[0-9a-f]{64}$'
        AND "deletedAt" IS NOT NULL
      )
    )
    AND (
      "deletionRequestedAt" IS NULL
      OR (
        "deletionRequestedAt" >= "createdAt"
        AND (
          "deletionAfter" IS NULL
          OR "deletionAfter" >= "deletionRequestedAt"
        )
      )
    )
    AND (
      "deletedAt" IS NULL
      OR "deletedAt" >= "deletionRequestedAt"
    )
  );

COMMENT ON COLUMN "CrawlerImport"."custodyStatus" IS
  'Orthogonal user-deletion lifecycle; DELETE_PENDING is fail-closed and remains quota-retained until proof.';
COMMENT ON COLUMN "CrawlerImport"."deletionProofDigest" IS
  'Domain-separated SHA-256 over the immutable, sorted local attempt identities proven absent.';

ALTER TABLE "CrawlerImport"
  ADD CONSTRAINT "CrawlerImport_deletionRequestedById_fkey"
    FOREIGN KEY ("deletionRequestedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "CrawlerImport_retained_deletion_requester_fkey"
    FOREIGN KEY ("organizationId", "deletionRequestedByPrincipalId")
    REFERENCES "RetainedAuditPrincipal"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "CrawlerImport_deletion_idempotency_key"
  ON "CrawlerImport"("organizationId", "deletionClientOperationId");
CREATE INDEX "CrawlerImport_custodyStatus_deletionAfter_idx"
  ON "CrawlerImport"("custodyStatus", "deletionAfter");
CREATE INDEX "CrawlerImport_deletionRequestedById_idx"
  ON "CrawlerImport"("deletionRequestedById");
CREATE INDEX "CrawlerImport_deletionRequestedByPrincipalId_idx"
  ON "CrawlerImport"("deletionRequestedByPrincipalId");

DROP INDEX "CrawlerImport_live_source_fingerprint_key";
CREATE UNIQUE INDEX "CrawlerImport_live_source_fingerprint_key"
  ON "CrawlerImport"("organizationId", "sourceUrlFingerprint")
  WHERE "custodyStatus" <> 'DELETED'
    AND "status" NOT IN ('FAILED', 'CANCELLED');

CREATE TRIGGER "CrawlerImport_01_deletion_requester_alignment_trigger"
BEFORE INSERT OR UPDATE ON "CrawlerImport"
FOR EACH ROW
EXECUTE FUNCTION "public"."RetainedAuditPrincipal_actor_alignment_guard"(
  'deletionRequestedByPrincipalId', 'deletionRequestedById'
);

-- The original authority remains immutable except for the one-way removal of
-- its raw URL at the exact RETAINED -> DELETE_PENDING transition.
CREATE OR REPLACE FUNCTION "public"."CrawlerImport_guard"()
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
       OR NEW."cancelledAt" IS NOT NULL
       OR NEW."custodyStatus" <> 'RETAINED' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_initial_lifecycle_check',
        MESSAGE = 'A crawler command must enter the lifecycle in a clean queued, retained state.';
    END IF;

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
        AND historical."canonicalSourceUrl" IS NOT NULL
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
      NEW."clientOperationId", NEW."requestHash",
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
      OLD."clientOperationId", OLD."requestHash",
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

    IF NEW."canonicalSourceUrl" IS DISTINCT FROM OLD."canonicalSourceUrl"
       AND NOT (
         OLD."custodyStatus" = 'RETAINED'
         AND NEW."custodyStatus" = 'DELETE_PENDING'
         AND OLD."canonicalSourceUrl" IS NOT NULL
         AND NEW."canonicalSourceUrl" IS NULL
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_source_url_redaction_check',
        MESSAGE = 'The crawler source URL may only be removed by an accepted custody deletion.';
    END IF;

    IF NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
       AND NOT (
         OLD."requestedById" IS NOT NULL
         AND NEW."requestedById" IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM "public"."User" AS deleted_user
           WHERE deleted_user."id" = OLD."requestedById"
         )
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_requester_immutability_check',
        MESSAGE = 'The crawler requester may only detach through User deletion.';
    END IF;

    IF NEW."deletionRequestedById" IS DISTINCT FROM OLD."deletionRequestedById"
       AND NOT (
         OLD."deletionRequestedById" IS NOT NULL
         AND NEW."deletionRequestedById" IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM "public"."User" AS deleted_user
           WHERE deleted_user."id" = OLD."deletionRequestedById"
         )
       )
       AND NOT (
         OLD."custodyStatus" = 'RETAINED'
         AND NEW."custodyStatus" = 'DELETE_PENDING'
         AND OLD."deletionRequestedById" IS NULL
         AND NEW."deletionRequestedById" IS NOT NULL
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_deletion_requester_immutability_check',
        MESSAGE = 'The crawler deletion requester is bound once and detaches only through User deletion.';
    END IF;

    IF NEW."custodyStatus" IS DISTINCT FROM OLD."custodyStatus" AND NOT (
      (OLD."custodyStatus" = 'RETAINED' AND NEW."custodyStatus" = 'DELETE_PENDING')
      OR (OLD."custodyStatus" = 'DELETE_PENDING' AND NEW."custodyStatus" = 'DELETED')
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_custody_transition_check',
        MESSAGE = 'The crawler custody transition is not allowed.';
    END IF;

    IF OLD."custodyStatus" <> 'RETAINED' AND ROW(
      NEW."deletionRequestedByPrincipalId", NEW."deletionClientOperationId",
      NEW."deletionRequestHash", NEW."deletionRequestedAt"
    ) IS DISTINCT FROM ROW(
      OLD."deletionRequestedByPrincipalId", OLD."deletionClientOperationId",
      OLD."deletionRequestHash", OLD."deletionRequestedAt"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_deletion_authority_immutable_check',
        MESSAGE = 'Accepted crawler deletion authority is immutable.';
    END IF;

    IF OLD."custodyStatus" = 'RETAINED' AND NEW."custodyStatus" = 'DELETE_PENDING'
       AND (
         NEW."deletionRequestedById" IS NULL
         OR NEW."deletionRequestedByPrincipalId" IS NULL
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_live_deletion_requester_check',
        MESSAGE = 'A crawler custody deletion requires a live explicit requester.';
    END IF;

    IF OLD."deletionAttemptCount" > NEW."deletionAttemptCount" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_deletion_attempt_monotonic_check',
        MESSAGE = 'Crawler deletion attempt count cannot decrease.';
    END IF;

    IF OLD."custodyStatus" = 'DELETED' AND ROW(
      NEW."custodyStatus", NEW."deletionAfter", NEW."deletionLeaseId",
      NEW."deletionLeaseExpiresAt", NEW."deletionAttemptCount",
      NEW."deletionFailureCode", NEW."deletionProofDigest", NEW."deletedAt"
    ) IS DISTINCT FROM ROW(
      OLD."custodyStatus", OLD."deletionAfter", OLD."deletionLeaseId",
      OLD."deletionLeaseExpiresAt", OLD."deletionAttemptCount",
      OLD."deletionFailureCode", OLD."deletionProofDigest", OLD."deletedAt"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_deleted_custody_immutable_check',
        MESSAGE = 'Proven crawler custody deletion is immutable.';
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

-- Commit-time deletion envelope. This closes Reader access and raw locator
-- retention as soon as deletion is accepted, then proves the last transition
-- only after every immutable attempt identity has an absence timestamp.
CREATE FUNCTION "public"."CrawlerImport_custody_consistency_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW."custodyStatus" IN ('DELETE_PENDING', 'DELETED') AND (
    EXISTS (
      SELECT 1
      FROM "public"."Document" AS document
      WHERE document."organizationId" = NEW."organizationId"
        AND document."id" = NEW."documentId"
        AND (
          document."sourceUri" IS NOT NULL
          OR document."status" <> 'ARCHIVED'
          OR document."archivedAt" IS NULL
        )
    )
    OR EXISTS (
      SELECT 1
      FROM "public"."InboxEntry" AS inbox
      WHERE inbox."organizationId" = NEW."organizationId"
        AND inbox."id" = NEW."inboxEntryId"
        AND (
          inbox."sourceUri" IS NOT NULL
          OR inbox."status" <> 'REJECTED'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM "public"."Asset" AS asset
      WHERE asset."organizationId" = NEW."organizationId"
        AND asset."id" = NEW."assetId"
        AND asset."status" = 'READY'
    )
    OR EXISTS (
      SELECT 1
      FROM "public"."Job" AS job
      WHERE job."organizationId" = NEW."organizationId"
        AND job."documentId" = NEW."documentId"
        AND job."assetId" = NEW."assetId"
        AND job."status" IN ('QUEUED', 'RUNNING', 'RETRYING')
    )
    OR EXISTS (
      SELECT 1
      FROM "public"."JobAttempt" AS attempt
      JOIN "public"."Job" AS job
        ON job."organizationId" = attempt."organizationId"
       AND job."id" = attempt."jobId"
      WHERE job."organizationId" = NEW."organizationId"
        AND job."documentId" = NEW."documentId"
        AND job."assetId" = NEW."assetId"
        AND attempt."status" = 'RUNNING'
    )
    OR EXISTS (
      SELECT 1
      FROM "public"."ProvenanceRecord" AS provenance
      WHERE provenance."organizationId" = NEW."organizationId"
        AND provenance."kind" = 'CRAWL'
        AND provenance."sourceRecordId" = NEW."id"
        AND provenance."sourceUri" IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_delete_pending_envelope_check',
      MESSAGE = 'Pending crawler deletion must fence work, hide Reader access, and redact raw locators.';
  END IF;

  IF NEW."custodyStatus" = 'DELETED' AND (
    EXISTS (
      SELECT 1
      FROM "public"."Asset" AS asset
      WHERE asset."organizationId" = NEW."organizationId"
        AND asset."id" = NEW."assetId"
        AND (
          asset."status" <> 'DELETED'
          OR asset."deletedAt" IS DISTINCT FROM NEW."deletedAt"
          OR asset."physicalLocator" IS NOT NULL
        )
    )
    OR EXISTS (
      SELECT 1
      FROM "public"."DocumentIntake" AS intake
      WHERE intake."organizationId" = NEW."organizationId"
        AND intake."id" = NEW."intakeId"
        AND intake."quotaReleasedAt" IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM "public"."DocumentIngressAttempt" AS attempt
      WHERE attempt."organizationId" = NEW."organizationId"
        AND attempt."intakeId" = NEW."intakeId"
        AND attempt."cleanupCompletedAt" IS NULL
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_deleted_proof_check',
      MESSAGE = 'Deleted crawler custody requires exact cleanup proof and quota release.';
  END IF;

  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "CrawlerImport_custody_consistency_constraint"
AFTER INSERT OR UPDATE ON "CrawlerImport"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "public"."CrawlerImport_custody_consistency_check"();
