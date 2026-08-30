import type { GroundedEvidenceSelection } from "./contracts";

export const MAX_GROUNDED_SELECTION_CHUNKS = 24;
export const MAX_GROUNDED_SELECTION_BYTES = 50_000;

const SHA256 = /^[0-9a-f]{64}$/;

export interface ReaderSelectionChunk {
  id: string;
  sequence: number;
  pageNumber: number;
  paragraphId: string;
  text: string;
  contentHash: string;
}

export interface ReaderSelectionBoundary {
  chunkId: string;
  /** Browser-native UTF-16 code-unit offset within the exact chunk text. */
  utf16Offset: number;
}

export interface ReaderEvidenceSelectionPreview {
  anchor: Pick<GroundedEvidenceSelection, "start" | "end" | "expectedQuoteSha256">;
  quoteText: string;
  pageStart: number;
  pageEnd: number;
  paragraphStartId: string;
  paragraphEndId: string;
  selectedChunkIds: string[];
  selectedByteLength: number;
}

export type ReaderSelectionFailureCode =
  | "boundary_missing"
  | "boundary_invalid"
  | "chunk_order_invalid"
  | "selection_empty"
  | "selection_too_large"
  | "source_identity_invalid";

export type ReaderSelectionResult =
  | { ok: true; selection: ReaderEvidenceSelectionPreview }
  | { ok: false; code: ReaderSelectionFailureCode };

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isUtf16Boundary(value: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length) return false;
  if (offset === 0 || offset === value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const next = value.charCodeAt(offset);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    return false;
  }
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  for (const segment of segmenter.segment(value)) {
    if (segment.index === offset) return true;
  }
  return false;
}

function sourceIdentityIsSound(chunk: ReaderSelectionChunk): boolean {
  return Boolean(chunk.id)
    && Number.isSafeInteger(chunk.sequence)
    && chunk.sequence >= 0
    && Number.isSafeInteger(chunk.pageNumber)
    && chunk.pageNumber >= 1
    && Boolean(chunk.paragraphId)
    && SHA256.test(chunk.contentHash);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Translate browser selection boundaries into canonical UTF-8 byte anchors.
 *
 * The preview is never authoritative: the server replays the exact admitted
 * chunk range and reconstructs the quote before creating grounded evidence.
 */
export async function selectionToGroundedAnchor(
  chunks: readonly ReaderSelectionChunk[],
  anchor: ReaderSelectionBoundary,
  focus: ReaderSelectionBoundary,
): Promise<ReaderSelectionResult> {
  const anchorIndex = chunks.findIndex((chunk) => chunk.id === anchor.chunkId);
  const focusIndex = chunks.findIndex((chunk) => chunk.id === focus.chunkId);
  if (anchorIndex < 0 || focusIndex < 0) return { ok: false, code: "boundary_missing" };

  const anchorChunk = chunks[anchorIndex]!;
  const focusChunk = chunks[focusIndex]!;
  if (
    !isUtf16Boundary(anchorChunk.text, anchor.utf16Offset)
    || !isUtf16Boundary(focusChunk.text, focus.utf16Offset)
  ) return { ok: false, code: "boundary_invalid" };

  let firstIndex = anchorIndex;
  let lastIndex = focusIndex;
  let firstOffset = anchor.utf16Offset;
  let lastOffset = focus.utf16Offset;
  if (
    anchorIndex > focusIndex
    || (anchorIndex === focusIndex && anchor.utf16Offset > focus.utf16Offset)
  ) {
    firstIndex = focusIndex;
    lastIndex = anchorIndex;
    firstOffset = focus.utf16Offset;
    lastOffset = anchor.utf16Offset;
  }

  const selectedChunks = chunks.slice(firstIndex, lastIndex + 1);
  if (
    selectedChunks.length < 1
    || selectedChunks.length > MAX_GROUNDED_SELECTION_CHUNKS
  ) return { ok: false, code: "selection_too_large" };
  if (selectedChunks.some((chunk) => !sourceIdentityIsSound(chunk))) {
    return { ok: false, code: "source_identity_invalid" };
  }
  for (let index = 1; index < selectedChunks.length; index += 1) {
    if (selectedChunks[index]!.sequence !== selectedChunks[index - 1]!.sequence + 1) {
      return { ok: false, code: "chunk_order_invalid" };
    }
  }

  const excerpts = selectedChunks.map((chunk, index) => {
    const start = index === 0 ? firstOffset : 0;
    const end = index === selectedChunks.length - 1 ? lastOffset : chunk.text.length;
    return { chunk, start, end, text: chunk.text.slice(start, end) };
  }).filter(({ text }) => text.length > 0);
  if (!excerpts.length) return { ok: false, code: "selection_empty" };

  const quoteText = excerpts.map(({ text }) => text).join("\n\n");
  const selectedByteLength = utf8ByteLength(quoteText);
  if (!quoteText.trim()) return { ok: false, code: "selection_empty" };
  if (selectedByteLength > MAX_GROUNDED_SELECTION_BYTES) {
    return { ok: false, code: "selection_too_large" };
  }

  const first = excerpts[0]!;
  const last = excerpts.at(-1)!;
  return {
    ok: true,
    selection: {
      anchor: {
        start: {
          chunkId: first.chunk.id,
          sequence: first.chunk.sequence,
          byteOffset: utf8ByteLength(first.chunk.text.slice(0, first.start)),
          contentHash: first.chunk.contentHash,
        },
        end: {
          chunkId: last.chunk.id,
          sequence: last.chunk.sequence,
          byteOffset: utf8ByteLength(last.chunk.text.slice(0, last.end)),
          contentHash: last.chunk.contentHash,
        },
        expectedQuoteSha256: await sha256Hex(quoteText),
      },
      quoteText,
      pageStart: first.chunk.pageNumber,
      pageEnd: last.chunk.pageNumber,
      paragraphStartId: first.chunk.paragraphId,
      paragraphEndId: last.chunk.paragraphId,
      selectedChunkIds: excerpts.map(({ chunk }) => chunk.id),
      selectedByteLength,
    },
  };
}
