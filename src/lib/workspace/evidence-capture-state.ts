import type {
  GroundedEvidenceConfidence,
  GroundedEvidenceNoteDraft,
  GroundedEvidenceSelection,
} from "./contracts";
import type { GroundedEvidenceSourceState, NoteStatus } from "../types";
import type { ReaderEvidenceSelectionPreview } from "./reader-evidence-selection";

export interface EvidenceCaptureSource {
  paperId: string;
  documentId: string;
  extractionId: string;
  manifestSha256: string;
}

export interface EvidenceCaptureDraft extends GroundedEvidenceNoteDraft {
  projectId: string;
  collectionId: string;
}

export type EvidenceCaptureIntent =
  | { action: "capture" }
  | {
      action: "reanchor";
      predecessorId: string;
      predecessorRevisionNumber: number;
      predecessorSourceState: GroundedEvidenceSourceState;
      predecessorStatus: NoteStatus;
    };

interface EvidenceCaptureSession {
  operationId: string;
  intent: EvidenceCaptureIntent;
  source: EvidenceCaptureSource;
  selection: ReaderEvidenceSelectionPreview;
  originElementId: string;
  draft: EvidenceCaptureDraft;
  error?: string;
}

export type EvidenceCaptureState =
  | { phase: "idle" }
  | ({ phase: "selected" | "saving" | "version-conflict" | "revision-conflict" | "source-changed" | "reselecting" } & EvidenceCaptureSession);

export type EvidenceCaptureAction =
  | {
      type: "selection-created";
      operationId: string;
      source: EvidenceCaptureSource;
      selection: ReaderEvidenceSelectionPreview;
      originElementId: string;
      projectId: string;
      collectionId?: string;
    }
  | {
      type: "reanchor-requested";
      operationId: string;
      predecessorId: string;
      predecessorRevisionNumber: number;
      predecessorSourceState: Exclude<GroundedEvidenceSourceState, "current">;
      predecessorStatus: NoteStatus;
      source: EvidenceCaptureSource;
      selection: ReaderEvidenceSelectionPreview;
      originElementId: string;
      draft: EvidenceCaptureDraft;
    }
  | { type: "field-changed"; field: keyof EvidenceCaptureDraft; value: string | string[] }
  | { type: "save-requested" }
  | { type: "save-failed"; message: string }
  | { type: "version-conflict"; message: string }
  | { type: "revision-conflict"; message: string }
  | { type: "source-conflict"; message?: string }
  | { type: "source-replaced"; extractionId: string }
  | { type: "reselection-requested" }
  | { type: "retry-ready" }
  | { type: "save-succeeded" }
  | { type: "dismissed" };

export function defaultEvidenceCaptureDraft(
  projectId: string,
  collectionId = "",
): EvidenceCaptureDraft {
  return {
    projectId,
    collectionId,
    kind: "direct-evidence",
    title: "",
    claim: "",
    interpretation: "",
    openQuestion: "",
    confidence: "unspecified" satisfies GroundedEvidenceConfidence,
    tags: [],
  };
}

export function evidenceCaptureReducer(
  state: EvidenceCaptureState,
  action: EvidenceCaptureAction,
): EvidenceCaptureState {
  switch (action.type) {
    case "selection-created":
      if (state.phase === "reselecting") {
        return {
          ...state,
          phase: "selected",
          source: action.source,
          selection: action.selection,
          // A re-anchor returns to Notes, so its original Notes control is the
          // only valid focus target after Reader unmounts. Ordinary source
          // reselection remains in Reader and may adopt the new selection
          // control as its return target.
          originElementId: state.intent.action === "reanchor"
            ? state.originElementId
            : action.originElementId,
          error: undefined,
        };
      }
      return {
        phase: "selected",
        operationId: action.operationId,
        intent: { action: "capture" },
        source: action.source,
        selection: action.selection,
        originElementId: action.originElementId,
        draft: defaultEvidenceCaptureDraft(action.projectId, action.collectionId),
      };
    case "reanchor-requested":
      return {
        phase: "reselecting",
        operationId: action.operationId,
        intent: {
          action: "reanchor",
          predecessorId: action.predecessorId,
          predecessorRevisionNumber: action.predecessorRevisionNumber,
          predecessorSourceState: action.predecessorSourceState,
          predecessorStatus: action.predecessorStatus,
        },
        source: action.source,
        selection: action.selection,
        originElementId: action.originElementId,
        draft: action.draft,
      };
    case "field-changed":
      if (state.phase === "idle" || state.phase === "saving") return state;
      return {
        ...state,
        draft: { ...state.draft, [action.field]: action.value },
        error: undefined,
      };
    case "save-requested":
      return state.phase === "selected" || state.phase === "version-conflict"
        ? { ...state, phase: "saving", error: undefined }
        : state;
    case "save-failed":
      return state.phase === "saving" || state.phase === "selected" || state.phase === "version-conflict"
        ? { ...state, phase: "selected", error: action.message }
        : state;
    case "version-conflict":
      return state.phase === "saving"
        ? { ...state, phase: "version-conflict", error: action.message }
        : state;
    case "revision-conflict":
      return state.phase === "saving"
        ? { ...state, phase: "revision-conflict", error: action.message }
        : state;
    case "source-conflict":
      return state.phase === "saving"
        ? {
            ...state,
            phase: "source-changed",
            error: action.message
              ?? "The authoritative source changed. Reload the Reader and select the passage again.",
          }
        : state;
    case "source-replaced":
      return state.phase !== "idle"
        && state.phase !== "reselecting"
        && state.source.extractionId !== action.extractionId
        ? {
            ...state,
            phase: "source-changed",
            error: "The authoritative source changed. Reload the Reader and select the passage again.",
          }
        : state;
    case "reselection-requested":
      return state.phase === "source-changed"
        ? { ...state, phase: "reselecting", error: undefined }
        : state;
    case "retry-ready":
      return state.phase === "version-conflict"
        ? { ...state, phase: "selected", error: undefined }
        : state;
    case "save-succeeded":
      return { phase: "idle" };
    case "dismissed":
      return state.phase === "saving" ? state : { phase: "idle" };
    default:
      return state;
  }
}

export function captureSelectionPayload(
  state: Exclude<EvidenceCaptureState, { phase: "idle" }>,
): GroundedEvidenceSelection {
  return {
    documentId: state.source.documentId,
    extractionId: state.source.extractionId,
    manifestSha256: state.source.manifestSha256,
    ...state.selection.anchor,
  };
}
