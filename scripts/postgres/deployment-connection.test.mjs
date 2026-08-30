import assert from "node:assert/strict";
import test from "node:test";

import {
  validatedAdminConnectionUrl,
  validatedDeployConnectionUrl,
} from "./deployment-connection.mjs";

test("deployment URLs are closed and add only the exact owner startup policy", () => {
  const connectionString = validatedDeployConnectionUrl(
    "postgresql://ephemeral_deployer:secret@db.example.test:5432/paperpilot?sslmode=verify-full",
  );
  const parsed = new URL(connectionString);
  assert.equal(parsed.username, "ephemeral_deployer");
  assert.equal(parsed.pathname, "/paperpilot");
  assert.equal(parsed.searchParams.get("sslmode"), "verify-full");
  assert.equal(
    parsed.searchParams.get("options"),
    "-c role=paperpilot_migration_owner"
      + " -c search_path=public,pg_catalog"
      + " -c row_security=on"
      + " -c check_function_bodies=on",
  );
  assert.deepEqual([...parsed.searchParams.keys()].sort(), ["options", "sslmode"]);

  for (const username of ["paperpilot_runtime", "paperpilot_migration_owner"]) {
    assert.throws(
      () => validatedDeployConnectionUrl(
        `postgresql://${username}@127.0.0.1:5432/paperpilot?sslmode=disable`,
      ),
      /short-lived deploy login/,
    );
  }
  assert.throws(
    () => validatedDeployConnectionUrl(
      "postgresql://ephemeral_deployer@127.0.0.1:5432/postgres?sslmode=disable",
    ),
    /dedicated PaperPilot database/,
  );
  assert.throws(
    () => validatedDeployConnectionUrl(
      "postgresql://ephemeral_deployer@db.example.test:5432/paperpilot?sslmode=verify-full&options=-c%20role%3Dadmin",
    ),
    /unsupported connection parameter/,
  );
});

test("admin URLs reject runtime credentials and unsafe destinations before I/O", () => {
  assert.equal(
    validatedAdminConnectionUrl(
      "postgresql://provider_admin@db.example.test:5432/paperpilot?sslmode=verify-full",
    ),
    "postgresql://provider_admin@db.example.test:5432/paperpilot?sslmode=verify-full",
  );
  assert.throws(
    () => validatedAdminConnectionUrl(
      "postgresql://paperpilot_runtime@127.0.0.1:5432/paperpilot?sslmode=disable",
    ),
    /must not authenticate as paperpilot_runtime/,
  );
});
