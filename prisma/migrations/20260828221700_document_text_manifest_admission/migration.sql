-- Admit each immutable text-extraction manifest exactly once after PostgreSQL
-- has verified its complete ordered chunk set. Reader can then trust this
-- compact seal while fetching only a bounded sequence range.

CREATE TABLE "DocumentTextManifestAdmission" (
    "extractionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "schemaVersion" SMALLINT NOT NULL,
    "verdict" "TextExtractionVerdict" NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "textBytes" INTEGER NOT NULL,
    "manifestSha256" CHAR(64) NOT NULL,
    "admittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentTextManifestAdmission_pkey" PRIMARY KEY ("extractionId"),
    CONSTRAINT "DocumentTextManifestAdmission_schema_check" CHECK (
        "schemaVersion" = 1
    ),
    CONSTRAINT "DocumentTextManifestAdmission_digest_check" CHECK (
        "manifestSha256" ~ '^[0-9a-f]{64}$'
        AND "manifestSha256" <> repeat('0', 64)
    ),
    CONSTRAINT "DocumentTextManifestAdmission_counts_check" CHECK (
        "pageCount" BETWEEN 1 AND 2000
        AND "chunkCount" BETWEEN 0 AND 4096
        AND "textBytes" BETWEEN 0 AND 4194304
    ),
    CONSTRAINT "DocumentTextManifestAdmission_verdict_check" CHECK (
        (
            "verdict" = 'EXTRACTED'
            AND "chunkCount" > 0
            AND "textBytes" > 0
        )
        OR (
            "verdict" = 'NO_TEXT'
            AND "chunkCount" = 0
            AND "textBytes" = 0
        )
    )
);

CREATE UNIQUE INDEX "DocumentTextManifestAdmission_binding_key"
    ON "DocumentTextManifestAdmission"(
        "organizationId",
        "documentId",
        "extractionId"
    );

CREATE INDEX "DocumentTextManifestAdmission_document_idx"
    ON "DocumentTextManifestAdmission"("organizationId", "documentId");

ALTER TABLE "DocumentTextManifestAdmission"
    ADD CONSTRAINT "DocumentTextManifestAdmission_extraction_fkey"
        FOREIGN KEY ("organizationId", "documentId", "extractionId")
        REFERENCES "DocumentTextExtraction"("organizationId", "documentId", "id")
        ON DELETE CASCADE ON UPDATE NO ACTION;

-- A stable length-prefixed UTF-8 field avoids delimiter ambiguity and does not
-- depend on PostgreSQL's JSON textual rendering.
CREATE FUNCTION document_text_manifest_field_v1(field_value TEXT)
RETURNS BYTEA
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT int4send(octet_length(field_value))
        || convert_to(field_value, 'UTF8');
$$;

-- Validate the complete immutable manifest and return its versioned digest.
-- The digest is a SHA-256 chain over a domain-separated header and ordered
-- chunk leaves. Each leaf binds the chunk identity, order, locator identity,
-- and the already revalidated SHA-256 of its exact UTF-8 text.
CREATE FUNCTION compute_document_text_manifest_v1(
    target_organization_id TEXT,
    target_document_id TEXT,
    target_extraction_id TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    generation RECORD;
    manifest_chunk RECORD;
    manifest_state BYTEA;
    chunk_leaf BYTEA;
    expected_sequence INTEGER := 0;
    measured_text_bytes BIGINT := 0;
    previous_page INTEGER := 0;
    previous_paragraph NUMERIC := 0;
    paragraph_match TEXT[];
    paragraph_page NUMERIC;
    paragraph_ordinal NUMERIC;
BEGIN
    SELECT
        extraction."organizationId",
        extraction."documentId",
        extraction."id",
        extraction."verdict",
        extraction."pageCount",
        extraction."chunkCount",
        extraction."textBytes"
    INTO generation
    FROM "DocumentTextExtraction" AS extraction
    WHERE extraction."organizationId" = target_organization_id
      AND extraction."documentId" = target_document_id
      AND extraction."id" = target_extraction_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = '23503',
            CONSTRAINT = 'DocumentTextManifestAdmission_extraction_fkey',
            MESSAGE = 'A manifest admission requires its exact extraction generation.';
    END IF;

    IF generation."pageCount" NOT BETWEEN 1 AND 2000
       OR generation."chunkCount" NOT BETWEEN 0 AND 4096
       OR generation."textBytes" NOT BETWEEN 0 AND 4194304
       OR (
           generation."verdict" = 'EXTRACTED'
           AND (generation."chunkCount" < 1 OR generation."textBytes" < 1)
       )
       OR (
           generation."verdict" = 'NO_TEXT'
           AND (generation."chunkCount" <> 0 OR generation."textBytes" <> 0)
       )
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentTextManifestAdmission_generation_check',
            MESSAGE = 'A manifest admission requires a bounded extraction generation.';
    END IF;

    manifest_state := sha256(
        convert_to('PaperPilot', 'UTF8')
        || decode('00', 'hex')
        || convert_to('DocumentTextManifest', 'UTF8')
        || decode('00', 'hex')
        || convert_to('v1', 'UTF8')
        || decode('00', 'hex')
        || document_text_manifest_field_v1(generation."organizationId")
        || document_text_manifest_field_v1(generation."documentId")
        || document_text_manifest_field_v1(generation."id")
        || document_text_manifest_field_v1(generation."verdict"::TEXT)
        || int4send(generation."pageCount")
        || int4send(generation."chunkCount")
        || int4send(generation."textBytes")
    );

    FOR manifest_chunk IN
        SELECT
            chunk."id",
            chunk."organizationId",
            chunk."documentId",
            chunk."extractionId",
            chunk."sequence",
            chunk."pageStart",
            chunk."pageEnd",
            chunk."sectionId",
            chunk."sectionTitle",
            chunk."paragraphId",
            chunk."charStart",
            chunk."charEnd",
            chunk."text",
            chunk."contentHash",
            chunk."locator"
        FROM "DocumentTextChunk" AS chunk
        WHERE chunk."organizationId" = target_organization_id
          AND chunk."documentId" = target_document_id
          AND chunk."extractionId" = target_extraction_id
        ORDER BY chunk."sequence" ASC
    LOOP
        IF generation."verdict" <> 'EXTRACTED'
           OR manifest_chunk."organizationId" <> generation."organizationId"
           OR manifest_chunk."documentId" <> generation."documentId"
           OR manifest_chunk."extractionId" <> generation."id"
           OR manifest_chunk."sequence" <> expected_sequence
           OR octet_length(manifest_chunk."id") NOT BETWEEN 1 AND 200
           OR manifest_chunk."id" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
           OR manifest_chunk."pageStart" NOT BETWEEN 1 AND generation."pageCount"
           OR manifest_chunk."pageEnd" <> manifest_chunk."pageStart"
           OR manifest_chunk."sectionId" IS NOT NULL
           OR manifest_chunk."sectionTitle" IS NOT NULL
           OR manifest_chunk."paragraphId" IS NULL
           OR char_length(manifest_chunk."paragraphId") NOT BETWEEN 5 AND 64
           OR manifest_chunk."charStart" IS NOT NULL
           OR manifest_chunk."charEnd" IS NOT NULL
           OR octet_length(manifest_chunk."text") NOT BETWEEN 1 AND 8192
           OR manifest_chunk."contentHash" !~ '^[0-9a-f]{64}$'
           OR manifest_chunk."contentHash" <> encode(
               sha256(convert_to(manifest_chunk."text", 'UTF8')),
               'hex'
           )
           OR manifest_chunk."locator" IS NULL
           OR manifest_chunk."locator" <> jsonb_build_object(
               'schemaVersion', 1,
               'kind', 'pdf-text',
               'pageNumber', manifest_chunk."pageStart",
               'paragraphId', manifest_chunk."paragraphId"
           )
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'DocumentTextManifestAdmission_chunk_check',
                MESSAGE = 'A manifest admission requires canonical extraction-owned chunks.';
        END IF;

        paragraph_match := regexp_match(
            manifest_chunk."paragraphId",
            '^p([1-9][0-9]*)-p([1-9][0-9]*)$'
        );
        IF paragraph_match IS NULL THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'DocumentTextManifestAdmission_paragraph_check',
                MESSAGE = 'A manifest admission requires canonical paragraph identifiers.';
        END IF;
        paragraph_page := paragraph_match[1]::NUMERIC;
        paragraph_ordinal := paragraph_match[2]::NUMERIC;
        IF paragraph_page <> manifest_chunk."pageStart"
           OR paragraph_ordinal > 4096
           OR manifest_chunk."pageStart" < previous_page
           OR (
               manifest_chunk."pageStart" <> previous_page
               AND paragraph_ordinal <> 1
           )
           OR (
               manifest_chunk."pageStart" = previous_page
               AND paragraph_ordinal <> previous_paragraph
               AND paragraph_ordinal <> previous_paragraph + 1
           )
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'DocumentTextManifestAdmission_order_check',
                MESSAGE = 'A manifest admission requires ordered pages and paragraphs.';
        END IF;

        IF normalize(manifest_chunk."text", NFC) <> manifest_chunk."text"
           OR btrim(manifest_chunk."text", ' ') <> manifest_chunk."text"
           OR left(manifest_chunk."text", 1) IN (chr(8232), chr(8233))
           OR right(manifest_chunk."text", 1) IN (chr(8232), chr(8233))
           OR position('  ' IN manifest_chunk."text") > 0
           OR EXISTS (
               SELECT 1
               FROM generate_series(1, 31) AS prohibited(codepoint)
               WHERE position(chr(prohibited.codepoint) IN manifest_chunk."text") > 0
           )
           OR EXISTS (
               SELECT 1
               FROM generate_series(127, 159) AS prohibited(codepoint)
               WHERE position(chr(prohibited.codepoint) IN manifest_chunk."text") > 0
           )
           OR EXISTS (
               SELECT 1
               FROM unnest(ARRAY[
                   1564, 8206, 8207, 8234, 8235, 8236, 8237, 8238,
                   8294, 8295, 8296, 8297, 65279,
                   160, 5760, 8192, 8193, 8194, 8195, 8196, 8197,
                   8198, 8199, 8200, 8201, 8202, 8239, 8287, 12288
               ]) AS prohibited(codepoint)
               WHERE position(chr(prohibited.codepoint) IN manifest_chunk."text") > 0
           )
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'DocumentTextManifestAdmission_text_check',
                MESSAGE = 'A manifest admission requires canonical NFC text.';
        END IF;

        measured_text_bytes := measured_text_bytes
            + octet_length(manifest_chunk."text");
        IF measured_text_bytes > 4194304 THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'DocumentTextManifestAdmission_text_bytes_check',
                MESSAGE = 'A manifest admission requires bounded extracted text.';
        END IF;

        chunk_leaf := sha256(
            document_text_manifest_field_v1(manifest_chunk."id")
            || int4send(manifest_chunk."sequence")
            || int4send(manifest_chunk."pageStart")
            || document_text_manifest_field_v1(manifest_chunk."paragraphId")
            || decode(manifest_chunk."contentHash", 'hex')
        );
        manifest_state := sha256(manifest_state || chunk_leaf);
        expected_sequence := expected_sequence + 1;
        previous_page := manifest_chunk."pageStart";
        previous_paragraph := paragraph_ordinal;
    END LOOP;

    IF expected_sequence <> generation."chunkCount"
       OR measured_text_bytes <> generation."textBytes"
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentTextManifestAdmission_aggregate_check',
            MESSAGE = 'A manifest admission must exactly match its extraction header.';
    END IF;

    RETURN encode(manifest_state, 'hex');
END;
$$;

CREATE FUNCTION validate_document_text_manifest_admission_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    generation RECORD;
    expected_manifest_sha256 TEXT;
BEGIN
    SELECT
        extraction."organizationId",
        extraction."documentId",
        extraction."id",
        extraction."verdict",
        extraction."pageCount",
        extraction."chunkCount",
        extraction."textBytes"
    INTO generation
    FROM "DocumentTextExtraction" AS extraction
    WHERE extraction."organizationId" = NEW."organizationId"
      AND extraction."documentId" = NEW."documentId"
      AND extraction."id" = NEW."extractionId";

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = '23503',
            CONSTRAINT = 'DocumentTextManifestAdmission_extraction_fkey',
            MESSAGE = 'A manifest admission requires its exact extraction generation.';
    END IF;

    expected_manifest_sha256 := compute_document_text_manifest_v1(
        NEW."organizationId",
        NEW."documentId",
        NEW."extractionId"
    );

    IF NEW."schemaVersion" <> 1
       OR NEW."verdict" <> generation."verdict"
       OR NEW."pageCount" <> generation."pageCount"
       OR NEW."chunkCount" <> generation."chunkCount"
       OR NEW."textBytes" <> generation."textBytes"
       OR NEW."manifestSha256" <> expected_manifest_sha256
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentTextManifestAdmission_exact_check',
            MESSAGE = 'A manifest admission must exactly match its verified generation.';
    END IF;

    NEW."admittedAt" := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "DocumentTextManifestAdmission_insert_trigger"
    BEFORE INSERT ON "DocumentTextManifestAdmission"
    FOR EACH ROW
    EXECUTE FUNCTION validate_document_text_manifest_admission_insert();

CREATE FUNCTION reject_document_text_manifest_admission_mutation()
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
        TABLE = 'DocumentTextManifestAdmission',
        MESSAGE = 'DocumentTextManifestAdmission records are immutable.';
END;
$$;

CREATE TRIGGER "DocumentTextManifestAdmission_immutable_trigger"
    BEFORE UPDATE OR DELETE ON "DocumentTextManifestAdmission"
    FOR EACH ROW
    EXECUTE FUNCTION reject_document_text_manifest_admission_mutation();

-- Stop extraction/chunk writers while historical generations pass through the
-- same verifier. This closes the old-worker race at the rollout boundary.
LOCK TABLE "DocumentTextExtraction", "DocumentTextChunk"
    IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO "DocumentTextManifestAdmission" (
    "extractionId",
    "organizationId",
    "documentId",
    "schemaVersion",
    "verdict",
    "pageCount",
    "chunkCount",
    "textBytes",
    "manifestSha256"
)
SELECT
    extraction."id",
    extraction."organizationId",
    extraction."documentId",
    1,
    extraction."verdict",
    extraction."pageCount",
    extraction."chunkCount",
    extraction."textBytes",
    compute_document_text_manifest_v1(
        extraction."organizationId",
        extraction."documentId",
        extraction."id"
    )
FROM "DocumentTextExtraction" AS extraction
ORDER BY extraction."organizationId", extraction."documentId", extraction."id";

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "DocumentTextExtraction" AS extraction
        LEFT JOIN "DocumentTextManifestAdmission" AS admission
          ON admission."organizationId" = extraction."organizationId"
         AND admission."documentId" = extraction."documentId"
         AND admission."extractionId" = extraction."id"
        WHERE admission."extractionId" IS NULL
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentTextManifestAdmission_backfill_check',
            MESSAGE = 'Every historical extraction must have an admitted manifest.';
    END IF;
END;
$$;

-- Preserve the existing deferred constraint trigger while strengthening its
-- function. Completion cannot commit until the exact admission exists.
CREATE OR REPLACE FUNCTION enforce_document_text_extraction_aggregate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    expected_manifest_sha256 TEXT;
    admitted RECORD;
BEGIN
    -- Tenant erasure can remove the extraction before deferred triggers run.
    IF NOT EXISTS (
        SELECT 1
        FROM "DocumentTextExtraction"
        WHERE "organizationId" = NEW."organizationId"
          AND "documentId" = NEW."documentId"
          AND "id" = NEW."id"
    ) THEN
        RETURN NEW;
    END IF;

    expected_manifest_sha256 := compute_document_text_manifest_v1(
        NEW."organizationId",
        NEW."documentId",
        NEW."id"
    );

    INSERT INTO "DocumentTextManifestAdmission" (
        "extractionId",
        "organizationId",
        "documentId",
        "schemaVersion",
        "verdict",
        "pageCount",
        "chunkCount",
        "textBytes",
        "manifestSha256"
    )
    VALUES (
        NEW."id",
        NEW."organizationId",
        NEW."documentId",
        1,
        NEW."verdict",
        NEW."pageCount",
        NEW."chunkCount",
        NEW."textBytes",
        expected_manifest_sha256
    )
    ON CONFLICT ("extractionId") DO NOTHING;

    SELECT
        admission."organizationId",
        admission."documentId",
        admission."extractionId",
        admission."schemaVersion",
        admission."verdict",
        admission."pageCount",
        admission."chunkCount",
        admission."textBytes",
        admission."manifestSha256"
    INTO admitted
    FROM "DocumentTextManifestAdmission" AS admission
    WHERE admission."extractionId" = NEW."id";

    IF NOT FOUND
       OR admitted."organizationId" <> NEW."organizationId"
       OR admitted."documentId" <> NEW."documentId"
       OR admitted."extractionId" <> NEW."id"
       OR admitted."schemaVersion" <> 1
       OR admitted."verdict" <> NEW."verdict"
       OR admitted."pageCount" <> NEW."pageCount"
       OR admitted."chunkCount" <> NEW."chunkCount"
       OR admitted."textBytes" <> NEW."textBytes"
       OR admitted."manifestSha256" <> expected_manifest_sha256
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentTextManifestAdmission_exact_check',
            MESSAGE = 'Text extraction completion requires its exact admitted manifest.';
    END IF;

    RETURN NEW;
END;
$$;
