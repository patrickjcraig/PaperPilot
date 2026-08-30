import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { repositoryRoot } from "./role-contract.mjs";

const MIGRATION_NAME = /^[0-9]{14}_[a-z0-9_]+$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function expectedMigrationLedgerEntries(
  migrationsDirectory = resolve(repositoryRoot, "prisma", "migrations"),
) {
  const entries = readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      if (!MIGRATION_NAME.test(entry.name)) {
        throw new TypeError(`Invalid Prisma migration directory: ${entry.name}`);
      }
      const migration = readFileSync(
        resolve(migrationsDirectory, entry.name, "migration.sql"),
      );
      return Object.freeze({
        migrationName: entry.name,
        checksum: createHash("sha256").update(migration).digest("hex"),
      });
    })
    .sort((left, right) => left.migrationName.localeCompare(right.migrationName));
  if (entries.length === 0) throw new TypeError("No Prisma migrations were found.");
  if (new Set(entries.map((entry) => entry.migrationName)).size !== entries.length) {
    throw new TypeError("Prisma migration names must be unique.");
  }
  return Object.freeze(entries);
}

export function verifyMigrationLedgerRows(expected, rows) {
  if (!Array.isArray(rows)) throw new TypeError("Migration ledger rows must be an array.");
  const normalized = rows.map((row) => ({
    migrationName: row.migration_name,
    checksum: row.checksum,
    finished: row.finished_at instanceof Date,
    rolledBack: row.rolled_back_at instanceof Date,
    appliedStepsCount: Number(row.applied_steps_count),
  }));
  const problems = [];
  for (const row of normalized) {
    if (
      typeof row.migrationName !== "string"
      || !MIGRATION_NAME.test(row.migrationName)
      || typeof row.checksum !== "string"
      || !SHA256.test(row.checksum)
    ) {
      problems.push("The migration ledger contains a malformed row.");
    }
    if (!row.finished || row.rolledBack || row.appliedStepsCount !== 1) {
      problems.push(`Migration ${row.migrationName} is not one clean completed application.`);
    }
  }
  const actualByName = new Map();
  for (const row of normalized) {
    if (actualByName.has(row.migrationName)) {
      problems.push(`Migration ${row.migrationName} has multiple ledger attempts.`);
    }
    actualByName.set(row.migrationName, row);
  }
  for (const entry of expected) {
    const row = actualByName.get(entry.migrationName);
    if (!row) problems.push(`Migration ${entry.migrationName} is missing.`);
    else if (row.checksum !== entry.checksum) {
      problems.push(`Migration ${entry.migrationName} checksum differs from source control.`);
    }
  }
  const expectedNames = new Set(expected.map((entry) => entry.migrationName));
  for (const row of normalized) {
    if (!expectedNames.has(row.migrationName)) {
      problems.push(`Unreviewed migration ${row.migrationName} exists in the ledger.`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Prisma migration ledger verification failed:\n- ${[...new Set(problems)].join("\n- ")}`);
  }
  return Object.freeze({ migrationCount: expected.length });
}
