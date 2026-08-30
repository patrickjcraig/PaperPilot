import { lookup as dnsLookup } from "node:dns/promises";
import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";

export const SUPABASE_PROJECT_REF = "avmcmmayvnjxrhrmgsdx";
export const SUPABASE_API_ORIGIN = `https://${SUPABASE_PROJECT_REF}.supabase.co`;
export const SUPABASE_DATABASE_HOST = `db.${SUPABASE_PROJECT_REF}.supabase.co`;
export const SUPABASE_STORAGE_GATEWAY = `${SUPABASE_API_ORIGIN}/storage/v1/bucket`;
const DATABASE_PORT = 5432;
const DEFAULT_TIMEOUT_MS = 5_000;

export class SupabasePreflightError extends Error {
  constructor(code) {
    super(code);
    this.name = "SupabasePreflightError";
    this.code = code;
  }
}

function boundedTimeout(value) {
  return Number.isSafeInteger(value) && value >= 500 && value <= 30_000
    ? value
    : DEFAULT_TIMEOUT_MS;
}

function defaultTcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Verify only public routing metadata. This command never accepts, reads, or
 * prints a database password, Supabase API key, or Storage credential.
 */
export async function runSupabaseEndpointPreflight({
  fetchImpl = globalThis.fetch,
  lookupImpl = dnsLookup,
  tcpProbeImpl = defaultTcpProbe,
  timeoutMs: rawTimeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new SupabasePreflightError("fetch_unavailable");
  }
  const timeoutMs = boundedTimeout(rawTimeoutMs);
  let response;
  try {
    response = await fetchImpl(`${SUPABASE_API_ORIGIN}/rest/v1/`, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new SupabasePreflightError("api_gateway_unreachable");
  }
  try {
    if (response.status !== 401) {
      throw new SupabasePreflightError("api_gateway_did_not_require_key");
    }
    if (response.headers.get("sb-project-ref") !== SUPABASE_PROJECT_REF) {
      throw new SupabasePreflightError("api_gateway_project_mismatch");
    }
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }

  let storageResponse;
  try {
    storageResponse = await fetchImpl(SUPABASE_STORAGE_GATEWAY, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new SupabasePreflightError("storage_gateway_unreachable");
  }
  try {
    if (![400, 401].includes(storageResponse.status)) {
      throw new SupabasePreflightError("storage_gateway_did_not_require_authorization");
    }
    if (storageResponse.headers.get("sb-project-ref") !== SUPABASE_PROJECT_REF) {
      throw new SupabasePreflightError("storage_gateway_project_mismatch");
    }
  } finally {
    await storageResponse.body?.cancel().catch(() => undefined);
  }

  let addresses;
  try {
    addresses = await lookupImpl(SUPABASE_DATABASE_HOST, {
      all: true,
      verbatim: true,
    });
  } catch {
    throw new SupabasePreflightError("database_dns_unreachable");
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new SupabasePreflightError("database_dns_empty");
  }

  const tcpReachable = await tcpProbeImpl(
    SUPABASE_DATABASE_HOST,
    DATABASE_PORT,
    timeoutMs,
  );
  if (tcpReachable !== true) {
    throw new SupabasePreflightError("database_tcp_unreachable");
  }

  return Object.freeze({
    schemaVersion: 1,
    status: "endpoint_ready",
    projectRef: SUPABASE_PROJECT_REF,
    apiOrigin: SUPABASE_API_ORIGIN,
    databaseHost: SUPABASE_DATABASE_HOST,
    databasePort: DATABASE_PORT,
    checks: Object.freeze({
      restGateway: "reachable_and_requires_api_key",
      storageGateway: "reachable_and_requires_authorization",
      databaseDns: "resolved",
      databaseTcp: "reachable",
    }),
    notChecked: Object.freeze([
      "database_authentication",
      "database_roles",
      "database_migrations",
      "storage_bucket",
      "storage_credentials",
    ]),
  });
}

async function main() {
  try {
    const result = await runSupabaseEndpointPreflight();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof SupabasePreflightError
      ? error.code
      : "unexpected_preflight_failure";
    process.stderr.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "blocked",
      projectRef: SUPABASE_PROJECT_REF,
      code,
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
