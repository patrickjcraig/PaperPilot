CREATE TYPE "TextExtractionVerdict" AS ENUM ('EXTRACTED', 'NO_TEXT');

ALTER TABLE "DocumentTextChunk"
    ADD COLUMN "extractionId" TEXT;

CREATE TABLE "DocumentTextExtraction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "jobAttemptId" TEXT NOT NULL,
    "validationAttestationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "inputSha256" CHAR(64) NOT NULL,
    "inputSizeBytes" BIGINT NOT NULL,
    "storageVersion" VARCHAR(128) NOT NULL,
    "extractionPolicyVersion" VARCHAR(128) NOT NULL,
    "toolchainDigest" CHAR(64) NOT NULL,
    "verdict" "TextExtractionVerdict" NOT NULL,
    "engine" VARCHAR(64) NOT NULL,
    "engineVersion" VARCHAR(128) NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "textBytes" INTEGER NOT NULL,
    "extractedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "totalDurationMs" INTEGER NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentTextExtraction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DocumentTextExtraction_hashes_check" CHECK (
        "inputSha256" ~ '^[0-9a-f]{64}$'
        AND "toolchainDigest" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "DocumentTextExtraction_input_size_check" CHECK (
        "inputSizeBytes" BETWEEN 1 AND 26214400
    ),
    CONSTRAINT "DocumentTextExtraction_versions_check" CHECK (
        "storageVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$'
        AND "extractionPolicyVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
    CONSTRAINT "DocumentTextExtraction_engine_check" CHECK (
        "engine" = 'poppler'
        AND "engineVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$'
    ),
    CONSTRAINT "DocumentTextExtraction_counts_check" CHECK (
        "pageCount" BETWEEN 1 AND 2000
        AND "chunkCount" BETWEEN 0 AND 4096
        AND "textBytes" BETWEEN 0 AND 4194304
    ),
    CONSTRAINT "DocumentTextExtraction_duration_check" CHECK (
        "durationMs" BETWEEN 0 AND 180000
        AND "totalDurationMs" BETWEEN "durationMs" AND 180000
    ),
    CONSTRAINT "DocumentTextExtraction_timestamps_check" CHECK (
        "extractedAt" <= "completedAt"
    ),
    CONSTRAINT "DocumentTextExtraction_verdict_check" CHECK (
        (
            "verdict" = 'EXTRACTED'
            AND "chunkCount" > 0
            AND "textBytes" > 0
        )
        OR
        (
            "verdict" = 'NO_TEXT'
            AND "chunkCount" = 0
            AND "textBytes" = 0
        )
    ),
    CONSTRAINT "DocumentTextExtraction_result_check" CHECK (
        "result" IS NULL
        OR (
            jsonb_typeof("result") = 'object'
            AND octet_length("result"::text) <= 65536
        )
    )
);

CREATE UNIQUE INDEX "DocumentValidationAttestation_organizationId_documentId_ass_key"
    ON "DocumentValidationAttestation"("organizationId", "documentId", "assetId", "id");

CREATE UNIQUE INDEX "Job_organizationId_documentId_assetId_id_key"
    ON "Job"("organizationId", "documentId", "assetId", "id");

CREATE UNIQUE INDEX "JobAttempt_organizationId_jobId_id_key"
    ON "JobAttempt"("organizationId", "jobId", "id");

CREATE UNIQUE INDEX "DocumentTextExtraction_jobAttemptId_key"
    ON "DocumentTextExtraction"("jobAttemptId");

CREATE UNIQUE INDEX "DocumentTextExtraction_organizationId_id_key"
    ON "DocumentTextExtraction"("organizationId", "id");

CREATE UNIQUE INDEX "DocumentTextExtraction_organizationId_documentId_id_key"
    ON "DocumentTextExtraction"("organizationId", "documentId", "id");

CREATE UNIQUE INDEX "DocumentTextExtraction_organizationId_jobAttemptId_key"
    ON "DocumentTextExtraction"("organizationId", "jobAttemptId");

CREATE UNIQUE INDEX "DocumentTextExtraction_organizationId_jobId_jobAttemptId_key"
    ON "DocumentTextExtraction"("organizationId", "jobId", "jobAttemptId");

CREATE UNIQUE INDEX "DocumentTextExtraction_generation_key"
    ON "DocumentTextExtraction"(
        "organizationId",
        "documentId",
        "assetId",
        "inputSha256",
        "storageVersion",
        "extractionPolicyVersion",
        "toolchainDigest"
    );

CREATE INDEX "DocumentTextExtraction_current_generation_idx"
    ON "DocumentTextExtraction"(
        "organizationId",
        "documentId",
        "extractionPolicyVersion",
        "createdAt" DESC
    );

CREATE INDEX "DocumentTextExtraction_organizationId_assetId_createdAt_idx"
    ON "DocumentTextExtraction"("organizationId", "assetId", "createdAt");

CREATE INDEX "DocumentTextExtraction_jobId_idx"
    ON "DocumentTextExtraction"("jobId");

CREATE INDEX "DocumentTextExtraction_validationAttestationId_idx"
    ON "DocumentTextExtraction"("validationAttestationId");

DROP INDEX "DocumentTextChunk_documentId_sequence_key";

CREATE UNIQUE INDEX "DocumentTextChunk_extractionId_sequence_key"
    ON "DocumentTextChunk"("extractionId", "sequence");

-- Existing chunks have no extraction provenance. Retain their prior per-document
-- sequence guarantee while allowing independent sequences for new generations.
CREATE UNIQUE INDEX "DocumentTextChunk_legacy_document_sequence_key"
    ON "DocumentTextChunk"("documentId", "sequence")
    WHERE "extractionId" IS NULL;

CREATE INDEX "DocumentTextChunk_organizationId_extractionId_sequence_idx"
    ON "DocumentTextChunk"("organizationId", "extractionId", "sequence");

ALTER TABLE "DocumentTextChunk"
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

ALTER TABLE "Job"
    ADD CONSTRAINT "Job_text_extraction_target_check" CHECK (
        "type" <> 'TEXT_EXTRACTION'
        OR (
            "documentId" IS NOT NULL
            AND "assetId" IS NOT NULL
            AND "dedupeKey" IS NOT NULL
        )
    );

CREATE INDEX "Job_claim_text_extraction_idx"
    ON "Job"("runAfter", "priority" DESC, "createdAt", "id")
    WHERE "type" = 'TEXT_EXTRACTION'
      AND "status" IN ('QUEUED', 'RETRYING');

-- A linked paper has one unambiguous active full-text document. This deliberately
-- does not rewrite or choose among duplicates: deployment fails if preflight data
-- violates the invariant.
CREATE UNIQUE INDEX "Document_one_active_paper_pdf_per_workspace_paper"
    ON "Document"("organizationId", "workspacePaperId")
    WHERE "workspacePaperId" IS NOT NULL
      AND "kind" = 'PAPER_PDF'
      AND "status" <> 'ARCHIVED';

ALTER TABLE "DocumentTextExtraction"
    ADD CONSTRAINT "DocumentTextExtraction_organizationId_fkey"
        FOREIGN KEY ("organizationId")
        REFERENCES "Organization"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
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
    ADD CONSTRAINT "DocumentTextChunk_organizationId_documentId_extractionId_fkey"
        FOREIGN KEY ("organizationId", "documentId", "extractionId")
        REFERENCES "DocumentTextExtraction"("organizationId", "documentId", "id")
        ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE FUNCTION enforce_document_text_extraction_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "Job" AS job
        WHERE job."organizationId" = NEW."organizationId"
          AND job."id" = NEW."jobId"
          AND job."documentId" = NEW."documentId"
          AND job."assetId" = NEW."assetId"
          AND job."type" = 'TEXT_EXTRACTION'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentTextExtraction_job_binding_check',
            MESSAGE = 'Text extraction must be bound to its exact TEXT_EXTRACTION job target.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "DocumentValidationAttestation" AS attestation
        INNER JOIN "Asset" AS asset
            ON asset."organizationId" = attestation."organizationId"
           AND asset."id" = attestation."assetId"
        INNER JOIN "Document" AS document
            ON document."organizationId" = attestation."organizationId"
           AND document."id" = attestation."documentId"
        WHERE attestation."organizationId" = NEW."organizationId"
          AND attestation."id" = NEW."validationAttestationId"
          AND attestation."documentId" = NEW."documentId"
          AND attestation."assetId" = NEW."assetId"
          AND attestation."verdict" = 'ACCEPTED'
          AND attestation."inputSha256" = NEW."inputSha256"
          AND attestation."inputSizeBytes" = NEW."inputSizeBytes"
          AND attestation."storageVersion" = NEW."storageVersion"
          AND (attestation."pageCount" IS NULL OR attestation."pageCount" = NEW."pageCount")
          AND asset."status" = 'READY'
          AND asset."sha256" = NEW."inputSha256"
          AND asset."sizeBytes" = NEW."inputSizeBytes"
          AND asset."validationPolicyVersion" = attestation."policyVersion"
          AND asset."scannedAt" = attestation."scannedAt"
          AND asset."validatedAt" = attestation."checkedAt"
          AND document."status" = 'READY'
          AND document."contentHash" = NEW."inputSha256"
          AND document."validationPolicyVersion" = attestation."policyVersion"
          AND document."validatedAt" = attestation."checkedAt"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentTextExtraction_validation_binding_check',
            MESSAGE = 'Text extraction must match the current accepted validation and input identity.';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "DocumentTextExtraction_binding_trigger"
    BEFORE INSERT ON "DocumentTextExtraction"
    FOR EACH ROW
    EXECUTE FUNCTION enforce_document_text_extraction_binding();

CREATE FUNCTION reject_document_text_extraction_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- The root tenant row is already invisible when its ON DELETE CASCADE
    -- actions run. Permit only that erasure path; normal direct deletion and
    -- every update remain forbidden.
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

CREATE FUNCTION enforce_document_text_chunk_extraction_bounds()
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
       OR NEW."sequence" >= extraction_chunk_count
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

    -- Tenant erasure can remove the manifest before deferred triggers run.
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

-- This single deferred manifest trigger sees the transaction's final chunk set.
-- After the first commit, extraction-owned chunks cannot be updated or deleted,
-- so later aggregate drift is impossible without disabling database triggers.
CREATE CONSTRAINT TRIGGER "DocumentTextExtraction_chunk_aggregate_trigger"
    AFTER INSERT ON "DocumentTextExtraction"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_document_text_extraction_aggregate();
