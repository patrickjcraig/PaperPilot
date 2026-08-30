-- Source grounding records what exact admitted text supports a note; it does
-- not imply that a researcher has reviewed the note. Newly captured grounded
-- notes therefore remain CAPTURED until an explicit review moves them to
-- VERIFIED. Keep the timestamp and review state paired exactly.

CREATE OR REPLACE FUNCTION validate_evidence_text_anchor_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    note_row RECORD;
    admission_row RECORD;
    anchor_chunk RECORD;
    endpoint_chunks RECORD;
    source_bytes BYTEA;
    selected_bytes BYTEA;
    quote_bytes BYTEA := ''::bytea;
    expected_quote TEXT;
    selected_count INTEGER := 0;
BEGIN
    SELECT
        note."organizationId",
        note."workspacePaperId",
        note."projectId",
        note."documentId",
        note."documentChunkId",
        note."groundingVersion",
        note."status",
        note."title",
        note."claim",
        note."evidence",
        note."interpretation",
        note."quote",
        note."text",
        note."pageStart",
        note."pageEnd",
        note."paragraphId",
        note."verifiedAt"
    INTO note_row
    FROM "EvidenceNote" AS note
    WHERE note."organizationId" = NEW."organizationId"
      AND note."workspacePaperId" = NEW."workspacePaperId"
      AND note."id" = NEW."evidenceNoteId";

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = '23503',
            CONSTRAINT = 'EvidenceTextAnchor_note_fkey',
            MESSAGE = 'A grounded anchor requires its exact evidence note and workspace paper.';
    END IF;

    IF note_row."projectId" IS NULL
       OR note_row."groundingVersion" IS DISTINCT FROM 1
       OR note_row."status" NOT IN ('CAPTURED', 'VERIFIED')
       OR (
           note_row."status" = 'CAPTURED'
           AND note_row."verifiedAt" IS NOT NULL
       )
       OR (
           note_row."status" = 'VERIFIED'
           AND note_row."verifiedAt" IS NULL
       )
       OR note_row."title" IS NULL
       OR note_row."claim" IS NULL
       OR note_row."interpretation" IS NULL
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'EvidenceTextAnchor_grounded_note_check',
            MESSAGE = 'A grounded anchor requires a complete explicitly scoped evidence note with a consistent review state.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "Document" AS document
        JOIN "WorkspacePaper" AS workspace_paper
          ON workspace_paper."organizationId" = document."organizationId"
         AND workspace_paper."id" = document."workspacePaperId"
        WHERE document."organizationId" = NEW."organizationId"
          AND document."workspacePaperId" = NEW."workspacePaperId"
          AND document."id" = NEW."documentId"
          AND document."paperId" = workspace_paper."paperId"
          AND document."kind" = 'PAPER_PDF'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23503',
            CONSTRAINT = 'EvidenceTextAnchor_document_fkey',
            MESSAGE = 'A grounded anchor requires the paper-bound source document.';
    END IF;

    SELECT
        admission."schemaVersion",
        admission."manifestSha256",
        admission."verdict",
        admission."chunkCount"
    INTO admission_row
    FROM "DocumentTextManifestAdmission" AS admission
    WHERE admission."organizationId" = NEW."organizationId"
      AND admission."documentId" = NEW."documentId"
      AND admission."extractionId" = NEW."extractionId"
      AND admission."schemaVersion" = NEW."schemaVersion"
      AND admission."manifestSha256" = NEW."manifestSha256";

    IF NOT FOUND
       OR admission_row."verdict" <> 'EXTRACTED'
       OR NEW."endSequence" >= admission_row."chunkCount"
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'EvidenceTextAnchor_manifest_admission_fkey',
            MESSAGE = 'A grounded anchor requires its exact admitted text manifest.';
    END IF;

    FOR anchor_chunk IN
        SELECT
            chunk."id",
            chunk."sequence",
            chunk."pageStart",
            chunk."pageEnd",
            chunk."paragraphId",
            chunk."text",
            chunk."contentHash"
        FROM "DocumentTextChunk" AS chunk
        WHERE chunk."organizationId" = NEW."organizationId"
          AND chunk."documentId" = NEW."documentId"
          AND chunk."extractionId" = NEW."extractionId"
          AND chunk."sequence" BETWEEN NEW."startSequence" AND NEW."endSequence"
        ORDER BY chunk."sequence"
    LOOP
        IF anchor_chunk."sequence" <> NEW."startSequence" + selected_count THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'EvidenceTextAnchor_sequence_check',
                MESSAGE = 'A grounded anchor must cover one contiguous chunk sequence.';
        END IF;

        source_bytes := convert_to(anchor_chunk."text", 'UTF8');
        IF anchor_chunk."sequence" = NEW."startSequence"
           AND NEW."startByteOffset" >= octet_length(anchor_chunk."text")
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '22023',
                CONSTRAINT = 'EvidenceTextAnchor_offset_check',
                MESSAGE = 'A grounded anchor start offset is outside its source chunk.';
        END IF;
        IF anchor_chunk."sequence" = NEW."endSequence"
           AND NEW."endByteOffset" > octet_length(anchor_chunk."text")
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '22023',
                CONSTRAINT = 'EvidenceTextAnchor_offset_check',
                MESSAGE = 'A grounded anchor end offset is outside its source chunk.';
        END IF;

        IF NEW."startSequence" = NEW."endSequence" THEN
            IF NEW."endByteOffset" <= NEW."startByteOffset" THEN
                RAISE EXCEPTION USING
                    ERRCODE = '22023',
                    CONSTRAINT = 'EvidenceTextAnchor_offset_check',
                    MESSAGE = 'A grounded anchor cannot select an empty source range.';
            END IF;
            selected_bytes := substring(
                source_bytes
                FROM NEW."startByteOffset" + 1
                FOR NEW."endByteOffset" - NEW."startByteOffset"
            );
        ELSIF anchor_chunk."sequence" = NEW."startSequence" THEN
            selected_bytes := substring(source_bytes FROM NEW."startByteOffset" + 1);
        ELSIF anchor_chunk."sequence" = NEW."endSequence" THEN
            selected_bytes := substring(source_bytes FROM 1 FOR NEW."endByteOffset");
        ELSE
            selected_bytes := source_bytes;
        END IF;

        -- Fail closed if an offset splits a UTF-8 code point.
        PERFORM convert_from(selected_bytes, 'UTF8');
        IF selected_count > 0 THEN
            quote_bytes := quote_bytes || convert_to(E'\n\n', 'UTF8');
        END IF;
        quote_bytes := quote_bytes || selected_bytes;
        selected_count := selected_count + 1;
    END LOOP;

    IF selected_count <> NEW."endSequence" - NEW."startSequence" + 1 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'EvidenceTextAnchor_sequence_check',
            MESSAGE = 'A grounded anchor has a missing source chunk.';
    END IF;

    expected_quote := convert_from(quote_bytes, 'UTF8');

    SELECT
        start_chunk."pageStart" AS start_page,
        start_chunk."paragraphId" AS start_paragraph_id,
        end_chunk."pageEnd" AS end_page,
        end_chunk."paragraphId" AS end_paragraph_id
    INTO endpoint_chunks
    FROM "DocumentTextChunk" AS start_chunk
    CROSS JOIN "DocumentTextChunk" AS end_chunk
    WHERE start_chunk."organizationId" = NEW."organizationId"
      AND start_chunk."documentId" = NEW."documentId"
      AND start_chunk."extractionId" = NEW."extractionId"
      AND start_chunk."id" = NEW."startChunkId"
      AND start_chunk."sequence" = NEW."startSequence"
      AND start_chunk."contentHash" = NEW."startContentHash"
      AND end_chunk."organizationId" = NEW."organizationId"
      AND end_chunk."documentId" = NEW."documentId"
      AND end_chunk."extractionId" = NEW."extractionId"
      AND end_chunk."id" = NEW."endChunkId"
      AND end_chunk."sequence" = NEW."endSequence"
      AND end_chunk."contentHash" = NEW."endContentHash";

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'EvidenceTextAnchor_exact_check',
            MESSAGE = 'A grounded anchor must name its exact endpoint chunks.';
    END IF;

    IF endpoint_chunks.start_page IS NULL
       OR endpoint_chunks.end_page IS NULL
       OR endpoint_chunks.start_paragraph_id IS NULL
       OR endpoint_chunks.end_paragraph_id IS NULL
       OR NEW."pageStart" <> endpoint_chunks.start_page
       OR NEW."pageEnd" <> endpoint_chunks.end_page
       OR NEW."paragraphStartId" <> endpoint_chunks.start_paragraph_id
       OR NEW."paragraphEndId" <> endpoint_chunks.end_paragraph_id
       OR NEW."quoteText" <> expected_quote
       OR NEW."quoteSha256" <> encode(sha256(quote_bytes), 'hex')
       OR note_row."documentId" IS DISTINCT FROM NEW."documentId"
       OR note_row."documentChunkId" IS DISTINCT FROM NEW."startChunkId"
       OR note_row."evidence" IS DISTINCT FROM expected_quote
       OR note_row."quote" IS DISTINCT FROM expected_quote
       OR note_row."text" IS DISTINCT FROM note_row."claim"
       OR note_row."pageStart" IS DISTINCT FROM NEW."pageStart"
       OR note_row."pageEnd" IS DISTINCT FROM NEW."pageEnd"
       OR note_row."paragraphId" IS DISTINCT FROM NEW."paragraphStartId"
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'EvidenceTextAnchor_exact_check',
            MESSAGE = 'A grounded anchor must exactly match its note, quote, endpoint chunks, and locators.';
    END IF;

    NEW."createdAt" := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;
