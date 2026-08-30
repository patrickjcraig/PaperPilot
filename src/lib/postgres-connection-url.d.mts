export interface ValidatedPostgresConnectionUrl {
  readonly connectionString: string;
  readonly hostname: string;
  readonly username: string;
  readonly databaseName: string;
  readonly port: number;
  readonly pathname: string;
  readonly sslMode: string | undefined;
  readonly isLoopback: boolean;
}

export interface ValidatedApplicationDatabaseUrl extends ValidatedPostgresConnectionUrl {
  readonly pgbouncer?: true;
  readonly isLocalPrismaDev: boolean;
}

export interface PostgresConnectionUrlOptions {
  label?: string;
  requireTlsForNonLoopback?: boolean;
  requiredUsername?: string;
}

export const PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE:
  "supabase-avmcmmayvnjxrhrmgsdx-direct-v1";
export const PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE:
  "supabase-avmcmmayvnjxrhrmgsdx-transaction-v1";
export const PAPERPILOT_SUPABASE_MIGRATION_DATABASE_PROFILE:
  "supabase-avmcmmayvnjxrhrmgsdx-migration-v1";
export const PAPERPILOT_SUPABASE_BOOTSTRAP_DATABASE_PROFILE:
  "supabase-avmcmmayvnjxrhrmgsdx-bootstrap-v1";
export const PAPERPILOT_SUPABASE_PROJECT_REF: "avmcmmayvnjxrhrmgsdx";
export const PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST:
  "db.avmcmmayvnjxrhrmgsdx.supabase.co";
export const PAPERPILOT_SUPABASE_RUNTIME_DATABASE_USERNAME:
  "paperpilot_runtime.avmcmmayvnjxrhrmgsdx";
export const PAPERPILOT_SUPABASE_MIGRATION_DATABASE_USERNAME:
  "paperpilot_migration_owner";

export function isPostgresLoopbackHost(hostname: string): boolean;
export function validatedPostgresConnectionUrl(
  rawValue: string | undefined,
  options?: PostgresConnectionUrlOptions,
): ValidatedPostgresConnectionUrl;
export function validatedPaperPilotApplicationDatabaseUrl(
  rawValue: string | undefined,
  options?: {
    databaseProfile?: string;
    poolerHost?: string;
  },
): ValidatedApplicationDatabaseUrl;
export function validatedPaperPilotMigrationDatabaseUrl(
  rawValue: string | undefined,
  options?: { databaseProfile?: string },
): ValidatedApplicationDatabaseUrl;
export function validatedPaperPilotBootstrapDatabaseUrl(
  rawValue: string | undefined,
  options?: { databaseProfile?: string },
): ValidatedApplicationDatabaseUrl;
