import type { Server } from "node:http";

export const SUPPORTED_PDF_VERSIONS = Object.freeze([
  "1.0",
  "1.1",
  "1.2",
  "1.3",
  "1.4",
  "1.5",
  "1.6",
  "1.7",
  "2.0",
] as const);

export type SupportedPdfVersion = (typeof SUPPORTED_PDF_VERSIONS)[number];

export interface MalwareInspection {
  verdict: "clean" | "infected";
  engine: string;
  engineVersion: string;
  signatureVersion: string;
  signaturePublishedAt: string;
  detectionCount: number;
}

export interface PdfInspection {
  outcome: "valid" | "invalid" | "policy_violation" | "resource_limit";
  engine: string;
  engineVersion: string;
  pdfVersion: SupportedPdfVersion | "unknown";
  pageCount: number | null;
  objectCount: number | null;
  revisionCount: number | null;
  warningCount: number;
}

export interface MalwareRunner {
  inspect(filePath: string, signal: AbortSignal): Promise<MalwareInspection>;
  ready(signal: AbortSignal): Promise<void>;
}

export interface PdfInspectionRunner {
  inspect(filePath: string, signal: AbortSignal): Promise<PdfInspection>;
  ready(signal: AbortSignal): Promise<void>;
}

export interface SafeLogFields {
  requestId?: string;
  route?: "validate" | "livez" | "readyz" | "unknown";
  method?: string;
  status?: number;
  code?: string;
  sizeBytes?: number;
  durationMs?: number;
  malwareVerdict?: "clean" | "infected";
  pdfVerdict?: "valid" | "invalid";
  verdict?: "accepted" | "rejected";
}

export interface StructuredLogger {
  info(event: string, fields?: SafeLogFields): void;
  warn(event: string, fields?: SafeLogFields): void;
  error(event: string, fields?: SafeLogFields): void;
}

export interface ValidatorServiceDependencies {
  malwareRunner: MalwareRunner;
  pdfRunner: PdfInspectionRunner;
  logger?: StructuredLogger;
  clock?: () => Date;
  monotonicClock?: () => number;
}

export interface ValidatorService {
  server: Server;
  listen(): Promise<{ address: string; port: number }>;
  close(): Promise<void>;
}

export interface ExternalDocumentValidationResponse {
  schemaVersion: 1;
  policyVersion: string;
  storageVersion: string;
  toolchainDigest: string;
  verdict: "accepted" | "rejected";
  rejectionCode:
    | "malware_detected"
    | "pdf_invalid"
    | "pdf_policy_violation"
    | "pdf_resource_limit_exceeded"
    | "malware_and_pdf_invalid"
    | null;
  input: {
    sha256: string;
    sizeBytes: string;
  };
  malware: {
    verdict: "clean" | "infected";
    engine: string;
    engineVersion: string;
    signatureVersion: string;
    signaturePublishedAt: string;
    scannedAt: string;
    detectionCount: number;
    durationMs: number;
  };
  pdf: {
    structuralVerdict: "valid" | "invalid";
    engine: string;
    engineVersion: string;
    pdfVersion: SupportedPdfVersion | "unknown";
    pageCount: number | null;
    objectCount: number | null;
    revisionCount: number | null;
    warningCount: number;
    checkedAt: string;
    durationMs: number;
  };
  completedAt: string;
  totalDurationMs: number;
}
