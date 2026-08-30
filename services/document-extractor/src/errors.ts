export type SafeErrorCode =
  | "not_found"
  | "method_not_allowed"
  | "unauthorized"
  | "invalid_headers"
  | "unsupported_media_type"
  | "body_too_large"
  | "body_timeout"
  | "body_incomplete"
  | "content_mismatch"
  | "policy_mismatch"
  | "extractor_busy"
  | "extraction_input_unsupported"
  | "extraction_resource_limit"
  | "extraction_unavailable"
  | "not_ready"
  | "internal_error";

const SAFE_ERROR_DETAILS: Readonly<Record<SafeErrorCode, {
  status: number;
  message: string;
}>> = Object.freeze({
  not_found: { status: 404, message: "The requested extractor route does not exist." },
  method_not_allowed: { status: 405, message: "The request method is not allowed." },
  unauthorized: { status: 401, message: "The extraction request was not authorized." },
  invalid_headers: { status: 400, message: "The extraction request headers were invalid." },
  unsupported_media_type: { status: 415, message: "The extraction request media type was not supported." },
  body_too_large: { status: 413, message: "The extraction request body was too large." },
  body_timeout: { status: 408, message: "The extraction request body was not received in time." },
  body_incomplete: { status: 400, message: "The extraction request body was incomplete." },
  content_mismatch: { status: 422, message: "The extraction request content did not match its binding." },
  policy_mismatch: { status: 409, message: "The requested extraction policy is not available." },
  extractor_busy: { status: 503, message: "The document extractor is temporarily busy." },
  extraction_input_unsupported: {
    status: 422,
    message: "The document input is not supported for text extraction.",
  },
  extraction_resource_limit: {
    status: 422,
    message: "The document exceeded a supported extraction resource limit.",
  },
  extraction_unavailable: { status: 503, message: "Document extraction is temporarily unavailable." },
  not_ready: { status: 503, message: "The document extractor is not ready." },
  internal_error: { status: 500, message: "The document extractor could not complete the request." },
});

export class SafeHttpError extends Error {
  readonly code: SafeErrorCode;
  readonly status: number;

  constructor(code: SafeErrorCode) {
    super(SAFE_ERROR_DETAILS[code].message);
    this.name = "SafeHttpError";
    this.code = code;
    this.status = SAFE_ERROR_DETAILS[code].status;
  }
}

export class RunnerFailure extends Error {
  readonly kind:
    | "aborted"
    | "timeout"
    | "input_unsupported"
    | "output_limit"
    | "spawn"
    | "protocol"
    | "tool";

  constructor(kind: RunnerFailure["kind"]) {
    super("The configured extraction runner failed.");
    this.name = "RunnerFailure";
    this.kind = kind;
  }
}

export function safeErrorBody(error: SafeHttpError): string {
  return JSON.stringify({ error: { code: error.code, message: error.message } });
}
