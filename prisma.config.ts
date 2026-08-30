import "dotenv/config";

import { defineConfig } from "prisma/config";

import {
  PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST,
  PAPERPILOT_SUPABASE_MIGRATION_DATABASE_PROFILE,
  validatedPaperPilotMigrationDatabaseUrl,
  validatedPostgresConnectionUrl,
} from "./src/lib/postgres-connection-url.mjs";

const prismaArguments = process.argv.slice(2);
const isOfflineGenerate = prismaArguments[0] === "generate";
const isReviewedMigrationDeploy =
  prismaArguments.length === 2
  && prismaArguments[0] === "migrate"
  && prismaArguments[1] === "deploy";

if (!isOfflineGenerate && !isReviewedMigrationDeploy) {
  throw new Error(
    "PaperPilot permits only offline `prisma generate` or the exact reviewed Supabase `prisma migrate deploy` path.",
  );
}

const OFFLINE_GENERATE_URL =
  "postgresql://paperpilot_migration_owner:not-configured@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full";
const validatedDatabaseUrl = isReviewedMigrationDeploy
  ? validatedPaperPilotMigrationDatabaseUrl(
    process.env.PAPERPILOT_MIGRATION_DATABASE_URL,
    { databaseProfile: process.env.PAPERPILOT_MIGRATION_DATABASE_PROFILE },
  )
  : validatedPostgresConnectionUrl(OFFLINE_GENERATE_URL, {
    label: "offline Prisma generate URL",
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
if (
  isReviewedMigrationDeploy
  && process.env.PAPERPILOT_MIGRATION_DATABASE_PROFILE
    !== PAPERPILOT_SUPABASE_MIGRATION_DATABASE_PROFILE
) {
  throw new Error("The approved PaperPilot Supabase migration profile is required.");
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
