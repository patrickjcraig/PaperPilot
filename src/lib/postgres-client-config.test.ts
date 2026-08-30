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
  PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME,
  PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE,
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

test("the Supabase transaction profile installs verified TLS in pg", () => {
  withTempDirectory((directory) => {
    const caPath = join(directory, "supabase-ca.pem");
    writeFileSync(caPath, TEST_CA, { encoding: "utf8", flag: "wx" });
    const configured = configuredPaperPilotPostgresConnection(
      `postgresql://${PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME}:unit%2Ftest@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=verify-full&pgbouncer=true`,
      {
        caCertificatePath: caPath,
        databaseProfile: PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE,
        poolerHost: "aws-0-us-east-1.pooler.supabase.com",
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

test("verified TLS and the approved transaction profile are mandatory", () => {
  const supabaseUrl =
    `postgresql://${PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME}:unit@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=verify-full&pgbouncer=true`;
  assert.deepEqual(
    configuredPaperPilotPostgresConnection(supabaseUrl, {
      databaseProfile: PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE,
      poolerHost: "aws-0-us-east-1.pooler.supabase.com",
    }).clientConfig.ssl,
    { rejectUnauthorized: true },
  );
  assert.throws(
    () => configuredPaperPilotPostgresConnection(
      "postgresql://paperpilot_runtime:unit@db.example.test:5432/paperpilot?sslmode=verify-full",
      {
        caCertificatePath: "C:\\private\\supabase-ca.pem",
        databaseProfile: PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE,
        poolerHost: "aws-0-us-east-1.pooler.supabase.com",
      },
    ),
    /pgbouncer=true|authenticate as paperpilot_runtime/,
  );
  assert.throws(
    () => configuredPaperPilotPostgresConnection(
      "postgresql://postgres:postgres@127.0.0.1:51218/template1?sslmode=disable",
      { databaseProfile: "" },
    ),
    /must select the approved PaperPilot Supabase transaction profile/,
  );
});
