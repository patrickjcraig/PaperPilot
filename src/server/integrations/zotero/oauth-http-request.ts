import "server-only";

import { HttpProblem } from "@/server/http/problem";

/** Disconnect is a resource mutation with no representation body. */
export function requireEmptyZoteroMutationBody(request: Request): void {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
      throw new HttpProblem(
        400,
        "invalid_content_length",
        "Content-Length must be a byte count.",
      );
    }
    if (normalized !== "0") {
      throw new HttpProblem(
        400,
        "validation",
        "The Zotero disconnect request body must be empty.",
      );
    }
  }
  // Reject chunked/streamed bodies without waiting for an attacker-controlled
  // stream. Ordinary bodyless DELETE requests expose a null body.
  if (request.body !== null) {
    throw new HttpProblem(
      400,
      "validation",
      "The Zotero disconnect request body must be empty.",
    );
  }
}
