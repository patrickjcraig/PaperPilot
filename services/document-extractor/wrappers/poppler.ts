#!/usr/bin/env node
import { RunnerFailure } from "../src/errors.js";
import { normalizePopplerText } from "../src/text-normalization.js";
import {
  canonicalInteger,
  decodeArgument,
  decodeArguments,
  decodedOutput,
  decodeUtf8,
  installSignalCancellation,
  invokeTool,
  wrapperMain,
} from "./common.js";

const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;

function parseVersion(output: string, tool: "pdftotext" | "pdfinfo"): string {
  const pattern = new RegExp(`^${tool} version\\s+([^\\s]+)(?:\\s|$)`, "i");
  for (const line of output.split(/\r?\n/)) {
    const version = pattern.exec(line.trim())?.[1];
    if (version !== undefined && SAFE_VERSION_PATTERN.test(version)) return version;
  }
  throw new RunnerFailure("protocol");
}

async function toolVersion(input: {
  executable: string;
  args: readonly string[];
  tool: "pdftotext" | "pdfinfo";
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<string> {
  const result = await invokeTool({
    executable: input.executable,
    args: input.args,
    timeoutMs: input.timeoutMs,
    maxStdoutBytes: 16 * 1_024,
    maxStderrBytes: 16 * 1_024,
    signal: input.signal,
  });
  if (result.exitCode !== 0 || result.signal !== null) throw new RunnerFailure("tool");
  return parseVersion(decodedOutput(result, 32 * 1_024), input.tool);
}

function parsePdfInfo(output: string, maximumPages: number): number {
  const pages: number[] = [];
  const encrypted: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const pagesMatch = /^Pages:\s+([^\s]+)\s*$/.exec(line);
    if (pagesMatch?.[1] !== undefined) {
      if (!/^[1-9]\d*$/.test(pagesMatch[1])) throw new RunnerFailure("protocol");
      pages.push(Number(pagesMatch[1]));
    }
    const encryptedMatch = /^Encrypted:\s+(yes|no)(?:\s+.*)?$/i.exec(line);
    if (encryptedMatch?.[1] !== undefined) encrypted.push(encryptedMatch[1].toLowerCase());
  }
  if (pages.length !== 1 || encrypted.length !== 1 || !Number.isSafeInteger(pages[0])) {
    throw new RunnerFailure("protocol");
  }
  if (encrypted[0] === "yes") throw new RunnerFailure("input_unsupported");
  const pageCount = pages[0] as number;
  if (pageCount > maximumPages) throw new RunnerFailure("output_limit");
  return pageCount;
}

await wrapperMain(async () => {
  const [
    mode,
    encodedTextExecutable,
    encodedTextArgs,
    encodedTextVersionArgs,
    encodedInfoExecutable,
    encodedInfoArgs,
    encodedInfoVersionArgs,
    rawTimeoutMs,
    rawMaximumPages,
    rawMaximumRawTextBytes,
    rawMaximumTextBytes,
    rawMaximumChunks,
    rawMaximumChunkBytes,
    filePath,
  ] = process.argv.slice(2);
  if (
    (mode !== "probe" && mode !== "inspect")
    || encodedTextExecutable === undefined
    || encodedTextArgs === undefined
    || encodedTextVersionArgs === undefined
    || encodedInfoExecutable === undefined
    || encodedInfoArgs === undefined
    || encodedInfoVersionArgs === undefined
    || rawTimeoutMs === undefined
    || rawMaximumPages === undefined
    || rawMaximumRawTextBytes === undefined
    || rawMaximumTextBytes === undefined
    || rawMaximumChunks === undefined
    || rawMaximumChunkBytes === undefined
    || (mode === "probe" && filePath !== undefined)
    || (mode === "inspect" && (filePath === undefined || filePath.includes("\0")))
  ) {
    throw new RunnerFailure("protocol");
  }

  const textExecutable = decodeArgument(encodedTextExecutable, 2 * 1_024);
  const textArgs = decodeArguments(encodedTextArgs);
  const textVersionArgs = decodeArguments(encodedTextVersionArgs);
  const infoExecutable = decodeArgument(encodedInfoExecutable, 2 * 1_024);
  const infoArgs = decodeArguments(encodedInfoArgs);
  const infoVersionArgs = decodeArguments(encodedInfoVersionArgs);
  const timeoutMs = canonicalInteger(rawTimeoutMs, 100, 120_000);
  const maximumPages = canonicalInteger(rawMaximumPages, 1, 2_000);
  const maximumRawTextBytes = canonicalInteger(
    rawMaximumRawTextBytes,
    1,
    8 * 1_024 * 1_024,
  );
  const maximumTextBytes = canonicalInteger(rawMaximumTextBytes, 1, 4 * 1_024 * 1_024);
  const maximumChunks = canonicalInteger(rawMaximumChunks, 1, 4_096);
  const maximumChunkBytes = canonicalInteger(rawMaximumChunkBytes, 256, 8 * 1_024);

  const controller = new AbortController();
  const removeSignals = installSignalCancellation(controller);
  try {
    const [textVersion, infoVersion] = await Promise.all([
      toolVersion({
        executable: textExecutable,
        args: textVersionArgs,
        tool: "pdftotext",
        timeoutMs,
        signal: controller.signal,
      }),
      toolVersion({
        executable: infoExecutable,
        args: infoVersionArgs,
        tool: "pdfinfo",
        timeoutMs,
        signal: controller.signal,
      }),
    ]);
    if (textVersion !== infoVersion) throw new RunnerFailure("protocol");
    if (mode === "probe") {
      return {
        schemaVersion: 1,
        ready: true,
        engine: "poppler",
        engineVersion: textVersion,
      };
    }

    const info = await invokeTool({
      executable: infoExecutable,
      args: [...infoArgs, filePath as string],
      timeoutMs,
      maxStdoutBytes: 64 * 1_024,
      maxStderrBytes: 16 * 1_024,
      signal: controller.signal,
    });
    if (info.exitCode !== 0 || info.signal !== null || info.stderr.byteLength !== 0) {
      throw new RunnerFailure("tool");
    }
    const pageCount = parsePdfInfo(decodeUtf8(info.stdout), maximumPages);

    const textResult = await invokeTool({
      executable: textExecutable,
      // Deployment-provided prefix arguments support wrappers in tests, while
      // the enforced encoding/EOL/output arguments remain last and therefore
      // cannot be overridden by ordinary Poppler option ordering.
      args: [...textArgs, "-enc", "UTF-8", "-eol", "unix", filePath as string, "-"],
      timeoutMs,
      maxStdoutBytes: maximumRawTextBytes,
      maxStderrBytes: 64 * 1_024,
      signal: controller.signal,
    });
    if (
      textResult.exitCode !== 0
      || textResult.signal !== null
      || textResult.stderr.byteLength !== 0
    ) {
      throw new RunnerFailure("tool");
    }
    const normalized = normalizePopplerText(textResult.stdout, pageCount, {
      maxTextBytes: maximumTextBytes,
      maxChunkCount: maximumChunks,
      maxChunkBytes: maximumChunkBytes,
    });
    return {
      schemaVersion: 1,
      outcome: normalized.chunks.length === 0 ? "no_text" : "extracted",
      engine: "poppler",
      engineVersion: textVersion,
      pageCount,
      chunkCount: normalized.chunks.length,
      textBytes: normalized.textBytes,
      chunks: normalized.chunks,
    };
  } finally {
    removeSignals();
  }
});
