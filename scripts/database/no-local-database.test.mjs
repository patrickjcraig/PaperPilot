import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  NoLocalDatabasePolicyError,
  verifyNoLocalDatabaseWrites,
} from "./no-local-database.mjs";
import { localWriteCommandDisabledMessage } from "./local-write-command-disabled.mjs";
import { commandForSupabaseRuntimeOperation } from "./run-with-supabase-database.mjs";

const PROFILE = "supabase-avmcmmayvnjxrhrmgsdx-transaction-v1";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SAFE_ENVIRONMENT = Object.freeze({
  PAPERPILOT_DATABASE_PROFILE: PROFILE,
  PAPERPILOT_ALLOW_LOCAL_PRISMA_DEV: "0",
  PAPERPILOT_SUPABASE_POOLER_HOST: "aws-0-us-east-1.pooler.supabase.com",
  DATABASE_URL: "",
  SHADOW_DATABASE_URL: "",
});

const unreachable = async () => "closed";

test("an offline archive with no configured runtime URL is write-frozen", async () => {
  const result = await verifyNoLocalDatabaseWrites({
    environment: SAFE_ENVIRONMENT,
    tcpProbeImpl: unreachable,
  });
  assert.equal(result.status, "local_database_write_frozen");
  assert.equal(result.configuredApplicationTarget, "not_configured");
  assert.deepEqual(result.checkedLocalPorts, [5432, 51213, 51218, 51219]);
});

test("the exact Supabase application target is accepted without opening it", async () => {
  const result = await verifyNoLocalDatabaseWrites({
    environment: {
      ...SAFE_ENVIRONMENT,
      DATABASE_URL:
        "postgresql://paperpilot_runtime.avmcmmayvnjxrhrmgsdx:unit@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=verify-full&pgbouncer=true",
    },
    tcpProbeImpl: unreachable,
  });
  assert.equal(
    result.configuredApplicationTarget,
    "aws-0-us-east-1.pooler.supabase.com",
  );
});

test("local escape flags, URLs, shadow databases, and listeners fail closed", async () => {
  const cases = [
    {
      environment: { ...SAFE_ENVIRONMENT, PAPERPILOT_DATABASE_PROFILE: "" },
      code: "approved_supabase_profile_required",
    },
    {
      environment: { ...SAFE_ENVIRONMENT, PAPERPILOT_ALLOW_LOCAL_PRISMA_DEV: "1" },
      code: "local_database_escape_enabled",
    },
    {
      environment: {
        ...SAFE_ENVIRONMENT,
        DATABASE_URL:
          "postgresql://postgres:postgres@127.0.0.1:51218/template1?sslmode=disable",
      },
      code: "database_authority_invalid",
    },
    {
      environment: {
        ...SAFE_ENVIRONMENT,
        SHADOW_DATABASE_URL:
          "postgresql://postgres:postgres@127.0.0.1:51219/template1?sslmode=disable",
      },
      code: "local_shadow_database_forbidden",
    },
  ];
  for (const input of cases) {
    await assert.rejects(
      verifyNoLocalDatabaseWrites({
        environment: input.environment,
        tcpProbeImpl: unreachable,
      }),
      (error) => error instanceof NoLocalDatabasePolicyError
        && error.code === input.code,
    );
  }

  await assert.rejects(
    verifyNoLocalDatabaseWrites({
      environment: SAFE_ENVIRONMENT,
      tcpProbeImpl: async (_host, port) => port === 51218 ? "open" : "closed",
    }),
    (error) => error instanceof NoLocalDatabasePolicyError
      && error.code === "local_database_listener_detected",
  );

  await assert.rejects(
    verifyNoLocalDatabaseWrites({
      environment: SAFE_ENVIRONMENT,
      tcpProbeImpl: async () => "indeterminate",
    }),
    (error) => error instanceof NoLocalDatabasePolicyError
      && error.code === "local_database_listener_probe_indeterminate",
  );
});

test("generic hosted and alternate Supabase authorities are rejected", async () => {
  for (const databaseUrl of [
    "postgresql://paperpilot_runtime:unit@db.example.test:5432/postgres?sslmode=verify-full",
    "postgresql://paperpilot_runtime:unit@db.otherprojectref.supabase.co:5432/postgres?sslmode=verify-full",
  ]) {
    await assert.rejects(
      verifyNoLocalDatabaseWrites({
        environment: { ...SAFE_ENVIRONMENT, DATABASE_URL: databaseUrl },
        tcpProbeImpl: unreachable,
      }),
      (error) => error instanceof NoLocalDatabasePolicyError
        && error.code === "database_authority_invalid",
    );
  }

  await assert.rejects(
    verifyNoLocalDatabaseWrites({
      environment: {
        ...SAFE_ENVIRONMENT,
        PAPERPILOT_SUPABASE_DATABASE_URL:
          "postgresql://postgres:local@127.0.0.1:5432/postgres?sslmode=disable",
      },
      tcpProbeImpl: unreachable,
    }),
    (error) => error instanceof NoLocalDatabasePolicyError
      && error.code === "database_authority_invalid",
  );
});

test("supported package commands cannot start or mutate the retired local database", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(REPOSITORY_ROOT, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["db:dev"],
    "node scripts/database/local-write-command-disabled.mjs db:dev",
  );
  assert.equal(
    packageJson.scripts["db:migrate"],
    "node scripts/database/local-write-command-disabled.mjs db:migrate",
  );
  assert.equal(
    packageJson.scripts["db:studio"],
    "node scripts/database/local-write-command-disabled.mjs db:studio",
  );
  assert.equal(
    packageJson.scripts["test:integration"],
    "node scripts/database/local-write-command-disabled.mjs test:integration",
  );
  for (const operation of [
    "db:roles:bootstrap",
    "db:roles:reconcile",
    "db:roles:retire-deployer",
    "db:roles:verify",
    "db:roles:smoke",
    "db:migrations:verify",
    "db:authority:snapshot",
  ]) {
    assert.equal(
      packageJson.scripts[operation],
      `node scripts/database/local-write-command-disabled.mjs ${operation}`,
    );
    assert.match(localWriteCommandDisabledMessage(operation), /disabled/u);
  }
  assert.equal(
    packageJson.scripts["db:deploy"],
    "node scripts/supabase/deploy-migrations.mjs",
  );
  assert.doesNotMatch(
    JSON.stringify(packageJson.scripts),
    /prisma\s+(?:dev|studio|db\s+(?:push|execute|seed)|validate|format)|prisma\s+migrate\s+(?:dev|reset)/u,
  );
  assert.match(localWriteCommandDisabledMessage("db:dev"), /disabled/u);

  const runtimeOperations = [
    "dev",
    "dev:local",
    "start",
    "worker:validation",
    "worker:extraction",
    "worker:zotero",
    "worker:zotero-attachments",
    "worker:crawler",
  ];
  for (const operation of runtimeOperations) {
    assert.equal(
      packageJson.scripts[operation],
      `node scripts/database/run-with-supabase-database.mjs ${operation}`,
    );
    const command = commandForSupabaseRuntimeOperation(operation);
    assert.equal(command[0], process.execPath);
    assert.ok(command.length >= 3);
  }
  assert.throws(
    () => commandForSupabaseRuntimeOperation("unreviewed"),
    /not approved/,
  );

  const directPrismaCommands = Object.values(packageJson.scripts)
    .filter((command) => /(?:^|\s)prisma(?:\s|$)/u.test(command));
  assert.deepEqual(directPrismaCommands.sort(), [
    "prisma generate",
    "prisma generate",
  ]);

  const directPrismaDev = spawnSync(
    process.execPath,
    [resolve(REPOSITORY_ROOT, "node_modules/prisma/build/index.js"), "dev", "--help"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", windowsHide: true },
  );
  assert.notEqual(directPrismaDev.status, 0);
  assert.match(
    `${directPrismaDev.stdout}${directPrismaDev.stderr}`,
    /permits only offline `prisma generate` or the exact reviewed Supabase `prisma migrate deploy` path/u,
  );
});
