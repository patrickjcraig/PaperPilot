import "server-only";

import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_UPLOAD_SESSION_TTL_MS = 15 * 60 * 1_000;
export const DEFAULT_UPLOAD_LEASE_TTL_MS = 10 * 60 * 1_000;
export const DEFAULT_UPLOAD_STREAM_IDLE_TIMEOUT_MS = 30 * 1_000;
export const DEFAULT_UPLOAD_STREAM_ABSOLUTE_TIMEOUT_MS = 5 * 60 * 1_000;
export const DEFAULT_UPLOAD_MAX_CONCURRENT_PER_USER = 2;
export const DEFAULT_UPLOAD_MAX_CONCURRENT_PER_WORKSPACE = 10;
export const DEFAULT_UPLOAD_MAX_RETAINED_BYTES_PER_WORKSPACE = 250 * 1024 * 1024;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;

export interface UploadConfiguration {
  /** Absolute, server-private filesystem root. Never expose this value to clients. */
  quarantineRoot: string;
  maxUploadBytes: number;
  sessionTtlMs: number;
  leaseTtlMs: number;
  streamIdleTimeoutMs: number;
  streamAbsoluteTimeoutMs: number;
  maxConcurrentUploadsPerUser: number;
  maxConcurrentUploadsPerWorkspace: number;
  maxRetainedBytesPerWorkspace: number;
}

function positiveSafeInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a canonical positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function secondsAsMilliseconds(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallbackMilliseconds: number,
): number {
  const fallbackSeconds = fallbackMilliseconds / 1_000;
  const seconds = positiveSafeInteger(environment, name, fallbackSeconds);
  if (seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
    throw new Error(`${name} is too large to represent safely in milliseconds.`);
  }
  return seconds * 1_000;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function canonicalExistingRoot(root: string, required: boolean): string | null {
  try {
    const information = lstatSync(root);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new Error(
        "PAPERPILOT_UPLOAD_QUARANTINE_ROOT must identify one real private directory.",
      );
    }
    const canonical = realpathSync.native(root);
    if (required && path.relative(root, canonical) !== "") {
      throw new Error(
        "PAPERPILOT_UPLOAD_QUARANTINE_ROOT must be canonical and cannot traverse a symlink or junction in production.",
      );
    }
    return canonical;
  } catch (error) {
    if (!required && nodeErrorCode(error) === "ENOENT") return null;
    if (error instanceof Error && error.message.startsWith("PAPERPILOT_")) throw error;
    throw new Error(
      "PAPERPILOT_UPLOAD_QUARANTINE_ROOT must be a pre-provisioned private directory in production.",
    );
  }
}

function rejectServedRoot(
  root: string,
  canonicalRoot: string | null,
  workingDirectory: string,
): void {
  for (const servedRoot of [
    path.resolve(workingDirectory, "public"),
    path.resolve(workingDirectory, ".next", "static"),
  ]) {
    if (isWithin(servedRoot, root)) {
      throw new Error(
        "PAPERPILOT_UPLOAD_QUARANTINE_ROOT must not be inside an application-served directory.",
      );
    }
    if (canonicalRoot) {
      try {
        const canonicalServedRoot = realpathSync.native(servedRoot);
        if (isWithin(canonicalServedRoot, canonicalRoot)) {
          throw new Error(
            "PAPERPILOT_UPLOAD_QUARANTINE_ROOT must not resolve inside an application-served directory.",
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("PAPERPILOT_")) throw error;
        if (nodeErrorCode(error) !== "ENOENT") {
          throw new Error("PaperPilot could not verify that the upload root is private.");
        }
      }
    }
  }
}

function privateQuarantineRoot(
  environment: Readonly<Record<string, string | undefined>>,
  workingDirectory: string,
): string {
  const configured = environment.PAPERPILOT_UPLOAD_QUARANTINE_ROOT;
  const production = environment.NODE_ENV === "production";
  if (production && configured === undefined) {
    throw new Error(
      "PAPERPILOT_UPLOAD_QUARANTINE_ROOT is required in production.",
    );
  }

  const raw = configured
    ?? path.join(workingDirectory, ".paperpilot-data", "quarantine");
  if (
    raw.length === 0
    || raw !== raw.trim()
    || CONTROL_CHARACTER_PATTERN.test(raw)
    || !path.isAbsolute(raw)
  ) {
    throw new Error(
      "PAPERPILOT_UPLOAD_QUARANTINE_ROOT must be an absolute private path without surrounding whitespace or control characters.",
    );
  }

  // The quarantine directory is a runtime-mounted private volume. It is not a
  // build input and must not cause Turbopack to trace the whole repository.
  const root = path.resolve(/* turbopackIgnore: true */ raw);
  if (root === path.parse(root).root) {
    throw new Error("PAPERPILOT_UPLOAD_QUARANTINE_ROOT cannot be a filesystem root.");
  }

  const canonicalRoot = canonicalExistingRoot(root, production);
  rejectServedRoot(root, canonicalRoot, workingDirectory);
  return root;
}

export function uploadConfigurationFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  workingDirectory = process.cwd(),
): UploadConfiguration {
  if (!path.isAbsolute(workingDirectory)) {
    throw new Error("The upload configuration working directory must be absolute.");
  }

  const maxUploadBytes = positiveSafeInteger(
    environment,
    "PAPERPILOT_UPLOAD_MAX_BYTES",
    DEFAULT_UPLOAD_MAX_BYTES,
  );
  const sessionTtlMs = secondsAsMilliseconds(
    environment,
    "PAPERPILOT_UPLOAD_SESSION_TTL_SECONDS",
    DEFAULT_UPLOAD_SESSION_TTL_MS,
  );
  const leaseTtlMs = secondsAsMilliseconds(
    environment,
    "PAPERPILOT_UPLOAD_LEASE_TTL_SECONDS",
    DEFAULT_UPLOAD_LEASE_TTL_MS,
  );
  const streamIdleTimeoutMs = secondsAsMilliseconds(
    environment,
    "PAPERPILOT_UPLOAD_STREAM_IDLE_TIMEOUT_SECONDS",
    DEFAULT_UPLOAD_STREAM_IDLE_TIMEOUT_MS,
  );
  const streamAbsoluteTimeoutMs = secondsAsMilliseconds(
    environment,
    "PAPERPILOT_UPLOAD_STREAM_ABSOLUTE_TIMEOUT_SECONDS",
    DEFAULT_UPLOAD_STREAM_ABSOLUTE_TIMEOUT_MS,
  );
  const maxConcurrentUploadsPerUser = positiveSafeInteger(
    environment,
    "PAPERPILOT_UPLOAD_MAX_CONCURRENT_PER_USER",
    DEFAULT_UPLOAD_MAX_CONCURRENT_PER_USER,
  );
  const maxConcurrentUploadsPerWorkspace = positiveSafeInteger(
    environment,
    "PAPERPILOT_UPLOAD_MAX_CONCURRENT_PER_WORKSPACE",
    DEFAULT_UPLOAD_MAX_CONCURRENT_PER_WORKSPACE,
  );
  const maxRetainedBytesPerWorkspace = positiveSafeInteger(
    environment,
    "PAPERPILOT_UPLOAD_MAX_RETAINED_BYTES_PER_WORKSPACE",
    DEFAULT_UPLOAD_MAX_RETAINED_BYTES_PER_WORKSPACE,
  );

  if (leaseTtlMs > sessionTtlMs) {
    throw new Error(
      "PAPERPILOT_UPLOAD_LEASE_TTL_SECONDS cannot exceed the upload session lifetime.",
    );
  }
  if (streamIdleTimeoutMs > streamAbsoluteTimeoutMs) {
    throw new Error(
      "PAPERPILOT_UPLOAD_STREAM_IDLE_TIMEOUT_SECONDS cannot exceed the absolute stream timeout.",
    );
  }
  if (streamAbsoluteTimeoutMs >= leaseTtlMs) {
    throw new Error(
      "PAPERPILOT_UPLOAD_STREAM_ABSOLUTE_TIMEOUT_SECONDS must be shorter than the receive lease.",
    );
  }
  if (maxConcurrentUploadsPerUser > maxConcurrentUploadsPerWorkspace) {
    throw new Error(
      "Per-user upload concurrency cannot exceed per-workspace upload concurrency.",
    );
  }
  if (maxRetainedBytesPerWorkspace < maxUploadBytes) {
    throw new Error(
      "The retained upload byte limit cannot be smaller than the per-upload byte limit.",
    );
  }

  return {
    quarantineRoot: privateQuarantineRoot(environment, workingDirectory),
    maxUploadBytes,
    sessionTtlMs,
    leaseTtlMs,
    streamIdleTimeoutMs,
    streamAbsoluteTimeoutMs,
    maxConcurrentUploadsPerUser,
    maxConcurrentUploadsPerWorkspace,
    maxRetainedBytesPerWorkspace,
  };
}
