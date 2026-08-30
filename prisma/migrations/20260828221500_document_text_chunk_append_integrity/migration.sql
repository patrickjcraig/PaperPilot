-- Revalidate an extraction's final chunk set whenever extraction-owned chunks
-- are inserted. The manifest-side trigger covers the original generation
-- transaction; this chunk-side trigger closes the append-after-commit path.

CREATE OR REPLACE FUNCTION assert_document_text_extraction_aggregate(
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
    invalid_content_hash_count BIGINT;
BEGIN
    SELECT "chunkCount", "textBytes"
    INTO expected_chunk_count, expected_text_bytes
    FROM "DocumentTextExtraction"
    WHERE "organizationId" = target_organization_id
      AND "id" = target_extraction_id;

    -- Tenant erasure can remove the manifest before deferred triggers run.
    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT
        count(*),
        COALESCE(sum(octet_length("text")), 0),
        min("sequence"),
        max("sequence"),
        count(*) FILTER (
            WHERE "contentHash" <> encode(
                sha256(convert_to("text", 'UTF8')),
                'hex'
            )
        )
    INTO
        actual_chunk_count,
        actual_text_bytes,
        minimum_sequence,
        maximum_sequence,
        invalid_content_hash_count
    FROM "DocumentTextChunk"
    WHERE "organizationId" = target_organization_id
      AND "extractionId" = target_extraction_id;

    IF actual_chunk_count <> expected_chunk_count
       OR actual_text_bytes <> expected_text_bytes
       OR invalid_content_hash_count <> 0
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

CREATE FUNCTION enforce_document_text_chunk_aggregate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    expected_chunk_count INTEGER;
BEGIN
    IF NEW."extractionId" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT "chunkCount"
    INTO expected_chunk_count
    FROM "DocumentTextExtraction"
    WHERE "organizationId" = NEW."organizationId"
      AND "documentId" = NEW."documentId"
      AND "id" = NEW."extractionId";

    -- The composite foreign key reports a missing or cross-extraction binding.
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- Every valid EXTRACTED generation contains its final sequence. Checking
    -- that event observes the transaction's complete set while avoiding one
    -- full aggregate scan per chunk. Any append is also at or beyond this
    -- sentinel and is therefore revalidated.
    IF NEW."sequence" >= expected_chunk_count - 1 THEN
        PERFORM assert_document_text_extraction_aggregate(
            NEW."organizationId",
            NEW."extractionId"
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "DocumentTextChunk_extraction_aggregate_trigger"
    AFTER INSERT ON "DocumentTextChunk"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_document_text_chunk_aggregate();

-- Keep all existing row-bound checks, but defer them to the same final-state
-- boundary. This makes sequence = chunkCount reach the aggregate check at
-- commit instead of failing before the chunk-side invariant can run.
DROP TRIGGER "DocumentTextChunk_extraction_bounds_trigger"
    ON "DocumentTextChunk";

CREATE CONSTRAINT TRIGGER "DocumentTextChunk_extraction_bounds_trigger"
    AFTER INSERT OR UPDATE ON "DocumentTextChunk"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_document_text_chunk_extraction_bounds();
