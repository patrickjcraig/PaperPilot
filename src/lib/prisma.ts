import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { validatedPaperPilotApplicationDatabaseUrl } from "@/lib/postgres-connection-url.mjs";

const databaseConnection = validatedPaperPilotApplicationDatabaseUrl(
  process.env.DATABASE_URL,
  {
    allowLocalPrismaDev: process.env.PAPERPILOT_ALLOW_LOCAL_PRISMA_DEV === "1",
    nodeEnvironment: process.env.NODE_ENV,
  },
);
const databaseUrl = databaseConnection.connectionString;
const isLoopbackDatabase = databaseConnection.isLoopback;
const isLocalPrismaDev = databaseConnection.isLocalPrismaDev && isLoopbackDatabase;
const configuredPoolSize = Number(process.env.DATABASE_POOL_MAX);
const poolSize = Number.isSafeInteger(configuredPoolSize) && configuredPoolSize > 0
  ? configuredPoolSize
  : isLocalPrismaDev ? 1 : 10;
const isSerializedLocalPool = isLocalPrismaDev && poolSize === 1;

const adapter = new PrismaPg({
  connectionString: databaseUrl,
  // Prisma Dev is most reliable with one connection, so concurrent local
  // transactions queue here instead of opening additional protocol sessions.
  // Give that intentional queue longer than Prisma's local transaction wait.
  connectionTimeoutMillis: isSerializedLocalPool ? 35_000 : 5_000,
  max: poolSize,
});

const prismaGlobal = globalThis as unknown as {
  paperPilotPrisma?: PrismaClient;
};

export const prisma = prismaGlobal.paperPilotPrisma ?? new PrismaClient({
  adapter,
  ...(isSerializedLocalPool
    ? {
        transactionOptions: {
          // A cold PGlite-backed bootstrap walks the complete visible graph
          // sequentially on its one physical connection. Leave enough room
          // for that bounded local read without changing managed-Postgres
          // transaction deadlines.
          maxWait: 60_000,
          timeout: 30_000,
        },
      }
    : {}),
});

if (process.env.NODE_ENV !== "production") {
  prismaGlobal.paperPilotPrisma = prisma;
}
