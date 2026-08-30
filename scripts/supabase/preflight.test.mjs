import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPABASE_API_ORIGIN,
  SUPABASE_DATABASE_HOST,
  SUPABASE_PROJECT_REF,
  SUPABASE_STORAGE_GATEWAY,
  SupabasePreflightError,
  runSupabaseEndpointPreflight,
} from "./preflight.mjs";

function response({ projectRef = SUPABASE_PROJECT_REF, status = 401 } = {}) {
  return new Response("{}", {
    status,
    headers: { "sb-project-ref": projectRef },
  });
}

const successfulDependencies = {
  fetchImpl: async (url) => response({
    status: url === SUPABASE_STORAGE_GATEWAY ? 400 : 401,
  }),
  lookupImpl: async () => [{ address: "2001:db8::1", family: 6 }],
  tcpProbeImpl: async () => true,
};

test("Supabase endpoint preflight is fixed to the PaperPilot project", async () => {
  const requestedUrls = [];
  const result = await runSupabaseEndpointPreflight({
    ...successfulDependencies,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return response({ status: url === SUPABASE_STORAGE_GATEWAY ? 400 : 401 });
    },
  });
  assert.deepEqual(requestedUrls, [
    `${SUPABASE_API_ORIGIN}/rest/v1/`,
    SUPABASE_STORAGE_GATEWAY,
  ]);
  assert.equal(result.projectRef, SUPABASE_PROJECT_REF);
  assert.equal(result.databaseHost, SUPABASE_DATABASE_HOST);
  assert.equal(result.status, "endpoint_ready");
  assert.deepEqual(result.notChecked, [
    "database_authentication",
    "database_roles",
    "database_migrations",
    "storage_bucket",
    "storage_credentials",
  ]);
});

test("Supabase endpoint preflight rejects an unexpected gateway identity", async () => {
  await assert.rejects(
    runSupabaseEndpointPreflight({
      ...successfulDependencies,
      fetchImpl: async (url) => response({
        projectRef: url.endsWith("/rest/v1/") ? "different-project" : SUPABASE_PROJECT_REF,
        status: url === SUPABASE_STORAGE_GATEWAY ? 400 : 401,
      }),
    }),
    (error) => error instanceof SupabasePreflightError
      && error.code === "api_gateway_project_mismatch",
  );
});

test("Supabase endpoint preflight requires the unauthenticated gateway to fail closed", async () => {
  await assert.rejects(
    runSupabaseEndpointPreflight({
      ...successfulDependencies,
      fetchImpl: async (url) => response({
        status: url === SUPABASE_STORAGE_GATEWAY ? 400 : 200,
      }),
    }),
    (error) => error instanceof SupabasePreflightError
      && error.code === "api_gateway_did_not_require_key",
  );
});

test("Supabase endpoint preflight rejects a public or mismatched Storage gateway", async () => {
  await assert.rejects(
    runSupabaseEndpointPreflight({
      ...successfulDependencies,
      fetchImpl: async (url) => response({
        status: url === SUPABASE_STORAGE_GATEWAY ? 200 : 401,
      }),
    }),
    (error) => error instanceof SupabasePreflightError
      && error.code === "storage_gateway_did_not_require_authorization",
  );
  await assert.rejects(
    runSupabaseEndpointPreflight({
      ...successfulDependencies,
      fetchImpl: async (url) => response({
        projectRef: url === SUPABASE_STORAGE_GATEWAY
          ? "different-project"
          : SUPABASE_PROJECT_REF,
        status: url === SUPABASE_STORAGE_GATEWAY ? 400 : 401,
      }),
    }),
    (error) => error instanceof SupabasePreflightError
      && error.code === "storage_gateway_project_mismatch",
  );
});

test("Supabase endpoint preflight rejects missing database routing", async () => {
  await assert.rejects(
    runSupabaseEndpointPreflight({
      ...successfulDependencies,
      lookupImpl: async () => [],
    }),
    (error) => error instanceof SupabasePreflightError
      && error.code === "database_dns_empty",
  );
  await assert.rejects(
    runSupabaseEndpointPreflight({
      ...successfulDependencies,
      tcpProbeImpl: async () => false,
    }),
    (error) => error instanceof SupabasePreflightError
      && error.code === "database_tcp_unreachable",
  );
});
