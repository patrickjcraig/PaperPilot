import { fileURLToPath } from "node:url";

import { Client } from "pg";

import {
  expectedMigrationLedgerEntries,
  verifyMigrationLedgerRows,
} from "./migration-ledger-contract.mjs";
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
    application_name: "paperpilot-migration-ledger-audit",
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
  });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await assertMigrationSession(client, AUDIT_URL_ENV);
    const { rows } = await client.query(
      `SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count
         FROM "public"."_prisma_migrations"
        ORDER BY started_at, id`,
    );
    const result = verifyMigrationLedgerRows(expectedMigrationLedgerEntries(), rows);
    const manifest = loadRuntimeAccessManifest();
    const authority = await applicationAuthoritySnapshot(client, manifest.databaseSchema);
    if (
      authority.snapshotVersion !== manifest.authoritySnapshotVersion
      || authority.functions.count !== manifest.applicationFunctionAuthority.count
      || authority.functions.sha256 !== manifest.applicationFunctionAuthority.sha256
      || authority.triggers.count !== manifest.applicationTriggerAuthority.count
      || authority.triggers.sha256 !== manifest.applicationTriggerAuthority.sha256
      || authority.schema.count !== manifest.applicationSchemaAuthority.count
      || authority.schema.sha256 !== manifest.applicationSchemaAuthority.sha256
    ) {
      throw new Error(
        "The deployed function/trigger authority graph differs from the reviewed manifest.",
      );
    }
    await client.query("ROLLBACK");
    process.stdout.write(
      `PaperPilot migration ledger and live schema verified (${result.migrationCount} migrations, ${authority.functions.count} functions, ${authority.triggers.count} triggers, ${authority.schema.count} relations).\n`,
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
