import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { PrismaClient } from "@/generated/prisma/client";

test("the narrow retained-principal INSERT grant covers Prisma's exact emitted columns", async () => {
  const pool = new Pool();
  let captured = "";
  pool.query = (async (query: { text: string }) => {
    captured = query.text;
    throw Object.assign(new Error("captured without opening a database socket"), {
      code: "XX000",
    });
  }) as typeof pool.query;
  const client = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    await assert.rejects(client.retainedAuditPrincipal.create({
      data: { organizationId: "organization", liveUserId: "user" },
      select: { id: true },
    }));
  } finally {
    await client.$disconnect();
  }
  assert.match(
    captured,
    /INSERT INTO "public"\."RetainedAuditPrincipal" \("id","organizationId","liveUserId","createdAt"\)/,
  );
});
