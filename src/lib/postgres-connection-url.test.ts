import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("application connections require the runtime role even through loopback proxies", () => {
  const runtimeLoopback = validatedPaperPilotApplicationDatabaseUrl(
    "postgresql://paperpilot_runtime@127.0.0.1:5432/paperpilot?sslmode=disable",
  );
  assert.equal(runtimeLoopback.username, "paperpilot_runtime");
  assert.equal(runtimeLoopback.isLocalPrismaDev, false);

  assert.throws(
    () => validatedPaperPilotApplicationDatabaseUrl(
      "postgresql://cluster_admin@127.0.0.1:5432/paperpilot?sslmode=disable",
    ),
    /authenticate as paperpilot_runtime/,
  );
  assert.throws(
    () => validatedPaperPilotApplicationDatabaseUrl(
      "postgresql://postgres:postgres@127.0.0.1:5432/template1?sslmode=disable",
      { allowLocalPrismaDev: true, nodeEnvironment: "production" },
    ),
    /authenticate as paperpilot_runtime/,
  );

  const localDevelopment = validatedPaperPilotApplicationDatabaseUrl(
    "postgresql://postgres:postgres@[::1]:5432/template1?sslmode=disable",
    { allowLocalPrismaDev: true, nodeEnvironment: "development" },
  );
  assert.equal(localDevelopment.isLocalPrismaDev, true);
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
