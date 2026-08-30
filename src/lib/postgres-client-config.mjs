import { X509Certificate } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute } from "node:path";

import {
  PAPERPILOT_SUPABASE_BOOTSTRAP_DATABASE_PROFILE,
  PAPERPILOT_SUPABASE_MIGRATION_DATABASE_PROFILE,
  PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE,
  validatedPaperPilotApplicationDatabaseUrl,
  validatedPaperPilotBootstrapDatabaseUrl,
  validatedPaperPilotMigrationDatabaseUrl,
} from "./postgres-connection-url.mjs";

export const PAPERPILOT_DATABASE_CA_CERT_PATH_ENV =
  "PAPERPILOT_DATABASE_CA_CERT_PATH";
export const MAX_DATABASE_CA_CERT_BYTES = 65_536;
export const MAX_DATABASE_CA_CERTIFICATES = 8;
export const MAX_DATABASE_CA_CERT_PATH_CHARACTERS = 1_024;

const CERTIFICATE_BLOCK_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu;

function caConfigurationError(message) {
  return new Error(`${PAPERPILOT_DATABASE_CA_CERT_PATH_ENV} ${message}`);
}

/**
 * Load one bounded, regular-file PEM CA bundle without placing its path in an
 * error. Certificate bytes are public trust material, but the configured
 * server path remains an internal deployment detail.
 */
export function loadPaperPilotDatabaseCaCertificate(rawPath) {
  if (typeof rawPath !== "string" || !rawPath) {
    throw caConfigurationError("is required for the approved Supabase profile.");
  }
  if (
    rawPath !== rawPath.trim()
    || rawPath.length > MAX_DATABASE_CA_CERT_PATH_CHARACTERS
    || /[\u0000-\u001f\u007f]/u.test(rawPath)
    || !isAbsolute(rawPath)
  ) {
    throw caConfigurationError("must be one bounded absolute file path.");
  }

  let descriptor;
  try {
    const pathEntry = lstatSync(rawPath);
    if (pathEntry.isSymbolicLink() || !pathEntry.isFile()) {
      throw caConfigurationError("must identify one regular non-symbolic-link file.");
    }
    descriptor = openSync(rawPath, "r");
    const openedFile = fstatSync(descriptor);
    if (
      !openedFile.isFile()
      || openedFile.size < 1
      || openedFile.size > MAX_DATABASE_CA_CERT_BYTES
    ) {
      throw caConfigurationError(
        `must contain between 1 and ${MAX_DATABASE_CA_CERT_BYTES} bytes.`,
      );
    }

    const bounded = Buffer.alloc(MAX_DATABASE_CA_CERT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.length) {
      const count = readSync(
        descriptor,
        bounded,
        bytesRead,
        bounded.length - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    const finalFile = fstatSync(descriptor);
    if (
      bytesRead < 1
      || bytesRead > MAX_DATABASE_CA_CERT_BYTES
      || finalFile.size !== bytesRead
    ) {
      throw caConfigurationError(
        `must remain a stable file of at most ${MAX_DATABASE_CA_CERT_BYTES} bytes while loading.`,
      );
    }

    let pem;
    try {
      pem = new TextDecoder("utf-8", { fatal: true }).decode(
        bounded.subarray(0, bytesRead),
      );
    } catch {
      throw caConfigurationError("must contain valid UTF-8 PEM text.");
    }
    const certificates = [...pem.matchAll(CERTIFICATE_BLOCK_PATTERN)].map(
      (match) => match[0],
    );
    const remainder = pem.replaceAll(CERTIFICATE_BLOCK_PATTERN, "").trim();
    if (
      certificates.length < 1
      || certificates.length > MAX_DATABASE_CA_CERTIFICATES
      || remainder
    ) {
      throw caConfigurationError(
        `must contain only 1 to ${MAX_DATABASE_CA_CERTIFICATES} PEM certificate blocks.`,
      );
    }
    try {
      for (const certificate of certificates) {
        const parsed = new X509Certificate(certificate);
        if (!parsed.ca) {
          throw new Error("not a CA certificate");
        }
      }
    } catch {
      throw caConfigurationError("must contain only valid CA certificates.");
    }
    return pem;
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith(`${PAPERPILOT_DATABASE_CA_CERT_PATH_ENV} `)
    ) {
      throw error;
    }
    throw caConfigurationError("must identify a readable certificate file.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Build the driver configuration only after the public authority URL passes
 * its closed policy. For Supabase, remove the already-validated sslmode from
 * the internal driver URL because pg connection-string parameters override an
 * explicit `ssl` object. The replacement below is stricter and carries the
 * reviewed CA while retaining hostname verification.
 */
export function configuredPaperPilotPostgresConnection(rawValue, options = {}) {
  const connection = validatedPaperPilotApplicationDatabaseUrl(rawValue, options);
  const databaseProfile = options.databaseProfile?.trim() ?? "";
  const rawCaPath = options.caCertificatePath;
  if (rawCaPath !== undefined && typeof rawCaPath !== "string") {
    throw caConfigurationError("must be a string when configured.");
  }

  if (databaseProfile === PAPERPILOT_SUPABASE_TRANSACTION_DATABASE_PROFILE) {
    const ca = rawCaPath
      ? loadPaperPilotDatabaseCaCertificate(rawCaPath)
      : undefined;
    const driverUrl = new URL(connection.connectionString);
    driverUrl.searchParams.delete("sslmode");
    driverUrl.searchParams.delete("pgbouncer");
    if ([...driverUrl.searchParams.keys()].length !== 0) {
      throw new Error("The validated Supabase driver URL retained an unexpected parameter.");
    }
    return Object.freeze({
      connection,
      clientConfig: Object.freeze({
        connectionString: driverUrl.toString(),
        ssl: Object.freeze({ ...(ca ? { ca } : {}), rejectUnauthorized: true }),
      }),
    });
  }

  if (rawCaPath) {
    throw caConfigurationError("is allowed only with the approved Supabase profile.");
  }
  return Object.freeze({
    connection,
    clientConfig: Object.freeze({ connectionString: connection.connectionString }),
  });
}

/** Build the direct, migration-only driver configuration. */
export function configuredPaperPilotMigrationPostgresConnection(rawValue, options = {}) {
  const connection = validatedPaperPilotMigrationDatabaseUrl(rawValue, options);
  const databaseProfile = options.databaseProfile?.trim() ?? "";
  const rawCaPath = options.caCertificatePath;
  if (rawCaPath !== undefined && typeof rawCaPath !== "string") {
    throw caConfigurationError("must be a string when configured.");
  }
  if (databaseProfile !== PAPERPILOT_SUPABASE_MIGRATION_DATABASE_PROFILE) {
    throw new Error("The approved Supabase migration profile is required.");
  }
  const ca = rawCaPath
    ? loadPaperPilotDatabaseCaCertificate(rawCaPath)
    : undefined;
  const driverUrl = new URL(connection.connectionString);
  driverUrl.searchParams.delete("sslmode");
  if ([...driverUrl.searchParams.keys()].length !== 0) {
    throw new Error("The validated Supabase migration URL retained an unexpected parameter.");
  }
  return Object.freeze({
    connection,
    clientConfig: Object.freeze({
      connectionString: driverUrl.toString(),
      ssl: Object.freeze({ ...(ca ? { ca } : {}), rejectUnauthorized: true }),
    }),
  });
}

/** Build the one-time provider-administrator connection without weakening migrations. */
export function configuredPaperPilotBootstrapPostgresConnection(rawValue, options = {}) {
  const connection = validatedPaperPilotBootstrapDatabaseUrl(rawValue, options);
  if (options.databaseProfile !== PAPERPILOT_SUPABASE_BOOTSTRAP_DATABASE_PROFILE) {
    throw new Error("The approved Supabase bootstrap profile is required.");
  }
  const rawCaPath = options.caCertificatePath;
  if (rawCaPath !== undefined && typeof rawCaPath !== "string") {
    throw caConfigurationError("must be a string when configured.");
  }
  const ca = rawCaPath
    ? loadPaperPilotDatabaseCaCertificate(rawCaPath)
    : undefined;
  const driverUrl = new URL(connection.connectionString);
  driverUrl.searchParams.delete("sslmode");
  return Object.freeze({
    connection,
    clientConfig: Object.freeze({
      connectionString: driverUrl.toString(),
      ssl: Object.freeze({ ...(ca ? { ca } : {}), rejectUnauthorized: true }),
    }),
  });
}
