import "server-only";

import { HttpProblem } from "./problem";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_MAX_JSON_BYTES = 128 * 1024;

function configuredApplicationOrigins(): Set<string> {
  const origins = new Set<string>();
  const configured = process.env.BETTER_AUTH_URL?.trim();
  if (configured) {
    try {
      origins.add(new URL(configured).origin);
    } catch {
      throw new Error("BETTER_AUTH_URL must be an absolute URL.");
    }
  }
  if (process.env.NODE_ENV !== "production") {
    origins.add("http://127.0.0.1:3000");
    origins.add("http://localhost:3000");
  }
  return origins;
}

/**
 * Require browser mutations to originate from the configured PaperPilot app.
 *
 * Authentication cookies are intentionally not enough: sibling origins can be
 * same-site and still issue credentialed requests. Modern browsers send both
 * Origin and Fetch Metadata on POST, so fail closed when either contradicts
 * the app origin. This boundary is for PaperPilot's browser-facing JSON APIs;
 * future token-authenticated public APIs should use a separate handler.
 */
export function requireTrustedMutationRequest(request: Request): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpProblem(403, "untrusted_origin", "The request did not originate from PaperPilot.");
  }

  const rawOrigin = request.headers.get("origin")?.trim();
  if (!rawOrigin) {
    throw new HttpProblem(403, "origin_required", "A trusted request origin is required.");
  }

  let origin: string;
  try {
    origin = new URL(rawOrigin).origin;
  } catch {
    throw new HttpProblem(403, "untrusted_origin", "The request origin is invalid.");
  }
  if (!configuredApplicationOrigins().has(origin)) {
    throw new HttpProblem(403, "untrusted_origin", "The request did not originate from PaperPilot.");
  }
}

async function readBodyBytesWithinLimit(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length")?.trim();
  if (contentLength) {
    if (!/^\d+$/.test(contentLength)) {
      throw new HttpProblem(400, "invalid_content_length", "Content-Length must be a byte count.");
    }
    if (Number(contentLength) > maximumBytes) {
      throw new HttpProblem(413, "request_too_large", "The request body is too large.");
    }
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel("PaperPilot JSON body limit exceeded");
      throw new HttpProblem(413, "request_too_large", "The request body is too large.");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Rebuild a request only after its complete body has passed the streaming cap. */
export async function requestWithinBodyLimit(
  request: Request,
  maximumBytes: number,
): Promise<Request> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("maximumBytes must be a positive safe integer.");
  }
  if (SAFE_METHODS.has(request.method.toUpperCase()) || !request.body) return request;

  const body = await readBodyBytesWithinLimit(request, maximumBytes);
  const headers = new Headers(request.headers);
  headers.set("Content-Length", String(body.byteLength));
  return new Request(request.url, {
    method: request.method,
    headers,
    body: body.buffer as ArrayBuffer,
    redirect: request.redirect,
    signal: request.signal,
  });
}

export async function readJsonObject(
  request: Request,
  maximumBytes = DEFAULT_MAX_JSON_BYTES,
): Promise<Record<string, unknown>> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpProblem(
      415,
      "unsupported_media_type",
      "PaperPilot write APIs accept application/json requests.",
    );
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("maximumBytes must be a positive safe integer.");
  }

  const bodyBytes = await readBodyBytesWithinLimit(request, maximumBytes);
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  } catch {
    throw new HttpProblem(400, "invalid_encoding", "The JSON request body must use UTF-8.");
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new HttpProblem(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpProblem(400, "validation", "A JSON object is required.");
  }
  return value as Record<string, unknown>;
}
