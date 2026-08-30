-- Supabase Storage is an exact-object custody provider. These guards are kept
-- separate from the enum migration so PostgreSQL commits the new enum value
-- before constraints and trigger functions reference it.

BEGIN;

CREATE FUNCTION "Asset_supabase_storage_update_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."storageProvider" = 'SUPABASE_STORAGE'
       OR NEW."storageProvider" = 'SUPABASE_STORAGE'
    THEN
        IF ROW(
            NEW."id",
            NEW."organizationId",
            NEW."storageProvider",
            NEW."bucket",
            NEW."objectKey",
            NEW."createdAt"
        ) IS DISTINCT FROM ROW(
            OLD."id",
            OLD."organizationId",
            OLD."storageProvider",
            OLD."bucket",
            OLD."objectKey",
            OLD."createdAt"
        ) THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'Asset_supabase_storage_identity_check',
                MESSAGE = 'A Supabase Storage asset cannot change its provider identity.';
        END IF;
    END IF;

    IF OLD."storageProvider" = 'SUPABASE_STORAGE'
       AND OLD."status" <> 'UPLOADING'
       AND ROW(
           NEW."objectKey",
           NEW."physicalLocator",
           NEW."mimeType",
           NEW."sizeBytes",
           NEW."sha256",
           NEW."etag"
       ) IS DISTINCT FROM ROW(
           OLD."objectKey",
           OLD."physicalLocator",
           OLD."mimeType",
           OLD."sizeBytes",
           OLD."sha256",
           OLD."etag"
       )
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'Asset_supabase_storage_admission_immutable_check',
            MESSAGE = 'An admitted Supabase Storage object binding is immutable.';
    END IF;

    IF OLD."storageProvider" = 'SUPABASE_STORAGE'
       AND OLD."status" <> 'UPLOADING'
       AND NEW."status" = 'UPLOADING'
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'Asset_supabase_storage_admission_immutable_check',
            MESSAGE = 'An admitted Supabase Storage asset cannot return to uploading.';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "Asset_supabase_storage_update_guard_trigger"
BEFORE UPDATE ON "Asset"
FOR EACH ROW
EXECUTE FUNCTION "Asset_supabase_storage_update_guard"();

CREATE FUNCTION "UploadAttempt_update_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(
        NEW."id",
        NEW."organizationId",
        NEW."uploadSessionId",
        NEW."assetId",
        NEW."attemptNumber",
        NEW."storageKey",
        NEW."expectedSizeBytes",
        NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id",
        OLD."organizationId",
        OLD."uploadSessionId",
        OLD."assetId",
        OLD."attemptNumber",
        OLD."storageKey",
        OLD."expectedSizeBytes",
        OLD."createdAt"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'UploadAttempt_identity_immutable_check',
            MESSAGE = 'An upload attempt cannot change its reserved object identity.';
    END IF;

    -- WRITTEN -> COMMITTED may restamp the authoritative storedAt while the
    -- current local adapter is being replaced. Once committed, or once an
    -- immutable receipt refers to the attempt, its observed bytes are fixed.
    IF (
        OLD."status" = 'COMMITTED'
        OR EXISTS (
            SELECT 1
            FROM public."DocumentIngestReceipt" AS receipt
            WHERE receipt."organizationId" = OLD."organizationId"
              AND receipt."uploadAttemptId" = OLD."id"
        )
    ) AND ROW(
        NEW."receivedSizeBytes",
        NEW."sha256",
        NEW."storedAt"
    ) IS DISTINCT FROM ROW(
        OLD."receivedSizeBytes",
        OLD."sha256",
        OLD."storedAt"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'UploadAttempt_receipt_immutable_check',
            MESSAGE = 'Committed upload-attempt receipt fields are immutable.';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "UploadAttempt_update_guard_trigger"
BEFORE UPDATE ON "UploadAttempt"
FOR EACH ROW
EXECUTE FUNCTION "UploadAttempt_update_guard"();

CREATE FUNCTION "DocumentIngestReceipt_supabase_storage_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    bound_asset_is_supabase BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM public."Asset" AS asset
        WHERE asset."organizationId" = NEW."organizationId"
          AND asset."id" = NEW."assetId"
          AND asset."storageProvider" = 'SUPABASE_STORAGE'
    )
    INTO bound_asset_is_supabase;

    IF bound_asset_is_supabase THEN
        IF NEW."storageVersion" <> 'supabase-private-object-v1'
           OR NEW."sourceEtag" IS NULL
           OR NEW."storageAuthorityGeneration" IS NOT NULL
           OR NOT EXISTS (
               SELECT 1
               FROM public."Asset" AS asset
               WHERE asset."organizationId" = NEW."organizationId"
                 AND asset."id" = NEW."assetId"
                 AND asset."storageProvider" = 'SUPABASE_STORAGE'
                 AND asset."status" IN ('QUARANTINED', 'SCANNING', 'READY')
                 AND asset."etag" = NEW."sourceEtag"
           )
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'DocumentIngestReceipt_supabase_storage_binding_check',
                MESSAGE = 'A Supabase ingest receipt must bind the admitted provider ETag and storage protocol.';
        END IF;
    ELSIF NEW."storageVersion" = 'supabase-private-object-v1' THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIngestReceipt_supabase_storage_binding_check',
            MESSAGE = 'A Supabase storage receipt requires a Supabase Storage asset.';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "DocumentIngestReceipt_supabase_storage_guard_trigger"
BEFORE INSERT ON "DocumentIngestReceipt"
FOR EACH ROW
EXECUTE FUNCTION "DocumentIngestReceipt_supabase_storage_guard"();

-- This validated constraint is deliberately the final migration statement.
-- Readiness uses it as the catalog sentinel for all guards installed above.
-- A metadata-only HTTP finalize remains UPLOADING; QUARANTINED is reserved for
-- the trusted Sandbox transition that supplies the verified byte digest.
ALTER TABLE "Asset"
    ADD CONSTRAINT "Asset_supabase_storage_shape_check"
        CHECK (
            "storageProvider" <> 'SUPABASE_STORAGE'
            OR (
                "bucket" IS NOT NULL
                AND "bucket" = 'paperpilot-private-pdfs'
                AND "physicalLocator" IS NULL
                AND "objectKey" ~ '^tenants/[a-f0-9]{64}/assets/[a-f0-9]{64}/attempts/[a-f0-9]{64}/original[.]pdf$'
                AND (
                    "status" NOT IN ('QUARANTINED', 'SCANNING', 'READY')
                    OR (
                        "mimeType" IS NOT NULL
                        AND "mimeType" = 'application/pdf'
                        AND "sizeBytes" IS NOT NULL
                        AND "sizeBytes" > 0
                        AND "sha256" IS NOT NULL
                        AND "sha256" ~ '^[a-f0-9]{64}$'
                        AND "etag" IS NOT NULL
                        AND octet_length("etag") BETWEEN 1 AND 255
                        AND "etag" = btrim("etag")
                        AND "etag" !~ '[[:cntrl:]]'
                    )
                )
            )
        );

COMMIT;
