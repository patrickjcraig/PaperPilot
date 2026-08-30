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
  readonly isLocalPrismaDev: boolean;
}

export interface PostgresConnectionUrlOptions {
  label?: string;
  requireTlsForNonLoopback?: boolean;
  requiredUsername?: string;
}

export const PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE:
  "supabase-avmcmmayvnjxrhrmgsdx-direct-v1";
export const PAPERPILOT_SUPABASE_PROJECT_REF: "avmcmmayvnjxrhrmgsdx";
export const PAPERPILOT_SUPABASE_DIRECT_DATABASE_HOST:
  "db.avmcmmayvnjxrhrmgsdx.supabase.co";

export function isPostgresLoopbackHost(hostname: string): boolean;
export function validatedPostgresConnectionUrl(
  rawValue: string | undefined,
  options?: PostgresConnectionUrlOptions,
): ValidatedPostgresConnectionUrl;
export function validatedPaperPilotApplicationDatabaseUrl(
  rawValue: string | undefined,
  options?: {
    databaseProfile?: string;
  },
): ValidatedApplicationDatabaseUrl;
