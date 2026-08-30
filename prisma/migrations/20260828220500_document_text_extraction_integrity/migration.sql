ALTER TABLE "DocumentTextExtraction"
    DROP CONSTRAINT "DocumentTextExtraction_timestamps_check",
    ADD CONSTRAINT "DocumentTextExtraction_timestamps_check" CHECK (
        "extractedAt" <= "completedAt"
    );

ALTER TABLE "DocumentTextChunk"
    DROP CONSTRAINT "DocumentTextChunk_extraction_owned_check",
    ADD CONSTRAINT "DocumentTextChunk_extraction_owned_check" CHECK (
        "extractionId" IS NULL
        OR (
            "sequence" BETWEEN 0 AND 4095
            AND "pageStart" BETWEEN 1 AND 2000
            AND "pageEnd" = "pageStart"
            AND "sectionId" IS NULL
            AND "sectionTitle" IS NULL
            AND "paragraphId" IS NOT NULL
            AND char_length("paragraphId") BETWEEN 5 AND 64
            AND "paragraphId" ~ '^p[1-9][0-9]*-p[1-9][0-9]*$'
            AND substring("paragraphId" from '^p([1-9][0-9]*)-p[1-9][0-9]*$')::integer = "pageStart"
            AND "charStart" IS NULL
            AND "charEnd" IS NULL
            AND octet_length("text") BETWEEN 1 AND 8192
            AND "contentHash" ~ '^[0-9a-f]{64}$'
            AND "locator" IS NOT NULL
            AND "locator" = jsonb_build_object(
                'schemaVersion', 1,
                'kind', 'pdf-text',
                'pageNumber', "pageStart",
                'paragraphId', "paragraphId"
            )
        )
    );

ALTER TABLE "DocumentTextExtraction"
    DROP CONSTRAINT "DocumentTextExtraction_organizationId_documentId_assetId_j_fkey",
    DROP CONSTRAINT "DocumentTextExtraction_organizationId_jobId_jobAttemptId_fkey",
    DROP CONSTRAINT "DocumentTextExtraction_organizationId_documentId_assetId_v_fkey",
    DROP CONSTRAINT "DocumentTextExtraction_organizationId_assetId_fkey",
    DROP CONSTRAINT "DocumentTextExtraction_organizationId_documentId_fkey",
    ADD CONSTRAINT "DocumentTextExtraction_organizationId_documentId_assetId_j_fkey"
        FOREIGN KEY ("organizationId", "documentId", "assetId", "jobId")
        REFERENCES "Job"("organizationId", "documentId", "assetId", "id")
        ON DELETE CASCADE ON UPDATE NO ACTION,
    ADD CONSTRAINT "DocumentTextExtraction_organizationId_jobId_jobAttemptId_fkey"
        FOREIGN KEY ("organizationId", "jobId", "jobAttemptId")
        REFERENCES "JobAttempt"("organizationId", "jobId", "id")
        ON DELETE CASCADE ON UPDATE NO ACTION,
    ADD CONSTRAINT "DocumentTextExtraction_organizationId_documentId_assetId_v_fkey"
        FOREIGN KEY ("organizationId", "documentId", "assetId", "validationAttestationId")
        REFERENCES "DocumentValidationAttestation"("organizationId", "documentId", "assetId", "id")
        ON DELETE CASCADE ON UPDATE NO ACTION,
    ADD CONSTRAINT "DocumentTextExtraction_organizationId_assetId_fkey"
        FOREIGN KEY ("organizationId", "assetId")
        REFERENCES "Asset"("organizationId", "id")
        ON DELETE CASCADE ON UPDATE NO ACTION,
    ADD CONSTRAINT "DocumentTextExtraction_organizationId_documentId_fkey"
        FOREIGN KEY ("organizationId", "documentId")
        REFERENCES "Document"("organizationId", "id")
        ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "DocumentTextChunk"
    DROP CONSTRAINT "DocumentTextChunk_organizationId_documentId_extractionId_fkey",
    ADD CONSTRAINT "DocumentTextChunk_organizationId_documentId_extractionId_fkey"
        FOREIGN KEY ("organizationId", "documentId", "extractionId")
        REFERENCES "DocumentTextExtraction"("organizationId", "documentId", "id")
        ON DELETE CASCADE ON UPDATE NO ACTION;

DROP TRIGGER "DocumentTextExtraction_immutable_trigger" ON "DocumentTextExtraction";
DROP FUNCTION IF EXISTS reject_document_text_extraction_update();
DROP FUNCTION IF EXISTS reject_document_text_extraction_mutation();

DROP TRIGGER IF EXISTS "DocumentTextChunk_immutable_trigger" ON "DocumentTextChunk";
DROP FUNCTION IF EXISTS reject_extraction_owned_chunk_mutation();

DROP TRIGGER IF EXISTS "DocumentTextExtraction_chunk_aggregate_trigger"
    ON "DocumentTextExtraction";
DROP FUNCTION IF EXISTS enforce_document_text_extraction_aggregate();
DROP FUNCTION IF EXISTS assert_document_text_extraction_aggregate(TEXT, TEXT);

CREATE FUNCTION reject_document_text_extraction_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1
        FROM "Organization"
        WHERE "id" = OLD."organizationId"
    ) THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION USING
        ERRCODE = '55000',
        TABLE = 'DocumentTextExtraction',
        MESSAGE = 'DocumentTextExtraction records are immutable; create a new policy generation.';
END;
$$;

CREATE TRIGGER "DocumentTextExtraction_immutable_trigger"
    BEFORE UPDATE OR DELETE ON "DocumentTextExtraction"
    FOR EACH ROW
    EXECUTE FUNCTION reject_document_text_extraction_mutation();

CREATE FUNCTION reject_extraction_owned_chunk_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."extractionId" IS NULL THEN
            RETURN OLD;
        END IF;
        IF NOT EXISTS (
            SELECT 1
            FROM "Organization"
            WHERE "id" = OLD."organizationId"
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

CREATE TRIGGER "DocumentTextChunk_immutable_trigger"
    BEFORE UPDATE OR DELETE ON "DocumentTextChunk"
    FOR EACH ROW
    EXECUTE FUNCTION reject_extraction_owned_chunk_mutation();

CREATE FUNCTION assert_document_text_extraction_aggregate(
    target_organization_id TEXT,
    target_extraction_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    expected_chunk_count INTEGER;
    expected_text_bytes INTEGER;
    actual_chunk_count BIGINT;
    actual_text_bytes BIGINT;
    minimum_sequence INTEGER;
    maximum_sequence INTEGER;
BEGIN
    SELECT "chunkCount", "textBytes"
    INTO expected_chunk_count, expected_text_bytes
    FROM "DocumentTextExtraction"
    WHERE "organizationId" = target_organization_id
      AND "id" = target_extraction_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT
        count(*),
        COALESCE(sum(octet_length("text")), 0),
        min("sequence"),
        max("sequence")
    INTO
        actual_chunk_count,
        actual_text_bytes,
        minimum_sequence,
        maximum_sequence
    FROM "DocumentTextChunk"
    WHERE "organizationId" = target_organization_id
      AND "extractionId" = target_extraction_id;

    IF actual_chunk_count <> expected_chunk_count
       OR actual_text_bytes <> expected_text_bytes
       OR (
           expected_chunk_count = 0
           AND (minimum_sequence IS NOT NULL OR maximum_sequence IS NOT NULL)
       )
       OR (
           expected_chunk_count > 0
           AND (minimum_sequence <> 0 OR maximum_sequence <> expected_chunk_count - 1)
       )
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentTextExtraction_chunk_aggregate_check',
            MESSAGE = 'Text extraction chunks must exactly match their manifest at commit.';
    END IF;
END;
$$;

CREATE FUNCTION enforce_document_text_extraction_aggregate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM assert_document_text_extraction_aggregate(
        NEW."organizationId",
        NEW."id"
    );
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "DocumentTextExtraction_chunk_aggregate_trigger"
    AFTER INSERT ON "DocumentTextExtraction"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_document_text_extraction_aggregate();
