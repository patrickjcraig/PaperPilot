-- User display names cross the authentication, invitation, and collaboration
-- boundaries. Refuse to certify a release that contains a legacy name the
-- strict browser contract cannot safely render.
BEGIN;

LOCK TABLE
  "public"."User",
  "public"."Organization",
  "public"."Member",
  "public"."Invitation"
IN SHARE ROW EXCLUSIVE MODE;

DO $migration$
DECLARE
  code integer;
  prohibited_characters text := '';
  trim_characters text := '';
  astral_character_pattern text;
BEGIN
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
      ERRCODE = 'check_violation',
      MESSAGE = 'Workspace owner preflight failed.',
      HINT = 'Restore at least one valid owner for every workspace before retrying.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."User" AS app_user
    WHERE app_user."email" <> pg_catalog.lower(pg_catalog.btrim(app_user."email"))
       OR pg_catalog.char_length(app_user."email") NOT BETWEEN 3 AND 254
       OR app_user."email" !~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'User email identity preflight failed.',
      HINT = 'Review every legacy User.email identity before retrying this migration.';
  END IF;

  -- PostgreSQL text cannot contain U+0000. Cover the remaining C0/C1 controls.
  FOR code IN 1..31 LOOP
    prohibited_characters := prohibited_characters || pg_catalog.chr(code);
  END LOOP;
  FOR code IN 127..159 LOOP
    prohibited_characters := prohibited_characters || pg_catalog.chr(code);
  END LOOP;
  FOREACH code IN ARRAY ARRAY[
    1564,       -- U+061C ARABIC LETTER MARK
    8206, 8207, -- U+200E..U+200F directional marks
    8234, 8235, 8236, 8237, 8238, -- U+202A..U+202E bidi embeddings/overrides
    8294, 8295, 8296, 8297,       -- U+2066..U+2069 bidi isolates
    65279       -- U+FEFF byte-order mark / zero-width no-break space
  ] LOOP
    prohibited_characters := prohibited_characters || pg_catalog.chr(code);
  END LOOP;

  -- ECMAScript TrimString whitespace, used by normalizePaperPilotUserName.
  FOREACH code IN ARRAY ARRAY[
    9, 10, 11, 12, 13, 32, 160, 5760,
    8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
    8232, 8233, 8239, 8287, 12288, 65279
  ] LOOP
    trim_characters := trim_characters || pg_catalog.chr(code);
  END LOOP;

  -- JavaScript String#length counts astral code points as two UTF-16 units.
  astral_character_pattern := '['
    || pg_catalog.chr(65536)
    || '-'
    || pg_catalog.chr(1114111)
    || ']';

  IF EXISTS (
    SELECT 1
    FROM "public"."User" AS app_user
    WHERE app_user."name" <> pg_catalog.btrim(app_user."name", trim_characters)
       OR (
         pg_catalog.char_length(app_user."name")
         + pg_catalog.char_length(app_user."name")
         - pg_catalog.char_length(
             pg_catalog.regexp_replace(
               app_user."name",
               astral_character_pattern,
               '',
               'g'
             )
           )
       ) NOT BETWEEN 2 AND 120
       OR pg_catalog.translate(app_user."name", prohibited_characters, '')
          <> app_user."name"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'User display-name policy preflight failed.',
      HINT = 'Review and normalize every legacy User.name before retrying this migration.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "public"."Member"
    GROUP BY "userId"
    HAVING pg_catalog.count(*) > 100
  ) OR EXISTS (
    SELECT 1 FROM "public"."Member"
    GROUP BY "organizationId"
    HAVING pg_catalog.count(*) > 500
  ) OR EXISTS (
    SELECT 1
    FROM "public"."Invitation"
    WHERE "status" = 'pending' AND "expiresAt" > CURRENT_TIMESTAMP
    GROUP BY "organizationId"
    HAVING pg_catalog.count(*) > 100
  ) OR EXISTS (
    SELECT 1
    FROM "public"."Invitation"
    WHERE "status" = 'pending' AND "expiresAt" > CURRENT_TIMESTAMP
    GROUP BY pg_catalog.lower(pg_catalog.btrim("email"))
    HAVING pg_catalog.count(*) > 100
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'program_limit_exceeded',
      MESSAGE = 'Collaboration register cardinality preflight failed.',
      HINT = 'Reduce the affected membership or pending-invitation register before retrying.';
  END IF;

  EXECUTE pg_catalog.format(
    $constraint$
      ALTER TABLE "public"."User"
      ADD CONSTRAINT "User_name_text_policy_check"
      CHECK (
        "name" = pg_catalog.btrim("name", %1$L)
        AND (
          pg_catalog.char_length("name")
          + pg_catalog.char_length("name")
          - pg_catalog.char_length(
              pg_catalog.regexp_replace("name", %2$L, '', 'g')
            )
        ) BETWEEN 2 AND 120
        AND pg_catalog.translate("name", %3$L, '') = "name"
      ),
      ADD CONSTRAINT "User_email_normalized_check"
      CHECK (
        "email" = pg_catalog.lower(pg_catalog.btrim("email"))
        AND pg_catalog.char_length("email") BETWEEN 3 AND 254
        AND "email" ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
      )
    $constraint$,
    trim_characters,
    astral_character_pattern,
    prohibited_characters
  );
END
$migration$;

-- Forward-repair deployments that applied the earlier immediate owner guard:
-- serialize concurrent owner changes on the parent Organization row before
-- deciding whether another owner remains.
CREATE OR REPLACE FUNCTION "public"."Workspace_owner_integrity_guard"()
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

COMMENT ON CONSTRAINT "User_name_text_policy_check" ON "public"."User" IS
  'Canonical 2-120 UTF-16-unit PaperPilot display name without control or bidirectional formatting characters.';

COMMENT ON CONSTRAINT "User_email_normalized_check" ON "public"."User" IS
  'Canonical lower-case PaperPilot login identity without surrounding whitespace.';

COMMIT;
