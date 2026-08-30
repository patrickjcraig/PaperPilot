-- A WebMCP proposal remains metadata-only until this lifetime-immutable authority row
-- records the exact reviewed snapshot, destination, duplicate decision, actor,
-- and independently verified canonical evidence used for promotion.
CREATE TYPE "WebMcpDuplicateDecision" AS ENUM ('CREATE_NEW', 'USE_EXISTING');
CREATE TYPE "WebMcpVerificationAuthority" AS ENUM ('OPENALEX', 'HUMAN_REVIEW', 'EXISTING_CANONICAL');

CREATE TABLE "WebMcpProposalApproval" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "inboxEntryId" TEXT NOT NULL,
    "destinationProjectId" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "proposalDigest" CHAR(64) NOT NULL,
    "decision" "WebMcpDuplicateDecision" NOT NULL,
    "selectedCanonicalPaperId" TEXT,
    "canonicalPaperId" TEXT NOT NULL,
    "workspacePaperId" TEXT NOT NULL,
    "verificationAuthority" "WebMcpVerificationAuthority" NOT NULL,
    "verificationAuthorityVersion" VARCHAR(100) NOT NULL,
    "verificationEvidenceDigest" CHAR(64) NOT NULL,
    "verifiedSnapshot" JSONB NOT NULL,
    "clientOperationId" VARCHAR(200) NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebMcpProposalApproval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WebMcpProposalApproval_proposal_digest_check"
      CHECK ("proposalDigest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "WebMcpProposalApproval_evidence_digest_check"
      CHECK ("verificationEvidenceDigest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "WebMcpProposalApproval_authority_version_check"
      CHECK (length("verificationAuthorityVersion") BETWEEN 1 AND 100),
    CONSTRAINT "WebMcpProposalApproval_decision_check" CHECK ((
      ("decision" = 'CREATE_NEW' AND "selectedCanonicalPaperId" IS NULL)
      OR
      ("decision" = 'USE_EXISTING' AND "selectedCanonicalPaperId" = "canonicalPaperId")
    ) IS TRUE),
    CONSTRAINT "WebMcpProposalApproval_authority_check" CHECK (
      (
        "decision" = 'USE_EXISTING'
        AND "verificationAuthority" = 'EXISTING_CANONICAL'
        AND "verificationAuthorityVersion" = 'existing-canonical-v1'
      )
      OR
      (
        "decision" = 'CREATE_NEW'
        AND (
          ("verificationAuthority" = 'OPENALEX' AND "verificationAuthorityVersion" = 'works-singleton-v1')
          OR
          ("verificationAuthority" = 'HUMAN_REVIEW' AND "verificationAuthorityVersion" = 'human-review-v1')
        )
      )
    ),
    CONSTRAINT "WebMcpProposalApproval_snapshot_shape_check" CHECK ((
      jsonb_typeof("verifiedSnapshot") = 'object'
      AND "verifiedSnapshot"->>'schemaVersion' = '1'
      AND "verifiedSnapshot"->>'authority' = "verificationAuthority"::text
      AND "verifiedSnapshot"->>'authorityVersion' = "verificationAuthorityVersion"
      AND "verifiedSnapshot"->>'evidenceDigest' = "verificationEvidenceDigest"
      AND (
        (
          "verificationAuthority" = 'OPENALEX'
          AND "verifiedSnapshot"->>'kind' = 'openalex_verified_work'
          AND "verifiedSnapshot" ?& ARRAY[
            'schemaVersion', 'kind', 'authority', 'authorityVersion',
            'retrievedAt', 'sourceRecordId', 'paper', 'evidenceDigest'
          ]
          AND "verifiedSnapshot" - ARRAY[
            'schemaVersion', 'kind', 'authority', 'authorityVersion',
            'retrievedAt', 'sourceRecordId', 'providerUpdatedAt', 'paper', 'evidenceDigest'
          ] = '{}'::jsonb
          AND "verifiedSnapshot"->>'sourceRecordId' ~ '^W[0-9]+$'
          AND jsonb_typeof("verifiedSnapshot"->'paper') = 'object'
          AND ("verifiedSnapshot"->'paper') ?& ARRAY[
            'title', 'abstractText', 'publicationYear', 'publicationDate', 'language',
            'workType', 'venueName', 'citationCount', 'isRetracted', 'identifiers', 'authors'
          ]
          AND ("verifiedSnapshot"->'paper') - ARRAY[
            'title', 'abstractText', 'publicationYear', 'publicationDate', 'language',
            'workType', 'venueName', 'citationCount', 'isRetracted', 'identifiers', 'authors'
          ] = '{}'::jsonb
          AND jsonb_typeof("verifiedSnapshot"->'paper'->'title') = 'string'
          AND jsonb_typeof("verifiedSnapshot"->'paper'->'identifiers') = 'array'
          AND jsonb_array_length("verifiedSnapshot"->'paper'->'identifiers') BETWEEN 1 AND 2
          AND jsonb_typeof("verifiedSnapshot"->'paper'->'authors') = 'array'
        )
        OR
        (
          "verificationAuthority" = 'HUMAN_REVIEW'
          AND "verifiedSnapshot"->>'kind' = 'human_review_identifier_free'
          AND "verifiedSnapshot" ?& ARRAY[
            'schemaVersion', 'kind', 'authority', 'authorityVersion',
            'proposalDigest', 'evidenceDigest'
          ]
          AND "verifiedSnapshot" - ARRAY[
            'schemaVersion', 'kind', 'authority', 'authorityVersion',
            'proposalDigest', 'evidenceDigest'
          ] = '{}'::jsonb
          AND "verifiedSnapshot"->>'proposalDigest' = "proposalDigest"
        )
        OR
        (
          "verificationAuthority" = 'EXISTING_CANONICAL'
          AND "verifiedSnapshot"->>'kind' = 'existing_canonical'
          AND "verifiedSnapshot" ?& ARRAY[
            'schemaVersion', 'kind', 'authority', 'authorityVersion',
            'proposalDigest', 'canonicalPaperId', 'evidenceDigest'
          ]
          AND "verifiedSnapshot" - ARRAY[
            'schemaVersion', 'kind', 'authority', 'authorityVersion',
            'proposalDigest', 'canonicalPaperId', 'evidenceDigest'
          ] = '{}'::jsonb
          AND "verifiedSnapshot"->>'proposalDigest' = "proposalDigest"
          AND "verifiedSnapshot"->>'canonicalPaperId' = "canonicalPaperId"
        )
      )
    ) IS TRUE)
);

-- The previous application path never allowed generic filing of WebMCP
-- proposals. Refuse to install the stronger invariant over a historical or
-- directly-written imported row that has no durable authority to backfill.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."InboxEntry" AS entry
    WHERE entry."source" = 'WEB_MCP'
      AND entry."status" = 'IMPORTED'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot install WebMCP approval authority while unapproved imported WebMCP entries exist.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "public"."InboxEntry" AS entry
    WHERE entry."source" = 'WEB_MCP'
      AND (
        entry."documentId" IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM "public"."ProvenanceRecord" AS provenance
          WHERE provenance."organizationId" = entry."organizationId"
            AND provenance."inboxEntryId" = entry."id"
            AND provenance."documentId" IS NOT NULL
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot install WebMCP approval authority over a proposal with document custody.';
  END IF;
END;
$$;

CREATE UNIQUE INDEX "WebMcpProposalApproval_organizationId_inboxEntryId_key"
  ON "WebMcpProposalApproval"("organizationId", "inboxEntryId");
CREATE UNIQUE INDEX "WebMcpProposalApproval_organizationId_clientOperationId_key"
  ON "WebMcpProposalApproval"("organizationId", "clientOperationId");
CREATE UNIQUE INDEX "WebMcpProposalApproval_organizationId_id_key"
  ON "WebMcpProposalApproval"("organizationId", "id");
CREATE INDEX "WebMcpProposalApproval_organizationId_approvedAt_idx"
  ON "WebMcpProposalApproval"("organizationId", "approvedAt");
CREATE INDEX "WebMcpProposalApproval_destinationProjectId_idx"
  ON "WebMcpProposalApproval"("destinationProjectId");
CREATE INDEX "WebMcpProposalApproval_approvedById_idx"
  ON "WebMcpProposalApproval"("approvedById");
CREATE INDEX "WebMcpProposalApproval_canonicalPaperId_idx"
  ON "WebMcpProposalApproval"("canonicalPaperId");
CREATE INDEX "WebMcpProposalApproval_selectedCanonicalPaperId_idx"
  ON "WebMcpProposalApproval"("selectedCanonicalPaperId");
CREATE INDEX "WebMcpProposalApproval_workspacePaperId_idx"
  ON "WebMcpProposalApproval"("workspacePaperId");
CREATE INDEX "WebMcpProposalApproval_proposalDigest_idx"
  ON "WebMcpProposalApproval"("proposalDigest");

-- A proposal has one immutable staged source-authority record. IMPORT and
-- METADATA provenance remain separate append-only facts.
CREATE UNIQUE INDEX "ProvenanceRecord_webmcp_inbox_authority_key"
  ON "ProvenanceRecord"("organizationId", "inboxEntryId")
  WHERE "kind" = 'WEB_MCP' AND "inboxEntryId" IS NOT NULL;
CREATE UNIQUE INDEX "ProvenanceRecord_webmcp_import_authority_key"
  ON "ProvenanceRecord"("organizationId", "inboxEntryId")
  WHERE "kind" = 'IMPORT'
    AND "inboxEntryId" IS NOT NULL
    AND "sourceProvider" = 'PaperPilot WebMCP review';
CREATE UNIQUE INDEX "ProvenanceRecord_webmcp_metadata_authority_key"
  ON "ProvenanceRecord"("organizationId", "inboxEntryId")
  WHERE "kind" = 'METADATA'
    AND "inboxEntryId" IS NOT NULL
    AND "sourceProvider" = 'OpenAlex';

ALTER TABLE "WebMcpProposalApproval"
  ADD CONSTRAINT "WebMcpProposalApproval_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebMcpProposalApproval"
  ADD CONSTRAINT "WebMcpProposalApproval_organizationId_inboxEntryId_fkey"
  FOREIGN KEY ("organizationId", "inboxEntryId")
  REFERENCES "InboxEntry"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "WebMcpProposalApproval"
  ADD CONSTRAINT "WebMcpProposalApproval_organizationId_destinationProjectId_fkey"
  FOREIGN KEY ("organizationId", "destinationProjectId")
  REFERENCES "Project"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
-- Retained approval authority currently retains its real actor. Account
-- erasure is intentionally blocked until a dedicated migration introduces a
-- pseudonymous retained-principal model; do not silently null audit authority.
ALTER TABLE "WebMcpProposalApproval"
  ADD CONSTRAINT "WebMcpProposalApproval_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebMcpProposalApproval"
  ADD CONSTRAINT "WebMcpProposalApproval_canonicalPaperId_fkey"
  FOREIGN KEY ("canonicalPaperId") REFERENCES "Paper"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebMcpProposalApproval"
  ADD CONSTRAINT "WebMcpProposalApproval_selectedCanonicalPaperId_fkey"
  FOREIGN KEY ("selectedCanonicalPaperId") REFERENCES "Paper"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebMcpProposalApproval"
  ADD CONSTRAINT "WebMcpProposalApproval_organizationId_workspacePaperId_fkey"
  FOREIGN KEY ("organizationId", "workspacePaperId")
  REFERENCES "WorkspacePaper"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Cross-table authority checks and their reciprocal mutations share
-- transaction-scoped locks. The hashes only select lock identities; a
-- collision can reduce concurrency but cannot weaken an invariant.
CREATE FUNCTION "public"."WebMcpInbox_integrity_lock"(
  organization_id TEXT,
  inbox_entry_id TEXT
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF organization_id IS NOT NULL AND inbox_entry_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'paperpilot:webmcp:inbox:' || organization_id || ':' || inbox_entry_id,
        0
      )
    );
  END IF;
END;
$$;

CREATE FUNCTION "public"."WebMcpPaper_integrity_lock"(paper_id TEXT)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF paper_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('paperpilot:webmcp:paper:' || paper_id, 0)
    );
  END IF;
END;
$$;

CREATE FUNCTION "WebMcpInbox_mutation_lock"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD."source" = 'WEB_MCP' THEN
    PERFORM "public"."WebMcpInbox_integrity_lock"(OLD."organizationId", OLD."id");
  END IF;
  IF TG_OP <> 'DELETE' AND NEW."source" = 'WEB_MCP' THEN
    PERFORM "public"."WebMcpInbox_integrity_lock"(NEW."organizationId", NEW."id");
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WebMcp00_Inbox_mutation_lock_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "InboxEntry"
FOR EACH ROW
EXECUTE FUNCTION "WebMcpInbox_mutation_lock"();

CREATE FUNCTION "WebMcpProvenance_mutation_lock"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD."inboxEntryId" IS NOT NULL THEN
    PERFORM "public"."WebMcpInbox_integrity_lock"(
      OLD."organizationId", OLD."inboxEntryId"
    );
  END IF;
  IF TG_OP <> 'DELETE' AND NEW."inboxEntryId" IS NOT NULL THEN
    PERFORM "public"."WebMcpInbox_integrity_lock"(
      NEW."organizationId", NEW."inboxEntryId"
    );
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WebMcp00_Provenance_mutation_lock_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProvenanceRecord"
FOR EACH ROW
EXECUTE FUNCTION "WebMcpProvenance_mutation_lock"();

CREATE FUNCTION "WebMcpProjectPaper_mutation_lock"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_paper_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT workspace_paper."paperId" INTO target_paper_id
    FROM "public"."WorkspacePaper" AS workspace_paper
    WHERE workspace_paper."organizationId" = OLD."organizationId"
      AND workspace_paper."id" = OLD."workspacePaperId";
    PERFORM "public"."WebMcpPaper_integrity_lock"(target_paper_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT workspace_paper."paperId" INTO target_paper_id
    FROM "public"."WorkspacePaper" AS workspace_paper
    WHERE workspace_paper."organizationId" = NEW."organizationId"
      AND workspace_paper."id" = NEW."workspacePaperId";
    PERFORM "public"."WebMcpPaper_integrity_lock"(target_paper_id);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WebMcp00_ProjectPaper_mutation_lock_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectPaper"
FOR EACH ROW
EXECUTE FUNCTION "WebMcpProjectPaper_mutation_lock"();

CREATE FUNCTION "WebMcpWorkspacePaper_mutation_lock"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM "public"."WebMcpPaper_integrity_lock"(OLD."paperId");
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM "public"."WebMcpPaper_integrity_lock"(NEW."paperId");
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WebMcp00_WorkspacePaper_mutation_lock_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "WorkspacePaper"
FOR EACH ROW
EXECUTE FUNCTION "WebMcpWorkspacePaper_mutation_lock"();

CREATE FUNCTION "WebMcpPaperIdentifier_mutation_lock"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM "public"."WebMcpPaper_integrity_lock"(OLD."paperId");
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM "public"."WebMcpPaper_integrity_lock"(NEW."paperId");
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WebMcp00_PaperIdentifier_mutation_lock_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "PaperIdentifier"
FOR EACH ROW
EXECUTE FUNCTION "WebMcpPaperIdentifier_mutation_lock"();

CREATE FUNCTION "WebMcpApproval_mutation_lock"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM "public"."WebMcpPaper_integrity_lock"(OLD."canonicalPaperId");
    PERFORM "public"."WebMcpInbox_integrity_lock"(
      OLD."organizationId", OLD."inboxEntryId"
    );
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM "public"."WebMcpPaper_integrity_lock"(NEW."canonicalPaperId");
    PERFORM "public"."WebMcpInbox_integrity_lock"(
      NEW."organizationId", NEW."inboxEntryId"
    );
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WebMcp00_Approval_mutation_lock_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "WebMcpProposalApproval"
FOR EACH ROW
EXECUTE FUNCTION "WebMcpApproval_mutation_lock"();

CREATE FUNCTION "WebMcpInbox_custody_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."source" = 'WEB_MCP' AND (
    NEW."documentId" IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM "public"."ProvenanceRecord" AS provenance
      WHERE provenance."organizationId" = NEW."organizationId"
        AND provenance."inboxEntryId" = NEW."id"
        AND provenance."documentId" IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpInboxEntry_metadata_only_check',
      MESSAGE = 'A WebMCP proposal cannot assert document custody.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WebMcp01_Inbox_custody_guard_trigger"
BEFORE INSERT OR UPDATE ON "InboxEntry"
FOR EACH ROW
EXECUTE FUNCTION "WebMcpInbox_custody_guard"();

CREATE FUNCTION "WebMcpProvenance_custody_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."documentId" IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "public"."InboxEntry" AS entry
    WHERE entry."organizationId" = NEW."organizationId"
      AND entry."id" = NEW."inboxEntryId"
      AND entry."source" = 'WEB_MCP'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProvenance_metadata_only_check',
      MESSAGE = 'WebMCP proposal provenance cannot assert document custody.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WebMcp01_Provenance_custody_guard_trigger"
BEFORE INSERT OR UPDATE ON "ProvenanceRecord"
FOR EACH ROW
EXECUTE FUNCTION "WebMcpProvenance_custody_guard"();

CREATE FUNCTION "WebMcpProposalApproval_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProposalApproval_immutable_check',
      MESSAGE = 'WebMCP proposal approval authority is immutable.';
  END IF;

  PERFORM 1
    FROM "public"."Member" AS member
    WHERE member."organizationId" = NEW."organizationId"
      AND member."userId" = NEW."approvedById"
      AND member."role" IN ('owner', 'admin', 'member')
    FOR KEY SHARE OF member;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProposalApproval_actor_check',
      MESSAGE = 'WebMCP approval requires a current mutating workspace member.';
  END IF;

  PERFORM 1
    FROM "public"."InboxEntry" AS entry
    JOIN "public"."WorkspacePaper" AS workspace_paper
      ON workspace_paper."organizationId" = entry."organizationId"
     AND workspace_paper."id" = entry."workspacePaperId"
    JOIN "public"."ProjectPaper" AS project_paper
      ON project_paper."organizationId" = entry."organizationId"
     AND project_paper."projectId" = entry."projectId"
     AND project_paper."workspacePaperId" = entry."workspacePaperId"
    JOIN "public"."Project" AS project
      ON project."organizationId" = entry."organizationId"
     AND project."id" = entry."projectId"
    WHERE entry."organizationId" = NEW."organizationId"
      AND entry."id" = NEW."inboxEntryId"
      AND entry."source" = 'WEB_MCP'
      AND entry."status" = 'IMPORTED'
      AND entry."documentId" IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "public"."ProvenanceRecord" AS custody_provenance
        WHERE custody_provenance."organizationId" = entry."organizationId"
          AND custody_provenance."inboxEntryId" = entry."id"
          AND custody_provenance."documentId" IS NOT NULL
      )
      AND entry."projectId" = NEW."destinationProjectId"
      AND entry."workspacePaperId" = NEW."workspacePaperId"
      AND workspace_paper."paperId" = NEW."canonicalPaperId"
      AND (
        project."visibility" = 'WORKSPACE'
        OR (project."visibility" = 'PRIVATE' AND project."createdById" = NEW."approvedById")
      )
    FOR KEY SHARE OF entry, workspace_paper, project_paper, project;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProposalApproval_target_check',
      MESSAGE = 'WebMCP approval does not match the promoted inbox target.';
  END IF;

  PERFORM 1
    FROM "public"."ProvenanceRecord" AS provenance
    JOIN "public"."InboxEntry" AS entry
      ON entry."organizationId" = provenance."organizationId"
     AND entry."id" = provenance."inboxEntryId"
    WHERE provenance."organizationId" = NEW."organizationId"
      AND provenance."inboxEntryId" = NEW."inboxEntryId"
      AND provenance."kind" = 'WEB_MCP'
      AND provenance."payloadDigest" = NEW."proposalDigest"
      AND provenance."payload" = entry."payload"
      AND provenance."documentId" IS NULL
    FOR KEY SHARE OF provenance, entry;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProposalApproval_digest_check',
      MESSAGE = 'WebMCP approval does not match the immutable staged proposal digest.';
  END IF;

  IF NEW."verificationAuthority" = 'HUMAN_REVIEW' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "public"."InboxEntry" AS entry
      WHERE entry."organizationId" = NEW."organizationId"
        AND entry."id" = NEW."inboxEntryId"
        AND CASE
          WHEN jsonb_typeof(entry."payload" #> '{paper,identifiers}') = 'array'
          THEN jsonb_array_length(entry."payload" #> '{paper,identifiers}') = 0
          ELSE FALSE
        END
    ) OR EXISTS (
      SELECT 1 FROM "public"."PaperIdentifier" AS identifier
      WHERE identifier."paperId" = NEW."canonicalPaperId"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'WebMcpProposalApproval_identifier_free_check',
        MESSAGE = 'Human-review authority is valid only for an identifier-free proposal and canonical paper.';
    END IF;
  END IF;

  IF NEW."verificationAuthority" = 'OPENALEX' THEN
    IF NOT (CASE
      WHEN jsonb_typeof(NEW."verifiedSnapshot" #> '{paper,identifiers}') = 'array'
      THEN jsonb_array_length(NEW."verifiedSnapshot" #> '{paper,identifiers}') BETWEEN 1 AND 2
      ELSE FALSE
    END) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'WebMcpProposalApproval_openalex_identifiers_check',
        MESSAGE = 'OpenAlex authority requires a closed verified identifier set.';
    END IF;

    IF (
      SELECT count(*) FROM "public"."PaperIdentifier" AS identifier
      WHERE identifier."paperId" = NEW."canonicalPaperId"
    ) <> jsonb_array_length(NEW."verifiedSnapshot" #> '{paper,identifiers}')
    OR EXISTS (
      SELECT 1
      FROM "public"."PaperIdentifier" AS identifier
      WHERE identifier."paperId" = NEW."canonicalPaperId"
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(NEW."verifiedSnapshot" #> '{paper,identifiers}') AS verified(value)
          WHERE verified.value->>'type' = identifier."type"::text
            AND verified.value->>'value' = identifier."value"
            AND verified.value->>'normalizedValue' = identifier."normalizedValue"
            AND verified.value->>'source' = identifier."source"::text
        )
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW."verifiedSnapshot" #> '{paper,identifiers}') AS verified(value)
      WHERE NOT EXISTS (
        SELECT 1
        FROM "public"."PaperIdentifier" AS identifier
        WHERE identifier."paperId" = NEW."canonicalPaperId"
          AND identifier."type"::text = verified.value->>'type'
          AND identifier."value" = verified.value->>'value'
          AND identifier."normalizedValue" = verified.value->>'normalizedValue'
          AND identifier."source"::text = verified.value->>'source'
      )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'WebMcpProposalApproval_openalex_identifiers_check',
        MESSAGE = 'Canonical identifiers do not match the verified OpenAlex authority snapshot.';
    END IF;
  END IF;

  IF NEW."decision" = 'USE_EXISTING' AND NOT EXISTS (
    SELECT 1
    FROM "public"."ProvenanceRecord" AS provenance
    WHERE provenance."organizationId" = NEW."organizationId"
      AND provenance."inboxEntryId" = NEW."inboxEntryId"
      AND provenance."kind" = 'WEB_MCP'
      AND provenance."paperId" = NEW."selectedCanonicalPaperId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProposalApproval_existing_selection_check',
      MESSAGE = 'The selected canonical paper was not the server-staged duplicate.';
  END IF;

  IF NEW."decision" = 'CREATE_NEW' AND EXISTS (
    SELECT 1
    FROM "public"."ProvenanceRecord" AS provenance
    WHERE provenance."organizationId" = NEW."organizationId"
      AND provenance."inboxEntryId" = NEW."inboxEntryId"
      AND provenance."kind" = 'WEB_MCP'
      AND provenance."paperId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProposalApproval_create_new_duplicate_check',
      MESSAGE = 'Create-new approval cannot override the exact staged canonical duplicate.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "WebMcpProposalApproval_guard_trigger"
BEFORE INSERT OR UPDATE ON "WebMcpProposalApproval"
FOR EACH ROW
EXECUTE FUNCTION "WebMcpProposalApproval_guard"();

-- The staged proposal is the immutable object reviewed by the human. Lifecycle
-- fields may advance, but direct SQL cannot swap the source identity or JSON
-- while retaining the reviewed digest.
CREATE FUNCTION "WebMcpInboxEntry_identity_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."source" = 'WEB_MCP' AND ROW(
    NEW."organizationId", NEW."source", NEW."sourceKey", NEW."dedupeKey",
    NEW."proposedTitle", NEW."proposedYear", NEW."sourceUri", NEW."payload", NEW."documentId",
    NEW."createdById"
  ) IS DISTINCT FROM ROW(
    OLD."organizationId", OLD."source", OLD."sourceKey", OLD."dedupeKey",
    OLD."proposedTitle", OLD."proposedYear", OLD."sourceUri", OLD."payload", OLD."documentId",
    OLD."createdById"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpInboxEntry_identity_check',
      MESSAGE = 'A staged WebMCP proposal identity is immutable.';
  END IF;
  IF OLD."source" = 'WEB_MCP' AND OLD."status" = 'IMPORTED' AND NEW."status" <> 'IMPORTED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpInboxEntry_imported_terminal_check',
      MESSAGE = 'An approved WebMCP proposal cannot leave the imported state.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WebMcpInboxEntry_identity_guard_trigger"
BEFORE UPDATE ON "InboxEntry"
FOR EACH ROW
WHEN (OLD."source" = 'WEB_MCP')
EXECUTE FUNCTION "WebMcpInboxEntry_identity_guard"();

-- The staged evidence and the approval-bound IMPORT/METADATA facts are
-- immutable during retention. Corrections append independent provenance;
-- they never rewrite the reviewed authority graph.
CREATE FUNCTION "WebMcpProvenance_immutable_update"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."kind" = 'WEB_MCP' OR NEW."kind" = 'WEB_MCP' OR EXISTS (
    SELECT 1
    FROM "public"."WebMcpProposalApproval" AS approval
    WHERE (
      approval."organizationId" = OLD."organizationId"
      AND approval."inboxEntryId" = OLD."inboxEntryId"
      AND OLD."kind" IN ('IMPORT', 'METADATA')
    ) OR (
      approval."organizationId" = NEW."organizationId"
      AND approval."inboxEntryId" = NEW."inboxEntryId"
      AND NEW."kind" IN ('IMPORT', 'METADATA')
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProvenance_immutable_check',
      MESSAGE = 'WebMCP authority provenance is immutable.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WebMcpProvenance_immutable_update_trigger"
BEFORE UPDATE ON "ProvenanceRecord"
FOR EACH ROW
EXECUTE FUNCTION "WebMcpProvenance_immutable_update"();

-- Deferred checks permit the service to update InboxEntry first and then
-- insert approval in the same transaction, while making an authority-less
-- IMPORTED state impossible at commit.
CREATE FUNCTION "WebMcpImportedInbox_consistency_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_organization_id TEXT;
  target_inbox_entry_id TEXT;
BEGIN
  target_organization_id := COALESCE(NEW."organizationId", OLD."organizationId");
  target_inbox_entry_id := COALESCE(NEW."id", OLD."id");

  IF EXISTS (
    SELECT 1
    FROM "public"."InboxEntry" AS entry
    WHERE entry."organizationId" = target_organization_id
      AND entry."id" = target_inbox_entry_id
      AND entry."source" = 'WEB_MCP'
      AND entry."status" = 'IMPORTED'
  ) AND (
    SELECT count(*)
    FROM "public"."WebMcpProposalApproval" AS approval
    JOIN "public"."InboxEntry" AS entry
      ON entry."organizationId" = approval."organizationId"
     AND entry."id" = approval."inboxEntryId"
    JOIN "public"."WorkspacePaper" AS workspace_paper
      ON workspace_paper."organizationId" = approval."organizationId"
     AND workspace_paper."id" = approval."workspacePaperId"
    JOIN "public"."ProjectPaper" AS project_paper
      ON project_paper."organizationId" = approval."organizationId"
     AND project_paper."projectId" = approval."destinationProjectId"
     AND project_paper."workspacePaperId" = approval."workspacePaperId"
    WHERE approval."organizationId" = target_organization_id
      AND approval."inboxEntryId" = target_inbox_entry_id
      AND entry."projectId" = approval."destinationProjectId"
      AND entry."workspacePaperId" = approval."workspacePaperId"
      AND entry."documentId" IS NULL
      AND workspace_paper."paperId" = approval."canonicalPaperId"
  ) <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpImportedInbox_approval_check',
      MESSAGE = 'An imported WebMCP proposal requires exactly one matching approval authority.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "WebMcpImportedInbox_approval_constraint"
AFTER INSERT OR UPDATE ON "InboxEntry"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "WebMcpImportedInbox_consistency_check"();

-- Every retained approval has one closed IMPORT fact. OpenAlex-backed creation
-- additionally has one exact METADATA fact carrying the independently verified
-- snapshot. These are checked at commit because the service creates them after
-- the approval row in the same serializable transaction.
CREATE FUNCTION "WebMcpApproval_provenance_consistency_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  import_count INTEGER;
  metadata_count INTEGER;
BEGIN
  SELECT count(*) INTO import_count
  FROM "public"."ProvenanceRecord" AS provenance
  WHERE provenance."organizationId" = NEW."organizationId"
    AND provenance."inboxEntryId" = NEW."inboxEntryId"
    AND provenance."kind" = 'IMPORT'
    AND provenance."paperId" = NEW."canonicalPaperId"
    AND provenance."workspacePaperId" = NEW."workspacePaperId"
    AND provenance."actorUserId" = NEW."approvedById"
    AND provenance."sourceProvider" = 'PaperPilot WebMCP review'
    AND provenance."sourceRecordId" = NEW."id"
    AND provenance."sourceUri" IS NOT DISTINCT FROM (
      SELECT entry."sourceUri"
      FROM "public"."InboxEntry" AS entry
      WHERE entry."organizationId" = NEW."organizationId"
        AND entry."id" = NEW."inboxEntryId"
    )
    AND provenance."retrievedAt" = NEW."approvedAt"
    -- The closed payload and approval ID are the authority binding. This
    -- digest is an integrity locator for that payload, not a second approval
    -- authority, because PostgreSQL core has no SHA-256 JSON primitive.
    AND provenance."payloadDigest" ~ '^[0-9a-f]{64}$'
    AND provenance."documentId" IS NULL
    AND provenance."evidenceNoteId" IS NULL
    AND provenance."zoteroObjectId" IS NULL
    AND provenance."integrationConnectionId" IS NULL
    AND provenance."supersedesId" IS NULL
    AND jsonb_typeof(provenance."payload") = 'object'
    AND provenance."payload" ?& ARRAY[
      'schemaVersion', 'approvalId', 'proposalDigest', 'destinationProjectId',
      'decision', 'canonicalPaperId', 'workspacePaperId',
      'verificationAuthority', 'verificationAuthorityVersion',
      'verificationEvidenceDigest'
    ]
    AND provenance."payload" - ARRAY[
      'schemaVersion', 'approvalId', 'proposalDigest', 'destinationProjectId',
      'decision', 'canonicalPaperId', 'workspacePaperId',
      'verificationAuthority', 'verificationAuthorityVersion',
      'verificationEvidenceDigest'
    ] = '{}'::jsonb
    AND provenance."payload"->>'schemaVersion' = '1'
    AND provenance."payload"->>'approvalId' = NEW."id"
    AND provenance."payload"->>'proposalDigest' = NEW."proposalDigest"
    AND provenance."payload"->>'destinationProjectId' = NEW."destinationProjectId"
    AND provenance."payload"->>'decision' = CASE
      WHEN NEW."decision" = 'CREATE_NEW' THEN 'create_new'
      ELSE 'use_existing'
    END
    AND provenance."payload"->>'canonicalPaperId' = NEW."canonicalPaperId"
    AND provenance."payload"->>'workspacePaperId' = NEW."workspacePaperId"
    AND provenance."payload"->>'verificationAuthority' = NEW."verificationAuthority"::text
    AND provenance."payload"->>'verificationAuthorityVersion' = NEW."verificationAuthorityVersion"
    AND provenance."payload"->>'verificationEvidenceDigest' = NEW."verificationEvidenceDigest";

  IF import_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProposalApproval_import_provenance_check',
      MESSAGE = 'Retained WebMCP approval requires one exact IMPORT provenance authority.';
  END IF;

  SELECT count(*) INTO metadata_count
  FROM "public"."ProvenanceRecord" AS provenance
  WHERE provenance."organizationId" = NEW."organizationId"
    AND provenance."inboxEntryId" = NEW."inboxEntryId"
    AND provenance."kind" = 'METADATA'
    AND provenance."sourceProvider" = 'OpenAlex';

  IF NEW."verificationAuthority" = 'OPENALEX' THEN
    IF metadata_count <> 1 OR NOT EXISTS (
      SELECT 1
      FROM "public"."ProvenanceRecord" AS provenance
      WHERE provenance."organizationId" = NEW."organizationId"
        AND provenance."inboxEntryId" = NEW."inboxEntryId"
        AND provenance."kind" = 'METADATA'
        AND provenance."paperId" = NEW."canonicalPaperId"
        AND provenance."workspacePaperId" = NEW."workspacePaperId"
        AND provenance."actorUserId" = NEW."approvedById"
        AND provenance."sourceProvider" = 'OpenAlex'
        AND provenance."sourceRecordId" = NEW."verifiedSnapshot"->>'sourceRecordId'
        AND provenance."sourceUri" = 'https://openalex.org/' || (NEW."verifiedSnapshot"->>'sourceRecordId')
        AND provenance."retrievedAt" AT TIME ZONE 'UTC'
          = (NEW."verifiedSnapshot"->>'retrievedAt')::timestamptz
        AND provenance."payloadDigest" = NEW."verificationEvidenceDigest"
        AND provenance."payload" = NEW."verifiedSnapshot"
        AND provenance."documentId" IS NULL
        AND provenance."evidenceNoteId" IS NULL
        AND provenance."zoteroObjectId" IS NULL
        AND provenance."integrationConnectionId" IS NULL
        AND provenance."supersedesId" IS NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'WebMcpProposalApproval_metadata_provenance_check',
        MESSAGE = 'OpenAlex WebMCP approval requires one exact METADATA provenance authority.';
    END IF;
  ELSIF metadata_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProposalApproval_metadata_provenance_check',
      MESSAGE = 'Identifier-free and existing-canonical WebMCP approvals cannot claim OpenAlex metadata authority.';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "WebMcpProposalApproval_provenance_constraint"
AFTER INSERT ON "WebMcpProposalApproval"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "WebMcpApproval_provenance_consistency_check"();

-- Identifier-free human review cannot later be used to squat the global
-- identifier namespace, and OpenAlex-backed creation retains exactly the
-- independently verified identifier set. EXISTING_CANONICAL makes no such
-- claim and remains eligible for separately authorized metadata enrichment.
CREATE FUNCTION "WebMcpCanonicalIdentifier_consistency_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_paper_ids TEXT[];
  target_paper_id TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_paper_ids := ARRAY[NEW."paperId"];
  ELSIF TG_OP = 'DELETE' THEN
    target_paper_ids := ARRAY[OLD."paperId"];
  ELSE
    target_paper_ids := ARRAY[OLD."paperId", NEW."paperId"];
  END IF;

  FOREACH target_paper_id IN ARRAY target_paper_ids LOOP
    IF target_paper_id IS NULL THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM "public"."WebMcpProposalApproval" AS approval
      WHERE approval."canonicalPaperId" = target_paper_id
        AND approval."verificationAuthority" = 'HUMAN_REVIEW'
    ) AND EXISTS (
      SELECT 1
      FROM "public"."PaperIdentifier" AS identifier
      WHERE identifier."paperId" = target_paper_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'WebMcpCanonicalIdentifier_retained_check',
        MESSAGE = 'Identifier-free WebMCP authority cannot gain a canonical identifier.';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM "public"."WebMcpProposalApproval" AS approval
      WHERE approval."canonicalPaperId" = target_paper_id
        AND approval."verificationAuthority" = 'OPENALEX'
        AND (
          (
            SELECT count(*)
            FROM "public"."PaperIdentifier" AS identifier
            WHERE identifier."paperId" = target_paper_id
          ) <> jsonb_array_length(approval."verifiedSnapshot" #> '{paper,identifiers}')
          OR EXISTS (
            SELECT 1
            FROM "public"."PaperIdentifier" AS identifier
            WHERE identifier."paperId" = target_paper_id
              AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  approval."verifiedSnapshot" #> '{paper,identifiers}'
                ) AS verified(value)
                WHERE verified.value->>'type' = identifier."type"::text
                  AND verified.value->>'value' = identifier."value"
                  AND verified.value->>'normalizedValue' = identifier."normalizedValue"
                  AND verified.value->>'source' = identifier."source"::text
              )
          )
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              approval."verifiedSnapshot" #> '{paper,identifiers}'
            ) AS verified(value)
            WHERE NOT EXISTS (
              SELECT 1
              FROM "public"."PaperIdentifier" AS identifier
              WHERE identifier."paperId" = target_paper_id
                AND identifier."type"::text = verified.value->>'type'
                AND identifier."value" = verified.value->>'value'
                AND identifier."normalizedValue" = verified.value->>'normalizedValue'
                AND identifier."source"::text = verified.value->>'source'
            )
          )
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'WebMcpCanonicalIdentifier_retained_check',
        MESSAGE = 'OpenAlex WebMCP authority requires its exact verified canonical identifiers.';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "WebMcpCanonicalIdentifier_approval_constraint"
AFTER INSERT OR UPDATE OR DELETE ON "PaperIdentifier"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "WebMcpCanonicalIdentifier_consistency_check"();

-- Deleting authority is allowed only as part of a transaction that also
-- erases or unlinks the tenant's imported proposal graph.
CREATE FUNCTION "WebMcpApproval_delete_consistency_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."InboxEntry" AS entry
    WHERE entry."organizationId" = OLD."organizationId"
      AND entry."id" = OLD."inboxEntryId"
      AND entry."source" = 'WEB_MCP'
      AND entry."status" = 'IMPORTED'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProposalApproval_retained_delete_check',
      MESSAGE = 'Retained imported WebMCP state cannot lose its approval authority.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "WebMcpProposalApproval_delete_constraint"
AFTER DELETE ON "WebMcpProposalApproval"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "WebMcpApproval_delete_consistency_check"();

CREATE FUNCTION "WebMcpProjectPaper_consistency_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."WebMcpProposalApproval" AS approval
    JOIN "public"."InboxEntry" AS entry
      ON entry."organizationId" = approval."organizationId"
     AND entry."id" = approval."inboxEntryId"
     AND entry."status" = 'IMPORTED'
    WHERE approval."organizationId" = OLD."organizationId"
      AND approval."destinationProjectId" = OLD."projectId"
      AND approval."workspacePaperId" = OLD."workspacePaperId"
  ) AND NOT EXISTS (
    SELECT 1 FROM "public"."ProjectPaper" AS project_paper
    WHERE project_paper."organizationId" = OLD."organizationId"
      AND project_paper."projectId" = OLD."projectId"
      AND project_paper."workspacePaperId" = OLD."workspacePaperId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProjectPaper_retained_edge_check',
      MESSAGE = 'Retained imported WebMCP authority requires its exact project edge.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "WebMcpProjectPaper_approval_constraint"
AFTER DELETE OR UPDATE ON "ProjectPaper"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "WebMcpProjectPaper_consistency_check"();

CREATE FUNCTION "WebMcpWorkspacePaper_consistency_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."WebMcpProposalApproval" AS approval
    JOIN "public"."InboxEntry" AS entry
      ON entry."organizationId" = approval."organizationId"
     AND entry."id" = approval."inboxEntryId"
     AND entry."status" = 'IMPORTED'
    WHERE approval."organizationId" = OLD."organizationId"
      AND approval."workspacePaperId" = OLD."id"
  ) AND NOT EXISTS (
    SELECT 1
    FROM "public"."WorkspacePaper" AS workspace_paper
    JOIN "public"."WebMcpProposalApproval" AS approval
      ON approval."organizationId" = workspace_paper."organizationId"
     AND approval."workspacePaperId" = workspace_paper."id"
     AND approval."canonicalPaperId" = workspace_paper."paperId"
    WHERE workspace_paper."organizationId" = OLD."organizationId"
      AND workspace_paper."id" = OLD."id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpWorkspacePaper_retained_target_check',
      MESSAGE = 'Retained WebMCP approval requires its exact canonical workspace paper.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "WebMcpWorkspacePaper_approval_constraint"
AFTER DELETE OR UPDATE ON "WorkspacePaper"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "WebMcpWorkspacePaper_consistency_check"();

CREATE FUNCTION "WebMcpProvenance_delete_consistency_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."kind" = 'WEB_MCP' AND EXISTS (
    SELECT 1 FROM "public"."InboxEntry" AS entry
    WHERE entry."organizationId" = OLD."organizationId"
      AND entry."id" = OLD."inboxEntryId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProvenance_retained_delete_check',
      MESSAGE = 'Retained WebMCP proposal requires its exact staged provenance.';
  END IF;
  IF OLD."kind" IN ('IMPORT', 'METADATA') AND EXISTS (
    SELECT 1 FROM "public"."WebMcpProposalApproval" AS approval
    WHERE approval."organizationId" = OLD."organizationId"
      AND approval."inboxEntryId" = OLD."inboxEntryId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProvenance_retained_delete_check',
      MESSAGE = 'Retained WebMCP approval requires its exact approval provenance.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "WebMcpProvenance_approval_constraint"
AFTER DELETE ON "ProvenanceRecord"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "WebMcpProvenance_delete_consistency_check"();
