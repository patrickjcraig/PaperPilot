import type { WorkspacePaperReaderDto } from "./contracts";

export type ReadyWorkspacePaperReader = Extract<
  WorkspacePaperReaderDto,
  { state: "ready" }
>;

export const DEFAULT_READER_POLL_DELAY_MS = 5_000;
export const MAX_READER_POLL_DELAY_MS = 120_000;

/** Honor a server retry floor without allowing an unbounded dormant poll. */
export function readerPollingDelayMs(retryAfterSeconds?: number): number {
  if (
    retryAfterSeconds === undefined
    || !Number.isSafeInteger(retryAfterSeconds)
    || retryAfterSeconds < 1
  ) return DEFAULT_READER_POLL_DELAY_MS;
  return Math.min(
    MAX_READER_POLL_DELAY_MS,
    Math.max(DEFAULT_READER_POLL_DELAY_MS, retryAfterSeconds * 1_000),
  );
}

export function readerNeedsRefresh(reader: WorkspacePaperReaderDto): boolean {
  return reader.state === "processing";
}

function sameDocument(
  left: ReadyWorkspacePaperReader["document"],
  right: ReadyWorkspacePaperReader["document"],
): boolean {
  return left.id === right.id
    && left.workspacePaperId === right.workspacePaperId
    && left.paperId === right.paperId
    && left.assetId === right.assetId
    && left.inputSha256 === right.inputSha256
    && left.inputSizeBytes === right.inputSizeBytes
    && left.pageCount === right.pageCount
    && left.validationAttestationId === right.validationAttestationId
    && left.validationPolicyVersion === right.validationPolicyVersion
    && left.validatedAt === right.validatedAt;
}

function sameGeneration(
  left: ReadyWorkspacePaperReader["generation"],
  right: ReadyWorkspacePaperReader["generation"],
): boolean {
  return left.id === right.id
    && left.validationAttestationId === right.validationAttestationId
    && left.policyVersion === right.policyVersion
    && left.toolchainDigest === right.toolchainDigest
    && left.engine === right.engine
    && left.engineVersion === right.engineVersion
    && left.verdict === right.verdict
    && left.pageCount === right.pageCount
    && left.chunkCount === right.chunkCount
    && left.textBytes === right.textBytes
    && left.extractedAt === right.extractedAt
    && left.completedAt === right.completedAt
    && left.checkedAt === right.checkedAt;
}

function loadedContinuationSequence(
  reader: ReadyWorkspacePaperReader,
): number | null {
  if (reader.chunks.length === 0) return null;
  for (let index = 0; index < reader.chunks.length; index += 1) {
    if (reader.chunks[index]?.sequence !== index) return null;
  }
  const lastSequence = reader.chunks.at(-1)!.sequence;
  return lastSequence < reader.generation.chunkCount - 1
    ? lastSequence + 1
    : null;
}

function pageContinuesAt(
  reader: ReadyWorkspacePaperReader,
  expectedSequence: number,
): boolean {
  if (reader.chunks.length === 0) return false;
  for (let index = 0; index < reader.chunks.length; index += 1) {
    if (reader.chunks[index]?.sequence !== expectedSequence + index) return false;
  }
  const lastSequence = reader.chunks.at(-1)!.sequence;
  return lastSequence < reader.generation.chunkCount
    && (reader.nextCursor === null
      ? lastSequence === reader.generation.chunkCount - 1
      : lastSequence < reader.generation.chunkCount - 1);
}

/**
 * Append one authoritative page without accepting a document/generation swap
 * or a discontinuous loaded sequence. The cursor remains opaque; continuity is
 * derived from the chunks already accepted by the browser. A caller should
 * restart from page one on failure.
 */
export function appendReaderPage(
  current: ReadyWorkspacePaperReader,
  next: WorkspacePaperReaderDto,
): ReadyWorkspacePaperReader {
  const expectedSequence = loadedContinuationSequence(current);
  if (
    next.state !== "ready"
    || current.nextCursor === null
    || expectedSequence === null
    || !sameDocument(current.document, next.document)
    || !sameGeneration(current.generation, next.generation)
    || !pageContinuesAt(next, expectedSequence)
  ) {
    throw new Error("The Reader source changed while loading the next page. Refresh the paper before continuing.");
  }

  return {
    ...next,
    chunks: [...current.chunks, ...next.chunks],
  };
}
