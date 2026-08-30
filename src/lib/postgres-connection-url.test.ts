import assert from "node:assert/strict";
import test from "node:test";

import {
  PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST,
  PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE,
  PAPERPILOT_SUPABASE_PROJECT_REF,
  validatedPaperPilotApplicationDatabaseUrl,
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
      /must select the approved PaperPilot Supabase profile/,
    );
  }
});

test("the approved Supabase direct profile is bound to one project and endpoint", () => {
  assert.equal(PAPERPILOT_SUPABASE_PROJECT_REF, "avmcmmayvnjxrhrmgsdx");
  assert.equal(
    PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST,
    "db.avmcmmayvnjxrhrmgsdx.supabase.co",
  );

  const accepted = validatedPaperPilotApplicationDatabaseUrl(
    "postgresql://paperpilot_runtime:unit%2Ftest@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full",
    { databaseProfile: PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE },
  );
  assert.equal(accepted.hostname, PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST);
  assert.equal(accepted.username, "paperpilot_runtime");
  assert.equal(accepted.databaseName, "postgres");
  assert.equal(accepted.port, 5432);
  assert.equal(accepted.sslMode, "verify-full");
  assert.equal(accepted.isLocalPrismaDev, false);

  const rejected = [
    [
      "postgresql://paperpilot_runtime:unit@db.otherprojectref.supabase.co:5432/postgres?sslmode=verify-full",
      /approved PaperPilot Supabase direct database host/,
    ],
    [
      "postgresql://paperpilot_runtime:unit@db.avmcmmayvnjxrhrmgsdx.supabase.co:6543/postgres?sslmode=verify-full",
      /port 5432/,
    ],
    [
      "postgresql://paperpilot_runtime:unit@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/paperpilot?sslmode=verify-full",
      /target the postgres database/,
    ],
    [
      "postgresql://paperpilot_runtime@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full",
      /explicit password/,
    ],
    [
      "postgresql://postgres:unit@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full",
      /authenticate as paperpilot_runtime/,
    ],
    [
      "postgresql://paperpilot_runtime.avmcmmayvnjxrhrmgsdx:unit@aws-0-example.pooler.supabase.com:5432/postgres?sslmode=verify-full",
      /authenticate as paperpilot_runtime/,
    ],
    [
      "postgresql://paperpilot_runtime:unit@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=C%3A%2Funsafe.pem",
      /unsupported connection parameter/,
    ],
  ] as const;
  for (const [value, expected] of rejected) {
    assert.throws(
      () => validatedPaperPilotApplicationDatabaseUrl(value, {
        databaseProfile: PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE,
      }),
      expected,
    );
  }

  assert.throws(
    () => validatedPaperPilotApplicationDatabaseUrl(
      "postgresql://paperpilot_runtime:unit@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full",
      { databaseProfile: "supabase-unreviewed-project-direct-v1" },
    ),
    /must select the approved PaperPilot Supabase profile/,
  );
  assert.throws(
    () => validatedPaperPilotApplicationDatabaseUrl(
      "postgresql://postgres:postgres@127.0.0.1:51218/template1?sslmode=disable",
      {
        databaseProfile: PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE,
      },
    ),
    /authenticate as paperpilot_runtime/,
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
