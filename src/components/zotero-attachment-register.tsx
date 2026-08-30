"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArchiveRestore,
  Check,
  FileCheck2,
  FileDown,
  FolderArchive,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type {
  ZoteroAttachmentEligibility,
  ZoteroAttachmentImportUiResponse,
  ZoteroAttachmentListUiResponse,
  ZoteroAttachmentPolicyMode,
  ZoteroAttachmentPolicyUiSummary,
  ZoteroAttachmentPolicyUpdateUiResponse,
  ZoteroAttachmentUiSummary,
  ZoteroConnectionUiSummary,
  ZoteroLibraryUiSummary,
} from "@/lib/integrations";
import { isZoteroAttachmentImportCurrent } from "@/lib/integrations";

const ACTIVE_IMPORT_STATUSES = new Set([
  "QUEUED",
  "DOWNLOADING",
  "QUARANTINED",
  "VALIDATING",
  "EXTRACTING",
]);
const INITIAL_POLL_DELAY_MS = 5_000;
const MAX_POLL_DELAY_MS = 60_000;
const MAX_QUIET_REFRESH_PAGES = 5;

export type ZoteroAttachmentRegisterController = {
  onGetAttachmentPolicy: (
    connectionId: string,
  ) => Promise<ZoteroAttachmentPolicyUiSummary>;
  onListAttachments: (
    connectionId: string,
    query: {
      after?: string;
      libraryId?: string;
      eligibility?: ZoteroAttachmentEligibility;
      includeDeleted?: boolean;
    },
  ) => Promise<ZoteroAttachmentListUiResponse>;
  onSetAttachmentPolicy: (
    connectionId: string,
    mode: ZoteroAttachmentPolicyMode,
    expectedRevision: number,
  ) => Promise<ZoteroAttachmentPolicyUpdateUiResponse>;
  onImportAttachment: (
    connectionId: string,
    attachment: ZoteroAttachmentUiSummary,
    expectedPolicyRevision: number,
    clientOperationId: string,
  ) => Promise<ZoteroAttachmentImportUiResponse>;
};

type RegisterProps = {
  connection: ZoteroConnectionUiSummary;
  controller: ZoteroAttachmentRegisterController;
  canManagePolicy: boolean;
  canImport: boolean;
  connectionAvailable: boolean;
  onOpenInbox: () => void;
};

type PolicyState =
  | { status: "loading" }
  | { status: "ready"; value: ZoteroAttachmentPolicyUiSummary }
  | { status: "error"; message: string };

type AttachmentState =
  | { status: "loading"; attachments: ZoteroAttachmentUiSummary[] }
  | {
      status: "ready";
      attachments: ZoteroAttachmentUiSummary[];
      nextCursor: string | null;
    }
  | { status: "error"; attachments: ZoteroAttachmentUiSummary[]; message: string };

type LoadedAttachmentPage = {
  after?: string;
  attachments: ZoteroAttachmentUiSummary[];
  nextCursor: string | null;
};

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function importStatus(value: ZoteroAttachmentUiSummary["latestImport"]): {
  label: string;
  detail: string;
  tone: "idle" | "active" | "ready" | "attention" | "failed";
} {
  if (!value) {
    return {
      label: "Not imported",
      detail: "The PDF remains only in Zotero.",
      tone: "idle",
    };
  }
  switch (value.status) {
    case "QUEUED":
      return { label: "Queued", detail: "Waiting for the private download worker.", tone: "active" };
    case "DOWNLOADING":
      return { label: "Copying", detail: "Streaming into private PaperPilot custody.", tone: "active" };
    case "QUARANTINED":
      return { label: "Quarantined", detail: "Copied, checksum-bound, and isolated.", tone: "active" };
    case "VALIDATING":
      return { label: "Validating", detail: "Malware and PDF checks are running.", tone: "active" };
    case "EXTRACTING":
      return { label: "Extracting", detail: "Validated bytes are becoming Reader text.", tone: "active" };
    case "READY":
      return { label: "Reader ready", detail: "The admitted text is available from the Inbox.", tone: "ready" };
    case "ATTENTION":
      return { label: "Needs attention", detail: "The file is retained safely, but Reader processing needs review.", tone: "attention" };
    case "FAILED":
      return { label: "Import failed", detail: failureCopy(value.failureCode), tone: "failed" };
    case "CANCELLED":
      return { label: "Cancelled", detail: "No active import owns this source generation.", tone: "failed" };
  }
}

function failureCopy(code: string | null): string {
  switch (code) {
    case "attachment_too_large":
      return "This PDF exceeds the workspace’s admitted file limit.";
    case "attachment_integrity_failed":
      return "The copied bytes did not match Zotero’s admitted file identity.";
    case "zotero_attachment_unavailable":
      return "The current Zotero connection can no longer provide this stored file.";
    case "attachment_download_failed":
      return "The private copy could not be completed safely.";
    case "source_changed":
      return "The Zotero file changed. Sync metadata before retrying.";
    case "credentials_changed":
      return "The Zotero connection changed. Refresh this account before retrying.";
    case "policy_changed":
      return "Attachment settings changed before the copy completed.";
    case "file_access_unavailable":
      return "Zotero no longer permits this stored file to be read.";
    case "checksum_mismatch":
      return "The downloaded bytes did not match Zotero’s checksum.";
    case "upload_too_large":
      return "This PDF exceeds the workspace’s admitted file limit.";
    case "provider_unavailable":
      return "Zotero was unavailable. A fresh explicit retry is safe.";
    case "download_failed":
      return "The private copy could not be completed.";
    case "cancelled":
      return "The import was cancelled before admission.";
    default:
      return "PaperPilot could not complete the import safely.";
  }
}

function ineligibilityCopy(attachment: ZoteroAttachmentUiSummary): string {
  if (attachment.isDeleted) return "Removed from Zotero";
  switch (attachment.reasonCode) {
    case "content_type_not_pdf":
    case "filename_not_pdf":
      return "Not a stored PDF";
    case "linked_file_not_downloadable":
      return "Linked files stay outside Zotero storage";
    case "linked_url_not_downloadable":
      return "Web links require governed web intake";
    case "embedded_image_not_downloadable":
      return "Embedded image, not a paper PDF";
    case "source_not_item":
    case "item_not_attachment":
      return "Metadata record, not an attachment";
    case "unsupported_link_mode":
      return "Unsupported Zotero attachment mode";
    default:
      return attachment.eligibility === "MALFORMED"
        ? "Zotero metadata could not be admitted safely"
        : "Not eligible for stored-PDF import";
  }
}

function custodyProgress(status: ZoteroAttachmentUiSummary["latestImport"]): number {
  if (!status) return 0;
  switch (status.status) {
    case "QUEUED":
    case "DOWNLOADING":
      return 1;
    case "QUARANTINED":
      return 2;
    case "VALIDATING":
      return 2;
    case "EXTRACTING":
    case "ATTENTION":
      return 3;
    case "READY":
      return 4;
    case "FAILED":
    case "CANCELLED":
      return 1;
  }
}

function CustodyRail({
  importRecord,
}: {
  importRecord: ZoteroAttachmentUiSummary["latestImport"];
}) {
  const progress = custodyProgress(importRecord);
  const failed = importRecord?.status === "FAILED"
    || importRecord?.status === "CANCELLED";
  const attention = importRecord?.status === "ATTENTION";
  const stages = ["Zotero", "Quarantine", "Validate", "Reader"];
  return (
    <ol
      className={`zotero-attachment-custody ${failed ? "failed" : ""} ${attention ? "attention" : ""}`}
      aria-label="Attachment custody path"
    >
      {stages.map((stage, index) => {
        const step = index + 1;
        const done = step <= progress;
        const current = step === Math.min(progress + 1, 4)
          && Boolean(importRecord)
          && importRecord?.status !== "READY";
        return (
          <li className={done ? "done" : current ? "current" : ""} key={stage}>
            <span aria-hidden="true">{done ? <Check size={9} /> : step}</span>
            <strong>{stage}</strong>
          </li>
        );
      })}
    </ol>
  );
}

function libraryProvenanceLabel(library: ZoteroLibraryUiSummary): string {
  const name = library.name
    ?? (library.type === "USER" ? "My Library" : "Unnamed Zotero group");
  const kind = library.type === "USER" ? "Personal library" : "Group library";
  return `${name} · ${kind} · Zotero ${library.zoteroLibraryId}`;
}

function libraryLabel(
  connection: ZoteroConnectionUiSummary,
  libraryId: string,
): string {
  const library = connection.libraries.find((candidate) => candidate.id === libraryId);
  return library ? libraryProvenanceLabel(library) : `Unavailable library · PaperPilot ${libraryId}`;
}

function flattenPages(pages: LoadedAttachmentPage[]): ZoteroAttachmentUiSummary[] {
  const seen = new Set<string>();
  return pages.flatMap((page) => page.attachments.filter((attachment) => {
    if (seen.has(attachment.id)) return false;
    seen.add(attachment.id);
    return true;
  }));
}

export function ZoteroAttachmentRegister({
  connection,
  controller,
  canManagePolicy,
  canImport,
  connectionAvailable,
  onOpenInbox,
}: RegisterProps) {
  const [policy, setPolicy] = useState<PolicyState>({ status: "loading" });
  const [attachments, setAttachments] = useState<AttachmentState>({
    status: "loading",
    attachments: [],
  });
  const [libraryId, setLibraryId] = useState("");
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [working, setWorking] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "error" | "success"; message: string }>();
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const requestCounter = useRef(0);
  const quietRequestCounter = useRef(0);
  const policyRequestCounter = useRef(0);
  const manualRequestCount = useRef(0);
  const attachmentStateRef = useRef<AttachmentState>(attachments);
  const loadedPagesRef = useRef<LoadedAttachmentPage[]>([]);
  const quietPageOffsetRef = useRef(0);

  useEffect(() => {
    attachmentStateRef.current = attachments;
  }, [attachments]);

  const selectedLibraries = useMemo(
    () => connection.libraries.filter((library) => library.syncEnabled),
    [connection.libraries],
  );

  const libraryAuthorityKey = useMemo(
    () => connection.libraries.map((library) => [
      library.id,
      library.syncEnabled ? "1" : "0",
      library.isReadable ? "1" : "0",
      library.fileAccessStatus,
      library.lastSyncedVersion ?? "",
    ].join(":" )).sort().join("|"),
    [connection.libraries],
  );

  const loadPolicy = useCallback(async () => {
    const requestId = ++policyRequestCounter.current;
    setPolicy({ status: "loading" });
    try {
      const value = await controllerRef.current.onGetAttachmentPolicy(connection.id);
      if (requestId !== policyRequestCounter.current) return;
      setPolicy({ status: "ready", value });
    } catch (cause) {
      if (requestId !== policyRequestCounter.current) return;
      setPolicy({
        status: "error",
        message: cause instanceof Error
          ? cause.message
          : "Attachment settings could not be loaded.",
      });
    }
  }, [connection.id]);

  const loadAttachments = useCallback(async (
    options: {
      append?: boolean;
      quiet?: boolean;
      after?: string;
      refreshAttachmentId?: string;
    } = {},
  ) => {
    if (options.quiet) {
      if (manualRequestCount.current > 0 && !options.refreshAttachmentId) return;
      const observedRequest = requestCounter.current;
      const quietRequestId = ++quietRequestCounter.current;
      const snapshot = attachmentStateRef.current;
      const pages = loadedPagesRef.current;
      if (pages.length === 0) return;
      const activeIds = new Set(snapshot.attachments
        .filter((attachment) => isZoteroAttachmentImportCurrent(attachment)
          && attachment.latestImport
          && ACTIVE_IMPORT_STATUSES.has(attachment.latestImport.status))
        .map((attachment) => attachment.id));
      const forcedPageIndex = options.refreshAttachmentId
        ? pages.findIndex((page) => page.attachments.some(
            (attachment) => attachment.id === options.refreshAttachmentId,
          ))
        : -1;
      const activePageIndexes = pages
        .map((page, index) => ({ page, index }))
        .filter(({ page, index }) => index > 0
          && page.attachments.some((attachment) => activeIds.has(attachment.id)))
        .map(({ index }) => index);
      const rotatingCapacity = MAX_QUIET_REFRESH_PAGES - 1;
      const rotatingStart = activePageIndexes.length > 0
        ? quietPageOffsetRef.current % activePageIndexes.length
        : 0;
      const selectedActivePages = Array.from(
        { length: Math.min(rotatingCapacity, activePageIndexes.length) },
        (_, offset) => activePageIndexes[(rotatingStart + offset) % activePageIndexes.length],
      );
      if (activePageIndexes.length > rotatingCapacity) {
        quietPageOffsetRef.current = (rotatingStart + rotatingCapacity) % activePageIndexes.length;
      } else {
        quietPageOffsetRef.current = 0;
      }
      const pageIndexes = forcedPageIndex >= 0
        ? [forcedPageIndex]
        : [0, ...selectedActivePages];
      try {
        for (const pageIndex of pageIndexes) {
          const pageSnapshot = loadedPagesRef.current[pageIndex];
          if (!pageSnapshot) continue;
          const page = await controllerRef.current.onListAttachments(connection.id, {
            ...(pageSnapshot.after ? { after: pageSnapshot.after } : {}),
            ...(libraryId ? { libraryId } : {}),
            ...(showUnavailable
              ? { includeDeleted: true }
              : { eligibility: "DOWNLOADABLE" }),
          });
          if (
            observedRequest !== requestCounter.current
            || quietRequestId !== quietRequestCounter.current
            || (manualRequestCount.current > 0 && !options.refreshAttachmentId)
          ) return;
          const currentPages = [...loadedPagesRef.current];
          if (currentPages[pageIndex]?.after !== pageSnapshot.after) return;
          const cursorChanged = page.nextCursor !== pageSnapshot.nextCursor;
          currentPages[pageIndex] = {
            after: pageSnapshot.after,
            attachments: page.attachments,
            nextCursor: page.nextCursor,
          };
          const authoritativePages = cursorChanged
            ? currentPages.slice(0, pageIndex + 1)
            : currentPages;
          loadedPagesRef.current = authoritativePages;
          const lastPage = authoritativePages.at(-1);
          setAttachments({
            status: "ready",
            attachments: flattenPages(authoritativePages),
            nextCursor: lastPage?.nextCursor ?? null,
          });
          if (cursorChanged) return;
        }
      } catch (cause) {
        if (
          observedRequest !== requestCounter.current
          || quietRequestId !== quietRequestCounter.current
          || (manualRequestCount.current > 0 && !options.refreshAttachmentId)
        ) return;
        setAttachments((current) => ({
          status: "error",
          attachments: current.attachments,
          message: cause instanceof Error
            ? cause.message
            : "Stored PDF records could not be refreshed.",
        }));
      }
      return;
    }

    const requestId = ++requestCounter.current;
    manualRequestCount.current += 1;
    if (options.append) {
      setLoadingMore(true);
    } else {
      loadedPagesRef.current = [];
      quietPageOffsetRef.current = 0;
      setAttachments({
        status: "loading",
        attachments: [],
      });
    }
    try {
      const page = await controllerRef.current.onListAttachments(connection.id, {
        ...(options.after ? { after: options.after } : {}),
        ...(libraryId ? { libraryId } : {}),
        ...(showUnavailable
          ? { includeDeleted: true }
          : { eligibility: "DOWNLOADABLE" }),
      });
      if (requestId !== requestCounter.current) return;
      const nextPage: LoadedAttachmentPage = {
        after: options.after,
        attachments: page.attachments,
        nextCursor: page.nextCursor,
      };
      const pages = options.append
        ? [...loadedPagesRef.current.filter((candidate) => candidate.after !== options.after), nextPage]
        : [nextPage];
      loadedPagesRef.current = pages;
      setAttachments({
        status: "ready",
        attachments: flattenPages(pages),
        nextCursor: page.nextCursor,
      });
    } catch (cause) {
      if (requestId !== requestCounter.current) return;
      setAttachments((current) => ({
        status: "error",
        attachments: current.attachments,
        message: cause instanceof Error
          ? cause.message
          : "Stored PDF records could not be loaded.",
      }));
    } finally {
      manualRequestCount.current -= 1;
      if (options.append) setLoadingMore(false);
    }
  }, [connection.id, libraryId, showUnavailable]);

  useEffect(() => {
    void loadPolicy();
    return () => {
      policyRequestCounter.current += 1;
    };
  }, [loadPolicy]);

  useEffect(() => {
    void loadAttachments();
    return () => {
      requestCounter.current += 1;
    };
  }, [libraryAuthorityKey, loadAttachments]);

  const activeImportKey = attachments.attachments
    .filter((attachment) => isZoteroAttachmentImportCurrent(attachment)
      && attachment.latestImport
      && ACTIVE_IMPORT_STATUSES.has(attachment.latestImport.status))
    .map((attachment) => `${attachment.id}:${attachment.latestImport?.status}`)
    .join("|");

  useEffect(() => {
    if (!activeImportKey) return;
    let cancelled = false;
    let timer: number | undefined;
    let inFlight = false;
    let resumeAfterFlight = false;
    let pollEpoch = 0;
    const stagger = [...connection.id]
      .reduce((total, character) => total + character.charCodeAt(0), 0) % 2_000;
    let delay = INITIAL_POLL_DELAY_MS + stagger;

    const schedule = (milliseconds = delay) => {
      if (cancelled || document.hidden) return;
      if (inFlight) {
        resumeAfterFlight = true;
        return;
      }
      if (timer !== undefined) window.clearTimeout(timer);
      const scheduledEpoch = pollEpoch;
      timer = window.setTimeout(() => {
        timer = undefined;
        if (cancelled || document.hidden || scheduledEpoch !== pollEpoch) return;
        inFlight = true;
        void loadAttachments({ quiet: true }).finally(() => {
          inFlight = false;
          if (cancelled || document.hidden) return;
          if (scheduledEpoch !== pollEpoch) {
            if (resumeAfterFlight) {
              resumeAfterFlight = false;
              schedule(500 + stagger);
            }
            return;
          }
          delay = Math.min(MAX_POLL_DELAY_MS, delay * 2);
          schedule();
        });
      }, milliseconds);
    };
    const onVisibilityChange = () => {
      pollEpoch += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (!document.hidden) {
        delay = INITIAL_POLL_DELAY_MS + stagger;
        if (inFlight) {
          resumeAfterFlight = true;
        } else {
          schedule(500 + stagger);
        }
      } else {
        resumeAfterFlight = false;
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule();
    return () => {
      cancelled = true;
      pollEpoch += 1;
      quietRequestCounter.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [activeImportKey, connection.id, loadAttachments]);

  async function changePolicy(mode: ZoteroAttachmentPolicyMode) {
    if (!connectionAvailable || !canManagePolicy || policy.status !== "ready" || working) return;
    policyRequestCounter.current += 1;
    setWorking("policy");
    setFeedback(undefined);
    try {
      const updated = await controllerRef.current.onSetAttachmentPolicy(
        connection.id,
        mode,
        policy.value.revision,
      );
      policyRequestCounter.current += 1;
      setPolicy({ status: "ready", value: updated });
      setFeedback({
        tone: "success",
        message: mode === "MANUAL"
          ? "Manual stored-PDF imports are enabled. Each file still requires an explicit import."
          : "Stored-PDF imports are disabled. Queued or downloading copies will stop at their next authority check and require a fresh retry after re-enabling; admitted PaperPilot copies remain available.",
      });
    } catch (cause) {
      setFeedback({
        tone: "error",
        message: cause instanceof Error
          ? cause.message
          : "Attachment settings could not be changed.",
      });
      await loadPolicy();
    } finally {
      setWorking(undefined);
    }
  }

  async function importAttachment(attachment: ZoteroAttachmentUiSummary) {
    if (
      !canImport
      || !connectionAvailable
      || policy.status !== "ready"
      || policy.value.mode !== "MANUAL"
      || !attachment.providerMd5
      || working
    ) return;
    requestCounter.current += 1;
    setWorking(attachment.id);
    setFeedback(undefined);
    try {
      const result = await controllerRef.current.onImportAttachment(
        connection.id,
        attachment,
        policy.value.revision,
        window.crypto.randomUUID(),
      );
      requestCounter.current += 1;
      setAttachments((current) => ({
        status: "ready",
        attachments: current.attachments.map((candidate) => candidate.id === attachment.id
          ? { ...candidate, latestImport: result.import }
          : candidate),
        nextCursor: current.status === "ready" ? current.nextCursor : null,
      }));
      loadedPagesRef.current = loadedPagesRef.current.map((page) => ({
        ...page,
        attachments: page.attachments.map((candidate) => candidate.id === attachment.id
          ? { ...candidate, latestImport: result.import }
          : candidate),
      }));
      setFeedback({
        tone: "success",
        message: result.outcome === "coalesced"
          ? "This exact Zotero file already has an active or completed PaperPilot import."
          : result.outcome === "replayed"
            ? "The earlier import request was restored without creating a duplicate."
            : "The PDF is queued for a private, checksum-bound copy from Zotero.",
      });
    } catch (cause) {
      requestCounter.current += 1;
      setFeedback({
        tone: "error",
        message: cause instanceof Error
          ? cause.message
          : "The Zotero PDF could not be queued for import.",
      });
      await loadAttachments({ quiet: true, refreshAttachmentId: attachment.id });
    } finally {
      setWorking(undefined);
    }
  }

  const policyEnabled = policy.status === "ready" && policy.value.mode === "MANUAL";
  const policyActive = policyEnabled && connectionAvailable;

  return (
    <section className="zotero-attachment-register" aria-labelledby={`zotero-attachments-${connection.id}`}>
      <header className="zotero-attachment-register-head">
        <div className="zotero-attachment-register-title">
          <span className="zotero-accession-mark" aria-hidden="true"><FolderArchive size={16} /></span>
          <div>
            <span className="micro-label">Stored-PDF accession register</span>
            <h4 id={`zotero-attachments-${connection.id}`}>Bring files into PaperPilot custody</h4>
          </div>
        </div>
        <button
          className="button small"
          type="button"
          onClick={() => {
            void loadPolicy();
            void loadAttachments();
          }}
          disabled={working !== undefined || policy.status === "loading" || attachments.status === "loading"}
        >
          <RefreshCw size={12} aria-hidden="true" /> Refresh register
        </button>
      </header>

      <div className={`zotero-attachment-policy ${policyActive ? "enabled" : "disabled"}`}>
        <span className="zotero-attachment-policy-seal" aria-hidden="true">
          {policyActive ? <ShieldCheck size={18} /> : <ArchiveRestore size={18} />}
        </span>
        <div>
          <span className="micro-label">File intake policy</span>
          <strong>
            {!connectionAvailable
              ? "Read-only connection history"
              : policy.status === "loading"
              ? "Checking policy…"
              : policy.status === "error"
                ? "Policy unavailable"
                : policyEnabled
                  ? "Manual imports enabled"
                  : "Stored files stay in Zotero"}
          </strong>
          <p>
            {!connectionAvailable
              ? "Reconnect this Zotero account before changing policy or importing another stored file. Existing PaperPilot copies and custody history remain available."
              : policy.status === "error"
              ? policy.message
              : policyEnabled
                ? "Researchers may copy one eligible PDF at a time. Nothing is downloaded during metadata sync. Disabling this policy also stops queued or downloading copies before admission."
                : "Metadata can sync, but PaperPilot will not copy Zotero attachment bytes."}
          </p>
        </div>
        {connectionAvailable && canManagePolicy && policy.status === "ready" ? (
          <button
            className={`button small ${policyEnabled ? "" : "primary"}`}
            type="button"
            onClick={() => void changePolicy(policyEnabled ? "DISABLED" : "MANUAL")}
            disabled={working !== undefined}
          >
            {working === "policy" ? <LoaderCircle className="status-spinner" size={12} aria-hidden="true" /> : null}
            {working === "policy"
              ? "Saving…"
              : policyEnabled
                ? "Disable imports & stop copies"
                : "Enable manual imports"}
          </button>
        ) : null}
      </div>

      {!connectionAvailable ? (
        <div className="zotero-attachment-governance-note" role="note">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>This register is read-only while the connection is {connection.status.toLowerCase()}. Reconnect Zotero to admit the current stored-file generation.</span>
        </div>
      ) : !canManagePolicy ? (
        <div className="zotero-attachment-governance-note" role="note">
          <ShieldCheck size={13} aria-hidden="true" />
          <span>The attachment policy is read-only for your workspace role. Eligible members can still import one PDF at a time when an administrator enables manual intake.</span>
        </div>
      ) : null}

      {feedback ? (
        <div
          className={`workspace-action-feedback zotero-attachment-feedback ${feedback.tone}`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </div>
      ) : null}

      <div className="zotero-attachment-register-tools">
        <label>
          <span>Library</span>
          <select
            className="project-form-select"
            value={libraryId}
            onChange={(event) => setLibraryId(event.target.value)}
            disabled={working !== undefined}
          >
            <option value="">All discovered libraries</option>
            {connection.libraries.map((library) => (
              <option value={library.id} key={library.id}>
                {libraryProvenanceLabel(library)}
                {library.syncEnabled ? "" : " — metadata paused"}
              </option>
            ))}
          </select>
        </label>
        <label className="zotero-attachment-unavailable-toggle">
          <input
            type="checkbox"
            checked={showUnavailable}
            onChange={(event) => setShowUnavailable(event.target.checked)}
            disabled={working !== undefined}
          />
          <span>Show non-importable records</span>
        </label>
        <p>
          {selectedLibraries.length
            ? `${selectedLibraries.length} ${selectedLibraries.length === 1 ? "library is" : "libraries are"} selected for metadata sync.`
            : "Select and sync a library above before importing its stored files."}
        </p>
      </div>

      {attachments.status === "error" ? (
        <div className="zotero-attachment-state error" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span><strong>Stored PDF records could not be refreshed.</strong> {attachments.message}</span>
        </div>
      ) : null}

      {attachments.status === "loading" && attachments.attachments.length === 0 ? (
        <div className="zotero-attachment-state" role="status">
          <LoaderCircle className="status-spinner" size={16} aria-hidden="true" />
          <span><strong>Opening the accession register</strong> Checking sanitized attachment metadata only.</span>
        </div>
      ) : attachments.attachments.length === 0 ? (
        <div className="zotero-attachment-empty">
          <FileCheck2 size={19} aria-hidden="true" />
          <div>
            <strong>{showUnavailable ? "No attachment records found" : "No importable stored PDFs yet"}</strong>
            <span>
              {showUnavailable
                ? "Refresh Zotero metadata or choose another library."
                : "Run a metadata sync above. Eligible Zotero PDFs appear here without downloading their bytes."}
            </span>
          </div>
        </div>
      ) : (
        <ul className="zotero-attachment-list" aria-label="Zotero stored PDF records">
          {attachments.attachments.map((attachment) => {
            const importIsCurrent = isZoteroAttachmentImportCurrent(attachment);
            const currentImport = importIsCurrent ? attachment.latestImport : null;
            const sourceUpdated = attachment.latestImport !== null && !importIsCurrent;
            const status = sourceUpdated
              ? {
                  label: "Updated in Zotero",
                  detail: "A newer stored-file generation is available. The earlier PaperPilot copy or attempt remains in custody history.",
                  tone: "attention" as const,
                }
              : importStatus(currentImport);
            const library = connection.libraries.find((candidate) => candidate.id === attachment.libraryId);
            const active = Boolean(currentImport
              && ACTIVE_IMPORT_STATUSES.has(currentImport.status));
            const retryable = currentImport?.status === "FAILED"
              || currentImport?.status === "CANCELLED";
            const opensInbox = currentImport?.status === "READY"
              || currentImport?.status === "ATTENTION";
            const opensPriorCopy = sourceUpdated
              && (attachment.latestImport?.status === "READY"
                || attachment.latestImport?.status === "ATTENTION");
            const sourceAvailable = Boolean(
              library?.syncEnabled
              && library.isReadable
              && library.fileAccessStatus !== "UNAVAILABLE",
            );
            const eligible = attachment.eligibility === "DOWNLOADABLE"
              && !attachment.isDeleted
              && Boolean(attachment.providerMd5);
            const canQueue = canImport
              && connectionAvailable
              && policyEnabled
              && sourceAvailable
              && eligible
              && (!currentImport || retryable)
              && !loadingMore
              && working === undefined;
            const blockReason = opensInbox
              ? undefined
              : !connectionAvailable
              ? "Reconnect this Zotero account before importing the current file generation."
              : !canImport
                ? "Your workspace role cannot import stored files."
                : !policyEnabled
                  ? "An owner or administrator must enable manual stored-PDF imports first."
                  : !sourceAvailable
                    ? "Select a readable library with file access before importing."
                    : !eligible
                      ? ineligibilityCopy(attachment)
                      : active
                        ? "PaperPilot is processing this exact stored-file generation."
                      : loadingMore
                        ? "Finish loading the next register page before starting an import."
                      : working !== undefined
                        ? "Another attachment-setting or import request is still being submitted."
                        : undefined;
            const blockReasonId = `zotero-attachment-${connection.id}-${attachment.id}-block`;
            return (
              <li className={`zotero-attachment-row tone-${status.tone}`} key={attachment.id}>
                <div className="zotero-attachment-identity">
                  <span className="zotero-attachment-file-icon" aria-hidden="true"><FileDown size={15} /></span>
                  <div>
                    <strong>{attachment.fileName ?? "Untitled Zotero attachment"}</strong>
                    <span>{libraryLabel(connection, attachment.libraryId)}</span>
                  </div>
                </div>
                <div className="zotero-attachment-specimen">
                  <span>Object {attachment.id}</span>
                  <span>Version {attachment.sourceVersion}</span>
                  {attachment.providerMd5 ? <span>MD5 {attachment.providerMd5.slice(0, 10)}…</span> : null}
                  <span>Seen {dateLabel(attachment.updatedAt)}</span>
                </div>
                {eligible ? <CustodyRail importRecord={currentImport} /> : (
                  <div className="zotero-attachment-ineligible">
                    <AlertTriangle size={13} aria-hidden="true" /> {ineligibilityCopy(attachment)}
                  </div>
                )}
                <div className="zotero-attachment-outcome" role="status" aria-live="polite" aria-atomic="true">
                  <span className={`zotero-attachment-status tone-${status.tone}`}>{status.label}</span>
                  <p>{eligible ? status.detail : ineligibilityCopy(attachment)}</p>
                </div>
                <div className="zotero-attachment-action">
                  <button
                    className={`button small ${opensInbox ? "" : "primary"}`}
                    type="button"
                    onClick={() => {
                      if (opensInbox) {
                        onOpenInbox();
                      } else if (canQueue) {
                        void importAttachment(attachment);
                      }
                    }}
                    aria-disabled={active || (!opensInbox && !canQueue)}
                    aria-describedby={blockReason ? blockReasonId : undefined}
                  >
                    {active || working === attachment.id
                      ? <LoaderCircle className="status-spinner" size={12} aria-hidden="true" />
                      : opensInbox
                        ? <FileCheck2 size={12} aria-hidden="true" />
                        : <FileDown size={12} aria-hidden="true" />}
                    {active
                      ? "Processing"
                      : working === attachment.id
                        ? "Queueing…"
                        : opensInbox
                          ? "Open Inbox"
                          : sourceUpdated
                            ? "Import new version"
                            : retryable
                              ? "Retry import"
                              : "Import PDF"}
                  </button>
                  {opensPriorCopy ? (
                    <button className="button small" type="button" onClick={onOpenInbox}>
                      Open prior copy
                    </button>
                  ) : null}
                  {blockReason ? (
                    <span className="zotero-attachment-action-note" id={blockReasonId}>
                      {blockReason}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {attachments.status === "ready" && attachments.nextCursor ? (
        <button
          className="button small zotero-attachment-load-more"
          type="button"
          onClick={() => void loadAttachments({
            append: true,
            after: attachments.nextCursor ?? undefined,
          })}
          disabled={working !== undefined || loadingMore}
        >
          {loadingMore ? (
            <><LoaderCircle className="status-spinner" size={12} aria-hidden="true" /> Loading…</>
          ) : "Load more records"}
        </button>
      ) : null}
    </section>
  );
}
