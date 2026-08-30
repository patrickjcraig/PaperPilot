import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, relative, sep } from "node:path";
import type { Duplex } from "node:stream";

import { validateExtractionResult } from "./command-protocol.js";
import type { ExtractorConfiguration } from "./config.js";
import { RunnerFailure, SafeHttpError, safeErrorBody } from "./errors.js";
import { NULL_LOGGER } from "./logger.js";
import type {
  ExternalDocumentExtractionResponse,
  ExtractionEngineIdentity,
  ExtractorService,
  ExtractorServiceDependencies,
  PopplerExtraction,
  StructuredLogger,
} from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;
const ENGINE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const STORAGE_VERSION_MAX_CHARACTERS = 256;
const RUNNER_ABORT_CLEANUP_GRACE_MS = 2_500;

interface ValidatedRequestHeaders {
  expectedSha256: string;
  expectedSizeBytes: number;
  storageVersion: string;
}

interface PrivateRequestFile {
  directoryPath: string;
  filePath: string;
  handle: FileHandle;
}

interface CompletedExtraction {
  value: PopplerExtraction;
  extractedAt: Date;
  durationMs: number;
}

function validatedEngineIdentity(value: unknown): ExtractionEngineIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunnerFailure("protocol");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2
    || !Object.hasOwn(record, "engine")
    || !Object.hasOwn(record, "engineVersion")
    || record.engine !== "poppler"
    || typeof record.engineVersion !== "string"
    || !ENGINE_VERSION_PATTERN.test(record.engineVersion)
  ) {
    throw new RunnerFailure("protocol");
  }
  return Object.freeze({ engine: "poppler", engineVersion: record.engineVersion });
}

function runnerFailureResponse(error: unknown): SafeHttpError {
  if (error instanceof RunnerFailure) {
    if (error.kind === "input_unsupported") {
      return new SafeHttpError("extraction_input_unsupported");
    }
    if (error.kind === "output_limit") return new SafeHttpError("extraction_resource_limit");
  }
  return new SafeHttpError("extraction_unavailable");
}

function exactHeaderCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function singleHeader(request: IncomingMessage, name: string): string | null {
  if (exactHeaderCount(request, name) !== 1) return null;
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

function authorized(raw: string | null, expectedSecret: string): boolean {
  const candidate = raw?.startsWith("Bearer ") ? raw.slice(7) : "";
  const actual = createHash("sha256").update(candidate, "utf8").digest();
  const expected = createHash("sha256").update(expectedSecret, "utf8").digest();
  return candidate.length > 0 && timingSafeEqual(actual, expected);
}

function validateHttp11Host(request: IncomingMessage): void {
  if (
    request.httpVersion !== "1.1"
    || exactHeaderCount(request, "host") !== 1
    || !/^[\x21-\x7e]{1,255}$/.test(singleHeader(request, "host") ?? "")
  ) {
    throw new SafeHttpError("invalid_headers");
  }
}

function rejectFramingHeaders(request: IncomingMessage): void {
  for (const name of ["content-encoding", "transfer-encoding", "expect", "te", "trailer"]) {
    if (request.headers[name] !== undefined) throw new SafeHttpError("invalid_headers");
  }
}

function validateHealthHeaders(request: IncomingMessage): void {
  validateHttp11Host(request);
  rejectFramingHeaders(request);
  const count = exactHeaderCount(request, "content-length");
  if (count > 1 || (count === 1 && singleHeader(request, "content-length") !== "0")) {
    throw new SafeHttpError("invalid_headers");
  }
}

function validateExtractionHeaders(
  request: IncomingMessage,
  configuration: ExtractorConfiguration,
): ValidatedRequestHeaders {
  validateHttp11Host(request);
  rejectFramingHeaders(request);
  const allowedPaperPilotHeaders = new Set([
    "x-paperpilot-content-sha256",
    "x-paperpilot-storage-version",
    "x-paperpilot-extraction-policy",
  ]);
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    if (name?.startsWith("x-paperpilot-") && !allowedPaperPilotHeaders.has(name)) {
      throw new SafeHttpError("invalid_headers");
    }
  }

  if (exactHeaderCount(request, "authorization") !== 1) {
    throw new SafeHttpError("invalid_headers");
  }
  if (!authorized(singleHeader(request, "authorization"), configuration.bearerSecret)) {
    throw new SafeHttpError("unauthorized");
  }
  if (singleHeader(request, "content-type")?.toLowerCase() !== "application/pdf") {
    throw new SafeHttpError("unsupported_media_type");
  }
  if (
    singleHeader(request, "accept")?.toLowerCase() !== "application/json"
    || singleHeader(request, "cache-control")?.toLowerCase() !== "no-store"
  ) {
    throw new SafeHttpError("invalid_headers");
  }

  const rawLength = singleHeader(request, "content-length");
  if (rawLength === null || !/^[1-9]\d{0,15}$/.test(rawLength)) {
    throw new SafeHttpError("invalid_headers");
  }
  const expectedSizeBytes = Number(rawLength);
  if (!Number.isSafeInteger(expectedSizeBytes)) throw new SafeHttpError("invalid_headers");
  if (expectedSizeBytes > configuration.maxBodyBytes) throw new SafeHttpError("body_too_large");

  const expectedSha256 = singleHeader(request, "x-paperpilot-content-sha256");
  const storageVersion = singleHeader(request, "x-paperpilot-storage-version");
  const policyVersion = singleHeader(request, "x-paperpilot-extraction-policy");
  if (
    expectedSha256 === null
    || !SHA256_PATTERN.test(expectedSha256)
    || storageVersion === null
    || storageVersion.length > STORAGE_VERSION_MAX_CHARACTERS
    || !SAFE_IDENTIFIER_PATTERN.test(storageVersion)
    || policyVersion === null
    || policyVersion.length > 128
    || !SAFE_IDENTIFIER_PATTERN.test(policyVersion)
  ) {
    throw new SafeHttpError("invalid_headers");
  }
  if (policyVersion !== configuration.policyVersion) throw new SafeHttpError("policy_mismatch");
  return { expectedSha256, expectedSizeBytes, storageVersion };
}

function securePathInside(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent !== "" && fromParent !== ".." && !fromParent.startsWith(`..${sep}`);
}

async function prepareTemporaryRoot(
  root: string,
  production: boolean | undefined,
  unsafeWindowsDevelopment: boolean | undefined,
): Promise<void> {
  if (process.platform === "win32" && (production === true || unsafeWindowsDevelopment !== true)) {
    throw new Error("Windows extraction requires private DACL support that is not implemented.");
  }
  const created = await mkdir(root, { recursive: true, mode: 0o700 });
  if (created !== undefined && process.platform !== "win32") await chmod(root, 0o700);
  const info = await lstat(root);
  const expectedUid = process.platform === "win32" ? undefined : process.geteuid?.();
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || (expectedUid !== undefined && info.uid !== expectedUid)
  ) {
    throw new Error("The extractor temporary root is not a private owned directory.");
  }
  const canonical = await realpath(root);
  const same = process.platform === "win32"
    ? canonical.toLowerCase() === root.toLowerCase()
    : canonical === root;
  if (!same) throw new Error("The extractor temporary root must not be an alias.");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("The extractor temporary root grants group or world access.");
  }
}

async function createPrivateRequestFile(root: string): Promise<PrivateRequestFile> {
  const directoryPath = await mkdtemp(join(root, "request-"));
  const filePath = join(directoryPath, "input.pdf");
  let handle: FileHandle | null = null;
  try {
    if (!securePathInside(root, directoryPath)) throw new Error("Temporary directory escaped root.");
    if (process.platform !== "win32") await chmod(directoryPath, 0o700);
    const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    handle = await open(
      filePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
      0o600,
    );
    const info = await handle.stat();
    const expectedUid = process.platform === "win32" ? undefined : process.geteuid?.();
    if (
      !info.isFile()
      || info.nlink !== 1
      || (expectedUid !== undefined && info.uid !== expectedUid)
      || (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    ) {
      throw new Error("The private extraction request file was not secure.");
    }
    return { directoryPath, filePath, handle };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(filePath).catch(() => undefined);
    await rmdir(directoryPath).catch(() => undefined);
    throw error;
  }
}

async function cleanupPrivateRequestFile(
  root: string,
  file: Omit<PrivateRequestFile, "handle">,
): Promise<boolean> {
  if (
    !securePathInside(root, file.directoryPath)
    || dirname(file.filePath) !== file.directoryPath
    || !securePathInside(file.directoryPath, file.filePath)
  ) {
    return false;
  }
  try { await unlink(file.filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  try { await rmdir(file.directoryPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  return true;
}

async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (bytesWritten < 1) throw new Error("The private request file could not be written.");
    offset += bytesWritten;
  }
}

async function hashPrivateFile(filePath: string, expectedSizeBytes: number): Promise<string> {
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== expectedSizeBytes) {
      throw new RunnerFailure("tool");
    }
    const hash = createHash("sha256");
    let position = 0;
    while (position < expectedSizeBytes) {
      const size = Math.min(256 * 1_024, expectedSizeBytes - position);
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(buffer, 0, size, position);
      if (bytesRead !== size) throw new RunnerFailure("tool");
      hash.update(buffer);
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function receiveRequestBody(input: {
  request: IncomingMessage;
  handle: FileHandle;
  expectedSizeBytes: number;
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  signal: AbortSignal;
}): Promise<string> {
  if (input.signal.aborted) throw new SafeHttpError("body_incomplete");
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    let receivedBytes = 0;
    let ended = false;
    let settled = false;
    let pendingWrite = Promise.resolve();
    let idleTimer: NodeJS.Timeout;

    const cleanup = () => {
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      input.signal.removeEventListener("abort", onSignalAbort);
      input.request.removeListener("data", onData);
      input.request.removeListener("end", onEnd);
      input.request.removeListener("aborted", onAborted);
      input.request.removeListener("error", onError);
      input.request.removeListener("close", onClose);
    };
    const fail = (error: SafeHttpError) => {
      if (settled) return;
      settled = true;
      input.request.pause();
      cleanup();
      rejectPromise(error);
    };
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new SafeHttpError("body_timeout")), input.idleTimeoutMs);
      idleTimer.unref?.();
    };
    const onData = (rawChunk: Buffer | string) => {
      if (settled) return;
      input.request.pause();
      clearTimeout(idleTimer);
      if (!Buffer.isBuffer(rawChunk)) {
        fail(new SafeHttpError("body_incomplete"));
        return;
      }
      receivedBytes += rawChunk.byteLength;
      if (receivedBytes > input.expectedSizeBytes) {
        fail(new SafeHttpError("body_too_large"));
        return;
      }
      hash.update(rawChunk);
      pendingWrite = pendingWrite.then(() => writeAll(input.handle, rawChunk));
      void pendingWrite.then(() => {
        if (!settled && !ended) {
          resetIdle();
          input.request.resume();
        }
      }).catch(() => fail(new SafeHttpError("internal_error")));
    };
    const onEnd = () => {
      ended = true;
      clearTimeout(idleTimer);
      void pendingWrite.then(async () => {
        if (settled) return;
        if (receivedBytes !== input.expectedSizeBytes || !input.request.complete) {
          fail(new SafeHttpError("body_incomplete"));
          return;
        }
        await input.handle.sync();
        settled = true;
        cleanup();
        resolvePromise(hash.digest("hex"));
      }).catch(() => fail(new SafeHttpError("internal_error")));
    };
    const onAborted = () => fail(new SafeHttpError("body_incomplete"));
    const onError = () => fail(new SafeHttpError("body_incomplete"));
    const onClose = () => { if (!ended) fail(new SafeHttpError("body_incomplete")); };
    const onSignalAbort = () => fail(new SafeHttpError("body_incomplete"));
    const absoluteTimer = setTimeout(
      () => fail(new SafeHttpError("body_timeout")),
      input.absoluteTimeoutMs,
    );
    absoluteTimer.unref?.();
    input.signal.addEventListener("abort", onSignalAbort, { once: true });
    input.request.on("data", onData);
    input.request.once("end", onEnd);
    input.request.once("aborted", onAborted);
    input.request.once("error", onError);
    input.request.once("close", onClose);
    resetIdle();
    input.request.resume();
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new RunnerFailure("aborted"));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let aborted = false;
    let cleanupGrace: NodeJS.Timeout | undefined;
    const abort = () => {
      if (aborted) return;
      aborted = true;
      cleanupGrace = setTimeout(
        () => rejectPromise(new RunnerFailure("aborted")),
        RUNNER_ABORT_CLEANUP_GRACE_MS,
      );
      cleanupGrace.unref?.();
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => aborted ? rejectPromise(new RunnerFailure("aborted")) : resolvePromise(value),
      (error: unknown) => aborted ? rejectPromise(new RunnerFailure("aborted")) : rejectPromise(error),
    ).finally(() => {
      if (cleanupGrace !== undefined) clearTimeout(cleanupGrace);
      signal.removeEventListener("abort", abort);
    });
  });
}

function safeNow(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RunnerFailure("protocol");
  }
  return new Date(value.getTime());
}

function duration(startedAt: number, monotonicClock: () => number, maximum: number): number {
  const value = Math.max(0, Math.round(monotonicClock() - startedAt));
  if (!Number.isSafeInteger(value) || value > maximum) throw new RunnerFailure("timeout");
  return value;
}

async function extractWithTiming(input: {
  filePath: string;
  configuration: ExtractorConfiguration;
  dependencies: ExtractorServiceDependencies;
  signal: AbortSignal;
}): Promise<CompletedExtraction> {
  const clock = input.dependencies.clock ?? (() => new Date());
  const monotonicClock = input.dependencies.monotonicClock ?? (() => performance.now());
  const startedAt = monotonicClock();
  const raw = await abortable(
    input.dependencies.extractionRunner.inspect(input.filePath, input.signal),
    input.signal,
  );
  const value = validateExtractionResult(raw, {
    maxPageCount: input.configuration.maxPageCount,
    maxTextBytes: input.configuration.maxTextBytes,
    maxChunkCount: input.configuration.maxChunkCount,
    maxChunkBytes: input.configuration.maxChunkBytes,
  });
  return {
    value,
    extractedAt: safeNow(clock),
    durationMs: duration(startedAt, monotonicClock, input.configuration.extractionTimeoutMs),
  };
}

function responseBody(input: {
  extraction: CompletedExtraction;
  configuration: ExtractorConfiguration;
  expectedSha256: string;
  expectedSizeBytes: number;
  storageVersion: string;
  completedAt: Date;
  totalDurationMs: number;
}): ExternalDocumentExtractionResponse {
  if (input.extraction.extractedAt.getTime() > input.completedAt.getTime()) {
    throw new RunnerFailure("protocol");
  }
  return {
    schemaVersion: 1,
    policyVersion: input.configuration.policyVersion,
    storageVersion: input.storageVersion,
    toolchainDigest: input.configuration.toolchainDigest,
    verdict: input.extraction.value.outcome,
    input: {
      sha256: input.expectedSha256,
      sizeBytes: String(input.expectedSizeBytes),
    },
    extraction: {
      engine: input.extraction.value.engine,
      engineVersion: input.extraction.value.engineVersion,
      pageCount: input.extraction.value.pageCount,
      chunkCount: input.extraction.value.chunkCount,
      textBytes: input.extraction.value.textBytes,
      extractedAt: input.extraction.extractedAt.toISOString(),
      durationMs: input.extraction.durationMs,
    },
    chunks: input.extraction.value.chunks.map((chunk) => ({ ...chunk })),
    completedAt: input.completedAt.toISOString(),
    totalDurationMs: input.totalDurationMs,
  };
}

function writeJsonResponse(
  response: ServerResponse,
  status: number,
  body: string,
  options: { close?: boolean; allow?: string } = {},
): void {
  const bytes = Buffer.from(body, "utf8");
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Content-Length", String(bytes.byteLength));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (options.allow !== undefined) response.setHeader("Allow", options.allow);
  if (options.close) {
    response.shouldKeepAlive = false;
    response.setHeader("Connection", "close");
  }
  response.end(bytes);
}

function writeSafeError(
  request: IncomingMessage,
  response: ServerResponse,
  error: SafeHttpError,
  allow?: string,
): void {
  writeJsonResponse(response, error.status, safeErrorBody(error), {
    close: true,
    ...(allow === undefined ? {} : { allow }),
  });
  if (!request.complete) response.once("finish", () => request.destroy());
}

function endSocketWithSafeError(
  socket: Duplex,
  status: number,
  statusText: string,
  error: SafeHttpError,
): void {
  if (!socket.writable) return;
  const body = safeErrorBody(error);
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function routeFor(
  url: string | undefined,
  extractionRoute: string,
): "extract" | "livez" | "readyz" | "unknown" {
  if (url === extractionRoute) return "extract";
  if (url === "/livez") return "livez";
  if (url === "/readyz") return "readyz";
  return "unknown";
}

export function createDocumentExtractorService(
  configuration: ExtractorConfiguration,
  dependencies: ExtractorServiceDependencies,
): ExtractorService {
  if (
    typeof configuration.singleUse !== "boolean"
    || !Number.isSafeInteger(configuration.maxConcurrentExtractions)
    || configuration.maxConcurrentExtractions < 1
    || configuration.maxConcurrentExtractions > 8
    || (configuration.singleUse && configuration.maxConcurrentExtractions !== 1)
    || (configuration.production === true
      && (!configuration.singleUse || configuration.maxConcurrentExtractions !== 1))
  ) {
    throw new Error("The extractor concurrency and single-use configuration is invalid.");
  }
  const logger: StructuredLogger = dependencies.logger ?? NULL_LOGGER;
  let activeExtractions = 0;
  let listening = false;
  let starting = false;
  let permanentlyClosed = false;
  let shuttingDown = false;
  let tempRootPrepared = false;
  let startOperation: Promise<{ address: string; port: number }> | null = null;
  let closeOperation: Promise<void> | null = null;
  let readiness: { checkedAt: number; identity: ExtractionEngineIdentity | null } | null = null;
  let readinessPromise: Promise<ExtractionEngineIdentity | null> | null = null;
  let singleUseConsumed = false;
  let singleUseShutdownScheduled = false;
  const activeControllers = new Set<AbortController>();

  const checkReadiness = async (): Promise<ExtractionEngineIdentity | null> => {
    if (shuttingDown || singleUseConsumed || !tempRootPrepared) return null;
    const now = Date.now();
    if (readiness !== null && now - readiness.checkedAt <= configuration.readinessCacheMs) {
      return readiness.identity;
    }
    if (readinessPromise !== null) return readinessPromise;
    readinessPromise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), configuration.readinessTimeoutMs);
      timeout.unref?.();
      try {
        const identity = validatedEngineIdentity(await abortable(
          dependencies.extractionRunner.ready(controller.signal),
          controller.signal,
        ));
        readiness = { checkedAt: Date.now(), identity };
        return identity;
      } catch {
        readiness = { checkedAt: Date.now(), identity: null };
        return null;
      } finally {
        clearTimeout(timeout);
      }
    })().finally(() => { readinessPromise = null; });
    return readinessPromise;
  };

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const requestId = randomUUID();
    const route = routeFor(request.url, configuration.route);
    const startedAt = performance.now();
    let responseStatus = 500;
    let logCode = "internal_error";
    try {
      if (route === "unknown") throw new SafeHttpError("not_found");
      if (request.method !== (route === "extract" ? "POST" : "GET")) {
        const error = new SafeHttpError("method_not_allowed");
        responseStatus = error.status;
        logCode = error.code;
        writeSafeError(request, response, error, route === "extract" ? "POST" : "GET");
        return;
      }
      if (route !== "extract") validateHealthHeaders(request);
      if (route === "livez") {
        responseStatus = 200;
        logCode = "live";
        writeJsonResponse(response, 200, '{"status":"live"}');
        return;
      }
      if (route === "readyz") {
        if (!authorized(singleHeader(request, "authorization"), configuration.bearerSecret)) {
          throw new SafeHttpError("unauthorized");
        }
        if (shuttingDown || activeExtractions >= configuration.maxConcurrentExtractions) {
          throw new SafeHttpError("not_ready");
        }
        const identity = await checkReadiness();
        if (
          identity === null
          || shuttingDown
          || singleUseConsumed
          || activeExtractions >= configuration.maxConcurrentExtractions
        ) {
          throw new SafeHttpError("not_ready");
        }
        responseStatus = 200;
        logCode = "ready";
        writeJsonResponse(response, 200, JSON.stringify({
          schemaVersion: 1,
          status: "ready",
          policyVersion: configuration.policyVersion,
          toolchainDigest: configuration.toolchainDigest,
          engine: identity.engine,
          engineVersion: identity.engineVersion,
        }));
        return;
      }
      // `extractor_busy` is reserved for requests rejected before admission.
      // The worker may safely release its provisional durable claim only for
      // this exact code; transient failures after admission remain
      // `extraction_unavailable` and consume the execution attempt.
      if (shuttingDown) throw new SafeHttpError("extractor_busy");
      const headers = validateExtractionHeaders(request, configuration);
      if (configuration.singleUse && singleUseConsumed) {
        throw new SafeHttpError("extractor_busy");
      }
      if (activeExtractions >= configuration.maxConcurrentExtractions) {
        throw new SafeHttpError("extractor_busy");
      }

      if (configuration.singleUse) singleUseConsumed = true;
      activeExtractions += 1;
      if (configuration.singleUse) {
        const scheduleShutdown = () => {
          if (singleUseShutdownScheduled) return;
          singleUseShutdownScheduled = true;
          shuttingDown = true;
          queueMicrotask(() => {
            void service.close().then(() => {
              try { dependencies.onSingleUseComplete?.(); } catch {
                logger.error("single_use_callback_failed", { code: "single_use_callback_failed" });
              }
            }).catch(() => {
              logger.error("single_use_shutdown_failed", { code: "single_use_shutdown_failed" });
            });
          });
        };
        response.once("finish", scheduleShutdown);
        response.once("close", scheduleShutdown);
      }
      const controller = new AbortController();
      activeControllers.add(controller);
      const onResponseClose = () => { if (!response.writableEnded) controller.abort(); };
      response.once("close", onResponseClose);
      let temporary: PrivateRequestFile | null = null;
      try {
        temporary = await createPrivateRequestFile(configuration.tempRoot);
        const actualSha256 = await receiveRequestBody({
          request,
          handle: temporary.handle,
          expectedSizeBytes: headers.expectedSizeBytes,
          idleTimeoutMs: configuration.bodyIdleTimeoutMs,
          absoluteTimeoutMs: configuration.bodyAbsoluteTimeoutMs,
          signal: controller.signal,
        });
        await temporary.handle.close();
        if (actualSha256 !== headers.expectedSha256) {
          throw new SafeHttpError("content_mismatch");
        }
        if (process.platform !== "win32") await chmod(temporary.filePath, 0o400);

        const totalStartedAt = dependencies.monotonicClock?.() ?? performance.now();
        let extractionTimedOut = false;
        const extractionTimer = setTimeout(() => {
          extractionTimedOut = true;
          controller.abort();
        }, configuration.extractionTimeoutMs);
        extractionTimer.unref?.();
        let extraction: CompletedExtraction;
        try {
          extraction = await extractWithTiming({
            filePath: temporary.filePath,
            configuration,
            dependencies,
            signal: controller.signal,
          });
          const finalSha256 = await hashPrivateFile(temporary.filePath, headers.expectedSizeBytes);
          if (finalSha256 !== headers.expectedSha256) throw new RunnerFailure("tool");
        } catch (error) {
          if (extractionTimedOut) throw new SafeHttpError("extraction_unavailable");
          throw runnerFailureResponse(error);
        } finally {
          clearTimeout(extractionTimer);
        }

        const clock = dependencies.clock ?? (() => new Date());
        const monotonicClock = dependencies.monotonicClock ?? (() => performance.now());
        const completedAt = safeNow(clock);
        const totalDurationMs = duration(
          totalStartedAt,
          monotonicClock,
          configuration.extractionTimeoutMs,
        );
        if (totalDurationMs < extraction.durationMs) throw new SafeHttpError("internal_error");
        const attestation = responseBody({
          extraction,
          configuration,
          expectedSha256: headers.expectedSha256,
          expectedSizeBytes: headers.expectedSizeBytes,
          storageVersion: headers.storageVersion,
          completedAt,
          totalDurationMs,
        });
        const body = JSON.stringify(attestation);
        if (Buffer.byteLength(body, "utf8") > configuration.maxResponseBytes) {
          throw new SafeHttpError("internal_error");
        }
        if (!await cleanupPrivateRequestFile(configuration.tempRoot, temporary)) {
          throw new SafeHttpError("internal_error");
        }
        temporary = null;
        responseStatus = 200;
        logCode = attestation.verdict;
        writeJsonResponse(response, 200, body, { close: configuration.singleUse });
        logger.info("extraction_completed", {
          requestId,
          route,
          status: 200,
          sizeBytes: headers.expectedSizeBytes,
          pageCount: attestation.extraction.pageCount,
          chunkCount: attestation.extraction.chunkCount,
          textBytes: attestation.extraction.textBytes,
          verdict: attestation.verdict,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
      } finally {
        response.removeListener("close", onResponseClose);
        controller.abort();
        activeControllers.delete(controller);
        activeExtractions -= 1;
        if (temporary !== null) {
          await temporary.handle.close().catch(() => undefined);
          if (!await cleanupPrivateRequestFile(configuration.tempRoot, temporary)) {
            logger.error("temporary_cleanup_failed", {
              requestId,
              route,
              code: "temporary_cleanup_failed",
            });
          }
        }
      }
    } catch (caught) {
      const error = caught instanceof SafeHttpError
        ? caught
        : new SafeHttpError("internal_error");
      responseStatus = error.status;
      logCode = error.code;
      if (!response.headersSent && !response.destroyed) writeSafeError(request, response, error);
      if (error.status < 500) {
        logger.warn("request_rejected", {
          requestId,
          route,
          method: request.method ?? "UNKNOWN",
          status: error.status,
          code: error.code,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
      }
    } finally {
      if (responseStatus >= 500) {
        logger.error("request_failed", {
          requestId,
          route,
          status: responseStatus,
          code: logCode,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
      }
    }
  };

  const server = createServer({
    maxHeaderSize: configuration.maxHeaderBytes,
    headersTimeout: Math.min(10_000, configuration.bodyAbsoluteTimeoutMs),
    requestTimeout: configuration.bodyAbsoluteTimeoutMs + 2_000,
    keepAliveTimeout: 5_000,
    connectionsCheckingInterval: 1_000,
  }, (request, response) => { void handler(request, response); });
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = configuration.maxRequestsPerSocket;
  server.maxConnections = configuration.maxConcurrentExtractions * 8 + 16;
  server.on("checkContinue", (request, response) => {
    writeSafeError(request, response, new SafeHttpError("invalid_headers"));
  });
  server.on("checkExpectation", (request, response) => {
    writeSafeError(request, response, new SafeHttpError("invalid_headers"));
  });
  server.on("clientError", (_error, socket) => {
    endSocketWithSafeError(socket, 400, "Bad Request", new SafeHttpError("invalid_headers"));
  });
  server.on("upgrade", (_request, socket) => {
    endSocketWithSafeError(socket, 400, "Bad Request", new SafeHttpError("invalid_headers"));
  });
  server.on("dropRequest", (_request, socket) => {
    endSocketWithSafeError(socket, 503, "Service Unavailable", new SafeHttpError("extractor_busy"));
  });

  const service: ExtractorService = {
    server,
    async listen() {
      if (listening || starting || permanentlyClosed) {
        throw new Error("The extractor cannot be started in its current lifecycle state.");
      }
      starting = true;
      startOperation = (async () => {
        try {
          await prepareTemporaryRoot(
            configuration.tempRoot,
            configuration.production,
            configuration.unsafeWindowsDevelopment,
          );
          await new Promise<void>((resolvePromise, rejectPromise) => {
            const onError = (error: Error) => {
              server.removeListener("listening", onListening);
              rejectPromise(error);
            };
            const onListening = () => {
              server.removeListener("error", onError);
              resolvePromise();
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(configuration.port, configuration.host);
          });
          if (permanentlyClosed) throw new Error("The extractor was closed while starting.");
          const address = server.address();
          if (address === null || typeof address === "string") {
            throw new Error("The extractor did not bind a TCP address.");
          }
          tempRootPrepared = true;
          listening = true;
          logger.info("service_listening", { status: 200 });
          return { address: address.address, port: address.port };
        } catch (error) {
          tempRootPrepared = false;
          if (server.listening) {
            await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
          }
          throw error;
        } finally {
          starting = false;
        }
      })();
      try { return await startOperation; } finally { startOperation = null; }
    },
    async close() {
      if (closeOperation !== null) return closeOperation;
      permanentlyClosed = true;
      shuttingDown = true;
      closeOperation = (async () => {
        if (startOperation !== null) await startOperation.catch(() => undefined);
        if (!listening && !server.listening) return;
        server.closeIdleConnections?.();
        await new Promise<void>((resolvePromise) => {
          const force = setTimeout(() => {
            for (const controller of activeControllers) controller.abort();
            server.closeAllConnections?.();
          }, configuration.gracefulShutdownMs);
          force.unref?.();
          server.close(() => {
            clearTimeout(force);
            resolvePromise();
          });
        });
        listening = false;
        tempRootPrepared = false;
        logger.info("service_stopped", { status: 200 });
      })();
      return closeOperation;
    },
  };
  return service;
}
