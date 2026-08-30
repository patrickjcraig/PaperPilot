-- Replace the deferred custody checks with immediate row guards. Anchor writes
-- already occur after the canonical project-paper edge is established, and an
-- immediate ProjectPaper guard avoids leaving a temporarily invalid custody
-- graph inside a transaction.

DROP TRIGGER "EvidenceTextAnchor_project_paper_constraint_trigger"
    ON "EvidenceTextAnchor";
DROP TRIGGER "ProjectPaper_grounded_evidence_constraint_trigger"
    ON "ProjectPaper";
DROP FUNCTION assert_grounded_evidence_project_paper_custody();

CREATE FUNCTION validate_grounded_evidence_project_paper_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_project_id TEXT;
BEGIN
    SELECT note."projectId"
    INTO target_project_id
    FROM "EvidenceNote" AS note
    WHERE note."organizationId" = NEW."organizationId"
      AND note."workspacePaperId" = NEW."workspacePaperId"
      AND note."id" = NEW."evidenceNoteId"
      AND note."groundingVersion" = 1;

    -- The existing anchor validator owns missing and malformed note failures.
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF target_project_id IS NULL
       OR NOT EXISTS (
           SELECT 1
           FROM "ProjectPaper" AS project_paper
           WHERE project_paper."organizationId" = NEW."organizationId"
             AND project_paper."projectId" = target_project_id
             AND project_paper."workspacePaperId" = NEW."workspacePaperId"
       )
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23503',
            CONSTRAINT = 'EvidenceTextAnchor_project_paper_fkey',
            MESSAGE = 'Grounded evidence requires its canonical project to contain its workspace paper.';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "EvidenceTextAnchor_project_paper_insert_trigger"
    BEFORE INSERT ON "EvidenceTextAnchor"
    FOR EACH ROW
    EXECUTE FUNCTION validate_grounded_evidence_project_paper_insert();

CREATE FUNCTION reject_grounded_project_paper_custody_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- A cascading tenant erasure is the one operation allowed to remove the
    -- complete immutable custody graph.
    IF TG_OP = 'DELETE'
       AND NOT EXISTS (
           SELECT 1
           FROM "Organization" AS organization
           WHERE organization."id" = OLD."organizationId"
       )
    THEN
        RETURN OLD;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "EvidenceNote" AS note
        JOIN "EvidenceTextAnchor" AS anchor
          ON anchor."organizationId" = note."organizationId"
         AND anchor."workspacePaperId" = note."workspacePaperId"
         AND anchor."evidenceNoteId" = note."id"
        WHERE note."organizationId" = OLD."organizationId"
          AND note."workspacePaperId" = OLD."workspacePaperId"
          AND note."projectId" = OLD."projectId"
          AND note."groundingVersion" = 1
    )
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23503',
            CONSTRAINT = 'EvidenceTextAnchor_project_paper_fkey',
            MESSAGE = 'Grounded evidence requires its canonical project to contain its workspace paper.';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectPaper_grounded_evidence_delete_trigger"
    BEFORE DELETE ON "ProjectPaper"
    FOR EACH ROW
    EXECUTE FUNCTION reject_grounded_project_paper_custody_mutation();

CREATE TRIGGER "ProjectPaper_grounded_evidence_update_trigger"
    BEFORE UPDATE OF "organizationId", "projectId", "workspacePaperId"
    ON "ProjectPaper"
    FOR EACH ROW
    WHEN (
        OLD."organizationId" IS DISTINCT FROM NEW."organizationId"
        OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
        OR OLD."workspacePaperId" IS DISTINCT FROM NEW."workspacePaperId"
    )
    EXECUTE FUNCTION reject_grounded_project_paper_custody_mutation();
