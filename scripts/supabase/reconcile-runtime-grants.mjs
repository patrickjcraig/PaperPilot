import "dotenv/config";

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Client } from "pg";

import { configuredPaperPilotMigrationPostgresConnection } from "../../src/lib/postgres-client-config.mjs";

const manifest = JSON.parse(readFileSync(
  new URL("../../deploy/postgres/runtime-access-manifest.json", import.meta.url),
  "utf8",
));

function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error("The runtime grant manifest contains an invalid identifier.");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function functionReference(signature) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/u.exec(signature);
  if (!match || !/^$|^text(?:,text)*$/u.test(match[2])) {
    throw new Error("The runtime grant manifest contains an invalid function signature.");
  }
  return `public.${identifier(match[1])}(${match[2]})`;
}

export async function reconcilePaperPilotRuntimeGrants(environment = process.env) {
  if (
    manifest.runtimeRole !== "paperpilot_runtime"
    || manifest.databaseSchema !== "public"
    || !Array.isArray(manifest.applicationTables)
    || !Array.isArray(manifest.requiredFunctionExecute)
  ) {
    throw new Error("The PaperPilot runtime grant manifest is invalid.");
  }
  const expectedTables = new Set(manifest.applicationTables);
  if (expectedTables.size !== manifest.applicationTables.length) {
    throw new Error("The PaperPilot runtime grant manifest contains duplicate tables.");
  }

  const configured = configuredPaperPilotMigrationPostgresConnection(
    environment.PAPERPILOT_MIGRATION_DATABASE_URL,
    {
      caCertificatePath: environment.PAPERPILOT_DATABASE_CA_CERT_PATH,
      databaseProfile: environment.PAPERPILOT_MIGRATION_DATABASE_PROFILE,
    },
  );
  const client = new Client({
    ...configured.clientConfig,
    application_name: "paperpilot-supabase-runtime-grants",
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  });
  await client.connect();
  try {
    const identity = await client.query(
      "SELECT current_user::text AS current_user, current_database()::text AS database_name",
    );
    if (
      identity.rows[0]?.current_user !== "paperpilot_migration_owner"
      || identity.rows[0]?.database_name !== "postgres"
    ) {
      throw new Error("The runtime grant session has the wrong migration authority.");
    }

    const roleContract = await client.query(`
      SELECT
        (SELECT count(*)::integer
         FROM pg_catalog.pg_roles
         WHERE rolname IN ('paperpilot_migration_owner', 'paperpilot_runtime')) AS role_count,
        NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_roles
          WHERE rolname IN ('paperpilot_migration_owner', 'paperpilot_runtime')
            AND (
              NOT rolcanlogin OR rolsuper OR rolinherit OR rolcreaterole
              OR rolcreatedb OR rolreplication OR rolbypassrls
            )
        ) AS attributes_closed,
        NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS granted_role
            ON granted_role.oid = membership.roleid
          JOIN pg_catalog.pg_roles AS member_role
            ON member_role.oid = membership.member
          WHERE granted_role.rolname IN ('paperpilot_migration_owner', 'paperpilot_runtime')
             OR member_role.rolname IN ('paperpilot_migration_owner', 'paperpilot_runtime')
        ) AS memberships_closed
    `);
    if (
      roleContract.rows[0]?.role_count !== 2
      || roleContract.rows[0]?.attributes_closed !== true
      || roleContract.rows[0]?.memberships_closed !== true
    ) {
      throw new Error("The PaperPilot role authority is not closed.");
    }

    const relations = await client.query(`
      SELECT relation.relname::text AS name, relation.relkind::text AS kind
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND pg_catalog.pg_get_userbyid(relation.relowner) = current_user
        AND relation.relkind IN ('r', 'p', 'S')
      ORDER BY relation.relname
    `);
    const ownedTables = relations.rows
      .filter((row) => row.kind === "r" || row.kind === "p")
      .map((row) => row.name);
    const actualApplicationTables = new Set(
      ownedTables.filter((name) => name !== "_prisma_migrations"),
    );
    if (
      actualApplicationTables.size !== expectedTables.size
      || [...expectedTables].some((name) => !actualApplicationTables.has(name))
    ) {
      throw new Error("The migrated PaperPilot table authority does not match its manifest.");
    }

    const routines = await client.query(`
      SELECT routine.proname::text AS name,
             pg_catalog.oidvectortypes(routine.proargtypes)::text AS arguments
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'public'
        AND pg_catalog.pg_get_userbyid(routine.proowner) = current_user
      ORDER BY routine.proname, arguments
    `);
    const ownedRoutineReferences = routines.rows.map((row) =>
      `public.${identifier(row.name)}(${row.arguments})`);
    const ownedRoutineSet = new Set(
      routines.rows.map((row) => `${row.name}(${row.arguments.replaceAll(" ", "")})`),
    );
    if (
      manifest.requiredFunctionExecute.some((signature) =>
        !ownedRoutineSet.has(signature))
    ) {
      throw new Error("A required PaperPilot runtime function is absent.");
    }

    await client.query("BEGIN");
    await client.query("GRANT USAGE ON SCHEMA public TO paperpilot_runtime");
    await client.query("REVOKE CREATE ON SCHEMA public FROM paperpilot_runtime");
    for (const table of ownedTables) {
      const reference = `public.${identifier(table)}`;
      await client.query(
        `REVOKE ALL PRIVILEGES ON TABLE ${reference} FROM PUBLIC, anon, authenticated, service_role, paperpilot_runtime`,
      );
      if (table === "_prisma_migrations") continue;
      if (table === "RetainedAuditPrincipal") {
        await client.query(
          `GRANT SELECT ON TABLE ${reference} TO paperpilot_runtime`,
        );
        await client.query(
          `GRANT INSERT ("createdAt", "id", "liveUserId", "organizationId") ON TABLE ${reference} TO paperpilot_runtime`,
        );
        await client.query(
          `GRANT UPDATE ("id") ON TABLE ${reference} TO paperpilot_runtime`,
        );
      } else {
        await client.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${reference} TO paperpilot_runtime`,
        );
      }
    }
    for (const row of relations.rows.filter((value) => value.kind === "S")) {
      await client.query(
        `REVOKE ALL PRIVILEGES ON SEQUENCE public.${identifier(row.name)} FROM PUBLIC, anon, authenticated, service_role, paperpilot_runtime`,
      );
    }
    for (const reference of ownedRoutineReferences) {
      await client.query(
        `REVOKE EXECUTE ON FUNCTION ${reference} FROM PUBLIC, anon, authenticated, service_role, paperpilot_runtime`,
      );
    }
    for (const signature of manifest.requiredFunctionExecute) {
      await client.query(
        `GRANT EXECUTE ON FUNCTION ${functionReference(signature)} TO paperpilot_runtime`,
      );
    }
    await client.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE paperpilot_migration_owner IN SCHEMA public
        REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role, paperpilot_runtime;
      ALTER DEFAULT PRIVILEGES FOR ROLE paperpilot_migration_owner IN SCHEMA public
        REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role, paperpilot_runtime;
      ALTER DEFAULT PRIVILEGES FOR ROLE paperpilot_migration_owner IN SCHEMA public
        REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role, paperpilot_runtime;
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
    status: "paperpilot_runtime_grants_reconciled",
    projectRef: "avmcmmayvnjxrhrmgsdx",
    applicationTableCount: expectedTables.size,
    runtimeFunctionCount: manifest.requiredFunctionExecute.length,
  });
}

async function main() {
  const result = await reconcilePaperPilotRuntimeGrants();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "blocked",
      code: "supabase_runtime_grant_reconciliation_failed",
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
