const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const KNOWN_SSL_MODES = new Set([
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
]);

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

/**
 * Application/worker policy: every live connection authenticates as the fixed
 * runtime role, including localhost proxies. The one exception is an explicit
 * non-production Prisma Dev template1 connection using the local postgres
 * account and disabled loopback TLS.
 */
export function validatedPaperPilotApplicationDatabaseUrl(rawValue, options = {}) {
  const parsed = validatedPostgresConnectionUrl(rawValue, {
    label: "DATABASE_URL",
    requireTlsForNonLoopback: true,
  });
  const isLocalPrismaDev =
    options.allowLocalPrismaDev === true
    && options.nodeEnvironment !== "production"
    && parsed.isLoopback
    && parsed.username === "postgres"
    && parsed.pathname === "/template1"
    && parsed.sslMode === "disable";
  if (isLocalPrismaDev) {
    return Object.freeze({ ...parsed, isLocalPrismaDev: true });
  }
  const runtime = validatedPostgresConnectionUrl(rawValue, {
    label: "DATABASE_URL",
    requireTlsForNonLoopback: true,
    requiredUsername: "paperpilot_runtime",
  });
  return Object.freeze({ ...runtime, isLocalPrismaDev: false });
}
