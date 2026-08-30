import "dotenv/config";

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifySupabaseRuntimeConfiguration } from "./no-local-database.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const nextCli = join(repositoryRoot, "node_modules", "next", "dist", "bin", "next");
const tsxCli = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");

const OPERATIONS = Object.freeze({
  dev: Object.freeze([nextCli, "dev"]),
  "dev:local": Object.freeze([nextCli, "dev", "--hostname", "127.0.0.1"]),
  start: Object.freeze([nextCli, "start"]),
  "worker:validation": Object.freeze([
    tsxCli,
    "--conditions=react-server",
    "src/workers/document-validation-worker.ts",
  ]),
  "worker:extraction": Object.freeze([
    tsxCli,
    "--conditions=react-server",
    "src/workers/document-extraction-worker.ts",
  ]),
  "worker:zotero": Object.freeze([
    tsxCli,
    "--conditions=react-server",
    "src/workers/zotero-sync-worker.ts",
  ]),
  "worker:zotero-attachments": Object.freeze([
    tsxCli,
    "--conditions=react-server",
    "src/workers/zotero-attachment-download-worker.ts",
  ]),
  "worker:crawler": Object.freeze([
    tsxCli,
    "--conditions=react-server",
    "src/workers/governed-crawler-worker.ts",
  ]),
});

export function commandForSupabaseRuntimeOperation(name, extraArguments = []) {
  const command = OPERATIONS[name];
  if (!command) throw new Error("The requested Supabase runtime operation is not approved.");
  if (!Array.isArray(extraArguments) || extraArguments.some((value) => typeof value !== "string")) {
    throw new Error("Runtime arguments are invalid.");
  }
  return Object.freeze([process.execPath, ...command, ...extraArguments]);
}

export async function main() {
  const operation = process.argv[2];
  await verifySupabaseRuntimeConfiguration();
  const [executable, ...argumentsList] = commandForSupabaseRuntimeOperation(
    operation,
    process.argv.slice(3),
  );
  const child = spawn(executable, argumentsList, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", (error) => {
    process.stderr.write(`Unable to start the approved Supabase runtime: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.stderr.write(`The approved Supabase runtime stopped after signal ${signal}.\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Supabase runtime configuration failed."}\n`);
    process.exitCode = 1;
  });
}
