import type {
  ValidatedApplicationDatabaseUrl,
} from "./postgres-connection-url.mjs";

export const PAPERPILOT_DATABASE_CA_CERT_PATH_ENV:
  "PAPERPILOT_DATABASE_CA_CERT_PATH";
export const MAX_DATABASE_CA_CERT_BYTES: 65536;
export const MAX_DATABASE_CA_CERTIFICATES: 8;
export const MAX_DATABASE_CA_CERT_PATH_CHARACTERS: 1024;

export interface PaperPilotPostgresClientConfig {
  readonly connectionString: string;
  readonly ssl?: {
    readonly ca: string;
    readonly rejectUnauthorized: true;
  };
}

export interface ConfiguredPaperPilotPostgresConnection {
  readonly connection: ValidatedApplicationDatabaseUrl;
  readonly clientConfig: PaperPilotPostgresClientConfig;
}

export function loadPaperPilotDatabaseCaCertificate(
  rawPath: string | undefined,
): string;
export function configuredPaperPilotPostgresConnection(
  rawValue: string | undefined,
  options?: {
    allowLocalPrismaDev?: boolean;
    caCertificatePath?: string;
    databaseProfile?: string;
    nodeEnvironment?: string;
  },
): ConfiguredPaperPilotPostgresConnection;
