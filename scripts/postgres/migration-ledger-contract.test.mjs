import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  expectedMigrationLedgerEntries,
  verifyMigrationLedgerRows,
} from "./migration-ledger-contract.mjs";

test("checked-in Prisma migrations form one exact sorted checksum contract", () => {
  const expected = expectedMigrationLedgerEntries();
  assert.ok(expected.length >= 40);
  assert.equal(new Set(expected.map((entry) => entry.migrationName)).size, expected.length);
  assert.ok(expected.every((entry) => /^[0-9a-f]{64}$/.test(entry.checksum)));
  assert.equal(expected.at(-1)?.migrationName, "20260829261000_user_name_text_policy");
});

test("authority migrations hold their preflight locks through the final sentinel", () => {
  for (const migrationName of [
    "20260829260000_workspace_collaboration_access",
    "20260829261000_user_name_text_policy",
  ]) {
    const sql = readFileSync(
      join(process.cwd(), "prisma", "migrations", migrationName, "migration.sql"),
      "utf8",
    );
    const begin = sql.indexOf("BEGIN;");
    const commit = sql.lastIndexOf("COMMIT;");
    assert.ok(begin >= 0, `${migrationName} must opt into a PostgreSQL transaction`);
    assert.ok(commit > begin, `${migrationName} must commit after its authority statements`);
    assert.equal(sql.slice(commit).trim(), "COMMIT;");
  }
});

test("ledger verification rejects missing, changed, failed, rolled-back, duplicate, and extra rows", () => {
  const expected = expectedMigrationLedgerEntries();
  const rows = expected.map((entry) => ({
    migration_name: entry.migrationName,
    checksum: entry.checksum,
    finished_at: new Date(),
    rolled_back_at: null,
    applied_steps_count: 1,
  }));
  assert.deepEqual(verifyMigrationLedgerRows(expected, rows), {
    migrationCount: expected.length,
  });
  const mutations = [
    rows.slice(1),
    rows.map((row, index) => index === 0 ? { ...row, checksum: "0".repeat(64) } : row),
    rows.map((row, index) => index === 0 ? { ...row, finished_at: null } : row),
    rows.map((row, index) => index === 0 ? { ...row, rolled_back_at: new Date() } : row),
    [...rows, rows[0]],
    [...rows, {
      migration_name: "20990101000000_unreviewed",
      checksum: "1".repeat(64),
      finished_at: new Date(),
      rolled_back_at: null,
      applied_steps_count: 1,
    }],
  ];
  for (const mutation of mutations) {
    assert.throws(
      () => verifyMigrationLedgerRows(expected, mutation),
      /migration ledger verification failed/i,
    );
  }
});
