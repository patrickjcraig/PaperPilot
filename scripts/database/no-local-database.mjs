import "dotenv/config";

import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";

import {
  PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST,
  PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE,
  validatedPaperPilotApplicationDatabaseUrl,
  validatedPaperPilotBootstrapDatabaseUrl,
  validatedPaperPilotMigrationDatabaseUrl,
  validatedPostgresConnectionUrl,
} from "../../src/lib/postgres-connection-url.mjs";
import { configuredPaperPilotPostgresConnection } from "../../src/lib/postgres-client-config.mjs";

const DEFAULT_LOCAL_DATABASE_PORTS = Object.freeze([5_432, 51_213, 51_218, 51_219]);
const DATABASE_AUTHORITY_ENVIRONMENTS = Object.freeze([
  "DATABASE_URL",
  "PAPERPILOT_SUPABASE_DATABASE_URL",
  "PAPERPILOT_ADMIN_DATABASE_URL",
  "PAPERPILOT_DEPLOY_DATABASE_URL",
  "PAPERPILOT_MIGRATION_AUDIT_DATABASE_URL",
  "PAPERPILOT_ROLE_AUDIT_DATABASE_URL",
  "PAPERPILOT_MIGRATION_DATABASE_URL",
  "PAPERPILOT_BOOTSTRAP_DATABASE_URL",
]);
const CONFIGURED_LOCAL_PORT_ENVIRONMENTS = Object.freeze([
  "PAPERPILOT_PRISMA_DEV_PORT",
  "PAPERPILOT_PRISMA_DEV_DB_PORT",
  "PAPERPILOT_PRISMA_DEV_SHADOW_DB_PORT",
]);

export class NoLocalDatabasePolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = "NoLocalDatabasePolicyError";
    this.code = code;
  }
}

function policyFailure(code) {
  throw new NoLocalDatabasePolicyError(code);
}

function boundedLocalPorts(environment) {
  const ports = new Set(DEFAULT_LOCAL_DATABASE_PORTS);
  for (const name of CONFIGURED_LOCAL_PORT_ENVIRONMENTS) {
    const raw = environment[name]?.trim();
    if (!raw) continue;
    if (!/^\d+$/u.test(raw)) policyFailure("local_database_port_invalid");
    const port = Number(raw);
    if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
      policyFailure("local_database_port_invalid");
    }
    ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

function defaultTcpProbe(host, port, timeoutMs = 250) {
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(state);
    };
    try {
      socket = createConnection({ host, port });
    } catch {
      finish("indeterminate");
      return;
    }
    socket.setTimeout(timeoutMs, () => finish("indeterminate"));
    socket.once("connect", () => finish("open"));
    socket.once("error", (error) => {
      const definitelyClosed = new Set([
        "EADDRNOTAVAIL",
        "EAFNOSUPPORT",
        "ECONNREFUSED",
        "ENETUNREACH",
      ]);
      finish(definitelyClosed.has(error.code) ? "closed" : "indeterminate");
    });
  });
}

function validateConfiguredAuthority(name, rawValue, environment) {
  const value = rawValue?.trim();
  if (!value) return null;

  if (name === "DATABASE_URL" || name === "PAPERPILOT_SUPABASE_DATABASE_URL") {
    return validatedPaperPilotApplicationDatabaseUrl(value, {
      databaseProfile: environment.PAPERPILOT_DATABASE_PROFILE,
      poolerHost: environment.PAPERPILOT_SUPABASE_POOLER_HOST,
    });
  }

  if (name === "PAPERPILOT_MIGRATION_DATABASE_URL") {
    return validatedPaperPilotMigrationDatabaseUrl(value, {
      databaseProfile: environment.PAPERPILOT_MIGRATION_DATABASE_PROFILE,
    });
  }

  if (name === "PAPERPILOT_BOOTSTRAP_DATABASE_URL") {
    return validatedPaperPilotBootstrapDatabaseUrl(value, {
      databaseProfile: environment.PAPERPILOT_BOOTSTRAP_DATABASE_PROFILE,
    });
  }

  const parsed = validatedPostgresConnectionUrl(value, {
    label: name,
    requireTlsForNonLoopback: true,
  });
  if (
    parsed.isLoopback
    || parsed.hostname !== PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST
    || parsed.port !== 5_432
    || parsed.databaseName !== "postgres"
  ) {
    policyFailure("database_authority_not_approved_supabase");
  }
  return parsed;
}

/**
 * Prove that supported PaperPilot configuration cannot target the retired
 * loopback database and that its known listener ports are closed. This check
 * performs no database connection, query, file write, or process start.
 */
export async function verifyNoLocalDatabaseWrites({
  environment = process.env,
  tcpProbeImpl = defaultTcpProbe,
} = {}) {
  if (
    environment.PAPERPILOT_DATABASE_PROFILE
      !== PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE
  ) {
    policyFailure("approved_supabase_profile_required");
  }
  if (environment.PAPERPILOT_ALLOW_LOCAL_PRISMA_DEV === "1") {
    policyFailure("local_database_escape_enabled");
  }
  if (environment.SHADOW_DATABASE_URL?.trim()) {
    policyFailure("local_shadow_database_forbidden");
  }

  let configuredApplicationTarget = null;
  try {
    for (const name of DATABASE_AUTHORITY_ENVIRONMENTS) {
      const parsed = validateConfiguredAuthority(
        name,
        environment[name],
        environment,
      );
      if (
        (name === "DATABASE_URL" || name === "PAPERPILOT_SUPABASE_DATABASE_URL")
        && parsed
      ) {
        configuredApplicationTarget = parsed.hostname;
      }
    }
  } catch (error) {
    if (error instanceof NoLocalDatabasePolicyError) throw error;
    policyFailure("database_authority_invalid");
  }

  const localPorts = boundedLocalPorts(environment);
  const observations = await Promise.all(
    localPorts.flatMap((port) => ["127.0.0.1", "::1"].map(async (host) => ({
      host,
      port,
      state: await tcpProbeImpl(host, port),
    }))),
  );
  if (observations.some((observation) => observation.state === "open")) {
    policyFailure("local_database_listener_detected");
  }
  if (observations.some((observation) => observation.state !== "closed")) {
    policyFailure("local_database_listener_probe_indeterminate");
  }

  return Object.freeze({
    schemaVersion: 1,
    status: "local_database_write_frozen",
    databaseProfile: PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE,
    configuredApplicationTarget: configuredApplicationTarget ?? "not_configured",
    checkedLocalPorts: Object.freeze(localPorts),
  });
}

/** Validate all server-side connection material without opening a socket. */
export async function verifySupabaseRuntimeConfiguration({
  environment = process.env,
  tcpProbeImpl = defaultTcpProbe,
} = {}) {
  const freeze = await verifyNoLocalDatabaseWrites({ environment, tcpProbeImpl });
  configuredPaperPilotPostgresConnection(environment.DATABASE_URL, {
    caCertificatePath: environment.PAPERPILOT_DATABASE_CA_CERT_PATH,
    databaseProfile: environment.PAPERPILOT_DATABASE_PROFILE,
    poolerHost: environment.PAPERPILOT_SUPABASE_POOLER_HOST,
  });
  return Object.freeze({
    ...freeze,
    status: "supabase_runtime_configuration_ready",
  });
}

async function main() {
  try {
    const result = await verifyNoLocalDatabaseWrites();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof NoLocalDatabasePolicyError
      ? error.code
      : "unexpected_local_database_policy_failure";
    process.stderr.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "blocked",
      code,
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
