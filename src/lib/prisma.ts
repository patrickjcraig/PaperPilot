import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { configuredPaperPilotPostgresConnection } from "@/lib/postgres-client-config.mjs";
import { paperPilotDatabasePoolMaxFromEnvironment } from "@/lib/postgres-pool-config";

const prismaGlobal = globalThis as unknown as {
  paperPilotPrisma?: PrismaClient;
};

function configuredPrismaClient() {
  if (prismaGlobal.paperPilotPrisma) return prismaGlobal.paperPilotPrisma;

  const configuredDatabase = configuredPaperPilotPostgresConnection(
    process.env.DATABASE_URL,
    {
      caCertificatePath: process.env.PAPERPILOT_DATABASE_CA_CERT_PATH,
      databaseProfile: process.env.PAPERPILOT_DATABASE_PROFILE,
      poolerHost: process.env.PAPERPILOT_SUPABASE_POOLER_HOST,
    },
  );
  const poolSize = paperPilotDatabasePoolMaxFromEnvironment(process.env);
  const adapter = new PrismaPg({
    ...configuredDatabase.clientConfig,
    connectionTimeoutMillis: 5_000,
    max: poolSize,
  });
  const client = new PrismaClient({ adapter });
  if (process.env.NODE_ENV !== "production") {
    prismaGlobal.paperPilotPrisma = client;
  }
  return client;
}

// Importing server modules during a build or an injected-database unit test must
// not parse a URL, open a socket, or create a pool. The first real Prisma member
// access performs the exact Supabase-only validation before client creation.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = configuredPrismaClient();
    const value = Reflect.get(client, property, client) as unknown;
    return typeof value === "function" ? value.bind(client) : value;
  },
});
