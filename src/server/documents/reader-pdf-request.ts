import { HttpProblem } from "@/server/http/problem";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface ReaderPdfRequestIdentity {
  documentId: string;
  inputSha256: string;
}

function validOpaqueId(value: string): boolean {
  return OPAQUE_ID_PATTERN.test(value) && new TextEncoder().encode(value).byteLength <= 200;
}

function invalidRequest(): HttpProblem {
  return new HttpProblem(400, "validation", "Reader PDF query parameters are invalid.");
}

export function readerPdfGenerationChanged(status: 409 | 412): HttpProblem {
  return new HttpProblem(
    status,
    "document_generation_changed",
    "The admitted Reader source changed. Refresh the paper.",
  );
}

export function parseReaderPdfRequest(
  searchParams: URLSearchParams,
  ifMatch: string | null,
): ReaderPdfRequestIdentity {
  if (
    [...searchParams.keys()].some((key) => key !== "documentId" && key !== "inputSha256")
    || searchParams.getAll("documentId").length !== 1
    || searchParams.getAll("inputSha256").length !== 1
  ) throw invalidRequest();

  const documentId = searchParams.get("documentId") ?? "";
  const inputSha256 = searchParams.get("inputSha256") ?? "";
  if (
    !validOpaqueId(documentId)
    || !SHA256_PATTERN.test(inputSha256)
    || /^0{64}$/.test(inputSha256)
  ) throw invalidRequest();
  if (ifMatch?.trim() !== `"${inputSha256}"`) throw readerPdfGenerationChanged(412);
  return { documentId, inputSha256 };
}
