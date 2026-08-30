import type { SafeLogFields, StructuredLogger } from "./types.js";

const EVENT_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9_.:+-]{1,128}$/;

function boundedInteger(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_VALUE_PATTERN.test(value)
    ? value
    : undefined;
}

/**
 * Copies an explicit allowlist. Raw errors, headers, hashes, secrets, file
 * paths, command output, and tenant data cannot cross this boundary.
 */
function redact(fields: SafeLogFields | undefined): Record<string, string | number> {
  if (!fields) return {};
  const output: Record<string, string | number> = {};
  for (const key of ["status", "sizeBytes", "durationMs"] as const) {
    const value = boundedInteger(fields[key]);
    if (value !== undefined) output[key] = value;
  }
  for (const key of [
    "requestId",
    "route",
    "method",
    "code",
    "malwareVerdict",
    "pdfVerdict",
    "verdict",
  ] as const) {
    const value = safeString(fields[key]);
    if (value !== undefined) output[key] = value;
  }
  return output;
}

export class JsonLineLogger implements StructuredLogger {
  readonly #write: (line: string) => void;
  readonly #clock: () => Date;

  constructor(
    write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    clock: () => Date = () => new Date(),
  ) {
    this.#write = write;
    this.#clock = clock;
  }

  info(event: string, fields?: SafeLogFields): void {
    this.#log("info", event, fields);
  }

  warn(event: string, fields?: SafeLogFields): void {
    this.#log("warn", event, fields);
  }

  error(event: string, fields?: SafeLogFields): void {
    this.#log("error", event, fields);
  }

  #log(level: "info" | "warn" | "error", event: string, fields?: SafeLogFields): void {
    const normalizedEvent = EVENT_PATTERN.test(event) ? event : "invalid_event";
    const now = this.#clock();
    const timestamp = Number.isFinite(now.getTime())
      ? now.toISOString()
      : "1970-01-01T00:00:00.000Z";
    try {
      this.#write(JSON.stringify({
        timestamp,
        level,
        event: normalizedEvent,
        ...redact(fields),
      }));
    } catch {
      // Telemetry failure must never change a validation verdict or expose a
      // secondary raw error path.
    }
  }
}

export const NULL_LOGGER: StructuredLogger = Object.freeze({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});
