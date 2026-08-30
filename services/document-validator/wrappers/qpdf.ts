#!/usr/bin/env node
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { RunnerFailure } from "../src/errors.js";
import {
  canonicalInteger,
  decodeArgument,
  decodeArguments,
  decodedOutput,
  installSignalCancellation,
  invokeTool,
  wrapperMain,
} from "./common.js";

const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const SUPPORTED_PDF_VERSIONS = new Set([
  "1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "2.0",
]);
const decoder = new TextDecoder("utf-8", { fatal: true });

function invalidPdf(engineVersion: string, warningCount = 1): Record<string, unknown> {
  return {
    schemaVersion: 1,
    outcome: "invalid",
    engine: "qpdf",
    engineVersion,
    pdfVersion: "unknown",
    pageCount: null,
    objectCount: null,
    revisionCount: null,
    warningCount,
  };
}

function resourceLimit(engineVersion: string): Record<string, unknown> {
  return {
    ...invalidPdf(engineVersion),
    outcome: "resource_limit",
  };
}

function isResourceFailure(error: unknown): boolean {
  return error instanceof RunnerFailure
    && (error.kind === "timeout" || error.kind === "output_limit");
}

function parseQpdfVersion(output: string): string {
  for (const line of output.split(/\r?\n/)) {
    const match = /^qpdf version\s+([^\s]+)(?:\s|$)/i.exec(line.trim());
    if (match?.[1] && SAFE_VERSION_PATTERN.test(match[1])) return match[1];
  }
  throw new RunnerFailure("protocol");
}

async function qpdfVersion(input: {
  executable: string;
  versionArgs: readonly string[];
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<string> {
  const result = await invokeTool({
    executable: input.executable,
    args: input.versionArgs,
    timeoutMs: input.timeoutMs,
    maxStdoutBytes: 16 * 1_024,
    maxStderrBytes: 16 * 1_024,
    signal: input.signal,
  });
  if (result.exitCode !== 0 || result.signal !== null) throw new RunnerFailure("tool");
  return parseQpdfVersion(decodedOutput(result, 32 * 1_024));
}

async function qpdf(input: {
  executable: string;
  commonArgs: readonly string[];
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}) {
  return invokeTool({
    executable: input.executable,
    args: [...input.commonArgs, ...input.args],
    timeoutMs: input.timeoutMs,
    maxStdoutBytes: input.maxOutputBytes,
    maxStderrBytes: Math.min(input.maxOutputBytes, 256 * 1_024),
    signal: input.signal,
  });
}

function countToken(
  bytes: Buffer,
  token: Buffer,
  prefixBytes: number,
  current: number,
  maximum: number,
): number {
  let count = current;
  let offset = 0;
  while (true) {
    const index = bytes.indexOf(token, offset);
    if (index < 0) return count;
    if (index + token.byteLength > prefixBytes) count += 1;
    if (count > maximum) return count;
    offset = index + token.byteLength;
  }
}

/**
 * Revision evidence is a deliberately conservative physical measure: after
 * qpdf declares the file structurally valid without warnings, count literal
 * `startxref` and `%%EOF` byte tokens in the bounded source. Counts must match.
 * Tokens embedded in stream data can increase this physical count; deployments
 * can reject that ambiguity by setting a lower revision policy limit.
 */
async function physicalRevisionCount(filePath: string, maximumFileBytes: number): Promise<number> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maximumFileBytes) {
      throw new RunnerFailure("output_limit");
    }
    const startToken = Buffer.from("startxref", "ascii");
    const endToken = Buffer.from("%%EOF", "ascii");
    const overlapBytes = Math.max(startToken.byteLength, endToken.byteLength) - 1;
    let overlap = Buffer.alloc(0);
    let position = 0;
    let startXrefs = 0;
    let endMarkers = 0;
    while (position < info.size) {
      const requested = Math.min(256 * 1_024, info.size - position);
      const chunk = Buffer.allocUnsafe(requested);
      const { bytesRead } = await handle.read(chunk, 0, requested, position);
      if (bytesRead !== requested) throw new RunnerFailure("protocol");
      const bytes = Buffer.concat([overlap, chunk], overlap.byteLength + bytesRead);
      startXrefs = countToken(bytes, startToken, overlap.byteLength, startXrefs, 10_000);
      endMarkers = countToken(bytes, endToken, overlap.byteLength, endMarkers, 10_000);
      if (startXrefs > 10_000 || endMarkers > 10_000) {
        throw new RunnerFailure("output_limit");
      }
      overlap = Buffer.from(bytes.subarray(Math.max(0, bytes.byteLength - overlapBytes)));
      position += bytesRead;
    }
    if (startXrefs < 1 || startXrefs !== endMarkers) throw new RunnerFailure("protocol");
    return startXrefs;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function qpdfMetadata(bytes: Buffer): {
  pdfVersion: string;
  objectCount: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new RunnerFailure("protocol");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RunnerFailure("protocol");
  }
  const qpdfValue = (parsed as Record<string, unknown>).qpdf;
  if (!Array.isArray(qpdfValue) || qpdfValue.length !== 2) {
    throw new RunnerFailure("protocol");
  }
  const header = qpdfValue[0];
  const objects = qpdfValue[1];
  if (
    typeof header !== "object"
    || header === null
    || Array.isArray(header)
    || typeof objects !== "object"
    || objects === null
    || Array.isArray(objects)
  ) {
    throw new RunnerFailure("protocol");
  }
  const pdfVersion = (header as Record<string, unknown>).pdfversion;
  if (typeof pdfVersion !== "string") throw new RunnerFailure("protocol");
  const keys = Object.keys(objects as Record<string, unknown>);
  if (!keys.includes("trailer")) throw new RunnerFailure("protocol");
  const objectKeys = keys.filter((key) => /^obj:[1-9]\d*\s+\d+\s+R$/.test(key));
  if (objectKeys.length !== keys.length - 1 || objectKeys.length < 1) {
    throw new RunnerFailure("protocol");
  }
  return { pdfVersion, objectCount: objectKeys.length };
}

await wrapperMain(async () => {
  const [
    mode,
    encodedExecutable,
    encodedCommonArgs,
    encodedVersionArgs,
    rawTimeoutMs,
    rawMetadataBytes,
    rawMaximumFileBytes,
    filePath,
  ] = process.argv.slice(2);
  if (
    (mode !== "probe" && mode !== "inspect")
    || encodedExecutable === undefined
    || encodedCommonArgs === undefined
    || encodedVersionArgs === undefined
    || rawTimeoutMs === undefined
    || rawMetadataBytes === undefined
    || rawMaximumFileBytes === undefined
    || (mode === "probe" && filePath !== undefined)
    || (mode === "inspect" && (filePath === undefined || filePath.includes("\0")))
  ) {
    throw new RunnerFailure("protocol");
  }
  const executable = decodeArgument(encodedExecutable, 2 * 1_024);
  const commonArgs = decodeArguments(encodedCommonArgs);
  const versionArgs = decodeArguments(encodedVersionArgs);
  const timeoutMs = canonicalInteger(rawTimeoutMs, 100, 120_000);
  const metadataBytes = canonicalInteger(rawMetadataBytes, 16 * 1_024, 32 * 1_024 * 1_024);
  const maximumFileBytes = canonicalInteger(rawMaximumFileBytes, 1, 100 * 1_024 * 1_024);
  const controller = new AbortController();
  const removeSignals = installSignalCancellation(controller);
  try {
    const engineVersion = await qpdfVersion({
      executable,
      versionArgs,
      timeoutMs,
      signal: controller.signal,
    });
    if (mode === "probe") return { schemaVersion: 1, ready: true };

    let check;
    try {
      check = await qpdf({
        executable,
        commonArgs,
        args: ["--check", filePath as string],
        timeoutMs,
        maxOutputBytes: 256 * 1_024,
        signal: controller.signal,
      });
    } catch (error) {
      if (isResourceFailure(error)) {
        return resourceLimit(engineVersion);
      }
      throw error;
    }
    if (check.signal !== null) throw new RunnerFailure("tool");
    if (check.exitCode === 2 || check.exitCode === 3) {
      return invalidPdf(engineVersion);
    }
    if (check.exitCode !== 0) throw new RunnerFailure("tool");
    const checkText = decodedOutput(check, 512 * 1_024);
    const encrypted = /(?:^|\n)File is encrypted(?:\r?$|\s)/m.test(checkText);
    if (!encrypted && !/(?:^|\n)File is not encrypted\s*$/m.test(checkText)) {
      throw new RunnerFailure("protocol");
    }
    if (!/No syntax or stream encoding errors found/.test(checkText)) {
      return invalidPdf(engineVersion);
    }

    let pageResult;
    try {
      pageResult = await qpdf({
        executable,
        commonArgs,
        args: ["--show-npages", filePath as string],
        timeoutMs,
        maxOutputBytes: 16 * 1_024,
        signal: controller.signal,
      });
    } catch (error) {
      if (isResourceFailure(error)) return resourceLimit(engineVersion);
      throw error;
    }
    if (pageResult.exitCode !== 0 || pageResult.signal !== null) return invalidPdf(engineVersion);
    const pageRaw = decodedOutput(pageResult, 32 * 1_024).trim();
    if (!/^[1-9]\d*$/.test(pageRaw)) throw new RunnerFailure("protocol");
    const pageCount = Number(pageRaw);
    if (!Number.isSafeInteger(pageCount) || pageCount > 100_000) {
      return resourceLimit(engineVersion);
    }

    let attachments;
    try {
      attachments = await qpdf({
        executable,
        commonArgs,
        args: ["--list-attachments", filePath as string],
        timeoutMs,
        maxOutputBytes: 256 * 1_024,
        signal: controller.signal,
      });
    } catch (error) {
      if (isResourceFailure(error)) return resourceLimit(engineVersion);
      throw error;
    }
    if (attachments.exitCode !== 0 || attachments.signal !== null) {
      return invalidPdf(engineVersion);
    }
    const hasAttachments = decodedOutput(attachments, 512 * 1_024).trim().length !== 0;

    let metadataResult;
    try {
      metadataResult = await qpdf({
        executable,
        commonArgs,
        args: ["--json", "--json-key=qpdf", "--json-stream-data=none", filePath as string],
        timeoutMs,
        maxOutputBytes: metadataBytes,
        signal: controller.signal,
      });
    } catch (error) {
      if (isResourceFailure(error)) {
        return resourceLimit(engineVersion);
      }
      throw error;
    }
    if (metadataResult.exitCode !== 0 || metadataResult.signal !== null) {
      return invalidPdf(engineVersion);
    }
    const metadata = qpdfMetadata(metadataResult.stdout);
    if (metadata.objectCount > 10_000_000) return resourceLimit(engineVersion);
    if (!SUPPORTED_PDF_VERSIONS.has(metadata.pdfVersion)) return invalidPdf(engineVersion);

    let revisionCount: number;
    try {
      revisionCount = await physicalRevisionCount(filePath as string, maximumFileBytes);
    } catch (error) {
      if (error instanceof RunnerFailure && error.kind === "output_limit") {
        return resourceLimit(engineVersion);
      }
      return invalidPdf(engineVersion);
    }
    return {
      schemaVersion: 1,
      outcome: encrypted || hasAttachments ? "policy_violation" : "valid",
      engine: "qpdf",
      engineVersion,
      pdfVersion: metadata.pdfVersion,
      pageCount,
      objectCount: metadata.objectCount,
      revisionCount,
      warningCount: 0,
    };
  } finally {
    removeSignals();
  }
});
