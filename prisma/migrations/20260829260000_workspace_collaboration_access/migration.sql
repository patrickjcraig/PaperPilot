-- PaperPilot-owned workspace collaboration authority. Generic organization
-- plugin mutations are closed at the HTTP boundary; these constraints make
-- the persisted role and invitation vocabulary equally closed.

BEGIN;

LOCK TABLE
  "public"."User",
  "public"."Organization",
  "public"."Member",
  "public"."Invitation"
IN SHARE ROW EXCLUSIVE MODE;

-- Refuse to infer authority from dirty legacy values. In particular, a NULL
-- invitation role must not silently become a membership grant.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."Member"
    WHERE "role" NOT IN ('owner', 'admin', 'member', 'viewer')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot install collaboration access over an unsupported Member role.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "public"."Invitation"
    WHERE "role" IS NULL
       OR "role" NOT IN ('admin', 'member', 'viewer')
       OR "status" NOT IN ('pending', 'accepted', 'rejected', 'canceled')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot install collaboration access over an ambiguous Invitation role or status.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."User" AS candidate
    JOIN "public"."User" AS duplicate
      ON candidate."id" < duplicate."id"
     AND pg_catalog.lower(pg_catalog.btrim(candidate."email"))
           = pg_catalog.lower(pg_catalog.btrim(duplicate."email"))
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'Cannot install collaboration access while User emails differ only by case or surrounding whitespace.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."Invitation" AS invitation
    WHERE pg_catalog.char_length(pg_catalog.btrim(invitation."email")) NOT BETWEEN 3 AND 254
       OR pg_catalog.btrim(invitation."email") !~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot install collaboration access over an invalid Invitation recipient email.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."Invitation"
    WHERE "status" = 'pending'
    GROUP BY "organizationId", pg_catalog.lower(pg_catalog.btrim("email"))
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'Cannot install collaboration access while a recipient has duplicate pending workspace invitations.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."Organization" AS organization
    WHERE NOT EXISTS (
        SELECT 1
        FROM "public"."Member" AS workspace_owner
        WHERE workspace_owner."organizationId" = organization."id"
          AND workspace_owner."role" = 'owner'
      )
      OR (
        organization."personalOwnerId" IS NOT NULL
        AND NOT EXISTS (
        SELECT 1
        FROM "public"."Member" AS personal_owner
        WHERE personal_owner."organizationId" = organization."id"
          AND personal_owner."userId" = organization."personalOwnerId"
          AND personal_owner."role" = 'owner'
      )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot install collaboration access while a workspace has no valid owner.';
  END IF;
END;
$$;

UPDATE "public"."Invitation"
SET "email" = pg_catalog.lower(pg_catalog.btrim("email"));

ALTER TABLE "public"."Member"
  ADD CONSTRAINT "Member_role_check"
  CHECK ("role" IN ('owner', 'admin', 'member', 'viewer'));

ALTER TABLE "public"."Invitation"
  ALTER COLUMN "role" DROP DEFAULT,
  ALTER COLUMN "role" SET NOT NULL,
  ADD CONSTRAINT "Invitation_role_check"
    CHECK ("role" IN ('admin', 'member', 'viewer')),
  ADD CONSTRAINT "Invitation_status_check"
    CHECK ("status" IN ('pending', 'accepted', 'rejected', 'canceled')),
  ADD CONSTRAINT "Invitation_email_normalized_check"
    CHECK (
      "email" = pg_catalog.lower(pg_catalog.btrim("email"))
      AND pg_catalog.char_length("email") BETWEEN 3 AND 254
      AND "email" ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
    ),
  ADD CONSTRAINT "Invitation_expiry_check"
    CHECK ("expiresAt" > "createdAt");

CREATE UNIQUE INDEX "User_email_normalized_key"
  ON "public"."User" (pg_catalog.lower(pg_catalog.btrim("email")));

CREATE UNIQUE INDEX "Invitation_pending_recipient_key"
  ON "public"."Invitation" (
    "organizationId",
    pg_catalog.lower(pg_catalog.btrim("email"))
  )
  WHERE "status" = 'pending';

CREATE INDEX "Invitation_organizationId_email_status_idx"
  ON "public"."Invitation"("organizationId", "email", "status");

-- Invitation authority is immutable after creation and every terminal state
-- is one-way. Organization/User cascades may still delete rows normally.
CREATE FUNCTION "public"."Invitation_collaboration_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'pending' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'Invitation_initial_status_check',
        MESSAGE = 'A workspace invitation must begin pending.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."email" IS DISTINCT FROM OLD."email"
     OR NEW."role" IS DISTINCT FROM OLD."role"
     OR NEW."teamId" IS DISTINCT FROM OLD."teamId"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."inviterId" IS DISTINCT FROM OLD."inviterId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'Invitation_authority_immutable_check',
      MESSAGE = 'Workspace invitation authority is immutable.';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (
       OLD."status" = 'pending'
       AND NEW."status" IN ('accepted', 'rejected', 'canceled')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'Invitation_status_transition_check',
      MESSAGE = 'Workspace invitation terminal state is immutable.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "Invitation_collaboration_guard_trigger"
BEFORE INSERT OR UPDATE ON "public"."Invitation"
FOR EACH ROW
EXECUTE FUNCTION "public"."Invitation_collaboration_guard"();

-- A personal workspace identity cannot be reassigned. Deleting the entire
-- organization remains valid because this guard only observes updates.
CREATE FUNCTION "public"."Organization_personal_owner_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW."personalOwnerId" IS DISTINCT FROM OLD."personalOwnerId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'Organization_personal_owner_immutable_check',
      MESSAGE = 'A personal workspace owner identity cannot be transferred.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "Organization_personal_owner_immutable_guard_trigger"
BEFORE UPDATE OF "personalOwnerId" ON "public"."Organization"
FOR EACH ROW
EXECUTE FUNCTION "public"."Organization_personal_owner_immutable_guard"();

-- is compatible with Prisma Dev/PGlite as well as PostgreSQL and still lets a
-- whole Organization cascade away: by the time its Member cascade runs, the
-- parent row is no longer visible to this trigger. Shared-workspace creation
-- may install its initial owner in a later statement, while every removal or
-- demotion of an existing owner is checked synchronously.
-- Protect persisted owners on the Member write itself. Locking the parent
-- serializes concurrent owner demotions/removals before checking the remaining
-- owners. The whole migration is transaction-wrapped, so its opening table
-- lock covers the preflight, constraints, functions, and final triggers.
-- is compatible with Prisma Dev/PGlite as well as PostgreSQL and still lets a
-- whole Organization cascade away: by the time its Member cascade runs, the
-- parent row is no longer visible to this trigger. Shared-workspace creation
-- may install its initial owner in a later statement, while every removal or
-- demotion of an existing owner is checked synchronously.
CREATE FUNCTION "public"."Workspace_owner_integrity_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  personal_owner_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
       OR NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'Member_identity_immutable_check',
      MESSAGE = 'Workspace membership identity is immutable.';
  END IF;

  IF OLD."role" <> 'owner'
     OR (TG_OP = 'UPDATE' AND NEW."role" = 'owner') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT organization."personalOwnerId"
    INTO personal_owner_id
  FROM "public"."Organization" AS organization
  WHERE organization."id" = OLD."organizationId"
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF personal_owner_id = OLD."userId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'Workspace_personal_owner_check',
      MESSAGE = 'A personal workspace must retain its designated owner membership.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "public"."Member" AS other_owner
    WHERE other_owner."organizationId" = OLD."organizationId"
      AND other_owner."role" = 'owner'
      AND other_owner."id" <> OLD."id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'Workspace_last_owner_check',
      MESSAGE = 'A workspace must retain at least one owner.';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE TRIGGER "Member_owner_integrity_guard_trigger"
BEFORE UPDATE OR DELETE ON "public"."Member"
FOR EACH ROW
EXECUTE FUNCTION "public"."Workspace_owner_integrity_guard"();

COMMIT;
