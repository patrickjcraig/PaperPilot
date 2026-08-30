import type { EvidenceNote } from "../types";
import type { EvidenceCaptureDraft } from "./evidence-capture-state";
import type { ReaderEvidenceSelectionPreview } from "./reader-evidence-selection";

export interface EvidenceRevisionActions {
  canReview: boolean;
  canReanchor: boolean;
}

export interface EvidenceReviewSessionProjection {
  conflicted: boolean;
  dialogNote?: EvidenceNote;
}

/**
 * A project read model carries immutable history, while its project/collection
 * indexes point at chain heads. Keep this defensive filter at the view boundary
 * so a predecessor can never appear as a second default evidence card.
 */
export function latestEvidenceNoteHeads(notes: readonly EvidenceNote[]): EvidenceNote[] {
  return notes.filter((note) => note.revision.isLatest);
}

export function evidenceNotesForHeads(
  notes: readonly EvidenceNote[],
  headIds: readonly string[],
): EvidenceNote[] {
  const headIdSet = new Set(headIds);
  const rootIds = new Set(
    notes
      .filter((note) => headIdSet.has(note.id))
      .map((note) => note.revision.rootId),
  );
  return notes.filter((note) => rootIds.has(note.revision.rootId));
}

export function evidenceRevisionHistory(
  head: EvidenceNote,
  notes: readonly EvidenceNote[],
): EvidenceNote[] {
  const history = notes
    .filter((note) => note.revision.rootId === head.revision.rootId)
    .sort((left, right) => right.revision.number - left.revision.number);
  return history.some((note) => note.id === head.id)
    ? history
    : [head, ...history];
}

export function evidenceRevisionActions(note: EvidenceNote): EvidenceRevisionActions {
  const groundedHead = Boolean(note.grounding) && note.revision.isLatest;
  return {
    canReview: groundedHead && note.status === "captured",
    canReanchor: groundedHead && note.grounding?.state !== "current",
  };
}

/**
 * Starting a review remains head-only through evidenceRevisionActions. Once a
 * request has been submitted, however, the same immutable predecessor and
 * operation ID must be allowed to reach the server again so a durable receipt
 * can be replayed after the local chain advances.
 */
export function canSubmitEvidenceReviewAttempt(
  note: EvidenceNote | undefined,
): note is EvidenceNote {
  return Boolean(note?.grounding) && note?.status === "captured";
}

/**
 * An unsubmitted dialog follows the live head and closes if that head moves.
 * A submitted dialog keeps its frozen predecessor available after an uncertain
 * response so retry can recover the original idempotent operation.
 */
export function evidenceReviewSessionProjection(
  frozenNote: EvidenceNote,
  currentNote: EvidenceNote | undefined,
  options: { saving: boolean; submitted: boolean },
): EvidenceReviewSessionProjection {
  const currentHead = currentNote?.revision.isLatest === true;
  const preserveAttempt = options.saving || options.submitted;
  return {
    conflicted: !options.saving && !options.submitted && !currentHead,
    dialogNote: currentHead
      ? currentNote
      : preserveAttempt
        ? currentNote ?? frozenNote
        : undefined,
  };
}

export function evidenceRevisionDraft(
  note: EvidenceNote,
  projectId: string,
  visibleCollectionIds: ReadonlySet<string>,
): EvidenceCaptureDraft {
  return {
    projectId,
    collectionId: note.collectionIds.find((id) => visibleCollectionIds.has(id)) ?? "",
    kind: note.kind,
    title: note.title,
    claim: note.claim,
    interpretation: note.interpretation,
    openQuestion: note.openQuestion ?? "",
    confidence: note.confidence,
    tags: [...note.tags],
  };
}

/**
 * The stale preview is shown only while the Reader asks for a replacement. It
 * is never submitted; selection-created replaces every authority field with a
 * span reconstructed from the current admitted manifest.
 */
export function staleEvidenceSelectionPreview(
  note: EvidenceNote,
): ReaderEvidenceSelectionPreview | undefined {
  const grounding = note.grounding;
  if (!grounding) return undefined;
  return {
    anchor: {
      start: { ...grounding.start },
      end: { ...grounding.end },
      expectedQuoteSha256: grounding.quoteSha256,
    },
    quoteText: note.evidence,
    pageStart: grounding.pageStart,
    pageEnd: grounding.pageEnd,
    paragraphStartId: grounding.paragraphStartId,
    paragraphEndId: grounding.paragraphEndId,
    selectedChunkIds: grounding.start.chunkId === grounding.end.chunkId
      ? [grounding.start.chunkId]
      : [grounding.start.chunkId, grounding.end.chunkId],
    selectedByteLength: new TextEncoder().encode(note.evidence).byteLength,
  };
}
