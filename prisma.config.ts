import "dotenv/config";

import { defineConfig } from "prisma/config";

import {
  PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST,
  validatedPostgresConnectionUrl,
} from "./src/lib/postgres-connection-url.mjs";

if (process.argv[2] !== "generate") {
  throw new Error(
    "PaperPilot permits only offline `prisma generate`; database lifecycle, migration, Studio, and execute commands are disabled until the reviewed Supabase workflow exists.",
  );
}

const OFFLINE_GENERATE_URL =
  "postgresql://paperpilot_runtime:not-configured@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full";
const configuredDatabaseUrl = process.env.DATABASE_URL?.trim() || OFFLINE_GENERATE_URL;
const validatedDatabaseUrl = validatedPostgresConnectionUrl(configuredDatabaseUrl, {
  label: "DATABASE_URL",
  requireTlsForNonLoopback: true,
});
if (
  validatedDatabaseUrl.isLoopback
  || validatedDatabaseUrl.hostname !== PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST
  || validatedDatabaseUrl.port !== 5_432
  || validatedDatabaseUrl.databaseName !== "postgres"
) {
  throw new Error("Prisma CLI operations may target only the approved PaperPilot Supabase database.");
}
if (process.env.SHADOW_DATABASE_URL?.trim()) {
  throw new Error("SHADOW_DATABASE_URL is forbidden by PaperPilot's no-local-database policy.");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: validatedDatabaseUrl.connectionString,
  },
});
