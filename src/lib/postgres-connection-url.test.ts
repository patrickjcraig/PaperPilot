import assert from "node:assert/strict";
import test from "node:test";

import {
  PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST,
  PAPERPILOT_SUPABASE_MIGRATION_DATABASE_PROFILE,
  PAPERPILOT_SUPABASE_PROJECT_REF,
  PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME,
  PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE,
  validatedPaperPilotApplicationDatabaseUrl,
  validatedPaperPilotMigrationDatabaseUrl,
  validatedPostgresConnectionUrl,
} from "./postgres-connection-url.mjs";

test("PostgreSQL URLs bind validation and driver connection to one closed destination", () => {
  const local = validatedPostgresConnectionUrl(
    "postgresql://paperpilot@127.0.0.1:5432/paperpilot?sslmode=disable",
    { label: "DATABASE_URL", requireTlsForNonLoopback: true },
  );
  assert.equal(local.isLoopback, true);
  assert.equal(local.sslMode, "disable");

  const remote = validatedPostgresConnectionUrl(
    "postgresql://paperpilot_runtime@db.example.test:5432/paperpilot?sslmode=verify-full",
    {
      label: "DATABASE_URL",
      requireTlsForNonLoopback: true,
      requiredUsername: "paperpilot_runtime",
    },
  );
  assert.equal(remote.hostname, "db.example.test");
  assert.equal(remote.username, "paperpilot_runtime");
  assert.equal(remote.databaseName, "paperpilot");
  assert.equal(remote.port, 5432);
  assert.equal(remote.sslMode, "verify-full");

  assert.equal(validatedPostgresConnectionUrl(
    "postgresql://paperpilot@[::1]:5432/paperpilot?sslmode=disable",
  ).isLoopback, true);

  for (const value of [
    "postgresql://paperpilot@db.example.test:5432/paperpilot",
    "postgresql://paperpilot@db.example.test:5432/paperpilot?sslmode=require",
    "postgresql://paperpilot@localhost:5432/paperpilot?host=db.example.test&sslmode=disable",
    "postgresql://paperpilot@db.example.test:5432/paperpilot?sslmode=verify-full&sslmode=disable",
    "postgresql://paperpilot@db.example.test:5432/paperpilot?service=unsafe&sslmode=verify-full",
    "postgresql://paperpilot@db.example.test:5432/paperpilot?sslmode=verify-full#ignored",
  ]) {
    assert.throws(
      () => validatedPostgresConnectionUrl(value, {
        label: "DATABASE_URL",
        requireTlsForNonLoopback: true,
      }),
      /verify-full|unsupported connection parameter|at most one sslmode|no fragment/,
    );
  }

  for (const value of [
    "postgresql://db.example.test:5432/paperpilot?sslmode=verify-full",
    "postgresql://paperpilot@db.example.test:5432?sslmode=verify-full",
    "postgresql://paperpilot@db.example.test:5432/?sslmode=verify-full",
    "postgresql://paperpilot@db.example.test/paperpilot?sslmode=verify-full",
    "postgresql://ambient_admin@db.example.test:5432/paperpilot?sslmode=verify-full",
  ]) {
    assert.throws(
      () => validatedPostgresConnectionUrl(value, {
        label: "DATABASE_URL",
        requireTlsForNonLoopback: true,
        requiredUsername: "paperpilot_runtime",
      }),
      /explicit username|database name|explicit TCP port|authenticate as paperpilot_runtime/,
    );
  }
});

test("application connections require the exact Supabase profile before parsing a target", () => {
  for (const options of [
    undefined,
    {},
    { databaseProfile: "" },
    { databaseProfile: "supabase-unreviewed-project-direct-v1" },
    // The removed local escape-hatch keys must not revive loopback access even
    // when supplied dynamically by stale deployment code.
    {
      allowLocalPrismaDev: true,
      databaseProfile: "",
      nodeEnvironment: "development",
    },
  ]) {
    assert.throws(
      () => validatedPaperPilotApplicationDatabaseUrl(
        "postgresql://postgres:postgres@127.0.0.1:51218/template1?sslmode=disable",
        options,
      ),
      /must select the approved PaperPilot Supabase transaction profile/,
    );
  }
});

test("the approved Supabase transaction profile is bound to one exact pooler", () => {
  assert.equal(PAPERPILOT_SUPABASE_PROJECT_REF, "avmcmmayvnjxrhrmgsdx");
  assert.equal(
    PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST,
    "db.avmcmmayvnjxrhrmgsdx.supabase.co",
  );

  const poolerHost = "aws-0-us-east-1.pooler.supabase.com";
  const accepted = validatedPaperPilotApplicationDatabaseUrl(
    `postgresql://${PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME}:unit%2Ftest@${poolerHost}:6543/postgres?sslmode=verify-full&pgbouncer=true`,
    {
      databaseProfile: PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE,
      poolerHost,
    },
  );
  assert.equal(accepted.hostname, poolerHost);
  assert.equal(accepted.username, PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME);
  assert.equal(accepted.databaseName, "postgres");
  assert.equal(accepted.port, 6543);
  assert.equal(accepted.sslMode, "verify-full");
  assert.equal(accepted.pgbouncer, true);
  assert.equal(accepted.isLocalPrismaDev, false);

  const rejected = [
    [
      `postgresql://${PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME}:unit@aws-0-us-west-2.pooler.supabase.com:6543/postgres?sslmode=verify-full&pgbouncer=true`,
      /configured PaperPilot Supabase transaction pooler host/,
    ],
    [
      `postgresql://${PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME}:unit@${poolerHost}:5432/postgres?sslmode=verify-full&pgbouncer=true`,
      /port 6543/,
    ],
    [
      `postgresql://${PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME}:unit@${poolerHost}:6543/paperpilot?sslmode=verify-full&pgbouncer=true`,
      /target the postgres database/,
    ],
    [
      `postgresql://${PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME}@${poolerHost}:6543/postgres?sslmode=verify-full&pgbouncer=true`,
      /explicit password/,
    ],
    [
      `postgresql://paperpilot_runtime:unit@${poolerHost}:6543/postgres?sslmode=verify-full&pgbouncer=true`,
      /authenticate as paperpilot_runtime\.avmcmmayvnjxrhrmgsdx/,
    ],
    [
      `postgresql://${PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME}:unit@${poolerHost}:6543/postgres?sslmode=verify-full`,
      /pgbouncer=true/,
    ],
    [
      `postgresql://${PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME}:unit@${poolerHost}:6543/postgres?sslmode=verify-full&pgbouncer=true&application_name=unsafe`,
      /exactly sslmode=verify-full and pgbouncer=true/,
    ],
    [
      "postgresql://paperpilot_runtime:unit@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full&pgbouncer=true",
      /authenticate as paperpilot_runtime\.avmcmmayvnjxrhrmgsdx/,
    ],
  ] as const;
  for (const [value, expected] of rejected) {
    assert.throws(
      () => validatedPaperPilotApplicationDatabaseUrl(value, {
        databaseProfile: PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE,
        poolerHost,
      }),
      expected,
    );
  }

  assert.throws(
    () => validatedPaperPilotApplicationDatabaseUrl(
      `postgresql://${PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME}:unit@${poolerHost}:6543/postgres?sslmode=verify-full&pgbouncer=true`,
      { databaseProfile: "supabase-unreviewed-project-direct-v1" },
    ),
    /must select the approved PaperPilot Supabase transaction profile/,
  );
  assert.throws(
    () => validatedPaperPilotApplicationDatabaseUrl(
      "postgresql://postgres:postgres@127.0.0.1:51218/template1?sslmode=disable",
      {
        databaseProfile: PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE,
        poolerHost,
      },
    ),
    /exactly sslmode=verify-full and pgbouncer=true/,
  );
});

test("migration authority is direct and cannot be swapped with runtime", () => {
  const accepted = validatedPaperPilotMigrationDatabaseUrl(
    "postgresql://paperpilot_migration_owner:unit%2Ftest@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full",
    { databaseProfile: PAPERPILOT_SUPABASE_MIGRATION_DATABASE_PROFILE },
  );
  assert.equal(accepted.hostname, PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST);
  assert.equal(accepted.username, "paperpilot_migration_owner");

  assert.throws(
    () => validatedPaperPilotMigrationDatabaseUrl(
      "postgresql://paperpilot_runtime:unit@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full",
      { databaseProfile: PAPERPILOT_SUPABASE_MIGRATION_DATABASE_PROFILE },
    ),
    /authenticate as paperpilot_migration_owner/,
  );
  assert.throws(
    () => validatedPaperPilotMigrationDatabaseUrl(
      "postgresql://paperpilot_migration_owner:unit@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=verify-full",
      { databaseProfile: PAPERPILOT_SUPABASE_MIGRATION_DATABASE_PROFILE },
    ),
    /approved direct Supabase postgres database/,
  );
});

test("ambient libpq variables cannot complete an incomplete authority URL", () => {
  const previous = {
    PGUSER: process.env.PGUSER,
    PGDATABASE: process.env.PGDATABASE,
    PGPORT: process.env.PGPORT,
  };
  process.env.PGUSER = "ambient_admin";
  process.env.PGDATABASE = "ambient_database";
  process.env.PGPORT = "6543";
  try {
    assert.throws(
      () => validatedPostgresConnectionUrl(
        "postgresql://db.example.test?sslmode=verify-full",
        { requireTlsForNonLoopback: true },
      ),
      /explicit username/,
    );
    assert.throws(
      () => validatedPostgresConnectionUrl(
        "postgresql://paperpilot_runtime@db.example.test:5432?sslmode=verify-full",
        { requireTlsForNonLoopback: true },
      ),
      /database name/,
    );
    assert.throws(
      () => validatedPostgresConnectionUrl(
        "postgresql://paperpilot_runtime@db.example.test/paperpilot?sslmode=verify-full",
        { requireTlsForNonLoopback: true },
      ),
      /explicit TCP port/,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
