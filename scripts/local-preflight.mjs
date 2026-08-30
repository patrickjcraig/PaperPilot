import "dotenv/config";

import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseLocalDatabaseUrl(name) {
  const raw = process.env[name]?.trim();
  if (!raw) fail(`${name} is required.`);

  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${name} must be a valid PostgreSQL URL.`);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    fail(`${name} must use postgres:// or postgresql://.`);
  }
  if (!isLoopback(url.hostname)) fail(`${name} must use a loopback host for local development.`);
  if (!url.port) fail(`${name} must include an explicit TCP port.`);
  if (url.pathname === "/" || !url.pathname) fail(`${name} must include a database name.`);
  if (url.searchParams.get("sslmode") !== "disable") {
    fail(`${name} must set sslmode=disable for the loopback-only Prisma Dev database.`);
  }

  return url;
}

async function requirePath(path, label) {
  try {
    await access(path);
  } catch {
    fail(`${label} is missing: ${path}`);
  }
}

async function fetchHealth(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`http://127.0.0.1:3000${path}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) fail(`${path} returned HTTP ${response.status}: ${body}`);
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      fail(`${path} did not respond within 5 seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const configuredRoot = process.env.PAPERPILOT_PRISMA_DEV_ROOT?.trim();
if (configuredRoot && !isAbsolute(configuredRoot)) {
  fail("PAPERPILOT_PRISMA_DEV_ROOT must be an absolute path.");
}

const runtimeRoot = resolve(
  configuredRoot
    || (process.platform === "win32"
      ? join(parse(repositoryRoot).root, "PaperPilot-Prisma-Dev")
      : join(repositoryRoot, ".paperpilot-prisma-dev")),
);

if (
  process.platform === "win32"
  && parse(runtimeRoot).root.toLowerCase() !== parse(repositoryRoot).root.toLowerCase()
) {
  fail(
    `The Prisma Dev runtime (${runtimeRoot}) must remain on the repository drive `
      + `(${parse(repositoryRoot).root}).`,
  );
}

const dataRoot = join(runtimeRoot, "LocalAppData", "prisma-dev-nodejs", "Data");
const namedDataRoot = join(dataRoot, "paperpilot");
await requirePath(runtimeRoot, "Prisma Dev runtime root");
await requirePath(dataRoot, "Prisma Dev data root");
await requirePath(namedDataRoot, "PaperPilot named database root");

const databaseUrl = parseLocalDatabaseUrl("DATABASE_URL");
const shadowDatabaseUrl = parseLocalDatabaseUrl("SHADOW_DATABASE_URL");
if (databaseUrl.port === shadowDatabaseUrl.port) {
  fail("DATABASE_URL and SHADOW_DATABASE_URL must use distinct ports.");
}

const client = new Client({ connectionString: databaseUrl.toString() });
let database;
try {
  await client.connect();
  const identity = await client.query(
    "select current_database() as database_name, current_user as user_name, "
      + "current_setting('row_security') as row_security",
  );
  const tables = await client.query(
    "select count(*)::int as table_count from pg_catalog.pg_tables where schemaname = 'public'",
  );
  database = {
    host: databaseUrl.hostname,
    port: Number.parseInt(databaseUrl.port, 10),
    database: identity.rows[0].database_name,
    user: identity.rows[0].user_name,
    rowSecurity: identity.rows[0].row_security,
    publicTableCount: tables.rows[0].table_count,
  };
} finally {
  await client.end().catch(() => undefined);
}

const pgAdminCandidates = process.platform === "win32"
  ? [
      process.env.PAPERPILOT_PGADMIN_EXE?.trim(),
      process.env.USERPROFILE
        ? join(
            process.env.USERPROFILE,
            "AppData",
            "Local",
            "Programs",
            "pgAdmin 4",
            "runtime",
            "pgAdmin4.exe",
          )
        : undefined,
      "C:\\Program Files\\pgAdmin 4\\runtime\\pgAdmin4.exe",
    ].filter(Boolean)
  : [];

let pgAdminExecutable = null;
for (const candidate of pgAdminCandidates) {
  try {
    await access(candidate);
    pgAdminExecutable = candidate;
    break;
  } catch {
    // Try the next supported install location.
  }
}

if (process.platform === "win32" && !pgAdminExecutable) {
  fail(
    "pgAdmin 4 is required for this local Windows workflow. Install PostgreSQL.pgAdmin "
      + "with winget or set PAPERPILOT_PGADMIN_EXE.",
  );
}

const [live, ready] = await Promise.all([fetchHealth("/livez"), fetchHealth("/readyz")]);

console.log(JSON.stringify({
  status: "ready",
  application: {
    origin: "http://127.0.0.1:3000",
    live,
    ready,
  },
  database: {
    ...database,
    persistentRoot: runtimeRoot,
    namedDataRoot,
    shadowPort: Number.parseInt(shadowDatabaseUrl.port, 10),
  },
  pgAdmin: {
    installed: Boolean(pgAdminExecutable),
    executable: pgAdminExecutable,
    registeredProfile: "PaperPilot Local",
    profileFile: join(repositoryRoot, "deploy", "local", "pgadmin-servers.json"),
  },
}, null, 2));
