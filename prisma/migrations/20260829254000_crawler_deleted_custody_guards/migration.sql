-- Reciprocal terminal guards for proven crawler-custody deletion.
--
-- The original deletion migration validates the child graph when
-- CrawlerImport transitions to DELETED. These reciprocal triggers also run
-- when a child changes later, so a committed deletion proof cannot be undone
-- by reactivating Reader state, scheduling new work, restoring a locator,
-- releasing cleanup proof, or appending new validation/extraction authority.
-- The checks are deferred so the existing DELETE_PENDING -> DELETED
-- reconciliation transaction can update all children before publishing the
-- terminal crawler row. A deliberate tenant-erasure transaction may delete
-- the graph only when the matching CrawlerImport (or its Organization) is gone
-- by commit.

CREATE FUNCTION "public"."CrawlerImport_deleted_child_ids"(
  child_table TEXT,
  child_row JSONB
)
RETURNS TABLE (
  "organizationId" TEXT,
  "crawlerImportId" TEXT
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  child_organization_id TEXT := child_row ->> 'organizationId';
BEGIN
  IF child_organization_id IS NULL THEN
    RETURN;
  END IF;

  CASE child_table
    WHEN 'Document' THEN
      RETURN QUERY
      SELECT crawl."organizationId", crawl."id"
      FROM "public"."CrawlerImport" AS crawl
      WHERE crawl."custodyStatus" = 'DELETED'
        AND crawl."organizationId" = child_organization_id
        AND crawl."documentId" = child_row ->> 'id';
    WHEN 'Asset' THEN
      RETURN QUERY
      SELECT crawl."organizationId", crawl."id"
      FROM "public"."CrawlerImport" AS crawl
      WHERE crawl."custodyStatus" = 'DELETED'
        AND crawl."organizationId" = child_organization_id
        AND crawl."assetId" = child_row ->> 'id';
    WHEN 'DocumentAsset' THEN
      RETURN QUERY
      SELECT crawl."organizationId", crawl."id"
      FROM "public"."CrawlerImport" AS crawl
      WHERE crawl."custodyStatus" = 'DELETED'
        AND crawl."organizationId" = child_organization_id
        AND (
          crawl."documentId" = child_row ->> 'documentId'
          OR crawl."assetId" = child_row ->> 'assetId'
        );
    WHEN 'InboxEntry' THEN
      RETURN QUERY
      SELECT crawl."organizationId", crawl."id"
      FROM "public"."CrawlerImport" AS crawl
      WHERE crawl."custodyStatus" = 'DELETED'
        AND crawl."organizationId" = child_organization_id
        AND (
          crawl."inboxEntryId" = child_row ->> 'id'
          OR crawl."documentId" = child_row ->> 'documentId'
          OR crawl."importBatchId" = child_row ->> 'importBatchId'
        );
    WHEN 'ProvenanceRecord' THEN
      IF child_row ->> 'kind' = 'CRAWL' THEN
        RETURN QUERY
        SELECT crawl."organizationId", crawl."id"
        FROM "public"."CrawlerImport" AS crawl
        WHERE crawl."custodyStatus" = 'DELETED'
          AND crawl."organizationId" = child_organization_id
          AND (
            crawl."id" = child_row ->> 'sourceRecordId'
            OR crawl."documentId" = child_row ->> 'documentId'
            OR crawl."inboxEntryId" = child_row ->> 'inboxEntryId'
          );
      END IF;
    WHEN 'Job' THEN
      RETURN QUERY
      SELECT crawl."organizationId", crawl."id"
      FROM "public"."CrawlerImport" AS crawl
      WHERE crawl."custodyStatus" = 'DELETED'
        AND crawl."organizationId" = child_organization_id
        AND (
          crawl."crawlJobId" = child_row ->> 'id'
          OR crawl."documentId" = child_row ->> 'documentId'
          OR crawl."assetId" = child_row ->> 'assetId'
          OR crawl."intakeId" = child_row ->> 'intakeId'
        );
    WHEN 'JobAttempt' THEN
      RETURN QUERY
      SELECT crawl."organizationId", crawl."id"
      FROM "public"."CrawlerImport" AS crawl
      WHERE crawl."custodyStatus" = 'DELETED'
        AND crawl."organizationId" = child_organization_id
        AND (
          crawl."crawlJobId" = child_row ->> 'jobId'
          OR EXISTS (
            SELECT 1
            FROM "public"."Job" AS job
            WHERE job."organizationId" = child_organization_id
              AND job."id" = child_row ->> 'jobId'
              AND (
                job."documentId" = crawl."documentId"
                OR job."assetId" = crawl."assetId"
                OR job."intakeId" = crawl."intakeId"
              )
          )
        );
    WHEN 'DocumentIngressAttempt' THEN
      RETURN QUERY
      SELECT crawl."organizationId", crawl."id"
      FROM "public"."CrawlerImport" AS crawl
      WHERE crawl."custodyStatus" = 'DELETED'
        AND crawl."organizationId" = child_organization_id
        AND (
          crawl."intakeId" = child_row ->> 'intakeId'
          OR crawl."documentId" = child_row ->> 'documentId'
          OR crawl."assetId" = child_row ->> 'assetId'
          OR crawl."crawlJobId" = child_row ->> 'jobId'
        );
    WHEN 'DocumentIntake' THEN
      RETURN QUERY
      SELECT crawl."organizationId", crawl."id"
      FROM "public"."CrawlerImport" AS crawl
      WHERE crawl."custodyStatus" = 'DELETED'
        AND crawl."organizationId" = child_organization_id
        AND (
          crawl."intakeId" = child_row ->> 'id'
          OR crawl."documentId" = child_row ->> 'documentId'
          OR crawl."assetId" = child_row ->> 'assetId'
          OR crawl."inboxEntryId" = child_row ->> 'inboxEntryId'
          OR crawl."importBatchId" = child_row ->> 'importBatchId'
        );
    WHEN 'DocumentIngestReceipt' THEN
      RETURN QUERY
      SELECT crawl."organizationId", crawl."id"
      FROM "public"."CrawlerImport" AS crawl
      WHERE crawl."custodyStatus" = 'DELETED'
        AND crawl."organizationId" = child_organization_id
        AND (
          crawl."id" = child_row ->> 'crawlerImportId'
          OR crawl."documentId" = child_row ->> 'documentId'
          OR crawl."assetId" = child_row ->> 'assetId'
          OR crawl."intakeId" = child_row ->> 'intakeId'
          OR crawl."inboxEntryId" = child_row ->> 'inboxEntryId'
        );
    WHEN 'DocumentValidationAttestation' THEN
      RETURN QUERY
      SELECT crawl."organizationId", crawl."id"
      FROM "public"."CrawlerImport" AS crawl
      WHERE crawl."custodyStatus" = 'DELETED'
        AND crawl."organizationId" = child_organization_id
        AND (
          crawl."documentId" = child_row ->> 'documentId'
          OR crawl."assetId" = child_row ->> 'assetId'
        );
    WHEN 'DocumentTextExtraction' THEN
      RETURN QUERY
      SELECT crawl."organizationId", crawl."id"
      FROM "public"."CrawlerImport" AS crawl
      WHERE crawl."custodyStatus" = 'DELETED'
        AND crawl."organizationId" = child_organization_id
        AND (
          crawl."documentId" = child_row ->> 'documentId'
          OR crawl."assetId" = child_row ->> 'assetId'
        );
    WHEN 'DocumentTextManifestAdmission' THEN
      RETURN QUERY
      SELECT crawl."organizationId", crawl."id"
      FROM "public"."CrawlerImport" AS crawl
      WHERE crawl."custodyStatus" = 'DELETED'
        AND crawl."organizationId" = child_organization_id
        AND crawl."documentId" = child_row ->> 'documentId';
    WHEN 'DocumentTextChunk' THEN
      RETURN QUERY
      SELECT crawl."organizationId", crawl."id"
      FROM "public"."CrawlerImport" AS crawl
      WHERE crawl."custodyStatus" = 'DELETED'
        AND crawl."organizationId" = child_organization_id
        AND crawl."documentId" = child_row ->> 'documentId';
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Unsupported crawler deleted-child trigger table.';
  END CASE;
END;
$function$;

CREATE FUNCTION "public"."CrawlerImport_deleted_state_is_sound"(
  crawler_organization_id TEXT,
  crawler_import_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $function$
  SELECT NOT EXISTS (
    SELECT 1
    FROM "public"."CrawlerImport" AS crawl
    WHERE crawl."organizationId" = crawler_organization_id
      AND crawl."id" = crawler_import_id
      AND crawl."custodyStatus" = 'DELETED'
      AND (
        NOT EXISTS (
          SELECT 1
          FROM "public"."Document" AS document
          WHERE document."organizationId" = crawl."organizationId"
            AND document."id" = crawl."documentId"
            AND document."status" = 'ARCHIVED'
            AND document."sourceUri" IS NULL
            AND document."contentHash" IS NULL
            AND document."archivedAt" IS NOT NULL
            AND document."failureCode" IS NULL
            AND document."metadata" = jsonb_build_object(
              'schemaVersion', 1,
              'custody', 'deleted',
              'readerAvailable', false
            )
        )
        OR NOT EXISTS (
          SELECT 1
          FROM "public"."Asset" AS asset
          WHERE asset."organizationId" = crawl."organizationId"
            AND asset."id" = crawl."assetId"
            AND asset."status" = 'DELETED'
            AND asset."storageProvider" = 'LOCAL'
            AND asset."bucket" = 'private-quarantine-v1'
            AND asset."objectKey" = 'deleted:crawler:' || crawl."id"
            AND asset."physicalLocator" IS NULL
            AND asset."sizeBytes" IS NULL
            AND asset."sha256" IS NULL
            AND asset."etag" IS NULL
            AND asset."rejectionCode" IS NULL
            AND asset."rejectedReason" IS NULL
            AND asset."deletedAt" = crawl."deletedAt"
            AND asset."metadata" = jsonb_build_object(
              'schemaVersion', 1,
              'custody', 'deleted',
              'publicAccess', false,
              'deletionProofDigest', crawl."deletionProofDigest",
              'storageAuthorityGeneration',
                crawl."deletionStorageAuthorityGeneration",
              'deletionTombstoneDigest', crawl."deletionTombstoneDigest"
            )
        )
        OR NOT EXISTS (
          SELECT 1
          FROM "public"."DocumentAsset" AS document_asset
          WHERE document_asset."organizationId" = crawl."organizationId"
            AND document_asset."documentId" = crawl."documentId"
            AND document_asset."assetId" = crawl."assetId"
            AND document_asset."role" = 'ORIGINAL'
        )
        OR EXISTS (
          SELECT 1
          FROM "public"."DocumentAsset" AS document_asset
          WHERE document_asset."organizationId" = crawl."organizationId"
            AND document_asset."documentId" = crawl."documentId"
            AND document_asset."role" = 'ORIGINAL'
            AND document_asset."assetId" <> crawl."assetId"
        )
        OR NOT EXISTS (
          SELECT 1
          FROM "public"."InboxEntry" AS inbox
          WHERE inbox."organizationId" = crawl."organizationId"
            AND inbox."id" = crawl."inboxEntryId"
            AND inbox."status" = 'REJECTED'
            AND inbox."sourceUri" IS NULL
            AND inbox."failureCode" = 'crawler_custody_deleted'
            AND inbox."failureMessage" IS NULL
            AND inbox."payload" = jsonb_build_object(
              'schemaVersion', 1,
              'kind', 'governed-crawler-import',
              'crawlerImportId', crawl."id",
              'importStatus', 'DELETED',
              'phase', 'custody-deletion'
            )
        )
        OR NOT EXISTS (
          SELECT 1
          FROM "public"."ProvenanceRecord" AS provenance
          WHERE provenance."organizationId" = crawl."organizationId"
            AND provenance."kind" = 'CRAWL'
            AND provenance."sourceRecordId" = crawl."id"
            AND provenance."sourceUri" IS NULL
            AND provenance."payload" = jsonb_build_object(
              'schemaVersion', 1,
              'stage', 'crawler-custody-deleted',
              'deletionProofDigest', crawl."deletionProofDigest"
            )
        )
        OR EXISTS (
          SELECT 1
          FROM "public"."ProvenanceRecord" AS provenance
          WHERE provenance."organizationId" = crawl."organizationId"
            AND provenance."kind" = 'CRAWL'
            AND (
              provenance."sourceRecordId" = crawl."id"
              OR provenance."documentId" = crawl."documentId"
              OR provenance."inboxEntryId" = crawl."inboxEntryId"
            )
            AND (
              provenance."sourceUri" IS NOT NULL
              OR provenance."payload" IS DISTINCT FROM jsonb_build_object(
                'schemaVersion', 1,
                'stage', 'crawler-custody-deleted',
                'deletionProofDigest', crawl."deletionProofDigest"
              )
            )
        )
        OR NOT EXISTS (
          SELECT 1
          FROM "public"."Job" AS crawl_job
          WHERE crawl_job."organizationId" = crawl."organizationId"
            AND crawl_job."id" = crawl."crawlJobId"
            AND crawl_job."payload" = jsonb_build_object(
              'schemaVersion', 1,
              'crawlerImportId', crawl."id"
            )
        )
        OR EXISTS (
          SELECT 1
          FROM "public"."Job" AS job
          WHERE job."organizationId" = crawl."organizationId"
            AND (
              job."id" = crawl."crawlJobId"
              OR job."documentId" = crawl."documentId"
              OR job."assetId" = crawl."assetId"
              OR job."intakeId" = crawl."intakeId"
            )
            AND job."status" IN ('QUEUED', 'RUNNING', 'RETRYING')
        )
        OR EXISTS (
          SELECT 1
          FROM "public"."JobAttempt" AS attempt
          JOIN "public"."Job" AS job
            ON job."organizationId" = attempt."organizationId"
           AND job."id" = attempt."jobId"
          WHERE job."organizationId" = crawl."organizationId"
            AND (
              job."id" = crawl."crawlJobId"
              OR job."documentId" = crawl."documentId"
              OR job."assetId" = crawl."assetId"
              OR job."intakeId" = crawl."intakeId"
            )
            AND attempt."status" = 'RUNNING'
        )
        OR EXISTS (
          SELECT 1
          FROM "public"."DocumentIngressAttempt" AS ingress
          WHERE ingress."organizationId" = crawl."organizationId"
            AND ingress."intakeId" = crawl."intakeId"
            AND ingress."documentId" = crawl."documentId"
            AND ingress."assetId" = crawl."assetId"
            AND (
              ingress."status" IN ('RECEIVING', 'WRITTEN')
              OR ingress."cleanupCompletedAt" IS NULL
              OR ingress."cleanupAfter" IS NOT NULL
              OR ingress."cleanupFailureCode" IS NOT NULL
              OR ingress."storageAuthorityGeneration" IS DISTINCT FROM
                crawl."deletionStorageAuthorityGeneration"
            )
        )
        OR NOT EXISTS (
          SELECT 1
          FROM "public"."DocumentIntake" AS intake
          WHERE intake."organizationId" = crawl."organizationId"
            AND intake."id" = crawl."intakeId"
            AND intake."documentId" = crawl."documentId"
            AND intake."assetId" = crawl."assetId"
            AND intake."quotaReleasedAt" IS NOT NULL
        )
        OR (
          crawl."quarantinedAt" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "public"."DocumentIngestReceipt" AS receipt
            WHERE receipt."organizationId" = crawl."organizationId"
              AND receipt."source" = 'CRAWLER'
              AND receipt."crawlerImportId" = crawl."id"
              AND receipt."documentId" = crawl."documentId"
              AND receipt."assetId" = crawl."assetId"
              AND receipt."intakeId" = crawl."intakeId"
              AND receipt."sourceFingerprint" = 'crawler-import:' || crawl."id"
              AND receipt."storageAuthorityGeneration" =
                crawl."deletionStorageAuthorityGeneration"
          )
        )
        OR EXISTS (
          SELECT 1
          FROM "public"."DocumentValidationAttestation" AS validation
          WHERE validation."organizationId" = crawl."organizationId"
            AND (
              validation."documentId" = crawl."documentId"
              OR validation."assetId" = crawl."assetId"
            )
            AND validation."createdAt" > crawl."deletedAt"
        )
        OR EXISTS (
          SELECT 1
          FROM "public"."DocumentTextExtraction" AS extraction
          WHERE extraction."organizationId" = crawl."organizationId"
            AND extraction."documentId" = crawl."documentId"
            AND (
              extraction."createdAt" > crawl."deletedAt"
              OR NOT EXISTS (
                SELECT 1
                FROM "public"."DocumentTextManifestAdmission" AS admission
                WHERE admission."organizationId" = extraction."organizationId"
                  AND admission."documentId" = extraction."documentId"
                  AND admission."extractionId" = extraction."id"
              )
              OR (
                NOT EXISTS (
                  SELECT 1
                  FROM "public"."EvidenceTextAnchor" AS anchor
                  WHERE anchor."organizationId" = extraction."organizationId"
                    AND anchor."documentId" = extraction."documentId"
                    AND anchor."extractionId" = extraction."id"
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM "public"."EvidenceNote" AS note
                  JOIN "public"."DocumentTextChunk" AS chunk
                    ON chunk."organizationId" = note."organizationId"
                   AND chunk."id" = note."documentChunkId"
                  WHERE chunk."organizationId" = extraction."organizationId"
                    AND chunk."documentId" = extraction."documentId"
                    AND chunk."extractionId" = extraction."id"
                )
              )
            )
        )
        OR EXISTS (
          SELECT 1
          FROM "public"."DocumentTextManifestAdmission" AS admission
          WHERE admission."organizationId" = crawl."organizationId"
            AND admission."documentId" = crawl."documentId"
            AND admission."admittedAt" > crawl."deletedAt"
        )
        OR EXISTS (
          SELECT 1
          FROM "public"."DocumentTextChunk" AS chunk
          WHERE chunk."organizationId" = crawl."organizationId"
            AND chunk."documentId" = crawl."documentId"
            AND (
              chunk."createdAt" > crawl."deletedAt"
              OR (
                chunk."extractionId" IS NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM "public"."EvidenceNote" AS note
                  WHERE note."organizationId" = chunk."organizationId"
                    AND note."documentChunkId" = chunk."id"
                )
              )
            )
        )
        OR (
          SELECT count(*)::integer
          FROM "public"."DocumentTextChunk" AS chunk
          WHERE chunk."organizationId" = crawl."organizationId"
            AND chunk."documentId" = crawl."documentId"
        ) <> crawl."derivedTextRetainedChunkCount"
      )
  );
$function$;

CREATE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."CrawlerImport_deleted_child_ids"(
      TG_TABLE_NAME,
      to_jsonb(NEW)
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_deleted_child_insert_check',
      MESSAGE = 'Proven crawler deletion cannot admit new child work or authority.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  affected RECORD;
  old_row JSONB := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  new_row JSONB := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
BEGIN
  FOR affected IN
    SELECT DISTINCT candidates."organizationId", candidates."crawlerImportId"
    FROM (
      SELECT ids."organizationId", ids."crawlerImportId"
      FROM "public"."CrawlerImport_deleted_child_ids"(TG_TABLE_NAME, old_row) AS ids
      WHERE old_row IS NOT NULL
      UNION ALL
      SELECT ids."organizationId", ids."crawlerImportId"
      FROM "public"."CrawlerImport_deleted_child_ids"(TG_TABLE_NAME, new_row) AS ids
      WHERE new_row IS NOT NULL
    ) AS candidates
  LOOP
    -- No covered child is inserted after (or concurrently with) terminal
    -- deletion. Reconciliation never inserts these records.
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_deleted_child_insert_check',
        MESSAGE = 'Proven crawler deletion cannot admit new child work or authority.';
    END IF;

    -- User/tenant lifecycle can still detach nullable user foreign keys, but
    -- terminal job and attempt outputs can never be rewritten to smuggle a
    -- raw URL, filesystem locator, or replacement worker authority back into
    -- a proven-deleted graph.
    IF TG_OP = 'UPDATE'
       AND TG_TABLE_NAME = 'Job'
       AND (
         (new_row -> 'payload') IS DISTINCT FROM (old_row -> 'payload')
         OR (new_row -> 'result') IS DISTINCT FROM (old_row -> 'result')
         OR (new_row -> 'lastErrorMessage')
           IS DISTINCT FROM (old_row -> 'lastErrorMessage')
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_deleted_job_output_immutable_check',
        MESSAGE = 'Proven crawler deletion makes job payloads and outputs immutable.';
    END IF;

    IF TG_OP = 'UPDATE'
       AND TG_TABLE_NAME = 'JobAttempt'
       AND (
         (new_row -> 'result') IS DISTINCT FROM (old_row -> 'result')
         OR (new_row -> 'errorMessage') IS DISTINCT FROM (old_row -> 'errorMessage')
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_deleted_job_attempt_output_immutable_check',
        MESSAGE = 'Proven crawler deletion makes job-attempt outputs immutable.';
    END IF;

    -- A terminal crawler provenance row cannot evade the exact redaction
    -- proof by changing kind or detaching all of its crawler graph bindings.
    -- Nullable actor-user detachment remains valid because it changes none of
    -- these authority fields.
    IF TG_OP = 'UPDATE'
       AND TG_TABLE_NAME = 'ProvenanceRecord'
       AND (
         (new_row -> 'kind') IS DISTINCT FROM (old_row -> 'kind')
         OR (new_row -> 'sourceRecordId')
           IS DISTINCT FROM (old_row -> 'sourceRecordId')
         OR (new_row -> 'documentId')
           IS DISTINCT FROM (old_row -> 'documentId')
         OR (new_row -> 'inboxEntryId')
           IS DISTINCT FROM (old_row -> 'inboxEntryId')
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_deleted_provenance_binding_immutable_check',
        MESSAGE = 'Proven crawler deletion makes provenance kind and graph bindings immutable.';
    END IF;

    -- Validation rows have no deletion-reconciliation mutation. After the
    -- terminal publication they may disappear only with the crawler/tenant,
    -- and may never be rewritten into replacement Reader authority.
    IF TG_TABLE_NAME = 'DocumentValidationAttestation'
       AND TG_OP IN ('UPDATE', 'DELETE') THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_deleted_validation_immutable_check',
        MESSAGE = 'Proven crawler deletion makes validation authority immutable.';
    END IF;

    -- Extraction-owned chunks already have a general immutable trigger;
    -- this closes the remaining mutable legacy-chunk path after deletion.
    IF TG_TABLE_NAME = 'DocumentTextChunk' AND TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_deleted_text_chunk_immutable_check',
        MESSAGE = 'Proven crawler deletion makes retained text chunks immutable.';
    END IF;

    -- Derived text is intentionally deleted during the pending -> deleted
    -- transaction. Other proof/authority rows can disappear only when the
    -- crawler itself is absent by this deferred check (tenant erasure).
    IF TG_OP = 'DELETE'
       AND TG_TABLE_NAME NOT IN (
         'DocumentTextExtraction',
         'DocumentTextManifestAdmission',
         'DocumentTextChunk'
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_deleted_child_delete_check',
        MESSAGE = 'Proven crawler deletion children can be erased only with their crawler or tenant.';
    END IF;

    IF NOT "public"."CrawlerImport_deleted_state_is_sound"(
      affected."organizationId",
      affected."crawlerImportId"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_deleted_child_consistency_check',
        MESSAGE = 'A child mutation would invalidate proven crawler deletion or reactivate Reader authority.';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION "public"."CrawlerImport_deleted_state_is_sound"(TEXT, TEXT) IS
  'Reciprocal terminal proof for one DELETED crawler across Reader, storage, quota, job, receipt, validation, and derived-text children.';

-- Immediate insert fences close the race where new work is proposed after the
-- crawler is already DELETED. Updates/deletes use the deferred final-state
-- proof so live user-ID detachment and exact tenant erasure remain possible.
CREATE TRIGGER "CrawlerImport_deleted_child_insert_guard"
BEFORE INSERT ON "Document"
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"();
CREATE TRIGGER "CrawlerImport_deleted_child_insert_guard"
BEFORE INSERT ON "Asset"
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"();
CREATE TRIGGER "CrawlerImport_deleted_child_insert_guard"
BEFORE INSERT ON "DocumentAsset"
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"();
CREATE TRIGGER "CrawlerImport_deleted_child_insert_guard"
BEFORE INSERT ON "InboxEntry"
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"();
CREATE TRIGGER "CrawlerImport_deleted_child_insert_guard"
BEFORE INSERT ON "ProvenanceRecord"
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"();
CREATE TRIGGER "CrawlerImport_deleted_child_insert_guard"
BEFORE INSERT ON "Job"
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"();
CREATE TRIGGER "CrawlerImport_deleted_child_insert_guard"
BEFORE INSERT ON "JobAttempt"
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"();
CREATE TRIGGER "CrawlerImport_deleted_child_insert_guard"
BEFORE INSERT ON "DocumentIngressAttempt"
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"();
CREATE TRIGGER "CrawlerImport_deleted_child_insert_guard"
BEFORE INSERT ON "DocumentIntake"
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"();
CREATE TRIGGER "CrawlerImport_deleted_child_insert_guard"
BEFORE INSERT ON "DocumentIngestReceipt"
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"();
CREATE TRIGGER "CrawlerImport_deleted_child_insert_guard"
BEFORE INSERT ON "DocumentValidationAttestation"
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"();
CREATE TRIGGER "CrawlerImport_deleted_child_insert_guard"
BEFORE INSERT ON "DocumentTextExtraction"
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"();
CREATE TRIGGER "CrawlerImport_deleted_child_insert_guard"
BEFORE INSERT ON "DocumentTextManifestAdmission"
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"();
CREATE TRIGGER "CrawlerImport_deleted_child_insert_guard"
BEFORE INSERT ON "DocumentTextChunk"
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"();

CREATE CONSTRAINT TRIGGER "CrawlerImport_deleted_child_consistency_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "Document"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"();
CREATE CONSTRAINT TRIGGER "CrawlerImport_deleted_child_consistency_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "Asset"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"();
CREATE CONSTRAINT TRIGGER "CrawlerImport_deleted_child_consistency_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "DocumentAsset"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"();
CREATE CONSTRAINT TRIGGER "CrawlerImport_deleted_child_consistency_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "InboxEntry"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"();
CREATE CONSTRAINT TRIGGER "CrawlerImport_deleted_child_consistency_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "ProvenanceRecord"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"();
CREATE CONSTRAINT TRIGGER "CrawlerImport_deleted_child_consistency_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "Job"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"();
CREATE CONSTRAINT TRIGGER "CrawlerImport_deleted_child_consistency_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "JobAttempt"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"();
CREATE CONSTRAINT TRIGGER "CrawlerImport_deleted_child_consistency_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "DocumentIngressAttempt"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"();
CREATE CONSTRAINT TRIGGER "CrawlerImport_deleted_child_consistency_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "DocumentIntake"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"();
CREATE CONSTRAINT TRIGGER "CrawlerImport_deleted_child_consistency_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "DocumentIngestReceipt"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"();
CREATE CONSTRAINT TRIGGER "CrawlerImport_deleted_child_consistency_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "DocumentValidationAttestation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"();
CREATE CONSTRAINT TRIGGER "CrawlerImport_deleted_child_consistency_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "DocumentTextExtraction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"();
CREATE CONSTRAINT TRIGGER "CrawlerImport_deleted_child_consistency_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "DocumentTextManifestAdmission"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"();
CREATE CONSTRAINT TRIGGER "CrawlerImport_deleted_child_consistency_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "DocumentTextChunk"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"();

REVOKE ALL ON FUNCTION "public"."CrawlerImport_deleted_child_ids"(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."CrawlerImport_deleted_state_is_sound"(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."CrawlerImport_reject_deleted_child_insert"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."CrawlerImport_deleted_child_consistency_check"() FROM PUBLIC;
