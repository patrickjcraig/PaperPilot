-- Keep the extraction-owned chunk bounds guard immediate for malformed rows.
-- The one intentionally deferred boundary is sequence = chunkCount: it is the
-- append sentinel covered by DocumentTextChunk_extraction_aggregate_trigger.

CREATE OR REPLACE FUNCTION enforce_document_text_chunk_extraction_bounds()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    extraction_page_count INTEGER;
    extraction_chunk_count INTEGER;
    extraction_text_bytes INTEGER;
    extraction_verdict "TextExtractionVerdict";
BEGIN
    IF NEW."extractionId" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT
        extraction."pageCount",
        extraction."chunkCount",
        extraction."textBytes",
        extraction."verdict"
    INTO
        extraction_page_count,
        extraction_chunk_count,
        extraction_text_bytes,
        extraction_verdict
    FROM "DocumentTextExtraction" AS extraction
    WHERE extraction."organizationId" = NEW."organizationId"
      AND extraction."documentId" = NEW."documentId"
      AND extraction."id" = NEW."extractionId";

    IF NOT FOUND
       OR extraction_verdict <> 'EXTRACTED'
       OR NEW."sequence" < 0
       OR NEW."sequence" > extraction_chunk_count
       OR NEW."pageStart" IS NULL
       OR NEW."pageEnd" IS NULL
       OR NEW."pageEnd" > extraction_page_count
       OR octet_length(NEW."text") > extraction_text_bytes
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentTextChunk_extraction_bounds_check',
            MESSAGE = 'Text chunk bounds must fit their exact extracted manifest.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER "DocumentTextChunk_extraction_bounds_trigger"
    ON "DocumentTextChunk";

CREATE TRIGGER "DocumentTextChunk_extraction_bounds_trigger"
    BEFORE INSERT OR UPDATE OF
        "organizationId",
        "documentId",
        "extractionId",
        "sequence",
        "pageStart",
        "pageEnd",
        "text"
    ON "DocumentTextChunk"
    FOR EACH ROW
    EXECUTE FUNCTION enforce_document_text_chunk_extraction_bounds();
