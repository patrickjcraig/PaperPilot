import { pathToFileURL } from "node:url";

const SUPPORTED_NAMES = new Set([
  "db:dev",
  "db:migrate",
  "db:studio",
  "db:deploy",
  "db:roles:bootstrap",
  "db:roles:reconcile",
  "db:roles:retire-deployer",
  "db:roles:verify",
  "db:roles:smoke",
  "db:migrations:verify",
  "db:authority:snapshot",
  "test:integration",
]);

export function localWriteCommandDisabledMessage(rawName) {
  const name = typeof rawName === "string" && SUPPORTED_NAMES.has(rawName)
    ? rawName
    : "local database operation";
  return `${name} is disabled: PaperPilot may not start, mutate, inspect, or test against a local database. Database operations remain fail-closed until their Supabase-specific authority workflow is reviewed.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stderr.write(`${localWriteCommandDisabledMessage(process.argv[2])}\n`);
  process.exitCode = 1;
}
