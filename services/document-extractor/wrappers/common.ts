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
  try { return decoder.decode(bytes); } catch { throw new RunnerFailure("protocol"); }
}

export function decodeArguments(encoded: string): string[] {
  let value: unknown;
  try { value = JSON.parse(decodeArgument(encoded, 16 * 1_024)) as unknown; } catch (error) {
    if (error instanceof RunnerFailure) throw error;
    throw new RunnerFailure("protocol");
  }
  if (
    !Array.isArray(value)
    || value.length > 64
    || value.some((item) =>
      typeof item !== "string" || item.length > 4 * 1_024 || item.includes("\0"))
  ) {
    throw new RunnerFailure("protocol");
  }
  return value as string[];
}

export function canonicalInteger(raw: string, minimum: number, maximum: number): number {
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new RunnerFailure("protocol");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RunnerFailure("protocol");
  }
  return value;
}

export function decodeUtf8(bytes: Buffer): string {
  try { return decoder.decode(bytes); } catch { throw new RunnerFailure("protocol"); }
}

export function decodedOutput(result: CommandResult, maximumBytes: number): string {
  const bytes = Buffer.concat(
    [result.stdout, Buffer.from("\n"), result.stderr],
    result.stdout.byteLength + result.stderr.byteLength + 1,
  );
  if (bytes.byteLength > maximumBytes) throw new RunnerFailure("output_limit");
  return decodeUtf8(bytes);
}

export function invokeTool(input: {
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
    environment: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
  }, input.signal);
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
    process.stdout.write(JSON.stringify(await action()));
  } catch (error) {
    if (
      error instanceof RunnerFailure
      && (error.kind === "input_unsupported" || error.kind === "output_limit")
    ) {
      process.stdout.write(JSON.stringify({
        schemaVersion: 1,
        error: {
          code: error.kind === "output_limit"
            ? "extraction_resource_limit"
            : "extraction_input_unsupported",
        },
      }));
      return;
    }
    process.stderr.write("extraction_wrapper_failed\n");
    process.exitCode = 70;
  }
}
