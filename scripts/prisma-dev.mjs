import "dotenv/config";

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prismaArguments = process.argv.slice(2);
if (
  prismaArguments.length !== 3
  || prismaArguments[0] !== "dev"
  || prismaArguments[1] !== "stop"
  || prismaArguments[2] !== "paperpilot"
) {
  throw new Error(
    "Local Prisma Dev start, restart, inspection, and mutation are disabled. "
      + "Only `npm run db:local:stop` is permitted so the retained archive stays offline.",
  );
}
const configuredRoot = process.env.PAPERPILOT_PRISMA_DEV_ROOT?.trim();
if (configuredRoot && !isAbsolute(configuredRoot)) {
  throw new Error("PAPERPILOT_PRISMA_DEV_ROOT must be an absolute path.");
}
const runtimeRoot = resolve(
  configuredRoot
    || (process.platform === "win32"
      ? join(parse(repositoryRoot).root, "PaperPilot-Prisma-Dev")
      : join(repositoryRoot, ".paperpilot-prisma-dev")),
);
const localAppData = join(runtimeRoot, "LocalAppData");
const temporaryDirectory = join(runtimeRoot, "Temp");
const npmCache = join(runtimeRoot, "npm-cache");

function configuredPort(name, fallback) {
  const raw = process.env[name]?.trim() || String(fallback);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer TCP port.`);
  }

  const port = Number.parseInt(raw, 10);
  if (port < 1024 || port > 65_535) {
    throw new Error(`${name} must be between 1024 and 65535.`);
  }

  return String(port);
}

const controlPort = configuredPort("PAPERPILOT_PRISMA_DEV_PORT", 51_213);
const databasePort = configuredPort("PAPERPILOT_PRISMA_DEV_DB_PORT", 51_218);
const shadowDatabasePort = configuredPort(
  "PAPERPILOT_PRISMA_DEV_SHADOW_DB_PORT",
  51_219,
);

if (new Set([controlPort, databasePort, shadowDatabasePort]).size !== 3) {
  throw new Error(
    "PAPERPILOT_PRISMA_DEV_PORT, PAPERPILOT_PRISMA_DEV_DB_PORT, and "
      + "PAPERPILOT_PRISMA_DEV_SHADOW_DB_PORT must be distinct.",
  );
}

for (const directory of [localAppData, temporaryDirectory, npmCache]) {
  mkdirSync(directory, { recursive: true });
}

const prismaCli = join(repositoryRoot, "node_modules", "prisma", "build", "index.js");
const child = spawn(process.execPath, [prismaCli, ...prismaArguments], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    LOCALAPPDATA: localAppData,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    npm_config_cache: npmCache,
  },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Unable to launch Prisma Dev from ${runtimeRoot}:`, error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Prisma Dev exited after signal ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
