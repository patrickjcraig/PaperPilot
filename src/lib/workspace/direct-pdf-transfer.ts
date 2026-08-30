const SUPABASE_PROJECT_ORIGIN = "https://avmcmmayvnjxrhrmgsdx.supabase.co";
const SUPABASE_UPLOAD_PATH = /^\/storage\/v1\/object\/upload\/sign\/paperpilot-private-pdfs\/tenants\/[a-f0-9]{64}\/assets\/[a-f0-9]{64}\/attempts\/[a-f0-9]{64}\/original\.pdf$/u;
const SUPABASE_READ_PATH = /^\/storage\/v1\/object\/sign\/paperpilot-private-pdfs\/tenants\/[a-f0-9]{64}\/assets\/[a-f0-9]{64}\/attempts\/[a-f0-9]{64}\/original\.pdf$/u;
const FINALIZE_PATH = /^\/api\/workspaces\/([^/?#]+)\/uploads\/([^/?#]+)\/finalize$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_CAPABILITY_LIFETIME_MS = 2 * 60 * 60 * 1_000;
const EXPIRY_CLOCK_SKEW_MS = 30 * 1_000;

const UPLOAD_HEADERS = Object.freeze({
  "cache-control": "max-age=0",
  "content-type": "application/pdf",
  "x-upsert": "false",
} as const);

export interface DirectPdfTransferPlanV1 {
  readonly schemaVersion: 1;
  readonly provider: "SUPABASE_STORAGE";
  readonly uploadSessionId: string;
  readonly attemptId: string;
  readonly method: "PUT";
  /** Ephemeral bearer capability. Never persist, log, or put in provenance. */
  readonly url: string;
  readonly headers: typeof UPLOAD_HEADERS;
  readonly expectedSizeBytes: number;
  readonly expectedSha256: string;
  readonly expiresAt: string;
  readonly finalizeUrl: string;
}

export interface DirectPdfReadPlanV1 {
  readonly schemaVersion: 1;
  readonly provider: "SUPABASE_STORAGE";
  readonly documentId: string;
  readonly method: "GET";
  /** Ephemeral bearer capability. Never persist, log, or put in provenance. */
  readonly url: string;
  readonly headers: Readonly<Record<string, never>>;
  readonly inputSizeBytes: number;
  readonly inputSha256: string;
  readonly objectVersion: string;
  readonly mediaType: "application/pdf";
  readonly expiresAt: string;
}

export interface CreateDirectPdfTransferCommandV1 {
  readonly schemaVersion: 1;
  readonly clientOperationId: string;
  readonly expectedUploadId: string;
  readonly expectedSizeBytes: number;
  readonly expectedSha256: string;
}

export interface FinalizeDirectPdfTransferCommandV1 {
  readonly schemaVersion: 1;
  readonly clientOperationId: string;
  readonly attemptId: string;
  readonly expectedSizeBytes: number;
  readonly expectedSha256: string;
}

export interface DirectPdfTransferProgress {
  loadedBytes: number;
  totalBytes: number;
}

export interface DirectPdfTransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DirectPdfTransferProgress) => void;
}

export type XMLHttpRequestFactory = () => XMLHttpRequest;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isProviderVersion(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && new TextEncoder().encode(value).byteLength <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isPdfSize(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_PDF_BYTES;
}

function canonicalExpiry(value: unknown, now: Date): value is string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) return false;
  const expiresAt = new Date(value);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== value) return false;
  const lifetime = expiresAt.getTime() - now.getTime();
  return lifetime > -EXPIRY_CLOCK_SKEW_MS
    && lifetime <= MAX_CAPABILITY_LIFETIME_MS + EXPIRY_CLOCK_SKEW_MS;
}

function signedCapabilityUrl(
  value: unknown,
  expectedPath: RegExp,
  allowedQueryKeys: ReadonlySet<string>,
): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.origin !== SUPABASE_PROJECT_ORIGIN
    || url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.hash
    || !expectedPath.test(url.pathname)
  ) return false;

  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== allowedQueryKeys.size
    || entries.some(([key, token]) =>
      !allowedQueryKeys.has(key)
      || token.length < 16
      || token.length > 8_192
      || /[\u0000-\u001f\u007f]/u.test(token))
    || new Set(entries.map(([key]) => key)).size !== allowedQueryKeys.size
  ) return false;
  return true;
}

function parseUploadHeaders(value: unknown): typeof UPLOAD_HEADERS | null {
  if (!isRecord(value) || !exactKeys(value, Object.keys(UPLOAD_HEADERS))) return null;
  for (const [name, expected] of Object.entries(UPLOAD_HEADERS)) {
    if (value[name] !== expected) return null;
  }
  return UPLOAD_HEADERS;
}

/**
 * Parse the only browser-visible upload capability PaperPilot accepts. The
 * closed profile prevents a compromised control response from redirecting PDF
 * bytes, attaching ambient cookies, or widening provider headers.
 */
export function parseDirectPdfTransferPlan(
  value: unknown,
  now = new Date(),
): DirectPdfTransferPlanV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion",
    "provider",
    "uploadSessionId",
    "attemptId",
    "method",
    "url",
    "headers",
    "expectedSizeBytes",
    "expectedSha256",
    "expiresAt",
    "finalizeUrl",
  ])) return null;
  const headers = parseUploadHeaders(value.headers);
  const finalizeUrl = typeof value.finalizeUrl === "string"
    ? value.finalizeUrl
    : null;
  const finalize = finalizeUrl ? FINALIZE_PATH.exec(finalizeUrl) : null;
  let finalizedUploadId: string | null = null;
  try {
    finalizedUploadId = finalize ? decodeURIComponent(finalize[2]) : null;
  } catch {
    finalizedUploadId = null;
  }
  if (
    value.schemaVersion !== 1
    || value.provider !== "SUPABASE_STORAGE"
    || !isOpaqueId(value.uploadSessionId)
    || !isOpaqueId(value.attemptId)
    || value.method !== "PUT"
    || !signedCapabilityUrl(value.url, SUPABASE_UPLOAD_PATH, new Set(["token"]))
    || !headers
    || !isPdfSize(value.expectedSizeBytes)
    || !isSha256(value.expectedSha256)
    || !canonicalExpiry(value.expiresAt, now)
    || !finalize
    || finalizedUploadId !== value.uploadSessionId
  ) return null;

  return Object.freeze({
    schemaVersion: 1,
    provider: "SUPABASE_STORAGE",
    uploadSessionId: value.uploadSessionId,
    attemptId: value.attemptId,
    method: "PUT",
    url: value.url,
    headers,
    expectedSizeBytes: value.expectedSizeBytes,
    expectedSha256: value.expectedSha256,
    expiresAt: value.expiresAt,
    finalizeUrl: finalizeUrl as string,
  });
}

export function parseCreateDirectPdfTransferCommand(
  value: unknown,
): CreateDirectPdfTransferCommandV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion",
    "clientOperationId",
    "expectedUploadId",
    "expectedSizeBytes",
    "expectedSha256",
  ])) return null;
  if (
    value.schemaVersion !== 1
    || !isOpaqueId(value.clientOperationId)
    || !isOpaqueId(value.expectedUploadId)
    || !isPdfSize(value.expectedSizeBytes)
    || !isSha256(value.expectedSha256)
  ) return null;
  return Object.freeze({
    schemaVersion: 1,
    clientOperationId: value.clientOperationId,
    expectedUploadId: value.expectedUploadId,
    expectedSizeBytes: value.expectedSizeBytes,
    expectedSha256: value.expectedSha256,
  });
}

export function parseFinalizeDirectPdfTransferCommand(
  value: unknown,
): FinalizeDirectPdfTransferCommandV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion",
    "clientOperationId",
    "attemptId",
    "expectedSizeBytes",
    "expectedSha256",
  ])) return null;
  if (
    value.schemaVersion !== 1
    || !isOpaqueId(value.clientOperationId)
    || !isOpaqueId(value.attemptId)
    || !isPdfSize(value.expectedSizeBytes)
    || !isSha256(value.expectedSha256)
  ) return null;
  return Object.freeze({
    schemaVersion: 1,
    clientOperationId: value.clientOperationId,
    attemptId: value.attemptId,
    expectedSizeBytes: value.expectedSizeBytes,
    expectedSha256: value.expectedSha256,
  });
}

export function parseDirectPdfReadPlan(
  value: unknown,
  now = new Date(),
): DirectPdfReadPlanV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion",
    "provider",
    "documentId",
    "method",
    "url",
    "headers",
    "inputSizeBytes",
    "inputSha256",
    "objectVersion",
    "mediaType",
    "expiresAt",
  ])) return null;
  if (
    value.schemaVersion !== 1
    || value.provider !== "SUPABASE_STORAGE"
    || !isOpaqueId(value.documentId)
    || value.method !== "GET"
    || !signedCapabilityUrl(value.url, SUPABASE_READ_PATH, new Set(["token"]))
    || !isRecord(value.headers)
    || Object.keys(value.headers).length !== 0
    || !isPdfSize(value.inputSizeBytes)
    || !isSha256(value.inputSha256)
    || !isProviderVersion(value.objectVersion)
    || value.mediaType !== "application/pdf"
    || !canonicalExpiry(value.expiresAt, now)
  ) return null;
  return Object.freeze({
    schemaVersion: 1,
    provider: "SUPABASE_STORAGE",
    documentId: value.documentId,
    method: "GET",
    url: value.url,
    headers: Object.freeze({}),
    inputSizeBytes: value.inputSizeBytes,
    inputSha256: value.inputSha256,
    objectVersion: value.objectVersion,
    mediaType: "application/pdf",
    expiresAt: value.expiresAt,
  });
}

/** Upload the untouched PDF directly to the signed provider URL. */
export function uploadPdfDirectly(
  planValue: unknown,
  file: File,
  options: DirectPdfTransferOptions = {},
  xhrFactory: XMLHttpRequestFactory = () => new XMLHttpRequest(),
  now = new Date(),
): Promise<void> {
  const plan = parseDirectPdfTransferPlan(planValue, now);
  if (!plan) throw new TypeError("PaperPilot received an invalid direct PDF transfer plan.");
  if (file.size !== plan.expectedSizeBytes || file.type !== "application/pdf") {
    throw new TypeError("The selected PDF does not match its reserved transfer identity.");
  }

  return new Promise((resolve, reject) => {
    const xhr = xhrFactory();
    let settled = false;
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const abort = () => {
      xhr.abort();
      finish(() => reject(new DOMException("The upload was cancelled.", "AbortError")));
    };

    xhr.open("PUT", plan.url, true);
    xhr.withCredentials = false;
    xhr.responseType = "text";
    for (const [name, value] of Object.entries(plan.headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (!settled && options.onProgress) {
        options.onProgress({
          loadedBytes: event.loaded,
          totalBytes: event.lengthComputable ? event.total : file.size,
        });
      }
    };
    xhr.onload = () => {
      let response: unknown;
      try {
        response = JSON.parse(xhr.responseText);
      } catch {
        response = undefined;
      }
      const providerPrefix = "/storage/v1/object/upload/sign/";
      const providerKey = new URL(plan.url).pathname.slice(providerPrefix.length);
      if (
        xhr.status >= 200
        && xhr.status < 300
        && isRecord(response)
        && response.Key === providerKey
        && (!xhr.responseURL || xhr.responseURL === plan.url)
      ) {
        finish(resolve);
        return;
      }
      finish(() => reject(new Error("The private PDF provider rejected the direct transfer.")));
    };
    xhr.onerror = () => finish(() => reject(new Error(
      "PaperPilot could not confirm whether the direct PDF transfer completed.",
    )));
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => finish(() => reject(new DOMException(
      "The upload was cancelled.",
      "AbortError",
    )));

    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}
