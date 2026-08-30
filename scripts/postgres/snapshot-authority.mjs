import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { loadRuntimeAccessManifest } from "./role-contract.mjs";
import { applicationAuthoritySnapshot } from "./verify-runtime-role.mjs";
import {
  assertMigrationSession,
  validatedDeployConnectionUrl,
} from "./deployment-connection.mjs";

const AUDIT_URL_ENV = "PAPERPILOT_MIGRATION_AUDIT_DATABASE_URL";

export async function main() {
  const connectionString = validatedDeployConnectionUrl(
    process.env[AUDIT_URL_ENV],
    { label: AUDIT_URL_ENV },
  );
  const client = new Client({
    connectionString,
    application_name: "paperpilot-authority-snapshot",
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
  });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await assertMigrationSession(client, AUDIT_URL_ENV);
    const manifest = loadRuntimeAccessManifest();
    const { rows: versionRows } = await client.query("SHOW server_version_num");
    const snapshot = await applicationAuthoritySnapshot(
      client,
      manifest.databaseSchema,
      { includeInventory: true },
    );
    await client.query("ROLLBACK");
    process.stdout.write(`${JSON.stringify({
      schema: manifest.databaseSchema,
      serverVersionNum: String(versionRows[0]?.server_version_num ?? ""),
      ...snapshot,
    }, null, 2)}\n`);
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
