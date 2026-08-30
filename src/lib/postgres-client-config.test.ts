import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import test from "node:test";

import { Client } from "pg";

import {
  configuredPaperPilotPostgresConnection,
  loadPaperPilotDatabaseCaCertificate,
  MAX_DATABASE_CA_CERT_BYTES,
} from "./postgres-client-config.mjs";
import {
  PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE,
} from "./postgres-connection-url.mjs";

const TEST_CA = rootCertificates[0];
assert.ok(TEST_CA, "Node must expose at least one trusted CA for this unit test");

function withTempDirectory<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "paperpilot-database-ca-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("the Supabase profile installs one explicitly verified CA in pg", () => {
  withTempDirectory((directory) => {
    const caPath = join(directory, "supabase-ca.pem");
    writeFileSync(caPath, TEST_CA, { encoding: "utf8", flag: "wx" });
    const configured = configuredPaperPilotPostgresConnection(
      "postgresql://paperpilot_runtime:unit%2Ftest@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full",
      {
        caCertificatePath: caPath,
        databaseProfile: PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE,
      },
    );

    assert.equal(configured.connection.sslMode, "verify-full");
    const driverUrl = new URL(configured.clientConfig.connectionString);
    assert.equal(driverUrl.search, "");
    assert.deepEqual(configured.clientConfig.ssl, {
      ca: TEST_CA,
      rejectUnauthorized: true,
    });

    const client = new Client(configured.clientConfig);
    const connectionParameters = (client as unknown as {
      connectionParameters: { ssl: unknown };
    }).connectionParameters;
    assert.deepEqual(connectionParameters.ssl, {
      ca: TEST_CA,
      rejectUnauthorized: true,
    });
  });
});

test("the Supabase CA loader accepts only bounded regular CA-only PEM files", () => {
  withTempDirectory((directory) => {
    const validPath = join(directory, "valid.pem");
    writeFileSync(validPath, `${TEST_CA}\n${TEST_CA}\n`, "utf8");
    assert.equal(
      loadPaperPilotDatabaseCaCertificate(validPath),
      `${TEST_CA}\n${TEST_CA}\n`,
    );

    const malformedPath = join(directory, "malformed.pem");
    writeFileSync(
      malformedPath,
      "-----BEGIN CERTIFICATE-----\nnot-base64\n-----END CERTIFICATE-----\n",
      "utf8",
    );
    assert.throws(
      () => loadPaperPilotDatabaseCaCertificate(malformedPath),
      /valid CA certificates/,
    );

    const mixedPath = join(directory, "mixed.pem");
    writeFileSync(mixedPath, `${TEST_CA}\nunreviewed trailing text\n`, "utf8");
    assert.throws(
      () => loadPaperPilotDatabaseCaCertificate(mixedPath),
      /only 1 to 8 PEM certificate blocks/,
    );

    const oversizedPath = join(directory, "oversized.pem");
    writeFileSync(oversizedPath, Buffer.alloc(MAX_DATABASE_CA_CERT_BYTES + 1, 65));
    assert.throws(
      () => loadPaperPilotDatabaseCaCertificate(oversizedPath),
      /between 1 and 65536 bytes/,
    );

    assert.throws(
      () => loadPaperPilotDatabaseCaCertificate("relative-ca.pem"),
      /bounded absolute file path/,
    );
    assert.throws(
      () => loadPaperPilotDatabaseCaCertificate(join(directory, "missing.pem")),
      /readable certificate file/,
    );
  });
});

test("CA trust cannot be omitted from Supabase or attached to another profile", () => {
  const supabaseUrl =
    "postgresql://paperpilot_runtime:unit@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full";
  assert.throws(
    () => configuredPaperPilotPostgresConnection(supabaseUrl, {
      databaseProfile: PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE,
    }),
    /PAPERPILOT_DATABASE_CA_CERT_PATH is required/,
  );
  assert.throws(
    () => configuredPaperPilotPostgresConnection(
      "postgresql://paperpilot_runtime:unit@db.example.test:5432/paperpilot?sslmode=verify-full",
      { caCertificatePath: "C:\\private\\supabase-ca.pem" },
    ),
    /allowed only with the approved Supabase profile/,
  );

  const generic = configuredPaperPilotPostgresConnection(
    "postgresql://paperpilot_runtime:unit@db.example.test:5432/paperpilot?sslmode=verify-full",
  );
  assert.equal(generic.clientConfig.connectionString.endsWith("sslmode=verify-full"), true);
  assert.equal(generic.clientConfig.ssl, undefined);
});
