-- Retire machine-derived full text with crawler PDF custody whenever doing so
-- does not destroy a user-authored grounded evidence chain. The original PDF
-- deletion proof remains independent and continues to gate quota release.

CREATE TYPE "CrawlerDerivedTextDisposition" AS ENUM (
  'NONE',
  'PURGED',
  'RETAINED_FOR_USER_EVIDENCE'
);

ALTER TABLE "CrawlerImport"
  ADD COLUMN "derivedTextDisposition" "CrawlerDerivedTextDisposition",
  ADD COLUMN "derivedTextDisposedAt" TIMESTAMPTZ(3),
  ADD COLUMN "derivedTextPurgedChunkCount" INTEGER,
  ADD COLUMN "derivedTextRetainedChunkCount" INTEGER;

COMMENT ON COLUMN "CrawlerImport"."derivedTextDisposition" IS
  'URL-free disposition of generated text at proven custody deletion: purged unless a retained user evidence chain depends on its generation.';

-- These immutable extraction records ordinarily survive for the tenant's
-- lifetime. A pending/proven crawler custody deletion is the sole live-tenant
-- exception; foreign keys still fail closed if user evidence was overlooked.
CREATE OR REPLACE FUNCTION reject_document_text_extraction_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND (
        NOT EXISTS (
            SELECT 1
            FROM "public"."Organization"
            WHERE "id" = OLD."organizationId"
        )
        OR EXISTS (
            SELECT 1
            FROM "public"."CrawlerImport" AS crawler
            WHERE crawler."organizationId" = OLD."organizationId"
              AND crawler."documentId" = OLD."documentId"
              AND crawler."custodyStatus" IN ('DELETE_PENDING', 'DELETED')
        )
    ) THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION USING
        ERRCODE = '55000',
        TABLE = 'DocumentTextExtraction',
        MESSAGE = 'DocumentTextExtraction records are immutable; create a new policy generation.';
END;
$$;

CREATE OR REPLACE FUNCTION reject_extraction_owned_chunk_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."extractionId" IS NULL THEN
            RETURN OLD;
        END IF;
        IF NOT EXISTS (
            SELECT 1
            FROM "public"."Organization"
            WHERE "id" = OLD."organizationId"
        ) OR EXISTS (
            SELECT 1
            FROM "public"."CrawlerImport" AS crawler
            WHERE crawler."organizationId" = OLD."organizationId"
              AND crawler."documentId" = OLD."documentId"
              AND crawler."custodyStatus" IN ('DELETE_PENDING', 'DELETED')
        ) THEN
            RETURN OLD;
        END IF;
    ELSIF OLD."extractionId" IS NULL AND NEW."extractionId" IS NULL THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION USING
        ERRCODE = '55000',
        TABLE = 'DocumentTextChunk',
        MESSAGE = 'Extraction-owned DocumentTextChunk records are immutable.';
END;
$$;

CREATE OR REPLACE FUNCTION reject_document_text_manifest_admission_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND (
        NOT EXISTS (
            SELECT 1
            FROM "public"."Organization"
            WHERE "id" = OLD."organizationId"
        )
        OR EXISTS (
            SELECT 1
            FROM "public"."CrawlerImport" AS crawler
            WHERE crawler."organizationId" = OLD."organizationId"
              AND crawler."documentId" = OLD."documentId"
              AND crawler."custodyStatus" IN ('DELETE_PENDING', 'DELETED')
        )
    ) THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION USING
        ERRCODE = '55000',
        TABLE = 'DocumentTextManifestAdmission',
        MESSAGE = 'DocumentTextManifestAdmission records are immutable.';
END;
$$;

-- Conservatively reconcile any deletion completed during a rolling deploy.
-- Supporting generations are retained; every other full-text generation and
-- unowned legacy chunk is removed before the new invariant is validated.
DROP TABLE IF EXISTS "CrawlerDerivedTextBackfill";
CREATE TABLE "CrawlerDerivedTextBackfill" (
  "crawlerImportId" TEXT PRIMARY KEY,
  "initialChunkCount" INTEGER NOT NULL,
  "retainedChunkCount" INTEGER
);

INSERT INTO "CrawlerDerivedTextBackfill" ("crawlerImportId", "initialChunkCount")
SELECT crawler."id", count(chunk."id")::integer
FROM "CrawlerImport" AS crawler
LEFT JOIN "DocumentTextChunk" AS chunk
  ON chunk."organizationId" = crawler."organizationId"
 AND chunk."documentId" = crawler."documentId"
WHERE crawler."custodyStatus" = 'DELETED'
GROUP BY crawler."id";

DELETE FROM "DocumentTextExtraction" AS extraction
USING "CrawlerImport" AS crawler
WHERE crawler."custodyStatus" = 'DELETED'
  AND crawler."organizationId" = extraction."organizationId"
  AND crawler."documentId" = extraction."documentId"
  AND NOT EXISTS (
    SELECT 1
    FROM "EvidenceTextAnchor" AS anchor
    WHERE anchor."organizationId" = extraction."organizationId"
      AND anchor."documentId" = extraction."documentId"
      AND anchor."extractionId" = extraction."id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "EvidenceNote" AS note
    JOIN "DocumentTextChunk" AS chunk
      ON chunk."organizationId" = note."organizationId"
     AND chunk."id" = note."documentChunkId"
    WHERE chunk."organizationId" = extraction."organizationId"
      AND chunk."documentId" = extraction."documentId"
      AND chunk."extractionId" = extraction."id"
  );

DELETE FROM "DocumentTextChunk" AS chunk
USING "CrawlerImport" AS crawler
WHERE crawler."custodyStatus" = 'DELETED'
  AND crawler."organizationId" = chunk."organizationId"
  AND crawler."documentId" = chunk."documentId"
  AND chunk."extractionId" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "EvidenceNote" AS note
    WHERE note."organizationId" = chunk."organizationId"
      AND note."documentChunkId" = chunk."id"
  );

UPDATE "CrawlerDerivedTextBackfill" AS backfill
SET "retainedChunkCount" = (
  SELECT count(*)::integer
  FROM "CrawlerImport" AS crawler
  JOIN "DocumentTextChunk" AS chunk
    ON chunk."organizationId" = crawler."organizationId"
   AND chunk."documentId" = crawler."documentId"
  WHERE crawler."id" = backfill."crawlerImportId"
);

UPDATE "CrawlerImport" AS crawler
SET
  "derivedTextDisposition" = CASE
    WHEN backfill."retainedChunkCount" > 0
      THEN 'RETAINED_FOR_USER_EVIDENCE'::"CrawlerDerivedTextDisposition"
    WHEN backfill."initialChunkCount" > 0
      THEN 'PURGED'::"CrawlerDerivedTextDisposition"
    ELSE 'NONE'::"CrawlerDerivedTextDisposition"
  END,
  "derivedTextDisposedAt" = crawler."deletedAt",
  "derivedTextPurgedChunkCount" = backfill."initialChunkCount" - backfill."retainedChunkCount",
  "derivedTextRetainedChunkCount" = backfill."retainedChunkCount"
FROM "CrawlerDerivedTextBackfill" AS backfill
WHERE crawler."id" = backfill."crawlerImportId";

DROP TABLE "CrawlerDerivedTextBackfill";

ALTER TABLE "CrawlerImport"
  ADD CONSTRAINT "CrawlerImport_derived_text_disposition_check" CHECK (
    (
      "custodyStatus" <> 'DELETED'
      AND "derivedTextDisposition" IS NULL
      AND "derivedTextDisposedAt" IS NULL
      AND "derivedTextPurgedChunkCount" IS NULL
      AND "derivedTextRetainedChunkCount" IS NULL
    )
    OR (
      "custodyStatus" = 'DELETED'
      AND "derivedTextDisposition" IS NOT NULL
      AND "derivedTextDisposedAt" = "deletedAt"
      AND "derivedTextPurgedChunkCount" >= 0
      AND "derivedTextRetainedChunkCount" >= 0
      AND (
        (
          "derivedTextDisposition" = 'NONE'
          AND "derivedTextPurgedChunkCount" = 0
          AND "derivedTextRetainedChunkCount" = 0
        )
        OR (
          "derivedTextDisposition" = 'PURGED'
          AND "derivedTextPurgedChunkCount" > 0
          AND "derivedTextRetainedChunkCount" = 0
        )
        OR (
          "derivedTextDisposition" = 'RETAINED_FOR_USER_EVIDENCE'
          AND "derivedTextRetainedChunkCount" > 0
        )
      )
    )
  );

CREATE FUNCTION "public"."CrawlerImport_derived_text_state_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF ROW(
      NEW."derivedTextDisposition", NEW."derivedTextDisposedAt",
      NEW."derivedTextPurgedChunkCount", NEW."derivedTextRetainedChunkCount"
    ) IS DISTINCT FROM ROW(NULL, NULL, NULL, NULL) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CrawlerImport_initial_derived_text_check',
        MESSAGE = 'Crawler derived-text disposition is recorded only at proven deletion.';
    END IF;
  ELSIF ROW(
    NEW."derivedTextDisposition", NEW."derivedTextDisposedAt",
    NEW."derivedTextPurgedChunkCount", NEW."derivedTextRetainedChunkCount"
  ) IS DISTINCT FROM ROW(
    OLD."derivedTextDisposition", OLD."derivedTextDisposedAt",
    OLD."derivedTextPurgedChunkCount", OLD."derivedTextRetainedChunkCount"
  ) AND NOT (
    OLD."custodyStatus" = 'DELETE_PENDING'
    AND NEW."custodyStatus" = 'DELETED'
    AND OLD."derivedTextDisposition" IS NULL
    AND OLD."derivedTextDisposedAt" IS NULL
    AND OLD."derivedTextPurgedChunkCount" IS NULL
    AND OLD."derivedTextRetainedChunkCount" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_derived_text_immutability_check',
      MESSAGE = 'Crawler derived-text disposition is immutable after proven deletion.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "CrawlerImport_derived_text_state_guard_trigger"
BEFORE INSERT OR UPDATE ON "CrawlerImport"
FOR EACH ROW
EXECUTE FUNCTION "public"."CrawlerImport_derived_text_state_guard"();

-- Commit-time proof that no unreferenced generated text survives and every
-- retained chunk count exactly matches the URL-free disposition ledger.
CREATE FUNCTION "public"."CrawlerImport_derived_text_consistency_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  actual_retained_chunks INTEGER;
BEGIN
  IF NEW."custodyStatus" <> 'DELETED' THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::integer
  INTO actual_retained_chunks
  FROM "public"."DocumentTextChunk" AS chunk
  WHERE chunk."organizationId" = NEW."organizationId"
    AND chunk."documentId" = NEW."documentId";

  IF actual_retained_chunks <> NEW."derivedTextRetainedChunkCount"
     OR EXISTS (
       SELECT 1
       FROM "public"."DocumentTextExtraction" AS extraction
       WHERE extraction."organizationId" = NEW."organizationId"
         AND extraction."documentId" = NEW."documentId"
         AND NOT EXISTS (
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
     OR EXISTS (
       SELECT 1
       FROM "public"."DocumentTextChunk" AS chunk
       WHERE chunk."organizationId" = NEW."organizationId"
         AND chunk."documentId" = NEW."documentId"
         AND chunk."extractionId" IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM "public"."EvidenceNote" AS note
           WHERE note."organizationId" = chunk."organizationId"
             AND note."documentChunkId" = chunk."id"
         )
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CrawlerImport_derived_text_cleanup_check',
      MESSAGE = 'Deleted crawler custody may retain only generated text required by user-authored evidence.';
  END IF;

  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "CrawlerImport_derived_text_consistency_constraint"
AFTER INSERT OR UPDATE ON "CrawlerImport"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "public"."CrawlerImport_derived_text_consistency_check"();
