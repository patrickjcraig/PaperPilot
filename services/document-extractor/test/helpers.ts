import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractorConfigurationFromEnvironment,
  type ExtractorConfiguration,
} from "../src/config.js";
import { createDocumentExtractorService } from "../src/service.js";
import type {
  ExtractionRunner,
  ExtractionEngineIdentity,
  ExtractorService,
  PopplerExtraction,
  StructuredLogger,
} from "../src/types.js";

export const BEARER_SECRET = "extractor-test-secret-that-is-long-and-random-2026";
export const POLICY_VERSION = "paperpilot-text-extraction-v1";
export const STORAGE_VERSION = "local-quarantine-v2";
export const TOOLCHAIN_DIGEST = "c".repeat(64);
export const PDF_BYTES = Buffer.from(
  "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\nstartxref\n0\n%%EOF\n",
  "ascii",
);

export function extracted(overrides: Partial<PopplerExtraction> = {}): PopplerExtraction {
  return {
    outcome: "extracted",
    engine: "poppler",
    engineVersion: "25.06.0",
    pageCount: 2,
    chunkCount: 2,
    textBytes: Buffer.byteLength("First paragraphSecond page", "utf8"),
    chunks: [
      { sequence: 0, pageNumber: 1, paragraphId: "p1-p1", text: "First paragraph" },
      { sequence: 1, pageNumber: 2, paragraphId: "p2-p1", text: "Second page" },
    ],
    ...overrides,
  };
}

export class InjectedExtractionRunner implements ExtractionRunner {
  inspection: PopplerExtraction = extracted();
  readiness: ExtractionEngineIdentity = Object.freeze({
    engine: "poppler",
    engineVersion: "25.06.0",
  });
  inspectImpl?: (filePath: string, signal: AbortSignal) => Promise<PopplerExtraction>;
  readyImpl?: (signal: AbortSignal) => Promise<ExtractionEngineIdentity>;
  inspectCalls = 0;
  readyCalls = 0;

  async inspect(filePath: string, signal: AbortSignal): Promise<PopplerExtraction> {
    this.inspectCalls += 1;
    return this.inspectImpl?.(filePath, signal) ?? this.inspection;
  }

  async ready(signal: AbortSignal): Promise<ExtractionEngineIdentity> {
    this.readyCalls += 1;
    return this.readyImpl?.(signal) ?? this.readiness;
  }
}

export async function testConfiguration(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Promise<{ configuration: ExtractorConfiguration; removeTempRoot: () => Promise<void> }> {
  const tempRoot = await mkdtemp(join(tmpdir(), "paperpilot-extractor-test-"));
  const configuration = extractorConfigurationFromEnvironment({
    PAPERPILOT_EXTRACTOR_HOST: "127.0.0.1",
    PAPERPILOT_EXTRACTOR_PORT: "0",
    PAPERPILOT_EXTRACTOR_BEARER_SECRET: BEARER_SECRET,
    PAPERPILOT_EXTRACTOR_POLICY_VERSION: POLICY_VERSION,
    PAPERPILOT_EXTRACTOR_TOOLCHAIN_DIGEST: TOOLCHAIN_DIGEST,
    PAPERPILOT_EXTRACTOR_TEMP_ROOT: tempRoot,
    PAPERPILOT_EXTRACTOR_READINESS_CACHE_MS: "0",
    ...(process.platform === "win32"
      ? { PAPERPILOT_EXTRACTOR_ALLOW_INSECURE_WINDOWS_DEVELOPMENT: "1" }
      : {}),
    ...overrides,
  });
  return {
    configuration,
    removeTempRoot: () => rm(tempRoot, { recursive: true, force: true }),
  };
}

export interface StartedTestService {
  service: ExtractorService;
  baseUrl: string;
  configuration: ExtractorConfiguration;
  runner: InjectedExtractionRunner;
  close(): Promise<void>;
}

export async function startTestService(options: {
  configuration?: ExtractorConfiguration;
  runner?: InjectedExtractionRunner;
  logger?: StructuredLogger;
  onSingleUseComplete?: () => void;
} = {}): Promise<StartedTestService> {
  const owned = options.configuration === undefined ? await testConfiguration() : null;
  const configuration = options.configuration ?? owned!.configuration;
  const runner = options.runner ?? new InjectedExtractionRunner();
  const service = createDocumentExtractorService(configuration, {
    extractionRunner: runner,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.onSingleUseComplete === undefined
      ? {}
      : { onSingleUseComplete: options.onSingleUseComplete }),
  });
  const bound = await service.listen();
  const host = bound.address.includes(":") ? `[${bound.address}]` : bound.address;
  return {
    service,
    baseUrl: `http://${host}:${bound.port}`,
    configuration,
    runner,
    async close() {
      await service.close();
      await owned?.removeTempRoot();
    },
  };
}

export function extractionHeaders(
  body = PDF_BYTES,
  overrides: OutgoingHttpHeaders = {},
): OutgoingHttpHeaders {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${BEARER_SECRET}`,
    "Cache-Control": "no-store",
    "Content-Length": String(body.byteLength),
    "Content-Type": "application/pdf",
    "X-PaperPilot-Content-SHA256": createHash("sha256").update(body).digest("hex"),
    "X-PaperPilot-Storage-Version": STORAGE_VERSION,
    "X-PaperPilot-Extraction-Policy": POLICY_VERSION,
    ...overrides,
  };
}

export interface TestHttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  json(): unknown;
}

export async function httpRequest(input: {
  baseUrl: string;
  path: string;
  method?: string;
  headers?: OutgoingHttpHeaders | readonly string[];
  body?: Buffer;
}): Promise<TestHttpResponse> {
  const url = new URL(input.path, input.baseUrl);
  return new Promise<TestHttpResponse>((resolvePromise, rejectPromise) => {
    const client = request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: input.method ?? "GET",
      ...(input.headers === undefined ? {} : { headers: input.headers }),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once("error", rejectPromise);
      response.once("end", () => {
        const body = Buffer.concat(chunks);
        resolvePromise({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body,
          json: () => JSON.parse(body.toString("utf8")) as unknown,
        });
      });
    });
    client.once("error", rejectPromise);
    if (input.body !== undefined) client.write(input.body);
    client.end();
  });
}

export function postExtraction(
  service: Pick<StartedTestService, "baseUrl" | "configuration">,
  body = PDF_BYTES,
  overrides: OutgoingHttpHeaders = {},
): Promise<TestHttpResponse> {
  return httpRequest({
    baseUrl: service.baseUrl,
    path: service.configuration.route,
    method: "POST",
    headers: extractionHeaders(body, overrides),
    body,
  });
}
