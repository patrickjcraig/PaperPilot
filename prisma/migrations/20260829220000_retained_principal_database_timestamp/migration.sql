-- Prisma materializes @default(now()) in its INSERT statement, so the runtime
-- role needs column-level INSERT on createdAt. Make that grant non-authoritative:
-- the database overwrites every submitted value before the lifecycle guard sees
-- the row. Trigger names execute alphabetically, and 00 therefore precedes the
-- RetainedAuditPrincipal immutability trigger installed in the prior migration.
CREATE FUNCTION "public"."RetainedAuditPrincipal_database_timestamp_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  NEW."createdAt" := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "RetainedAuditPrincipal_00_database_timestamp_trigger"
BEFORE INSERT ON "public"."RetainedAuditPrincipal"
FOR EACH ROW
EXECUTE FUNCTION "public"."RetainedAuditPrincipal_database_timestamp_guard"();
