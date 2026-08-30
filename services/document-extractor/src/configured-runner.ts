import { fileURLToPath } from "node:url";

import { CommandExtractionRunner, type CommandTemplate } from "./command-protocol.js";
import type { ExtractorConfiguration } from "./config.js";
import type { ExtractionRunner } from "./types.js";

const MAX_COMMAND_BYTES = 2 * 1_024;
const MAX_ARGUMENTS_JSON_BYTES = 6 * 1_024;
const HARD_MAX_RAW_TEXT_BYTES = 8 * 1_024 * 1_024;
const MAX_AGGREGATE_RAW_TEXT_BYTES = 64 * 1_024 * 1_024;

function command(raw: string | undefined, fallback: string, name: string): string {
  const value = raw ?? fallback;
  if (
    value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_COMMAND_BYTES
    || value.includes("\0")
    || /[\r\n]/.test(value)
  ) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function argumentsFromJson(
  raw: string | undefined,
  fallback: readonly string[],
  name: string,
): string[] {
  if (raw === undefined) return [...fallback];
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch {
    throw new Error(`${name} must be a JSON array of command arguments.`);
  }
  if (
    !Array.isArray(value)
    || value.length > 64
    || value.some((argument) =>
      typeof argument !== "string" || argument.length > 4 * 1_024 || argument.includes("\0"))
    || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_ARGUMENTS_JSON_BYTES
  ) {
    throw new Error(`${name} must be a bounded JSON array of command arguments.`);
  }
  return value as string[];
}

function positiveInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a canonical positive integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the supported range.`);
  }
  return value;
}

function encoded(value: string | readonly string[]): string {
  return Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  ).toString("base64url");
}

function template(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  maxStdoutBytes: number,
): CommandTemplate {
  return {
    executable,
    args,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes: 4 * 1_024,
    environment: { TZ: "UTC" },
    terminationGraceMs: 1_500,
  };
}

export function configuredExtractionRunner(
  configuration: ExtractorConfiguration,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ExtractionRunner {
  const textExecutable = command(
    environment.PAPERPILOT_EXTRACTOR_PDFTOTEXT_COMMAND,
    "pdftotext",
    "PAPERPILOT_EXTRACTOR_PDFTOTEXT_COMMAND",
  );
  const infoExecutable = command(
    environment.PAPERPILOT_EXTRACTOR_PDFINFO_COMMAND,
    "pdfinfo",
    "PAPERPILOT_EXTRACTOR_PDFINFO_COMMAND",
  );
  const textArgs = argumentsFromJson(
    environment.PAPERPILOT_EXTRACTOR_PDFTOTEXT_ARGS_JSON,
    [],
    "PAPERPILOT_EXTRACTOR_PDFTOTEXT_ARGS_JSON",
  );
  const infoArgs = argumentsFromJson(
    environment.PAPERPILOT_EXTRACTOR_PDFINFO_ARGS_JSON,
    [],
    "PAPERPILOT_EXTRACTOR_PDFINFO_ARGS_JSON",
  );
  const textVersionArgs = argumentsFromJson(
    environment.PAPERPILOT_EXTRACTOR_PDFTOTEXT_VERSION_ARGS_JSON,
    ["-v"],
    "PAPERPILOT_EXTRACTOR_PDFTOTEXT_VERSION_ARGS_JSON",
  );
  const infoVersionArgs = argumentsFromJson(
    environment.PAPERPILOT_EXTRACTOR_PDFINFO_VERSION_ARGS_JSON,
    ["-v"],
    "PAPERPILOT_EXTRACTOR_PDFINFO_VERSION_ARGS_JSON",
  );
  const commandTimeoutMs = positiveInteger(
    environment,
    "PAPERPILOT_EXTRACTOR_POPPLER_COMMAND_TIMEOUT_MS",
    15_000,
    100,
    120_000,
  );
  const maximumRawTextBytes = positiveInteger(
    environment,
    "PAPERPILOT_EXTRACTOR_POPPLER_MAX_RAW_TEXT_BYTES",
    HARD_MAX_RAW_TEXT_BYTES,
    configuration.maxTextBytes,
    HARD_MAX_RAW_TEXT_BYTES,
  );
  if (
    maximumRawTextBytes
      > Math.floor(MAX_AGGREGATE_RAW_TEXT_BYTES / configuration.maxConcurrentExtractions)
  ) {
    throw new Error("Poppler output multiplied by extraction concurrency exceeds 64 MiB.");
  }

  const common = [
    encoded(textExecutable),
    encoded(textArgs),
    encoded(textVersionArgs),
    encoded(infoExecutable),
    encoded(infoArgs),
    encoded(infoVersionArgs),
    String(commandTimeoutMs),
    String(configuration.maxPageCount),
    String(maximumRawTextBytes),
    String(configuration.maxTextBytes),
    String(configuration.maxChunkCount),
    String(configuration.maxChunkBytes),
  ];
  const wrapper = fileURLToPath(new URL("../wrappers/poppler.js", import.meta.url));
  const nodeExecutable = process.execPath;
  return new CommandExtractionRunner({
    probe: template(
      nodeExecutable,
      [wrapper, "probe", ...common],
      Math.min(120_000, commandTimeoutMs + 2_000),
      16 * 1_024,
    ),
    inspect: template(
      nodeExecutable,
      [wrapper, "inspect", ...common, "{file}"],
      Math.min(120_000, commandTimeoutMs * 3 + 3_000),
      configuration.maxResponseBytes,
    ),
    limits: {
      maxPageCount: configuration.maxPageCount,
      maxTextBytes: configuration.maxTextBytes,
      maxChunkCount: configuration.maxChunkCount,
      maxChunkBytes: configuration.maxChunkBytes,
    },
  });
}
