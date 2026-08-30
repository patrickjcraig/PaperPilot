\set ON_ERROR_STOP on

-- Run once per dedicated PaperPilot PostgreSQL cluster as its provider
-- administrator. PostgreSQL roles are cluster-wide; refusing a shared cluster
-- prevents one environment's credential from becoming valid in another.
-- The runtime role is intentionally born without a password. Provision its
-- password, certificate, or IAM binding out-of-band through the secret manager.
BEGIN;

-- PostgreSQL 16+ automatically grants a non-superuser CREATEROLE principal an
-- ADMIN membership in every role it creates. That bootstrap-superuser grant
-- cannot be removed by the creating principal, so it is incompatible with the
-- zero-persistent-membership contract below. Fail before CREATE ROLE rather
-- than leaving a provider administrator able to administer runtime or owner.
DO $bootstrap_authority$
DECLARE
  server_version_number integer := current_setting('server_version_num')::integer;
  bootstrap_is_superuser boolean := coalesce((
    SELECT role.rolsuper
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname = current_user
  ), false);
BEGIN
  IF server_version_number >= 160000 AND NOT bootstrap_is_superuser THEN
    RAISE EXCEPTION
      'PostgreSQL 16+ PaperPilot bootstrap requires a true superuser so role creation cannot leave non-revocable automatic ADMIN memberships';
  END IF;
END
$bootstrap_authority$;

DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'paperpilot_migration_owner') THEN
    CREATE ROLE paperpilot_migration_owner;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'paperpilot_runtime') THEN
    CREATE ROLE paperpilot_runtime LOGIN;
  END IF;
END
$bootstrap$;

ALTER ROLE paperpilot_migration_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE paperpilot_runtime
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- This bootstrap is safe for a fresh database and idempotent after every
-- application object is already owned by the fixed migration role. It must not
-- silently adopt a legacy schema: ownership transfer is an authority change
-- that requires its own exact, reviewed inventory.
DO $existing_ownership_guard$
DECLARE
  wrong_objects text[];
BEGIN
  SELECT array_agg(object_identity ORDER BY object_identity)
  INTO wrong_objects
  FROM (
    SELECT format('%s %I.%I',
      CASE relation.relkind
        WHEN 'S' THEN 'sequence'
        WHEN 'v' THEN 'view'
        WHEN 'm' THEN 'materialized view'
        ELSE 'table'
      END,
      namespace.nspname,
      relation.relname
    ) AS object_identity
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = relation.relowner
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
      AND owner_role.rolname <> 'paperpilot_migration_owner'
    UNION ALL
    SELECT format('function %I.%I(%s)',
      namespace.nspname,
      routine.proname,
      pg_catalog.oidvectortypes(routine.proargtypes)
    )
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = routine.proowner
    WHERE namespace.nspname = 'public'
      AND owner_role.rolname <> 'paperpilot_migration_owner'
    UNION ALL
    SELECT format('type %I.%I', namespace.nspname, type_definition.typname)
    FROM pg_catalog.pg_type AS type_definition
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_definition.typnamespace
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = type_definition.typowner
    WHERE namespace.nspname = 'public'
      AND type_definition.typisdefined
      AND owner_role.rolname <> 'paperpilot_migration_owner'
  ) AS legacy_object;

  IF coalesce(cardinality(wrong_objects), 0) > 0 THEN
    RAISE EXCEPTION
      'Refusing implicit ownership adoption. Use a fresh PaperPilot database or an exact reviewed conversion plan. Wrongly owned objects: %',
      wrong_objects;
  END IF;
END
$existing_ownership_guard$;

-- Remove stale availability/security settings from reused fixed roles and from
-- every database-specific override before asserting the two reviewed global
-- settings. Migrations need public first so unqualified CREATE targets the
-- closed application schema; runtime lookup keeps pg_catalog first.
ALTER ROLE paperpilot_migration_owner RESET ALL;
ALTER ROLE paperpilot_runtime RESET ALL;
DO $database_role_settings_reset$
DECLARE
  database_name text;
BEGIN
  FOR database_name IN
    SELECT datname FROM pg_catalog.pg_database
  LOOP
    EXECUTE format(
      'ALTER ROLE paperpilot_migration_owner IN DATABASE %I RESET ALL',
      database_name
    );
    EXECUTE format(
      'ALTER ROLE paperpilot_runtime IN DATABASE %I RESET ALL',
      database_name
    );
  END LOOP;
END
$database_role_settings_reset$;

ALTER ROLE paperpilot_migration_owner SET search_path = public, pg_catalog;
ALTER ROLE paperpilot_migration_owner SET row_security = on;
ALTER ROLE paperpilot_runtime SET search_path = pg_catalog, public;
ALTER ROLE paperpilot_runtime SET row_security = on;

-- A runtime credential must never be able to SET ROLE into the object owner.
REVOKE paperpilot_migration_owner FROM paperpilot_runtime;

DO $dedicated_cluster_guard$
DECLARE
  unexpected_databases text[];
BEGIN
  IF current_database() = 'postgres'
     OR current_database() LIKE 'template%' THEN
    RAISE EXCEPTION
      'PaperPilot must use its own database, not the postgres/template maintenance databases';
  END IF;

  SELECT array_agg(database.datname ORDER BY database.datname)
  INTO unexpected_databases
  FROM pg_catalog.pg_database AS database
  WHERE NOT database.datistemplate
    AND database.datname <> current_database()
    AND database.datname <> 'postgres';

  IF coalesce(cardinality(unexpected_databases), 0) > 0 THEN
    RAISE EXCEPTION
      'PaperPilot requires a dedicated cluster. Unexpected peer databases: %',
      unexpected_databases;
  END IF;
END
$dedicated_cluster_guard$;

DO $database_privileges$
DECLARE
  database_name text;
  stale_grantee record;
  grantee_clause text;
BEGIN
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC',
    current_database()
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I',
    current_database(),
    'paperpilot_runtime'
  );
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO %I',
    current_database(),
    'paperpilot_runtime'
  );

  -- Remove every direct current-database grantee except the database owner and
  -- the exact runtime CONNECT role. An idempotent bootstrap must not preserve
  -- a historical observer/writer through the migration window.
  FOR stale_grantee IN
    SELECT DISTINCT expanded.grantee AS grantee_oid,
           grantee.rolname AS grantee_name
    FROM pg_catalog.pg_database AS database
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(database.datacl, pg_catalog.acldefault('d', database.datdba))
    ) AS expanded
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
    WHERE database.datname = current_database()
      AND expanded.grantee <> database.datdba
      AND expanded.grantee <> (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'paperpilot_runtime'
      )
  LOOP
    IF stale_grantee.grantee_oid = 0 THEN
      grantee_clause := 'PUBLIC';
    ELSIF stale_grantee.grantee_name IS NOT NULL THEN
      grantee_clause := format('%I', stale_grantee.grantee_name);
    ELSE
      RAISE EXCEPTION 'Database ACL references missing role OID %', stale_grantee.grantee_oid;
    END IF;
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %s',
      current_database(),
      grantee_clause
    );
  END LOOP;

  -- Close every other connectable database in this dedicated cluster. This is
  -- essential because PUBLIC CONNECT/TEMP defaults are cluster-spanning attack
  -- surfaces for the fixed runtime login.
  FOR database_name IN
    SELECT database.datname
    FROM pg_catalog.pg_database AS database
    WHERE database.datname <> current_database()
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC',
      database_name
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I',
      database_name,
      'paperpilot_runtime'
    );
  END LOOP;
END
$database_privileges$;

-- PostgreSQL 15 permits a sufficiently privileged provider administrator here;
-- PostgreSQL 16+ was required above to be a true superuser. Membership is
-- needed before ownership work as the NOLOGIN migration owner. The transaction
-- removes every bootstrap membership edge at the end.
GRANT paperpilot_migration_owner TO CURRENT_USER;

ALTER SCHEMA public OWNER TO paperpilot_migration_owner;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM paperpilot_runtime;
GRANT USAGE ON SCHEMA public TO paperpilot_runtime;

DO $schema_privileges$
DECLARE
  stale_grantee record;
  grantee_clause text;
BEGIN
  FOR stale_grantee IN
    SELECT DISTINCT expanded.grantee AS grantee_oid,
           grantee.rolname AS grantee_name
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) AS expanded
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
    WHERE namespace.nspname = 'public'
      AND expanded.grantee <> namespace.nspowner
      AND expanded.grantee <> (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'paperpilot_runtime'
      )
  LOOP
    IF stale_grantee.grantee_oid = 0 THEN
      grantee_clause := 'PUBLIC';
    ELSIF stale_grantee.grantee_name IS NOT NULL THEN
      grantee_clause := format('%I', stale_grantee.grantee_name);
    ELSE
      RAISE EXCEPTION 'Schema ACL references missing role OID %', stale_grantee.grantee_oid;
    END IF;
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SCHEMA public FROM %s',
      grantee_clause
    );
  END LOOP;
END
$schema_privileges$;

-- PostgreSQL 15+ can delegate SET or ALTER SYSTEM on individual parameters.
-- Fixed roles are deliberately reusable, so reconcile every stale explicit
-- parameter ACL rather than checking only the best-known trigger bypass knob.
DO $parameter_privileges$
DECLARE
  parameter_name text;
BEGIN
  FOR parameter_name IN
    SELECT DISTINCT parameter.parname
    FROM pg_catalog.pg_parameter_acl AS parameter
    CROSS JOIN LATERAL pg_catalog.aclexplode(parameter.paracl) AS expanded
    WHERE expanded.grantee = 0
       OR expanded.grantee IN (
         SELECT role.oid
         FROM pg_catalog.pg_roles AS role
         WHERE role.rolname IN ('paperpilot_migration_owner', 'paperpilot_runtime')
       )
    ORDER BY parameter.parname COLLATE "C"
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON PARAMETER %I FROM PUBLIC, paperpilot_migration_owner, paperpilot_runtime',
      parameter_name
    );
  END LOOP;
END
$parameter_privileges$;

-- Keep the critical trigger-control denial explicit even on a fresh cluster
-- with no pg_parameter_acl row yet.
REVOKE SET ON PARAMETER session_replication_role FROM PUBLIC;
REVOKE SET ON PARAMETER session_replication_role FROM paperpilot_runtime;
REVOKE ALTER SYSTEM ON PARAMETER session_replication_role FROM PUBLIC;
REVOKE ALTER SYSTEM ON PARAMETER session_replication_role FROM paperpilot_runtime;

-- Database/schema CREATE denial alone does not stop PostgreSQL large objects:
-- these PUBLIC-executable pg_catalog routines can create caller-owned objects.
-- PaperPilot uses bytea/text columns and private object storage, never LOs.
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_creat(integer)
  FROM PUBLIC, paperpilot_runtime;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid)
  FROM PUBLIC, paperpilot_runtime;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_from_bytea(oid, bytea)
  FROM PUBLIC, paperpilot_runtime;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_import(text)
  FROM PUBLIC, paperpilot_runtime;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_import(text, oid)
  FROM PUBLIC, paperpilot_runtime;

-- Default ACLs belong to the object-creating role. The bootstrap principal is
-- a member only for this transaction and is removed again before commit.
SET LOCAL ROLE paperpilot_migration_owner;

-- These must be owner-global defaults. A per-schema REVOKE cannot subtract
-- PostgreSQL's built-in global PUBLIC EXECUTE/USAGE defaults for new functions
-- and types.
ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE USAGE ON TYPES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TABLES FROM paperpilot_runtime;
ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON SEQUENCES FROM paperpilot_runtime;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM paperpilot_runtime;
ALTER DEFAULT PRIVILEGES REVOKE USAGE ON TYPES FROM paperpilot_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE ON TYPES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM paperpilot_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM paperpilot_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM paperpilot_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE ON TYPES FROM paperpilot_runtime;

-- A role can retain default grants to arbitrary third parties from an earlier
-- use. Revoke every non-owner entry, not only the two familiar grantees above.
-- Otherwise the next migration can expose a new object before the post-migrate
-- reconciler notices the resulting direct ACL.
DO $default_acl_reconciliation$
DECLARE
  default_grant record;
  object_class text;
  schema_clause text;
  grantee_clause text;
BEGIN
  FOR default_grant IN
    SELECT defaults.defaclobjtype AS object_type,
           namespace.nspname AS schema_name,
           expanded.grantee AS grantee_oid,
           grantee.rolname AS grantee_name
    FROM pg_catalog.pg_default_acl AS defaults
    LEFT JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = defaults.defaclnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS expanded
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
    WHERE defaults.defaclrole = (
      SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user
    )
      AND expanded.grantee <> defaults.defaclrole
  LOOP
    object_class := CASE default_grant.object_type
      WHEN 'r' THEN 'TABLES'
      WHEN 'S' THEN 'SEQUENCES'
      WHEN 'f' THEN 'FUNCTIONS'
      WHEN 'T' THEN 'TYPES'
      WHEN 'n' THEN 'SCHEMAS'
      ELSE NULL
    END;
    IF object_class IS NULL THEN
      RAISE EXCEPTION
        'Unsupported migration-owner default ACL object type: %',
        default_grant.object_type;
    END IF;
    IF default_grant.grantee_oid = 0 THEN
      grantee_clause := 'PUBLIC';
    ELSIF default_grant.grantee_name IS NOT NULL THEN
      grantee_clause := format('%I', default_grant.grantee_name);
    ELSE
      RAISE EXCEPTION
        'Migration-owner default ACL references missing role OID %',
        default_grant.grantee_oid;
    END IF;
    IF default_grant.schema_name IS NULL THEN
      schema_clause := '';
    ELSIF default_grant.object_type = 'n' THEN
      RAISE EXCEPTION 'Schema default ACLs cannot be scoped inside another schema';
    ELSE
      schema_clause := format(' IN SCHEMA %I', default_grant.schema_name);
    END IF;
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES%s REVOKE ALL PRIVILEGES ON %s FROM %s',
      schema_clause,
      object_class,
      grantee_clause
    );
  END LOOP;
END
$default_acl_reconciliation$;

DO $default_acl_exact_guard$
DECLARE
  unexpected_default_grants text[];
BEGIN
  WITH owner_role AS (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user
  ), requested(object_type) AS (
    VALUES ('r'::"char"), ('S'::"char"), ('f'::"char"),
           ('T'::"char"), ('n'::"char")
  ), unexpected AS (
    SELECT format(
      '<global>:%s=>%s:%s%s',
      requested.object_type,
      coalesce(grantee.rolname, 'PUBLIC'),
      expanded.privilege_type,
      CASE WHEN expanded.is_grantable THEN '*' ELSE '' END
    ) AS grant_identity
    FROM requested
    CROSS JOIN owner_role
    LEFT JOIN pg_catalog.pg_default_acl AS defaults
      ON defaults.defaclrole = owner_role.oid
     AND defaults.defaclnamespace = 0
     AND defaults.defaclobjtype = requested.object_type
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(
        defaults.defaclacl,
        pg_catalog.acldefault(requested.object_type, owner_role.oid)
      )
    ) AS expanded
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
    WHERE expanded.grantee <> owner_role.oid
    UNION ALL
    SELECT format(
      '%I:%s=>%s:%s%s',
      namespace.nspname,
      defaults.defaclobjtype,
      coalesce(grantee.rolname, 'PUBLIC'),
      expanded.privilege_type,
      CASE WHEN expanded.is_grantable THEN '*' ELSE '' END
    )
    FROM pg_catalog.pg_default_acl AS defaults
    JOIN owner_role ON owner_role.oid = defaults.defaclrole
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = defaults.defaclnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS expanded
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
    WHERE expanded.grantee <> owner_role.oid
  )
  SELECT array_agg(grant_identity ORDER BY grant_identity)
  INTO unexpected_default_grants
  FROM unexpected;

  IF coalesce(cardinality(unexpected_default_grants), 0) > 0 THEN
    RAISE EXCEPTION
      'Migration-owner default ACLs must be exact owner-only: %',
      unexpected_default_grants;
  END IF;
END
$default_acl_exact_guard$;

RESET ROLE;
REVOKE paperpilot_migration_owner FROM CURRENT_USER;
REVOKE paperpilot_runtime FROM CURRENT_USER;

DO $membership_guard$
DECLARE
  owner_oid oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'paperpilot_migration_owner');
  runtime_oid oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'paperpilot_runtime');
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members
    WHERE member IN (owner_oid, runtime_oid)
  ) THEN
    RAISE EXCEPTION 'PaperPilot owner/runtime roles must not inherit or SET ROLE into any other role';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members
    WHERE roleid IN (owner_oid, runtime_oid)
  ) THEN
    RAISE EXCEPTION 'Remove persistent members of PaperPilot owner/runtime roles before completing bootstrap';
  END IF;
END
$membership_guard$;

COMMIT;
