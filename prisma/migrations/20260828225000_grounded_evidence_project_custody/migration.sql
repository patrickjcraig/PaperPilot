-- A grounded note's canonical project is part of its source custody. Keep the
-- database invariant aligned with the service rule: that project must contain
-- the same workspace paper for as long as the immutable anchor exists.

CREATE FUNCTION assert_grounded_evidence_project_paper_custody()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_organization_id TEXT;
    target_workspace_paper_id TEXT;
    target_project_id TEXT;
BEGIN
    IF TG_TABLE_NAME = 'EvidenceTextAnchor' THEN
        SELECT
            note."organizationId",
            note."workspacePaperId",
            note."projectId"
        INTO
            target_organization_id,
            target_workspace_paper_id,
            target_project_id
        FROM "EvidenceNote" AS note
        WHERE note."organizationId" = NEW."organizationId"
          AND note."workspacePaperId" = NEW."workspacePaperId"
          AND note."id" = NEW."evidenceNoteId"
          AND note."groundingVersion" = 1;

        -- The anchor validation and deferred grounding-cardinality checks own
        -- missing or ungrounded-note failures. This trigger owns only custody.
        IF NOT FOUND THEN
            RETURN NULL;
        END IF;
    ELSE
        target_organization_id := OLD."organizationId";
        target_workspace_paper_id := OLD."workspacePaperId";
        target_project_id := OLD."projectId";

        -- Tenant erasure intentionally removes the whole custody graph. Match
        -- the grounded-note/anchor immutability triggers' tenant-delete escape.
        IF NOT EXISTS (
            SELECT 1
            FROM "Organization" AS organization
            WHERE organization."id" = target_organization_id
        ) THEN
            RETURN NULL;
        END IF;

        -- An UPDATE that leaves the custody key unchanged cannot invalidate it.
        IF TG_OP = 'UPDATE'
           AND NEW."organizationId" = OLD."organizationId"
           AND NEW."workspacePaperId" = OLD."workspacePaperId"
           AND NEW."projectId" = OLD."projectId"
        THEN
            RETURN NULL;
        END IF;
    END IF;

    IF target_project_id IS NULL
       OR NOT EXISTS (
           SELECT 1
           FROM "ProjectPaper" AS project_paper
           WHERE project_paper."organizationId" = target_organization_id
             AND project_paper."projectId" = target_project_id
             AND project_paper."workspacePaperId" = target_workspace_paper_id
       )
    THEN
        -- A ProjectPaper mutation only matters when an immutable grounded note
        -- still depends on the old key. Anchor inserts always matter.
        IF TG_TABLE_NAME = 'EvidenceTextAnchor'
           OR EXISTS (
               SELECT 1
               FROM "EvidenceNote" AS note
               JOIN "EvidenceTextAnchor" AS anchor
                 ON anchor."organizationId" = note."organizationId"
                AND anchor."workspacePaperId" = note."workspacePaperId"
                AND anchor."evidenceNoteId" = note."id"
               WHERE note."organizationId" = target_organization_id
                 AND note."workspacePaperId" = target_workspace_paper_id
                 AND note."projectId" = target_project_id
                 AND note."groundingVersion" = 1
           )
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '23503',
                CONSTRAINT = 'EvidenceTextAnchor_project_paper_fkey',
                MESSAGE = 'Grounded evidence requires its canonical project to contain its workspace paper.';
        END IF;
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "EvidenceTextAnchor_project_paper_constraint_trigger"
    AFTER INSERT ON "EvidenceTextAnchor"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION assert_grounded_evidence_project_paper_custody();

CREATE CONSTRAINT TRIGGER "ProjectPaper_grounded_evidence_constraint_trigger"
    AFTER DELETE OR UPDATE OF "organizationId", "projectId", "workspacePaperId"
    ON "ProjectPaper"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION assert_grounded_evidence_project_paper_custody();
