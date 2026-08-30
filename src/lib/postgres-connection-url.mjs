const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const KNOWN_SSL_MODES = new Set([
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
]);

/**
 * Approved provider profile for the current PaperPilot Supabase project.
 *
 * The project reference and database endpoint are public routing metadata, not
 * credentials. Keeping them fixed here makes opting into the profile narrower
 * than merely accepting any host below supabase.co.
 */
export const PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE =
  "supabase-avmcmmayvnjxrhrmgsdx-direct-v1";
export const PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE =
  "supabase-avmcmmayvnjxrhrmgsdx-transaction-v1";
export const PAPERPILOT_SUPABASE_MIGRATION_DATABASE_PROFILE =
  "supabase-avmcmmayvnjxrhrmgsdx-migration-v1";
export const PAPERPILOT_SUPABASE_BOOTSTRAP_DATABASE_PROFILE =
  "supabase-avmcmmayvnjxrhrmgsdx-bootstrap-v1";
export const PAPERPILOT_SUPABASE_PROJECT_REF = "avmcmmayvnjxrhrmgsdx";
export const PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST =
  `db.${PAPERPILOT_SUPABASE_PROJECT_REF}.supabase.co`;
export const PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME =
  `paperpilot_runtime.${PAPERPILOT_SUPABASE_PROJECT_REF}`;
export const PAPERPILOT_SUPABASE_MIGRATION_DATABASE_USERNAME =
  "paperpilot_migration_owner";

const SUPABASE_POOLER_HOST_PATTERN =
  /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/u;

export function isPostgresLoopbackHost(hostname) {
  const normalized = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * Parse the same closed connection string that will be passed to `pg`.
 * Query-level host/service overrides and duplicate parameters are rejected so
 * validation cannot inspect one destination while the driver connects to
 * another. Pool sizing and application names belong in explicit client
 * options, not in this authority string.
 */
export function validatedPostgresConnectionUrl(rawValue, options = {}) {
  const label = typeof options.label === "string" && options.label
    ? options.label
    : "PostgreSQL connection URL";
  const requireTlsForNonLoopback = options.requireTlsForNonLoopback === true;
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) throw new Error(`${label} is required.`);

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute PostgreSQL URL.`);
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`${label} must use the postgres or postgresql protocol.`);
  }
  if (!parsed.hostname || parsed.hash) {
    throw new Error(`${label} must contain one authority host and no fragment.`);
  }
  let username;
  let databaseName;
  try {
    username = decodeURIComponent(parsed.username);
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error(`${label} contains invalid percent-encoding.`);
  }
  if (!username) {
    throw new Error(`${label} must contain an explicit username.`);
  }
  if (
    !databaseName
    || parsed.pathname[0] !== "/"
    || databaseName.includes("/")
    || databaseName.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(databaseName)
  ) {
    throw new Error(`${label} must contain one explicit database name.`);
  }
  if (!parsed.port) {
    throw new Error(`${label} must contain an explicit TCP port.`);
  }
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} contains an invalid TCP port.`);
  }
  if (
    typeof options.requiredUsername === "string"
    && username !== options.requiredUsername
  ) {
    throw new Error(`${label} must authenticate as ${options.requiredUsername}.`);
  }
  const parameterNames = [...new Set(parsed.searchParams.keys())];
  if (parameterNames.some((name) => name !== "sslmode")) {
    throw new Error(`${label} contains an unsupported connection parameter.`);
  }
  const sslModes = parsed.searchParams.getAll("sslmode");
  if (sslModes.length > 1) {
    throw new Error(`${label} must contain at most one sslmode.`);
  }
  const sslMode = sslModes[0]?.toLowerCase();
  if (sslMode && !KNOWN_SSL_MODES.has(sslMode)) {
    throw new Error(`${label} contains an unsupported sslmode.`);
  }
  const isLoopback = isPostgresLoopbackHost(parsed.hostname);
  if (requireTlsForNonLoopback && !isLoopback && sslMode !== "verify-full") {
    throw new Error(`${label} must use sslmode=verify-full for a non-loopback database.`);
  }

  return Object.freeze({
    connectionString: value,
    hostname: parsed.hostname,
    username,
    databaseName,
    port,
    pathname: parsed.pathname,
    sslMode,
    isLoopback,
  });
}

function normalizedConfiguredPoolerHost(rawValue) {
  if (typeof rawValue !== "string") {
    throw new Error("PAPERPILOT_SUPABASE_POOLER_HOST is required.");
  }
  const value = rawValue.trim().toLowerCase();
  if (
    !value
    || value !== rawValue
    || !SUPABASE_POOLER_HOST_PATTERN.test(value)
  ) {
    throw new Error(
      "PAPERPILOT_SUPABASE_POOLER_HOST must be the exact dashboard-issued Supavisor hostname.",
    );
  }
  return value;
}

function parsedRuntimeUrlWithoutPgbouncer(rawValue) {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) throw new Error("DATABASE_URL is required.");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be an absolute PostgreSQL URL.");
  }
  const parameterNames = [...new Set(parsed.searchParams.keys())];
  if (
    parameterNames.length !== 2
    || !parameterNames.includes("sslmode")
    || !parameterNames.includes("pgbouncer")
    || parsed.searchParams.getAll("pgbouncer").length !== 1
    || parsed.searchParams.get("pgbouncer") !== "true"
  ) {
    throw new Error(
      "DATABASE_URL must contain exactly sslmode=verify-full and pgbouncer=true.",
    );
  }
  parsed.searchParams.delete("pgbouncer");
  return Object.freeze({ original: value, validationUrl: parsed.toString() });
}

/**
 * Application/Workflow policy: one exact dashboard-issued Supavisor
 * transaction endpoint and one project-scoped runtime identity.
 */
export function validatedPaperPilotApplicationDatabaseUrl(rawValue, options = {}) {
  const configuredProfile = options.databaseProfile;
  if (configuredProfile !== undefined && typeof configuredProfile !== "string") {
    throw new Error("PAPERPILOT_DATABASE_PROFILE must be a string when configured.");
  }
  const databaseProfile = configuredProfile?.trim() ?? "";
  if (databaseProfile !== PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE) {
    throw new Error(
      "PAPERPILOT_DATABASE_PROFILE must select the approved PaperPilot Supabase transaction profile.",
    );
  }

  const poolerHost = normalizedConfiguredPoolerHost(options.poolerHost);
  const prepared = parsedRuntimeUrlWithoutPgbouncer(rawValue);
  const runtime = validatedPostgresConnectionUrl(prepared.validationUrl, {
    label: "DATABASE_URL",
    requireTlsForNonLoopback: true,
    requiredUsername: PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME,
  });

  if (runtime.hostname !== poolerHost) {
    throw new Error(
      "DATABASE_URL must target the configured PaperPilot Supabase transaction pooler host.",
    );
  }
  if (runtime.port !== 6543) {
    throw new Error(
      "DATABASE_URL must use port 6543 for the approved PaperPilot Supabase transaction profile.",
    );
  }
  if (runtime.databaseName !== "postgres") {
    throw new Error(
      "DATABASE_URL must target the postgres database for the approved PaperPilot Supabase profile.",
    );
  }
  if (!new URL(runtime.connectionString).password) {
    throw new Error(
      "DATABASE_URL must contain an explicit password for the approved PaperPilot Supabase profile.",
    );
  }
  return Object.freeze({
    ...runtime,
    connectionString: prepared.original,
    pgbouncer: true,
    isLocalPrismaDev: false,
  });
}

/** Reviewed migrations use only the direct endpoint and a separate owner. */
export function validatedPaperPilotMigrationDatabaseUrl(rawValue, options = {}) {
  const configuredProfile = options.databaseProfile;
  if (configuredProfile !== undefined && typeof configuredProfile !== "string") {
    throw new Error("PAPERPILOT_MIGRATION_DATABASE_PROFILE must be a string when configured.");
  }
  if (configuredProfile?.trim() !== PAPERPILOT_SUPABASE_MIGRATION_DATABASE_PROFILE) {
    throw new Error(
      "PAPERPILOT_MIGRATION_DATABASE_PROFILE must select the approved PaperPilot Supabase migration profile.",
    );
  }
  const migration = validatedPostgresConnectionUrl(rawValue, {
    label: "PAPERPILOT_MIGRATION_DATABASE_URL",
    requireTlsForNonLoopback: true,
    requiredUsername: PAPERPILOT_SUPABASE_MIGRATION_DATABASE_USERNAME,
  });
  if (
    migration.hostname !== PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST
    || migration.port !== 5432
    || migration.databaseName !== "postgres"
  ) {
    throw new Error(
      "PAPERPILOT_MIGRATION_DATABASE_URL must target the approved direct Supabase postgres database on port 5432.",
    );
  }
  if (!new URL(migration.connectionString).password) {
    throw new Error("PAPERPILOT_MIGRATION_DATABASE_URL must contain an explicit password.");
  }
  return Object.freeze({ ...migration, isLocalPrismaDev: false });
}

/** One-time provider administrator path used only to create PaperPilot roles. */
export function validatedPaperPilotBootstrapDatabaseUrl(rawValue, options = {}) {
  if (options.databaseProfile !== PAPERPILOT_SUPABASE_BOOTSTRAP_DATABASE_PROFILE) {
    throw new Error(
      "PAPERPILOT_BOOTSTRAP_DATABASE_PROFILE must select the approved PaperPilot Supabase bootstrap profile.",
    );
  }
  const bootstrap = validatedPostgresConnectionUrl(rawValue, {
    label: "PAPERPILOT_BOOTSTRAP_DATABASE_URL",
    requireTlsForNonLoopback: true,
    requiredUsername: "postgres",
  });
  if (
    bootstrap.hostname !== PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST
    || bootstrap.port !== 5432
    || bootstrap.databaseName !== "postgres"
  ) {
    throw new Error(
      "PAPERPILOT_BOOTSTRAP_DATABASE_URL must target the approved direct Supabase postgres database on port 5432.",
    );
  }
  if (!new URL(bootstrap.connectionString).password) {
    throw new Error("PAPERPILOT_BOOTSTRAP_DATABASE_URL must contain an explicit password.");
  }
  return Object.freeze({ ...bootstrap, isLocalPrismaDev: false });
}
