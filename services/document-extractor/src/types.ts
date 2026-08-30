import type { Server } from "node:http";

export interface ExtractedTextChunk {
  sequence: number;
  pageNumber: number;
  paragraphId: string;
  text: string;
}

export interface PopplerExtraction {
  outcome: "extracted" | "no_text";
  engine: "poppler";
  engineVersion: string;
  pageCount: number;
  chunkCount: number;
  textBytes: number;
  chunks: readonly ExtractedTextChunk[];
}

export interface ExtractionEngineIdentity {
  engine: "poppler";
  engineVersion: string;
}

export interface ExtractionRunner {
  inspect(filePath: string, signal: AbortSignal): Promise<PopplerExtraction>;
  ready(signal: AbortSignal): Promise<ExtractionEngineIdentity>;
}

export interface SafeLogFields {
  requestId?: string;
  route?: "extract" | "livez" | "readyz" | "unknown";
  method?: string;
  status?: number;
  code?: string;
  sizeBytes?: number;
  durationMs?: number;
  pageCount?: number;
  chunkCount?: number;
  textBytes?: number;
  verdict?: "extracted" | "no_text";
}

export interface StructuredLogger {
  info(event: string, fields?: SafeLogFields): void;
  warn(event: string, fields?: SafeLogFields): void;
  error(event: string, fields?: SafeLogFields): void;
}

export interface ExtractorServiceDependencies {
  extractionRunner: ExtractionRunner;
  logger?: StructuredLogger;
  clock?: () => Date;
  monotonicClock?: () => number;
  /** Called only after a single-use service has closed following its admitted request. */
  onSingleUseComplete?: () => void;
}

export interface ExtractorService {
  server: Server;
  listen(): Promise<{ address: string; port: number }>;
  close(): Promise<void>;
}

export interface ExternalDocumentExtractionResponse {
  schemaVersion: 1;
  policyVersion: string;
  storageVersion: string;
  toolchainDigest: string;
  verdict: "extracted" | "no_text";
  input: {
    sha256: string;
    sizeBytes: string;
  };
  extraction: {
    engine: "poppler";
    engineVersion: string;
    pageCount: number;
    chunkCount: number;
    textBytes: number;
    extractedAt: string;
    durationMs: number;
  };
  chunks: ExtractedTextChunk[];
  completedAt: string;
  totalDurationMs: number;
}
