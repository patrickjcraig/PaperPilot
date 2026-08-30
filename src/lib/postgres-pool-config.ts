export const PAPERPILOT_SERVERLESS_DATABASE_POOL_MAX = 1;

/**
 * PaperPilot's hackathon release admits exactly one pg connection per warm
 * serverless instance. Aggregate platform concurrency is controlled outside
 * the process; a local environment value cannot silently widen this budget.
 */
export function paperPilotDatabasePoolMaxFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = environment.DATABASE_POOL_MAX;
  if (raw === undefined || raw === "") {
    return PAPERPILOT_SERVERLESS_DATABASE_POOL_MAX;
  }
  if (raw !== String(PAPERPILOT_SERVERLESS_DATABASE_POOL_MAX)) {
    throw new Error("DATABASE_POOL_MAX must be exactly 1 for the serverless release.");
  }
  return PAPERPILOT_SERVERLESS_DATABASE_POOL_MAX;
}
