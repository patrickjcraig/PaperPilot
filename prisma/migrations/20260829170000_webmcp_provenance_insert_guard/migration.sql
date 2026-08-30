-- The original approval migration validates the required authority rows when
-- an approval is inserted and prevents their later update/delete. This
-- reciprocal INSERT guard closes the remaining append path: once an approval
-- exists, its Inbox may contain only the one exact IMPORT fact and, for
-- OpenAlex authority, the one exact verified METADATA fact. Other enrichment
-- must be unlinked from the approval Inbox or use a future correction model.

CREATE FUNCTION "public"."WebMcpApproval_provenance_row_allowed"(
  organization_id TEXT,
  inbox_entry_id TEXT,
  provenance_id TEXT
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN provenance."kind" = 'IMPORT' THEN (
      provenance."paperId" = approval."canonicalPaperId"
      AND provenance."workspacePaperId" = approval."workspacePaperId"
      AND provenance."actorUserId" = approval."approvedById"
      AND provenance."sourceProvider" = 'PaperPilot WebMCP review'
      AND provenance."sourceRecordId" = approval."id"
      AND provenance."sourceUri" IS NOT DISTINCT FROM entry."sourceUri"
      AND provenance."retrievedAt" = approval."approvedAt"
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
      AND provenance."payload"->>'approvalId' = approval."id"
      AND provenance."payload"->>'proposalDigest' = approval."proposalDigest"
      AND provenance."payload"->>'destinationProjectId' = approval."destinationProjectId"
      AND provenance."payload"->>'decision' = CASE
        WHEN approval."decision" = 'CREATE_NEW' THEN 'create_new'
        ELSE 'use_existing'
      END
      AND provenance."payload"->>'canonicalPaperId' = approval."canonicalPaperId"
      AND provenance."payload"->>'workspacePaperId' = approval."workspacePaperId"
      AND provenance."payload"->>'verificationAuthority' = approval."verificationAuthority"::text
      AND provenance."payload"->>'verificationAuthorityVersion'
        = approval."verificationAuthorityVersion"
      AND provenance."payload"->>'verificationEvidenceDigest'
        = approval."verificationEvidenceDigest"
    ) IS TRUE
    WHEN provenance."kind" = 'METADATA' THEN (
      approval."verificationAuthority" = 'OPENALEX'
      AND provenance."paperId" = approval."canonicalPaperId"
      AND provenance."workspacePaperId" = approval."workspacePaperId"
      AND provenance."actorUserId" = approval."approvedById"
      AND provenance."sourceProvider" = 'OpenAlex'
      AND provenance."sourceRecordId" = approval."verifiedSnapshot"->>'sourceRecordId'
      AND provenance."sourceUri"
        = 'https://openalex.org/' || (approval."verifiedSnapshot"->>'sourceRecordId')
      AND provenance."retrievedAt" AT TIME ZONE 'UTC'
        = (approval."verifiedSnapshot"->>'retrievedAt')::timestamptz
      AND provenance."payloadDigest" = approval."verificationEvidenceDigest"
      AND provenance."payload" = approval."verifiedSnapshot"
      AND provenance."documentId" IS NULL
      AND provenance."evidenceNoteId" IS NULL
      AND provenance."zoteroObjectId" IS NULL
      AND provenance."integrationConnectionId" IS NULL
      AND provenance."supersedesId" IS NULL
    ) IS TRUE
    ELSE FALSE
  END
  FROM "public"."ProvenanceRecord" AS provenance
  JOIN "public"."WebMcpProposalApproval" AS approval
    ON approval."organizationId" = provenance."organizationId"
   AND approval."inboxEntryId" = provenance."inboxEntryId"
  JOIN "public"."InboxEntry" AS entry
    ON entry."organizationId" = approval."organizationId"
   AND entry."id" = approval."inboxEntryId"
  WHERE provenance."organizationId" = organization_id
    AND provenance."inboxEntryId" = inbox_entry_id
    AND provenance."id" = provenance_id;
$$;

-- Refuse to install over any authority-like row that was appended after the
-- first migration but does not belong to its retained approval exactly.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."ProvenanceRecord" AS provenance
    JOIN "public"."WebMcpProposalApproval" AS approval
      ON approval."organizationId" = provenance."organizationId"
     AND approval."inboxEntryId" = provenance."inboxEntryId"
    WHERE provenance."kind" IN ('IMPORT', 'METADATA')
      AND "public"."WebMcpApproval_provenance_row_allowed"(
        provenance."organizationId",
        provenance."inboxEntryId",
        provenance."id"
      ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot install WebMCP provenance INSERT guard over unexpected approval-bound authority rows.';
  END IF;
END;
$$;

CREATE FUNCTION "public"."WebMcpProvenance_insert_consistency_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."kind" IN ('IMPORT', 'METADATA') AND EXISTS (
    SELECT 1
    FROM "public"."WebMcpProposalApproval" AS approval
    WHERE approval."organizationId" = NEW."organizationId"
      AND approval."inboxEntryId" = NEW."inboxEntryId"
  ) AND "public"."WebMcpApproval_provenance_row_allowed"(
    NEW."organizationId",
    NEW."inboxEntryId",
    NEW."id"
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProvenance_approved_insert_check',
      MESSAGE = 'An approved WebMCP Inbox accepts only its exact retained IMPORT and METADATA authority rows.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "WebMcpProvenance_approved_insert_constraint"
AFTER INSERT ON "public"."ProvenanceRecord"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "public"."WebMcpProvenance_insert_consistency_check"();

-- The reciprocal order matters too: an unexpected authority-like row may be
-- present before approval. Revalidate the whole retained set when approval is
-- added; the original migration's approval trigger still independently
-- requires the exact IMPORT row and exact OpenAlex METADATA row.
CREATE FUNCTION "public"."WebMcpApproval_provenance_closed_set_check"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."ProvenanceRecord" AS provenance
    WHERE provenance."organizationId" = NEW."organizationId"
      AND provenance."inboxEntryId" = NEW."inboxEntryId"
      AND provenance."kind" IN ('IMPORT', 'METADATA')
      AND "public"."WebMcpApproval_provenance_row_allowed"(
        provenance."organizationId",
        provenance."inboxEntryId",
        provenance."id"
      ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpApproval_provenance_closed_set_check',
      MESSAGE = 'A WebMCP approval cannot retain unexpected IMPORT or METADATA authority rows.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "WebMcpApproval_provenance_closed_set_constraint"
AFTER INSERT ON "public"."WebMcpProposalApproval"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "public"."WebMcpApproval_provenance_closed_set_check"();
