import "dotenv/config";

import { pathToFileURL } from "node:url";

import { Client } from "pg";

import { configuredPaperPilotBootstrapPostgresConnection } from "../../src/lib/postgres-client-config.mjs";
import {
  validatedPaperPilotApplicationDatabaseUrl,
  validatedPaperPilotMigrationDatabaseUrl,
} from "../../src/lib/postgres-connection-url.mjs";

function decodedPassword(connectionString, label) {
  let password;
  try {
    password = decodeURIComponent(new URL(connectionString).password);
  } catch {
    throw new Error(`${label} contains invalid password encoding.`);
  }
  if (
    password.length < 24
    || password.length > 512
    || /[\u0000-\u001f\u007f]/u.test(password)
  ) {
    throw new Error(`${label} must contain one bounded high-entropy password.`);
  }
  return password;
}

export async function bootstrapPaperPilotSupabaseRoles(environment = process.env) {
  const bootstrap = configuredPaperPilotBootstrapPostgresConnection(
    environment.PAPERPILOT_BOOTSTRAP_DATABASE_URL,
    {
      caCertificatePath: environment.PAPERPILOT_DATABASE_CA_CERT_PATH,
      databaseProfile: environment.PAPERPILOT_BOOTSTRAP_DATABASE_PROFILE,
    },
  );
  const migration = validatedPaperPilotMigrationDatabaseUrl(
    environment.PAPERPILOT_MIGRATION_DATABASE_URL,
    { databaseProfile: environment.PAPERPILOT_MIGRATION_DATABASE_PROFILE },
  );
  const runtime = validatedPaperPilotApplicationDatabaseUrl(
    environment.DATABASE_URL,
    {
      databaseProfile: environment.PAPERPILOT_DATABASE_PROFILE,
      poolerHost: environment.PAPERPILOT_SUPABASE_POOLER_HOST,
    },
  );
  const migrationPassword = decodedPassword(
    migration.connectionString,
    "PAPERPILOT_MIGRATION_DATABASE_URL",
  );
  const runtimePassword = decodedPassword(runtime.connectionString, "DATABASE_URL");

  const client = new Client({
    ...bootstrap.clientConfig,
    application_name: "paperpilot-supabase-role-bootstrap",
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
    statement_timeout: 20_000,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('paperpilot.migration_password', $1, true), set_config('paperpilot.runtime_password', $2, true)",
      [migrationPassword, runtimePassword],
    );
    await client.query(`
      DO $paperpilot$
      DECLARE
        membership_record record;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'paperpilot_migration_owner') THEN
          CREATE ROLE paperpilot_migration_owner;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'paperpilot_runtime') THEN
          CREATE ROLE paperpilot_runtime;
        END IF;

        EXECUTE format(
          'ALTER ROLE paperpilot_migration_owner WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
          current_setting('paperpilot.migration_password')
        );
        EXECUTE format(
          'ALTER ROLE paperpilot_runtime WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
          current_setting('paperpilot.runtime_password')
        );

        FOR membership_record IN
          SELECT granted_role.rolname AS granted_role,
                 member_role.rolname AS member_role
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS granted_role
            ON granted_role.oid = membership.roleid
          JOIN pg_catalog.pg_roles AS member_role
            ON member_role.oid = membership.member
          WHERE granted_role.rolname IN ('paperpilot_migration_owner', 'paperpilot_runtime')
             OR member_role.rolname IN ('paperpilot_migration_owner', 'paperpilot_runtime')
        LOOP
          EXECUTE format(
            'REVOKE %I FROM %I',
            membership_record.granted_role,
            membership_record.member_role
          );
        END LOOP;

        IF (SELECT count(*) FROM pg_catalog.pg_roles
            WHERE rolname IN ('paperpilot_migration_owner', 'paperpilot_runtime')) <> 2
           OR EXISTS (
             SELECT 1
             FROM pg_catalog.pg_roles
             WHERE rolname IN ('paperpilot_migration_owner', 'paperpilot_runtime')
               AND (
                 NOT rolcanlogin OR rolsuper OR rolinherit OR rolcreaterole
                 OR rolcreatedb OR rolreplication OR rolbypassrls
               )
           )
           OR EXISTS (
             SELECT 1
             FROM pg_catalog.pg_auth_members AS membership
             JOIN pg_catalog.pg_roles AS granted_role
               ON granted_role.oid = membership.roleid
             JOIN pg_catalog.pg_roles AS member_role
               ON member_role.oid = membership.member
             WHERE granted_role.rolname IN ('paperpilot_migration_owner', 'paperpilot_runtime')
                OR member_role.rolname IN ('paperpilot_migration_owner', 'paperpilot_runtime')
           )
        THEN
          RAISE EXCEPTION 'PaperPilot role attributes or memberships are not closed';
        END IF;
      END
      $paperpilot$;

      ALTER ROLE paperpilot_migration_owner IN DATABASE postgres
        SET search_path = public;
      ALTER ROLE paperpilot_migration_owner IN DATABASE postgres
        SET row_security = on;
      ALTER ROLE paperpilot_runtime IN DATABASE postgres
        SET search_path = pg_catalog, public;
      ALTER ROLE paperpilot_runtime IN DATABASE postgres
        SET row_security = on;

      GRANT USAGE, CREATE ON SCHEMA public TO paperpilot_migration_owner;
      GRANT USAGE ON SCHEMA public TO paperpilot_runtime;
      REVOKE CREATE ON SCHEMA public FROM paperpilot_runtime;
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  return Object.freeze({
    schemaVersion: 1,
    status: "paperpilot_supabase_roles_bootstrapped",
    projectRef: "avmcmmayvnjxrhrmgsdx",
    roles: Object.freeze(["paperpilot_migration_owner", "paperpilot_runtime"]),
  });
}

async function main() {
  const result = await bootstrapPaperPilotSupabaseRoles();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "blocked",
      code: "supabase_role_bootstrap_failed",
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
