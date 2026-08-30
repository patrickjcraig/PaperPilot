import type { ReaderDocumentMetadata } from "./contracts";

const PDF_MEDIA_TYPE = "application/pdf";

export type ReaderPdfRequest = {
  document: Pick<ReaderDocumentMetadata, "id" | "inputSha256" | "inputSizeBytes">;
  paperId: string;
  signal?: AbortSignal;
  workspaceId: string;
};

export class ReaderPdfClientError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "authentication"
      | "changed"
      | "integrity"
      | "rate-limited"
      | "unavailable",
  ) {
    super(message);
    this.name = "ReaderPdfClientError";
  }
}

function endpointSegment(value: string): string {
  return encodeURIComponent(value);
}

export function readerPdfUrl(input: ReaderPdfRequest): string {
  const parameters = new URLSearchParams({
    documentId: input.document.id,
    inputSha256: input.document.inputSha256,
  });
  return `/api/workspaces/${endpointSegment(input.workspaceId)}/papers/${endpointSegment(input.paperId)}/reader/pdf?${parameters}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new ReaderPdfClientError(
      "This browser cannot verify the admitted PDF, so PaperPilot did not render it.",
      "integrity",
    );
  }
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function statusError(status: number): ReaderPdfClientError {
  if (status === 401) {
    return new ReaderPdfClientError(
      "Your session ended. Sign in again, then reopen this paper.",
      "authentication",
    );
  }
  if (status === 409 || status === 412) {
    return new ReaderPdfClientError(
      "The admitted source changed. Refresh the Reader before using this page.",
      "changed",
    );
  }
  if (status === 429) {
    return new ReaderPdfClientError(
      "The Reader is receiving too many requests. Wait briefly, then try this page again.",
      "rate-limited",
    );
  }
  return new ReaderPdfClientError(
    status === 404
      ? "The admitted PDF is no longer available. Return to the paper and check its status."
      : "PaperPilot could not load the admitted PDF page. Try again.",
    "unavailable",
  );
}

function responseIdentityIsValid(
  response: Response,
  document: ReaderPdfRequest["document"],
): boolean {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === PDF_MEDIA_TYPE
    && response.headers.get("x-paperpilot-document-id") === document.id
    && response.headers.get("x-paperpilot-document-sha256") === document.inputSha256
    && response.headers.get("etag") === `"${document.inputSha256}"`;
}

export async function fetchVerifiedReaderPdf(
  input: ReaderPdfRequest,
  fetchImpl: typeof fetch = (request, init) => globalThis.fetch(request, init),
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(readerPdfUrl(input), {
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: PDF_MEDIA_TYPE,
        "If-Match": `"${input.document.inputSha256}"`,
      },
      signal: input.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ReaderPdfClientError(
      "PaperPilot could not reach the admitted PDF. Check the connection and try again.",
      "unavailable",
    );
  }

  if (!response.ok) throw statusError(response.status);
  if (!responseIdentityIsValid(response, input.document)) {
    throw new ReaderPdfClientError(
      "The PDF response did not match the admitted source, so PaperPilot did not render it.",
      "integrity",
    );
  }

  const buffer = await response.arrayBuffer();
  const expectedSize = Number(input.document.inputSizeBytes);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || buffer.byteLength !== expectedSize) {
    throw new ReaderPdfClientError(
      "The PDF byte count did not match the admitted source, so PaperPilot did not render it.",
      "integrity",
    );
  }

  const bytes = new Uint8Array(buffer);
  if (await sha256Hex(bytes) !== input.document.inputSha256) {
    throw new ReaderPdfClientError(
      "The PDF digest did not match the admitted source, so PaperPilot did not render it.",
      "integrity",
    );
  }
  return bytes;
}
