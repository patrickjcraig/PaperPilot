-- Retained timestamps are TIMESTAMP WITHOUT TIME ZONE for Prisma compatibility.
-- Cast the authoritative clock through UTC explicitly so a runtime session's
-- mutable TimeZone setting cannot shift the stored wall-clock value.
CREATE OR REPLACE FUNCTION "public"."RetainedAuditPrincipal_database_timestamp_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.clock_timestamp());
  RETURN NEW;
END;
$function$;

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

    NEW."pseudonymizedAt" := pg_catalog.timezone(
      'UTC',
      pg_catalog.clock_timestamp()
    );
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'RetainedAuditPrincipal_rewrite_check',
    MESSAGE = 'Retained audit principal cannot be rebound or rewritten.';
END;
$function$;
