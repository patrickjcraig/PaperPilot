import { fileURLToPath } from "node:url";

import {
  CommandMalwareRunner,
  CommandPdfInspectionRunner,
  type CommandTemplate,
} from "./command-protocol.js";
import type { ValidatorConfiguration } from "./config.js";
import type { MalwareRunner, PdfInspectionRunner } from "./types.js";

const MAX_COMMAND_CHARACTERS = 2 * 1_024;
// qpdf metadata is held as bounded bytes, decoded text, and parsed objects in
// one wrapper process. Bound the raw aggregate across admitted validations so
// configuration cannot multiply the per-command ceiling without limit.
const MAX_AGGREGATE_QPDF_METADATA_BYTES = 64 * 1_024 * 1_024;

function command(raw: string | undefined, fallback: string, name: string): string {
  const value = raw ?? fallback;
  if (
    value.length === 0
    || value.length > MAX_COMMAND_CHARACTERS
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
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${name} must be a JSON array of command arguments.`);
  }
  if (
    !Array.isArray(value)
    || value.length > 64
    || value.some((argument) =>
      typeof argument !== "string"
      || argument.length > 4 * 1_024
      || argument.includes("\0"))
  ) {
    throw new Error(`${name} must be a bounded JSON array of command arguments.`);
  }
  return value as string[];
}

function integer(
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
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.from(text, "utf8").toString("base64url");
}

function template(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): CommandTemplate {
  return {
    executable,
    args,
    timeoutMs,
    maxStdoutBytes: 16 * 1_024,
    maxStderrBytes: 4 * 1_024,
    environment: { TZ: "UTC" },
    // The wrapper needs time to forward cancellation and reap its own detached
    // scanner/parser process group before the outer group is force-killed.
    terminationGraceMs: 1_500,
  };
}

export function configuredInspectionRunners(
  configuration: ValidatorConfiguration,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { malwareRunner: MalwareRunner; pdfRunner: PdfInspectionRunner } {
  const clamCommand = command(
    environment.PAPERPILOT_VALIDATOR_CLAM_COMMAND,
    "clamdscan",
    "PAPERPILOT_VALIDATOR_CLAM_COMMAND",
  );
  const clamArgs = argumentsFromJson(
    environment.PAPERPILOT_VALIDATOR_CLAM_ARGS_JSON,
    ["--no-summary", "--stream"],
    "PAPERPILOT_VALIDATOR_CLAM_ARGS_JSON",
  );
  const clamVersionArgs = argumentsFromJson(
    environment.PAPERPILOT_VALIDATOR_CLAM_VERSION_ARGS_JSON,
    ["--version"],
    "PAPERPILOT_VALIDATOR_CLAM_VERSION_ARGS_JSON",
  );
  const clamTimeoutMs = integer(
    environment,
    "PAPERPILOT_VALIDATOR_CLAM_TIMEOUT_MS",
    8_000,
    100,
    120_000,
  );

  const qpdfCommand = command(
    environment.PAPERPILOT_VALIDATOR_QPDF_COMMAND,
    "qpdf",
    "PAPERPILOT_VALIDATOR_QPDF_COMMAND",
  );
  const qpdfArgs = argumentsFromJson(
    environment.PAPERPILOT_VALIDATOR_QPDF_ARGS_JSON,
    [],
    "PAPERPILOT_VALIDATOR_QPDF_ARGS_JSON",
  );
  const qpdfVersionArgs = argumentsFromJson(
    environment.PAPERPILOT_VALIDATOR_QPDF_VERSION_ARGS_JSON,
    ["--version"],
    "PAPERPILOT_VALIDATOR_QPDF_VERSION_ARGS_JSON",
  );
  const qpdfTimeoutMs = integer(
    environment,
    "PAPERPILOT_VALIDATOR_QPDF_COMMAND_TIMEOUT_MS",
    5_000,
    100,
    120_000,
  );
  const qpdfMetadataBytes = integer(
    environment,
    "PAPERPILOT_VALIDATOR_QPDF_MAX_METADATA_BYTES",
    8 * 1_024 * 1_024,
    16 * 1_024,
    32 * 1_024 * 1_024,
  );
  if (
    qpdfMetadataBytes
      > Math.floor(MAX_AGGREGATE_QPDF_METADATA_BYTES / configuration.maxConcurrentValidations)
  ) {
    throw new Error(
      "Qpdf metadata bytes multiplied by validator concurrency exceed the aggregate memory ceiling.",
    );
  }

  const nodeExecutable = process.execPath;
  const clamWrapper = fileURLToPath(new URL("../wrappers/clamav.js", import.meta.url));
  const qpdfWrapper = fileURLToPath(new URL("../wrappers/qpdf.js", import.meta.url));
  const clamCommon = [
    encoded(clamCommand),
    encoded(clamArgs),
    encoded(clamVersionArgs),
    String(clamTimeoutMs),
    String(configuration.signatureReadinessMaxAgeMs),
    String(configuration.signatureFutureClockSkewMs),
  ];
  const qpdfCommon = [
    encoded(qpdfCommand),
    encoded(qpdfArgs),
    encoded(qpdfVersionArgs),
    String(qpdfTimeoutMs),
    String(qpdfMetadataBytes),
    String(configuration.maxBodyBytes),
  ];

  return {
    malwareRunner: new CommandMalwareRunner({
      probe: template(
        nodeExecutable,
        [clamWrapper, "probe", ...clamCommon],
        Math.min(120_000, clamTimeoutMs + 2_000),
      ),
      inspect: template(
        nodeExecutable,
        [clamWrapper, "inspect", ...clamCommon, "{file}"],
        Math.min(120_000, clamTimeoutMs * 2 + 2_000),
      ),
    }),
    pdfRunner: new CommandPdfInspectionRunner({
      probe: template(
        nodeExecutable,
        [qpdfWrapper, "probe", ...qpdfCommon],
        Math.min(120_000, qpdfTimeoutMs + 2_000),
      ),
      inspect: template(
        nodeExecutable,
        [qpdfWrapper, "inspect", ...qpdfCommon, "{file}"],
        Math.min(120_000, qpdfTimeoutMs * 6 + 3_000),
      ),
    }),
  };
}
