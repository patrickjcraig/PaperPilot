\set ON_ERROR_STOP on

-- Run through the exact connection that `prisma migrate deploy` will use,
-- immediately before every migration release. This script is deliberately
-- read-only: it proves that the connection is already the fixed owner and that
-- no inherited default ACL can expose objects created by the next migration.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';

DO $migration_preflight$
DECLARE
  owner_role CONSTANT text := 'paperpilot_migration_owner';
  unexpected_default_grants text[];
  unexpected_database_grants text[];
  unexpected_schema_grants text[];
  runtime_database_privileges text[];
  deploy_database_privileges text[];
  runtime_schema_privileges text[];
  unsafe_membership_options boolean;
  public_schema_owner text;
BEGIN
  IF current_user <> owner_role THEN
    RAISE EXCEPTION
      'Migration connection must begin as %, got %',
      owner_role,
      current_user;
  END IF;

  IF session_user = current_user OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS deploy_login
    WHERE deploy_login.rolname = session_user
      AND deploy_login.rolcanlogin
      AND NOT deploy_login.rolsuper
      AND NOT deploy_login.rolinherit
      AND NOT deploy_login.rolcreaterole
      AND NOT deploy_login.rolcreatedb
      AND NOT deploy_login.rolreplication
      AND NOT deploy_login.rolbypassrls
  ) THEN
    RAISE EXCEPTION
      'Session user % must be a separate LOGIN, NOSUPERUSER, NOINHERIT, NOCREATEROLE, NOCREATEDB, NOREPLICATION, NOBYPASSRLS deploy role',
      session_user;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS owner
    CROSS JOIN pg_catalog.pg_roles AS runtime
    WHERE owner.rolname = owner_role
      AND NOT owner.rolcanlogin
      AND NOT owner.rolsuper
      AND NOT owner.rolinherit
      AND NOT owner.rolcreaterole
      AND NOT owner.rolcreatedb
      AND NOT owner.rolreplication
      AND NOT owner.rolbypassrls
      AND runtime.rolname = 'paperpilot_runtime'
      AND runtime.rolcanlogin
      AND NOT runtime.rolsuper
      AND NOT runtime.rolinherit
      AND NOT runtime.rolcreaterole
      AND NOT runtime.rolcreatedb
      AND NOT runtime.rolreplication
      AND NOT runtime.rolbypassrls
  ) THEN
    RAISE EXCEPTION
      'PaperPilot migration-owner/runtime role attributes are missing or overpowered';
  END IF;

  IF (
    SELECT coalesce(
      array_agg(granted.rolname ORDER BY granted.rolname COLLATE "C"),
      ARRAY[]::text[]
    )
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
    WHERE member.rolname = session_user
  ) IS DISTINCT FROM ARRAY[owner_role]::text[]
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
       WHERE member.rolname = session_user
         AND membership.admin_option
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
       WHERE granted.rolname = session_user
     ) THEN
    RAISE EXCEPTION
      'Deploy login % must have only one outbound, non-admin membership edge to % and no members of its own',
      session_user,
      owner_role;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
    WHERE (
      granted.rolname IN (owner_role, 'paperpilot_runtime', session_user)
      OR member.rolname IN (owner_role, 'paperpilot_runtime', session_user)
    )
      AND NOT (
        granted.rolname = owner_role
        AND member.rolname = session_user
        AND NOT membership.admin_option
      )
  ) THEN
    RAISE EXCEPTION
      'The sole membership touching deploy, migration-owner, or runtime must be deploy -> migration-owner without ADMIN';
  END IF;

  IF current_setting('server_version_num')::integer >= 160000 THEN
    EXECUTE $membership_options$
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS membership
        JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
        JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
        WHERE member.rolname = $1
          AND granted.rolname = $2
          AND (
            membership.admin_option
            OR membership.inherit_option
            OR NOT membership.set_option
          )
      )
    $membership_options$
    INTO STRICT unsafe_membership_options
    USING session_user, owner_role;
    IF unsafe_membership_options THEN
      RAISE EXCEPTION
        'Deploy login % owner membership must be SET TRUE, INHERIT FALSE, ADMIN FALSE',
        session_user;
    END IF;
  END IF;

  IF pg_catalog.regexp_replace(
       pg_catalog.replace(current_setting('search_path'), '"', ''),
       '\s',
       '',
       'g'
     ) <> 'public,pg_catalog' THEN
    RAISE EXCEPTION
      'Migration connection must use exact search_path public, pg_catalog; got %',
      current_setting('search_path');
  END IF;

  IF current_setting('row_security') <> 'on' THEN
    RAISE EXCEPTION
      'Migration connection must keep row_security on; got %',
      current_setting('row_security');
  END IF;

  IF current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION
      'Migration connection must use session_replication_role origin; got %',
      current_setting('session_replication_role');
  END IF;

  IF current_setting('check_function_bodies') <> 'on' THEN
    RAISE EXCEPTION
      'Migration connection must keep check_function_bodies on; got %',
      current_setting('check_function_bodies');
  END IF;

  IF current_database() = 'postgres' OR current_database() LIKE 'template%' THEN
    RAISE EXCEPTION 'Migration connection targets a maintenance database: %', current_database();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS owner
    WHERE owner.rolname = owner_role
      AND cardinality(coalesce(owner.rolconfig, ARRAY[]::text[])) = 2
      AND 'row_security=on' = ANY(owner.rolconfig)
      AND EXISTS (
        SELECT 1
        FROM unnest(owner.rolconfig) AS setting
        WHERE setting LIKE 'search_path=%'
          AND pg_catalog.regexp_replace(
            pg_catalog.replace(substr(setting, 13), '"', ''),
            '\s',
            '',
            'g'
          ) = 'public,pg_catalog'
      )
  ) THEN
    RAISE EXCEPTION 'Migration owner has stale or incomplete global role settings';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS runtime
    WHERE runtime.rolname = 'paperpilot_runtime'
      AND cardinality(coalesce(runtime.rolconfig, ARRAY[]::text[])) = 2
      AND 'row_security=on' = ANY(runtime.rolconfig)
      AND EXISTS (
        SELECT 1
        FROM unnest(runtime.rolconfig) AS setting
        WHERE setting LIKE 'search_path=%'
          AND pg_catalog.regexp_replace(
            pg_catalog.replace(substr(setting, 13), '"', ''),
            '\s',
            '',
            'g'
          ) = 'pg_catalog,public'
      )
  ) THEN
    RAISE EXCEPTION 'Runtime has stale or incomplete global role settings';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting AS role_setting
    WHERE role_setting.setdatabase <> 0
      AND role_setting.setrole IN (
      SELECT oid
      FROM pg_catalog.pg_roles
      WHERE rolname IN ('paperpilot_migration_owner', 'paperpilot_runtime')
    )
  ) THEN
    RAISE EXCEPTION 'PaperPilot fixed roles must have no database-specific settings';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_parameter_acl AS parameter
    CROSS JOIN LATERAL pg_catalog.aclexplode(parameter.paracl) AS expanded
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
    WHERE expanded.grantee = 0
       OR grantee.rolname IN (owner_role, 'paperpilot_runtime')
  ) THEN
    RAISE EXCEPTION
      'PUBLIC and PaperPilot fixed roles must have no explicit parameter privileges';
  END IF;

  SELECT schema_owner
  INTO public_schema_owner
  FROM information_schema.schemata
  WHERE schema_name = 'public';
  IF public_schema_owner IS DISTINCT FROM owner_role THEN
    RAISE EXCEPTION
      'public schema must be owned by %, got %',
      owner_role,
      coalesce(public_schema_owner, '<missing>');
  END IF;

  WITH acl AS (
    SELECT database_owner.rolname AS owner_name,
           coalesce(grantee.rolname, 'PUBLIC') AS grantee_name,
           expanded.privilege_type,
           expanded.is_grantable
    FROM pg_catalog.pg_database AS database
    JOIN pg_catalog.pg_roles AS database_owner ON database_owner.oid = database.datdba
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(database.datacl, pg_catalog.acldefault('d', database.datdba))
    ) AS expanded
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
    WHERE database.datname = current_database()
  )
  SELECT array_agg(
           format('%s:%s%s', grantee_name, privilege_type,
             CASE WHEN is_grantable THEN '*' ELSE '' END)
           ORDER BY grantee_name, privilege_type
         ) FILTER (
           WHERE grantee_name = 'PUBLIC'
              OR grantee_name NOT IN (owner_name, 'paperpilot_runtime', session_user)
              OR (grantee_name <> owner_name AND is_grantable)
              OR (grantee_name = 'paperpilot_runtime' AND privilege_type <> 'CONNECT')
              OR (
                grantee_name = session_user
                AND grantee_name <> owner_name
                AND privilege_type <> 'CONNECT'
              )
         ),
         array_agg(privilege_type ORDER BY privilege_type)
           FILTER (WHERE grantee_name = 'paperpilot_runtime'),
         array_agg(privilege_type ORDER BY privilege_type)
           FILTER (WHERE grantee_name = session_user)
  INTO unexpected_database_grants, runtime_database_privileges,
       deploy_database_privileges
  FROM acl;

  IF coalesce(cardinality(unexpected_database_grants), 0) > 0
     OR runtime_database_privileges IS DISTINCT FROM ARRAY['CONNECT']::text[]
     OR deploy_database_privileges IS DISTINCT FROM ARRAY['CONNECT']::text[] THEN
    RAISE EXCEPTION
      'Application database ACL is not closed for migration: unexpected %, runtime %, deploy %',
      unexpected_database_grants,
      runtime_database_privileges,
      deploy_database_privileges;
  END IF;

  WITH acl AS (
    SELECT owner.rolname AS owner_name,
           coalesce(grantee.rolname, 'PUBLIC') AS grantee_name,
           expanded.privilege_type,
           expanded.is_grantable
    FROM pg_catalog.pg_namespace AS namespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) AS expanded
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
    WHERE namespace.nspname = 'public'
  )
  SELECT array_agg(
           format('%s:%s%s', grantee_name, privilege_type,
             CASE WHEN is_grantable THEN '*' ELSE '' END)
           ORDER BY grantee_name, privilege_type
         ) FILTER (
           WHERE grantee_name NOT IN (owner_name, 'paperpilot_runtime')
              OR (grantee_name <> owner_name AND is_grantable)
              OR (grantee_name = 'paperpilot_runtime' AND privilege_type <> 'USAGE')
         ),
         array_agg(privilege_type ORDER BY privilege_type)
           FILTER (WHERE grantee_name = 'paperpilot_runtime')
  INTO unexpected_schema_grants, runtime_schema_privileges
  FROM acl;

  IF coalesce(cardinality(unexpected_schema_grants), 0) > 0
     OR runtime_schema_privileges IS DISTINCT FROM ARRAY['USAGE']::text[] THEN
    RAISE EXCEPTION
      'Application schema ACL is not closed for migration: unexpected %, runtime %',
      unexpected_schema_grants,
      runtime_schema_privileges;
  END IF;

  WITH owner_identity AS (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = owner_role
  ), requested(object_type) AS (
    VALUES ('r'::"char"), ('S'::"char"), ('f'::"char"),
           ('T'::"char"), ('n'::"char")
  ), unexpected AS (
    -- Global defaults have PostgreSQL built-ins when no catalog row exists.
    SELECT format(
      '<global>:%s=>%s:%s%s',
      requested.object_type,
      coalesce(grantee.rolname, 'PUBLIC'),
      expanded.privilege_type,
      CASE WHEN expanded.is_grantable THEN '*' ELSE '' END
    ) AS grant_identity
    FROM requested
    CROSS JOIN owner_identity
    LEFT JOIN pg_catalog.pg_default_acl AS defaults
      ON defaults.defaclrole = owner_identity.oid
     AND defaults.defaclnamespace = 0
     AND defaults.defaclobjtype = requested.object_type
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(
        defaults.defaclacl,
        pg_catalog.acldefault(requested.object_type, owner_identity.oid)
      )
    ) AS expanded
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
    WHERE expanded.grantee <> owner_identity.oid
    UNION ALL
    -- Schema-scoped rows are additive. Any non-owner entry is unreviewed.
    SELECT format(
      '%I:%s=>%s:%s%s',
      namespace.nspname,
      defaults.defaclobjtype,
      coalesce(grantee.rolname, 'PUBLIC'),
      expanded.privilege_type,
      CASE WHEN expanded.is_grantable THEN '*' ELSE '' END
    )
    FROM pg_catalog.pg_default_acl AS defaults
    JOIN owner_identity ON owner_identity.oid = defaults.defaclrole
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = defaults.defaclnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS expanded
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
    WHERE expanded.grantee <> owner_identity.oid
  )
  SELECT array_agg(grant_identity ORDER BY grant_identity)
  INTO unexpected_default_grants
  FROM unexpected;

  IF coalesce(cardinality(unexpected_default_grants), 0) > 0 THEN
    RAISE EXCEPTION
      'Migration-owner default ACLs are not exact owner-only: %',
      unexpected_default_grants;
  END IF;
END
$migration_preflight$;

ROLLBACK;
