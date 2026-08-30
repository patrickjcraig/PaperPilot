import "server-only";

import { Client } from "pg";

import { configuredPaperPilotPostgresConnection } from "@/lib/postgres-client-config.mjs";
import { PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE } from "@/lib/postgres-connection-url.mjs";

/**
 * The newest migration whose atomic schema effects this release requires.
 *
 * The runtime role deliberately has no access to Prisma's migration ledger.
 * Readiness therefore verifies one transactionally-installed catalog sentinel
 * from this migration instead of weakening that privilege boundary.
 */
const MIGRATION_SENTINELS = Object.freeze({
  "20260829254000_crawler_deleted_custody_guards": Object.freeze({
    kind: "function" as const,
    schema: "public",
    objectName: "CrawlerImport_deleted_child_consistency_check",
    identityArguments: "",
    relationKinds: Object.freeze([] as string[]),
  }),
  "20260829260000_workspace_collaboration_access": Object.freeze({
    kind: "function" as const,
    schema: "public",
    objectName: "Workspace_owner_integrity_guard",
    identityArguments: "",
    relationKinds: Object.freeze([] as string[]),
  }),
  "20260829261000_user_name_text_policy": Object.freeze({
    kind: "constraint" as const,
    schema: "public",
    objectName: "User_name_text_policy_check",
    identityArguments: "User",
    relationKinds: Object.freeze([] as string[]),
  }),
});

// Adding a newer migration requires adding its catalog sentinel above before
// this exported release requirement can move. That makes a constant-only bump
// fail type checking instead of silently probing the preceding schema.
export const EXPECTED_LATEST_MIGRATION: keyof typeof MIGRATION_SENTINELS =
  "20260829261000_user_name_text_policy";

export const EXPECTED_LATEST_MIGRATION_SENTINEL =
  MIGRATION_SENTINELS[EXPECTED_LATEST_MIGRATION];

export const READINESS_DATABASE_DEADLINE_MS = 1_500;
export const MAX_HEALTH_RESPONSE_BYTES = 128;

const MIN_DATABASE_DEADLINE_MS = 100;
const MAX_DATABASE_DEADLINE_MS = 5_000;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const PLACEHOLDER_SECRET = /(?:change[-_ ]?me|development[-_ ]?only|example[-_ ]?secret)/i;

export type HealthMethod = "GET" | "HEAD";
export type ReadinessReason =
  | "configuration_invalid"
  | "database_unavailable"
  | "migration_incomplete";

export type DatabaseReadinessResult =
  | { status: "ready" }
  | { status: "configuration-invalid" }
  | { status: "unavailable" }
  | { status: "migration-incomplete" };

export interface RuntimeReleaseContract {
  production: boolean;
  releaseId: string;
}

export type RuntimeReleaseContractResult =
  | { ok: true; value: RuntimeReleaseContract }
  | { ok: false };

export interface DatabaseProbeInput {
  deadlineMs: number;
  environment: Readonly<Record<string, string | undefined>>;
  runtime: RuntimeReleaseContract;
}

export type DatabaseReadinessProbe = (
  input: DatabaseProbeInput,
) => Promise<DatabaseReadinessResult>;

function validProductionSecret(rawValue: string | undefined): boolean {
  const value = rawValue?.trim();
  return Boolean(
    value
      && value.length >= 32
      && value !== "replace-with-at-least-32-random-characters"
      && !PLACEHOLDER_SECRET.test(value)
      && new Set(value).size >= 12,
  );
}

function validProductionOrigin(rawValue: string | undefined): boolean {
  const value = rawValue?.trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && (parsed.pathname === "" || parsed.pathname === "/")
      && parsed.origin === value.replace(/\/$/u, "");
  } catch {
    return false;
  }
}

/** Validate only the bounded, deployment-wide contract required to route web traffic. */
export function runtimeReleaseContractFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeReleaseContractResult {
  const production = environment.NODE_ENV === "production";
  const configuredReleaseId = environment.PAPERPILOT_RELEASE_ID?.trim();
  const releaseId = configuredReleaseId || (production ? "" : "development");
  if (!RELEASE_ID_PATTERN.test(releaseId)) return { ok: false };

  if (
    environment.PAPERPILOT_DATABASE_PROFILE
      !== PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE
    || environment.PAPERPILOT_ALLOW_LOCAL_PRISMA_DEV === "1"
  ) {
    return { ok: false };
  }

  if (
    production
    && (
      !validProductionOrigin(environment.BETTER_AUTH_URL)
      || !validProductionSecret(environment.BETTER_AUTH_SECRET)
      || environment.PAPERPILOT_ALLOW_INSECURE_ORIGIN === "true"
    )
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    value: Object.freeze({ production, releaseId }),
  };
}

function normalizedSearchPath(value: string): string {
  return value.replaceAll(/["\s]/gu, "");
}

function boundedDatabaseDeadline(deadlineMs: number): number | null {
  return Number.isSafeInteger(deadlineMs)
    && deadlineMs >= MIN_DATABASE_DEADLINE_MS
    && deadlineMs <= MAX_DATABASE_DEADLINE_MS
    ? deadlineMs
    : null;
}

interface DatabaseIdentityRow {
  currentUser: string;
  latestMigrationPresent: boolean;
  rowSecurity: string;
  searchPath: string;
}

export function createPaperPilotDatabaseReadinessClient(
  environment: Readonly<Record<string, string | undefined>>,
  perPhaseTimeoutMs: number,
): Client {
  if (
    !Number.isSafeInteger(perPhaseTimeoutMs)
    || perPhaseTimeoutMs < MIN_DATABASE_DEADLINE_MS
    || perPhaseTimeoutMs > MAX_DATABASE_DEADLINE_MS
  ) {
    throw new Error("The database readiness client deadline is invalid.");
  }
  const configuredConnection = configuredPaperPilotPostgresConnection(
    environment.DATABASE_URL,
    {
      caCertificatePath: environment.PAPERPILOT_DATABASE_CA_CERT_PATH,
      databaseProfile: environment.PAPERPILOT_DATABASE_PROFILE,
    },
  );
  return new Client({
    ...configuredConnection.clientConfig,
    application_name: "paperpilot-web-readiness",
    connectionTimeoutMillis: perPhaseTimeoutMs,
    query_timeout: perPhaseTimeoutMs,
    statement_timeout: perPhaseTimeoutMs,
  });
}

/**
 * Probe one fresh connection with its own connection/query/statement bounds.
 * No error text escapes this function.
 */
export async function probePaperPilotDatabaseReadiness(
  input: DatabaseProbeInput,
): Promise<DatabaseReadinessResult> {
  const deadlineMs = boundedDatabaseDeadline(input.deadlineMs);
  if (deadlineMs === null) return { status: "configuration-invalid" };

  const perPhaseTimeoutMs = Math.max(
    MIN_DATABASE_DEADLINE_MS,
    Math.floor(deadlineMs / 2),
  );
  let client: Client;
  try {
    client = createPaperPilotDatabaseReadinessClient(
      input.environment,
      perPhaseTimeoutMs,
    );
  } catch {
    return { status: "configuration-invalid" };
  }
  let connected = false;

  try {
    await client.connect();
    connected = true;
    const result = await client.query<DatabaseIdentityRow>(
      `SELECT
         current_user::text AS "currentUser",
         current_setting('search_path')::text AS "searchPath",
         current_setting('row_security')::text AS "rowSecurity",
         CASE $1::text
           WHEN 'function' THEN EXISTS (
             SELECT 1
             FROM pg_catalog.pg_proc AS routine
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid = routine.pronamespace
             WHERE namespace.nspname = $2
               AND routine.proname = $3
               AND pg_catalog.pg_get_function_identity_arguments(routine.oid) = $4
           )
            WHEN 'relation' THEN EXISTS (
             SELECT 1
             FROM pg_catalog.pg_class AS relation
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = $2
               AND relation.relname = $3
                AND relation.relkind::text = ANY($5::text[])
            )
            WHEN 'constraint' THEN EXISTS (
              SELECT 1
              FROM pg_catalog.pg_constraint AS constraint_record
              JOIN pg_catalog.pg_class AS relation
                ON relation.oid = constraint_record.conrelid
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = $2
                AND constraint_record.conname = $3
                AND relation.relname = $4
                AND constraint_record.contype = 'c'
                AND constraint_record.convalidated
            )
           ELSE false
         END AS "latestMigrationPresent"`,
      [
        EXPECTED_LATEST_MIGRATION_SENTINEL.kind,
        EXPECTED_LATEST_MIGRATION_SENTINEL.schema,
        EXPECTED_LATEST_MIGRATION_SENTINEL.objectName,
        EXPECTED_LATEST_MIGRATION_SENTINEL.identityArguments,
        EXPECTED_LATEST_MIGRATION_SENTINEL.relationKinds,
      ],
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1
      || !row
      || typeof row.currentUser !== "string"
      || typeof row.searchPath !== "string"
      || typeof row.rowSecurity !== "string"
      || typeof row.latestMigrationPresent !== "boolean"
    ) {
      return { status: "unavailable" };
    }
    if (!row.latestMigrationPresent) return { status: "migration-incomplete" };
    if (
      input.runtime.production
      && (
        row.currentUser !== "paperpilot_runtime"
        || normalizedSearchPath(row.searchPath) !== "pg_catalog,public"
        || row.rowSecurity !== "on"
      )
    ) {
      return { status: "configuration-invalid" };
    }
    return { status: "ready" };
  } catch {
    return { status: "unavailable" };
  } finally {
    if (connected) await client.end().catch(() => undefined);
    else client.end().catch(() => undefined);
  }
}

function serializedHealthResponse(
  body: { status: "live" | "ready" } | { status: "not_ready"; reason: ReadinessReason },
  status: 200 | 503,
  method: HealthMethod,
): Response {
  const serialized = JSON.stringify(body);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > MAX_HEALTH_RESPONSE_BYTES) {
    throw new Error("The fixed health response exceeded its public byte contract.");
  }
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Length": String(byteLength),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  if (status === 503) headers.set("Retry-After", "5");
  return new Response(method === "HEAD" ? null : serialized, { status, headers });
}

export function livenessResponse(method: HealthMethod): Response {
  return serializedHealthResponse({ status: "live" }, 200, method);
}

async function probeWithinDeadline(
  probe: DatabaseReadinessProbe,
  input: DatabaseProbeInput,
): Promise<DatabaseReadinessResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => probe(input)).catch(() => ({ status: "unavailable" as const })),
      new Promise<DatabaseReadinessResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: "unavailable" }), input.deadlineMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface ReadinessResponseOptions {
  databaseDeadlineMs?: number;
  databaseProbe?: DatabaseReadinessProbe;
  environment?: Readonly<Record<string, string | undefined>>;
  method: HealthMethod;
}

export async function readinessResponse(
  options: ReadinessResponseOptions,
): Promise<Response> {
  const environment = options.environment ?? process.env;
  const runtime = runtimeReleaseContractFromEnvironment(environment);
  const deadlineMs = boundedDatabaseDeadline(
    options.databaseDeadlineMs ?? READINESS_DATABASE_DEADLINE_MS,
  );
  if (!runtime.ok || deadlineMs === null) {
    return serializedHealthResponse(
      { status: "not_ready", reason: "configuration_invalid" },
      503,
      options.method,
    );
  }

  const database = await probeWithinDeadline(
    options.databaseProbe ?? probePaperPilotDatabaseReadiness,
    { deadlineMs, environment, runtime: runtime.value },
  );
  switch (database.status) {
    case "ready":
      return serializedHealthResponse({ status: "ready" }, 200, options.method);
    case "configuration-invalid":
      return serializedHealthResponse(
        { status: "not_ready", reason: "configuration_invalid" },
        503,
        options.method,
      );
    case "migration-incomplete":
      return serializedHealthResponse(
        { status: "not_ready", reason: "migration_incomplete" },
        503,
        options.method,
      );
    case "unavailable":
      return serializedHealthResponse(
        { status: "not_ready", reason: "database_unavailable" },
        503,
        options.method,
      );
  }
}
