import { TextDecoder } from "node:util";
import { dirname } from "node:path";

import { RunnerFailure } from "./errors.js";
import { runCommand, type CommandSpec } from "./process-runner.js";
import {
  SUPPORTED_PDF_VERSIONS,
  type MalwareInspection,
  type MalwareRunner,
  type PdfInspection,
  type PdfInspectionRunner,
  type SupportedPdfVersion,
} from "./types.js";

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_DETECTION_COUNT = 128;
const MAX_PAGE_COUNT = 100_000;
const MAX_OBJECT_COUNT = 10_000_000;
const MAX_REVISION_COUNT = 10_000;
const MAX_WARNING_COUNT = 10_000;
const PDF_VERSIONS = new Set<string>(SUPPORTED_PDF_VERSIONS);

export interface CommandTemplate {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  environment?: Readonly<Record<string, string>>;
  terminationGraceMs?: number;
}

export interface CommandRunnerOptions {
  inspect: CommandTemplate;
  probe: CommandTemplate;
}

function command(template: CommandTemplate, filePath?: string): CommandSpec {
  let replacements = 0;
  const args = template.args.map((argument) => {
    if (argument !== "{file}") return argument;
    replacements += 1;
    if (filePath === undefined) throw new RunnerFailure("protocol");
    return filePath;
  });
  if ((filePath === undefined && replacements !== 0) || (filePath !== undefined && replacements !== 1)) {
    throw new RunnerFailure("protocol");
  }
  return {
    executable: template.executable,
    args,
    timeoutMs: template.timeoutMs,
    maxStdoutBytes: template.maxStdoutBytes ?? 16 * 1_024,
    maxStderrBytes: template.maxStderrBytes ?? 4 * 1_024,
    ...(filePath === undefined ? {} : { cwd: dirname(filePath) }),
    ...(template.environment === undefined ? {} : { environment: template.environment }),
    ...(template.terminationGraceMs === undefined
      ? {}
      : { terminationGraceMs: template.terminationGraceMs }),
  };
}

function parseJson(bytes: Buffer): unknown {
  if (bytes.byteLength === 0) throw new RunnerFailure("protocol");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new RunnerFailure("protocol");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunnerFailure("protocol");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new RunnerFailure("protocol");
  }
}

function identifier(value: unknown, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length > maximum
    || !SAFE_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new RunnerFailure("protocol");
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new RunnerFailure("protocol");
  }
  return value;
}

function nullableInteger(value: unknown, minimum: number, maximum: number): number | null {
  return value === null ? null : integer(value, minimum, maximum);
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new RunnerFailure("protocol");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new RunnerFailure("protocol");
  }
  return value;
}

async function runProtocolCommand(
  template: CommandTemplate,
  signal: AbortSignal,
  filePath?: string,
): Promise<unknown> {
  const result = await runCommand(command(template, filePath), signal);
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new RunnerFailure("tool");
  }
  return parseJson(result.stdout);
}

async function probe(template: CommandTemplate, signal: AbortSignal): Promise<void> {
  const value = record(await runProtocolCommand(template, signal));
  exactKeys(value, ["schemaVersion", "ready"]);
  if (value.schemaVersion !== 1 || value.ready !== true) {
    throw new RunnerFailure("protocol");
  }
}

export class CommandMalwareRunner implements MalwareRunner {
  readonly #options: CommandRunnerOptions;

  constructor(options: CommandRunnerOptions) {
    this.#options = options;
  }

  ready(signal: AbortSignal): Promise<void> {
    return probe(this.#options.probe, signal);
  }

  async inspect(filePath: string, signal: AbortSignal): Promise<MalwareInspection> {
    const value = record(
      await runProtocolCommand(this.#options.inspect, signal, filePath),
    );
    exactKeys(value, [
      "schemaVersion",
      "verdict",
      "engine",
      "engineVersion",
      "signatureVersion",
      "signaturePublishedAt",
      "detectionCount",
    ]);
    if (value.schemaVersion !== 1 || (value.verdict !== "clean" && value.verdict !== "infected")) {
      throw new RunnerFailure("protocol");
    }
    const detectionCount = integer(value.detectionCount, 0, MAX_DETECTION_COUNT);
    if (
      (value.verdict === "clean" && detectionCount !== 0)
      || (value.verdict === "infected" && detectionCount < 1)
    ) {
      throw new RunnerFailure("protocol");
    }
    return {
      verdict: value.verdict,
      engine: identifier(value.engine, 64),
      engineVersion: identifier(value.engineVersion, 128),
      signatureVersion: identifier(value.signatureVersion, 128),
      signaturePublishedAt: timestamp(value.signaturePublishedAt),
      detectionCount,
    };
  }
}

export class CommandPdfInspectionRunner implements PdfInspectionRunner {
  readonly #options: CommandRunnerOptions;

  constructor(options: CommandRunnerOptions) {
    this.#options = options;
  }

  ready(signal: AbortSignal): Promise<void> {
    return probe(this.#options.probe, signal);
  }

  async inspect(filePath: string, signal: AbortSignal): Promise<PdfInspection> {
    const value = record(
      await runProtocolCommand(this.#options.inspect, signal, filePath),
    );
    exactKeys(value, [
      "schemaVersion",
      "outcome",
      "engine",
      "engineVersion",
      "pdfVersion",
      "pageCount",
      "objectCount",
      "revisionCount",
      "warningCount",
    ]);
    if (
      value.schemaVersion !== 1
      || (
        value.outcome !== "valid"
        && value.outcome !== "invalid"
        && value.outcome !== "policy_violation"
        && value.outcome !== "resource_limit"
      )
      || typeof value.pdfVersion !== "string"
      || (value.pdfVersion !== "unknown" && !PDF_VERSIONS.has(value.pdfVersion))
    ) {
      throw new RunnerFailure("protocol");
    }
    const pageCount = nullableInteger(value.pageCount, 1, MAX_PAGE_COUNT);
    const objectCount = nullableInteger(value.objectCount, 1, MAX_OBJECT_COUNT);
    const revisionCount = nullableInteger(value.revisionCount, 1, MAX_REVISION_COUNT);
    const warningCount = integer(value.warningCount, 0, MAX_WARNING_COUNT);
    const structurallyValid = value.outcome === "valid" || value.outcome === "policy_violation";
    if (
      structurallyValid
      && (
        value.pdfVersion === "unknown"
        || pageCount === null
        || objectCount === null
        || revisionCount === null
        || warningCount !== 0
      )
    ) {
      throw new RunnerFailure("protocol");
    }
    return {
      outcome: value.outcome,
      engine: identifier(value.engine, 64),
      engineVersion: identifier(value.engineVersion, 128),
      pdfVersion: value.pdfVersion as SupportedPdfVersion | "unknown",
      pageCount,
      objectCount,
      revisionCount,
      warningCount,
    };
  }
}
