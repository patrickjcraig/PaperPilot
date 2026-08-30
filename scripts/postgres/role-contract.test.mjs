import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  loadRuntimeAccessManifest,
  prismaTableNames,
  repositoryRoot,
  sqlApplicationTables,
  validateRuntimeAccessManifest,
} from "./role-contract.mjs";
import { canonicalSqlDeparse, validatedAuditUrl } from "./verify-runtime-role.mjs";

const manifest = loadRuntimeAccessManifest();
const prismaSchema = readFileSync(resolve(repositoryRoot, "prisma", "schema.prisma"), "utf8");
const bootstrapSql = readFileSync(
  resolve(repositoryRoot, "deploy", "postgres", "01-bootstrap-roles.sql"),
  "utf8",
);
const runtimeGrantSql = readFileSync(
  resolve(repositoryRoot, "deploy", "postgres", "02-runtime-grants.sql"),
  "utf8",
);
const migrationPreflightSql = readFileSync(
  resolve(repositoryRoot, "deploy", "postgres", "migration-preflight.sql"),
  "utf8",
);
const verifierSource = readFileSync(
  resolve(repositoryRoot, "scripts", "postgres", "verify-runtime-role.mjs"),
  "utf8",
);
const deployWrapperSource = readFileSync(
  resolve(repositoryRoot, "scripts", "postgres", "deploy-migrations.mjs"),
  "utf8",
);
const snapshotSource = readFileSync(
  resolve(repositoryRoot, "scripts", "postgres", "snapshot-authority.mjs"),
  "utf8",
);
const runtimeSmokeSource = readFileSync(
  resolve(repositoryRoot, "scripts", "postgres", "smoke-runtime-role.mjs"),
  "utf8",
);
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));

test("the reviewed runtime table allowlist exactly matches the Prisma models", () => {
  assert.deepEqual(prismaTableNames(prismaSchema), manifest.applicationTables);
  assert.deepEqual(sqlApplicationTables(runtimeGrantSql), manifest.applicationTables);
  assert.equal(manifest.applicationTables.includes("_prisma_migrations"), false);
});

test("the role bootstrap is secret-free and closes role, database, schema, and replication authority", () => {
  assert.doesNotMatch(bootstrapSql, /\bPASSWORD\s+['"]/i);
  assert.match(
    bootstrapSql,
    /ALTER ROLE paperpilot_migration_owner\s+NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;/,
  );
  assert.match(
    bootstrapSql,
    /ALTER ROLE paperpilot_runtime\s+LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;/,
  );
  assert.match(bootstrapSql, /REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC/);
  assert.match(bootstrapSql, /REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC/);
  assert.match(bootstrapSql, /GRANT USAGE ON SCHEMA public TO paperpilot_runtime/);
  assert.match(bootstrapSql, /REVOKE SET ON PARAMETER session_replication_role FROM PUBLIC/);
  assert.match(bootstrapSql, /REVOKE SET ON PARAMETER session_replication_role FROM paperpilot_runtime/);
  assert.match(bootstrapSql, /REVOKE ALTER SYSTEM ON PARAMETER session_replication_role FROM PUBLIC/);
  assert.match(bootstrapSql, /REVOKE ALTER SYSTEM ON PARAMETER session_replication_role FROM paperpilot_runtime/);
  assert.match(bootstrapSql, /DO \$parameter_privileges\$/);
  assert.match(bootstrapSql, /REVOKE ALL PRIVILEGES ON PARAMETER %I FROM PUBLIC, paperpilot_migration_owner, paperpilot_runtime/);
  assert.match(bootstrapSql, /PaperPilot requires a dedicated cluster/);
  for (const signature of manifest.forbiddenSystemFunctionExecute) {
    const sqlArguments = signature.slice(signature.indexOf("(") + 1, -1).replaceAll(",", ", ");
    const name = signature.slice(0, signature.indexOf("("));
    assert.match(
      bootstrapSql,
      new RegExp(`REVOKE EXECUTE ON FUNCTION pg_catalog\\.${name}\\(${sqlArguments}\\)`),
    );
  }
  assert.match(bootstrapSql, /REVOKE paperpilot_migration_owner FROM paperpilot_runtime/);
  assert.match(bootstrapSql, /REVOKE paperpilot_migration_owner FROM CURRENT_USER/);
  assert.match(bootstrapSql, /REVOKE paperpilot_runtime FROM CURRENT_USER/);
  assert.match(bootstrapSql, /server_version_number >= 160000 AND NOT bootstrap_is_superuser/);
  assert.match(bootstrapSql, /non-revocable automatic ADMIN memberships/);
  assert.match(bootstrapSql, /Refusing implicit ownership adoption/);
  assert.match(bootstrapSql, /ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/);
  assert.match(bootstrapSql, /ALTER DEFAULT PRIVILEGES REVOKE USAGE ON TYPES FROM PUBLIC/);
  assert.match(bootstrapSql, /ALTER ROLE paperpilot_migration_owner RESET ALL/);
  assert.match(bootstrapSql, /ALTER ROLE paperpilot_runtime RESET ALL/);
  assert.match(bootstrapSql, /ALTER ROLE paperpilot_migration_owner SET search_path = public, pg_catalog/);
  assert.match(bootstrapSql, /ALTER ROLE paperpilot_runtime SET search_path = pg_catalog, public/);
  assert.match(bootstrapSql, /database_role_settings_reset/);
  assert.match(bootstrapSql, /default_acl_reconciliation/);
  assert.match(bootstrapSql, /default_acl_exact_guard/);
  assert.match(bootstrapSql, /Database ACL references missing role OID/);
  assert.match(bootstrapSql, /Schema ACL references missing role OID/);
});

test("runtime reconciliation grants DML only and excludes owner-only surfaces", () => {
  assert.deepEqual(
    manifest.requiredTablePrivileges,
    ["SELECT", "INSERT", "UPDATE", "DELETE"],
  );
  assert.deepEqual(
    manifest.forbiddenTablePrivileges,
    ["TRUNCATE", "REFERENCES", "TRIGGER"],
  );
  assert.match(
    runtimeGrantSql,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I\.%I TO %I/,
  );
  assert.match(runtimeGrantSql, /GRANT INSERT \("id", "organizationId", "liveUserId", "createdAt"\)/);
  assert.match(runtimeGrantSql, /GRANT UPDATE \("id"\)/);
  assert.match(runtimeGrantSql, /REVOKE ALL PRIVILEGES \(%s\) ON TABLE %I\.%I FROM %I/);
  assert.deepEqual(manifest.tablePrivilegeOverrides, [{
    table: "RetainedAuditPrincipal",
    tablePrivileges: ["SELECT"],
    columnPrivileges: [
      { privilege: "INSERT", columns: ["createdAt", "id", "liveUserId", "organizationId"] },
      { privilege: "UPDATE", columns: ["id"] },
    ],
  }]);
  assert.doesNotMatch(runtimeGrantSql, /GRANT USAGE ON TYPE/);
  assert.match(runtimeGrantSql, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES/);
  assert.match(runtimeGrantSql, /REVOKE EXECUTE ON ALL FUNCTIONS/);
  for (const signature of manifest.requiredFunctionExecute) {
    const [name, argumentsList] = signature.split("(");
    const quotedName = /^[A-Z]/.test(name) ? `"${name}"` : name;
    const sqlArguments = argumentsList.slice(0, -1).replaceAll(",", ", ");
    assert.match(
      runtimeGrantSql,
      new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${quotedName.replaceAll('"', '\\"')}\\(${sqlArguments}\\)`),
    );
  }
  assert.equal((runtimeGrantSql.match(/GRANT EXECUTE ON FUNCTION/g) ?? []).length, manifest.requiredFunctionExecute.length);
  assert.doesNotMatch(runtimeGrantSql, /GRANT\s+(?:ALL|CREATE|TRUNCATE|REFERENCES|TRIGGER)\b/i);
  assert.doesNotMatch(runtimeGrantSql, /GRANT\s+(?:USAGE|SELECT|UPDATE)\s+ON\s+(?:ALL\s+)?SEQUENCES?/i);
  assert.match(runtimeGrantSql, /default_acl_reconciliation/);
  assert.match(runtimeGrantSql, /Migration-owner default ACLs must be exact owner-only/);
});

test("the read-only verifier checks required access and every forbidden capability", () => {
  assert.match(verifierSource, /BEGIN TRANSACTION READ ONLY/);
  assert.match(verifierSource, /has_database_privilege\(\$1, current_database\(\), 'CREATE'\)/);
  assert.match(verifierSource, /has_database_privilege\(\$1, current_database\(\), 'TEMPORARY'\)/);
  assert.match(verifierSource, /has_schema_privilege\(\$1, namespace\.oid, 'CREATE'\)/);
  for (const privilege of [...manifest.requiredTablePrivileges, ...manifest.forbiddenTablePrivileges]) {
    assert.match(verifierSource, new RegExp(`has_table_privilege\\(\\$1, relation\\.oid, '${privilege}'\\)`));
  }
  assert.match(verifierSource, /has_sequence_privilege/);
  assert.match(verifierSource, /has_function_privilege/);
  assert.match(verifierSource, /forbiddenSystemFunctionExecute/);
  assert.match(verifierSource, /pg_catalog\.aclexplode/);
  assert.match(verifierSource, /pg_catalog\.pg_attribute/);
  assert.match(verifierSource, /has_any_column_privilege/);
  assert.match(verifierSource, /pg_catalog\.pg_trigger/);
  assert.match(verifierSource, /routine\.prosrc/);
  assert.match(verifierSource, /sourceSha256/);
  assert.match(verifierSource, /pg_catalog\.pg_get_triggerdef/);
  assert.doesNotMatch(verifierSource, /tgqual::text/);
  assert.match(verifierSource, /COLLATE "C"/);
  assert.match(verifierSource, /applicationTriggerAuthority/);
  assert.match(verifierSource, /applicationSchemaAuthority/);
  assert.match(verifierSource, /pg_catalog\.pg_constraint/);
  assert.match(verifierSource, /pg_catalog\.pg_index/);
  assert.match(verifierSource, /pg_catalog\.pg_policy/);
  assert.match(verifierSource, /pg_catalog\.pg_enum/);
  assert.match(verifierSource, /enum_value\.enumsortorder::text/);
  assert.match(verifierSource, /internalConstraintTriggers/);
  assert.match(verifierSource, /trigger\.tgisinternal/);
  assert.match(verifierSource, /pg_catalog\.pg_get_expr/);
  assert.match(verifierSource, /pg_catalog\.pg_get_constraintdef/);
  assert.match(verifierSource, /pg_catalog\.pg_get_indexdef/);
  assert.equal(manifest.authoritySnapshotVersion, 3);
  assert.equal(manifest.applicationFunctionAuthority.count, 82);
  assert.match(manifest.applicationFunctionAuthority.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.applicationTriggerAuthority.count, 166);
  assert.match(manifest.applicationTriggerAuthority.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.applicationSchemaAuthority.count, 57);
  assert.match(manifest.applicationSchemaAuthority.sha256, /^[0-9a-f]{64}$/);
  assert.match(verifierSource, /pg_catalog\.pg_default_acl/);
  assert.match(verifierSource, /is_grantable/);
  assert.match(verifierSource, /has_parameter_privilege\(\$1, 'session_replication_role', 'SET'\)/);
  assert.match(verifierSource, /has_parameter_privilege\(\$1, 'session_replication_role', 'ALTER SYSTEM'\)/);
  assert.match(verifierSource, /pg_catalog\.pg_parameter_acl/);
  assert.match(verifierSource, /No parameter may directly grant PUBLIC, migration-owner, or runtime authority/);
  assert.match(verifierSource, /clusterDatabases/);
  assert.match(verifierSource, /rolbypassrls/);
  assert.match(verifierSource, /pg_catalog\.pg_auth_members/);
  assert.match(verifierSource, /pg_catalog\.pg_shdepend/);
  assert.match(verifierSource, /_prisma_migrations/);
  assert.match(verifierSource, /exact owner-only/);
  assert.match(verifierSource, /no database-specific settings/);
});

test("manifest parsing fails closed on drift and unsafe identifiers", () => {
  const baseline = JSON.parse(JSON.stringify(manifest));
  assert.throws(
    () => validateRuntimeAccessManifest({ ...baseline, extraAuthority: true }),
    /open or incomplete shape/,
  );
  assert.throws(
    () => validateRuntimeAccessManifest({ ...baseline, runtimeRole: "paperpilot_runtime_v2" }),
    /exactly paperpilot_runtime/,
  );
  assert.throws(
    () => validateRuntimeAccessManifest({
      ...baseline,
      requiredFunctionExecute: baseline.requiredFunctionExecute.slice(1),
    }),
    /six reviewed trigger helpers/,
  );
  assert.throws(
    () => validateRuntimeAccessManifest({
      ...baseline,
      forbiddenSystemFunctionExecute: baseline.forbiddenSystemFunctionExecute.slice(1),
    }),
    /five reviewed large-object creators/,
  );
  assert.throws(
    () => validateRuntimeAccessManifest({
      ...baseline,
      applicationTriggerAuthority: { count: 116, sha256: "not-a-digest" },
    }),
    /exact count and SHA-256 contract/,
  );
  assert.throws(
    () => validateRuntimeAccessManifest({
      ...baseline,
      tablePrivilegeOverrides: [{
        ...baseline.tablePrivilegeOverrides[0],
        columnPrivileges: [{ privilege: "DELETE", columns: ["id"] }],
      }],
    }),
    /column privilege grant/,
  );
  assert.throws(
    () => validateRuntimeAccessManifest({ ...baseline, runtimeRole: "runtime; SUPERUSER" }),
    /identifier/,
  );
  assert.throws(
    () => validateRuntimeAccessManifest({
      ...baseline,
      requiredTablePrivileges: [...baseline.requiredTablePrivileges, "TRIGGER"],
    }),
    /exactly SELECT/,
  );
  assert.throws(
    () => validateRuntimeAccessManifest({
      ...baseline,
      requiredFunctionExecute: [...baseline.requiredFunctionExecute, "dangerous()"],
    }),
    /unique and sorted|text-only identity/,
  );
  assert.throws(
    () => validateRuntimeAccessManifest({
      ...baseline,
      forbiddenSystemFunctionExecute: ["lo_create(oid);drop schema public"],
    }),
    /large-object signature/,
  );
  assert.throws(
    () => validateRuntimeAccessManifest({
      ...baseline,
      applicationTables: [...baseline.applicationTables, baseline.applicationTables[0]],
    }),
    /unique and sorted/,
  );
});

test("the production deployment path preflights exact authority without putting a URL on argv", () => {
  assert.equal(
    packageJson.scripts["db:deploy"],
    "node scripts/postgres/deploy-migrations.mjs",
  );
  assert.match(deployWrapperSource, /migration-preflight\.sql/);
  assert.match(deployWrapperSource, /DATABASE_URL: connectionString/);
  assert.doesNotMatch(deployWrapperSource, /\[.*connectionString.*"migrate"/s);
  assert.match(migrationPreflightSql, /current_user <> owner_role/);
  assert.match(migrationPreflightSql, /session_user = current_user/);
  assert.match(migrationPreflightSql, /deploy_login\.rolsuper/);
  assert.match(migrationPreflightSql, /migration-owner\/runtime role attributes are missing or overpowered/);
  assert.match(migrationPreflightSql, /membership\.admin_option/);
  assert.match(migrationPreflightSql, /sole membership touching deploy, migration-owner, or runtime/);
  assert.match(migrationPreflightSql, /public,pg_catalog/);
  assert.match(migrationPreflightSql, /session_replication_role'\) <> 'origin'/);
  assert.match(migrationPreflightSql, /check_function_bodies'\) <> 'on'/);
  assert.match(migrationPreflightSql, /Application database ACL is not closed for migration/);
  assert.match(migrationPreflightSql, /Application schema ACL is not closed for migration/);
  assert.match(migrationPreflightSql, /Migration-owner default ACLs are not exact owner-only/);
  assert.match(migrationPreflightSql, /Runtime has stale or incomplete global role settings/);
  assert.match(migrationPreflightSql, /fixed roles must have no explicit parameter privileges/);
  assert.match(migrationPreflightSql, /deploy_database_privileges IS DISTINCT FROM ARRAY\['CONNECT'\]/);
  assert.match(migrationPreflightSql, /role_setting\.setdatabase <> 0/);
  assert.match(verifierSource, /role_setting\.setdatabase <> 0/);
});

test("authority review and runtime smoke commands are reproducible and bounded", () => {
  assert.match(snapshotSource, /BEGIN TRANSACTION READ ONLY/);
  assert.match(snapshotSource, /includeInventory: true/);
  assert.equal(
    packageJson.scripts["db:authority:snapshot"],
    "node scripts/postgres/snapshot-authority.mjs",
  );
  assert.match(runtimeSmokeSource, /BEGIN/);
  assert.match(runtimeSmokeSource, /ROLLBACK/);
  for (const signature of manifest.requiredFunctionExecute) {
    const functionName = signature.slice(0, signature.indexOf("("));
    assert.match(runtimeSmokeSource, new RegExp(functionName));
  }
});

test("SQL deparse canonicalization changes only whitespace outside quoted tokens", () => {
  assert.equal(
    canonicalSqlDeparse('  CHECK  (("field"   =  \'a  b\'))  '),
    'CHECK (("field" = \'a  b\'))',
  );
  assert.notEqual(
    canonicalSqlDeparse("CHECK (value = 'a b')"),
    canonicalSqlDeparse("CHECK (value = 'a  b')"),
  );
  assert.notEqual(
    canonicalSqlDeparse('CHECK ("a b" IS NOT NULL)'),
    canonicalSqlDeparse('CHECK ("a  b" IS NOT NULL)'),
  );
  assert.equal(
    canonicalSqlDeparse("CHECK (value = $tag$a  b$tag$   OR value = E'a\\'  b')"),
    "CHECK (value = $tag$a  b$tag$ OR value = E'a\\'  b')",
  );
});

test("the audit URL is explicit and requires transport security off loopback", () => {
  assert.throws(() => validatedAuditUrl(""), /is required/);
  assert.throws(
    () => validatedAuditUrl("postgresql://paperpilot_runtime@example.test:5432/paperpilot"),
    /verify-full/,
  );
  assert.throws(
    () => validatedAuditUrl("postgresql://paperpilot_runtime@example.test:5432/paperpilot?sslmode=require"),
    /verify-full/,
  );
  assert.throws(
    () => validatedAuditUrl("postgresql://paperpilot_runtime@localhost:5432/paperpilot?host=remote.example&sslmode=disable"),
    /unsupported connection parameter/,
  );
  assert.throws(
    () => validatedAuditUrl("postgresql://paperpilot_runtime@example.test:5432/paperpilot?sslmode=verify-full&sslmode=disable"),
    /at most one sslmode/,
  );
  assert.throws(
    () => validatedAuditUrl("postgresql://paperpilot_runtime@example.test:5432/paperpilot?sslmode=verify-full&service=unsafe"),
    /unsupported connection parameter/,
  );
  assert.throws(
    () => validatedAuditUrl("postgresql://ambient_admin@example.test:5432/paperpilot?sslmode=verify-full"),
    /authenticate as paperpilot_runtime/,
  );
  assert.equal(
    validatedAuditUrl("postgresql://paperpilot_runtime@127.0.0.1:5432/paperpilot?sslmode=disable"),
    "postgresql://paperpilot_runtime@127.0.0.1:5432/paperpilot?sslmode=disable",
  );
  assert.equal(
    validatedAuditUrl("postgresql://paperpilot_runtime@example.test:5432/paperpilot?sslmode=verify-full"),
    "postgresql://paperpilot_runtime@example.test:5432/paperpilot?sslmode=verify-full",
  );
});
