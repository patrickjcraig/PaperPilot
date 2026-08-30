"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Clock,
  Database,
  FileUp,
  Globe2,
  History,
  LibraryBig,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Unplug,
  Users,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  ZoteroConnectionUiSummary,
  ZoteroLibraryUiSummary,
  ZoteroScopeProfile,
  ZoteroSyncErrorCode,
  ZoteroSyncRunUiSummary,
} from "@/lib/integrations";
import type { WorkspaceActionResult } from "./workspace-action";
import {
  FileUploadCard,
  type UploadFileController,
} from "./file-upload-card";
import {
  ZoteroAttachmentRegister,
  type ZoteroAttachmentRegisterController,
} from "./zotero-attachment-register";

type PreviewSourceKind = "zotero" | "crawler" | "upload";

export type ZoteroSourceState =
  | { status: "idle" | "loading"; connections: ZoteroConnectionUiSummary[] }
  | { status: "ready"; connections: ZoteroConnectionUiSummary[] }
  | { status: "error"; connections: ZoteroConnectionUiSummary[]; message: string };

export type ZoteroSourceController = ZoteroAttachmentRegisterController & {
  canManage: boolean;
  role: string;
  state: ZoteroSourceState;
  onDiscoverLibraries: (connectionId: string) => Promise<WorkspaceActionResult>;
  onDisconnect: (connectionId: string) => Promise<WorkspaceActionResult>;
  onRefresh: () => Promise<void>;
  onSaveLibrarySelection: (
    connectionId: string,
    expectedSelectionRevision: number,
    selectedLibraryIds: string[],
    clientOperationId: string,
  ) => Promise<WorkspaceActionResult>;
  onStartOAuth: (scopeProfile: ZoteroScopeProfile) => Promise<WorkspaceActionResult>;
  onSyncSelected: (
    connectionId: string,
    clientOperationId: string,
  ) => Promise<WorkspaceActionResult>;
};

export type CrawlerRequestStatus =
  | "QUEUED"
  | "FETCHING"
  | "QUARANTINED"
  | "VALIDATING"
  | "EXTRACTING"
  | "READY"
  | "ATTENTION"
  | "FAILED"
  | "CANCELLED"
  | "DELETING"
  | "DELETED";

export type CrawlerSafeFailureCode =
  | "crawler_request_invalid"
  | "crawler_url_invalid"
  | "crawler_policy_denied"
  | "crawler_dns_rejected"
  | "crawler_robots_denied"
  | "crawler_redirect_rejected"
  | "crawler_bad_response"
  | "crawler_response_too_large"
  | "crawler_timeout"
  | "crawler_cancelled"
  | "crawler_unavailable"
  | "content_length_mismatch"
  | "invalid_pdf_envelope"
  | "pdf_trailing_data"
  | "upload_too_large"
  | "upload_timed_out"
  | "storage_unavailable"
  | "storage_finalize_failed"
  | "malware_detected"
  | "pdf_invalid"
  | "pdf_policy_violation"
  | "pdf_resource_limit_exceeded"
  | "malware_and_pdf_invalid"
  | "extraction_unavailable"
  | "extraction_failed"
  | "crawler_custody_deletion_retrying"
  | "cancelled"
  | "internal_error";

/** Public crawler ledger row: deliberately no URL, digest, job, asset, or document IDs. */
export interface CrawlerRequestSummary {
  id: string;
  clientOperationId: string;
  canDeleteCustody: boolean;
  displayFileName: string;
  status: CrawlerRequestStatus;
  policyVersion: string;
  maxBytes: number;
  receivedBytes: number | null;
  failureCode: CrawlerSafeFailureCode | null;
  retryAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CrawlerPolicySummary {
  acquisitionMode: "EXPLICIT_SINGLE_QUERY_FREE_HTTPS_PDF_V1";
  policyVersion: string;
  rightsAttestation: "INDEFINITE_RESEARCH_CUSTODY";
  robotsMode: "REQUIRE_ALLOW";
  retentionMode: "INDEFINITE_UNTIL_USER_DELETION";
  maxResponseBytes: number;
  maxRedirects: 0;
}

export type CrawlerSourceState =
  | {
    status: "idle" | "loading";
    policy?: CrawlerPolicySummary;
    requests: CrawlerRequestSummary[];
  }
  | {
    status: "ready";
    policy: CrawlerPolicySummary;
    requests: CrawlerRequestSummary[];
  }
  | {
    status: "error";
    policy?: CrawlerPolicySummary;
    requests: CrawlerRequestSummary[];
    message: string;
  };

export interface CrawlerQueueInput {
  clientOperationId: string;
  sourceUrl: string;
  displayFileName: string;
  maxBytes: number;
  userDeclared: true;
}

export interface CrawlerPendingRetrySummary {
  clientOperationId: string;
  displayFileName: string;
  policyVersion: string;
  maxBytes: number;
}

export interface CrawlerSourceController {
  canManage: boolean;
  role: string;
  state: CrawlerSourceState;
  pendingRetry?: Readonly<CrawlerPendingRetrySummary>;
  onDeleteCustody: (
    crawlerImportId: string,
    clientOperationId: string,
  ) => Promise<WorkspaceActionResult>;
  onQueueRequest: (input: CrawlerQueueInput) => Promise<WorkspaceActionResult>;
  onRefresh: () => Promise<void>;
  onRetryPending: () => Promise<WorkspaceActionResult>;
}

type SourcesViewProps = {
  mode?: "demo" | "live";
  onOpenDiscover: () => void;
  onOpenInbox: () => void;
  onPreviewSource: (kind: PreviewSourceKind) => void;
  crawler?: CrawlerSourceController;
  zotero?: ZoteroSourceController;
  upload?: UploadFileController;
};

type SourceCard = {
  id: "openalex" | "zotero" | "crawler" | "upload" | "webmcp";
  title: string;
  description: string;
  detail: string;
  status: "live" | "preview" | "upcoming";
  statusLabel: string;
  icon: LucideIcon;
  actionLabel?: string;
  previewKind?: PreviewSourceKind;
};

const sourceCards: SourceCard[] = [
  {
    id: "openalex",
    title: "OpenAlex scholarly search",
    description: "Search works, authors, venues, concepts, and citation metadata through PaperPilot's live discovery gateway.",
    detail: "Live metadata gateway · results still pass through the Research Inbox before project filing.",
    status: "live",
    statusLabel: "Live gateway",
    icon: Search,
    actionLabel: "Search OpenAlex",
  },
  {
    id: "zotero",
    title: "Zotero",
    description: "Preview personal and group library intake with explicit read-only scopes.",
    detail: "The browser demo does not contact Zotero or retain an OAuth connection.",
    status: "preview",
    statusLabel: "Demo preview",
    icon: LibraryBig,
    actionLabel: "Preview Zotero import",
    previewKind: "zotero",
  },
  {
    id: "crawler",
    title: "Governed scholarly crawler",
    description: "Preview a monitored repository, journal, or research-group source with explicit scope, rate, and rights policy.",
    detail: "Fetching is upcoming and never starts from this preview. Every source requires policy approval.",
    status: "preview",
    statusLabel: "Policy preview",
    icon: Globe2,
    actionLabel: "Preview crawler policy",
    previewKind: "crawler",
  },
  {
    id: "upload",
    title: "Files and identifiers",
    description: "Preview imports for PDF, DOI, PMID, arXiv, URL, BibTeX, RIS, and CSL-JSON records.",
    detail: "Secure file storage and parsing are upcoming; the current preview does not upload a file.",
    status: "preview",
    statusLabel: "Preview only",
    icon: FileUp,
    actionLabel: "Preview file import",
    previewKind: "upload",
  },
  {
    id: "webmcp",
    title: "Browser and WebMCP capture",
    description: "Stage a paper from its page or let an authenticated assistant prepare an import for user review.",
    detail: "Upcoming control surface. It depends on authenticated tools and a separate secure byte-upload path.",
    status: "upcoming",
    statusLabel: "Upcoming",
    icon: Bot,
  },
];

const scopeDescriptions: Record<ZoteroScopeProfile, string> = {
  personal_metadata: "Personal library metadata. Zotero also grants stored-file retrieval with personal-library access, but PaperPilot downloads nothing until you explicitly import an attachment. Notes, groups, and writes stay out of scope.",
  personal_metadata_notes: "Personal library metadata and Zotero note records. Stored PDFs remain opt-in per attachment inside PaperPilot; groups and writes stay out of scope.",
  personal_group_metadata: "Personal and group library metadata. Stored PDFs remain opt-in per attachment inside PaperPilot; notes and writes stay out of scope.",
  personal_group_metadata_notes: "Personal and group metadata plus Zotero note records. Stored PDFs remain opt-in per attachment inside PaperPilot; writes stay out of scope.",
};

function connectionStatus(connection: ZoteroConnectionUiSummary): {
  className: string;
  label: string;
} {
  if (connection.status === "CONNECTED") {
    return { className: "source-status-live", label: "Connected" };
  }
  if (connection.status === "PENDING") {
    return { className: "source-status-preview", label: "Verifying" };
  }
  if (connection.status === "DEGRADED") {
    return { className: "source-status-preview", label: "Needs attention" };
  }
  if (connection.status === "REVOKED") {
    return { className: "source-status-upcoming", label: "Revoked" };
  }
  return { className: "source-status-upcoming", label: "Disconnected" };
}

const activeRunStatuses = new Set(["QUEUED", "RUNNING", "BACKING_OFF"]);
const usableDegradedAttentionCodes = new Set([
  "remote_revocation_pending",
  "remote_revocation_unconfirmed",
  "previous_key_revocation_pending",
  "previous_key_revocation_unconfirmed",
  "zotero_unavailable",
]);

function attentionCopy(connection: ZoteroConnectionUiSummary): string | undefined {
  switch (connection.attentionCode) {
    case "remote_revocation_pending":
    case "previous_key_revocation_pending":
      return "Metadata access remains available, but PaperPilot is still confirming cleanup of an older Zotero key.";
    case "remote_revocation_unconfirmed":
    case "previous_key_revocation_unconfirmed":
      return "Metadata access remains available. An administrator should verify that the older Zotero key was removed.";
    case "zotero_authentication_failed":
      return "Zotero no longer accepts this connection. Connect Zotero again before refreshing libraries or syncing.";
    case "zotero_forbidden":
      return "This connection can no longer read one or more libraries. Review access in Zotero, then refresh libraries.";
    case "zotero_credential_unavailable":
      return "PaperPilot cannot open the protected Zotero credential. An administrator needs to reconnect this account.";
    case "zotero_unavailable":
      return "Zotero could not be reached during the latest check. Existing PaperPilot records remain available.";
    default:
      return undefined;
  }
}

function syncErrorCopy(errorCode: ZoteroSyncErrorCode | null): string | undefined {
  switch (errorCode) {
    case "zotero_authentication_failed":
    case "zotero_credential_unavailable":
      return "Authorization must be restored before this library can sync.";
    case "zotero_forbidden":
      return "Zotero no longer permits this library to be read.";
    case "zotero_rate_limited":
      return "Zotero asked PaperPilot to wait before another request.";
    case "zotero_timeout":
    case "zotero_unavailable":
      return "Zotero was temporarily unavailable. The committed cursor was not advanced.";
    case "zotero_bad_response":
      return "Zotero returned a response PaperPilot could not safely admit.";
    case "zotero_sync_resource_limit":
      return "This library changed more metadata than one safe sync pass can admit. Automatic retries are paused; an administrator can retry after reducing or partitioning the source.";
    case "stable_version_changed":
      return "The library changed during this pass. PaperPilot will restart from the last committed cursor.";
    case "zotero_invalid_request":
    case "zotero_not_found":
      return "This library could not be read with the current connection.";
    case "internal_error":
      return "The sync did not complete. The committed cursor was not advanced.";
    default:
      return undefined;
  }
}

function runStatus(run: ZoteroSyncRunUiSummary | null): {
  className: string;
  label: string;
} {
  if (!run) return { className: "zotero-run-idle", label: "Never synced" };
  if (run.status === "SUCCEEDED") {
    return { className: "zotero-run-success", label: "Sync complete" };
  }
  if (run.status === "QUEUED") {
    return { className: "zotero-run-active", label: "Queued" };
  }
  if (run.status === "RUNNING") {
    return { className: "zotero-run-active", label: "Syncing" };
  }
  if (run.status === "BACKING_OFF") {
    return { className: "zotero-run-waiting", label: "Waiting for Zotero" };
  }
  if (run.status === "PARTIAL") {
    return { className: "zotero-run-waiting", label: "Incomplete" };
  }
  if (run.status === "FAILED") {
    return { className: "zotero-run-error", label: "Sync failed" };
  }
  return { className: "zotero-run-idle", label: "Cancelled" };
}

function isConnectionUsable(connection: ZoteroConnectionUiSummary): boolean {
  return connection.status === "CONNECTED"
    || (connection.status === "DEGRADED"
      && connection.attentionCode !== null
      && usableDegradedAttentionCodes.has(connection.attentionCode));
}

function isConnectionConfigurable(connection: ZoteroConnectionUiSummary): boolean {
  return connection.status === "CONNECTED" || connection.status === "DEGRADED";
}

function newOperationId(): string {
  return window.crypto.randomUUID();
}

function dateLabel(value: string | null): string {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function crawlerBytes(value: number): string {
  if (value < 1_024) return `${value.toLocaleString()} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function crawlerStatusPresentation(status: CrawlerRequestStatus): {
  label: string;
  tone: "active" | "custody" | "ready" | "failed" | "deleting" | "deleted";
} {
  switch (status) {
    case "QUEUED": return { label: "Queued", tone: "active" };
    case "FETCHING": return { label: "Fetching", tone: "active" };
    case "QUARANTINED": return { label: "Quarantined", tone: "custody" };
    case "VALIDATING": return { label: "Validating", tone: "custody" };
    case "EXTRACTING": return { label: "Extracting", tone: "custody" };
    case "READY": return { label: "Ready", tone: "ready" };
    case "ATTENTION": return { label: "Needs attention", tone: "custody" };
    case "FAILED": return { label: "Failed", tone: "failed" };
    case "CANCELLED": return { label: "Cancelled", tone: "failed" };
    case "DELETING": return { label: "Private PDF deletion scheduled", tone: "deleting" };
    case "DELETED": return { label: "Private PDF custody deleted", tone: "deleted" };
  }
}

function crawlerFailureCopy(code: CrawlerSafeFailureCode): string {
  switch (code) {
    case "crawler_request_invalid":
    case "crawler_url_invalid":
      return "The request no longer matches the governed crawler contract.";
    case "crawler_policy_denied":
      return "The reviewed source policy does not admit this PDF.";
    case "crawler_dns_rejected":
      return "The source did not resolve exclusively to eligible public addresses.";
    case "crawler_robots_denied":
      return "The source’s robots policy does not allow retrieval.";
    case "crawler_redirect_rejected":
      return "A redirect left the reviewed source boundary or failed revalidation.";
    case "crawler_bad_response":
      return "The source did not return an eligible PDF response.";
    case "crawler_response_too_large":
      return "The response exceeded the admitted byte limit.";
    case "crawler_timeout":
      return "The bounded acquisition deadline elapsed.";
    case "crawler_cancelled":
      return "The acquisition was cancelled before custody transfer completed.";
    case "crawler_unavailable":
      return "The source was temporarily unavailable.";
    case "content_length_mismatch":
      return "The source response length did not match the bytes received.";
    case "invalid_pdf_envelope":
    case "pdf_invalid":
      return "The quarantined bytes were not an eligible PDF.";
    case "pdf_trailing_data":
      return "The PDF contained unsupported data after its final trailer.";
    case "upload_too_large":
      return "The transfer exceeded the admitted upload limit.";
    case "upload_timed_out":
      return "The private quarantine transfer did not finish in time.";
    case "storage_unavailable":
    case "storage_finalize_failed":
      return "Private quarantine storage could not complete custody transfer.";
    case "malware_detected":
    case "malware_and_pdf_invalid":
      return "The quarantined file did not pass malware screening.";
    case "pdf_policy_violation":
      return "The PDF violated the workspace validation policy.";
    case "pdf_resource_limit_exceeded":
      return "The PDF exceeded a bounded validation resource limit.";
    case "extraction_unavailable":
      return "The extraction service is temporarily unavailable.";
    case "extraction_failed":
      return "Text extraction could not complete from the validated file.";
    case "crawler_custody_deletion_retrying":
      return "Physical cleanup did not finish in the latest pass. PaperPilot will retry without restoring Reader access.";
    case "cancelled":
      return "The custody lifecycle was cancelled before completion.";
    case "internal_error":
      return "PaperPilot could not complete this acquisition safely.";
  }
}

function hasUnpairedFilenameSurrogate(value: string): boolean {
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

function crawlerDraftError(
  sourceUrl: string,
  displayFileName: string,
  rawMaxBytes: string,
  policy: CrawlerPolicySummary | undefined,
): string | undefined {
  if (!policy) return "Wait for the crawler policy to load.";
  if (!sourceUrl || sourceUrl !== sourceUrl.trim()) {
    return "Enter one absolute HTTPS PDF URL without surrounding spaces.";
  }
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return "Enter one absolute HTTPS PDF URL.";
  }
  if (parsed.protocol !== "https:") return "The source must use HTTPS.";
  if (parsed.username || parsed.password) return "Credentials are not allowed in the source URL.";
  if (sourceUrl.includes("?")) return "Queries are not allowed in the source URL.";
  if (sourceUrl.includes("#")) return "Fragments are not allowed in the source URL.";
  if (parsed.port !== "") return "The source must use HTTPS port 443.";
  if (!parsed.pathname.toLowerCase().endsWith(".pdf")) {
    return "The source URL path must end in .pdf.";
  }
  if (hasUnpairedFilenameSurrogate(displayFileName)) {
    return "Use a display filename ending in .pdf without path or control characters.";
  }
  const normalizedName = displayFileName.normalize("NFC");
  const firstComponent = normalizedName.split(".", 1)[0].replace(/[ .]+$/g, "");
  if (
    !normalizedName
    || normalizedName !== normalizedName.trim()
    || !normalizedName.toLowerCase().endsWith(".pdf")
    || /[<>:"/\\|?*\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(normalizedName)
    || /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(normalizedName)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(firstComponent)
    || new TextEncoder().encode(normalizedName).byteLength > 255
  ) {
    return "Use a display filename ending in .pdf without path or control characters.";
  }
  const maxBytes = Number(rawMaxBytes);
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes < 1
    || maxBytes > policy.maxResponseBytes
  ) {
    return `Set a whole-byte cap from 1 to ${policy.maxResponseBytes.toLocaleString()}.`;
  }
  return undefined;
}

function workspaceRoleLabel(role: string): string {
  if (role === "member") return "workspace member";
  if (role === "viewer") return "workspace viewer";
  return "workspace member";
}

function libraryName(library: ZoteroLibraryUiSummary): string {
  return library.name ?? (library.type === "USER" ? "My Library" : "Unnamed Zotero group");
}

function fileAccessCopy(library: ZoteroLibraryUiSummary): string {
  if (library.fileAccessStatus === "AVAILABLE") return "File access available";
  if (library.fileAccessStatus === "UNAVAILABLE") return "File access unavailable";
  return "File access unknown · Checked when you import";
}

function ZoteroRunLedger({
  library,
}: {
  library: ZoteroLibraryUiSummary;
}) {
  const run = library.lastSyncRun;
  if (!run) return null;
  const error = syncErrorCopy(run.errorCode);
  return (
    <details className="zotero-run-ledger">
      <summary>
        <span><History size={12} aria-hidden="true" /> Latest sync ledger</span>
        <span>{run.id}</span>
      </summary>
      <div className="zotero-run-ledger-grid">
        <div><span>Observed</span><strong>{run.objectsRead}</strong></div>
        <div><span>Source records updated</span><strong>{run.objectsWritten}</strong></div>
        <div><span>Tombstoned</span><strong>{run.objectsDeleted}</strong></div>
        <div>
          <span>Committed version</span>
          <strong>{run.status === "SUCCEEDED" ? (run.toVersion ?? "Not reported") : "Not advanced"}</strong>
        </div>
      </div>
      <p className="zotero-run-ledger-time">
        {run.completedAt
          ? `Completed ${dateLabel(run.completedAt)}`
          : run.startedAt
            ? `Started ${dateLabel(run.startedAt)}`
            : "Waiting to start"}
        {run.backoffUntil ? ` · Resume no earlier than ${dateLabel(run.backoffUntil)}` : ""}
      </p>
      {error ? <p className="zotero-run-ledger-error">{error}</p> : null}
    </details>
  );
}

type ZoteroFolioAction = "discover" | "disconnect" | "save" | "sync";

function ZoteroConnectionFolio({
  connection,
  controller,
  onOpenInbox,
}: {
  connection: ZoteroConnectionUiSummary;
  controller: ZoteroSourceController;
  onOpenInbox: () => void;
}) {
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>(() =>
    connection.libraries.filter((library) => library.syncEnabled).map((library) => library.id));
  const [working, setWorking] = useState<ZoteroFolioAction>();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [selectionOperationId, setSelectionOperationId] = useState<string>();
  const [syncOperationId, setSyncOperationId] = useState<string>();
  const [feedback, setFeedback] = useState<{
    tone: "error" | "success";
    message: string;
  }>();
  const [clock, setClock] = useState(() => Date.now());
  const disconnectTriggerRef = useRef<HTMLButtonElement>(null);
  const disconnectCancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!connection.providerBackoffUntil) return;
    const remaining = Date.parse(connection.providerBackoffUntil) - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(
      () => setClock(Date.now()),
      Math.min(remaining + 50, 2_147_000_000),
    );
    return () => window.clearTimeout(timer);
  }, [clock, connection.providerBackoffUntil]);

  useEffect(() => {
    if (confirmDisconnect) disconnectCancelRef.current?.focus();
  }, [confirmDisconnect]);

  const selected = useMemo(() => new Set(selectedLibraryIds), [selectedLibraryIds]);
  const persistedSelection = useMemo(
    () => new Set(connection.libraries.filter((library) => library.syncEnabled).map((library) => library.id)),
    [connection.libraries],
  );
  const selectionDirty = selected.size !== persistedSelection.size
    || [...selected].some((id) => !persistedSelection.has(id));
  const readableLibraries = connection.libraries.filter((library) => library.isReadable);
  const selectedReadableCount = readableLibraries.filter((library) => selected.has(library.id)).length;
  const selectedUnreadableCount = connection.libraries.filter(
    (library) => !library.isReadable && selected.has(library.id),
  ).length;
  const hasActiveRun = connection.libraries.some((library) =>
    library.lastSyncRun && activeRunStatuses.has(library.lastSyncRun.status));
  const providerBackoffActive = connection.providerBackoffUntil !== null
    && Date.parse(connection.providerBackoffUntil) > clock;
  const usable = isConnectionUsable(connection);
  const configurable = isConnectionConfigurable(connection);
  const canConfigure = controller.canManage && configurable && working === undefined;
  const canDiscover = canConfigure
    && connection.attentionCode !== "zotero_authentication_failed"
    && connection.attentionCode !== "zotero_credential_unavailable"
    && !providerBackoffActive;
  const canReachProvider = controller.canManage
    && usable
    && working === undefined
    && !providerBackoffActive;
  const status = connectionStatus(connection);
  const attention = attentionCopy(connection)
    ?? (connection.status === "DEGRADED"
      ? "Metadata sync is paused. Refresh libraries to verify the connection before trying again."
      : connection.status === "REVOKED"
        ? "Zotero authorization has ended. Connect Zotero again to resume inbound metadata access."
        : undefined);

  function toggleLibrary(library: ZoteroLibraryUiSummary, checked: boolean) {
    if (!canConfigure || (!library.isReadable && checked)) return;
    setSelectedLibraryIds((current) => checked
      ? Array.from(new Set([...current, library.id]))
      : current.filter((id) => id !== library.id));
    setSelectionOperationId(undefined);
    setFeedback(undefined);
  }

  async function runAction(
    action: ZoteroFolioAction,
    task: () => Promise<WorkspaceActionResult>,
  ) {
    if (working) return;
    setWorking(action);
    setFeedback(undefined);
    try {
      const result = await task();
      setFeedback({ tone: result.ok ? "success" : "error", message: result.message });
      if (result.ok && action === "disconnect") setConfirmDisconnect(false);
      if (result.ok && action === "save") setSelectionOperationId(undefined);
      if (result.ok && action === "sync") setSyncOperationId(undefined);
    } catch (cause) {
      setFeedback({
        tone: "error",
        message: cause instanceof Error
          ? cause.message
          : "PaperPilot could not complete this Zotero action.",
      });
    } finally {
      setWorking(undefined);
    }
  }

  function saveSelection() {
    if (!canConfigure || !selectionDirty || selectedUnreadableCount > 0) return;
    const operationId = selectionOperationId ?? newOperationId();
    setSelectionOperationId(operationId);
    void runAction("save", () => controller.onSaveLibrarySelection(
      connection.id,
      connection.selectionRevision,
      [...selected].sort(),
      operationId,
    ));
  }

  function syncSelected() {
    if (!canReachProvider || selectedReadableCount === 0 || hasActiveRun) return;
    const operationId = syncOperationId ?? newOperationId();
    setSyncOperationId(operationId);
    void runAction("sync", () => controller.onSyncSelected(connection.id, operationId));
  }

  return (
    <section
      className={`zotero-connection zotero-connection-${connection.status.toLowerCase()}`}
      aria-labelledby={`zotero-connection-${connection.id}`}
    >
      <header className="zotero-connection-head">
        <div>
          <span className="micro-label">Zotero account folio</span>
          <h3 id={`zotero-connection-${connection.id}`}>
            {connection.displayName ?? "Zotero library account"}
          </h3>
        </div>
        <span className={`status-chip ${status.className}`}>{status.label}</span>
      </header>

      <div className="zotero-custody-spine" aria-label="Connection custody summary">
        <div>
          <span>Authorization</span>
          <strong>{connection.lastVerifiedAt ? dateLabel(connection.lastVerifiedAt) : "Not verified"}</strong>
        </div>
        <div>
          <span>Library selection</span>
          <strong>
            {connection.librariesConfiguredAt
              ? `${connection.libraries.filter((library) => library.syncEnabled).length} selected`
              : "Selection required"}
          </strong>
        </div>
        <div>
          <span>Latest complete sync</span>
          <strong>{dateLabel(
            connection.libraries
              .map((library) => library.lastSyncedAt)
              .filter((value): value is string => value !== null)
              .sort()
              .at(-1) ?? null,
          )}</strong>
        </div>
      </div>

      <div className="zotero-capability-row" aria-label="Authorized Zotero capabilities">
        {connection.capabilities.personalLibrary ? <span>Personal metadata</span> : null}
        {connection.capabilities.groupLibraries ? <span>Group metadata</span> : null}
        {connection.capabilities.notes ? <span>Notes authorized</span> : <span>Notes excluded</span>}
        {connection.capabilities.files
          ? <span className="warning">File access reported; every import stays explicit</span>
          : <span>File access is checked per library</span>}
        <span>Writes excluded</span>
      </div>

      {attention ? (
        <div className="zotero-connection-attention" role="note">
          <AlertTriangle size={15} aria-hidden="true" />
          <span><strong>Connection needs attention.</strong> {attention}</span>
        </div>
      ) : null}

      {providerBackoffActive ? (
        <div className="zotero-provider-backoff" role="status">
          <Clock size={15} aria-hidden="true" />
          <span>
            <strong>Zotero requested a pause.</strong> Sync and library discovery resume after{" "}
            <time dateTime={connection.providerBackoffUntil ?? undefined}>
              {dateLabel(connection.providerBackoffUntil)}
            </time>.
          </span>
        </div>
      ) : null}

      {!connection.librariesConfiguredAt && configurable ? (
        <div className="zotero-selection-required" role="note">
          <Database size={15} aria-hidden="true" />
          <span>
            <strong>Choose what enters PaperPilot.</strong> Connecting Zotero did not import anything. Selected libraries stage changed metadata in the Research Inbox; they never file papers into a project automatically.
          </span>
        </div>
      ) : null}

      {feedback ? (
        <div
          className={`workspace-action-feedback zotero-action-feedback ${feedback.tone}`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </div>
      ) : null}

      <fieldset className="zotero-library-fieldset" disabled={working !== undefined}>
        <legend>
          <span>Libraries entering this workspace</span>
          <strong>{selectedReadableCount} of {readableLibraries.length} readable selected</strong>
        </legend>
        {connection.libraries.length ? (
          <ul className="zotero-library-list">
            {connection.libraries.map((library) => {
              const run = runStatus(library.lastSyncRun);
              const checkboxId = `zotero-library-${connection.id}-${library.id}`;
              const statusId = `${checkboxId}-status`;
              return (
                <li
                  className={`zotero-library-row ${!library.isReadable ? "unavailable" : ""}`}
                  key={library.id}
                >
                  <input
                    className="zotero-library-checkbox"
                    id={checkboxId}
                    type="checkbox"
                    checked={selected.has(library.id)}
                    onChange={(event) => toggleLibrary(library, event.target.checked)}
                    disabled={!canConfigure || (!library.isReadable && !selected.has(library.id))}
                    aria-describedby={statusId}
                  />
                  <label className="zotero-library-identity" htmlFor={checkboxId}>
                    <span className="zotero-library-icon" aria-hidden="true">
                      {library.type === "GROUP" ? <Users size={13} /> : <LibraryBig size={13} />}
                    </span>
                    <span className="zotero-library-copy">
                      <strong>{libraryName(library)}</strong>
                      <span>
                        {library.type === "USER" ? "Personal library" : "Group library"}
                        {` · Zotero ${library.zoteroLibraryId}`}
                      </span>
                    </span>
                  </label>
                  <div className="zotero-library-health" id={statusId}>
                    {!library.isReadable ? (
                      <span className="zotero-run-chip zotero-run-error">
                        <XCircle size={11} aria-hidden="true" />
                        {selected.has(library.id) ? "Access unavailable · Uncheck to remove" : "Access unavailable"}
                      </span>
                    ) : (
                      <span className={`zotero-run-chip ${run.className}`}>
                        {library.lastSyncRun?.status === "RUNNING" ? <LoaderCircle className="status-spinner" size={11} aria-hidden="true" /> : null}
                        {run.label}
                      </span>
                    )}
                    <span>
                      {library.lastSyncedAt
                        ? `Current through ${dateLabel(library.lastSyncedAt)}`
                        : selected.has(library.id)
                          ? "Awaiting first complete sync"
                          : "Metadata intake paused"}
                    </span>
                    {library.lastSyncedVersion ? <span>Provider version {library.lastSyncedVersion}</span> : null}
                    <span>{fileAccessCopy(library)}</span>
                  </div>
                  <ZoteroRunLedger library={library} />
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="zotero-library-empty">
            No libraries have been discovered for this connection. Refresh libraries after Zotero access is verified.
          </div>
        )}
      </fieldset>

      <ZoteroAttachmentRegister
        connection={connection}
        controller={controller}
        canManagePolicy={controller.canManage}
        canImport={controller.role === "owner" || controller.role === "admin" || controller.role === "member"}
        connectionAvailable={connection.status === "CONNECTED"}
        onOpenInbox={onOpenInbox}
      />

      {controller.canManage ? (
        <div className="zotero-folio-actions">
          <div className="zotero-folio-action-copy">
            {selectedUnreadableCount > 0
              ? `${selectedUnreadableCount} retained ${selectedUnreadableCount === 1 ? "selection no longer has" : "selections no longer have"} Zotero access. Refresh or reconnect to preserve ${selectedUnreadableCount === 1 ? "it" : "them"}, or uncheck ${selectedUnreadableCount === 1 ? "it" : "them"} to explicitly remove ${selectedUnreadableCount === 1 ? "it" : "them"}; PaperPilot will not silently drop ${selectedUnreadableCount === 1 ? "it" : "them"}.`
              : selectionDirty
              ? "Your selection has unsaved changes. Pausing a library keeps its existing PaperPilot records."
              : hasActiveRun
                ? "A durable sync pass is active. Counts update without advancing a partial cursor."
                : "Sync reads metadata into the Research Inbox. Zotero content is never changed."}
          </div>
          <div className="button-group">
            <button
              className="button small"
              type="button"
              onClick={() => void runAction("discover", () => controller.onDiscoverLibraries(connection.id))}
              disabled={!canDiscover}
            >
              {working === "discover" ? <LoaderCircle className="status-spinner" size={12} aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
              {working === "discover" ? "Refreshing…" : "Refresh libraries"}
            </button>
            <button
              className="button small"
              type="button"
              onClick={saveSelection}
              disabled={!canConfigure || !selectionDirty || selectedUnreadableCount > 0}
            >
              {working === "save" ? <LoaderCircle className="status-spinner" size={12} aria-hidden="true" /> : <Save size={12} aria-hidden="true" />}
              {working === "save" ? "Saving…" : "Save selection"}
            </button>
            <button
              className="button small primary"
              type="button"
              onClick={syncSelected}
              disabled={!canReachProvider || selectedReadableCount === 0 || selectionDirty || hasActiveRun}
            >
              {working === "sync" || hasActiveRun
                ? <LoaderCircle className="status-spinner" size={12} aria-hidden="true" />
                : <Play size={12} aria-hidden="true" />}
              {working === "sync"
                ? "Queueing…"
                : hasActiveRun
                  ? "Sync in progress"
                  : "Sync selected"}
            </button>
          </div>
        </div>
      ) : (
        <div className="zotero-role-note" role="note">
          You can inspect library custody and sync history as a {workspaceRoleLabel(controller.role)}. Only workspace owners and administrators can change selection or start a sync.
        </div>
      )}

      {controller.canManage && (connection.status === "CONNECTED" || connection.status === "PENDING" || connection.status === "DEGRADED") ? (
        <div className="zotero-disconnect-zone">
          <button
            className="button small"
            type="button"
            ref={disconnectTriggerRef}
            aria-controls={`disconnect-confirm-${connection.id}`}
            aria-expanded={confirmDisconnect}
            onClick={() => setConfirmDisconnect((current) => !current)}
            disabled={working !== undefined}
          >
            <Unplug size={12} aria-hidden="true" />
            {confirmDisconnect ? "Keep Zotero connected" : "Disconnect"}
          </button>
          {confirmDisconnect ? (
            <div
              className="zotero-disconnect-confirm"
              id={`disconnect-confirm-${connection.id}`}
              role="group"
              aria-labelledby={`disconnect-title-${connection.id}`}
            >
              <div>
                <strong id={`disconnect-title-${connection.id}`}>Disconnect this Zotero account?</strong>
                <span>PaperPilot erases its local credential and stops future sync. Queued or downloading PDF copies will lose authority and fail safely; retry the current file generation after reconnecting. Existing papers, source records, and evidence remain, and Zotero content is not changed.</span>
              </div>
              <div className="button-group">
                <button
                  className="button small"
                  type="button"
                  ref={disconnectCancelRef}
                  onClick={() => {
                    setConfirmDisconnect(false);
                    window.requestAnimationFrame(() => disconnectTriggerRef.current?.focus());
                  }}
                  disabled={working === "disconnect"}
                >
                  Cancel
                </button>
                <button
                  className="button small danger-button"
                  type="button"
                  onClick={() => void runAction("disconnect", () => controller.onDisconnect(connection.id))}
                  disabled={working === "disconnect"}
                >
                  <Unplug size={12} aria-hidden="true" />
                  {working === "disconnect" ? "Disconnecting…" : "Disconnect"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function CrawlerLiveCard({
  controller,
}: {
  controller: CrawlerSourceController;
}) {
  const [sourceUrl, setSourceUrl] = useState("");
  const [displayFileName, setDisplayFileName] = useState("");
  const [rawMaxBytes, setRawMaxBytes] = useState<string>();
  const [userDeclared, setUserDeclared] = useState(false);
  const [working, setWorking] = useState(false);
  const [confirmingDeletionId, setConfirmingDeletionId] = useState<string>();
  const [deletingRequestId, setDeletingRequestId] = useState<string>();
  const [deletionFeedback, setDeletionFeedback] = useState<{
    requestId: string;
    tone: "error" | "success";
    message: string;
  }>();
  const [feedback, setFeedback] = useState<{
    tone: "error" | "success";
    message: string;
  }>();
  const mounted = useRef(true);
  const operationId = useRef<string | undefined>(undefined);
  const deletionOperationIds = useRef<Record<string, string>>({});
  const deletionCancelRef = useRef<HTMLButtonElement | null>(null);
  const deletionTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const policy = controller.state.policy;
  const displayedMaxBytes = rawMaxBytes
    ?? (policy ? String(policy.maxResponseBytes) : "");
  const loading = controller.state.status === "idle" || controller.state.status === "loading";
  const pendingRetry = controller.pendingRetry;
  const crawlerBusy = working || Boolean(deletingRequestId);
  const custodyActionsBlocked = crawlerBusy || Boolean(pendingRetry);
  const draftError = crawlerDraftError(
    sourceUrl,
    displayFileName,
    displayedMaxBytes,
    policy,
  );
  const showDraftError = Boolean(sourceUrl || displayFileName) && draftError;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!confirmingDeletionId) return;
    const frame = window.requestAnimationFrame(() => deletionCancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [confirmingDeletionId]);

  function reviseDraft(update: () => void) {
    update();
    operationId.current = undefined;
    setFeedback(undefined);
  }

  async function queueRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      crawlerBusy
      || !controller.canManage
      || !userDeclared
      || draftError
      || !policy
      || pendingRetry
    ) return;
    const clientOperationId = operationId.current ?? newOperationId();
    operationId.current = clientOperationId;
    setWorking(true);
    setFeedback(undefined);
    try {
      const request = controller.onQueueRequest({
        clientOperationId,
        sourceUrl,
        displayFileName: displayFileName.normalize("NFC"),
        maxBytes: Number(displayedMaxBytes),
        userDeclared: true,
      });
      setSourceUrl("");
      const result = await request;
      if (!mounted.current) return;
      setFeedback({ tone: result.ok ? "success" : "error", message: result.message });
      if (result.ok) {
        operationId.current = undefined;
        setSourceUrl("");
        setDisplayFileName("");
        setRawMaxBytes(undefined);
        setUserDeclared(false);
      } else {
        operationId.current = undefined;
        setUserDeclared(false);
      }
    } catch {
      if (!mounted.current) return;
      operationId.current = undefined;
      setUserDeclared(false);
      setFeedback({
        tone: "error",
        message: "PaperPilot could not confirm whether the crawler request was queued. Use the preserved retry below to check the exact same operation.",
      });
    } finally {
      if (mounted.current) setWorking(false);
    }
  }

  async function retryPendingRequest() {
    if (crawlerBusy || !pendingRetry) return;
    setWorking(true);
    setFeedback(undefined);
    try {
      const result = await controller.onRetryPending();
      if (!mounted.current) return;
      setFeedback({ tone: result.ok ? "success" : "error", message: result.message });
      if (result.ok) {
        setSourceUrl("");
        setDisplayFileName("");
        setRawMaxBytes(undefined);
        setUserDeclared(false);
      } else {
        setUserDeclared(false);
      }
    } catch {
      if (!mounted.current) return;
      setUserDeclared(false);
      setFeedback({
        tone: "error",
        message: "PaperPilot still could not confirm the preserved crawler operation. Its original request remains available for another exact retry.",
      });
    } finally {
      if (mounted.current) setWorking(false);
    }
  }

  function beginCustodyDeletion(request: CrawlerRequestSummary) {
    if (custodyActionsBlocked || !request.canDeleteCustody) return;
    setDeletionFeedback(undefined);
    setConfirmingDeletionId(request.id);
  }

  function cancelCustodyDeletion(requestId: string) {
    if (deletingRequestId === requestId) return;
    setConfirmingDeletionId(undefined);
    setDeletionFeedback(undefined);
    window.requestAnimationFrame(() => deletionTriggerRefs.current[requestId]?.focus());
  }

  async function deletePrivatePdfCustody(request: CrawlerRequestSummary) {
    if (custodyActionsBlocked || !request.canDeleteCustody) return;
    const clientOperationId = deletionOperationIds.current[request.id] ?? newOperationId();
    deletionOperationIds.current[request.id] = clientOperationId;
    setDeletingRequestId(request.id);
    setDeletionFeedback(undefined);
    try {
      const result = await controller.onDeleteCustody(request.id, clientOperationId);
      if (!mounted.current) return;
      if (result.ok) {
        delete deletionOperationIds.current[request.id];
        setConfirmingDeletionId(undefined);
        setDeletionFeedback({
          requestId: request.id,
          tone: "success",
          message: result.message,
        });
      } else {
        // A closed application error proves that this command did not apply;
        // the next deliberate attempt gets a fresh idempotency identity.
        delete deletionOperationIds.current[request.id];
        setDeletionFeedback({
          requestId: request.id,
          tone: "error",
          message: result.message,
        });
      }
    } catch {
      if (!mounted.current) return;
      // The frozen operation ID remains associated with this row so the user
      // can retry the exact deletion after an ambiguous transport outcome.
      setDeletionFeedback({
        requestId: request.id,
        tone: "error",
        message: "PaperPilot could not confirm whether private PDF deletion was scheduled. Retry this same confirmation to check the exact operation.",
      });
    } finally {
      if (mounted.current) setDeletingRequestId(undefined);
    }
  }

  return (
    <article
      className="source-card source-card-live source-card-crawler-live"
      aria-labelledby="source-crawler"
    >
      <div className="source-card-head">
        <span className="source-card-icon" aria-hidden="true"><Globe2 size={18} /></span>
        <span className="status-chip source-status source-status-live">Governed one-PDF intake</span>
      </div>

      <div className="source-card-body crawler-source-body">
        <div className="crawler-source-intro">
          <div>
            <span className="micro-label">Remote acquisition docket</span>
            <h2 id="source-crawler">Governed scholarly crawler</h2>
            <p className="source-card-copy">
              Request one explicit repository PDF. PaperPilot checks the reviewed source policy, robots rules, public network destination, rejects redirects, and verifies response identity and byte budget before private custody begins.
            </p>
          </div>
          <button
            className="button small"
            type="button"
            onClick={() => void controller.onRefresh()}
            disabled={loading || crawlerBusy}
          >
            <RefreshCw className={loading ? "status-spinner" : undefined} size={12} aria-hidden="true" />
            {loading ? "Loading…" : "Refresh ledger"}
          </button>
        </div>

        <div className="crawler-docket-layout">
          <form className="crawler-request-form" onSubmit={(event) => void queueRequest(event)}>
            <div className="crawler-docket-heading">
              <div>
                <span className="micro-label">One-source request</span>
                <h3>Admit a PDF for quarantine</h3>
              </div>
              <span>Schema v1</span>
            </div>

            <label className="crawler-form-field" htmlFor="crawler-source-url">
              <span>Explicit PDF URL</span>
              <input
                id="crawler-source-url"
                type="url"
                value={sourceUrl}
                onChange={(event) => reviseDraft(() => setSourceUrl(event.target.value))}
                placeholder="https://repository.example.edu/papers/article.pdf"
                autoComplete="off"
                spellCheck={false}
                required
                disabled={crawlerBusy || !controller.canManage || !policy || Boolean(pendingRetry)}
                aria-describedby="crawler-source-url-note"
              />
              <small id="crawler-source-url-note">
                HTTPS port 443 only. Credentials, queries, fragments, discovery pages, and non-PDF paths are rejected.
              </small>
            </label>

            <div className="crawler-form-pair">
              <label className="crawler-form-field" htmlFor="crawler-display-filename">
                <span>Display filename</span>
                <input
                  id="crawler-display-filename"
                  type="text"
                  value={displayFileName}
                  onChange={(event) => reviseDraft(() => setDisplayFileName(event.target.value))}
                  placeholder="article.pdf"
                  autoComplete="off"
                  required
                  disabled={crawlerBusy || !controller.canManage || !policy || Boolean(pendingRetry)}
                />
                <small>Display only; never used as a storage path.</small>
              </label>

              <label className="crawler-form-field" htmlFor="crawler-max-bytes">
                <span>Stop after (bytes)</span>
                <input
                  id="crawler-max-bytes"
                  type="number"
                  min="1"
                  max={policy?.maxResponseBytes}
                  step="1"
                  value={displayedMaxBytes}
                  onChange={(event) => reviseDraft(() => setRawMaxBytes(event.target.value))}
                  required
                  disabled={crawlerBusy || !controller.canManage || !policy || Boolean(pendingRetry)}
                />
                <small>
                  Deployment ceiling: {policy ? crawlerBytes(policy.maxResponseBytes) : "loading"}.
                </small>
              </label>
            </div>

            <label className="crawler-rights-attestation">
              <input
                type="checkbox"
                checked={userDeclared}
                onChange={(event) => reviseDraft(() => setUserDeclared(event.target.checked))}
                disabled={crawlerBusy || !controller.canManage || !policy || Boolean(pendingRetry)}
              />
              <span>
                <strong>I affirm that I have the right to grant PaperPilot indefinite research custody of this PDF until I delete it.</strong>
                <small>
                  Required declaration: <code>INDEFINITE_RESEARCH_CUSTODY</code>. PaperPilot cannot offer a temporary-retention crawl in this mode.
                </small>
              </span>
            </label>

            {showDraftError ? (
              <p className="crawler-draft-error" role="status">{draftError}</p>
            ) : null}

            {feedback ? (
              <div
                className={`workspace-action-feedback crawler-action-feedback ${feedback.tone}`}
                role={feedback.tone === "error" ? "alert" : "status"}
              >
                {feedback.message}
              </div>
            ) : null}

            {!controller.canManage ? (
              <div className="crawler-role-note" role="note">
                This {workspaceRoleLabel(controller.role)} can inspect policy and request status. A workspace member, administrator, or owner must make the rights declaration and queue the request.
              </div>
            ) : null}

            {pendingRetry ? (
              <div className="crawler-role-note" role="alert">
                <strong>One request has an unconfirmed outcome.</strong>{" "}
                Retry operation <code>{pendingRetry.clientOperationId}</code> exactly as submitted
                for <strong>{pendingRetry.displayFileName}</strong> under policy{" "}
                <code>{pendingRetry.policyVersion}</code>, capped at{" "}
                {crawlerBytes(pendingRetry.maxBytes)}. The source URL remains private and is not
                reconstructed from this form.
                <div className="button-group">
                  <button
                    className="button small"
                    type="button"
                    onClick={() => void retryPendingRequest()}
                    disabled={crawlerBusy}
                  >
                    {working
                      ? <LoaderCircle className="status-spinner" size={12} aria-hidden="true" />
                      : <RefreshCw size={12} aria-hidden="true" />}
                    Retry exact operation
                  </button>
                </div>
              </div>
            ) : null}

            <div className="crawler-request-actions">
              <span>
                Queueing starts policy checks. It does not file a paper into any project.
              </span>
              <button
                className="button primary"
                type="submit"
                disabled={crawlerBusy || loading || !controller.canManage || !userDeclared || Boolean(draftError) || Boolean(pendingRetry)}
              >
                {working
                  ? <LoaderCircle className="status-spinner" size={13} aria-hidden="true" />
                  : <Play size={13} aria-hidden="true" />}
                {working ? "Queueing…" : "Queue governed request"}
              </button>
            </div>
          </form>

          <aside className="crawler-policy-passport" aria-label="Active crawler policy">
            <div className="crawler-policy-seal" aria-hidden="true"><ShieldCheck size={19} /></div>
            <div className="crawler-policy-heading">
              <span className="micro-label">Active policy passport</span>
              <strong>{policy?.policyVersion ?? "Loading policy"}</strong>
            </div>
            <dl>
              <div>
                <dt>Source envelope</dt>
                <dd>One query-free HTTPS <code>.pdf</code> URL · port 443</dd>
              </div>
              <div>
                <dt>Robots</dt>
                <dd>{policy?.robotsMode === "REQUIRE_ALLOW" ? "Explicit allowance required" : "Loading"}</dd>
              </div>
              <div>
                <dt>Redirects</dt>
                <dd>{policy ? "Disabled for exact-path first mode" : "Loading"}</dd>
              </div>
              <div>
                <dt>Response ceiling</dt>
                <dd>{policy ? crawlerBytes(policy.maxResponseBytes) : "Loading"}</dd>
              </div>
              <div>
                <dt>Retention</dt>
                <dd>Indefinite until user deletion</dd>
              </div>
              <div>
                <dt>Project filing</dt>
                <dd>Never automatic</dd>
              </div>
            </dl>
            <p>
              No ambient credentials are sent. DNS must resolve only to eligible public addresses, and each connection stays pinned to an admitted address.
            </p>
          </aside>
        </div>

        <div className="crawler-custody-note" role="note">
          <Database size={15} aria-hidden="true" />
          <span>
            <strong>Private quarantine comes before trust.</strong> Retrieved bytes remain unavailable while malware/PDF validation and authoritative extraction run. A ready result enters Research Inbox for separate review; it is not automatically filed into a project.
          </span>
        </div>

        <section className="crawler-ledger" aria-labelledby="crawler-ledger-title">
          <div className="crawler-ledger-head">
            <div>
              <span className="micro-label">Credential- and URL-free record</span>
              <h3 id="crawler-ledger-title">Recent acquisition ledger</h3>
            </div>
            <span>{controller.state.requests.length} recent</span>
          </div>

          {controller.state.status === "error" ? (
            <div className="crawler-state-panel error" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              <div>
                <strong>Crawler status could not be refreshed.</strong>
                <span>{controller.state.message}</span>
              </div>
              <button
                className="button small"
                type="button"
                onClick={() => void controller.onRefresh()}
                disabled={crawlerBusy}
              >
                Try again
              </button>
            </div>
          ) : null}

          {loading && controller.state.requests.length === 0 ? (
            <div className="crawler-state-panel" role="status" aria-live="polite">
              <LoaderCircle className="status-spinner" size={16} aria-hidden="true" />
              <div>
                <strong>Loading the public request ledger</strong>
                <span>Source URLs, network details, storage keys, and worker claims stay private.</span>
              </div>
            </div>
          ) : null}

          {!loading && controller.state.requests.length === 0 ? (
            <div className="crawler-empty-state">
              <History size={18} aria-hidden="true" />
              <div>
                <strong>No crawler requests yet.</strong>
                <span>Queue one eligible PDF above; its governed custody stages will appear here.</span>
              </div>
            </div>
          ) : null}

          {controller.state.requests.length > 0 ? (
            <ol className="crawler-request-ledger-list">
              {controller.state.requests.map((request) => {
                const presentation = crawlerStatusPresentation(request.status);
                const active = request.status === "QUEUED"
                  || request.status === "FETCHING"
                  || request.status === "QUARANTINED"
                  || request.status === "VALIDATING"
                  || request.status === "EXTRACTING"
                  || request.status === "DELETING";
                const confirmingDeletion = confirmingDeletionId === request.id
                  && request.status !== "DELETING"
                  && request.status !== "DELETED";
                const deleting = deletingRequestId === request.id;
                const storedDeletionFeedback = deletionFeedback?.requestId === request.id
                  ? deletionFeedback
                  : undefined;
                const requestDeletionFeedback = storedDeletionFeedback?.tone === "error"
                  && (request.status === "DELETING" || request.status === "DELETED")
                  ? {
                    ...storedDeletionFeedback,
                    tone: "success" as const,
                    message: request.status === "DELETED"
                      ? "The refreshed ledger confirms private PDF custody was deleted and quota was released after proof."
                      : "The refreshed ledger confirms private PDF deletion is scheduled and Reader access is closed.",
                  }
                  : storedDeletionFeedback;
                return (
                  <li className={`crawler-request-row tone-${presentation.tone}`} key={request.id}>
                    <div className="crawler-request-identity">
                      <span className="crawler-ledger-mark" aria-hidden="true">
                        {active
                          ? <LoaderCircle className="status-spinner" size={13} />
                          : request.status === "READY"
                            ? <ShieldCheck size={13} />
                            : request.status === "DELETED"
                              ? <ShieldOff size={13} />
                            : request.status === "ATTENTION"
                              ? <AlertTriangle size={13} />
                              : <XCircle size={13} />}
                      </span>
                      <div>
                        <strong>{request.displayFileName}</strong>
                        <span>Request <code>{request.id}</code></span>
                      </div>
                    </div>
                    <div className="crawler-request-stage">
                      <span className={`crawler-stage-chip ${presentation.tone}`}>{presentation.label}</span>
                      <span>{request.receivedBytes === null
                        ? `Cap ${crawlerBytes(request.maxBytes)}`
                        : `${crawlerBytes(request.receivedBytes)} received · cap ${crawlerBytes(request.maxBytes)}`}</span>
                    </div>
                    <div className="crawler-request-time">
                      <Clock size={12} aria-hidden="true" />
                      <span>
                        Updated <time dateTime={request.updatedAt}>{dateLabel(request.updatedAt)}</time>
                        {request.status === "DELETING" && request.retryAt
                          ? <> · next cleanup pass <time dateTime={request.retryAt}>{dateLabel(request.retryAt)}</time></>
                          : request.retryAt
                          ? <> · retry after <time dateTime={request.retryAt}>{dateLabel(request.retryAt)}</time></>
                          : request.status === "DELETED" && request.completedAt
                            ? <> · deletion proved <time dateTime={request.completedAt}>{dateLabel(request.completedAt)}</time></>
                            : request.completedAt
                            ? <> · completed <time dateTime={request.completedAt}>{dateLabel(request.completedAt)}</time></>
                            : null}
                      </span>
                    </div>
                    <div className="crawler-custody-control">
                      {request.status === "DELETING" ? (
                        <div className="crawler-custody-stamp scheduled" role="status">
                          <Trash2 size={13} aria-hidden="true" />
                          <span>
                            <strong>Private PDF deletion scheduled</strong>
                            <small>Reader access is closed. Cleanup is pending; quota remains held until proof.</small>
                          </span>
                        </div>
                      ) : request.status === "DELETED" ? (
                        <div className="crawler-custody-stamp deleted" role="status">
                          <ShieldOff size={13} aria-hidden="true" />
                          <span>
                            <strong>Private PDF custody deleted</strong>
                            <small>Private-byte proof is recorded and quota is released. A complete extracted-text generation may remain for grounded evidence.</small>
                          </span>
                        </div>
                      ) : request.canDeleteCustody ? (
                        <button
                          aria-controls={confirmingDeletion
                            ? `crawler-delete-confirm-${request.id}`
                            : undefined}
                          aria-expanded={confirmingDeletion}
                          aria-label={`Delete private PDF custody for ${request.displayFileName}`}
                          className="button small danger-button crawler-delete-trigger"
                          disabled={custodyActionsBlocked}
                          onClick={() => beginCustodyDeletion(request)}
                          ref={(node) => {
                            deletionTriggerRefs.current[request.id] = node;
                          }}
                          type="button"
                        >
                          <Trash2 size={12} aria-hidden="true" />
                          Delete private PDF custody
                        </button>
                      ) : (
                        <span className="crawler-custody-retained">Private PDF custody retained</span>
                      )}
                    </div>
                    {request.failureCode ? (
                      <div className="crawler-request-failure">
                        <code>{request.failureCode}</code>
                        <span>{crawlerFailureCopy(request.failureCode)}</span>
                      </div>
                    ) : null}
                    {confirmingDeletion ? (
                      <div
                        aria-labelledby={`crawler-delete-confirm-title-${request.id}`}
                        className="crawler-delete-confirm"
                        id={`crawler-delete-confirm-${request.id}`}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape" || deleting) return;
                          event.preventDefault();
                          cancelCustodyDeletion(request.id);
                        }}
                        role="group"
                      >
                        <div>
                          <strong id={`crawler-delete-confirm-title-${request.id}`}>
                            Delete private PDF custody for {request.displayFileName}?
                          </strong>
                          <span>
                            Reader access closes immediately. PaperPilot deletes private crawler PDF bytes asynchronously and releases retained-byte quota only after the bound storage generation proves its managed final and partial object names absent. Extracted-text generations with no evidence dependency are purged. If any grounded evidence depends on one chunk, PaperPilot retains that complete extracted-text generation, which may include the paper&apos;s full extracted text and text unrelated to the saved excerpt. A minimal no-raw-locator audit/provenance record, immutable custody receipts, and user-authored evidence also remain.
                          </span>
                        </div>
                        <div className="button-group">
                          <button
                            className="button small"
                            disabled={deleting}
                            onClick={() => cancelCustodyDeletion(request.id)}
                            ref={deletionCancelRef}
                            type="button"
                          >
                            Cancel
                          </button>
                          <button
                            className="button small danger-button"
                            disabled={deleting}
                            onClick={() => void deletePrivatePdfCustody(request)}
                            type="button"
                          >
                            {deleting
                              ? <LoaderCircle className="status-spinner" size={12} aria-hidden="true" />
                              : <Trash2 size={12} aria-hidden="true" />}
                            {deleting ? "Scheduling deletion…" : "Delete private PDF custody"}
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {requestDeletionFeedback ? (
                      <div
                        className={`crawler-deletion-feedback ${requestDeletionFeedback.tone}`}
                        role={requestDeletionFeedback.tone === "error" ? "alert" : "status"}
                      >
                        {requestDeletionFeedback.message}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : null}
        </section>
      </div>
    </article>
  );
}

function ZoteroLiveCard({
  controller,
  onOpenInbox,
}: {
  controller: ZoteroSourceController;
  onOpenInbox: () => void;
}) {
  const [scopeProfile, setScopeProfile] = useState<ZoteroScopeProfile>("personal_metadata");
  const [starting, setStarting] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "error" | "success";
    message: string;
  }>();
  const isLoading = controller.state.status === "idle" || controller.state.status === "loading";
  const hasActiveConnection = controller.state.connections.some((connection) =>
    connection.status === "CONNECTED"
    || connection.status === "PENDING"
    || connection.status === "DEGRADED");

  async function startOAuth() {
    if (starting || isLoading || !controller.canManage) return;
    setStarting(true);
    setFeedback(undefined);
    try {
      const result = await controller.onStartOAuth(scopeProfile);
      setFeedback({ tone: result.ok ? "success" : "error", message: result.message });
    } catch (cause) {
      setFeedback({
        tone: "error",
        message: cause instanceof Error
          ? cause.message
          : "PaperPilot could not start the Zotero connection.",
      });
    } finally {
      setStarting(false);
    }
  }

  return (
    <article className="source-card source-card-live source-card-zotero-live" aria-labelledby="source-zotero">
      <div className="source-card-head">
        <span className="source-card-icon" aria-hidden="true"><LibraryBig size={18} /></span>
        <span className="status-chip source-status source-status-live">Read-only sync live</span>
      </div>
      <div className="source-card-body zotero-source-body">
        <div className="zotero-source-intro">
          <div>
            <h2 id="source-zotero">Zotero library intake</h2>
            <p className="source-card-copy">
              Connect personal or group libraries, choose exactly which ones enter this workspace, and inspect every durable metadata pass. PaperPilot exposes no credential in this page.
            </p>
          </div>
          <button
            className="button small"
            type="button"
            onClick={() => void controller.onRefresh()}
            disabled={isLoading}
          >
            <RefreshCw size={12} aria-hidden="true" /> {isLoading ? "Loading…" : "Refresh status"}
          </button>
        </div>

        <div className="zotero-readonly-strip" role="note">
          <ShieldCheck size={14} aria-hidden="true" />
          <span><strong>Inbound and read-only.</strong> No PaperPilot control can edit or delete Zotero library content.</span>
        </div>

        {feedback ? (
          <div className={`workspace-action-feedback zotero-action-feedback ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>
            {feedback.message}
          </div>
        ) : null}

        {controller.state.status === "error" ? (
          <div className="zotero-state-panel error" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <div>
              <strong>Zotero status could not be loaded.</strong>
              <span>{controller.state.message}</span>
            </div>
            <button className="button small" type="button" onClick={() => void controller.onRefresh()}>
              Try again
            </button>
          </div>
        ) : null}

        {isLoading ? (
          <div className="zotero-state-panel" role="status" aria-live="polite">
            <LoaderCircle className="status-spinner" size={16} aria-hidden="true" />
            <div>
              <strong>Loading credential-free connection summaries</strong>
              <span>PaperPilot is checking this workspace’s Zotero status.</span>
            </div>
          </div>
        ) : null}

        {controller.state.status === "ready" && !controller.state.connections.length ? (
          <div className="zotero-empty-state">
            <LibraryBig size={20} aria-hidden="true" />
            <div>
              <strong>No Zotero library is connected.</strong>
              <span>
                {controller.canManage
                  ? "Choose a read-only profile below to begin."
                  : "A workspace owner or administrator can add the first connection."}
              </span>
            </div>
          </div>
        ) : null}

        {controller.state.connections.length ? (
          <div className="zotero-connection-list" aria-label="Zotero connections">
            {controller.state.connections.map((connection) => (
              <ZoteroConnectionFolio
                connection={connection}
                controller={controller}
                onOpenInbox={onOpenInbox}
                key={`${connection.id}:${connection.selectionRevision}:${connection.libraries
                  .map((library) => `${library.id}:${library.isReadable ? 1 : 0}:${library.syncEnabled ? 1 : 0}`)
                  .join("|")}`}
              />
            ))}
          </div>
        ) : null}

        {controller.canManage ? (
          <div className="zotero-connect-panel">
            <div>
              <span className="micro-label">Read-only scope profile</span>
              <label className="sr-only" htmlFor="zotero-scope-profile">Zotero read-only scope profile</label>
              <select
                className="project-form-select"
                id="zotero-scope-profile"
                value={scopeProfile}
                onChange={(event) => setScopeProfile(event.target.value as ZoteroScopeProfile)}
                disabled={starting || isLoading}
              >
                <option value="personal_metadata">Personal metadata — recommended</option>
                <option value="personal_metadata_notes">Personal metadata + notes</option>
                <option value="personal_group_metadata">Personal + group metadata</option>
                <option value="personal_group_metadata_notes">Personal + groups + notes</option>
              </select>
              <p>{scopeDescriptions[scopeProfile]}</p>
            </div>
            <button className="button primary" type="button" onClick={() => void startOAuth()} disabled={starting || isLoading}>
              <LibraryBig size={13} aria-hidden="true" />
              {starting ? "Opening Zotero…" : hasActiveConnection ? "Connect another account" : "Connect Zotero"}
            </button>
          </div>
        ) : (
          <div className="zotero-role-note" role="note">
            Connection details are visible to this {workspaceRoleLabel(controller.role)}. Only workspace owners and administrators can connect or disconnect Zotero.
          </div>
        )}
      </div>
    </article>
  );
}

export function SourcesView({
  mode = "demo",
  onOpenDiscover,
  onOpenInbox,
  onPreviewSource,
  crawler,
  zotero,
  upload,
}: SourcesViewProps) {
  const liveCrawler = mode === "live" && crawler;
  const liveZotero = mode === "live" && zotero;
  const liveUpload = mode === "live" && upload;
  return (
    <section className="view sources-view" aria-labelledby="sources-title">
      <div className="view-header">
        <div>
          <span className="eyebrow">Ingestion and monitoring</span>
          <h1 className="view-title" id="sources-title">Sources</h1>
          <p className="view-subtitle">
            {mode === "live"
              ? "Connect governed research sources, inspect their real status, and keep every inbound path explicit."
              : "Inspect the browser demo’s guarded workflows for libraries, files, websites, and agent-assisted capture."}
          </p>
        </div>
        <button className="button primary" type="button" onClick={onOpenDiscover}>
          <Search size={14} aria-hidden="true" /> Search research
        </button>
      </div>

      <div className="source-disclosure" role="note">
        <ShieldCheck size={16} aria-hidden="true" />
        <p>
          {mode === "live" ? (
            <><strong>Live boundaries are explicit.</strong> OpenAlex search, Zotero’s read-only library selection and cursored metadata intake, authenticated PDF quarantine, and the durable validation control plane are live. {liveCrawler ? "Governed one-PDF crawler requests enter the same private validation path; WebMCP byte capture remains gated." : "Crawling and WebMCP capture remain gated."}</>
          ) : (
            <><strong>This is a browser demo.</strong> OpenAlex search can use the live gateway when available; Zotero, crawling, uploads, and WebMCP cards are non-connecting previews.</>
          )}
        </p>
      </div>

      <div className="source-grid" aria-label="Paper sources">
        {sourceCards.map((source) => {
          if (source.id === "crawler" && liveCrawler) {
            return (
              <CrawlerLiveCard
                controller={liveCrawler}
                key={source.id}
              />
            );
          }
          if (source.id === "zotero" && liveZotero) {
            return <ZoteroLiveCard controller={liveZotero} onOpenInbox={onOpenInbox} key={source.id} />;
          }
          if (source.id === "upload" && liveUpload) {
            return <FileUploadCard controller={liveUpload} key={source.id} />;
          }
          const Icon = source.icon;
          return (
            <article className={`source-card source-card-${source.status}`} aria-labelledby={`source-${source.id}`} key={source.id}>
              <div className="source-card-head">
                <span className="source-card-icon" aria-hidden="true"><Icon size={18} /></span>
                <span className={`status-chip source-status source-status-${source.status}`}>{source.statusLabel}</span>
              </div>
              <div className="source-card-body">
                <h2 id={`source-${source.id}`}>{source.title}</h2>
                <p className="source-card-copy">{source.description}</p>
                <p className="source-card-detail">{source.detail}</p>
              </div>
              <div className="source-card-actions">
                {source.id === "openalex" ? (
                  <button className="button primary" type="button" onClick={onOpenDiscover}>
                    {source.actionLabel} <Search size={13} aria-hidden="true" />
                  </button>
                ) : source.previewKind ? (
                  <button className="button" type="button" onClick={() => onPreviewSource(source.previewKind as PreviewSourceKind)}>
                    {source.actionLabel}
                  </button>
                ) : (
                  <span className="micro-label">No connection in this build</span>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
