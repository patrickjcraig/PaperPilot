import { readFileSync } from "node:fs";

import { Client } from "pg";

import {
  PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST,
  validatedPostgresConnectionUrl,
} from "../../src/lib/postgres-connection-url.mjs";

export const ADMIN_URL_ENV = "PAPERPILOT_ADMIN_DATABASE_URL";
export const DEPLOY_URL_ENV = "PAPERPILOT_DEPLOY_DATABASE_URL";

export function assertApprovedSupabaseDatabaseTarget(parsed, label) {
  if (
    parsed.isLoopback
    || parsed.hostname !== PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST
    || parsed.port !== 5_432
    || parsed.databaseName !== "postgres"
  ) {
    throw new Error(
      `${label} may target only the approved PaperPilot Supabase direct database.`,
    );
  }
  return parsed;
}

function withoutPsqlDirectives(source) {
  return source.replace(/^\\set\s+ON_ERROR_STOP\s+on\s*$/mu, "");
}

export function validatedAdminConnectionUrl(rawValue) {
  const parsed = validatedPostgresConnectionUrl(rawValue, {
    label: ADMIN_URL_ENV,
    requireTlsForNonLoopback: true,
  });
  if (parsed.username === "paperpilot_runtime") {
    throw new Error(`${ADMIN_URL_ENV} must not authenticate as paperpilot_runtime.`);
  }
  return assertApprovedSupabaseDatabaseTarget(parsed, ADMIN_URL_ENV).connectionString;
}

export function validatedDeployConnectionUrl(rawValue, { label = DEPLOY_URL_ENV } = {}) {
  const parsed = validatedPostgresConnectionUrl(rawValue, {
    label,
    requireTlsForNonLoopback: true,
  });
  if (
    parsed.username === "paperpilot_runtime"
    || parsed.username === "paperpilot_migration_owner"
  ) {
    throw new Error(`${label} must authenticate as a short-lived deploy login, not a fixed PaperPilot role.`);
  }
  assertApprovedSupabaseDatabaseTarget(parsed, label);

  const migrationUrl = new URL(parsed.connectionString);
  migrationUrl.searchParams.set(
    "options",
    "-c role=paperpilot_migration_owner"
      + " -c search_path=public,pg_catalog"
      + " -c row_security=on"
      + " -c check_function_bodies=on",
  );
  return migrationUrl.toString();
}

export async function assertMigrationSession(client, label = "Migration session") {
  const { rows } = await client.query(
    `SELECT current_user,
            current_database() AS database_name,
            current_setting('search_path') AS search_path,
            current_setting('row_security') AS row_security,
            current_setting('session_replication_role') AS replication_role,
            current_setting('check_function_bodies') AS check_function_bodies`,
  );
  const session = rows[0] ?? {};
  const normalizedSearchPath = typeof session.search_path === "string"
    ? session.search_path.replaceAll(/["\s]/g, "")
    : "";
  if (
    session.current_user !== "paperpilot_migration_owner"
    || normalizedSearchPath !== "public,pg_catalog"
    || session.row_security !== "on"
    || session.replication_role !== "origin"
    || session.check_function_bodies !== "on"
    || session.database_name === "postgres"
    || session.database_name?.startsWith("template")
  ) {
    throw new Error(`${label} does not have the exact reviewed owner session policy.`);
  }
  return Object.freeze(session);
}

export async function executeSqlFile(connectionString, sqlPath, applicationName) {
  const client = new Client({
    connectionString,
    application_name: applicationName,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
  });
  await client.connect();
  try {
    await client.query(withoutPsqlDirectives(readFileSync(sqlPath, "utf8")));
  } finally {
    await client.end();
  }
}
