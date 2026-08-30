import assert from "node:assert/strict";
import test from "node:test";

import { exactSupabaseMigrationCommand } from "./deploy-migrations.mjs";

test("the Supabase migration wrapper emits one exact Prisma command", () => {
  const command = exactSupabaseMigrationCommand([]);
  assert.equal(command[0], process.execPath);
  assert.match(command[1], /node_modules[\\/]prisma[\\/]build[\\/]index\.js$/u);
  assert.deepEqual(command.slice(2), ["migrate", "deploy"]);
});

test("the Supabase migration wrapper rejects every forwarded option", () => {
  for (const arguments_ of [
    ["--schema", "other.prisma"],
    ["--config", "other.ts"],
    ["--help"],
    ["extra"],
  ]) {
    assert.throws(
      () => exactSupabaseMigrationCommand(arguments_),
      /accepts no arguments/,
    );
  }
});
