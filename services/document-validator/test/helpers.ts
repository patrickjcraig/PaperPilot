import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validatorConfigurationFromEnvironment,
  type ValidatorConfiguration,
} from "../src/config.js";
import { createDocumentValidatorService } from "../src/service.js";
import type {
  MalwareInspection,
  MalwareRunner,
  PdfInspection,
  PdfInspectionRunner,
  StructuredLogger,
  ValidatorService,
} from "../src/types.js";

export const BEARER_SECRET = "validator-test-secret-".padEnd(64, "x");
export const POLICY_VERSION = "paperpilot-document-validation-v1";
export const STORAGE_VERSION = "local-quarantine-v2";
export const TOOLCHAIN_DIGEST = "b".repeat(64);
export const PDF_BYTES = Buffer.from(
  "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\nstartxref\n0\n%%EOF\n",
  "ascii",
);

export function cleanMalware(overrides: Partial<MalwareInspection> = {}): MalwareInspection {
  return {
    verdict: "clean",
    engine: "clamav",
    engineVersion: "1.4.3",
    signatureVersion: "27835",
    signaturePublishedAt: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
    detectionCount: 0,
    ...overrides,
  };
}

export function validPdf(overrides: Partial<PdfInspection> = {}): PdfInspection {
  return {
    outcome: "valid",
    engine: "qpdf",
    engineVersion: "12.4.0",
    pdfVersion: "1.7",
    pageCount: 1,
    objectCount: 1,
    revisionCount: 1,
    warningCount: 0,
    ...overrides,
  };
}

export class InjectedMalwareRunner implements MalwareRunner {
  inspection: MalwareInspection = cleanMalware();
  inspectImpl?: (filePath: string, signal: AbortSignal) => Promise<MalwareInspection>;
  readyImpl?: (signal: AbortSignal) => Promise<void>;
  inspectCalls = 0;
  readyCalls = 0;

  async inspect(filePath: string, signal: AbortSignal): Promise<MalwareInspection> {
    this.inspectCalls += 1;
    return this.inspectImpl?.(filePath, signal) ?? this.inspection;
  }

  async ready(signal: AbortSignal): Promise<void> {
    this.readyCalls += 1;
    await this.readyImpl?.(signal);
  }
}

export class InjectedPdfRunner implements PdfInspectionRunner {
  inspection: PdfInspection = validPdf();
  inspectImpl?: (filePath: string, signal: AbortSignal) => Promise<PdfInspection>;
  readyImpl?: (signal: AbortSignal) => Promise<void>;
  inspectCalls = 0;
  readyCalls = 0;

  async inspect(filePath: string, signal: AbortSignal): Promise<PdfInspection> {
    this.inspectCalls += 1;
    return this.inspectImpl?.(filePath, signal) ?? this.inspection;
  }

  async ready(signal: AbortSignal): Promise<void> {
    this.readyCalls += 1;
    await this.readyImpl?.(signal);
  }
}

export async function testConfiguration(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Promise<{ configuration: ValidatorConfiguration; removeTempRoot: () => Promise<void> }> {
  const tempRoot = await mkdtemp(join(tmpdir(), "paperpilot-validator-test-"));
  const configuration = validatorConfigurationFromEnvironment({
    PAPERPILOT_VALIDATOR_HOST: "127.0.0.1",
    PAPERPILOT_VALIDATOR_PORT: "0",
    PAPERPILOT_VALIDATOR_BEARER_SECRET: BEARER_SECRET,
    PAPERPILOT_VALIDATOR_POLICY_VERSION: POLICY_VERSION,
    PAPERPILOT_VALIDATOR_TOOLCHAIN_DIGEST: TOOLCHAIN_DIGEST,
    PAPERPILOT_VALIDATOR_TEMP_ROOT: tempRoot,
    PAPERPILOT_VALIDATOR_READINESS_CACHE_MS: "0",
    ...(process.platform === "win32"
      ? { PAPERPILOT_VALIDATOR_ALLOW_INSECURE_WINDOWS_DEVELOPMENT: "1" }
      : {}),
    ...overrides,
  });
  return {
    configuration,
    removeTempRoot: () => rm(tempRoot, { recursive: true, force: true }),
  };
}

export interface StartedTestService {
  service: ValidatorService;
  baseUrl: string;
  configuration: ValidatorConfiguration;
  malwareRunner: InjectedMalwareRunner;
  pdfRunner: InjectedPdfRunner;
  close(): Promise<void>;
}

export async function startTestService(options: {
  configuration?: ValidatorConfiguration;
  malwareRunner?: InjectedMalwareRunner;
  pdfRunner?: InjectedPdfRunner;
  logger?: StructuredLogger;
} = {}): Promise<StartedTestService> {
  const ownedConfiguration = options.configuration === undefined
    ? await testConfiguration()
    : null;
  const configuration = options.configuration ?? ownedConfiguration!.configuration;
  const malwareRunner = options.malwareRunner ?? new InjectedMalwareRunner();
  const pdfRunner = options.pdfRunner ?? new InjectedPdfRunner();
  const service = createDocumentValidatorService(configuration, {
    malwareRunner,
    pdfRunner,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const bound = await service.listen();
  const host = bound.address.includes(":") ? `[${bound.address}]` : bound.address;
  return {
    service,
    baseUrl: `http://${host}:${bound.port}`,
    configuration,
    malwareRunner,
    pdfRunner,
    async close() {
      await service.close();
      await ownedConfiguration?.removeTempRoot();
    },
  };
}

export function validationHeaders(
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
    "X-PaperPilot-Validation-Policy": POLICY_VERSION,
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

export function postValidation(
  service: Pick<StartedTestService, "baseUrl" | "configuration">,
  body = PDF_BYTES,
  headerOverrides: OutgoingHttpHeaders = {},
): Promise<TestHttpResponse> {
  return httpRequest({
    baseUrl: service.baseUrl,
    path: service.configuration.route,
    method: "POST",
    headers: validationHeaders(body, headerOverrides),
    body,
  });
}
