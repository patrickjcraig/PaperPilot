#!/usr/bin/env node
import { RunnerFailure } from "../src/errors.js";
import {
  canonicalInteger,
  canonicalToolTimestamp,
  decodeArgument,
  decodeArguments,
  decodedOutput,
  installSignalCancellation,
  invokeTool,
  wrapperMain,
} from "./common.js";

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;

interface ClamMetadata {
  engineVersion: string;
  signatureVersion: string;
  signaturePublishedAt: string;
}

function parseVersionOutput(output: string): ClamMetadata {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^ClamAV\s+([^/\s]+)\/([^/\s]+)\/(.+)$/.exec(line);
    if (!match) continue;
    const engineVersion = match[1];
    const signatureVersion = match[2];
    const published = match[3];
    if (
      engineVersion === undefined
      || signatureVersion === undefined
      || published === undefined
      || engineVersion.length > 128
      || signatureVersion.length > 128
      || !SAFE_IDENTIFIER_PATTERN.test(engineVersion)
      || !SAFE_IDENTIFIER_PATTERN.test(signatureVersion)
    ) {
      break;
    }
    return {
      engineVersion,
      signatureVersion,
      signaturePublishedAt: canonicalToolTimestamp(published),
    };
  }
  throw new RunnerFailure("protocol");
}

async function metadata(input: {
  executable: string;
  versionArgs: readonly string[];
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ClamMetadata> {
  const result = await invokeTool({
    executable: input.executable,
    args: input.versionArgs,
    timeoutMs: input.timeoutMs,
    maxStdoutBytes: 16 * 1_024,
    maxStderrBytes: 16 * 1_024,
    signal: input.signal,
  });
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new RunnerFailure("tool");
  }
  return parseVersionOutput(decodedOutput(result, 32 * 1_024));
}

await wrapperMain(async () => {
  const [
    mode,
    encodedExecutable,
    encodedScanArgs,
    encodedVersionArgs,
    rawTimeoutMs,
    rawSignatureMaxAgeMs,
    rawFutureClockSkewMs,
    filePath,
  ] =
    process.argv.slice(2);
  if (
    (mode !== "probe" && mode !== "inspect")
    || encodedExecutable === undefined
    || encodedScanArgs === undefined
    || encodedVersionArgs === undefined
    || rawTimeoutMs === undefined
    || rawSignatureMaxAgeMs === undefined
    || rawFutureClockSkewMs === undefined
    || (mode === "probe" && filePath !== undefined)
    || (mode === "inspect" && (filePath === undefined || filePath.includes("\0")))
  ) {
    throw new RunnerFailure("protocol");
  }
  const executable = decodeArgument(encodedExecutable, 2 * 1_024);
  const scanArgs = decodeArguments(encodedScanArgs);
  const versionArgs = decodeArguments(encodedVersionArgs);
  const timeoutMs = canonicalInteger(rawTimeoutMs, 100, 120_000);
  const signatureMaxAgeMs = canonicalInteger(
    rawSignatureMaxAgeMs,
    60_000,
    7 * 24 * 60 * 60 * 1_000,
  );
  const futureClockSkewMs = canonicalInteger(rawFutureClockSkewMs, 0, 60 * 60 * 1_000);
  const controller = new AbortController();
  const removeSignals = installSignalCancellation(controller);
  try {
    const version = await metadata({
      executable,
      versionArgs,
      timeoutMs,
      signal: controller.signal,
    });
    const signaturePublishedAt = new Date(version.signaturePublishedAt).getTime();
    const now = Date.now();
    if (
      signaturePublishedAt > now + futureClockSkewMs
      || now - signaturePublishedAt > signatureMaxAgeMs
    ) {
      throw new RunnerFailure("tool");
    }
    if (mode === "probe") return { schemaVersion: 1, ready: true };

    const scan = await invokeTool({
      executable,
      args: [...scanArgs, filePath as string],
      timeoutMs,
      maxStdoutBytes: 128 * 1_024,
      maxStderrBytes: 128 * 1_024,
      signal: controller.signal,
    });
    if (scan.signal !== null || (scan.exitCode !== 0 && scan.exitCode !== 1)) {
      throw new RunnerFailure("tool");
    }
    const output = decodedOutput(scan, 256 * 1_024);
    const found = output.split(/\r?\n/).filter((line) => /:\s+.+\s+FOUND\s*$/.test(line));
    const cleanLines = output.split(/\r?\n/).filter((line) => /:\s+OK\s*$/.test(line));
    if (
      (scan.exitCode === 0 && (found.length !== 0 || cleanLines.length !== 1))
      || (scan.exitCode === 1 && found.length < 1)
      || found.length > 128
    ) {
      throw new RunnerFailure("protocol");
    }
    return {
      schemaVersion: 1,
      verdict: scan.exitCode === 0 ? "clean" : "infected",
      engine: "clamav",
      engineVersion: version.engineVersion,
      signatureVersion: version.signatureVersion,
      signaturePublishedAt: version.signaturePublishedAt,
      detectionCount: found.length,
    };
  } finally {
    removeSignals();
  }
});
