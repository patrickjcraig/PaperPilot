-- Bind verified evidence excerpts to one exact, database-admitted extraction
-- manifest. Legacy/manual evidence remains explicitly ungrounded; this
-- migration never fabricates custody from the old optional chunk pointer.

ALTER TABLE "EvidenceNote"
    ADD COLUMN "groundingVersion" SMALLINT;

ALTER TABLE "EvidenceNote"
    ADD CONSTRAINT "EvidenceNote_grounding_version_check"
    CHECK ("groundingVersion" IS NULL OR "groundingVersion" = 1);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "EvidenceNote"
        WHERE "supersedesId" = "id"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Existing evidence revisions contain a self-cycle.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "EvidenceNote"
        WHERE "supersedesId" IS NOT NULL
        GROUP BY "organizationId", "supersedesId"
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23505',
            MESSAGE = 'Existing evidence revisions branch from one predecessor.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "EvidenceNote" AS successor
        JOIN "EvidenceNote" AS predecessor
          ON predecessor."organizationId" = successor."organizationId"
         AND predecessor."id" = successor."supersedesId"
        WHERE successor."workspacePaperId" <> predecessor."workspacePaperId"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Existing evidence revisions cross workspace-paper custody.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "EvidenceNote" AS successor
        JOIN "EvidenceNote" AS predecessor
          ON predecessor."organizationId" = successor."organizationId"
         AND predecessor."id" = successor."supersedesId"
        WHERE successor."createdAt" < predecessor."createdAt"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Existing evidence revision chronology runs backward.';
    END IF;
END;
$$;

CREATE UNIQUE INDEX "EvidenceNote_one_revision_per_note_key"
    ON "EvidenceNote"("organizationId", "supersedesId");

-- Revision history is deleted only as part of the root tenant cascade. A
-- deferred NO ACTION check lets all revisions disappear in the same statement
-- without weakening direct-delete protection.
ALTER TABLE "EvidenceNote"
    DROP CONSTRAINT "EvidenceNote_organizationId_supersedesId_fkey",
    ADD CONSTRAINT "EvidenceNote_organizationId_supersedesId_fkey"
        FOREIGN KEY ("organizationId", "supersedesId")
        REFERENCES "EvidenceNote"("organizationId", "id")
        ON DELETE NO ACTION ON UPDATE NO ACTION
        DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX "Document_workspace_paper_binding_key"
    ON "Document"("organizationId", "workspacePaperId", "id");

CREATE UNIQUE INDEX "DocumentTextManifestAdmission_digest_binding_key"
    ON "DocumentTextManifestAdmission"(
        "organizationId",
        "documentId",
        "extractionId",
        "schemaVersion",
        "manifestSha256"
    );

CREATE UNIQUE INDEX "DocumentTextChunk_evidence_anchor_binding_key"
    ON "DocumentTextChunk"(
        "organizationId",
        "documentId",
        "extractionId",
        "id",
        "sequence",
        "contentHash"
    );

CREATE TABLE "EvidenceTextAnchor" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "evidenceNoteId" TEXT NOT NULL,
    "workspacePaperId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "schemaVersion" SMALLINT NOT NULL,
    "manifestSha256" CHAR(64) NOT NULL,
    "startChunkId" TEXT NOT NULL,
    "endChunkId" TEXT NOT NULL,
    "startSequence" INTEGER NOT NULL,
    "endSequence" INTEGER NOT NULL,
    "startByteOffset" INTEGER NOT NULL,
    "endByteOffset" INTEGER NOT NULL,
    "startContentHash" TEXT NOT NULL,
    "endContentHash" TEXT NOT NULL,
    "quoteText" TEXT NOT NULL,
    "quoteSha256" CHAR(64) NOT NULL,
    "pageStart" INTEGER NOT NULL,
    "pageEnd" INTEGER NOT NULL,
    "paragraphStartId" VARCHAR(200) NOT NULL,
    "paragraphEndId" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceTextAnchor_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EvidenceTextAnchor_schema_check" CHECK (
        "schemaVersion" = 1
    ),
    CONSTRAINT "EvidenceTextAnchor_sequence_check" CHECK (
        "startSequence" BETWEEN 0 AND 4095
        AND "endSequence" BETWEEN "startSequence" AND 4095
        AND "endSequence" - "startSequence" < 100
    ),
    CONSTRAINT "EvidenceTextAnchor_offset_check" CHECK (
        "startByteOffset" BETWEEN 0 AND 8191
        AND "endByteOffset" BETWEEN 1 AND 8192
    ),
    CONSTRAINT "EvidenceTextAnchor_hash_check" CHECK (
        "manifestSha256" ~ '^[0-9a-f]{64}$'
        AND "manifestSha256" <> repeat('0', 64)
        AND "startContentHash" ~ '^[0-9a-f]{64}$'
        AND "startContentHash" <> repeat('0', 64)
        AND "endContentHash" ~ '^[0-9a-f]{64}$'
        AND "endContentHash" <> repeat('0', 64)
        AND "quoteSha256" ~ '^[0-9a-f]{64}$'
        AND "quoteSha256" <> repeat('0', 64)
    ),
    CONSTRAINT "EvidenceTextAnchor_quote_check" CHECK (
        char_length("quoteText") BETWEEN 1 AND 50000
        AND octet_length("quoteText") BETWEEN 1 AND 200000
    ),
    CONSTRAINT "EvidenceTextAnchor_locator_check" CHECK (
        "pageStart" BETWEEN 1 AND 2000
        AND "pageEnd" BETWEEN "pageStart" AND 2000
        AND "paragraphStartId" ~ '^p[1-9][0-9]*-p[1-9][0-9]*$'
        AND "paragraphEndId" ~ '^p[1-9][0-9]*-p[1-9][0-9]*$'
    )
);

CREATE UNIQUE INDEX "EvidenceTextAnchor_organizationId_id_key"
    ON "EvidenceTextAnchor"("organizationId", "id");

CREATE UNIQUE INDEX "EvidenceTextAnchor_note_binding_key"
    ON "EvidenceTextAnchor"(
        "organizationId",
        "workspacePaperId",
        "evidenceNoteId"
    );

CREATE INDEX "EvidenceTextAnchor_workspace_created_idx"
    ON "EvidenceTextAnchor"("organizationId", "workspacePaperId", "createdAt" DESC);

CREATE INDEX "EvidenceTextAnchor_organizationId_documentId_extractionId_idx"
    ON "EvidenceTextAnchor"("organizationId", "documentId", "extractionId");

CREATE INDEX "EvidenceTextAnchor_organizationId_startChunkId_idx"
    ON "EvidenceTextAnchor"("organizationId", "startChunkId");

CREATE INDEX "EvidenceTextAnchor_organizationId_endChunkId_idx"
    ON "EvidenceTextAnchor"("organizationId", "endChunkId");

ALTER TABLE "EvidenceTextAnchor"
    ADD CONSTRAINT "EvidenceTextAnchor_organizationId_fkey"
        FOREIGN KEY ("organizationId")
        REFERENCES "Organization"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "EvidenceTextAnchor"
    ADD CONSTRAINT "EvidenceTextAnchor_note_fkey"
        FOREIGN KEY ("organizationId", "workspacePaperId", "evidenceNoteId")
        REFERENCES "EvidenceNote"("organizationId", "workspacePaperId", "id")
        ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "EvidenceTextAnchor"
    ADD CONSTRAINT "EvidenceTextAnchor_workspace_paper_fkey"
        FOREIGN KEY ("organizationId", "workspacePaperId")
        REFERENCES "WorkspacePaper"("organizationId", "id")
        ON DELETE NO ACTION ON UPDATE NO ACTION
        DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "EvidenceTextAnchor"
    ADD CONSTRAINT "EvidenceTextAnchor_document_fkey"
        FOREIGN KEY ("organizationId", "workspacePaperId", "documentId")
        REFERENCES "Document"("organizationId", "workspacePaperId", "id")
        ON DELETE NO ACTION ON UPDATE NO ACTION
        DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "EvidenceTextAnchor"
    ADD CONSTRAINT "EvidenceTextAnchor_manifest_admission_fkey"
        FOREIGN KEY (
            "organizationId",
            "documentId",
            "extractionId",
            "schemaVersion",
            "manifestSha256"
        )
        REFERENCES "DocumentTextManifestAdmission"(
            "organizationId",
            "documentId",
            "extractionId",
            "schemaVersion",
            "manifestSha256"
        )
        ON DELETE NO ACTION ON UPDATE NO ACTION
        DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "EvidenceTextAnchor"
    ADD CONSTRAINT "EvidenceTextAnchor_start_chunk_fkey"
        FOREIGN KEY (
            "organizationId",
            "documentId",
            "extractionId",
            "startChunkId",
            "startSequence",
            "startContentHash"
        )
        REFERENCES "DocumentTextChunk"(
            "organizationId",
            "documentId",
            "extractionId",
            "id",
            "sequence",
            "contentHash"
        )
        ON DELETE NO ACTION ON UPDATE NO ACTION
        DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "EvidenceTextAnchor"
    ADD CONSTRAINT "EvidenceTextAnchor_end_chunk_fkey"
        FOREIGN KEY (
            "organizationId",
            "documentId",
            "extractionId",
            "endChunkId",
            "endSequence",
            "endContentHash"
        )
        REFERENCES "DocumentTextChunk"(
            "organizationId",
            "documentId",
            "extractionId",
            "id",
            "sequence",
            "contentHash"
        )
        ON DELETE NO ACTION ON UPDATE NO ACTION
        DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION validate_evidence_text_anchor_insert()
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
       OR note_row."status" <> 'VERIFIED'
       OR note_row."title" IS NULL
       OR note_row."claim" IS NULL
       OR note_row."interpretation" IS NULL
       OR note_row."verifiedAt" IS NULL
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'EvidenceTextAnchor_grounded_note_check',
            MESSAGE = 'A grounded anchor requires a complete explicitly scoped evidence note.';
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

CREATE TRIGGER "EvidenceTextAnchor_insert_trigger"
    BEFORE INSERT ON "EvidenceTextAnchor"
    FOR EACH ROW
    EXECUTE FUNCTION validate_evidence_text_anchor_insert();

CREATE FUNCTION assert_evidence_note_grounding()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_organization_id TEXT;
    target_workspace_paper_id TEXT;
    target_note_id TEXT;
    grounding_version SMALLINT;
    anchor_count INTEGER;
    anchor_schema_version SMALLINT;
BEGIN
    -- OLD is unassigned for INSERT and NEW is unassigned for DELETE on PostgreSQL.
    -- Branch on the operation before dereferencing either transition record.
    IF TG_OP = 'DELETE' THEN
        target_organization_id := OLD."organizationId";
        target_workspace_paper_id := OLD."workspacePaperId";
        IF TG_TABLE_NAME = 'EvidenceNote' THEN
            target_note_id := OLD."id";
        ELSE
            target_note_id := OLD."evidenceNoteId";
        END IF;
    ELSE
        target_organization_id := NEW."organizationId";
        target_workspace_paper_id := NEW."workspacePaperId";
        IF TG_TABLE_NAME = 'EvidenceNote' THEN
            target_note_id := NEW."id";
        ELSE
            target_note_id := NEW."evidenceNoteId";
        END IF;
    END IF;

    SELECT note."groundingVersion"
    INTO grounding_version
    FROM "EvidenceNote" AS note
    WHERE note."organizationId" = target_organization_id
      AND note."workspacePaperId" = target_workspace_paper_id
      AND note."id" = target_note_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT count(*), min(anchor."schemaVersion")
    INTO anchor_count, anchor_schema_version
    FROM "EvidenceTextAnchor" AS anchor
    WHERE anchor."organizationId" = target_organization_id
      AND anchor."workspacePaperId" = target_workspace_paper_id
      AND anchor."evidenceNoteId" = target_note_id;

    IF grounding_version IS NULL AND anchor_count <> 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'EvidenceNote_grounding_cardinality_check',
            MESSAGE = 'An ungrounded evidence note cannot own a Reader anchor.';
    END IF;
    IF grounding_version = 1
       AND (anchor_count <> 1 OR anchor_schema_version <> 1)
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'EvidenceNote_grounding_cardinality_check',
            MESSAGE = 'A version-one grounded evidence note requires exactly one version-one anchor.';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "EvidenceNote_grounding_constraint_trigger"
    AFTER INSERT OR UPDATE OF "groundingVersion" ON "EvidenceNote"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION assert_evidence_note_grounding();

CREATE CONSTRAINT TRIGGER "EvidenceTextAnchor_grounding_constraint_trigger"
    AFTER INSERT OR UPDATE OR DELETE ON "EvidenceTextAnchor"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION assert_evidence_note_grounding();

CREATE FUNCTION reject_evidence_text_anchor_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM "Organization" WHERE "id" = OLD."organizationId"
    ) THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION USING
        ERRCODE = '55000',
        TABLE = 'EvidenceTextAnchor',
        MESSAGE = 'Grounded evidence anchors are immutable; create a successor evidence revision.';
END;
$$;

CREATE TRIGGER "EvidenceTextAnchor_immutable_trigger"
    BEFORE UPDATE OR DELETE ON "EvidenceTextAnchor"
    FOR EACH ROW
    EXECUTE FUNCTION reject_evidence_text_anchor_mutation();

CREATE FUNCTION validate_evidence_revision_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    predecessor RECORD;
BEGIN
    IF NEW."supersedesId" IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW."supersedesId" = NEW."id" THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'EvidenceNote_revision_check',
            MESSAGE = 'An evidence revision cannot supersede itself.';
    END IF;

    SELECT
        note."workspacePaperId",
        note."projectId",
        note."groundingVersion",
        note."createdAt"
    INTO predecessor
    FROM "EvidenceNote" AS note
    WHERE note."organizationId" = NEW."organizationId"
      AND note."id" = NEW."supersedesId";

    IF NOT FOUND
       OR predecessor."workspacePaperId" <> NEW."workspacePaperId"
       OR predecessor."projectId" IS DISTINCT FROM NEW."projectId"
       OR predecessor."groundingVersion" IS DISTINCT FROM NEW."groundingVersion"
       OR NEW."createdAt" < predecessor."createdAt"
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'EvidenceNote_revision_check',
            MESSAGE = 'An evidence successor must retain predecessor paper, project, and grounding custody.';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "EvidenceNote_revision_insert_trigger"
    BEFORE INSERT ON "EvidenceNote"
    FOR EACH ROW
    EXECUTE FUNCTION validate_evidence_revision_insert();

CREATE FUNCTION reject_grounded_evidence_semantic_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."groundingVersion" IS DISTINCT FROM 1 THEN
            RETURN OLD;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM "Organization" WHERE "id" = OLD."organizationId"
        ) THEN
            RETURN OLD;
        END IF;
    ELSIF OLD."groundingVersion" IS DISTINCT FROM 1
      AND NEW."groundingVersion" IS DISTINCT FROM 1
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION USING
        ERRCODE = '55000',
        TABLE = 'EvidenceNote',
        MESSAGE = 'Grounded evidence revisions are immutable; create a successor revision.';
END;
$$;

CREATE TRIGGER "EvidenceNote_grounded_immutable_trigger"
    BEFORE UPDATE OR DELETE ON "EvidenceNote"
    FOR EACH ROW
    EXECUTE FUNCTION reject_grounded_evidence_semantic_mutation();
