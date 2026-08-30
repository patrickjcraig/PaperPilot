import { dirname } from "node:path";
import { TextDecoder } from "node:util";

import type { ExtractorConfiguration } from "./config.js";
import { RunnerFailure } from "./errors.js";
import { runCommand, type CommandSpec } from "./process-runner.js";
import type {
  ExtractedTextChunk,
  ExtractionEngineIdentity,
  ExtractionRunner,
  PopplerExtraction,
} from "./types.js";

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
const PARAGRAPH_ID_PATTERN = /^p([1-9]\d*)-p([1-9]\d*)$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface CommandTemplate {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  environment?: Readonly<Record<string, string>>;
  terminationGraceMs?: number;
}

export interface CommandRunnerOptions {
  inspect: CommandTemplate;
  probe: CommandTemplate;
  limits: Pick<
    ExtractorConfiguration,
    "maxPageCount" | "maxTextBytes" | "maxChunkCount" | "maxChunkBytes"
  >;
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
    maxStdoutBytes: template.maxStdoutBytes,
    maxStderrBytes: template.maxStderrBytes,
    ...(filePath === undefined ? {} : { cwd: dirname(filePath) }),
    ...(template.environment === undefined ? {} : { environment: template.environment }),
    ...(template.terminationGraceMs === undefined
      ? {}
      : { terminationGraceMs: template.terminationGraceMs }),
  };
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

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
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

function hasUnsafeUnicode(value: string): boolean {
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) return true;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (
      point === undefined
      || (point >= 0xfdd0 && point <= 0xfdef)
      || (point & 0xffff) === 0xfffe
      || (point & 0xffff) === 0xffff
    ) {
      return true;
    }
  }
  return false;
}

function validateChunk(
  value: unknown,
  sequence: number,
  limits: CommandRunnerOptions["limits"],
): ExtractedTextChunk {
  const chunk = record(value);
  exactKeys(chunk, ["sequence", "pageNumber", "paragraphId", "text"]);
  if (chunk.sequence !== sequence) throw new RunnerFailure("protocol");
  const pageNumber = boundedInteger(chunk.pageNumber, 1, limits.maxPageCount);
  const paragraphId = typeof chunk.paragraphId === "string" ? chunk.paragraphId : "";
  const match = PARAGRAPH_ID_PATTERN.exec(paragraphId);
  if (match?.[1] === undefined || Number(match[1]) !== pageNumber || paragraphId.length > 64) {
    throw new RunnerFailure("protocol");
  }
  const text = typeof chunk.text === "string" ? chunk.text : "";
  if (
    text.length === 0
    || text !== text.trim()
    || text !== text.normalize("NFC")
    || hasUnsafeUnicode(text)
    || /\p{Zs}/u.test(text.replaceAll(" ", ""))
    || text.includes("  ")
    || Buffer.byteLength(text, "utf8") > limits.maxChunkBytes
  ) {
    throw new RunnerFailure("protocol");
  }
  return { sequence, pageNumber, paragraphId, text };
}

export function validateExtractionResult(
  value: unknown,
  limits: CommandRunnerOptions["limits"],
): PopplerExtraction {
  const result = record(value);
  const hasWireSchema = Object.hasOwn(result, "schemaVersion");
  exactKeys(result, hasWireSchema
    ? [
        "schemaVersion", "outcome", "engine", "engineVersion", "pageCount",
        "chunkCount", "textBytes", "chunks",
      ]
    : [
        "outcome", "engine", "engineVersion", "pageCount", "chunkCount",
        "textBytes", "chunks",
      ]);
  if (
    (hasWireSchema && result.schemaVersion !== 1)
    || (result.outcome !== "extracted" && result.outcome !== "no_text")
    || !Array.isArray(result.chunks)
  ) {
    throw new RunnerFailure("protocol");
  }
  const pageCount = boundedInteger(result.pageCount, 1, limits.maxPageCount);
  const chunkCount = boundedInteger(result.chunkCount, 0, limits.maxChunkCount);
  const textBytes = boundedInteger(result.textBytes, 0, limits.maxTextBytes);
  const engine = identifier(result.engine, 64);
  if (chunkCount !== result.chunks.length) throw new RunnerFailure("protocol");
  const chunks = result.chunks.map((chunk, sequence) =>
    validateChunk(chunk, sequence, limits));

  let calculatedBytes = 0;
  let previousPage = 0;
  let previousParagraph = 0;
  for (const chunk of chunks) {
    if (chunk.pageNumber < previousPage) throw new RunnerFailure("protocol");
    const paragraph = Number(PARAGRAPH_ID_PATTERN.exec(chunk.paragraphId)?.[2]);
    if (!Number.isSafeInteger(paragraph)) throw new RunnerFailure("protocol");
    if (chunk.pageNumber !== previousPage) {
      if (paragraph !== 1) throw new RunnerFailure("protocol");
      previousParagraph = 0;
    }
    if (paragraph !== previousParagraph && paragraph !== previousParagraph + 1) {
      throw new RunnerFailure("protocol");
    }
    previousPage = chunk.pageNumber;
    previousParagraph = paragraph;
    calculatedBytes += Buffer.byteLength(chunk.text, "utf8");
  }
  if (
    calculatedBytes !== textBytes
    || engine !== "poppler"
    || (result.outcome === "no_text" && (chunkCount !== 0 || textBytes !== 0))
    || (result.outcome === "extracted" && (chunkCount < 1 || textBytes < 1))
  ) {
    throw new RunnerFailure("protocol");
  }
  return {
    outcome: result.outcome,
    engine: "poppler",
    engineVersion: identifier(result.engineVersion, 128),
    pageCount,
    chunkCount,
    textBytes,
    chunks,
  };
}

async function protocolCommand(
  template: CommandTemplate,
  signal: AbortSignal,
  filePath?: string,
): Promise<unknown> {
  const result = await runCommand(command(template, filePath), signal);
  if (
    result.exitCode !== 0
    || result.signal !== null
    || result.stdout.byteLength === 0
    || result.stderr.byteLength !== 0
  ) {
    throw new RunnerFailure("tool");
  }
  let value: unknown;
  try { value = JSON.parse(decoder.decode(result.stdout)) as unknown; } catch {
    throw new RunnerFailure("protocol");
  }
  const possibleFailure = record(value);
  if (Object.hasOwn(possibleFailure, "error")) {
    exactKeys(possibleFailure, ["schemaVersion", "error"]);
    const error = record(possibleFailure.error);
    exactKeys(error, ["code"]);
    if (possibleFailure.schemaVersion !== 1) throw new RunnerFailure("protocol");
    if (error.code === "extraction_input_unsupported") {
      throw new RunnerFailure("input_unsupported");
    }
    if (error.code === "extraction_resource_limit") throw new RunnerFailure("output_limit");
    throw new RunnerFailure("protocol");
  }
  return value;
}

export class CommandExtractionRunner implements ExtractionRunner {
  readonly #options: CommandRunnerOptions;

  constructor(options: CommandRunnerOptions) { this.#options = options; }

  async ready(signal: AbortSignal): Promise<ExtractionEngineIdentity> {
    const value = record(await protocolCommand(this.#options.probe, signal));
    exactKeys(value, ["schemaVersion", "ready", "engine", "engineVersion"]);
    if (
      value.schemaVersion !== 1
      || value.ready !== true
      || identifier(value.engine, 64) !== "poppler"
    ) {
      throw new RunnerFailure("protocol");
    }
    return Object.freeze({
      engine: "poppler",
      engineVersion: identifier(value.engineVersion, 128),
    });
  }

  async inspect(filePath: string, signal: AbortSignal): Promise<PopplerExtraction> {
    return validateExtractionResult(
      await protocolCommand(this.#options.inspect, signal, filePath),
      this.#options.limits,
    );
  }
}
