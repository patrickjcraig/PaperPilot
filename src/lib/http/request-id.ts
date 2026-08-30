const SAFE_REQUEST_ID = /^[a-zA-Z0-9._:-]{1,200}$/;

/**
 * Keep externally supplied correlation IDs safe for response headers, logs,
 * and provenance identifiers. Invalid values are intentionally replaced with
 * the server-generated fallback instead of being reflected back to callers.
 */
export function safeRequestId(value: unknown, fallback: string): string {
  if (!SAFE_REQUEST_ID.test(fallback)) {
    throw new Error("The request ID fallback must be a safe header value.");
  }

  if (typeof value !== "string") return fallback;
  const candidate = value.trim();
  return SAFE_REQUEST_ID.test(candidate) ? candidate : fallback;
}

