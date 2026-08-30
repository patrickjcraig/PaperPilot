import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repositoryRoot } from "./role-contract.mjs";
import {
  ADMIN_URL_ENV,
  executeSqlFile,
  validatedAdminConnectionUrl,
} from "./deployment-connection.mjs";

export async function main() {
  const connectionString = validatedAdminConnectionUrl(process.env[ADMIN_URL_ENV]);
  await executeSqlFile(
    connectionString,
    resolve(repositoryRoot, "deploy", "postgres", "01-bootstrap-roles.sql"),
    "paperpilot-role-bootstrap",
  );
  process.stdout.write("PaperPilot PostgreSQL role bootstrap completed.\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
