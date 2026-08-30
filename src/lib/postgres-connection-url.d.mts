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

export function isPostgresLoopbackHost(hostname: string): boolean;
export function validatedPostgresConnectionUrl(
  rawValue: string | undefined,
  options?: PostgresConnectionUrlOptions,
): ValidatedPostgresConnectionUrl;
export function validatedPaperPilotApplicationDatabaseUrl(
  rawValue: string | undefined,
  options?: {
    allowLocalPrismaDev?: boolean;
    nodeEnvironment?: string;
  },
): ValidatedApplicationDatabaseUrl;
