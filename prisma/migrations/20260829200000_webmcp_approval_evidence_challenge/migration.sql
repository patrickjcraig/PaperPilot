-- Two-step WebMCP approval. Provider verification is frozen in a short-lived
-- one-use challenge before final human consent. Historical approvals remain
-- command schema v1; every post-cutover approval is command schema v2 and is
-- linked to the exact challenge that supplied its retained evidence.

CREATE TABLE "WebMcpApprovalChallenge" (
    "id" VARCHAR(43) NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "inboxEntryId" TEXT NOT NULL,
    "proposalDigest" CHAR(64) NOT NULL,
    "destinationProjectId" TEXT NOT NULL,
    "decision" "WebMcpDuplicateDecision" NOT NULL,
    "selectedCanonicalPaperId" TEXT,
    "expectedOrganizationRevision" INTEGER NOT NULL,
    "verificationAuthority" "WebMcpVerificationAuthority" NOT NULL,
    "verificationAuthorityVersion" VARCHAR(100) NOT NULL,
    "verificationEvidenceDigest" CHAR(64) NOT NULL,
    "verifiedSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "WebMcpApprovalChallenge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WebMcpApprovalChallenge_id_check"
      CHECK ("id" ~ '^[A-Za-z0-9_-]{43}$'),
    CONSTRAINT "WebMcpApprovalChallenge_schema_check"
      CHECK ("schemaVersion" = 2),
    CONSTRAINT "WebMcpApprovalChallenge_revision_check"
      CHECK ("expectedOrganizationRevision" >= 0),
    CONSTRAINT "WebMcpApprovalChallenge_proposal_digest_check"
      CHECK ("proposalDigest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "WebMcpApprovalChallenge_evidence_digest_check"
      CHECK ("verificationEvidenceDigest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "WebMcpApprovalChallenge_authority_version_check"
      CHECK (length("verificationAuthorityVersion") BETWEEN 1 AND 100),
    CONSTRAINT "WebMcpApprovalChallenge_lifetime_check" CHECK ((
      "expiresAt" > "createdAt"
      AND "expiresAt" <= "createdAt" + INTERVAL '10 minutes'
      AND (
        "consumedAt" IS NULL
        OR ("consumedAt" >= "createdAt" AND "consumedAt" < "expiresAt")
      )
    ) IS TRUE),
    CONSTRAINT "WebMcpApprovalChallenge_decision_check" CHECK ((
      ("decision" = 'CREATE_NEW' AND "selectedCanonicalPaperId" IS NULL)
      OR
      ("decision" = 'USE_EXISTING' AND "selectedCanonicalPaperId" IS NOT NULL)
    ) IS TRUE),
    CONSTRAINT "WebMcpApprovalChallenge_authority_check" CHECK ((
      (
        "decision" = 'USE_EXISTING'
        AND "verificationAuthority" = 'EXISTING_CANONICAL'
        AND "verificationAuthorityVersion" = 'existing-canonical-v1'
      )
      OR
      (
        "decision" = 'CREATE_NEW'
        AND (
          ("verificationAuthority" = 'OPENALEX'
            AND "verificationAuthorityVersion" = 'works-singleton-v1')
          OR
          ("verificationAuthority" = 'HUMAN_REVIEW'
            AND "verificationAuthorityVersion" = 'human-review-v1')
        )
      )
    ) IS TRUE),
    CONSTRAINT "WebMcpApprovalChallenge_snapshot_shape_check" CHECK ((
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
          AND "verifiedSnapshot"->>'canonicalPaperId' = "selectedCanonicalPaperId"
        )
      )
    ) IS TRUE)
);

CREATE UNIQUE INDEX "WebMcpApprovalChallenge_organizationId_id_key"
  ON "WebMcpApprovalChallenge"("organizationId", "id");
CREATE INDEX "WebMcpApprovalChallenge_organizationId_actorUserId_expiresAt_idx"
  ON "WebMcpApprovalChallenge"("organizationId", "actorUserId", "expiresAt");
CREATE INDEX "WebMcpApprovalChallenge_organizationId_inboxEntryId_expiresAt_idx"
  ON "WebMcpApprovalChallenge"("organizationId", "inboxEntryId", "expiresAt");
CREATE INDEX "WebMcpApprovalChallenge_destinationProjectId_idx"
  ON "WebMcpApprovalChallenge"("destinationProjectId");
CREATE INDEX "WebMcpApprovalChallenge_selectedCanonicalPaperId_idx"
  ON "WebMcpApprovalChallenge"("selectedCanonicalPaperId");
CREATE INDEX "WebMcpApprovalChallenge_verificationEvidenceDigest_idx"
  ON "WebMcpApprovalChallenge"("verificationEvidenceDigest");

ALTER TABLE "WebMcpApprovalChallenge"
  ADD CONSTRAINT "WebMcpApprovalChallenge_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "WebMcpApprovalChallenge"
  ADD CONSTRAINT "WebMcpApprovalChallenge_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "WebMcpApprovalChallenge"
  ADD CONSTRAINT "WebMcpApprovalChallenge_organizationId_inboxEntryId_fkey"
  FOREIGN KEY ("organizationId", "inboxEntryId")
  REFERENCES "InboxEntry"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "WebMcpApprovalChallenge"
  ADD CONSTRAINT "WebMcpApprovalChallenge_organizationId_destinationProjectId_fkey"
  FOREIGN KEY ("organizationId", "destinationProjectId")
  REFERENCES "Project"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "WebMcpApprovalChallenge"
  ADD CONSTRAINT "WebMcpApprovalChallenge_selectedCanonicalPaperId_fkey"
  FOREIGN KEY ("selectedCanonicalPaperId") REFERENCES "Paper"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "WebMcpProposalApproval"
  ADD COLUMN "approvalCommandSchemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "challengeId" VARCHAR(43);
ALTER TABLE "WebMcpProposalApproval"
  ALTER COLUMN "approvalCommandSchemaVersion" DROP DEFAULT;
ALTER TABLE "WebMcpProposalApproval"
  ADD CONSTRAINT "WebMcpProposalApproval_command_challenge_check" CHECK ((
    ("approvalCommandSchemaVersion" = 1 AND "challengeId" IS NULL)
    OR
    ("approvalCommandSchemaVersion" = 2 AND "challengeId" IS NOT NULL)
  ) IS TRUE);
CREATE UNIQUE INDEX "WebMcpProposalApproval_organizationId_challengeId_key"
  ON "WebMcpProposalApproval"("organizationId", "challengeId");
ALTER TABLE "WebMcpProposalApproval"
  ADD CONSTRAINT "WebMcpApproval_challenge_fkey"
  FOREIGN KEY ("organizationId", "challengeId")
  REFERENCES "WebMcpApprovalChallenge"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Only the one-way, one-use consumption timestamp may change. The deferred
-- reciprocal check below requires that transition and approval insertion to
-- occur in the same transaction.
CREATE FUNCTION "public"."WebMcpApprovalChallenge_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."consumedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'WebMcpApprovalChallenge_unconsumed_insert_check',
        MESSAGE = 'A new WebMCP approval challenge must be unconsumed.';
    END IF;

    PERFORM 1
    FROM "public"."Member" AS member
    JOIN "public"."Organization" AS organization
      ON organization."id" = member."organizationId"
    WHERE member."organizationId" = NEW."organizationId"
      AND member."userId" = NEW."actorUserId"
      AND member."role" IN ('owner', 'admin', 'member')
      AND organization."revision" = NEW."expectedOrganizationRevision"
    FOR KEY SHARE OF member;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'WebMcpApprovalChallenge_actor_revision_check',
        MESSAGE = 'A WebMCP approval challenge requires a current mutating member and revision.';
    END IF;

    PERFORM 1
    FROM "public"."InboxEntry" AS entry
    JOIN "public"."ProvenanceRecord" AS provenance
      ON provenance."organizationId" = entry."organizationId"
     AND provenance."inboxEntryId" = entry."id"
     AND provenance."kind" = 'WEB_MCP'
    JOIN "public"."Project" AS project
      ON project."organizationId" = entry."organizationId"
     AND project."id" = NEW."destinationProjectId"
    WHERE entry."organizationId" = NEW."organizationId"
      AND entry."id" = NEW."inboxEntryId"
      AND entry."source" = 'WEB_MCP'
      AND entry."status" IN ('PENDING', 'DUPLICATE')
      AND entry."documentId" IS NULL
      AND provenance."documentId" IS NULL
      AND provenance."payloadDigest" = NEW."proposalDigest"
      AND provenance."payload" = entry."payload"
      AND (
        (NEW."decision" = 'CREATE_NEW' AND provenance."paperId" IS NULL)
        OR
        (NEW."decision" = 'USE_EXISTING'
          AND provenance."paperId" = NEW."selectedCanonicalPaperId")
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'WebMcpApprovalChallenge_staged_intent_check',
        MESSAGE = 'A WebMCP approval challenge must match the exact staged proposal intent.';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."schemaVersion" IS DISTINCT FROM OLD."schemaVersion"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId"
     OR NEW."inboxEntryId" IS DISTINCT FROM OLD."inboxEntryId"
     OR NEW."proposalDigest" IS DISTINCT FROM OLD."proposalDigest"
     OR NEW."destinationProjectId" IS DISTINCT FROM OLD."destinationProjectId"
     OR NEW."decision" IS DISTINCT FROM OLD."decision"
     OR NEW."selectedCanonicalPaperId" IS DISTINCT FROM OLD."selectedCanonicalPaperId"
     OR NEW."expectedOrganizationRevision" IS DISTINCT FROM OLD."expectedOrganizationRevision"
     OR NEW."verificationAuthority" IS DISTINCT FROM OLD."verificationAuthority"
     OR NEW."verificationAuthorityVersion" IS DISTINCT FROM OLD."verificationAuthorityVersion"
     OR NEW."verificationEvidenceDigest" IS DISTINCT FROM OLD."verificationEvidenceDigest"
     OR NEW."verifiedSnapshot" IS DISTINCT FROM OLD."verifiedSnapshot"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR OLD."consumedAt" IS NOT NULL
     OR NEW."consumedAt" IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpApprovalChallenge_immutable_check',
      MESSAGE = 'WebMCP approval challenge authority is immutable and one-use.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WebMcpApprovalChallenge_guard_trigger"
BEFORE INSERT OR UPDATE ON "WebMcpApprovalChallenge"
FOR EACH ROW
EXECUTE FUNCTION "public"."WebMcpApprovalChallenge_guard"();

-- New approval rows must reproduce the complete challenge binding exactly.
-- Existing v1 rows retain NULL challengeId, but no post-cutover INSERT may
-- manufacture another historical approval.
CREATE FUNCTION "public"."WebMcpApproval_challenge_binding_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."approvalCommandSchemaVersion" = 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'WebMcpApproval_historical_insert_check',
      MESSAGE = 'New WebMCP approvals require a v2 review challenge.';
  END IF;

  PERFORM 1
  FROM "public"."WebMcpApprovalChallenge" AS challenge
  JOIN "public"."Organization" AS organization
    ON organization."id" = challenge."organizationId"
  WHERE challenge."organizationId" = NEW."organizationId"
    AND challenge."id" = NEW."challengeId"
    AND challenge."schemaVersion" = 2
    AND challenge."actorUserId" = NEW."approvedById"
    AND challenge."inboxEntryId" = NEW."inboxEntryId"
    AND challenge."proposalDigest" = NEW."proposalDigest"
    AND challenge."destinationProjectId" = NEW."destinationProjectId"
    AND challenge."decision" = NEW."decision"
    AND challenge."selectedCanonicalPaperId"
      IS NOT DISTINCT FROM NEW."selectedCanonicalPaperId"
    AND challenge."verificationAuthority" = NEW."verificationAuthority"
    AND challenge."verificationAuthorityVersion" = NEW."verificationAuthorityVersion"
    AND challenge."verificationEvidenceDigest" = NEW."verificationEvidenceDigest"
    AND challenge."verifiedSnapshot" = NEW."verifiedSnapshot"
    AND challenge."consumedAt" = NEW."approvedAt"
    AND organization."revision" = challenge."expectedOrganizationRevision" + 1
  FOR KEY SHARE OF challenge;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpApproval_challenge_binding_check',
      MESSAGE = 'A v2 WebMCP approval must exactly match its consumed review challenge.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WebMcp02_Approval_challenge_binding_trigger"
BEFORE INSERT ON "WebMcpProposalApproval"
FOR EACH ROW
EXECUTE FUNCTION "public"."WebMcpApproval_challenge_binding_check"();

CREATE FUNCTION "public"."WebMcpApprovalChallenge_consumption_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."consumedAt" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "public"."WebMcpProposalApproval" AS approval
    WHERE approval."organizationId" = NEW."organizationId"
      AND approval."challengeId" = NEW."id"
      AND approval."approvalCommandSchemaVersion" = 2
      AND approval."approvedAt" = NEW."consumedAt"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpApprovalChallenge_consumption_check',
      MESSAGE = 'A consumed WebMCP challenge requires its exact retained approval.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "WebMcpApprovalChallenge_consumption_constraint"
AFTER UPDATE ON "WebMcpApprovalChallenge"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "public"."WebMcpApprovalChallenge_consumption_check"();

CREATE FUNCTION "public"."WebMcpApproval_challenge_retention_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."approvalCommandSchemaVersion" = 2 AND EXISTS (
    SELECT 1
    FROM "public"."WebMcpApprovalChallenge" AS challenge
    WHERE challenge."organizationId" = OLD."organizationId"
      AND challenge."id" = OLD."challengeId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpApproval_challenge_retention_check',
      MESSAGE = 'Tenant erasure must remove a retained WebMCP challenge with its approval.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "WebMcpApproval_challenge_retention_constraint"
AFTER DELETE ON "WebMcpProposalApproval"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "public"."WebMcpApproval_challenge_retention_check"();
