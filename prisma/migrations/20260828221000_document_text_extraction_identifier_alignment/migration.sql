-- Align the persisted storage identity with the extraction contract's safe
-- object-store version alphabet. Extraction policies deliberately retain the
-- stricter configuration-identifier alphabet.
ALTER TABLE "DocumentTextExtraction"
    DROP CONSTRAINT "DocumentTextExtraction_versions_check",
    ADD CONSTRAINT "DocumentTextExtraction_versions_check" CHECK (
        "storageVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$'
        AND "extractionPolicyVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    );

-- Bound paragraph identifiers before evaluating the regex/cast and bind the
-- exact four-key source locator to the row. Legacy chunks remain exempt.
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
