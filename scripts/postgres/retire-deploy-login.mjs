import { fileURLToPath } from "node:url";

import { Client } from "pg";

import {
  ADMIN_URL_ENV,
  validatedAdminConnectionUrl,
} from "./deployment-connection.mjs";

const DEPLOY_LOGIN_ENV = "PAPERPILOT_DEPLOY_LOGIN_ROLE";
const ROLE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

function deployLoginRole() {
  const value = process.env[DEPLOY_LOGIN_ENV]?.trim() ?? "";
  if (!ROLE_IDENTIFIER.test(value)) {
    throw new Error(`${DEPLOY_LOGIN_ENV} must be one explicit lowercase role identifier.`);
  }
  if (["paperpilot_migration_owner", "paperpilot_runtime"].includes(value)) {
    throw new Error(`${DEPLOY_LOGIN_ENV} must name only the short-lived deploy login.`);
  }
  return value;
}

export async function main() {
  const roleName = deployLoginRole();
  const quotedRole = `"${roleName}"`;
  const connectionString = validatedAdminConnectionUrl(process.env[ADMIN_URL_ENV]);
  const client = new Client({
    connectionString,
    application_name: "paperpilot-deploy-login-retirement",
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
  });
  await client.connect();
  try {
    const { rows: roleRows } = await client.query(
      `SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = $1`,
      [roleName],
    );
    if (roleRows.length !== 1) {
      throw new Error("The named deploy login does not exist; retirement was not assumed.");
    }

    await client.query("BEGIN");
    await client.query(`ALTER ROLE ${quotedRole} NOLOGIN`);
    await client.query(`REVOKE paperpilot_migration_owner FROM ${quotedRole}`);
    const { rows: databaseRows } = await client.query("SELECT current_database() AS name");
    const databaseName = databaseRows[0]?.name;
    if (typeof databaseName !== "string" || !databaseName) {
      throw new Error("Could not resolve the deployment database.");
    }
    const quotedDatabase = `"${databaseName.replaceAll('"', '""')}"`;
    await client.query(`REVOKE ALL PRIVILEGES ON DATABASE ${quotedDatabase} FROM ${quotedRole}`);
    await client.query("COMMIT");

    const { rows: terminatedRows } = await client.query(
      `SELECT pid, pg_catalog.pg_terminate_backend(pid) AS terminated
         FROM pg_catalog.pg_stat_activity
        WHERE usename = $1
          AND pid <> pg_catalog.pg_backend_pid()`,
      [roleName],
    );
    if (terminatedRows.some((row) => !row.terminated)) {
      throw new Error("At least one deploy backend could not be terminated.");
    }
    const { rows: remainingRows } = await client.query(
      `SELECT count(*)::integer AS active
         FROM pg_catalog.pg_stat_activity
        WHERE usename = $1`,
      [roleName],
    );
    if (remainingRows[0]?.active !== 0) {
      throw new Error("A deploy backend remains active after retirement.");
    }
    process.stdout.write(
      `Retired deploy login ${roleName}; LOGIN, owner membership, database privileges, and active sessions are closed.\n`,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
