-- Tighten the retained-principal expand phase without making principal
-- columns mandatory. Old application nodes may continue to write NULL during
-- the rolling deployment, while every non-NULL principal written by a new
-- node must be a live, tenant-bound mapping for the legacy actor beside it.

-- Hold writers across preflight and trigger installation so no mismatched row
-- can commit in the gap. The order follows the application authority path
-- (User -> principal -> Inbox -> approval/provenance -> audit) to minimize
-- deadlock risk while a rolling node finishes an in-flight transaction.
LOCK TABLE
  "public"."User",
  "public"."RetainedAuditPrincipal",
  "public"."InboxEntry",
  "public"."WebMcpProposalApproval",
  "public"."ProvenanceRecord",
  "public"."AuditEvent"
IN SHARE ROW EXCLUSIVE MODE;

-- Refuse to install the guards over a principal/legacy-actor mismatch. A
-- legitimately erased actor is represented by a pseudonymized principal and
-- a NULL legacy actor; those retained references must remain readable.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT entry."organizationId", entry."createdById" AS actor_id,
             entry."createdByPrincipalId" AS principal_id
      FROM "public"."InboxEntry" AS entry
      WHERE entry."createdByPrincipalId" IS NOT NULL
      UNION ALL
      SELECT provenance."organizationId", provenance."actorUserId",
             provenance."actorPrincipalId"
      FROM "public"."ProvenanceRecord" AS provenance
      WHERE provenance."actorPrincipalId" IS NOT NULL
      UNION ALL
      SELECT approval."organizationId", approval."approvedById",
             approval."approvedByPrincipalId"
      FROM "public"."WebMcpProposalApproval" AS approval
      WHERE approval."approvedByPrincipalId" IS NOT NULL
      UNION ALL
      SELECT audit."organizationId", audit."actorUserId",
             audit."actorPrincipalId"
      FROM "public"."AuditEvent" AS audit
      WHERE audit."actorPrincipalId" IS NOT NULL
    ) AS retained_reference
    LEFT JOIN "public"."RetainedAuditPrincipal" AS principal
      ON principal."organizationId" = retained_reference."organizationId"
     AND principal."id" = retained_reference.principal_id
    WHERE principal."id" IS NULL
       OR (
         (
           principal."liveUserId" IS NOT NULL
           AND principal."pseudonymizedAt" IS NULL
           AND principal."liveUserId" = retained_reference.actor_id
         )
         OR
         (
           principal."liveUserId" IS NULL
           AND principal."pseudonymizedAt" IS NOT NULL
           AND retained_reference.actor_id IS NULL
         )
       ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot install retained-principal actor guards over a mismatched retained reference.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."ProvenanceRecord" AS provenance
    LEFT JOIN "public"."InboxEntry" AS entry
      ON entry."organizationId" = provenance."organizationId"
     AND entry."id" = provenance."inboxEntryId"
    WHERE provenance."kind" = 'WEB_MCP'
      AND (
        entry."id" IS NULL
        OR entry."source" <> 'WEB_MCP'
        OR provenance."actorPrincipalId"
             IS DISTINCT FROM entry."createdByPrincipalId"
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot install retained-principal guards over mismatched staged WebMCP authority.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."ProvenanceRecord" AS provenance
    JOIN "public"."WebMcpProposalApproval" AS approval
      ON approval."organizationId" = provenance."organizationId"
     AND approval."inboxEntryId" = provenance."inboxEntryId"
    WHERE provenance."kind" IN ('IMPORT', 'METADATA')
      AND provenance."actorPrincipalId"
            IS DISTINCT FROM approval."approvedByPrincipalId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot install retained-principal guards over mismatched approval provenance authority.';
  END IF;
END;
$$;

-- A retained principal may only be born as a live mapping. Its identifiers and
-- creation time never change. The sole update is the ON DELETE SET NULL action
-- from User: by the time that referential action reaches this BEFORE trigger,
-- the deleted User is no longer visible. The database, not the caller, stamps
-- the actual detachment time using clock_timestamp().
CREATE OR REPLACE FUNCTION "public"."RetainedAuditPrincipal_immutability_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."liveUserId" IS NULL OR NEW."pseudonymizedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'RetainedAuditPrincipal_live_insert_check',
        MESSAGE = 'A retained audit principal must be created as a live, unpseudonymized mapping.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'RetainedAuditPrincipal_identity_immutable_check',
      MESSAGE = 'Retained audit principal identity is immutable.';
  END IF;

  -- A caller may neither supply a pseudonymization time nor directly detach a
  -- still-existing account. Referential User deletion supplies NULL for both
  -- columns, after which this trigger supplies the authoritative timestamp.
  IF OLD."liveUserId" IS NOT NULL
     AND OLD."pseudonymizedAt" IS NULL
     AND NEW."liveUserId" IS NULL
     AND NEW."pseudonymizedAt" IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM "public"."User" AS live_user
      WHERE live_user."id" = OLD."liveUserId"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'RetainedAuditPrincipal_fk_detach_only_check',
        MESSAGE = 'A retained audit principal can detach only through deletion of its live User.';
    END IF;

    NEW."pseudonymizedAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'RetainedAuditPrincipal_rewrite_check',
    MESSAGE = 'Retained audit principal cannot be rebound or rewritten.';
END;
$function$;

DROP TRIGGER "RetainedAuditPrincipal_immutability_guard_trigger"
  ON "public"."RetainedAuditPrincipal";
CREATE TRIGGER "RetainedAuditPrincipal_immutability_guard_trigger"
BEFORE INSERT OR UPDATE ON "public"."RetainedAuditPrincipal"
FOR EACH ROW
EXECUTE FUNCTION "public"."RetainedAuditPrincipal_immutability_guard"();

-- Shared row-level live-actor validation. Trigger arguments name the retained
-- principal and legacy actor columns on the host table. JSON field access lets
-- one closed implementation protect all four authority-bearing tables.
CREATE FUNCTION "public"."RetainedAuditPrincipal_actor_alignment_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  new_row JSONB := pg_catalog.to_jsonb(NEW);
  old_row JSONB;
  organization_id TEXT := new_row ->> 'organizationId';
  principal_id UUID := NULLIF(new_row ->> TG_ARGV[0], '')::UUID;
  actor_id TEXT := new_row ->> TG_ARGV[1];
  old_principal_id UUID;
  old_actor_id TEXT;
BEGIN
  IF principal_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- ON DELETE SET NULL on a legacy actor is the only write allowed after the
  -- live User disappears. Trigger ordering between the User's several FK
  -- actions is unspecified, so the principal may be either live or already
  -- pseudonymized when this child-row update runs.
  IF TG_OP = 'UPDATE' THEN
    old_row := pg_catalog.to_jsonb(OLD);
    old_principal_id := NULLIF(old_row ->> TG_ARGV[0], '')::UUID;
    old_actor_id := old_row ->> TG_ARGV[1];

    IF actor_id IS NULL
       AND old_actor_id IS NOT NULL
       AND principal_id IS NOT DISTINCT FROM old_principal_id
       AND (new_row - TG_ARGV[1]) = (old_row - TG_ARGV[1])
       AND NOT EXISTS (
         SELECT 1
         FROM "public"."User" AS deleted_user
         WHERE deleted_user."id" = old_actor_id
       )
       AND EXISTS (
         SELECT 1
         FROM "public"."RetainedAuditPrincipal" AS principal
         WHERE principal."organizationId" = organization_id
           AND principal."id" = principal_id
           AND (
             (
               principal."liveUserId" = old_actor_id
               AND principal."pseudonymizedAt" IS NULL
             )
             OR
             (
               principal."liveUserId" IS NULL
               AND principal."pseudonymizedAt" IS NOT NULL
             )
           )
       ) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Lock in User -> principal order. That matches account deletion and avoids
  -- a writer/delete deadlock while preserving the live mapping through commit.
  PERFORM 1
  FROM "public"."User" AS live_user
  WHERE live_user."id" = actor_id
  FOR KEY SHARE OF live_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'RetainedAuditPrincipal_actor_alignment_check',
      MESSAGE = 'A retained authority actor must be a live User.';
  END IF;

  PERFORM 1
  FROM "public"."RetainedAuditPrincipal" AS principal
  WHERE principal."organizationId" = organization_id
    AND principal."id" = principal_id
    AND principal."liveUserId" = actor_id
    AND principal."pseudonymizedAt" IS NULL
  FOR SHARE OF principal;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'RetainedAuditPrincipal_actor_alignment_check',
      MESSAGE = 'A retained authority principal must be live, tenant-bound, and map to its legacy actor.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER "WebMcp02_Inbox_retained_actor_alignment_trigger"
BEFORE INSERT OR UPDATE ON "public"."InboxEntry"
FOR EACH ROW
EXECUTE FUNCTION "public"."RetainedAuditPrincipal_actor_alignment_guard"(
  'createdByPrincipalId', 'createdById'
);

CREATE TRIGGER "WebMcp02_Provenance_retained_actor_alignment_trigger"
BEFORE INSERT OR UPDATE ON "public"."ProvenanceRecord"
FOR EACH ROW
EXECUTE FUNCTION "public"."RetainedAuditPrincipal_actor_alignment_guard"(
  'actorPrincipalId', 'actorUserId'
);

CREATE TRIGGER "WebMcp02_Approval_retained_actor_alignment_trigger"
BEFORE INSERT OR UPDATE ON "public"."WebMcpProposalApproval"
FOR EACH ROW
EXECUTE FUNCTION "public"."RetainedAuditPrincipal_actor_alignment_guard"(
  'approvedByPrincipalId', 'approvedById'
);

CREATE TRIGGER "RetainedAuditPrincipal_Audit_actor_alignment_trigger"
BEFORE INSERT OR UPDATE ON "public"."AuditEvent"
FOR EACH ROW
EXECUTE FUNCTION "public"."RetainedAuditPrincipal_actor_alignment_guard"(
  'actorPrincipalId', 'actorUserId'
);

-- Audit events are append-only authority. NULL principal inserts remain legal
-- for rolling old nodes, and a valid principal may backfill a historical row,
-- but established retained authority cannot later be stripped or swapped.
CREATE FUNCTION "public"."RetainedAuditPrincipal_audit_authority_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD."actorPrincipalId" IS NOT NULL
     AND NEW."actorPrincipalId" IS DISTINCT FROM OLD."actorPrincipalId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'AuditEvent_retained_actor_immutable_check',
      MESSAGE = 'Retained AuditEvent actor authority cannot be stripped or replaced.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "RetainedAuditPrincipal_Audit_authority_guard_trigger"
BEFORE UPDATE ON "public"."AuditEvent"
FOR EACH ROW
EXECUTE FUNCTION "public"."RetainedAuditPrincipal_audit_authority_guard"();

-- Preserve the staged proposal's retained creator as immutable identity. An
-- FK-driven legacy actor detachment is permitted only after that User has
-- disappeared; direct identity edits and principal stripping still fail.
CREATE OR REPLACE FUNCTION "public"."WebMcpInboxEntry_identity_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  fk_actor_detachment BOOLEAN := FALSE;
BEGIN
  fk_actor_detachment := (
    OLD."createdById" IS NOT NULL
    AND NEW."createdById" IS NULL
    AND ROW(
      NEW."organizationId", NEW."source", NEW."sourceKey", NEW."dedupeKey",
      NEW."proposedTitle", NEW."proposedYear", NEW."sourceUri", NEW."payload",
      NEW."documentId", NEW."createdByPrincipalId"
    ) IS NOT DISTINCT FROM ROW(
      OLD."organizationId", OLD."source", OLD."sourceKey", OLD."dedupeKey",
      OLD."proposedTitle", OLD."proposedYear", OLD."sourceUri", OLD."payload",
      OLD."documentId", OLD."createdByPrincipalId"
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "public"."User" AS deleted_user
      WHERE deleted_user."id" = OLD."createdById"
    )
  );

  IF OLD."source" = 'WEB_MCP' AND ROW(
    NEW."organizationId", NEW."source", NEW."sourceKey", NEW."dedupeKey",
    NEW."proposedTitle", NEW."proposedYear", NEW."sourceUri", NEW."payload",
    NEW."documentId", NEW."createdById", NEW."createdByPrincipalId"
  ) IS DISTINCT FROM ROW(
    OLD."organizationId", OLD."source", OLD."sourceKey", OLD."dedupeKey",
    OLD."proposedTitle", OLD."proposedYear", OLD."sourceUri", OLD."payload",
    OLD."documentId", OLD."createdById", OLD."createdByPrincipalId"
  ) AND NOT fk_actor_detachment THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpInboxEntry_identity_check',
      MESSAGE = 'A staged WebMCP proposal identity is immutable.';
  END IF;
  IF OLD."source" = 'WEB_MCP'
     AND OLD."status" = 'IMPORTED'
     AND NEW."status" <> 'IMPORTED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpInboxEntry_imported_terminal_check',
      MESSAGE = 'An approved WebMCP proposal cannot leave the imported state.';
  END IF;
  RETURN NEW;
END;
$function$;

-- A staged WEB_MCP provenance row belongs to the Inbox creator principal.
-- Approval-time actor authority is deliberately independent: the reviewer may
-- differ from the stager.
CREATE FUNCTION "public"."RetainedAuditPrincipal_staged_webmcp_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  inbox_principal_id UUID;
BEGIN
  IF NEW."kind" <> 'WEB_MCP' THEN
    RETURN NEW;
  END IF;

  IF NEW."inboxEntryId" IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProvenance_staged_principal_check',
      MESSAGE = 'Staged WebMCP provenance must belong to its WebMCP Inbox.';
  END IF;

  SELECT entry."createdByPrincipalId"
  INTO inbox_principal_id
  FROM "public"."InboxEntry" AS entry
  WHERE entry."organizationId" = NEW."organizationId"
    AND entry."id" = NEW."inboxEntryId"
    AND entry."source" = 'WEB_MCP'
  FOR SHARE OF entry;
  IF NOT FOUND
     OR NEW."actorPrincipalId" IS DISTINCT FROM inbox_principal_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProvenance_staged_principal_check',
      MESSAGE = 'Staged WebMCP provenance must use its Inbox creator principal.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER "WebMcp02_Provenance_staged_principal_trigger"
BEFORE INSERT OR UPDATE ON "public"."ProvenanceRecord"
FOR EACH ROW
EXECUTE FUNCTION "public"."RetainedAuditPrincipal_staged_webmcp_guard"();

-- IMPORT/METADATA provenance linked to an approval must use the reviewer's
-- retained principal, including NULL = NULL for an old-node transaction.
CREATE FUNCTION "public"."RetainedAuditPrincipal_approval_provenance_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  approval_principal_id UUID;
BEGIN
  IF NEW."kind" NOT IN ('IMPORT', 'METADATA')
     OR NEW."inboxEntryId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT approval."approvedByPrincipalId"
  INTO approval_principal_id
  FROM "public"."WebMcpProposalApproval" AS approval
  WHERE approval."organizationId" = NEW."organizationId"
    AND approval."inboxEntryId" = NEW."inboxEntryId"
  FOR SHARE OF approval;
  IF FOUND
     AND NEW."actorPrincipalId" IS DISTINCT FROM approval_principal_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpProvenance_approval_principal_check',
      MESSAGE = 'Approval-bound provenance must use the reviewer retained principal.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER "WebMcp02_Provenance_approval_principal_trigger"
BEFORE INSERT OR UPDATE ON "public"."ProvenanceRecord"
FOR EACH ROW
EXECUTE FUNCTION "public"."RetainedAuditPrincipal_approval_provenance_guard"();

-- Close the reciprocal insertion order: provenance may be inserted before its
-- approval inside a transaction, so approval insertion rechecks any existing
-- IMPORT/METADATA rows without equating the stager and reviewer principals.
CREATE FUNCTION "public"."RetainedAuditPrincipal_approval_actor_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."ProvenanceRecord" AS provenance
    WHERE provenance."organizationId" = NEW."organizationId"
      AND provenance."inboxEntryId" = NEW."inboxEntryId"
      AND provenance."kind" IN ('IMPORT', 'METADATA')
      AND provenance."actorPrincipalId"
            IS DISTINCT FROM NEW."approvedByPrincipalId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'WebMcpApproval_provenance_principal_check',
      MESSAGE = 'A WebMCP approval must match its retained provenance actor principal.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "WebMcp02_Approval_provenance_principal_trigger"
BEFORE INSERT ON "public"."WebMcpProposalApproval"
FOR EACH ROW
EXECUTE FUNCTION "public"."RetainedAuditPrincipal_approval_actor_guard"();
