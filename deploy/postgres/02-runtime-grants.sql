\set ON_ERROR_STOP on

-- Run after `prisma migrate deploy`, while the deployment principal has a
-- temporary membership in paperpilot_migration_owner. This script deliberately
-- fails when the Prisma model/table allowlist has drifted.
BEGIN;
SET LOCAL ROLE paperpilot_migration_owner;

DO $runtime_grants$
DECLARE
  migration_owner CONSTANT text := 'paperpilot_migration_owner';
  runtime_role CONSTANT text := 'paperpilot_runtime';
  application_schema CONSTANT text := 'public';
  -- BEGIN APPLICATION TABLES: keep exactly aligned with runtime-access-manifest.json.
  expected_tables CONSTANT text[] := ARRAY[
    'Account',
    'Asset',
    'AuditEvent',
    'Collection',
    'CollectionEvidenceNote',
    'CollectionPaper',
    'CrawlerImport',
    'Document',
    'DocumentAsset',
    'DocumentIngestReceipt',
    'DocumentIngressAttempt',
    'DocumentIntake',
    'DocumentTextChunk',
    'DocumentTextExtraction',
    'DocumentTextManifestAdmission',
    'DocumentValidationAttestation',
    'EvidenceNote',
    'EvidenceTextAnchor',
    'IdempotencyRecord',
    'ImportBatch',
    'InboxEntry',
    'IntegrationConnection',
    'Invitation',
    'Job',
    'JobAttempt',
    'Member',
    'Organization',
    'OrganizationRole',
    'Paper',
    'PaperAuthor',
    'PaperIdentifier',
    'Project',
    'ProjectEvidenceNote',
    'ProjectPaper',
    'ProvenanceRecord',
    'RateLimit',
    'RateLimitBucket',
    'RetainedAuditPrincipal',
    'Session',
    'Team',
    'TeamMember',
    'UploadAttempt',
    'UploadSession',
    'User',
    'Verification',
    'WebMcpApprovalChallenge',
    'WebMcpProposalApproval',
    'WorkspacePaper',
    'ZoteroAttachment',
    'ZoteroAttachmentImport',
    'ZoteroAttachmentPolicy',
    'ZoteroLibrary',
    'ZoteroOAuthAttempt',
    'ZoteroObject',
    'ZoteroSyncRun',
    'ZoteroSyncStage'
  ];
  -- END APPLICATION TABLES.
  missing_tables text[];
  unexpected_tables text[];
  wrongly_owned_objects text[];
  object_name text;
  column_list text;
BEGIN
  IF current_user <> migration_owner THEN
    RAISE EXCEPTION 'Runtime grants must execute as %, got %', migration_owner, current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = runtime_role) THEN
    RAISE EXCEPTION 'Required runtime role % is missing', runtime_role;
  END IF;

  SELECT array_agg(expected_name ORDER BY expected_name)
  INTO missing_tables
  FROM unnest(expected_tables) AS expected_name
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = application_schema
      AND relation.relname = expected_name
      AND relation.relkind IN ('r', 'p')
  );

  IF coalesce(cardinality(missing_tables), 0) > 0 THEN
    RAISE EXCEPTION 'Missing PaperPilot application tables: %', missing_tables;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS ledger
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = ledger.relnamespace
    WHERE namespace.nspname = application_schema
      AND ledger.relname = '_prisma_migrations'
      AND ledger.relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'Prisma migration ledger is missing; run prisma migrate deploy first';
  END IF;

  SELECT array_agg(relation.relname ORDER BY relation.relname)
  INTO unexpected_tables
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = application_schema
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND relation.relname <> '_prisma_migrations'
    AND NOT relation.relname = ANY(expected_tables);

  IF coalesce(cardinality(unexpected_tables), 0) > 0 THEN
    RAISE EXCEPTION 'Unreviewed public tables are not granted: %', unexpected_tables;
  END IF;

  SELECT array_agg(object_identity ORDER BY object_identity)
  INTO wrongly_owned_objects
  FROM (
    SELECT format('table %I.%I', namespace.nspname, relation.relname) AS object_identity
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = relation.relowner
    WHERE namespace.nspname = application_schema
      AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
      AND owner_role.rolname <> migration_owner
    UNION ALL
    SELECT format('function %I.%I', namespace.nspname, routine.proname)
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = routine.proowner
    WHERE namespace.nspname = application_schema
      AND owner_role.rolname <> migration_owner
    UNION ALL
    SELECT format('type %I.%I', namespace.nspname, type_definition.typname)
    FROM pg_catalog.pg_type AS type_definition
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_definition.typnamespace
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = type_definition.typowner
    WHERE namespace.nspname = application_schema
      AND type_definition.typisdefined
      AND owner_role.rolname <> migration_owner
  ) AS wrong_owner;

  IF coalesce(cardinality(wrongly_owned_objects), 0) > 0 THEN
    RAISE EXCEPTION 'Application objects must be owned by %: %', migration_owner, wrongly_owned_objects;
  END IF;

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
    application_schema,
    runtime_role
  );
  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;

  -- Table-level REVOKE is not a substitute for closing pg_attribute.attacl.
  -- Clear every column grant before applying the single reviewed exception.
  FOR object_name IN
    SELECT relation.relname
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = application_schema
      AND relation.relkind IN ('r', 'p')
  LOOP
    SELECT string_agg(format('%I', attribute.attname), ', ' ORDER BY attribute.attnum)
    INTO column_list
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = application_schema
      AND relation.relname = object_name
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF column_list IS NOT NULL THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES (%s) ON TABLE %I.%I FROM %I',
        column_list,
        application_schema,
        object_name,
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES (%s) ON TABLE %I.%I FROM PUBLIC',
        column_list,
        application_schema,
        object_name
      );
    END IF;
  END LOOP;

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I',
    application_schema,
    runtime_role
  );
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

  FOREACH object_name IN ARRAY expected_tables LOOP
    CONTINUE WHEN object_name = 'RetainedAuditPrincipal';
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I',
      application_schema,
      object_name,
      runtime_role
    );
  END LOOP;

  -- The retained identity resolver needs to create a live principal and lock
  -- it FOR SHARE. It does not need to detach, rewrite, or delete identities.
  -- UPDATE(id) supplies PostgreSQL's minimum locking-clause privilege while
  -- the immutable trigger rejects every real ID change.
  GRANT SELECT ON TABLE public."RetainedAuditPrincipal" TO paperpilot_runtime;
  GRANT INSERT ("id", "organizationId", "liveUserId", "createdAt")
    ON TABLE public."RetainedAuditPrincipal" TO paperpilot_runtime;
  GRANT UPDATE ("id")
    ON TABLE public."RetainedAuditPrincipal" TO paperpilot_runtime;

  FOR object_name IN
    SELECT type_definition.typname
    FROM pg_catalog.pg_type AS type_definition
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_definition.typnamespace
    WHERE namespace.nspname = application_schema
      AND type_definition.typtype IN ('d', 'e')
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TYPE %I.%I FROM PUBLIC',
      application_schema,
      object_name
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TYPE %I.%I FROM %I',
      application_schema,
      object_name,
      runtime_role
    );
  END LOOP;
END
$runtime_grants$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM paperpilot_runtime;

-- Trigger functions run as the row writer. These six non-mutating helpers are
-- called from installed trigger functions; everything else remains non-callable.
GRANT EXECUTE ON FUNCTION public."WebMcpApproval_provenance_row_allowed"(text, text, text)
  TO paperpilot_runtime;
GRANT EXECUTE ON FUNCTION public."WebMcpInbox_integrity_lock"(text, text)
  TO paperpilot_runtime;
GRANT EXECUTE ON FUNCTION public."WebMcpPaper_integrity_lock"(text)
  TO paperpilot_runtime;
GRANT EXECUTE ON FUNCTION public.assert_document_text_extraction_aggregate(text, text)
  TO paperpilot_runtime;
GRANT EXECUTE ON FUNCTION public.compute_document_text_manifest_v1(text, text, text)
  TO paperpilot_runtime;
GRANT EXECUTE ON FUNCTION public.document_text_manifest_field_v1(text)
  TO paperpilot_runtime;

-- Reassert fail-closed defaults on every deployment. A new table receives no
-- runtime grant until this reviewed allowlist is updated and applied again.
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

-- Reconcile inherited history on the fixed owner role as well as the known
-- PUBLIC/runtime entries. A later release must never inherit a grant to an
-- arbitrary third-party role.
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

COMMIT;
