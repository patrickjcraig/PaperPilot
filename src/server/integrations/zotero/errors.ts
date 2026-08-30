import type { ZoteroResponseMeta } from "./contracts";

export type ZoteroAdapterErrorCode =
  | "zotero_invalid_request"
  | "zotero_credential_unavailable"
  | "zotero_authentication_failed"
  | "zotero_forbidden"
  | "zotero_not_found"
  | "zotero_rate_limited"
  | "zotero_timeout"
  | "zotero_unavailable"
  | "zotero_response_too_large"
  | "zotero_bad_response";

export interface ZoteroAdapterErrorOptions {
  code: ZoteroAdapterErrorCode;
  status: number;
  retryable: boolean;
  providerStatus?: number;
  backoffSeconds?: number;
  retryAfterSeconds?: number;
  retryAt?: string;
  cause?: unknown;
}

/** A normalized failure that is safe for a route handler to inspect. */
export class ZoteroAdapterError extends Error {
  readonly code: ZoteroAdapterErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly providerStatus?: number;
  readonly backoffSeconds?: number;
  readonly retryAfterSeconds?: number;
  readonly retryAt?: string;

  constructor(message: string, options: ZoteroAdapterErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "ZoteroAdapterError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    this.providerStatus = options.providerStatus;
    this.backoffSeconds = options.backoffSeconds;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.retryAt = options.retryAt;
  }
}

export function invalidZoteroRequest(message: string): ZoteroAdapterError {
  return new ZoteroAdapterError(message, {
    code: "zotero_invalid_request",
    status: 400,
    retryable: false,
  });
}

export function invalidZoteroResponse(
  message: string,
  providerStatus?: number,
  metadata?: Partial<ZoteroResponseMeta>,
): ZoteroAdapterError {
  return new ZoteroAdapterError(message, {
    code: "zotero_bad_response",
    status: 502,
    retryable: true,
    providerStatus,
    backoffSeconds: metadata?.backoffSeconds,
    retryAfterSeconds: metadata?.retryAfterSeconds,
    retryAt: metadata?.retryAt,
  });
}
