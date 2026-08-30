import { TextDecoder } from "node:util";

import { RunnerFailure } from "../src/errors.js";
import { runCommand, type CommandResult } from "../src/process-runner.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export function decodeArgument(encoded: string, maximumBytes = 8 * 1_024): string {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.includes("=")) {
    throw new RunnerFailure("protocol");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (
    bytes.byteLength === 0
    || bytes.byteLength > maximumBytes
    || bytes.toString("base64url") !== encoded
  ) {
    throw new RunnerFailure("protocol");
  }
  try {
    return decoder.decode(bytes);
  } catch {
    throw new RunnerFailure("protocol");
  }
}

export function decodeArguments(encoded: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(decodeArgument(encoded, 32 * 1_024)) as unknown;
  } catch (error) {
    if (error instanceof RunnerFailure) throw error;
    throw new RunnerFailure("protocol");
  }
  if (
    !Array.isArray(value)
    || value.length > 64
    || value.some((item) =>
      typeof item !== "string"
      || item.length > 4 * 1_024
      || item.includes("\0"))
  ) {
    throw new RunnerFailure("protocol");
  }
  return value as string[];
}

export function canonicalInteger(
  raw: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new RunnerFailure("protocol");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RunnerFailure("protocol");
  }
  return value;
}

export async function invokeTool(input: {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal: AbortSignal;
}): Promise<CommandResult> {
  return runCommand({
    executable: input.executable,
    args: input.args,
    timeoutMs: input.timeoutMs,
    maxStdoutBytes: input.maxStdoutBytes,
    maxStderrBytes: input.maxStderrBytes,
    environment: {
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
    },
  }, input.signal);
}

export function decodedOutput(result: CommandResult, maximumBytes = 128 * 1_024): string {
  const bytes = Buffer.concat(
    [result.stdout, Buffer.from("\n"), result.stderr],
    result.stdout.byteLength + result.stderr.byteLength + 1,
  );
  if (bytes.byteLength > maximumBytes) throw new RunnerFailure("output_limit");
  try {
    return decoder.decode(bytes);
  } catch {
    throw new RunnerFailure("protocol");
  }
}

export function canonicalToolTimestamp(raw: string): string {
  const value = raw.trim();
  const ctime = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(value);
  if (ctime) {
    const months: Readonly<Record<string, number>> = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    const monthName = ctime[1];
    const month = monthName === undefined ? undefined : months[monthName];
    const day = Number(ctime[2]);
    const hour = Number(ctime[3]);
    const minute = Number(ctime[4]);
    const second = Number(ctime[5]);
    const year = Number(ctime[6]);
    if (
      month === undefined
      || !Number.isInteger(day)
      || day < 1
      || day > 31
      || !Number.isInteger(hour)
      || hour > 23
      || !Number.isInteger(minute)
      || minute > 59
      || !Number.isInteger(second)
      || second > 59
      || !Number.isInteger(year)
    ) {
      throw new RunnerFailure("protocol");
    }
    const parsed = new Date(Date.UTC(year, month, day, hour, minute, second));
    if (
      parsed.getUTCFullYear() !== year
      || parsed.getUTCMonth() !== month
      || parsed.getUTCDate() !== day
      || parsed.getUTCHours() !== hour
      || parsed.getUTCMinutes() !== minute
      || parsed.getUTCSeconds() !== second
    ) {
      throw new RunnerFailure("protocol");
    }
    return parsed.toISOString();
  }
  // Anything outside Clam's known zone-less ctime form must carry an explicit
  // zone. This avoids host-local Date parsing and cross-host clock drift.
  if (!/(?:Z|GMT|[+-]\d{2}:?\d{2})$/i.test(value)) {
    throw new RunnerFailure("protocol");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new RunnerFailure("protocol");
  return parsed.toISOString();
}

export function installSignalCancellation(controller: AbortController): () => void {
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return () => {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  };
}

export async function wrapperMain(action: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    const result = await action();
    process.stdout.write(JSON.stringify(result));
  } catch {
    // The HTTP process maps this fixed failure to a fixed 503 and never exposes
    // tool output, command lines, or private temporary paths.
    process.stderr.write("inspection_wrapper_failed\n");
    process.exitCode = 70;
  }
}
