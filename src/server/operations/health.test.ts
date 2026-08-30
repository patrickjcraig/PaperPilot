import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import test from "node:test";

import {
  EXPECTED_LATEST_MIGRATION,
  MAX_HEALTH_RESPONSE_BYTES,
  createPaperPilotDatabaseReadinessClient,
  livenessResponse,
  probePaperPilotDatabaseReadiness,
  readinessResponse,
  runtimeReleaseContractFromEnvironment,
  type DatabaseReadinessProbe,
} from "./health";

const PRODUCTION_ENVIRONMENT = Object.freeze({
  NODE_ENV: "production",
  PAPERPILOT_RELEASE_ID: "paperpilot-2026.08.29+abcdef1",
  PAPERPILOT_DATABASE_PROFILE:
    "supabase-avmcmmayvnjxrhrmgsdx-direct-v1",
  BETTER_AUTH_URL: "https://paperpilot.example",
  BETTER_AUTH_SECRET: "2bN7!rQ9#xL4@vC8$kM5%tP1&wD6*zH3",
});

async function body(response: Response): Promise<unknown> {
  return JSON.parse(await response.text()) as unknown;
}

function assertCommonHeaders(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(Number(response.headers.get("content-length")) <= MAX_HEALTH_RESPONSE_BYTES);
}

test("the expected migration identity is isolated and bounded", () => {
  assert.equal(
    EXPECTED_LATEST_MIGRATION,
    "20260829261000_user_name_text_policy",
  );
  assert.match(EXPECTED_LATEST_MIGRATION, /^[0-9]{14}_[a-z0-9_]+$/u);
});

test("liveness is a fixed process-only GET and HEAD contract", async () => {
  const get = livenessResponse("GET");
  assert.equal(get.status, 200);
  assertCommonHeaders(get);
  assert.deepEqual(await body(get), { status: "live" });

  const head = livenessResponse("HEAD");
  assert.equal(head.status, 200);
  assertCommonHeaders(head);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-length"), "17");
});

test("production release configuration requires a bounded release, HTTPS origin, and real secret", () => {
  assert.deepEqual(runtimeReleaseContractFromEnvironment(PRODUCTION_ENVIRONMENT), {
    ok: true,
    value: { production: true, releaseId: "paperpilot-2026.08.29+abcdef1" },
  });

  for (const changed of [
    { PAPERPILOT_RELEASE_ID: "" },
    { PAPERPILOT_RELEASE_ID: "release with spaces" },
    { BETTER_AUTH_URL: "http://paperpilot.example" },
    { BETTER_AUTH_URL: "https://user@paperpilot.example" },
    { BETTER_AUTH_URL: "https://paperpilot.example/path" },
    { BETTER_AUTH_SECRET: "replace-with-at-least-32-random-characters" },
    { BETTER_AUTH_SECRET: "a".repeat(64) },
    { PAPERPILOT_ALLOW_INSECURE_ORIGIN: "true" },
    { PAPERPILOT_ALLOW_LOCAL_PRISMA_DEV: "1" },
    { PAPERPILOT_DATABASE_PROFILE: "" },
    { PAPERPILOT_DATABASE_PROFILE: "generic-managed-postgres" },
  ]) {
    assert.deepEqual(
      runtimeReleaseContractFromEnvironment({ ...PRODUCTION_ENVIRONMENT, ...changed }),
      { ok: false },
    );
  }
});

test("non-production readiness still requires the Supabase-only database profile", () => {
  assert.deepEqual(runtimeReleaseContractFromEnvironment({ NODE_ENV: "development" }), {
    ok: false,
  });
  assert.deepEqual(runtimeReleaseContractFromEnvironment({
    NODE_ENV: "development",
    PAPERPILOT_DATABASE_PROFILE:
      "supabase-avmcmmayvnjxrhrmgsdx-direct-v1",
  }), {
    ok: true,
    value: { production: false, releaseId: "development" },
  });
  assert.deepEqual(runtimeReleaseContractFromEnvironment({
    NODE_ENV: "test",
    PAPERPILOT_DATABASE_PROFILE:
      "supabase-avmcmmayvnjxrhrmgsdx-direct-v1",
    PAPERPILOT_RELEASE_ID: "invalid release",
  }), { ok: false });
});

test("readiness succeeds without exposing the release or migration identity", async () => {
  let calls = 0;
  const probe: DatabaseReadinessProbe = async (input) => {
    calls += 1;
    assert.equal(input.runtime.releaseId, "paperpilot-2026.08.29+abcdef1");
    assert.equal(input.runtime.production, true);
    return { status: "ready" };
  };
  const response = await readinessResponse({
    method: "GET",
    environment: PRODUCTION_ENVIRONMENT,
    databaseProbe: probe,
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assertCommonHeaders(response);
  assert.deepEqual(await body(response), { status: "ready" });
  assert.equal(response.headers.get("retry-after"), null);
});

test("invalid configuration fails before a database probe", async () => {
  let called = false;
  const response = await readinessResponse({
    method: "GET",
    environment: { ...PRODUCTION_ENVIRONMENT, PAPERPILOT_RELEASE_ID: "" },
    databaseProbe: async () => {
      called = true;
      return { status: "ready" };
    },
  });
  assert.equal(called, false);
  assert.equal(response.status, 503);
  assertCommonHeaders(response);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.deepEqual(await body(response), {
    status: "not_ready",
    reason: "configuration_invalid",
  });
});

test("local database compatibility flags cannot reach a readiness probe", async () => {
  let called = false;
  const response = await readinessResponse({
    method: "GET",
    environment: {
      ...PRODUCTION_ENVIRONMENT,
      PAPERPILOT_DATABASE_PROFILE: "",
      PAPERPILOT_ALLOW_LOCAL_PRISMA_DEV: "1",
      DATABASE_URL:
        "postgresql://postgres:postgres@127.0.0.1:51218/template1?sslmode=disable",
    },
    databaseProbe: async () => {
      called = true;
      return { status: "ready" };
    },
  });
  assert.equal(called, false);
  assert.equal(response.status, 503);
  assert.deepEqual(await body(response), {
    status: "not_ready",
    reason: "configuration_invalid",
  });
});

test("the Supabase readiness probe fails closed before I/O without its CA", async () => {
  const result = await probePaperPilotDatabaseReadiness({
    deadlineMs: 100,
    environment: {
      DATABASE_URL:
        "postgresql://paperpilot_runtime:unit@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full",
      PAPERPILOT_DATABASE_PROFILE:
        "supabase-avmcmmayvnjxrhrmgsdx-direct-v1",
    },
    runtime: { production: false, releaseId: "development" },
  });
  assert.deepEqual(result, { status: "configuration-invalid" });
});

test("the Supabase readiness client uses the configured verified CA", () => {
  const ca = rootCertificates[0];
  assert.ok(ca);
  const directory = mkdtempSync(join(tmpdir(), "paperpilot-readiness-ca-"));
  try {
    const caPath = join(directory, "supabase-ca.pem");
    writeFileSync(caPath, ca, { encoding: "utf8", flag: "wx" });
    const client = createPaperPilotDatabaseReadinessClient({
      DATABASE_URL:
        "postgresql://paperpilot_runtime:unit@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full",
      PAPERPILOT_DATABASE_CA_CERT_PATH: caPath,
      PAPERPILOT_DATABASE_PROFILE:
        "supabase-avmcmmayvnjxrhrmgsdx-direct-v1",
    }, 100);
    const parameters = (client as unknown as {
      connectionParameters: {
        application_name: unknown;
        ssl: unknown;
      };
    }).connectionParameters;
    assert.equal(parameters.application_name, "paperpilot-web-readiness");
    assert.deepEqual(parameters.ssl, { ca, rejectUnauthorized: true });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("readiness returns only fixed safe dependency reason codes", async () => {
  const cases = [
    ["configuration-invalid", "configuration_invalid"],
    ["migration-incomplete", "migration_incomplete"],
    ["unavailable", "database_unavailable"],
  ] as const;
  for (const [databaseStatus, reason] of cases) {
    const response = await readinessResponse({
      method: "GET",
      environment: PRODUCTION_ENVIRONMENT,
      databaseProbe: async () => ({ status: databaseStatus }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await body(response), { status: "not_ready", reason });
  }

  const raw = "postgres://user:secret@private.example/paperpilot";
  const thrown = await readinessResponse({
    method: "GET",
    environment: PRODUCTION_ENVIRONMENT,
    databaseProbe: async () => { throw new Error(raw); },
  });
  const serialized = await thrown.text();
  assert.equal(thrown.status, 503);
  assert.deepEqual(JSON.parse(serialized), {
    status: "not_ready",
    reason: "database_unavailable",
  });
  assert.ok(!serialized.includes(raw));
  assert.ok(!serialized.includes("secret"));
});

test("readiness enforces its outer deadline even when a probe never settles", async () => {
  const response = await readinessResponse({
    method: "GET",
    environment: PRODUCTION_ENVIRONMENT,
    databaseDeadlineMs: 100,
    databaseProbe: async () => new Promise<never>(() => undefined),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await body(response), {
    status: "not_ready",
    reason: "database_unavailable",
  });
});

test("readiness HEAD retains GET metadata and emits no body", async () => {
  const head = await readinessResponse({
    method: "HEAD",
    environment: PRODUCTION_ENVIRONMENT,
    databaseProbe: async () => ({ status: "migration-incomplete" }),
  });
  assert.equal(head.status, 503);
  assertCommonHeaders(head);
  assert.equal(head.headers.get("retry-after"), "5");
  assert.equal(await head.text(), "");
  assert.equal(
    Number(head.headers.get("content-length")),
    new TextEncoder().encode(
      JSON.stringify({ status: "not_ready", reason: "migration_incomplete" }),
    ).byteLength,
  );
});
