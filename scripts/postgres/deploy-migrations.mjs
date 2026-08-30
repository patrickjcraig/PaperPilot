import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repositoryRoot } from "./role-contract.mjs";
import {
  DEPLOY_URL_ENV,
  executeSqlFile,
  validatedDeployConnectionUrl,
} from "./deployment-connection.mjs";

function runPrismaMigrateDeploy(connectionString) {
  const prismaCli = resolve(repositoryRoot, "node_modules", "prisma", "build", "index.js");
  const childEnvironment = { ...process.env, DATABASE_URL: connectionString };
  delete childEnvironment.SHADOW_DATABASE_URL;
  delete childEnvironment[DEPLOY_URL_ENV];

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [prismaCli, "migrate", "deploy"], {
      cwd: repositoryRoot,
      env: childEnvironment,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(
        `Prisma migrate deploy failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`,
      ));
    });
  });
}

export async function main() {
  const connectionString = validatedDeployConnectionUrl(process.env[DEPLOY_URL_ENV]);
  await executeSqlFile(
    connectionString,
    resolve(repositoryRoot, "deploy", "postgres", "migration-preflight.sql"),
    "paperpilot-migration-preflight",
  );
  await runPrismaMigrateDeploy(connectionString);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
