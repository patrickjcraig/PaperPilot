"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  LiteratureSearchHit,
  LiteratureSearchRequest,
  LiteratureSearchResponse,
  ProviderDescriptor,
  ZoteroAttachmentEligibility,
  ZoteroAttachmentImportUiResponse,
  ZoteroAttachmentListUiResponse,
  ZoteroAttachmentPolicyMode,
  ZoteroAttachmentPolicyUiSummary,
  ZoteroAttachmentPolicyUpdateUiResponse,
  ZoteroAttachmentUiSummary,
  ZoteroScopeProfile,
} from "@/lib/integrations";
import {
  isWorkspaceIntegrationManager,
  parseZoteroAttachmentImportResponse,
  parseZoteroAttachmentListResponse,
  parseZoteroAttachmentPolicyResponse,
  parseZoteroAttachmentPolicyUpdateResponse,
  parseZoteroConnectionsResponse,
  parseZoteroDisconnectResponse,
  parseZoteroLibraryDiscoveryResponse,
  parseZoteroLibrarySelectionResponse,
  parseZoteroOAuthStartResponse,
  parseZoteroSyncRunsResponse,
  safeApiProblemMessage,
  zoteroAttachmentImportsRoute,
  zoteroAttachmentPolicyRoute,
  zoteroAttachmentsRoute,
  zoteroCallbackConsumption,
  zoteroConnectionsRoute,
  zoteroDisconnectRoute,
  zoteroLibraryDiscoveryRoute,
  zoteroLibrarySelectionRoute,
  zoteroOAuthStartRoute,
  zoteroSyncRunsRoute,
} from "@/lib/integrations";
import { getSectionsForPaper, researchGoal } from "@/lib/data";
import {
  clearCrawlerRecovery,
  crawlerDefinitiveProblemCode,
  persistCrawlerRecovery,
  restoreCrawlerRecovery,
  type FrozenCrawlerRecoverySubmission,
} from "@/lib/integrations/crawler-recovery";
import {
  clearCrawlerCustodyDeletionRecovery,
  createCrawlerCustodyDeletionSubmission,
  crawlerCustodyDeletionRoute,
  parseCrawlerCustodyDeletionResponse,
  persistCrawlerCustodyDeletionRecovery,
  restoreCrawlerCustodyDeletionRecovery,
  type FrozenCrawlerCustodyDeletionSubmission,
} from "@/lib/integrations/crawler-custody-ui";
import type {
  DocumentUploadInboxEntry,
  DocumentUploadStage,
  EvidenceNote,
  SourceLocator,
} from "@/lib/types";
import {
  isCrawlerDocumentInboxEntry,
  isDocumentUploadInboxEntry,
  isWebMcpInboxEntry,
} from "@/lib/types";
import type { ProjectDraft } from "./project-create-dialog";
import type { AppView } from "./app-shell";
import type {
  WorkspaceBootstrapDto,
  EvidenceCaptureState,
  FrozenWebMcpApprovalSubmission,
  ReceivedWorkspaceInvitationsDto,
  ReaderEvidenceSelectionPreview,
  WebMcpApprovalEvidenceDossier,
  WorkspacePaperReaderDto,
  WorkspaceCollaboratorsDto,
  WorkspaceDirectoryDto,
  WorkspaceProjectDto,
  WorkspaceUiState,
} from "@/lib/workspace";
import {
  appendReaderPage,
  applyCreatedCollection,
  applyCreatedEvidenceNote,
  applyEvidenceNoteRevision,
  applyNoteCollectionLink,
  applyPaperCollectionLink,
  DEFAULT_READER_POLL_DELAY_MS,
  captureSelectionPayload,
  canSubmitEvidenceReviewAttempt,
  evidenceCaptureReducer,
  evidenceRevisionDraft,
  evidenceRevisionNeedsRefresh,
  evidenceNotesForHeads,
  freezeWebMcpApprovalSubmission,
  CollaborationHttpError,
  HttpCollaborationClient,
  latestEvidenceNoteHeads,
  HttpWorkspaceClient,
  readerPollingDelayMs,
  staleEvidenceSelectionPreview,
  WorkspaceHttpError,
} from "@/lib/workspace";
import { authClient } from "@/lib/auth-client";
import { sha256Hex as sha256PdfBytes } from "@/lib/workspace/reader-pdf";
import {
  isWorkspaceRole,
  type InvitableWorkspaceRole,
} from "@/lib/workspace-roles";
import { findPaperDuplicate } from "@/lib/workspace-store";
import {
  getRefreshableDocumentUploadIds,
  getLatestPaperExtractionStages,
  isDocumentUploadRefreshPending,
  mergeRefreshedDocumentUploads,
} from "@/lib/workspace/upload-refresh";
import { AppShell } from "./app-shell";
import { CollaboratorsView } from "./collaborators-view";
import type { CollectionDraft } from "./collection-create-dialog";
import { CollectionsView } from "./collections-view";
import { DiscoverView } from "./discover-view";
import {
  InboxView,
  type WebMcpApprovalSelection,
  type WebMcpApprovalReview,
} from "./inbox-view";
import { NotesView, type NoteDraft } from "./notes-view";
import { PaperImportDialog } from "./paper-import-dialog";
import { ProjectCreateDialog } from "./project-create-dialog";
import { ProjectView } from "./project-view";
import { LiveReaderView } from "./live-reader-view";
import {
  SourcesView,
  type CrawlerPendingRetrySummary,
  type CrawlerPolicySummary,
  type CrawlerQueueInput,
  type CrawlerRequestStatus,
  type CrawlerRequestSummary,
  type CrawlerSafeFailureCode,
  type CrawlerSourceState,
  type ZoteroSourceState,
} from "./sources-view";
import { ToastRegion, type ToastMessage } from "./toast";
import { WorkspaceView } from "./workspace-view";
import type { WorkspaceActionResult } from "./workspace-action";
import type {
  UploadFileController,
  UploadFilePhase,
} from "./file-upload-card";

const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1_024 * 1_024;
const UPLOAD_STATUS_REFRESH_INTERVAL_MS = 5_000;
const CRAWLER_STATUS_REFRESH_INTERVAL_MS = 4_000;
const CRAWLER_POST_DEADLINE_MS = 15_000;
const MUTATING_WORKSPACE_ROLES = new Set(["owner", "admin", "member"]);
const ACTIVE_CRAWLER_REQUEST_STATUSES = new Set<CrawlerRequestStatus>([
  "QUEUED",
  "FETCHING",
  "QUARANTINED",
  "VALIDATING",
  "EXTRACTING",
  "DELETING",
]);
const CRAWLER_REQUEST_STATUSES = new Set<CrawlerRequestStatus>([
  ...ACTIVE_CRAWLER_REQUEST_STATUSES,
  "READY",
  "ATTENTION",
  "FAILED",
  "CANCELLED",
  "DELETED",
]);
const CRAWLER_FAILURE_CODES = new Set<CrawlerSafeFailureCode>([
  "crawler_request_invalid",
  "crawler_url_invalid",
  "crawler_policy_denied",
  "crawler_dns_rejected",
  "crawler_robots_denied",
  "crawler_redirect_rejected",
  "crawler_bad_response",
  "crawler_response_too_large",
  "crawler_timeout",
  "crawler_cancelled",
  "crawler_unavailable",
  "content_length_mismatch",
  "invalid_pdf_envelope",
  "pdf_trailing_data",
  "upload_too_large",
  "upload_timed_out",
  "storage_unavailable",
  "storage_finalize_failed",
  "malware_detected",
  "pdf_invalid",
  "pdf_policy_violation",
  "pdf_resource_limit_exceeded",
  "malware_and_pdf_invalid",
  "extraction_unavailable",
  "extraction_failed",
  "crawler_custody_deletion_retrying",
  "cancelled",
  "internal_error",
]);

type StoredUploadStage = Extract<
  DocumentUploadStage,
  "quarantined" | "validating" | "ready"
>;

function isStoredUploadStage(stage: DocumentUploadStage): stage is StoredUploadStage {
  return stage === "quarantined" || stage === "validating" || stage === "ready";
}

function storedUploadFeedback(stage: StoredUploadStage): {
  message: string;
  toastTitle: string;
  toastDescription: string;
} {
  switch (stage) {
    case "quarantined":
      return {
        message: "Transfer complete. The PDF is privately quarantined and awaiting validation.",
        toastTitle: "PDF quarantined",
        toastDescription: "The upload is visible in Research Inbox. Verification, project filing, and Reader access remain locked.",
      };
    case "validating":
      return {
        message: "Transfer complete. Malware screening and PDF validation are in progress.",
        toastTitle: "PDF validating",
        toastDescription: "The upload is visible in Research Inbox while verification runs. Project filing and Reader access remain locked.",
      };
    case "ready":
      return {
        message: "Transfer and validation complete. The verified private document is ready.",
        toastTitle: "PDF verified",
        toastDescription: "The document is ready in Research Inbox. Reader access still requires a separately linked paper source.",
      };
  }
}

function upsertInboxEntry(
  entries: WorkspaceBootstrapDto["inboxEntries"],
  entry: WorkspaceBootstrapDto["inboxEntries"][number],
): WorkspaceBootstrapDto["inboxEntries"] {
  return [entry, ...entries.filter((candidate) => candidate.id !== entry.id)];
}

function webMcpApprovalSelectionKey(selection: WebMcpApprovalSelection): string {
  return [
    selection.inboxEntryId,
    selection.proposalDigest,
    selection.destinationProjectId,
    selection.duplicateDecision.kind,
    selection.duplicateDecision.kind === "use_existing"
      ? selection.duplicateDecision.canonicalPaperId
      : "",
  ].join("\u0000");
}

function uploadFailureMessage(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return "The transfer was cancelled. PaperPilot is checking the durable upload state.";
  }
  if (cause instanceof WorkspaceHttpError) {
    const known: Record<string, string> = {
      invalid_filename: "Rename the file and try again.",
      unsupported_media_type: "Choose the original PDF file.",
      invalid_pdf_envelope: "This file was not recognized as a supported PDF.",
      pdf_trailing_data: "This PDF has unsupported data after its final trailer.",
      content_length_mismatch: "The transfer did not match the selected file. Select it again.",
      upload_too_large: "This PDF exceeds the workspace upload limit.",
      storage_quota_exceeded: "This workspace has reached its private upload storage limit.",
      upload_concurrency_exceeded: "Finish an active upload before starting another.",
      upload_session_expired: "The upload session expired. Select the file again to start a new transfer.",
      upload_session_closed: "This upload session is closed. Select the file again to start a new transfer.",
      upload_in_progress: "This PDF transfer is already in progress. PaperPilot is checking its state.",
    };
    const message = cause.code ? known[cause.code] : undefined;
    const reference = cause.requestId ? ` Reference: ${cause.requestId}.` : "";
    return `${message ?? cause.message}${reference}`;
  }
  return cause instanceof Error
    ? cause.message
    : "PaperPilot could not confirm whether the PDF transfer completed.";
}

function collaborationFailureMessage(cause: unknown): string {
  if (cause instanceof CollaborationHttpError) {
    const known: Record<string, string> = {
      version_conflict: "The authorship ledger changed. PaperPilot reloaded the current roster; review it and try again.",
      forbidden: "Your current workspace role does not authorize this change.",
      invitation_not_found: "That invitation is no longer available.",
      member_not_found: "That collaborator is no longer in this workspace.",
      owner_protected: "The workspace owner cannot be changed or removed through this control.",
      private_projects_owned: "Reassign this collaborator's private projects before removing their workspace access.",
    };
    const reference = cause.requestId ? ` Reference: ${cause.requestId}.` : "";
    return `${cause.code ? known[cause.code] ?? cause.message : cause.message}${reference}`;
  }
  return cause instanceof Error
    ? cause.message
    : "PaperPilot could not load the workspace authorship ledger.";
}

const liveProvider: ProviderDescriptor = {
  id: "openalex-live",
  displayName: "OpenAlex scholarly index",
  description: "Live scholarly metadata through PaperPilot's server gateway.",
  transport: "http-api",
  isMock: false,
  capabilities: ["search-papers", "return-provenance"],
};

const liveViews = new Set<AppView>([
  "discover",
  "workspace",
  "collaboration",
  "inbox",
  "sources",
  "project",
  "reader",
  "notes",
  "collections",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function crawlerRequestsRoute(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/crawler/requests`;
}

function exactCrawlerRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error("PaperPilot received an invalid crawler response.");
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => !keys.includes(key))
  ) {
    throw new Error("PaperPilot received an invalid crawler response.");
  }
  return value;
}

function crawlerPublicId(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)
  ) {
    throw new Error("PaperPilot received an invalid crawler response.");
  }
  return value;
}

function crawlerPolicyVersion(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new Error("PaperPilot received an invalid crawler response.");
  }
  return value;
}

function crawlerSafeInteger(value: unknown, positive = false): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < (positive ? 1 : 0)
  ) {
    throw new Error("PaperPilot received an invalid crawler response.");
  }
  return value;
}

function crawlerTimestamp(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("PaperPilot received an invalid crawler response.");
  }
  return value;
}

function nullableCrawlerTimestamp(value: unknown): string | null {
  return value === null ? null : crawlerTimestamp(value);
}

function hasUnpairedCrawlerFilenameSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function crawlerDisplayFileName(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 255
    || hasUnpairedCrawlerFilenameSurrogate(value)
    || value.normalize("NFC") !== value
    || value === "."
    || value === ".."
    || value.endsWith(".")
    || value.endsWith(" ")
    || !value.toLowerCase().endsWith(".pdf")
    || /[<>:"/\\|?*\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(value)
    || /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(value)
    || new TextEncoder().encode(value).byteLength > 255
  ) {
    throw new Error("PaperPilot received an invalid crawler response.");
  }
  const firstComponent = value.split(".", 1)[0].replace(/[ .]+$/g, "");
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(firstComponent)) {
    throw new Error("PaperPilot received an invalid crawler response.");
  }
  return value;
}

function parseCrawlerPolicySummary(value: unknown): CrawlerPolicySummary {
  const record = exactCrawlerRecord(value, [
    "acquisitionMode",
    "policyVersion",
    "rightsAttestation",
    "robotsMode",
    "retentionMode",
    "maxResponseBytes",
    "maxRedirects",
  ]);
  if (
    record.acquisitionMode !== "EXPLICIT_SINGLE_QUERY_FREE_HTTPS_PDF_V1"
    || record.rightsAttestation !== "INDEFINITE_RESEARCH_CUSTODY"
    || record.robotsMode !== "REQUIRE_ALLOW"
    || record.retentionMode !== "INDEFINITE_UNTIL_USER_DELETION"
  ) {
    throw new Error("PaperPilot received an unsupported crawler policy.");
  }
  const maxRedirects = crawlerSafeInteger(record.maxRedirects);
  if (maxRedirects !== 0) {
    throw new Error("PaperPilot received an unsupported crawler policy.");
  }
  return {
    acquisitionMode: "EXPLICIT_SINGLE_QUERY_FREE_HTTPS_PDF_V1",
    policyVersion: crawlerPolicyVersion(record.policyVersion),
    rightsAttestation: "INDEFINITE_RESEARCH_CUSTODY",
    robotsMode: "REQUIRE_ALLOW",
    retentionMode: "INDEFINITE_UNTIL_USER_DELETION",
    maxResponseBytes: crawlerSafeInteger(record.maxResponseBytes, true),
    maxRedirects: 0,
  };
}

function parseCrawlerRequestSummary(value: unknown): CrawlerRequestSummary {
  const record = exactCrawlerRecord(value, [
    "id",
    "clientOperationId",
    "canDeleteCustody",
    "displayFileName",
    "status",
    "policyVersion",
    "maxBytes",
    "receivedBytes",
    "failureCode",
    "retryAt",
    "createdAt",
    "updatedAt",
    "completedAt",
  ]);
  if (
    typeof record.status !== "string"
    || !CRAWLER_REQUEST_STATUSES.has(record.status as CrawlerRequestStatus)
    || typeof record.canDeleteCustody !== "boolean"
    || (record.failureCode !== null
      && (typeof record.failureCode !== "string"
        || !CRAWLER_FAILURE_CODES.has(record.failureCode as CrawlerSafeFailureCode)))
  ) {
    throw new Error("PaperPilot received an invalid crawler response.");
  }
  const maxBytes = crawlerSafeInteger(record.maxBytes, true);
  const receivedBytes = record.receivedBytes === null
    ? null
    : crawlerSafeInteger(record.receivedBytes);
  if (receivedBytes !== null && receivedBytes > maxBytes) {
    throw new Error("PaperPilot received an invalid crawler response.");
  }
  const status = record.status as CrawlerRequestStatus;
  const failureCode = record.failureCode as CrawlerSafeFailureCode | null;
  const retryAt = nullableCrawlerTimestamp(record.retryAt);
  const completedAt = nullableCrawlerTimestamp(record.completedAt);
  if (
    (status === "DELETING"
      && (retryAt === null
        || completedAt !== null
        || (failureCode !== null
          && failureCode !== "crawler_custody_deletion_retrying")))
    || (status === "DELETED"
      && (retryAt !== null
        || completedAt === null
        || receivedBytes !== null
        || failureCode !== null))
    || ((status === "DELETING" || status === "DELETED")
      && record.canDeleteCustody !== false)
    || (status !== "DELETING"
      && status !== "DELETED"
      && failureCode === "crawler_custody_deletion_retrying")
  ) {
    throw new Error("PaperPilot received an invalid crawler response.");
  }
  return {
    id: crawlerPublicId(record.id),
    clientOperationId: crawlerPublicId(record.clientOperationId),
    canDeleteCustody: record.canDeleteCustody,
    displayFileName: crawlerDisplayFileName(record.displayFileName),
    status,
    policyVersion: crawlerPolicyVersion(record.policyVersion),
    maxBytes,
    receivedBytes,
    failureCode,
    retryAt,
    createdAt: crawlerTimestamp(record.createdAt),
    updatedAt: crawlerTimestamp(record.updatedAt),
    completedAt,
  };
}

function parseCrawlerRequestsResponse(value: unknown): {
  policy: CrawlerPolicySummary;
  requests: CrawlerRequestSummary[];
} {
  const record = exactCrawlerRecord(value, ["schemaVersion", "policy", "requests"]);
  if (record.schemaVersion !== 1 || !Array.isArray(record.requests) || record.requests.length > 100) {
    throw new Error("PaperPilot received an invalid crawler response.");
  }
  const requests = record.requests.map(parseCrawlerRequestSummary);
  const requestIds = new Set<string>();
  const clientOperationIds = new Set<string>();
  for (const request of requests) {
    if (
      requestIds.has(request.id)
      || clientOperationIds.has(request.clientOperationId)
    ) {
      throw new Error("PaperPilot received an invalid crawler response.");
    }
    requestIds.add(request.id);
    clientOperationIds.add(request.clientOperationId);
  }
  return {
    policy: parseCrawlerPolicySummary(record.policy),
    requests,
  };
}

function parseCrawlerQueueResponse(value: unknown): {
  outcome: "applied" | "replayed";
  aggregateVersion: number;
  request: CrawlerRequestSummary;
} {
  const record = exactCrawlerRecord(value, ["outcome", "aggregateVersion", "request"]);
  if (record.outcome !== "applied" && record.outcome !== "replayed") {
    throw new Error("PaperPilot received an invalid crawler response.");
  }
  return {
    outcome: record.outcome,
    aggregateVersion: crawlerSafeInteger(record.aggregateVersion),
    request: parseCrawlerRequestSummary(record.request),
  };
}

function crawlerApiFailureMessage(
  payload: unknown,
  fallback: string,
): string {
  const error = isObject(payload) && isObject(payload.error) ? payload.error : undefined;
  const code = error && typeof error.code === "string" ? error.code : undefined;
  switch (code) {
    case "forbidden": return "Your workspace role cannot queue crawler requests.";
    case "version_conflict": return "The workspace changed. Refresh the crawler ledger, then review and retry.";
    case "policy_version_conflict": return "The crawler policy changed. Refresh and review the current policy before retrying.";
    case "invalid_crawler_command": return "The crawler request no longer matches the active first-mode policy.";
    case "rate_limited": return "Crawler request capacity is temporarily full. Wait, then retry the same request.";
    default: return fallback;
  }
}

function crawlerCustodyApiFailureMessage(
  payload: unknown,
  fallback: string,
): string {
  const error = isObject(payload) && isObject(payload.error) ? payload.error : undefined;
  const code = error && typeof error.code === "string" ? error.code : undefined;
  switch (code) {
    case "forbidden":
    case "crawler_custody_delete_forbidden":
      return "Your workspace role cannot delete private crawler PDF custody.";
    case "version_conflict":
      return "The workspace changed. PaperPilot refreshed the ledger; review the record before confirming again.";
    case "crawler_custody_deletion_pending":
      return "Private PDF deletion is already scheduled by another operation. The ledger is refreshing.";
    case "crawler_custody_already_deleted":
      return "Private PDF custody was already deleted. The ledger is refreshing its proof state.";
    case "invalid_crawler_deletion_command":
    case "idempotency_mismatch":
    case "idempotency_conflict":
      return "The deletion confirmation no longer matches this crawler record. Refresh, review, and confirm again.";
    case "crawler_request_not_found":
      return "This crawler record is no longer available in the workspace ledger.";
    case "rate_limited":
      return "Crawler deletion capacity is temporarily full. Retry this exact confirmation after the wait period.";
    default:
      return fallback;
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)?.[0]}` : parts[0]?.slice(0, 2) || "PP")
    .toUpperCase();
}

function mergeProjectDetail(
  detail: WorkspaceProjectDto,
  update: (state: WorkspaceUiState) => WorkspaceUiState,
): WorkspaceProjectDto {
  const next = update({
    aggregateVersion: detail.aggregateVersion,
    projects: [detail.project],
    papers: detail.papers,
    notes: detail.notes,
    collections: detail.collections,
  });
  return {
    aggregateVersion: next.aggregateVersion,
    project: next.projects[0] ?? detail.project,
    papers: next.papers,
    notes: next.notes,
    collections: next.collections,
  };
}

interface LivePaperPilotAppProps {
  initialBootstrap: WorkspaceBootstrapDto;
  readerPdfJsEnabled: boolean;
  user: { name: string; email: string };
}

type FrozenCrawlerSubmission = FrozenCrawlerRecoverySubmission & {
  readonly policy: Readonly<CrawlerPolicySummary>;
};

export function LivePaperPilotApp({
  initialBootstrap,
  readerPdfJsEnabled,
  user,
}: LivePaperPilotAppProps) {
  const router = useRouter();
  const collaborationClient = useMemo(() => new HttpCollaborationClient(), []);
  const client = useMemo(
    () => new HttpWorkspaceClient(initialBootstrap.workspace.id),
    [initialBootstrap.workspace.id],
  );
  const [bootstrap, setBootstrap] = useState(initialBootstrap);
  const [projectDetail, setProjectDetail] = useState<WorkspaceProjectDto>();
  const [activeView, setActiveView] = useState<AppView>("discover");
  const [showProjectDialog, setShowProjectDialog] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [importHit, setImportHit] = useState<LiteratureSearchHit>();
  const [savingImport, setSavingImport] = useState(false);
  const [filingEntryId, setFilingEntryId] = useState<string>();
  const [preparingWebMcpEntryId, setPreparingWebMcpEntryId] = useState<string>();
  const [approvingWebMcpEntryId, setApprovingWebMcpEntryId] = useState<string>();
  const [webMcpApprovalReviews, setWebMcpApprovalReviews] = useState<
    Record<string, WebMcpApprovalReview>
  >({});
  const [webMcpReviewErrors, setWebMcpReviewErrors] = useState<Record<string, string>>({});
  const [linkingDocumentId, setLinkingDocumentId] = useState<string>();
  const [readerPaperId, setReaderPaperId] = useState<string>();
  const [reader, setReader] = useState<WorkspacePaperReaderDto>();
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerLoadingMore, setReaderLoadingMore] = useState(false);
  const [readerError, setReaderError] = useState<string>();
  const [evidenceCapture, dispatchEvidenceCapture] = useReducer(
    evidenceCaptureReducer,
    { phase: "idle" } satisfies EvidenceCaptureState,
  );
  const [readerPollDelayMs, setReaderPollDelayMs] = useState(
    DEFAULT_READER_POLL_DELAY_MS,
  );
  const [uploadFile, setUploadFile] = useState<File>();
  const [uploadPhase, setUploadPhase] = useState<UploadFilePhase>("idle");
  const [uploadLoadedBytes, setUploadLoadedBytes] = useState(0);
  const [uploadMaxBytes, setUploadMaxBytes] = useState(DEFAULT_UPLOAD_MAX_BYTES);
  const [uploadMessage, setUploadMessage] = useState<string>();
  const [selectedCollectionId, setSelectedCollectionId] = useState(
    initialBootstrap.collections[0]?.id ?? "",
  );
  const [zoteroState, setZoteroState] = useState<ZoteroSourceState>({
    status: "idle",
    connections: [],
  });
  const [crawlerState, setCrawlerState] = useState<CrawlerSourceState>({
    status: "idle",
    requests: [],
  });
  const [workspaceDirectory, setWorkspaceDirectory] = useState<WorkspaceDirectoryDto>({
    schemaVersion: 1,
    activeWorkspaceId: initialBootstrap.workspace.id,
    workspaces: [{
      id: initialBootstrap.workspace.id,
      name: initialBootstrap.workspace.name,
      kind: "personal",
      role: isWorkspaceRole(initialBootstrap.workspace.role)
        ? initialBootstrap.workspace.role
        : "viewer",
      memberCount: 1,
    }],
  });
  const [receivedInvitations, setReceivedInvitations] = useState<ReceivedWorkspaceInvitationsDto>({
    schemaVersion: 1,
    invitations: [],
  });
  const [collaborators, setCollaborators] = useState<WorkspaceCollaboratorsDto | null>(null);
  const [collaborationLoading, setCollaborationLoading] = useState(false);
  const [collaborationError, setCollaborationError] = useState<string>();
  const [collaborationActionKey, setCollaborationActionKey] = useState<string | null>(null);
  const [pendingCrawlerRetry, setPendingCrawlerRetry] = useState<
    CrawlerPendingRetrySummary | undefined
  >();
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastCounter = useRef(0);
  const projectRequestCounter = useRef(0);
  const readerRequestCounter = useRef(0);
  const collaborationRequestCounter = useRef(0);
  const zoteroRequestCounter = useRef(0);
  const crawlerRequestCounter = useRef(0);
  const crawlerReadAbortController = useRef<AbortController | undefined>(undefined);
  const crawlerMutationAbortController = useRef<AbortController | undefined>(undefined);
  const crawlerMutationInFlight = useRef(false);
  const crawlerMounted = useRef(true);
  const uploadRequestCounter = useRef(0);
  const uploadAbortController = useRef<AbortController | undefined>(undefined);
  const uploadIntent = useRef<{
    operationId: string;
    file: File;
    expectedSha256?: string;
    uploadId?: string;
  } | undefined>(undefined);
  const webMcpFinalSubmissions = useRef<Record<string, {
    key: string;
    submission: FrozenWebMcpApprovalSubmission;
  }>>({});
  const crawlerSubmissions = useRef<Record<string, FrozenCrawlerSubmission>>({});
  const crawlerDeletionSubmissions = useRef<Record<
    string,
    Readonly<FrozenCrawlerCustodyDeletionSubmission>
  >>({});
  const webMcpApprovalInFlight = useRef<string | undefined>(undefined);

  const activeProject = bootstrap.projects.find(
    (project) => project.id === bootstrap.activeProjectId,
  ) ?? bootstrap.projects[0];
  const activeProjectPapers = activeProject
    ? activeProject.paperIds
        .map((paperId) => bootstrap.papers.find((paper) => paper.id === paperId))
        .filter((paper): paper is WorkspaceBootstrapDto["papers"][number] => Boolean(paper))
    : [];
  const activeProjectNoteHeads = activeProject
    ? activeProject.evidenceNoteIds
        .map((noteId) => bootstrap.notes.find((note) => note.id === noteId))
        .filter((note): note is WorkspaceBootstrapDto["notes"][number] => Boolean(note))
    : [];
  const activeProjectNotes = activeProject
    ? evidenceNotesForHeads(bootstrap.notes, activeProject.evidenceNoteIds)
    : [];
  const activeProjectCollections = activeProject
    ? activeProject.collectionIds
        .map((collectionId) => bootstrap.collections.find(
          (collection) => collection.id === collectionId,
        ))
        .filter((collection): collection is WorkspaceBootstrapDto["collections"][number] => Boolean(collection))
    : [];
  const currentProjectPaperId = activeProjectPapers[0]?.id ?? "";
  const readerStages = useMemo(
    () => getLatestPaperExtractionStages(bootstrap.inboxEntries),
    [bootstrap.inboxEntries],
  );
  const readerPaper = readerPaperId
    ? bootstrap.papers.find((paper) => paper.id === readerPaperId)
    : undefined;
  const defaultReaderPaperId = activeProjectPapers.find(
    (paper) => readerStages[paper.id] === "ready",
  )?.id ?? activeProjectPapers[0]?.id;
  const readerProgress = reader?.state === "ready" && reader.generation.chunkCount > 0
    ? Math.round((reader.chunks.length / reader.generation.chunkCount) * 100)
    : 0;
  const canManageIntegrations = isWorkspaceIntegrationManager(
    bootstrap.workspace.role,
  );
  const canQueueCrawler = MUTATING_WORKSPACE_ROLES.has(bootstrap.workspace.role);
  const hashProjectId = bootstrap.activeProjectId ?? bootstrap.projects[0]?.id;
  const actionableInboxCount = bootstrap.inboxEntries.filter(
    (entry) => isDocumentUploadInboxEntry(entry)
      ? entry.upload.stage !== "ready" || !entry.upload.linkedPaperId
      : isCrawlerDocumentInboxEntry(entry)
        ? entry.crawler.stage !== "ready" || !entry.crawler.linkedPaperId
      : entry.status !== "ready",
  ).length;
  const refreshableUploadKey = useMemo(
    () => JSON.stringify(getRefreshableDocumentUploadIds(bootstrap.inboxEntries)),
    [bootstrap.inboxEntries],
  );

  const showToast = useCallback((title: string, detail: string) => {
    const id = ++toastCounter.current;
    setToasts((current) => [...current, { id, title, detail }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3_600);
  }, []);

  const loadCollaboration = useCallback(async (showLoading = true): Promise<boolean> => {
    const requestId = ++collaborationRequestCounter.current;
    if (showLoading) setCollaborationLoading(true);
    setCollaborationError(undefined);
    try {
      const [directoryResult, invitationsResult, rosterResult] = await Promise.allSettled([
        collaborationClient.listWorkspaces(),
        collaborationClient.listInvitations(),
        collaborationClient.collaborators(initialBootstrap.workspace.id),
      ]);
      if (requestId !== collaborationRequestCounter.current) return false;
      const failures: unknown[] = [];
      if (directoryResult.status === "fulfilled") {
        setWorkspaceDirectory({
          ...directoryResult.value,
          // The rendered app snapshot remains authoritative until a workspace switch reloads it.
          // A different active organization observed through another tab must not retarget this UI.
          activeWorkspaceId: initialBootstrap.workspace.id,
        });
      } else failures.push(directoryResult.reason);
      if (invitationsResult.status === "fulfilled") {
        setReceivedInvitations(invitationsResult.value);
      } else failures.push(invitationsResult.reason);
      if (rosterResult.status === "fulfilled") {
        setCollaborators(rosterResult.value);
      } else failures.push(rosterResult.reason);
      if (failures.length > 0) {
        setCollaborationError(collaborationFailureMessage(failures[0]));
        return false;
      }
      return true;
    } catch (cause) {
      if (requestId !== collaborationRequestCounter.current) return false;
      setCollaborationError(collaborationFailureMessage(cause));
      return false;
    } finally {
      if (requestId === collaborationRequestCounter.current) {
        setCollaborationLoading(false);
      }
    }
  }, [collaborationClient, initialBootstrap.workspace.id]);

  const requestZoteroConnections = useCallback(async () => {
    const response = await fetch(
      zoteroConnectionsRoute(initialBootstrap.workspace.id),
      {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(safeApiProblemMessage(
        payload,
        "PaperPilot could not load Zotero connection status.",
      ));
    }
    return parseZoteroConnectionsResponse(payload).connections;
  }, [initialBootstrap.workspace.id]);

  const loadZoteroConnections = useCallback(async (showLoading = true): Promise<void> => {
    const requestId = ++zoteroRequestCounter.current;
    if (showLoading) {
      setZoteroState((current) => ({
        status: "loading",
        connections: current.connections,
      }));
    }
    try {
      const connections = await requestZoteroConnections();
      if (requestId !== zoteroRequestCounter.current) return;
      setZoteroState({ status: "ready", connections });
    } catch (cause) {
      if (requestId !== zoteroRequestCounter.current) return;
      setZoteroState((current) => ({
        status: "error",
        connections: current.connections,
        message: cause instanceof Error
          ? cause.message
          : "PaperPilot could not load Zotero connection status.",
      }));
    }
  }, [requestZoteroConnections]);

  const cancelCrawlerReads = useCallback(() => {
    crawlerRequestCounter.current += 1;
    crawlerReadAbortController.current?.abort();
    crawlerReadAbortController.current = undefined;
  }, []);

  const requestCrawlerRequests = useCallback(async (signal: AbortSignal) => {
    const response = await fetch(
      crawlerRequestsRoute(initialBootstrap.workspace.id),
      {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal,
      },
    );
    if (!response.ok) {
      throw new Error("PaperPilot could not load the crawler request ledger.");
    }
    const payload: unknown = await response.json().catch(() => undefined);
    return parseCrawlerRequestsResponse(payload);
  }, [initialBootstrap.workspace.id]);

  const loadCrawlerRequests = useCallback(async (showLoading = true): Promise<void> => {
    if (crawlerMutationInFlight.current || !crawlerMounted.current) return;
    crawlerReadAbortController.current?.abort();
    const requestId = ++crawlerRequestCounter.current;
    const requestController = new AbortController();
    crawlerReadAbortController.current = requestController;
    if (showLoading) {
      setCrawlerState((current) => ({
        status: "loading",
        policy: current.policy,
        requests: current.requests,
      }));
    }
    try {
      const result = await requestCrawlerRequests(requestController.signal);
      if (
        requestController.signal.aborted
        || requestId !== crawlerRequestCounter.current
        || crawlerMutationInFlight.current
        || !crawlerMounted.current
      ) return;
      const reconciledDeletionIds = new Set(
        result.requests
          .filter((request) => request.status === "DELETING" || request.status === "DELETED")
          .map((request) => request.id),
      );
      let reconciledCustodyRecovery = false;
      for (const [operationId, submission] of Object.entries(
        crawlerDeletionSubmissions.current,
      )) {
        if (reconciledDeletionIds.has(submission.crawlerImportId)) {
          delete crawlerDeletionSubmissions.current[operationId];
          reconciledCustodyRecovery = true;
        }
      }
      if (reconciledCustodyRecovery) {
        clearCrawlerCustodyDeletionRecovery(
          window.sessionStorage,
          initialBootstrap.workspace.id,
        );
      }
      setCrawlerState({
        status: "ready",
        policy: result.policy,
        requests: result.requests,
      });
    } catch {
      if (
        requestController.signal.aborted
        || requestId !== crawlerRequestCounter.current
        || crawlerMutationInFlight.current
        || !crawlerMounted.current
      ) return;
      setCrawlerState((current) => ({
        status: "error",
        policy: current.policy,
        requests: current.requests,
        message: "PaperPilot could not load the crawler request ledger.",
      }));
    } finally {
      if (crawlerReadAbortController.current === requestController) {
        crawlerReadAbortController.current = undefined;
      }
    }
  }, [initialBootstrap.workspace.id, requestCrawlerRequests]);

  useEffect(() => {
    crawlerMounted.current = true;
    return () => {
      crawlerMounted.current = false;
      cancelCrawlerReads();
      crawlerMutationAbortController.current?.abort();
      crawlerMutationAbortController.current = undefined;
    };
  }, [cancelCrawlerReads]);

  useEffect(() => {
    const restored = restoreCrawlerRecovery(
      window.sessionStorage,
      initialBootstrap.workspace.id,
    );
    if (!restored) return;
    const submission: FrozenCrawlerSubmission = Object.freeze({
      ...restored,
      policy: Object.freeze({ ...restored.policy }),
    });
    crawlerSubmissions.current = {
      [submission.clientOperationId]: submission,
    };
    setPendingCrawlerRetry({
      clientOperationId: submission.clientOperationId,
      displayFileName: submission.displayFileName,
      policyVersion: submission.policyVersion,
      maxBytes: submission.maxBytes,
    });
  }, [initialBootstrap.workspace.id]);

  useEffect(() => {
    const restored = restoreCrawlerCustodyDeletionRecovery(
      window.sessionStorage,
      initialBootstrap.workspace.id,
    );
    if (!restored) return;
    crawlerDeletionSubmissions.current = {
      [restored.clientOperationId]: restored,
    };
    showToast(
      "Deletion confirmation recovered",
      "PaperPilot preserved the exact confirmation after an unknown outcome. Review that crawler record and choose delete again to check the same operation.",
    );
  }, [initialBootstrap.workspace.id, showToast]);

  useEffect(() => {
    const callback = zoteroCallbackConsumption(window.location.href);
    if (!callback.hadParameter) return;
    window.history.replaceState(window.history.state, "", callback.replacement);
    if (callback.result === "connected") {
      showToast(
        "Zotero connected",
        "The read-only connection was verified. Refreshing credential-free library summaries now.",
      );
    } else if (callback.result === "failed") {
      showToast(
        "Zotero connection failed",
        "No connection was added. Review the selected scope and try again from Sources.",
      );
    }
    if (!callback.result) return;
    const requestId = ++zoteroRequestCounter.current;
    void requestZoteroConnections().then((connections) => {
      if (requestId === zoteroRequestCounter.current) {
        setZoteroState({ status: "ready", connections });
      }
    }).catch((cause: unknown) => {
      if (requestId !== zoteroRequestCounter.current) return;
      setZoteroState((current) => ({
        status: "error",
        connections: current.connections,
        message: cause instanceof Error
          ? cause.message
          : "PaperPilot could not load Zotero connection status.",
      }));
    });
  }, [requestZoteroConnections, showToast]);

  useEffect(() => {
    if (activeView !== "sources") return;
    const requestId = ++zoteroRequestCounter.current;
    void requestZoteroConnections().then((connections) => {
      if (requestId === zoteroRequestCounter.current) {
        setZoteroState({ status: "ready", connections });
      }
    }).catch((cause: unknown) => {
      if (requestId !== zoteroRequestCounter.current) return;
      setZoteroState((current) => ({
        status: "error",
        connections: current.connections,
        message: cause instanceof Error
          ? cause.message
          : "PaperPilot could not load Zotero connection status.",
      }));
    });
  }, [activeView, requestZoteroConnections]);

  useEffect(() => {
    if (activeView !== "collaboration") return;
    void loadCollaboration(true);
  }, [activeView, loadCollaboration]);

  useEffect(() => {
    if (activeView !== "sources") return;
    const runs = zoteroState.connections
      .flatMap((connection) => connection.libraries)
      .map((library) => library.lastSyncRun)
      .filter((run) => run !== null);
    const hasImmediateWork = runs.some((run) =>
      run.status === "QUEUED" || run.status === "RUNNING");
    const hasBackoff = runs.some((run) => run.status === "BACKING_OFF");
    if (!hasImmediateWork && !hasBackoff) return;
    const timer = window.setTimeout(
      () => void loadZoteroConnections(false),
      hasImmediateWork ? 3_500 : 30_000,
    );
    return () => window.clearTimeout(timer);
  }, [activeView, loadZoteroConnections, zoteroState.connections]);

  useEffect(() => {
    if (activeView !== "sources") {
      cancelCrawlerReads();
      return;
    }
    void loadCrawlerRequests(true);
    return cancelCrawlerReads;
  }, [activeView, cancelCrawlerReads, loadCrawlerRequests]);

  useEffect(() => {
    if (
      activeView !== "sources"
      || !crawlerState.requests.some((request) =>
        ACTIVE_CRAWLER_REQUEST_STATUSES.has(request.status))
    ) return;
    const timer = window.setTimeout(
      () => void loadCrawlerRequests(false),
      CRAWLER_STATUS_REFRESH_INTERVAL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [activeView, crawlerState.requests, loadCrawlerRequests]);

  useEffect(() => {
    if (
      activeView !== "inbox"
      || bootstrap.workspace.id !== initialBootstrap.workspace.id
    ) return;
    const controller = new AbortController();
    void client.bootstrap().then((refreshed) => {
      if (!controller.signal.aborted) setBootstrap(refreshed);
    }).catch(() => {
      // Inbox refresh is opportunistic; existing authorized state remains visible.
    });
    return () => controller.abort();
  }, [activeView, bootstrap.workspace.id, client, initialBootstrap.workspace.id]);

  useEffect(() => {
    if (
      refreshableUploadKey === "[]"
      || bootstrap.workspace.id !== initialBootstrap.workspace.id
    ) return;

    const workspaceId = initialBootstrap.workspace.id;
    const refreshableUploadIds = JSON.parse(refreshableUploadKey) as string[];
    const refreshOnFocus = activeView === "inbox" || activeView === "sources";
    let cancelled = false;
    let inFlight = false;
    let immediateRefreshQueued = false;
    let timeoutId: number | undefined;
    let requestController: AbortController | undefined;

    function scheduleRefresh(delay: number) {
      if (cancelled) return;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        timeoutId = undefined;
        void refreshUploadStatuses();
      }, delay);
    }

    async function refreshUploadStatuses() {
      if (cancelled) return;
      if (inFlight) {
        immediateRefreshQueued = true;
        return;
      }

      inFlight = true;
      immediateRefreshQueued = false;
      const controller = new AbortController();
      requestController = controller;
      const refreshedEntries: DocumentUploadInboxEntry[] = [];
      let shouldContinue = false;

      try {
        for (const uploadId of refreshableUploadIds) {
          try {
            const status = await client.getUploadStatus(uploadId, controller.signal);
            if (cancelled || controller.signal.aborted) return;
            if (status.upload.id !== uploadId) {
              shouldContinue = true;
              continue;
            }
            refreshedEntries.push(status.inboxEntry);
            shouldContinue ||= isDocumentUploadRefreshPending(
              status.upload.status,
              status.inboxEntry.upload.extractionStage,
            );
          } catch {
            if (cancelled || controller.signal.aborted) return;
            // A transient status read stays silent and is retried on the normal cadence.
            shouldContinue = true;
          }
        }

        if (refreshedEntries.length) {
          setBootstrap((current) => current.workspace.id === workspaceId
            ? {
                ...current,
                inboxEntries: mergeRefreshedDocumentUploads(
                  current.inboxEntries,
                  refreshedEntries,
                ),
              }
            : current);
        }
      } finally {
        if (requestController === controller) requestController = undefined;
        inFlight = false;
        if (!cancelled && shouldContinue) {
          scheduleRefresh(
            immediateRefreshQueued ? 0 : UPLOAD_STATUS_REFRESH_INTERVAL_MS,
          );
        }
      }
    }

    function refreshFocusedView() {
      if (!refreshOnFocus || cancelled) return;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (inFlight) {
        immediateRefreshQueued = true;
        return;
      }
      void refreshUploadStatuses();
    }

    function refreshVisibleView() {
      if (document.visibilityState === "visible") refreshFocusedView();
    }

    if (refreshOnFocus) {
      window.addEventListener("focus", refreshFocusedView);
      document.addEventListener("visibilitychange", refreshVisibleView);
      refreshFocusedView();
    } else {
      scheduleRefresh(UPLOAD_STATUS_REFRESH_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      requestController?.abort();
      window.removeEventListener("focus", refreshFocusedView);
      document.removeEventListener("visibilitychange", refreshVisibleView);
    };
  }, [
    activeView,
    bootstrap.workspace.id,
    client,
    initialBootstrap.workspace.id,
    refreshableUploadKey,
  ]);

  const openProject = useCallback(async (projectId: string, updateHistory = true) => {
    const requestId = ++projectRequestCounter.current;
    try {
      const detail = await client.getProject({ projectId });
      if (requestId !== projectRequestCounter.current) return;
      if (!detail) {
        showToast(
          "Project unavailable",
          "This project no longer exists or is private to another workspace member.",
        );
        return;
      }

      setProjectDetail(detail);
      setBootstrap((current) => ({
        ...current,
        aggregateVersion: detail.aggregateVersion,
        activeProjectId: detail.project.id,
        projects: [
          detail.project,
          ...current.projects.filter((project) => project.id !== detail.project.id),
        ],
        papers: [
          ...detail.papers,
          ...current.papers.filter(
            (paper) => !detail.papers.some((projectPaper) => projectPaper.id === paper.id),
          ),
        ],
        notes: [
          ...detail.notes,
          ...current.notes.filter(
            (note) => !detail.notes.some((projectNote) => projectNote.id === note.id),
          ),
        ],
        collections: [
          ...detail.collections,
          ...current.collections.filter(
            (collection) => !detail.collections.some(
              (projectCollection) => projectCollection.id === collection.id,
            ),
          ),
        ],
      }));
      setActiveView("project");
      if (updateHistory) window.history.pushState(null, "", "#project");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      if (requestId !== projectRequestCounter.current) return;
      showToast(
        "Project service unavailable",
        error instanceof Error ? error.message : "PaperPilot could not load this project.",
      );
    }
  }, [client, showToast]);

  const loadReader = useCallback(async (
    paperId: string,
    options: { updateHistory?: boolean; reset?: boolean } = {},
  ) => {
    const requestId = ++readerRequestCounter.current;
    setReaderPaperId(paperId);
    setReaderError(undefined);
    setReaderLoading(true);
    if (options.reset !== false) {
      setReader(undefined);
      setReaderPollDelayMs(DEFAULT_READER_POLL_DELAY_MS);
    }
    setActiveView("reader");
    if (options.updateHistory !== false) {
      window.history.pushState(null, "", "#reader");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    try {
      const response = await client.getPaperReader(paperId, { limit: 50 });
      if (requestId !== readerRequestCounter.current) return;
      if (response.state === "ready") {
        dispatchEvidenceCapture({
          type: "source-replaced",
          extractionId: response.generation.id,
        });
      }
      setReader(response);
      setReaderPollDelayMs(DEFAULT_READER_POLL_DELAY_MS);
    } catch (cause) {
      if (requestId !== readerRequestCounter.current) return;
      if (
        options.reset === false
        && cause instanceof WorkspaceHttpError
        && cause.status === 429
      ) {
        setReaderPollDelayMs(readerPollingDelayMs(cause.retryAfterSeconds));
        setReaderError(undefined);
        return;
      }
      setReaderError(cause instanceof Error
        ? cause.message
        : "PaperPilot could not verify this Reader source.");
    } finally {
      if (requestId === readerRequestCounter.current) setReaderLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (
      activeView !== "reader"
      || !readerPaperId
      || reader?.state !== "processing"
      || readerLoading
    ) return;
    const timeoutId = window.setTimeout(() => {
      void loadReader(readerPaperId, { updateHistory: false, reset: false });
    }, readerPollDelayMs);
    return () => window.clearTimeout(timeoutId);
  }, [activeView, loadReader, reader, readerLoading, readerPaperId, readerPollDelayMs]);

  useEffect(() => {
    function routeFromHash() {
      const view = window.location.hash.slice(1) as AppView;
      if (view !== "reader") dispatchEvidenceCapture({ type: "dismissed" });
      if (view === "project") {
        if (hashProjectId) {
          void openProject(hashProjectId, false);
        } else {
          setActiveView("workspace");
        }
        return;
      }
      if (view === "reader") {
        const selectedPaperId = readerPaperId ?? defaultReaderPaperId;
        if (selectedPaperId) {
          void loadReader(selectedPaperId, { updateHistory: false });
        } else {
          setReaderPaperId(undefined);
          setReader(undefined);
          setActiveView("reader");
        }
        return;
      }
      setActiveView(liveViews.has(view) ? view : "discover");
    }
    const frame = window.requestAnimationFrame(routeFromHash);
    window.addEventListener("hashchange", routeFromHash);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", routeFromHash);
    };
  }, [
    defaultReaderPaperId,
    hashProjectId,
    loadReader,
    openProject,
    readerPaperId,
  ]);

  function navigate(view: AppView) {
    if (view !== "reader" && evidenceCapture.phase === "saving") {
      showToast(
        "Evidence write in progress",
        "Keep the Reader open until PaperPilot confirms the immutable evidence write.",
      );
      return;
    }
    if (view !== "reader" && evidenceCapture.phase !== "idle") {
      dispatchEvidenceCapture({ type: "dismissed" });
    }
    if (view === "project") {
      if (activeProject) {
        void openProject(activeProject.id);
      } else {
        showToast("Create a project first", "Project resources need an active research project.");
      }
      return;
    }
    if (view === "reader") {
      const selectedPaperId = readerPaperId ?? defaultReaderPaperId;
      if (selectedPaperId) {
        void loadReader(selectedPaperId);
      } else {
        setReaderPaperId(undefined);
        setReader(undefined);
        setReaderError(undefined);
        setActiveView("reader");
        window.history.pushState(null, "", "#reader");
      }
      return;
    }
    if ((view === "notes" || view === "collections") && !activeProject) {
      showToast(
        "Create a project first",
        "Evidence and collections need an active research project.",
      );
      setActiveView("workspace");
      window.history.pushState(null, "", "#workspace");
      return;
    }
    const supported = liveViews.has(view) ? view : "workspace";
    if (!liveViews.has(view)) {
      showToast(
        "Document processing required",
        "The live reader opens after an uploaded document has passed the verified processing pipeline.",
      );
    }
    setActiveView(supported);
    window.history.pushState(null, "", `#${supported}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function searchLiterature(
    request: LiteratureSearchRequest,
  ): Promise<LiteratureSearchResponse> {
    const response = await fetch("/api/discover", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const errorPayload = isObject(payload) && isObject(payload.error)
        ? payload.error
        : payload;
      const message = isObject(errorPayload) && typeof errorPayload.message === "string"
        ? errorPayload.message
        : "The live literature gateway could not complete this search.";
      throw new Error(message);
    }
    if (!isObject(payload) || !Array.isArray(payload.results)) {
      throw new Error("The literature gateway returned an invalid response.");
    }
    return payload as unknown as LiteratureSearchResponse;
  }

  function selectUploadFile(file: File | null) {
    if (uploadPhase === "creating" || uploadPhase === "transferring") return;
    uploadAbortController.current?.abort();
    uploadAbortController.current = undefined;
    uploadRequestCounter.current += 1;
    if (!file) {
      uploadIntent.current = undefined;
      setUploadFile(undefined);
      setUploadPhase("idle");
      setUploadLoadedBytes(0);
      setUploadMessage(undefined);
      return;
    }
    uploadIntent.current = { operationId: crypto.randomUUID(), file };
    setUploadFile(file);
    setUploadPhase("selected");
    setUploadLoadedBytes(0);
    setUploadMessage(undefined);
  }

  async function startPdfUpload() {
    const intent = uploadIntent.current;
    if (!intent || uploadPhase === "creating" || uploadPhase === "transferring") return;
    const requestNumber = ++uploadRequestCounter.current;
    let uploadId = intent.uploadId;
    let aggregateVersion = bootstrap.aggregateVersion;
    try {
      if (!intent.expectedSha256) {
        setUploadPhase("creating");
        setUploadMessage("Verifying the selected PDF before reserving private storage…");
        const fileBytes = new Uint8Array(await intent.file.arrayBuffer());
        if (requestNumber !== uploadRequestCounter.current) return;
        intent.expectedSha256 = await sha256PdfBytes(fileBytes);
        if (requestNumber !== uploadRequestCounter.current) return;
      }
      if (!uploadId) {
        setUploadPhase("creating");
        setUploadMessage("Creating a tenant-bound private upload session…");
        let created = await client.createUploadSession({
          clientOperationId: intent.operationId,
          expectedVersion: aggregateVersion,
          fileName: intent.file.name,
          sizeBytes: intent.file.size,
          sha256: intent.expectedSha256,
          declaredMimeType: "application/pdf",
        });
        if (!created.ok && created.code === "version_conflict") {
          const refreshed = await client.bootstrap();
          if (requestNumber !== uploadRequestCounter.current) return;
          setBootstrap(refreshed);
          aggregateVersion = refreshed.aggregateVersion;
          created = await client.createUploadSession({
            clientOperationId: intent.operationId,
            expectedVersion: aggregateVersion,
            fileName: intent.file.name,
            sizeBytes: intent.file.size,
            sha256: intent.expectedSha256,
            declaredMimeType: "application/pdf",
          });
        }
        if (!created.ok) {
          throw new WorkspaceHttpError(409, created.code, undefined, undefined, created.message);
        }
        if (requestNumber !== uploadRequestCounter.current) return;
        uploadId = created.data.upload.id;
        intent.uploadId = uploadId;
        setUploadMaxBytes(created.data.upload.maxBytes);
        setBootstrap((current) => ({
          ...current,
          aggregateVersion: created.aggregateVersion,
          inboxEntries: upsertInboxEntry(current.inboxEntries, created.data.inboxEntry),
        }));
      }

      const controller = new AbortController();
      uploadAbortController.current = controller;
      setUploadPhase("transferring");
      setUploadLoadedBytes(0);
      setUploadMessage("Transferring the selected bytes into private quarantine…");
      const status = await client.uploadContent(uploadId, intent.file, {
        signal: controller.signal,
        onProgress: ({ loadedBytes }) => {
          if (requestNumber === uploadRequestCounter.current) {
            setUploadLoadedBytes(loadedBytes);
          }
        },
      });
      if (requestNumber !== uploadRequestCounter.current) return;
      setBootstrap((current) => ({
        ...current,
        inboxEntries: upsertInboxEntry(current.inboxEntries, status.inboxEntry),
      }));
      setUploadLoadedBytes(intent.file.size);
      if (isStoredUploadStage(status.upload.status)) {
        const feedback = storedUploadFeedback(status.upload.status);
        setUploadPhase("quarantined");
        setUploadMessage(feedback.message);
        navigate("inbox");
        showToast(feedback.toastTitle, feedback.toastDescription);
      } else {
        setUploadPhase("error");
        setUploadMessage(status.inboxEntry.failure?.message ?? "This PDF could not be accepted.");
      }
    } catch (cause) {
      if (requestNumber !== uploadRequestCounter.current) return;
      let confirmed: Awaited<ReturnType<typeof client.getUploadStatus>> | undefined;
      if (uploadId) {
        try {
          confirmed = await client.getUploadStatus(uploadId);
        } catch {
          // Preserve the original safe failure. The outcome remains unknown.
        }
      }
      if (requestNumber !== uploadRequestCounter.current) return;
      if (confirmed) {
        setBootstrap((current) => ({
          ...current,
          inboxEntries: upsertInboxEntry(current.inboxEntries, confirmed.inboxEntry),
        }));
        if (isStoredUploadStage(confirmed.upload.status)) {
          const feedback = storedUploadFeedback(confirmed.upload.status);
          setUploadLoadedBytes(intent.file.size);
          setUploadPhase("quarantined");
          setUploadMessage(feedback.message);
          navigate("inbox");
          return;
        }
        if (confirmed.upload.status === "failed" || confirmed.upload.status === "expired") {
          setUploadPhase("error");
          setUploadMessage(confirmed.inboxEntry.failure?.message ?? uploadFailureMessage(cause));
          return;
        }
      }
      setUploadPhase("error");
      setUploadMessage(uploadFailureMessage(cause));
    } finally {
      if (requestNumber === uploadRequestCounter.current) {
        uploadAbortController.current = undefined;
      }
    }
  }

  function cancelPdfUpload() {
    uploadAbortController.current?.abort();
  }

  const uploadController: UploadFileController = {
    role: bootstrap.workspace.role,
    canUpload: MUTATING_WORKSPACE_ROLES.has(bootstrap.workspace.role),
    maxBytes: uploadMaxBytes,
    phase: uploadPhase,
    selected: uploadFile ? {
      fileName: uploadFile.name,
      sizeBytes: uploadFile.size,
      mediaType: uploadFile.type || undefined,
    } : undefined,
    loadedBytes: uploadLoadedBytes,
    totalBytes: uploadFile?.size,
    message: uploadMessage,
    onSelect: selectUploadFile,
    onStart: startPdfUpload,
    onCancel: cancelPdfUpload,
    onRetry: startPdfUpload,
  };

  function saveSearchHit(hit: LiteratureSearchHit) {
    setImportHit(hit);
  }

  async function importSearchHit(destinationProjectId?: string) {
    if (!importHit || savingImport) return;
    setSavingImport(true);
    try {
      const staged = await client.stageImport({
        clientOperationId: crypto.randomUUID(),
        expectedVersion: bootstrap.aggregateVersion,
        sourceKind: "discover",
        paper: importHit.paper,
        provenance: importHit.provenance,
      });
      if (!staged.ok) {
        if (staged.code === "version_conflict") {
          setBootstrap(await client.bootstrap());
        }
        showToast("Paper not staged", staged.message);
        return;
      }

      setBootstrap((current) => ({
        ...current,
        aggregateVersion: staged.aggregateVersion,
        inboxEntries: [
          staged.data.inboxEntry,
          ...current.inboxEntries.filter((entry) => entry.id !== staged.data.inboxEntry.id),
        ],
      }));

      if (!destinationProjectId) {
        setImportHit(undefined);
        navigate("inbox");
        showToast(
          staged.outcome === "noop" ? "Paper already staged" : "Paper staged in Inbox",
          `“${importHit.paper.shortTitle}” is stored with its source provenance.`,
        );
        return;
      }

      const filed = await client.fileImport({
        clientOperationId: crypto.randomUUID(),
        expectedVersion: staged.aggregateVersion,
        inboxEntryId: staged.data.inboxEntry.id,
        projectId: destinationProjectId,
      });
      if (!filed.ok) {
        if (filed.code === "version_conflict") {
          setBootstrap(await client.bootstrap());
        }
        showToast(
          "Paper staged, but not filed",
          `${filed.message} The Inbox copy remains available for retry.`,
        );
        return;
      }

      setBootstrap((current) => ({
        ...current,
        aggregateVersion: filed.aggregateVersion,
        activeProjectId: filed.data.project.id,
        inboxEntries: [
          filed.data.inboxEntry,
          ...current.inboxEntries.filter((entry) => entry.id !== filed.data.inboxEntry.id),
        ],
        papers: [
          filed.data.paper,
          ...current.papers.filter((paper) => paper.id !== filed.data.paper.id),
        ],
        projects: [
          filed.data.project,
          ...current.projects.filter((project) => project.id !== filed.data.project.id),
        ],
      }));
      setProjectDetail(undefined);
      setImportHit(undefined);
      navigate("workspace");
      showToast(
        filed.data.usedExistingPaper ? "Existing paper linked" : "Paper saved to project",
        `“${filed.data.paper.shortTitle}” is now in “${filed.data.project.name}”.`,
      );
    } catch (error) {
      showToast(
        "Import service unavailable",
        error instanceof Error ? error.message : "PaperPilot could not save this paper.",
      );
    } finally {
      setSavingImport(false);
    }
  }

  async function createProject(draft: ProjectDraft) {
    if (savingProject) return;
    setSavingProject(true);
    try {
      const result = await client.createProject({
        clientOperationId: crypto.randomUUID(),
        expectedVersion: bootstrap.aggregateVersion,
        project: draft,
      });
      if (!result.ok) {
        if (result.code === "version_conflict") {
          const refreshed = await client.bootstrap();
          setBootstrap(refreshed);
        }
        showToast("Project not created", result.message);
        return;
      }
      setBootstrap((current) => ({
        ...current,
        aggregateVersion: result.aggregateVersion,
        activeProjectId: result.data.activeProjectId,
        projects: [
          result.data.project,
          ...current.projects.filter((project) => project.id !== result.data.project.id),
        ],
      }));
      setProjectDetail(undefined);
      setShowProjectDialog(false);
      navigate("workspace");
      showToast("Project created", `“${result.data.project.name}” is stored in the live workspace.`);
    } catch (error) {
      showToast(
        "Project service unavailable",
        error instanceof Error ? error.message : "PaperPilot could not create the project.",
      );
    } finally {
      setSavingProject(false);
    }
  }

  async function fileInboxEntry(inboxEntryId: string, projectId: string) {
    if (filingEntryId) return;
    setFilingEntryId(inboxEntryId);
    try {
      const filed = await client.fileImport({
        clientOperationId: crypto.randomUUID(),
        expectedVersion: bootstrap.aggregateVersion,
        inboxEntryId,
        projectId,
      });
      if (!filed.ok) {
        if (filed.code === "version_conflict") {
          setBootstrap(await client.bootstrap());
        }
        showToast("Paper not filed", filed.message);
        return;
      }

      setBootstrap((current) => ({
        ...current,
        aggregateVersion: filed.aggregateVersion,
        activeProjectId: filed.data.project.id,
        inboxEntries: [
          filed.data.inboxEntry,
          ...current.inboxEntries.filter((entry) => entry.id !== filed.data.inboxEntry.id),
        ],
        papers: [
          filed.data.paper,
          ...current.papers.filter((paper) => paper.id !== filed.data.paper.id),
        ],
        projects: [
          filed.data.project,
          ...current.projects.filter((project) => project.id !== filed.data.project.id),
        ],
      }));
      setProjectDetail(undefined);
      showToast(
        filed.outcome === "noop" ? "Paper already filed" : "Inbox paper filed",
        `“${filed.data.paper.shortTitle}” is available in “${filed.data.project.name}”.`,
      );
    } catch (error) {
      showToast(
        "Import service unavailable",
        error instanceof Error ? error.message : "PaperPilot could not file this Inbox record.",
      );
    } finally {
      setFilingEntryId(undefined);
    }
  }

  function currentWebMcpSelection(selection: WebMcpApprovalSelection) {
    const entry = bootstrap.inboxEntries.find(
      (candidate) => candidate.id === selection.inboxEntryId,
    );
    const destination = bootstrap.projects.find(
      (project) => project.id === selection.destinationProjectId,
    );
    const expectedDecision = entry && isWebMcpInboxEntry(entry)
      ? entry.duplicateOfPaperId
        ? { kind: "use_existing" as const, canonicalPaperId: entry.duplicateOfPaperId }
        : { kind: "create_new" as const }
      : undefined;
    const decisionMatches = expectedDecision?.kind === selection.duplicateDecision.kind
      && (expectedDecision.kind === "create_new"
        || (selection.duplicateDecision.kind === "use_existing"
          && expectedDecision.canonicalPaperId === selection.duplicateDecision.canonicalPaperId));
    if (
      !MUTATING_WORKSPACE_ROLES.has(bootstrap.workspace.role)
      || !entry
      || !isWebMcpInboxEntry(entry)
      || entry.proposalDigest !== selection.proposalDigest
      || !destination
      || !decisionMatches
      || (entry.status !== "awaiting-review" && entry.status !== "possible-duplicate")
    ) {
      return null;
    }
    return { entry, destination };
  }

  function clearWebMcpApprovalReview(entryId: string) {
    delete webMcpFinalSubmissions.current[entryId];
    setWebMcpApprovalReviews((current) => {
      if (!current[entryId]) return current;
      const next = { ...current };
      delete next[entryId];
      return next;
    });
  }

  function discardWebMcpApprovalReview(entryId: string) {
    const review = webMcpApprovalReviews[entryId];
    if (review?.finalOutcomeUnknown) {
      const message = "The final outcome is unknown. Retry the exact approval attempt before preparing different evidence.";
      setWebMcpReviewErrors((current) => ({ ...current, [entryId]: message }));
      showToast("Exact retry required", message);
      return;
    }
    clearWebMcpApprovalReview(entryId);
  }

  function reportWebMcpIntentDrift(entryId: string, action: "prepare" | "approve") {
    const message = "This source dossier, project, or duplicate decision changed. Refresh the Inbox and review the current fingerprint before preparing new evidence.";
    setWebMcpReviewErrors((current) => ({ ...current, [entryId]: message }));
    showToast(
      action === "prepare" ? "Authority evidence not prepared" : "WebMCP proposal not approved",
      message,
    );
  }

  async function prepareWebMcpApprovalChallenge(selection: WebMcpApprovalSelection) {
    if (webMcpApprovalInFlight.current) return;
    const currentReview = webMcpApprovalReviews[selection.inboxEntryId];
    if (currentReview?.finalOutcomeUnknown) {
      const message = "PaperPilot cannot prepare different evidence while a final approval outcome is unknown. Retry the exact operation first.";
      setWebMcpReviewErrors((current) => ({
        ...current,
        [selection.inboxEntryId]: message,
      }));
      showToast("Exact retry required", message);
      return;
    }
    const resolved = currentWebMcpSelection(selection);
    if (!resolved) {
      clearWebMcpApprovalReview(selection.inboxEntryId);
      reportWebMcpIntentDrift(selection.inboxEntryId, "prepare");
      return;
    }
    const { entry, destination } = resolved;
    clearWebMcpApprovalReview(entry.id);
    webMcpApprovalInFlight.current = entry.id;
    setPreparingWebMcpEntryId(entry.id);
    setWebMcpReviewErrors((current) => {
      const next = { ...current };
      delete next[entry.id];
      return next;
    });

    try {
      const result = await client.prepareWebMcpApprovalChallenge({
        schemaVersion: 1,
        expectedVersion: bootstrap.aggregateVersion,
        inboxEntryId: entry.id,
        proposalDigest: entry.proposalDigest,
        destinationProjectId: destination.id,
        duplicateDecision: selection.duplicateDecision,
      });
      if (!result.ok) {
        if (
          result.code === "version_conflict"
          || result.code === "validation"
          || result.code === "not_found"
          || result.code === "duplicate"
        ) {
          try {
            setBootstrap(await client.bootstrap());
          } catch {
            // Keep the preparation rejection as the primary recovery message.
          }
        }
        setWebMcpReviewErrors((current) => ({
          ...current,
          [entry.id]: result.message,
        }));
        showToast("Authority evidence not prepared", result.message);
        return;
      }
      setWebMcpApprovalReviews((current) => ({
        ...current,
        [entry.id]: {
          challenge: result.data.challenge,
          finalOutcomeUnknown: false,
        },
      }));
      showToast(
        "Authority evidence ready",
        `Review the exact ${result.data.challenge.evidence.authority} snapshot and expiry before giving final consent. No project changed.`,
      );
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "PaperPilot could not independently prepare this authority evidence.";
      setWebMcpReviewErrors((current) => ({ ...current, [entry.id]: message }));
      showToast("Authority evidence unavailable", message);
    } finally {
      if (webMcpApprovalInFlight.current === entry.id) {
        webMcpApprovalInFlight.current = undefined;
        setPreparingWebMcpEntryId(undefined);
      }
    }
  }

  async function approveWebMcpProposal(
    selection: WebMcpApprovalSelection,
    challenge: WebMcpApprovalEvidenceDossier,
  ) {
    if (webMcpApprovalInFlight.current) return;
    const storedReview = webMcpApprovalReviews[selection.inboxEntryId];
    const priorSubmission = webMcpFinalSubmissions.current[selection.inboxEntryId];
    const resolved = currentWebMcpSelection(selection);
    const selectionKey = webMcpApprovalSelectionKey(selection);
    const challengeKey = webMcpApprovalSelectionKey({
      inboxEntryId: challenge.inboxEntryId,
      proposalDigest: challenge.proposalDigest,
      destinationProjectId: challenge.destinationProjectId,
      duplicateDecision: challenge.duplicateDecision,
    });
    const challengeIsCurrent = storedReview?.challenge.challengeId === challenge.challengeId
      && storedReview.challenge.evidence.evidenceDigest === challenge.evidence.evidenceDigest
      && challengeKey === selectionKey;
    const retryingUnknownOutcome = Boolean(
      storedReview?.finalOutcomeUnknown
      && priorSubmission
      && priorSubmission.key === selectionKey,
    );
    if ((!resolved && !retryingUnknownOutcome) || !challengeIsCurrent) {
      if (!storedReview?.finalOutcomeUnknown) clearWebMcpApprovalReview(selection.inboxEntryId);
      reportWebMcpIntentDrift(selection.inboxEntryId, "approve");
      return;
    }
    const entryId = selection.inboxEntryId;
    if (
      !priorSubmission
      && Date.parse(challenge.expiresAt) <= Date.now()
    ) {
      clearWebMcpApprovalReview(entryId);
      showToast(
        "Authority evidence expired",
        "PaperPilot is preparing a fresh independent snapshot. Review it before consenting.",
      );
      await prepareWebMcpApprovalChallenge(selection);
      return;
    }
    if (
      !priorSubmission
      && challenge.expectedVersion !== bootstrap.aggregateVersion
    ) {
      clearWebMcpApprovalReview(entryId);
      showToast(
        "Workspace revision changed",
        "PaperPilot is preparing evidence against the current workspace revision. Review the fresh snapshot before consenting.",
      );
      await prepareWebMcpApprovalChallenge(selection);
      return;
    }

    const submission = priorSubmission?.key === selectionKey
      ? priorSubmission.submission
      : freezeWebMcpApprovalSubmission({
          schemaVersion: 2,
          clientOperationId: crypto.randomUUID(),
          expectedVersion: challenge.expectedVersion,
          inboxEntryId: resolved!.entry.id,
          proposalDigest: resolved!.entry.proposalDigest,
          destinationProjectId: resolved!.destination.id,
          duplicateDecision: selection.duplicateDecision,
          challengeId: challenge.challengeId,
          evidenceDigest: challenge.evidence.evidenceDigest,
        });
    webMcpFinalSubmissions.current[entryId] = { key: selectionKey, submission };
    webMcpApprovalInFlight.current = entryId;
    setApprovingWebMcpEntryId(entryId);
    setWebMcpReviewErrors((current) => {
      const next = { ...current };
      delete next[entryId];
      return next;
    });

    try {
      const result = await client.approveWebMcpProposal(submission);
      if (!result.ok) {
        // A closed failure proves no unknown final response remains. Every
        // retry after this point must start from freshly prepared evidence.
        clearWebMcpApprovalReview(entryId);
        if (
          result.code === "version_conflict"
          || result.code === "validation"
          || result.code === "not_found"
          || result.code === "duplicate"
        ) {
          try {
            setBootstrap(await client.bootstrap());
          } catch {
            // The closed final rejection still proves this attempt did not apply.
          }
        }
        setWebMcpReviewErrors((current) => ({
          ...current,
          [entryId]: result.message,
        }));
        showToast("WebMCP proposal not approved", result.message);
        return;
      }

      clearWebMcpApprovalReview(entryId);
      // Reconcile after an approval because another local or collaborative
      // mutation may have advanced the aggregate while provider verification
      // was in flight. A late response must never roll the browser backward.
      setBootstrap((current) => {
        if (current.aggregateVersion > result.aggregateVersion) return current;
        return {
          ...current,
          aggregateVersion: result.aggregateVersion,
          activeProjectId: result.data.project.id,
          inboxEntries: upsertInboxEntry(current.inboxEntries, result.data.inboxEntry),
          papers: [
            result.data.paper,
            ...current.papers.filter((paper) => paper.id !== result.data.paper.id),
          ],
          projects: [
            result.data.project,
            ...current.projects.filter((project) => project.id !== result.data.project.id),
          ],
        };
      });
      // Do not keep every review form locked on this reconciliation request.
      // It is an eventual authoritative refresh; the version-aware response
      // merge above already prevents rollback if this request is delayed.
      void client.bootstrap().then((refreshed) => {
        setBootstrap((current) => refreshed.aggregateVersion >= current.aggregateVersion
          ? refreshed
          : current);
      }).catch(() => undefined);
      setProjectDetail(undefined);
      setWebMcpReviewErrors((current) => {
        const next = { ...current };
        delete next[entryId];
        return next;
      });
      const verifiedCount = result.data.approval.verifiedIdentifiers.length;
      showToast(
        result.data.usedExistingPaper
          ? "Canonical paper linked"
          : "WebMCP proposal approved",
        `“${result.data.paper.shortTitle}” is now in “${result.data.project.name}”. ${verifiedCount} identifier${verifiedCount === 1 ? " was" : "s were"} independently verified. No PDF bytes or Reader text were added.`,
      );
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "PaperPilot could not complete this digest-bound WebMCP approval.";
      if (
        error instanceof WorkspaceHttpError
        && [400, 401, 403, 404, 409].includes(error.status)
      ) {
        clearWebMcpApprovalReview(entryId);
        if (error.status === 404 || error.status === 409) {
          try {
            setBootstrap(await client.bootstrap());
          } catch {
            // The original closed rejection remains the actionable message.
          }
        }
        setWebMcpReviewErrors((current) => ({ ...current, [entryId]: message }));
        showToast("WebMCP proposal not approved", message);
        return;
      }
      // A missing, malformed, or timed-out response is an unknown outcome.
      // Retain both the exact challenge and the frozen serialized submission;
      // retrying must never mint a replacement challenge or operation ID.
      setWebMcpApprovalReviews((current) => ({
        ...current,
        [entryId]: {
          challenge,
          finalOutcomeUnknown: true,
        },
      }));
      setWebMcpReviewErrors((current) => ({
        ...current,
        [entryId]: message,
      }));
      showToast("WebMCP approval unavailable", message);
    } finally {
      if (webMcpApprovalInFlight.current === entryId) {
        webMcpApprovalInFlight.current = undefined;
        setApprovingWebMcpEntryId(undefined);
      }
    }
  }

  async function linkValidatedDocument(documentId: string, paperId: string) {
    if (linkingDocumentId) return;
    const paper = bootstrap.papers.find((candidate) => candidate.id === paperId);
    const documentEntry = bootstrap.inboxEntries.find((entry) =>
      isDocumentUploadInboxEntry(entry)
        ? entry.upload.documentId === documentId
        : isCrawlerDocumentInboxEntry(entry)
          && entry.crawler.documentId === documentId);
    const isReadyAndUnlinked = documentEntry
      ? isDocumentUploadInboxEntry(documentEntry)
        ? documentEntry.upload.stage === "ready" && !documentEntry.upload.linkedPaperId
        : isCrawlerDocumentInboxEntry(documentEntry)
          && documentEntry.crawler.stage === "ready"
          && !documentEntry.crawler.linkedPaperId
      : false;
    if (
      !paper
      || !documentEntry
      || !isReadyAndUnlinked
    ) {
      showToast(
        "Document not linkable",
        "Refresh the Inbox and choose an unlinked, validated PDF and a visible workspace paper.",
      );
      return;
    }

    setLinkingDocumentId(documentId);
    const clientOperationId = crypto.randomUUID();
    try {
      const result = await client.linkValidatedDocument(documentId, {
        clientOperationId,
        expectedVersion: bootstrap.aggregateVersion,
        paperId,
      });
      if (!result.ok) {
        if (result.code === "version_conflict") await refreshAfterVersionConflict();
        showToast("PDF not linked", result.message);
        return;
      }

      // The command moves the aggregate revision and links to independently
      // processed document state. Read a fresh bootstrap instead of predicting it.
      const refreshed = await client.bootstrap();
      setBootstrap(refreshed);
      setProjectDetail(undefined);
      setReaderPaperId(result.data.paperId);
      showToast(
        result.outcome === "replayed" ? "PDF link restored" : "Validated PDF linked",
        `“${paper.shortTitle}” now owns this document source. Authoritative text extraction will continue in the Inbox.`,
      );
    } catch (cause) {
      showToast(
        "Document link service unavailable",
        cause instanceof Error
          ? cause.message
          : "PaperPilot could not link this validated PDF.",
      );
    } finally {
      setLinkingDocumentId(undefined);
    }
  }

  async function loadMoreReader() {
    if (reader?.state !== "ready" || !reader.nextCursor || !readerPaperId || readerLoadingMore) {
      return;
    }
    const cursor = reader.nextCursor;
    const source = reader;
    const currentGenerationId = source.generation.id;
    const expectedSequence = source.chunks.at(-1)?.sequence;
    if (expectedSequence === undefined) return;
    setReaderLoadingMore(true);
    try {
      const next = await client.getPaperReader(readerPaperId, {
        limit: 50,
        cursor,
        expectedSequence: expectedSequence + 1,
      });
      const merged = appendReaderPage(source, next);
      setReader((current) => {
        if (
          current?.state !== "ready"
          || current.generation.id !== currentGenerationId
          || current.nextCursor !== cursor
        ) {
          return current;
        }
        return merged;
      });
    } catch (cause) {
      if (cause instanceof WorkspaceHttpError && cause.code === "reader_cursor_stale") {
        showToast(
          "Reader source updated",
          "PaperPilot is restarting from the newly authoritative text generation.",
        );
        await loadReader(readerPaperId, { updateHistory: false, reset: true });
        return;
      }
      const retry = cause instanceof WorkspaceHttpError && cause.status === 429
        && cause.retryAfterSeconds
        ? ` Try again in ${cause.retryAfterSeconds} seconds.`
        : "";
      showToast(
        "Next Reader folio unavailable",
        cause instanceof Error
          ? `${cause.message}${retry}`
          : "PaperPilot could not load the next authoritative text page.",
      );
    } finally {
      setReaderLoadingMore(false);
    }
  }

  async function refreshAfterVersionConflict(): Promise<void> {
    const refreshed = await client.bootstrap();
    setBootstrap((current) => (
      refreshed.aggregateVersion < current.aggregateVersion
        ? current
        : refreshed
    ));
    setProjectDetail(undefined);
  }

  function startEvidenceCapture(
    selection: ReaderEvidenceSelectionPreview,
    originElementId: string,
  ) {
    if (
      reader?.state !== "ready"
      || !readerPaper
      || !activeProject
      || !activeProject.paperIds.includes(readerPaper.id)
      || !MUTATING_WORKSPACE_ROLES.has(bootstrap.workspace.role)
    ) {
      showToast(
        "Evidence capture unavailable",
        "Open an attested paper from a project where your workspace role can create evidence.",
      );
      return;
    }
    dispatchEvidenceCapture({
      type: "selection-created",
      operationId: crypto.randomUUID(),
      source: {
        paperId: readerPaper.id,
        documentId: reader.document.id,
        extractionId: reader.generation.id,
        manifestSha256: reader.generation.manifestSha256,
      },
      selection,
      originElementId,
      projectId: activeProject.id,
      collectionId: activeProjectCollections.some(
        (collection) => collection.id === selectedCollectionId,
      ) ? selectedCollectionId : undefined,
    });
  }

  function startEvidenceReanchor(note: EvidenceNote, originElementId: string) {
    const grounding = note.grounding;
    const selection = staleEvidenceSelectionPreview(note);
    if (
      !grounding
      || grounding.state === "current"
      || !note.revision.isLatest
      || !selection
      || !activeProject
      || !activeProject.paperIds.includes(note.paperId)
      || !MUTATING_WORKSPACE_ROLES.has(bootstrap.workspace.role)
    ) {
      showToast(
        "Re-anchor unavailable",
        "Choose the latest grounded evidence revision with a replaced or unavailable source.",
      );
      return;
    }
    dispatchEvidenceCapture({
      type: "reanchor-requested",
      operationId: crypto.randomUUID(),
      predecessorId: note.id,
      predecessorRevisionNumber: note.revision.number,
      predecessorSourceState: grounding.state,
      predecessorStatus: note.status,
      source: {
        paperId: note.paperId,
        documentId: grounding.documentId,
        extractionId: grounding.extractionId,
        manifestSha256: grounding.manifestSha256,
      },
      selection,
      originElementId,
      draft: evidenceRevisionDraft(
        note,
        activeProject.id,
        new Set(activeProjectCollections.map((collection) => collection.id)),
      ),
    });
    void loadReader(note.paperId);
  }

  function dismissEvidenceCapture() {
    if (evidenceCapture.phase === "saving") {
      showToast(
        "Evidence write in progress",
        "PaperPilot cannot safely cancel a write after it reaches the workspace service.",
      );
      return;
    }
    const originElementId = evidenceCapture.phase === "idle"
      ? undefined
      : evidenceCapture.originElementId;
    const returnToEvidence = evidenceCapture.phase !== "idle"
      && evidenceCapture.intent.action === "reanchor";
    dispatchEvidenceCapture({ type: "dismissed" });
    if (returnToEvidence) navigate("notes");
    if (originElementId) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          document.getElementById(originElementId)?.focus({ preventScroll: true });
        });
      });
    }
  }

  function reloadEvidenceCaptureSource() {
    if (evidenceCapture.phase !== "source-changed") return;
    dispatchEvidenceCapture({ type: "reselection-requested" });
    if (readerPaperId) {
      void loadReader(readerPaperId, { updateHistory: false, reset: true });
    }
  }

  async function saveGroundedEvidence(): Promise<void> {
    if (
      evidenceCapture.phase === "idle"
      || evidenceCapture.phase === "saving"
      || evidenceCapture.phase === "source-changed"
      || evidenceCapture.phase === "reselecting"
    ) return;
    const session = evidenceCapture;
    const draft = session.draft;

    if (session.intent.action === "reanchor") {
      const reanchorIntent = session.intent;
      dispatchEvidenceCapture({ type: "save-requested" });
      const predecessor = activeProjectNotes.find(
        (note) => note.id === reanchorIntent.predecessorId,
      );
      if (!predecessor) {
        dispatchEvidenceCapture({
          type: "revision-conflict",
          message: "The predecessor is no longer visible in this evidence chain.",
        });
        return;
      }
      try {
        const result = await client.createEvidenceRevision(
          reanchorIntent.predecessorId,
          {
            clientOperationId: session.operationId,
            expectedVersion: bootstrap.aggregateVersion,
            action: "reanchor",
            selection: captureSelectionPayload(session),
          },
          predecessor,
        );
        if (!result.ok) {
          if (result.code === "selection_conflict") {
            dispatchEvidenceCapture({ type: "source-conflict", message: result.message });
            return;
          }
          if (result.code === "version_conflict") {
            try {
              await refreshAfterVersionConflict();
            } finally {
              dispatchEvidenceCapture({ type: "version-conflict", message: result.message });
            }
            return;
          }
          if (result.code === "revision_conflict") {
            try {
              await refreshAfterVersionConflict();
            } finally {
              dispatchEvidenceCapture({ type: "revision-conflict", message: result.message });
            }
            return;
          }
          dispatchEvidenceCapture({ type: "save-failed", message: result.message });
          return;
        }

        if (evidenceRevisionNeedsRefresh(bootstrap, result.data)) {
          await refreshAfterVersionConflict();
        } else {
          setBootstrap((current) =>
            applyEvidenceNoteRevision(current, result.aggregateVersion, result.data));
          setProjectDetail((current) =>
            current && result.data.linkedProjectIds.includes(current.project.id)
              ? mergeProjectDetail(current, (state) =>
                  applyEvidenceNoteRevision(state, result.aggregateVersion, result.data))
              : current);
        }
        dispatchEvidenceCapture({ type: "save-succeeded" });
        navigate("notes");
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            document.getElementById(`evidence-chain-${result.data.note.revision.rootId}`)?.focus({ preventScroll: true });
          });
        });
        const successor = result.data.note;
        const custodyCopy = successor.grounding?.state === "current"
          ? "cites the current Reader source"
          : successor.grounding?.state === "superseded"
            ? "was saved, but its Reader source has already been updated again"
            : "was saved, but its source anchor is no longer resolvable";
        const lineageCopy = successor.revision.isLatest
          ? `Revision ${successor.revision.number} ${custodyCopy}. Its review state is Captured.`
          : `Revision ${successor.revision.number} was restored; a later immutable revision remains the active head.`;
        showToast(
          result.outcome === "replayed" ? "Re-anchored revision restored" : "Evidence re-anchored",
          lineageCopy,
        );
      } catch (cause) {
        if (cause instanceof WorkspaceHttpError && cause.code === "selection_conflict") {
          dispatchEvidenceCapture({ type: "source-conflict", message: cause.message });
          return;
        }
        if (cause instanceof WorkspaceHttpError && cause.code === "version_conflict") {
          try {
            await refreshAfterVersionConflict();
          } finally {
            dispatchEvidenceCapture({ type: "version-conflict", message: cause.message });
          }
          return;
        }
        if (cause instanceof WorkspaceHttpError && cause.code === "revision_conflict") {
          try {
            await refreshAfterVersionConflict();
          } finally {
            dispatchEvidenceCapture({ type: "revision-conflict", message: cause.message });
          }
          return;
        }
        dispatchEvidenceCapture({
          type: "save-failed",
          message: cause instanceof Error
            ? cause.message
            : "PaperPilot could not create the re-anchored revision.",
        });
      }
      return;
    }

    if (
      !draft.projectId
      || !draft.title.trim()
      || !draft.claim.trim()
      || !draft.interpretation.trim()
    ) {
      dispatchEvidenceCapture({
        type: "save-failed",
        message: "Add a label, supported claim, and interpretation before saving.",
      });
      return;
    }

    dispatchEvidenceCapture({ type: "save-requested" });
    try {
      const result = await client.captureGroundedEvidence(session.source.paperId, {
        clientOperationId: session.operationId,
        expectedVersion: bootstrap.aggregateVersion,
        projectId: draft.projectId,
        collectionIds: draft.collectionId ? [draft.collectionId] : [],
        note: {
          kind: draft.kind,
          title: draft.title.trim(),
          claim: draft.claim.trim(),
          interpretation: draft.interpretation.trim(),
          openQuestion: draft.openQuestion?.trim() || undefined,
          confidence: draft.confidence,
          tags: draft.tags,
        },
        selection: captureSelectionPayload(session),
      });
      if (!result.ok) {
        if (result.code === "selection_conflict") {
          dispatchEvidenceCapture({ type: "source-conflict", message: result.message });
          return;
        }
        if (result.code === "version_conflict") {
          try {
            await refreshAfterVersionConflict();
          } finally {
            dispatchEvidenceCapture({ type: "version-conflict", message: result.message });
          }
          return;
        }
        dispatchEvidenceCapture({ type: "save-failed", message: result.message });
        return;
      }

      setBootstrap((current) =>
        applyCreatedEvidenceNote(current, result.aggregateVersion, result.data));
      setProjectDetail((current) =>
        current && result.data.linkedProjectIds.includes(current.project.id)
          ? mergeProjectDetail(current, (state) =>
              applyCreatedEvidenceNote(state, result.aggregateVersion, result.data))
          : current);
      if (draft.collectionId) setSelectedCollectionId(draft.collectionId);
      dispatchEvidenceCapture({ type: "save-succeeded" });
      window.requestAnimationFrame(() => {
        document.getElementById(session.originElementId)?.focus({ preventScroll: true });
      });
      showToast(
        result.outcome === "replayed" ? "Grounded evidence restored" : "Grounded evidence saved",
        `${result.data.note.title} is linked to the exact admitted source span and project.`,
      );
    } catch (cause) {
      if (cause instanceof WorkspaceHttpError && cause.code === "selection_conflict") {
        dispatchEvidenceCapture({ type: "source-conflict", message: cause.message });
        return;
      }
      if (cause instanceof WorkspaceHttpError && cause.code === "version_conflict") {
        try {
          await refreshAfterVersionConflict();
        } finally {
          dispatchEvidenceCapture({ type: "version-conflict", message: cause.message });
        }
        return;
      }
      dispatchEvidenceCapture({
        type: "save-failed",
        message: cause instanceof Error
          ? cause.message
          : "PaperPilot could not save this grounded evidence.",
      });
    }
  }

  async function reviewEvidenceNote(
    noteId: string,
    operationId: string,
  ): Promise<WorkspaceActionResult & { code?: "revision_conflict" }> {
    const note = activeProjectNotes.find((candidate) => candidate.id === noteId);
    if (
      !canSubmitEvidenceReviewAttempt(note)
      || !MUTATING_WORKSPACE_ROLES.has(bootstrap.workspace.role)
    ) {
      return {
        ok: false,
        message: "This review session no longer has a grounded Captured predecessor or write access.",
      };
    }
    try {
      const result = await client.createEvidenceRevision(note.id, {
        clientOperationId: operationId,
        expectedVersion: bootstrap.aggregateVersion,
        action: "verify",
      }, note);
      if (!result.ok) {
        if (result.code === "version_conflict" || result.code === "revision_conflict") {
          await refreshAfterVersionConflict();
        }
        showToast("Evidence not reviewed", result.message);
        return {
          ok: false,
          message: result.message,
          code: result.code === "revision_conflict" ? "revision_conflict" : undefined,
        };
      }

      if (evidenceRevisionNeedsRefresh(bootstrap, result.data)) {
        await refreshAfterVersionConflict();
      } else {
        setBootstrap((current) =>
          applyEvidenceNoteRevision(current, result.aggregateVersion, result.data));
        setProjectDetail((current) =>
          current && result.data.linkedProjectIds.includes(current.project.id)
            ? mergeProjectDetail(current, (state) =>
                applyEvidenceNoteRevision(state, result.aggregateVersion, result.data))
            : current);
      }
      const message = !result.data.note.revision.isLatest
        ? `Reviewed revision ${result.data.note.revision.number} was restored; a later immutable revision remains active.`
        : result.outcome === "replayed"
          ? `Reviewed revision ${result.data.note.revision.number} was restored from its durable receipt.`
          : `Revision ${result.data.note.revision.number} is reviewed; revision ${note.revision.number} remains preserved.`;
      showToast(result.outcome === "replayed" ? "Reviewed revision restored" : "Evidence marked reviewed", message);
      return { ok: true, message };
    } catch (cause) {
      if (
        cause instanceof WorkspaceHttpError
        && (cause.code === "version_conflict" || cause.code === "revision_conflict")
      ) {
        await refreshAfterVersionConflict();
      }
      const message = cause instanceof Error
        ? cause.message
        : "PaperPilot could not create the reviewed revision.";
      showToast("Evidence not reviewed", message);
      return {
        ok: false,
        message,
        code: cause instanceof WorkspaceHttpError && cause.code === "revision_conflict"
          ? "revision_conflict"
          : undefined,
      };
    }
  }

  async function createCollection(draft: CollectionDraft): Promise<WorkspaceActionResult> {
    if (!activeProject) {
      return { ok: false, message: "Create or select a project before creating a collection." };
    }
    try {
      const result = await client.createCollection({
        clientOperationId: crypto.randomUUID(),
        expectedVersion: bootstrap.aggregateVersion,
        projectId: activeProject.id,
        name: draft.name,
        description: draft.description,
        color: draft.color,
      });
      if (!result.ok) {
        if (result.code === "version_conflict") await refreshAfterVersionConflict();
        showToast("Collection not created", result.message);
        return { ok: false, message: result.message };
      }

      setBootstrap((current) =>
        applyCreatedCollection(current, result.aggregateVersion, result.data));
      setProjectDetail((current) =>
        current?.project.id === result.data.projectId
          ? mergeProjectDetail(current, (state) =>
              applyCreatedCollection(state, result.aggregateVersion, result.data))
          : current);
      setSelectedCollectionId(result.data.collection.id);
      const message = result.outcome === "replayed"
        ? `${result.data.collection.name} was already created; the durable result was restored.`
        : `${result.data.collection.name} is ready for papers and evidence.`;
      showToast("Collection created", message);
      return { ok: true, message };
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "PaperPilot could not create this collection.";
      showToast("Collection service unavailable", message);
      return { ok: false, message };
    }
  }

  async function addPaperToCollection(
    collectionId: string,
    paperId: string,
  ): Promise<WorkspaceActionResult> {
    const paper = activeProjectPapers.find((candidate) => candidate.id === paperId);
    const collection = activeProjectCollections.find((candidate) => candidate.id === collectionId);
    if (!paper || !collection) {
      return {
        ok: false,
        message: "Choose a paper and collection that belong to the active project.",
      };
    }
    try {
      const result = await client.addPaperToCollection({
        clientOperationId: crypto.randomUUID(),
        expectedVersion: bootstrap.aggregateVersion,
        paperId,
        collectionId,
      });
      if (!result.ok) {
        if (result.code === "version_conflict") await refreshAfterVersionConflict();
        showToast("Paper not added", result.message);
        return { ok: false, message: result.message };
      }

      setBootstrap((current) =>
        applyPaperCollectionLink(current, result.aggregateVersion, result.data));
      setProjectDetail((current) =>
        current?.collections.some((item) => item.id === collectionId)
          ? mergeProjectDetail(current, (state) =>
              applyPaperCollectionLink(state, result.aggregateVersion, result.data))
          : current);
      setSelectedCollectionId(collectionId);
      const message = result.outcome === "noop"
        ? `${paper.shortTitle} is already in ${collection.name}.`
        : `${paper.shortTitle} was added to ${collection.name}.`;
      showToast(result.outcome === "noop" ? "Paper already saved" : "Paper added", message);
      return { ok: true, message };
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "PaperPilot could not add this paper to the collection.";
      showToast("Collection service unavailable", message);
      return { ok: false, message };
    }
  }

  async function addStructuredNote(draft: NoteDraft): Promise<WorkspaceActionResult> {
    if (!activeProject) {
      return { ok: false, message: "Create or select a project before saving evidence." };
    }
    const paper = activeProjectPapers.find((candidate) => candidate.id === draft.paperId);
    if (!paper) {
      return { ok: false, message: "Choose a paper filed in the active project." };
    }
    const section = draft.sectionId
      ? getSectionsForPaper(paper.id).find((candidate) => candidate.id === draft.sectionId)
      : undefined;
    const parsedPage = draft.page ? Number(draft.page) : undefined;
    const locator: SourceLocator = {
      paperId: paper.id,
      sectionId: section?.id,
      sectionTitle: section?.title,
      page: parsedPage && Number.isSafeInteger(parsedPage) ? parsedPage : undefined,
      figureLabel: draft.figureLabel.trim() || undefined,
    };
    const evidence = draft.evidence.trim();
    const title = (draft.title.trim() || draft.claim.trim()).slice(0, 200);

    try {
      const result = await client.createEvidenceNote({
        clientOperationId: crypto.randomUUID(),
        expectedVersion: bootstrap.aggregateVersion,
        projectId: activeProject.id,
        note: {
          paperId: paper.id,
          title,
          kind: "interpretation",
          claim: draft.claim.trim(),
          evidence,
          interpretation: draft.interpretation.trim(),
          openQuestion: draft.openQuestion.trim() || undefined,
          confidence: draft.confidence,
          status: "needs-verification",
          provenance: {
            sourceType: "paper",
            sourceId: paper.id,
            sourceTitle: paper.title,
            sourceUrl: paper.sourceUrl,
            providerName: "PaperPilot researcher input",
            retrievedAt: new Date().toISOString(),
            accessMethod: "manual",
            locator,
            excerpt: evidence,
            version: "manual-assertion-v1",
          },
          linkedHighlightIds: [],
          collectionIds: draft.collectionId ? [draft.collectionId] : [],
          tags: ["manual assertion", "needs verification"],
        },
      });
      if (!result.ok) {
        if (result.code === "version_conflict") await refreshAfterVersionConflict();
        showToast("Evidence not saved", result.message);
        return { ok: false, message: result.message };
      }

      setBootstrap((current) =>
        applyCreatedEvidenceNote(current, result.aggregateVersion, result.data));
      setProjectDetail((current) =>
        current && result.data.linkedProjectIds.includes(current.project.id)
          ? mergeProjectDetail(current, (state) =>
              applyCreatedEvidenceNote(state, result.aggregateVersion, result.data))
          : current);
      if (draft.collectionId) setSelectedCollectionId(draft.collectionId);
      const message = draft.collectionId
        ? "The manual assertion was saved, filed in the collection, and marked needs verification."
        : "The manual assertion was saved and marked needs verification.";
      showToast("Evidence note saved", message);
      return { ok: true, message };
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "PaperPilot could not save this evidence note.";
      showToast("Evidence service unavailable", message);
      return { ok: false, message };
    }
  }

  async function fileNoteInCollection(
    noteId: string,
    collectionId: string,
  ): Promise<WorkspaceActionResult> {
    const note = activeProjectNotes.find((candidate) => candidate.id === noteId);
    const collection = activeProjectCollections.find((candidate) => candidate.id === collectionId);
    if (!note || !collection) {
      return {
        ok: false,
        message: "Choose evidence and a collection that belong to the active project.",
      };
    }
    try {
      const result = await client.addNoteToCollection({
        clientOperationId: crypto.randomUUID(),
        expectedVersion: bootstrap.aggregateVersion,
        noteId,
        collectionId,
      });
      if (!result.ok) {
        if (result.code === "version_conflict") await refreshAfterVersionConflict();
        showToast("Evidence not filed", result.message);
        return { ok: false, message: result.message };
      }

      setBootstrap((current) =>
        applyNoteCollectionLink(current, result.aggregateVersion, result.data));
      setProjectDetail((current) =>
        current?.collections.some((item) => item.id === collectionId)
          ? mergeProjectDetail(current, (state) =>
              applyNoteCollectionLink(state, result.aggregateVersion, result.data))
          : current);
      setSelectedCollectionId(collectionId);
      const message = result.outcome === "noop"
        ? `${note.title} is already in ${collection.name}.`
        : `${note.title} was filed in ${collection.name}.`;
      showToast(result.outcome === "noop" ? "Evidence already filed" : "Evidence filed", message);
      return { ok: true, message };
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "PaperPilot could not file this evidence note.";
      showToast("Evidence service unavailable", message);
      return { ok: false, message };
    }
  }

  function explainSourceBoundary(
    paperId: string,
    _locator?: SourceLocator,
    noteId?: string,
  ) {
    const note = noteId
      ? bootstrap.notes.find((candidate) => candidate.id === noteId)
      : undefined;
    if (note?.grounding) {
      if (note.grounding.state !== "current") {
        showToast(
          note.grounding.state === "superseded" ? "Source generation updated" : "Source anchor unavailable",
          "Opening the current admitted Reader. Select the corresponding passage again to create a fresh grounded evidence revision.",
        );
      }
      void loadReader(paperId);
      return;
    }
    showToast(
      "Source verification pending",
      "This note keeps its paper and claimed location, but the live reader opens only after verified document processing confirms the excerpt.",
    );
  }

  async function deleteCrawlerCustody(
    crawlerImportId: string,
    clientOperationId: string,
  ): Promise<WorkspaceActionResult> {
    if (crawlerMutationInFlight.current) {
      return {
        ok: false,
        message: "Another crawler operation is already being checked. Wait for it to finish.",
      };
    }
    if (Object.keys(crawlerSubmissions.current).length > 0 || pendingCrawlerRetry) {
      return {
        ok: false,
        message: "Resolve the preserved crawler request before changing private PDF custody.",
      };
    }
    const currentRequest = crawlerState.requests.find(
      (request) => request.id === crawlerImportId,
    );
    if (!currentRequest) {
      return {
        ok: false,
        message: "Refresh the crawler ledger before changing private PDF custody.",
      };
    }
    // This server-derived bit is the only client authorization signal. The API
    // independently rechecks the actor and live requester relationship.
    if (!currentRequest.canDeleteCustody) {
      return {
        ok: false,
        message: currentRequest.status === "DELETING"
          ? "Private PDF deletion is already scheduled."
          : currentRequest.status === "DELETED"
            ? "Private PDF custody has already been deleted."
            : "You cannot delete private PDF custody for this crawler record.",
      };
    }

    const preserved = Object.values(crawlerDeletionSubmissions.current);
    const preservedForTarget = preserved.find(
      (candidate) => candidate.crawlerImportId === crawlerImportId,
    );
    if (preserved.length > 0 && !preservedForTarget) {
      return {
        ok: false,
        message: "Resolve the preserved private PDF deletion before changing another crawler record.",
      };
    }
    const prior = crawlerDeletionSubmissions.current[clientOperationId]
      ?? preservedForTarget;
    if (prior && prior.crawlerImportId !== crawlerImportId) {
      return {
        ok: false,
        message: "This deletion confirmation belongs to a different crawler record. Refresh and review before trying again.",
      };
    }
    let submission: Readonly<FrozenCrawlerCustodyDeletionSubmission>;
    try {
      submission = prior ?? createCrawlerCustodyDeletionSubmission({
        clientOperationId,
        crawlerImportId,
        expectedVersion: bootstrap.aggregateVersion,
      });
    } catch {
      return {
        ok: false,
        message: "PaperPilot could not create a valid private PDF deletion confirmation.",
      };
    }
    crawlerDeletionSubmissions.current[submission.clientOperationId] = submission;
    if (!persistCrawlerCustodyDeletionRecovery(
      window.sessionStorage,
      initialBootstrap.workspace.id,
      submission,
    )) {
      showToast(
        "Deletion recovery limited to this page",
        "This browser denied session recovery storage. Keep this page open until PaperPilot confirms the deletion operation.",
      );
    }
    crawlerMutationInFlight.current = true;
    cancelCrawlerReads();
    const requestController = new AbortController();
    crawlerMutationAbortController.current = requestController;
    const deadline = window.setTimeout(
      () => requestController.abort(),
      CRAWLER_POST_DEADLINE_MS,
    );
    try {
      const response = await fetch(
        crawlerCustodyDeletionRoute(
          initialBootstrap.workspace.id,
          submission.crawlerImportId,
        ),
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": submission.clientOperationId,
          },
          body: submission.body,
          signal: requestController.signal,
        },
      );
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message = crawlerCustodyApiFailureMessage(
          payload,
          "PaperPilot could not schedule private PDF custody deletion.",
        );
        const definitiveCode = crawlerDefinitiveProblemCode({
          status: response.status,
          payload,
          responseRequestId: response.headers.get("x-request-id"),
          contentType: response.headers.get("content-type"),
          cacheControl: response.headers.get("cache-control"),
        });
        if (!definitiveCode || definitiveCode === "operation_pending") {
          throw new Error(message);
        }
        delete crawlerDeletionSubmissions.current[submission.clientOperationId];
        clearCrawlerCustodyDeletionRecovery(
          window.sessionStorage,
          initialBootstrap.workspace.id,
        );
        if (response.status === 409) {
          void refreshAfterVersionConflict().catch(() => undefined);
        }
        if (crawlerMounted.current) {
          showToast("Private PDF custody unchanged", message);
        }
        return { ok: false, message };
      }

      const result = parseCrawlerCustodyDeletionResponse({
        value: payload,
        httpStatus: response.status,
        submission,
        parseRequest: parseCrawlerRequestSummary,
      });
      cancelCrawlerReads();
      if (crawlerMounted.current) {
        setBootstrap((current) => ({
          ...current,
          aggregateVersion: Math.max(current.aggregateVersion, result.aggregateVersion),
        }));
        setCrawlerState((current) => ({
          ...current,
          requests: [
            result.request,
            ...current.requests.filter((request) => request.id !== result.request.id),
          ],
        }));
      }
      delete crawlerDeletionSubmissions.current[submission.clientOperationId];
      clearCrawlerCustodyDeletionRecovery(
        window.sessionStorage,
        initialBootstrap.workspace.id,
      );

      const completed = result.request.status === "DELETED";
      const message = completed
        ? "Private PDF deletion proof is recorded, Reader access is closed, and retained-byte quota is released. If grounded evidence depends on an extraction, its complete extracted-text generation may remain—including text unrelated to the excerpt—along with minimal custody records."
        : "Private PDF deletion is scheduled and Reader access is closed. Bytes are removed asynchronously; quota releases only after authoritative storage proof.";
      if (crawlerMounted.current) {
        showToast(
          completed ? "Private PDF custody deleted" : "Private PDF deletion scheduled",
          message,
        );
      }
      return { ok: true, message };
    } catch {
      const message = "PaperPilot could not confirm whether private PDF deletion was scheduled. Retry this exact confirmation to check the same operation.";
      if (crawlerMounted.current) showToast("Deletion outcome unknown", message);
      throw new Error(message);
    } finally {
      window.clearTimeout(deadline);
      if (crawlerMutationAbortController.current === requestController) {
        crawlerMutationAbortController.current = undefined;
      }
      crawlerMutationInFlight.current = false;
      if (crawlerMounted.current) {
        void loadCrawlerRequests(false);
      }
    }
  }

  async function submitFrozenCrawlerRequest(
    submission: FrozenCrawlerSubmission,
  ): Promise<WorkspaceActionResult> {
    if (crawlerMutationInFlight.current) {
      return {
        ok: false,
        message: "A crawler request is already being checked. Wait for that operation to finish.",
      };
    }
    crawlerMutationInFlight.current = true;
    cancelCrawlerReads();
    const requestController = new AbortController();
    crawlerMutationAbortController.current = requestController;
    const deadline = window.setTimeout(
      () => requestController.abort(),
      CRAWLER_POST_DEADLINE_MS,
    );

    try {
      const response = await fetch(
        crawlerRequestsRoute(initialBootstrap.workspace.id),
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": submission.clientOperationId,
          },
          body: submission.body,
          signal: requestController.signal,
        },
      );
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message = crawlerApiFailureMessage(
          payload,
          "PaperPilot could not queue this governed crawler request.",
        );
        const definitiveCode = crawlerDefinitiveProblemCode({
          status: response.status,
          payload,
          responseRequestId: response.headers.get("x-request-id"),
          contentType: response.headers.get("content-type"),
          cacheControl: response.headers.get("cache-control"),
        });
        if (!definitiveCode || definitiveCode === "operation_pending") {
          throw new Error(message);
        }

        if (crawlerSubmissions.current[submission.clientOperationId] === submission) {
          delete crawlerSubmissions.current[submission.clientOperationId];
        }
        clearCrawlerRecovery(window.sessionStorage, initialBootstrap.workspace.id);
        if (crawlerMounted.current) {
          setPendingCrawlerRetry((current) => (
            current?.clientOperationId === submission.clientOperationId
              ? undefined
              : current
          ));
          showToast("Crawler request not queued", message);
        }
        if (response.status === 409 && crawlerMounted.current) {
          await Promise.allSettled([
            refreshAfterVersionConflict(),
            loadCrawlerRequests(false),
          ]);
        }
        return { ok: false, message };
      }

      const result = parseCrawlerQueueResponse(payload);
      const minimumAggregateVersion = submission.expectedVersion + 1;
      if (
        !Number.isSafeInteger(minimumAggregateVersion)
        || result.request.clientOperationId !== submission.clientOperationId
        || result.request.displayFileName !== submission.displayFileName
        || result.request.maxBytes !== submission.maxBytes
        || result.request.policyVersion !== submission.policyVersion
        || (result.outcome === "applied"
          ? result.aggregateVersion !== minimumAggregateVersion
          : result.aggregateVersion < minimumAggregateVersion)
      ) {
        throw new Error("PaperPilot received an invalid crawler response.");
      }

      const requestIds = new Set<string>();
      const clientOperationIds = new Set<string>();
      for (const request of crawlerState.requests) {
        if (
          requestIds.has(request.id)
          || clientOperationIds.has(request.clientOperationId)
          || (request.id === result.request.id
            && request.clientOperationId !== result.request.clientOperationId)
          || (request.clientOperationId === result.request.clientOperationId
            && request.id !== result.request.id)
        ) {
          throw new Error("PaperPilot received an invalid crawler response.");
        }
        requestIds.add(request.id);
        clientOperationIds.add(request.clientOperationId);
      }

      cancelCrawlerReads();
      if (crawlerMounted.current) {
        setBootstrap((current) => ({
          ...current,
          aggregateVersion: Math.max(current.aggregateVersion, result.aggregateVersion),
        }));
        setCrawlerState((current) => ({
          status: "ready",
          policy: current.policy ?? submission.policy,
          requests: [
            result.request,
            ...current.requests.filter((request) => (
              request.id !== result.request.id
              && request.clientOperationId !== result.request.clientOperationId
            )),
          ],
        }));
      }
      if (crawlerSubmissions.current[submission.clientOperationId] === submission) {
        delete crawlerSubmissions.current[submission.clientOperationId];
      }
      clearCrawlerRecovery(window.sessionStorage, initialBootstrap.workspace.id);
      if (crawlerMounted.current) {
        setPendingCrawlerRetry((current) => (
          current?.clientOperationId === submission.clientOperationId
            ? undefined
          : current
        ));
      }

      const replayed = result.outcome === "replayed";
      const message = replayed
        ? "The existing governed request was recovered and remains visible in the ledger."
        : "The PDF request is queued for policy, robots, network, and response checks. Nothing was filed into a project.";
      if (crawlerMounted.current) {
        showToast(replayed ? "Crawler request recovered" : "Crawler request queued", message);
      }
      return { ok: true, message };
    } catch {
      if (crawlerMounted.current) {
        setPendingCrawlerRetry({
          clientOperationId: submission.clientOperationId,
          displayFileName: submission.displayFileName,
          policyVersion: submission.policyVersion,
          maxBytes: submission.maxBytes,
        });
      }
      const message = "PaperPilot could not confirm whether this crawler request was queued. Retry to check the exact same operation.";
      if (crawlerMounted.current) showToast("Crawler outcome unknown", message);
      throw new Error(message);
    } finally {
      window.clearTimeout(deadline);
      if (crawlerMutationAbortController.current === requestController) {
        crawlerMutationAbortController.current = undefined;
      }
      crawlerMutationInFlight.current = false;
    }
  }

  async function queueCrawlerRequest(
    input: CrawlerQueueInput,
  ): Promise<WorkspaceActionResult> {
    const priorSubmission = crawlerSubmissions.current[input.clientOperationId];
    if (priorSubmission) return submitFrozenCrawlerRequest(priorSubmission);
    if (Object.keys(crawlerSubmissions.current).length > 0 || pendingCrawlerRetry) {
      return {
        ok: false,
        message: "Resolve the preserved crawler operation before queueing another request.",
      };
    }
    const policy = crawlerState.policy;
    if (!canQueueCrawler) {
      return {
        ok: false,
        message: "Your workspace role cannot queue crawler requests.",
      };
    }
    if (!policy) {
      return {
        ok: false,
        message: "Refresh the crawler ledger and review the active policy before queueing.",
      };
    }

    const displayFileName = input.displayFileName.normalize("NFC");
    const expectedVersion = bootstrap.aggregateVersion;
    const body = JSON.stringify({
      schemaVersion: 1,
      clientOperationId: input.clientOperationId,
      expectedVersion,
      policyVersion: policy.policyVersion,
      sourceUrl: input.sourceUrl,
      displayFileName,
      rightsAttestation: {
        scope: "INDEFINITE_RESEARCH_CUSTODY",
        userDeclared: input.userDeclared,
      },
      robotsMode: "REQUIRE_ALLOW",
      retentionMode: "INDEFINITE_UNTIL_USER_DELETION",
      maxBytes: input.maxBytes,
    });
    const submission: FrozenCrawlerSubmission = Object.freeze({
      body,
      clientOperationId: input.clientOperationId,
      displayFileName,
      expectedVersion,
      maxBytes: input.maxBytes,
      policy: Object.freeze({ ...policy }),
      policyVersion: policy.policyVersion,
    });
    crawlerSubmissions.current[input.clientOperationId] = submission;
    if (!persistCrawlerRecovery(
      window.sessionStorage,
      initialBootstrap.workspace.id,
      submission,
    )) {
      showToast(
        "Crawler recovery limited to this page",
        "This browser denied session recovery storage. Keep this page open until PaperPilot confirms the operation.",
      );
    }
    return submitFrozenCrawlerRequest(submission);
  }

  async function retryPendingCrawlerRequest(): Promise<WorkspaceActionResult> {
    const operationId = pendingCrawlerRetry?.clientOperationId;
    const submission = operationId
      ? crawlerSubmissions.current[operationId]
      : undefined;
    if (!submission) {
      setPendingCrawlerRetry(undefined);
      return {
        ok: false,
        message: "The preserved crawler operation is no longer available. Refresh before starting a new request.",
      };
    }
    return submitFrozenCrawlerRequest(submission);
  }

  async function startZoteroOAuth(
    scopeProfile: ZoteroScopeProfile,
  ): Promise<WorkspaceActionResult> {
    if (!canManageIntegrations) {
      return {
        ok: false,
        message: "Only workspace owners and administrators can connect Zotero.",
      };
    }
    try {
      const response = await fetch(
        zoteroOAuthStartRoute(bootstrap.workspace.id),
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ scopeProfile }),
        },
      );
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message = safeApiProblemMessage(
          payload,
          "PaperPilot could not start the Zotero connection.",
        );
        showToast("Zotero connection not started", message);
        return { ok: false, message };
      }
      const started = parseZoteroOAuthStartResponse(payload, scopeProfile);
      window.location.assign(started.authorizationUrl);
      return {
        ok: true,
        message: "Opening Zotero’s trusted read-only authorization page…",
      };
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "PaperPilot could not start the Zotero connection.";
      showToast("Zotero connection not started", message);
      return { ok: false, message };
    }
  }

  async function discoverZoteroLibraries(
    connectionId: string,
  ): Promise<WorkspaceActionResult> {
    if (!canManageIntegrations) {
      return {
        ok: false,
        message: "Only workspace owners and administrators can refresh Zotero libraries.",
      };
    }
    try {
      const response = await fetch(
        zoteroLibraryDiscoveryRoute(bootstrap.workspace.id, connectionId),
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: "{}",
        },
      );
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message = safeApiProblemMessage(
          payload,
          "PaperPilot could not refresh Zotero libraries.",
        );
        showToast("Zotero libraries not refreshed", message);
        await loadZoteroConnections(false);
        return { ok: false, message };
      }
      const discovered = parseZoteroLibraryDiscoveryResponse(payload);
      const message = discovered.libraries.length === 1
        ? "PaperPilot refreshed 1 credential-free library summary."
        : `PaperPilot refreshed ${discovered.libraries.length} credential-free library summaries.`;
      showToast("Zotero libraries refreshed", message);
      await loadZoteroConnections(false);
      return { ok: true, message };
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "PaperPilot could not refresh Zotero libraries.";
      showToast("Zotero libraries not refreshed", message);
      return { ok: false, message };
    }
  }

  async function saveZoteroLibrarySelection(
    connectionId: string,
    expectedSelectionRevision: number,
    selectedLibraryIds: string[],
    clientOperationId: string,
  ): Promise<WorkspaceActionResult> {
    if (!canManageIntegrations) {
      return {
        ok: false,
        message: "Only workspace owners and administrators can change Zotero library selection.",
      };
    }
    try {
      const response = await fetch(
        zoteroLibrarySelectionRoute(bootstrap.workspace.id, connectionId),
        {
          method: "PUT",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            clientOperationId,
            expectedSelectionRevision,
            selectedLibraryIds,
          }),
        },
      );
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message = safeApiProblemMessage(
          payload,
          "PaperPilot could not save the Zotero library selection.",
        );
        showToast("Zotero selection not saved", message);
        await loadZoteroConnections(false);
        return { ok: false, message };
      }
      const selected = parseZoteroLibrarySelectionResponse(payload);
      const selectedCount = selected.libraries.filter((library) => library.syncEnabled).length;
      const message = selectedCount === 0
        ? "Metadata intake is paused for every library. Existing PaperPilot records remain available."
        : selectedCount === 1
          ? "1 Zotero library is selected for inbound metadata sync."
          : `${selectedCount} Zotero libraries are selected for inbound metadata sync.`;
      showToast("Zotero selection saved", message);
      await loadZoteroConnections(false);
      return { ok: true, message };
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "PaperPilot could not save the Zotero library selection.";
      showToast("Zotero selection not saved", message);
      return { ok: false, message };
    }
  }

  async function syncSelectedZoteroLibraries(
    connectionId: string,
    clientOperationId: string,
  ): Promise<WorkspaceActionResult> {
    if (!canManageIntegrations) {
      return {
        ok: false,
        message: "Only workspace owners and administrators can start Zotero sync.",
      };
    }
    try {
      const response = await fetch(
        zoteroSyncRunsRoute(bootstrap.workspace.id, connectionId),
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ clientOperationId }),
        },
      );
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message = safeApiProblemMessage(
          payload,
          "PaperPilot could not queue Zotero sync.",
        );
        showToast("Zotero sync not queued", message);
        await loadZoteroConnections(false);
        return { ok: false, message };
      }
      const queued = parseZoteroSyncRunsResponse(payload);
      const message = queued.outcome === "coalesced"
        ? "An existing durable sync pass already covers the selected libraries."
        : queued.coalescedCount > 0
          ? `${queued.queuedCount} durable library sync${queued.queuedCount === 1 ? " was" : "s were"} queued; ${queued.coalescedCount} already had an active pass.`
        : queued.queuedCount === 1
          ? "1 durable library sync was queued."
          : `${queued.queuedCount} durable library syncs were queued.`;
      showToast(
        queued.outcome === "coalesced" ? "Zotero sync already queued" : "Zotero sync queued",
        message,
      );
      await loadZoteroConnections(false);
      return { ok: true, message };
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "PaperPilot could not queue Zotero sync.";
      showToast("Zotero sync not queued", message);
      return { ok: false, message };
    }
  }

  async function getZoteroAttachmentPolicy(
    connectionId: string,
  ): Promise<ZoteroAttachmentPolicyUiSummary> {
    const response = await fetch(
      zoteroAttachmentPolicyRoute(bootstrap.workspace.id, connectionId),
      {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(safeApiProblemMessage(
        payload,
        "PaperPilot could not load Zotero attachment settings.",
      ));
    }
    return parseZoteroAttachmentPolicyResponse(payload);
  }

  async function listZoteroAttachments(
    connectionId: string,
    query: {
      after?: string;
      libraryId?: string;
      eligibility?: ZoteroAttachmentEligibility;
      includeDeleted?: boolean;
    },
  ): Promise<ZoteroAttachmentListUiResponse> {
    const response = await fetch(
      zoteroAttachmentsRoute(bootstrap.workspace.id, connectionId, {
        ...query,
        limit: 25,
      }),
      {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(safeApiProblemMessage(
        payload,
        "PaperPilot could not load Zotero stored-PDF records.",
      ));
    }
    return parseZoteroAttachmentListResponse(payload);
  }

  async function setZoteroAttachmentPolicy(
    connectionId: string,
    mode: ZoteroAttachmentPolicyMode,
    expectedRevision: number,
  ): Promise<ZoteroAttachmentPolicyUpdateUiResponse> {
    if (!canManageIntegrations) {
      throw new Error("Only workspace owners and administrators can change Zotero attachment settings.");
    }
    try {
      const response = await fetch(
        zoteroAttachmentPolicyRoute(bootstrap.workspace.id, connectionId),
        {
          method: "PUT",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ mode, expectedRevision }),
        },
      );
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new Error(safeApiProblemMessage(
          payload,
          "PaperPilot could not change Zotero attachment settings.",
        ));
      }
      const result = parseZoteroAttachmentPolicyUpdateResponse(payload);
      showToast(
        result.mode === "MANUAL" ? "Manual PDF imports enabled" : "Zotero PDF imports paused",
        result.mode === "MANUAL"
          ? "Every stored file still requires a separate, explicit import into private quarantine."
          : "No new attachment copy can start; existing PaperPilot documents remain available.",
      );
      return result;
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "PaperPilot could not change Zotero attachment settings.";
      showToast("Zotero attachment settings not changed", message);
      throw new Error(message);
    }
  }

  async function importZoteroAttachment(
    connectionId: string,
    attachment: ZoteroAttachmentUiSummary,
    expectedPolicyRevision: number,
    clientOperationId: string,
  ): Promise<ZoteroAttachmentImportUiResponse> {
    if (!MUTATING_WORKSPACE_ROLES.has(bootstrap.workspace.role)) {
      throw new Error("Your workspace role cannot import Zotero files.");
    }
    if (!attachment.providerMd5) {
      throw new Error("This Zotero attachment has no admitted provider checksum.");
    }
    try {
      const response = await fetch(
        zoteroAttachmentImportsRoute(
          bootstrap.workspace.id,
          connectionId,
          attachment.id,
        ),
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": clientOperationId,
          },
          body: JSON.stringify({
            clientOperationId,
            expectedPolicyRevision,
            sourceVersion: attachment.sourceVersion,
            metadataHash: attachment.metadataHash,
            providerMd5: attachment.providerMd5,
          }),
        },
      );
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new Error(safeApiProblemMessage(
          payload,
          "PaperPilot could not queue this Zotero PDF.",
        ));
      }
      const result = parseZoteroAttachmentImportResponse(payload);
      showToast(
        result.outcome === "coalesced" ? "Zotero PDF already admitted" : "Zotero PDF queued",
        result.outcome === "coalesced"
          ? "The exact Zotero file version already has an active or completed PaperPilot import."
          : "PaperPilot will copy it into private quarantine, verify the checksum, validate it, and prepare Reader text.",
      );
      return result;
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "PaperPilot could not queue this Zotero PDF.";
      showToast("Zotero PDF not queued", message);
      throw new Error(message);
    }
  }

  async function disconnectZotero(
    connectionId: string,
  ): Promise<WorkspaceActionResult> {
    if (!canManageIntegrations) {
      return {
        ok: false,
        message: "Only workspace owners and administrators can disconnect Zotero.",
      };
    }
    try {
      const response = await fetch(
        zoteroDisconnectRoute(bootstrap.workspace.id, connectionId),
        {
          method: "DELETE",
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
        },
      );
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message = safeApiProblemMessage(
          payload,
          "PaperPilot could not disconnect this Zotero account.",
        );
        showToast("Zotero not disconnected", message);
        return { ok: false, message };
      }
      parseZoteroDisconnectResponse(payload);
      const message = "PaperPilot erased its local Zotero credential and stopped inbound access.";
      showToast("Zotero disconnected", message);
      await loadZoteroConnections(true);
      return { ok: true, message };
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "PaperPilot could not disconnect this Zotero account.";
      showToast("Zotero not disconnected", message);
      return { ok: false, message };
    }
  }

  function collaborationOperationId(): string {
    return `collaboration:${window.crypto.randomUUID()}`;
  }

  async function activateWorkspace(workspaceId: string): Promise<void> {
    await collaborationClient.activateWorkspace(workspaceId);
  }

  async function runCollaborationAction(
    actionKey: string,
    successTitle: string,
    successDetail: string,
    command: () => Promise<void>,
  ): Promise<void> {
    if (collaborationActionKey) return;
    setCollaborationActionKey(actionKey);
    setCollaborationError(undefined);
    try {
      await command();
      await loadCollaboration(false);
      showToast(successTitle, successDetail);
    } catch (cause) {
      if (cause instanceof CollaborationHttpError && cause.code === "version_conflict") {
        await loadCollaboration(false);
      }
      setCollaborationError(collaborationFailureMessage(cause));
      throw cause;
    } finally {
      setCollaborationActionKey(null);
    }
  }

  async function switchWorkspace(workspaceId: string): Promise<void> {
    if (collaborationActionKey || workspaceId === collaborators?.workspaceId) return;
    setCollaborationActionKey(`workspace:${workspaceId}`);
    setCollaborationError(undefined);
    try {
      await activateWorkspace(workspaceId);
      window.location.replace("/app#collaboration");
    } catch (cause) {
      setCollaborationError(collaborationFailureMessage(cause));
      setCollaborationActionKey(null);
      throw cause;
    }
  }

  async function decideWorkspaceInvitation(
    invitationId: string,
    decision: "accept" | "reject",
  ): Promise<void> {
    if (collaborationActionKey) return;
    setCollaborationActionKey(`invitation:${invitationId}:${decision}`);
    setCollaborationError(undefined);
    try {
      const result = await collaborationClient.decideInvitation(invitationId, {
        schemaVersion: 1,
        clientOperationId: collaborationOperationId(),
        decision,
      });
      if (decision === "accept" && result.membership) {
        await activateWorkspace(result.membership.workspaceId);
        window.location.replace("/app#collaboration");
        return;
      }
      await loadCollaboration(false);
      showToast(
        "Invitation declined",
        "The invitation was closed without changing workspace access.",
      );
    } catch (cause) {
      await loadCollaboration(false);
      setCollaborationError(collaborationFailureMessage(cause));
      throw cause;
    } finally {
      setCollaborationActionKey(null);
    }
  }

  async function inviteWorkspaceCollaborator(
    email: string,
    role: InvitableWorkspaceRole,
  ): Promise<void> {
    const expectedVersion = collaborators?.aggregateVersion;
    const workspaceId = collaborators?.workspaceId;
    if (expectedVersion === undefined || !workspaceId) return;
    await runCollaborationAction(
      "invite:create",
      "In-app invitation created",
      `${email.trim().toLowerCase()} can answer it after signing in to PaperPilot with that address.`,
      async () => {
        await collaborationClient.invite(workspaceId, {
          schemaVersion: 1,
          clientOperationId: collaborationOperationId(),
          expectedVersion,
          email,
          role,
        });
      },
    );
  }

  async function cancelWorkspaceInvitation(invitationId: string): Promise<void> {
    const expectedVersion = collaborators?.aggregateVersion;
    const workspaceId = collaborators?.workspaceId;
    if (expectedVersion === undefined || !workspaceId) return;
    await runCollaborationAction(
      `invitation:${invitationId}:cancel`,
      "Invitation canceled",
      "The pending in-app invitation was closed and cannot be accepted.",
      async () => {
        await collaborationClient.cancelInvitation(workspaceId, invitationId, {
          schemaVersion: 1,
          clientOperationId: collaborationOperationId(),
          expectedVersion,
        });
      },
    );
  }

  async function changeWorkspaceRole(
    memberId: string,
    role: InvitableWorkspaceRole,
  ): Promise<void> {
    const expectedVersion = collaborators?.aggregateVersion;
    const workspaceId = collaborators?.workspaceId;
    if (expectedVersion === undefined || !workspaceId) return;
    await runCollaborationAction(
      `member:${memberId}:role`,
      "Role updated",
      "The collaborator's authority now matches the revised authorship ledger.",
      async () => {
        await collaborationClient.updateMemberRole(workspaceId, memberId, {
          schemaVersion: 1,
          clientOperationId: collaborationOperationId(),
          expectedVersion,
          role,
        });
      },
    );
  }

  async function removeWorkspaceMember(memberId: string): Promise<void> {
    const expectedVersion = collaborators?.aggregateVersion;
    const workspaceId = collaborators?.workspaceId;
    if (expectedVersion === undefined || !workspaceId) return;
    await runCollaborationAction(
      `member:${memberId}:remove`,
      "Workspace access removed",
      "The collaborator no longer has authority in this workspace; retained audit identity remains intact.",
      async () => {
        await collaborationClient.removeMember(workspaceId, memberId, {
          schemaVersion: 1,
          clientOperationId: collaborationOperationId(),
          expectedVersion,
          confirmation: "REMOVE_MEMBER",
        });
      },
    );
  }

  async function signOut() {
    crawlerMutationAbortController.current?.abort();
    crawlerMutationAbortController.current = undefined;
    crawlerSubmissions.current = {};
    crawlerDeletionSubmissions.current = {};
    setPendingCrawlerRetry(undefined);
    clearCrawlerRecovery(window.sessionStorage, initialBootstrap.workspace.id);
    clearCrawlerCustodyDeletionRecovery(
      window.sessionStorage,
      initialBootstrap.workspace.id,
    );
    await authClient.signOut();
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <>
      <AppShell
        activeProjectName={activeProject?.name ?? "Create a project"}
        activeView={activeView}
        collectionCount={activeProjectCollections.length}
        inboxCount={actionableInboxCount}
        noteCount={activeProjectNoteHeads.length}
        onNavigate={navigate}
        readingProgress={readerProgress}
        workspaceName={bootstrap.workspace.name}
        userInitials={initials(user.name)}
        userLabel={`Signed in as ${user.email}`}
        onSignOut={signOut}
      >
        {activeView === "discover" ? (
          <DiscoverView
            goal={researchGoal}
            initialPapers={[]}
            initialProvider={liveProvider}
            initialNotices={[
              "Authenticated live workspace. Search OpenAlex to begin a source-grounded import.",
            ]}
            onManageSources={() => navigate("sources")}
            onOpenPaper={() => {
              showToast("Reader awaits an imported document", "Save and process a paper before opening its reader.");
            }}
            onSaveHit={saveSearchHit}
            onSearch={searchLiterature}
          />
        ) : null}

        {activeView === "workspace" ? (
          <WorkspaceView
            projects={bootstrap.projects}
            papers={bootstrap.papers}
            notes={bootstrap.notes}
            onCreateProject={() => setShowProjectDialog(true)}
            onOpenProject={(projectId) => {
              setBootstrap((current) => ({ ...current, activeProjectId: projectId }));
              void openProject(projectId);
            }}
            onOpenInbox={() => navigate("inbox")}
          />
        ) : null}

        {activeView === "collaboration" ? (
          <CollaboratorsView
            collaborators={collaborators}
            directory={workspaceDirectory}
            error={collaborationError}
            invitations={receivedInvitations}
            loading={collaborationLoading}
            onAcceptInvitation={(invitationId) => (
              decideWorkspaceInvitation(invitationId, "accept")
            )}
            onCancelInvitation={cancelWorkspaceInvitation}
            onChangeRole={changeWorkspaceRole}
            onInvite={inviteWorkspaceCollaborator}
            onRefresh={async () => {
              if (!await loadCollaboration(true)) {
                throw new Error("One or more collaboration registers could not be refreshed.");
              }
            }}
            onRejectInvitation={(invitationId) => (
              decideWorkspaceInvitation(invitationId, "reject")
            )}
            onRemoveMember={removeWorkspaceMember}
            onSwitchWorkspace={switchWorkspace}
          />
        ) : null}

        {activeView === "inbox" ? (
          <InboxView
            approvingWebMcpEntryId={approvingWebMcpEntryId}
            canApproveWebMcp={MUTATING_WORKSPACE_ROLES.has(bootstrap.workspace.role)}
            canLinkDocuments={MUTATING_WORKSPACE_ROLES.has(bootstrap.workspace.role)}
            entries={bootstrap.inboxEntries}
            filingEntryId={filingEntryId}
            linkingDocumentId={linkingDocumentId}
            papers={bootstrap.papers}
            preparingWebMcpEntryId={preparingWebMcpEntryId}
            projects={bootstrap.projects}
            onChooseProject={fileInboxEntry}
            onApproveWebMcp={approveWebMcpProposal}
            onDiscardWebMcpReview={discardWebMcpApprovalReview}
            onPrepareWebMcp={prepareWebMcpApprovalChallenge}
            onLinkDocument={(documentId, paperId) => {
              void linkValidatedDocument(documentId, paperId);
            }}
            onOpenReader={(paperId) => {
              void loadReader(paperId);
            }}
            onOpenDiscover={() => navigate("discover")}
            onOpenSources={() => navigate("sources")}
            webMcpApprovalReviews={webMcpApprovalReviews}
            webMcpReviewErrors={webMcpReviewErrors}
          />
        ) : null}

        {activeView === "sources" ? (
          <SourcesView
            mode="live"
            crawler={{
              canManage: canQueueCrawler,
              role: bootstrap.workspace.role,
              state: crawlerState,
              pendingRetry: pendingCrawlerRetry,
              onDeleteCustody: deleteCrawlerCustody,
              onQueueRequest: queueCrawlerRequest,
              onRefresh: () => loadCrawlerRequests(true),
              onRetryPending: retryPendingCrawlerRequest,
            }}
            onOpenDiscover={() => navigate("discover")}
            onOpenInbox={() => navigate("inbox")}
            onPreviewSource={(kind) => {
              showToast(
                `${kind === "crawler" ? "Crawler" : kind === "upload" ? "Upload" : "Source"} preview`,
                kind === "crawler"
                  ? "No crawl started. Fetching remains behind source approval, rights review, robots checks, and rate policy."
                  : kind === "upload"
                    ? "Choose a PDF in the secure upload folio. It will remain isolated until validation, explicit paper linking, and authoritative text extraction complete."
                    : "This connection is not available through the preview control.",
              );
            }}
            zotero={{
              canManage: canManageIntegrations,
              role: bootstrap.workspace.role,
              state: zoteroState,
              onDiscoverLibraries: discoverZoteroLibraries,
              onDisconnect: disconnectZotero,
              onGetAttachmentPolicy: getZoteroAttachmentPolicy,
              onImportAttachment: importZoteroAttachment,
              onListAttachments: listZoteroAttachments,
              onRefresh: () => loadZoteroConnections(true),
              onSaveLibrarySelection: saveZoteroLibrarySelection,
              onSetAttachmentPolicy: setZoteroAttachmentPolicy,
              onStartOAuth: startZoteroOAuth,
              onSyncSelected: syncSelectedZoteroLibraries,
            }}
            upload={uploadController}
          />
        ) : null}

        {activeView === "project" && projectDetail ? (
          <ProjectView
            project={projectDetail.project}
            papers={projectDetail.papers}
            notes={latestEvidenceNoteHeads(projectDetail.notes)}
            readerStages={readerStages}
            onAddPapers={() => navigate("discover")}
            onBack={() => navigate("workspace")}
            onOpenPaper={(paperId) => {
              void loadReader(paperId);
            }}
          />
        ) : null}

        {activeView === "reader" ? (
          <LiveReaderView
            canCaptureEvidence={MUTATING_WORKSPACE_ROLES.has(bootstrap.workspace.role)}
            captureState={evidenceCapture}
            collections={activeProject?.paperIds.includes(readerPaper?.id ?? "")
              ? activeProjectCollections
              : []}
            error={readerError}
            evidenceNotes={activeProject?.paperIds.includes(readerPaper?.id ?? "")
              ? activeProjectNoteHeads.filter((note) => note.paperId === readerPaper?.id)
              : []}
            loading={readerLoading}
            loadingMore={readerLoadingMore}
            onBack={() => navigate(activeProject ? "project" : "workspace")}
            onCaptureAction={dispatchEvidenceCapture}
            onCaptureSelection={startEvidenceCapture}
            onDismissCapture={dismissEvidenceCapture}
            onLoadMore={() => {
              void loadMoreReader();
            }}
            onRefresh={() => {
              if (readerPaperId) {
                void loadReader(readerPaperId, { updateHistory: false, reset: false });
              }
            }}
            onReloadCaptureSource={reloadEvidenceCaptureSource}
            onSaveCapture={() => {
              void saveGroundedEvidence();
            }}
            onViewEvidence={() => navigate("notes")}
            paper={readerPaper}
            project={activeProject?.paperIds.includes(readerPaper?.id ?? "")
              ? activeProject
              : undefined}
            reader={reader}
            readerPdfJsEnabled={readerPdfJsEnabled}
            workspaceId={bootstrap.workspace.id}
          />
        ) : null}

        {activeView === "notes" && activeProject ? (
          <NotesView
            collections={activeProjectCollections}
            currentPaperId={currentProjectPaperId}
            mode="live"
            notes={activeProjectNotes}
            onAddNote={addStructuredNote}
            onFileNote={fileNoteInCollection}
            onJumpToSource={explainSourceBoundary}
            onReanchorNote={startEvidenceReanchor}
            onReviewNote={reviewEvidenceNote}
            papers={activeProjectPapers}
          />
        ) : null}

        {activeView === "collections" && activeProject ? (
          <CollectionsView
            collections={activeProjectCollections}
            currentPaperId={currentProjectPaperId}
            mode="live"
            notes={activeProjectNoteHeads}
            onAddPaper={addPaperToCollection}
            onCreateCollection={createCollection}
            onOpenPaper={(paperId) => {
              void loadReader(paperId);
            }}
            papers={activeProjectPapers}
            projectName={activeProject.name}
            readerStages={readerStages}
            selectedCollectionId={activeProjectCollections.some(
              (collection) => collection.id === selectedCollectionId,
            ) ? selectedCollectionId : activeProjectCollections[0]?.id ?? ""}
            setSelectedCollectionId={setSelectedCollectionId}
          />
        ) : null}
      </AppShell>

      {showProjectDialog ? (
        <ProjectCreateDialog
          existingProjectNames={bootstrap.projects.map((project) => project.name)}
          onClose={() => {
            if (!savingProject) setShowProjectDialog(false);
          }}
          onCreate={createProject}
        />
      ) : null}

      {importHit ? (
        <PaperImportDialog
          duplicatePaper={findPaperDuplicate(importHit.paper, bootstrap.papers)}
          hit={importHit}
          isSubmitting={savingImport}
          onClose={() => {
            if (!savingImport) setImportHit(undefined);
          }}
          onConfirm={importSearchHit}
          projects={bootstrap.projects}
        />
      ) : null}

      <ToastRegion messages={toasts} />
    </>
  );
}
