import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repositoryRoot } from "./role-contract.mjs";
import {
  DEPLOY_URL_ENV,
  executeSqlFile,
  validatedDeployConnectionUrl,
} from "./deployment-connection.mjs";

export async function main() {
  const connectionString = validatedDeployConnectionUrl(process.env[DEPLOY_URL_ENV]);
  await executeSqlFile(
    connectionString,
    resolve(repositoryRoot, "deploy", "postgres", "migration-preflight.sql"),
    "paperpilot-grant-preflight",
  );
  await executeSqlFile(
    connectionString,
    resolve(repositoryRoot, "deploy", "postgres", "02-runtime-grants.sql"),
    "paperpilot-runtime-grant-reconciler",
  );
  process.stdout.write("PaperPilot runtime grants reconciled.\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
