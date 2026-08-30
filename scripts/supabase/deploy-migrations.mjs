import "dotenv/config";

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRISMA_CLI = resolve(REPOSITORY_ROOT, "node_modules", "prisma", "build", "index.js");

export function exactSupabaseMigrationCommand(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length !== 0) {
    throw new Error("PaperPilot's Supabase migration command accepts no arguments.");
  }
  return Object.freeze([process.execPath, PRISMA_CLI, "migrate", "deploy"]);
}

function main() {
  const [executable, ...arguments_] = exactSupabaseMigrationCommand(
    process.argv.slice(2),
  );
  const result = spawnSync(executable, arguments_, {
    cwd: REPOSITORY_ROOT,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "blocked",
      code: "supabase_migration_command_invalid",
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
