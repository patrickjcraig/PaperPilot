"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpenText,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileUp,
  Fingerprint,
  Globe2,
  Inbox,
  LibraryBig,
  Link2,
  LockKeyhole,
  LoaderCircle,
  Search,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  CrawlerDocumentInboxEntry,
  CrawlerDocumentStage,
  DocumentUploadInboxEntry,
  DocumentUploadStage,
  ImportSourceKind,
  InboxEntryStatus,
  Paper,
  ResearchProject,
  WebMcpInboxEntry,
  WorkspaceInboxEntry,
} from "@/lib/types";
import {
  isCrawlerDocumentInboxEntry,
  isDocumentUploadInboxEntry,
  isWebMcpInboxEntry,
} from "@/lib/types";
import type {
  WebMcpApprovalEvidenceDossier,
  WebMcpDuplicateDecision as WorkspaceWebMcpDuplicateDecision,
} from "@/lib/workspace";

export type WebMcpDuplicateDecision = WorkspaceWebMcpDuplicateDecision;

export interface WebMcpApprovalSelection {
  inboxEntryId: string;
  proposalDigest: string;
  destinationProjectId: string;
  duplicateDecision: WebMcpDuplicateDecision;
}

export interface WebMcpApprovalReview {
  challenge: WebMcpApprovalEvidenceDossier;
  /** A final request left without a trustworthy response and must be retried verbatim. */
  finalOutcomeUnknown: boolean;
}

type InboxViewProps = {
  entries: WorkspaceInboxEntry[];
  canLinkDocuments?: boolean;
  papers?: Paper[];
  projects: ResearchProject[];
  onChooseProject: (entryId: string, projectId: string) => void;
  onLinkDocument?: (documentId: string, paperId: string) => void;
  onOpenReader?: (paperId: string) => void;
  onOpenSources: () => void;
  onOpenDiscover: () => void;
  filingEntryId?: string;
  linkingDocumentId?: string;
  canApproveWebMcp?: boolean;
  preparingWebMcpEntryId?: string;
  approvingWebMcpEntryId?: string;
  webMcpApprovalReviews?: Readonly<Record<string, WebMcpApprovalReview>>;
  webMcpReviewErrors?: Readonly<Record<string, string>>;
  onPrepareWebMcp?: (selection: WebMcpApprovalSelection) => void | Promise<void>;
  onApproveWebMcp?: (
    selection: WebMcpApprovalSelection,
    challenge: WebMcpApprovalEvidenceDossier,
  ) => void | Promise<void>;
  onDiscardWebMcpReview?: (inboxEntryId: string) => void;
};

const uploadStageLabels: Record<DocumentUploadStage, string> = {
  "awaiting-bytes": "Awaiting transfer",
  receiving: "Receiving PDF",
  quarantined: "Quarantined",
  validating: "Validating PDF",
  ready: "Verified and ready",
  failed: "Not accepted",
  expired: "Session expired",
};

const uploadCustodyLabels: Record<DocumentUploadStage, string> = {
  "awaiting-bytes": "Transfer not started",
  receiving: "Private transfer",
  quarantined: "Private quarantine",
  validating: "Private validation",
  ready: "Verified private document",
  failed: "Unavailable document",
  expired: "Expired transfer",
};

function uploadBoundaryMessage(entry: DocumentUploadInboxEntry): string {
  if (entry.upload.linkedPaperId) {
    switch (entry.upload.extractionStage) {
      case "not-started":
        return "The validated PDF is linked to the selected paper. No current authoritative text extraction is available yet.";
      case "queued":
        return "The validated PDF is linked to the selected paper. Authoritative text extraction is queued.";
      case "extracting":
        return "The validated PDF is linked and authoritative text extraction is in progress.";
      case "ready":
        return "The linked document has an attested text extraction and is available in Reader.";
      case "no-text":
        return "Extraction completed without a usable text layer. Reader will not invent text or apply an unverified OCR fallback.";
      case "failed":
        return "The document remains linked, but the current authoritative extraction failed.";
    }
  }
  switch (entry.upload.stage) {
    case "ready":
      return "Verified as a private document. Choose an existing visible workspace paper to establish the source link Reader requires; extraction proceeds independently.";
    case "validating":
      return "Malware screening and structural PDF validation are in progress. Project filing and Reader access stay locked.";
    case "quarantined":
      return "Privately quarantined and awaiting validation. It is not available to projects or Reader.";
    case "awaiting-bytes":
    case "receiving":
      return "The PDF transfer is not complete. Project filing and Reader access stay locked.";
    case "failed":
    case "expired":
      return "This document remains unavailable to projects and Reader.";
  }
}

function uploadDisplayState(entry: DocumentUploadInboxEntry): string {
  if (!entry.upload.linkedPaperId) return uploadStageLabels[entry.upload.stage];
  switch (entry.upload.extractionStage) {
    case "not-started": return "Linked · awaiting extraction";
    case "queued": return "Text extraction queued";
    case "extracting": return "Extracting text";
    case "ready": return "Reader ready";
    case "no-text": return "No usable text";
    case "failed": return "Extraction failed";
  }
}

const crawlerStageLabels: Record<CrawlerDocumentStage, string> = {
  queued: "Queued",
  fetching: "Acquiring PDF",
  quarantined: "Quarantined",
  validating: "Validating PDF",
  extracting: "Extracting text",
  ready: "Verified and ready",
  attention: "Extraction needs attention",
  failed: "Not accepted",
  cancelled: "Cancelled",
};

function crawlerBoundaryMessage(entry: CrawlerDocumentInboxEntry): string {
  if (entry.crawler.linkedPaperId) {
    switch (entry.crawler.extractionStage) {
      case "not-started": return "The governed PDF is linked, but no current authoritative text extraction is available.";
      case "queued": return "The governed PDF is linked and authoritative text extraction is queued.";
      case "extracting": return "The governed PDF is linked and authoritative text extraction is in progress.";
      case "ready": return "The linked governed document has an attested extraction and is available in Reader.";
      case "no-text": return "Extraction completed without a usable text layer. Reader will not invent text or apply an unverified OCR fallback.";
      case "failed": return "The governed document remains linked, but its current authoritative extraction failed.";
    }
  }
  switch (entry.crawler.stage) {
    case "queued":
    case "fetching":
      return "Governed acquisition is in progress. The source URL and network receipt remain private; linking and Reader stay locked.";
    case "quarantined":
      return "The acquired PDF is privately quarantined and awaiting validation. Linking and Reader stay locked.";
    case "validating":
      return "Malware screening and structural PDF validation are in progress. Linking and Reader stay locked.";
    case "extracting":
      return "The PDF is validated and authoritative text extraction is in progress. Linking stays locked until the governed request is ready.";
    case "ready":
      return "The governed PDF and its extraction are verified. Choose a visible workspace paper to establish the explicit source link Reader requires.";
    case "attention":
    case "failed":
    case "cancelled":
      return "This governed document remains unavailable to projects and Reader.";
  }
}

function crawlerDisplayState(entry: CrawlerDocumentInboxEntry): string {
  if (!entry.crawler.linkedPaperId) return crawlerStageLabels[entry.crawler.stage];
  switch (entry.crawler.extractionStage) {
    case "not-started": return "Linked · awaiting extraction";
    case "queued": return "Text extraction queued";
    case "extracting": return "Extracting text";
    case "ready": return "Reader ready";
    case "no-text": return "No usable text";
    case "failed": return "Extraction failed";
  }
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

const sourceLabels: Record<ImportSourceKind, string> = {
  discover: "Discover",
  zotero: "Zotero preview",
  upload: "File upload",
  crawler: "Crawler preview",
  webmcp: "WebMCP proposal",
  identifier: "Identifier import",
};

const sourceIcons: Record<ImportSourceKind, LucideIcon> = {
  discover: Search,
  zotero: LibraryBig,
  upload: FileUp,
  crawler: Globe2,
  webmcp: Globe2,
  identifier: Inbox,
};

const statusLabels: Record<InboxEntryStatus, string> = {
  "awaiting-review": "Awaiting review",
  "possible-duplicate": "Possible duplicate",
  processing: "Processing",
  ready: "Filed",
  blocked: "Needs attention",
};

const statusIcons: Record<InboxEntryStatus, LucideIcon> = {
  "awaiting-review": Clock3,
  "possible-duplicate": AlertTriangle,
  processing: LoaderCircle,
  ready: CheckCircle2,
  blocked: AlertTriangle,
};

function formatStagedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently staged";

  return `Staged ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)}`;
}

function safeReviewUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    // A terminal DNS root dot is semantically insignificant, but retaining it
    // would let `localhost.` evade exact/suffix checks. Literal IP addresses
    // are withheld entirely; asserted review links do not need that power.
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    const blockedSuffixes = [
      ".arpa", ".corp", ".example", ".home", ".internal", ".invalid",
      ".lan", ".local", ".localdomain", ".localhost", ".onion", ".test",
    ];
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.hash
      || !hostname
      || hostname === "localhost"
      || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)
      || hostname.includes(":")
      || hostname.startsWith("[")
      || !hostname.includes(".")
      || blockedSuffixes.some((suffix) => hostname.endsWith(suffix))
    ) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function shortProposalDigest(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function webMcpDecisionMatches(
  left: WebMcpDuplicateDecision,
  right: WebMcpDuplicateDecision,
): boolean {
  return left.kind === right.kind
    && (left.kind === "create_new"
      || (right.kind === "use_existing"
        && left.canonicalPaperId === right.canonicalPaperId));
}

function challengeMatchesSelection(
  challenge: WebMcpApprovalEvidenceDossier,
  selection: WebMcpApprovalSelection,
): boolean {
  return challenge.inboxEntryId === selection.inboxEntryId
    && challenge.proposalDigest === selection.proposalDigest
    && challenge.destinationProjectId === selection.destinationProjectId
    && webMcpDecisionMatches(challenge.duplicateDecision, selection.duplicateDecision);
}

const authorityLabels: Record<WebMcpApprovalEvidenceDossier["evidence"]["authority"], string> = {
  OPENALEX: "OpenAlex verified work",
  HUMAN_REVIEW: "Identifier-free human review",
  EXISTING_CANONICAL: "Existing canonical record",
};

type WebMcpDossierProps = {
  entry: WebMcpInboxEntry;
  projects: ResearchProject[];
  selectedProjectId: string;
  canApprove: boolean;
  isPreparing: boolean;
  isApproving: boolean;
  anotherApprovalInFlight: boolean;
  review?: WebMcpApprovalReview;
  reviewError?: string;
  onSelectProject: (projectId: string) => void;
  onPrepare?: (selection: WebMcpApprovalSelection) => void | Promise<void>;
  onApprove?: (
    selection: WebMcpApprovalSelection,
    challenge: WebMcpApprovalEvidenceDossier,
  ) => void | Promise<void>;
  onDiscardReview?: (inboxEntryId: string) => void;
};

function WebMcpDossier({
  entry,
  projects,
  selectedProjectId,
  canApprove,
  isPreparing,
  isApproving,
  anotherApprovalInFlight,
  review,
  reviewError,
  onSelectProject,
  onPrepare,
  onApprove,
  onDiscardReview,
}: WebMcpDossierProps) {
  const decisionIdentity = [
    entry.proposalDigest,
    entry.duplicateOfPaperId ?? "create-new",
    entry.duplicateCandidate?.id ?? "no-candidate",
  ].join("\u0000");
  const [acknowledgedDecision, setAcknowledgedDecision] = useState({
    identity: decisionIdentity,
    acknowledged: false,
  });
  const decisionAcknowledged = acknowledgedDecision.identity === decisionIdentity
    && acknowledgedDecision.acknowledged;
  const titleId = `inbox-entry-${entry.id}`;
  const sourceUrl = safeReviewUrl(entry.provenance.sourceUrl ?? entry.paper.sourceUrl);
  const candidatePdfUrl = safeReviewUrl(entry.paper.access?.pdfUrl);
  const duplicateDecision: WebMcpDuplicateDecision = entry.duplicateOfPaperId
    ? { kind: "use_existing", canonicalPaperId: entry.duplicateOfPaperId }
    : { kind: "create_new" };
  const currentSelection: WebMcpApprovalSelection = {
    inboxEntryId: entry.id,
    proposalDigest: entry.proposalDigest,
    destinationProjectId: selectedProjectId,
    duplicateDecision,
  };
  const challenge = review?.challenge;
  const challengeMatches = challenge
    ? challengeMatchesSelection(challenge, currentSelection)
    : false;
  const [expiredChallengeId, setExpiredChallengeId] = useState<string>();
  useEffect(() => {
    if (!challenge || review?.finalOutcomeUnknown) return;
    const expiresIn = Date.parse(challenge.expiresAt) - Date.now();
    const timeout = window.setTimeout(
      () => setExpiredChallengeId(challenge.challengeId),
      Math.max(0, Math.min(expiresIn + 25, 2_147_483_647)),
    );
    return () => window.clearTimeout(timeout);
  }, [challenge, review?.finalOutcomeUnknown]);
  const challengeExpired = Boolean(challenge)
    && expiredChallengeId === challenge!.challengeId;
  const evidenceIdentity = challenge
    ? `${challenge.challengeId}\u0000${challenge.evidence.evidenceDigest}`
    : "no-evidence";
  const [acknowledgedEvidence, setAcknowledgedEvidence] = useState({
    identity: evidenceIdentity,
    acknowledged: false,
  });
  const evidenceAcknowledged = acknowledgedEvidence.identity === evidenceIdentity
    && acknowledgedEvidence.acknowledged;
  const finalOutcomeUnknown = review?.finalOutcomeUnknown === true;
  const approvalSelection = finalOutcomeUnknown && challenge
    ? {
        inboxEntryId: challenge.inboxEntryId,
        proposalDigest: challenge.proposalDigest,
        destinationProjectId: challenge.destinationProjectId,
        duplicateDecision: challenge.duplicateDecision,
      }
    : currentSelection;
  const eligibleStatus = entry.status === "awaiting-review"
    || entry.status === "possible-duplicate";
  const hasUsableChallenge = Boolean(challenge)
    && (challengeMatches || finalOutcomeUnknown)
    && (!challengeExpired || finalOutcomeUnknown);
  const canPrepare = Boolean(onPrepare)
    && (!challenge || !hasUsableChallenge)
    && !finalOutcomeUnknown;
  const canSubmitFinal = Boolean(onApprove)
    && hasUsableChallenge
    && (evidenceAcknowledged || finalOutcomeUnknown);
  const submitDisabled = !canApprove
    || (!finalOutcomeUnknown && (
      !projects.length
      || !selectedProjectId
      || !eligibleStatus
      || !decisionAcknowledged
    ))
    || anotherApprovalInFlight
    || (!canPrepare && !canSubmitFinal);
  const reviewHelpId = `webmcp-review-help-${entry.id}`;
  const reviewErrorId = `webmcp-review-error-${entry.id}`;
  const custodyId = `webmcp-custody-${entry.id}`;
  const ReviewStatusIcon = statusIcons[entry.status];

  return (
    <article
      className="webmcp-dossier"
      aria-labelledby={titleId}
      aria-busy={isPreparing || isApproving}
    >
      <header className="webmcp-dossier-head">
        <span className="webmcp-source-seal" aria-hidden="true">
          <Globe2 size={18} />
        </span>
        <div className="webmcp-dossier-heading">
          <div className="webmcp-dossier-kicker">
            <span>WebMCP source dossier</span>
            <span>{formatStagedAt(entry.createdAt)}</span>
          </div>
          <h3 id={titleId}>{entry.paper.title}</h3>
          <p className="webmcp-byline">
            {entry.paper.authors.length
              ? entry.paper.authors.join(", ")
              : "No authors asserted by the source"}
          </p>
        </div>
        <span className={`status-chip inbox-status inbox-status-${entry.status}`}>
          <ReviewStatusIcon size={10} aria-hidden="true" />
          {statusLabels[entry.status]}
        </span>
      </header>

      <div className="webmcp-source-ribbon">
        <span className="webmcp-source-origin">
          <span className="micro-label">Asserted source origin</span>
          {sourceUrl ? (
            <a
              href={sourceUrl.href}
              target="_blank"
              rel="noopener noreferrer external"
              referrerPolicy="no-referrer"
              title={`Open asserted source page at ${sourceUrl.origin}`}
            >
              <span>{sourceUrl.origin}</span>
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          ) : (
            <strong>Source address withheld because it is not an eligible HTTPS URL</strong>
          )}
        </span>
        <span className="webmcp-fingerprint">
          <Fingerprint size={13} aria-hidden="true" />
          <span>
            <span className="micro-label">Immutable proposal fingerprint</span>
            <code title={entry.proposalDigest}>
              <span aria-hidden="true">sha256:{shortProposalDigest(entry.proposalDigest)}</span>
              <span className="sr-only">SHA-256 {entry.proposalDigest}</span>
            </code>
          </span>
        </span>
      </div>

      <div className="webmcp-dossier-body">
        <div className="webmcp-assertion-sheet">
          <section className="webmcp-bibliography" aria-labelledby={`webmcp-citation-${entry.id}`}>
            <h4 id={`webmcp-citation-${entry.id}`}>Bibliographic assertion</h4>
            <dl className="webmcp-citation-grid">
              <div>
                <dt>Venue</dt>
                <dd>{entry.paper.venue || "Not asserted"}</dd>
              </div>
              <div>
                <dt>Year</dt>
                <dd>{entry.paper.year || "Not asserted"}</dd>
              </div>
              <div>
                <dt>Publication type</dt>
                <dd>{entry.paper.type}</dd>
              </div>
              <div>
                <dt>Source provider</dt>
                <dd>{entry.provenance.providerName}</dd>
              </div>
            </dl>
          </section>

          {entry.duplicateCandidate ? (
            <section
              className="webmcp-duplicate-comparison"
              aria-labelledby={`webmcp-comparison-${entry.id}`}
            >
              <div className="webmcp-section-head">
                <h4 id={`webmcp-comparison-${entry.id}`}>Proposal versus canonical match</h4>
                <span>Existing record required</span>
              </div>
              <div className="webmcp-comparison-grid">
                <article>
                  <span className="micro-label">Source proposal</span>
                  <h5>{entry.paper.title}</h5>
                  <p>{entry.paper.authors.length ? entry.paper.authors.join(", ") : "No authors asserted"}</p>
                  <dl>
                    <div><dt>Venue</dt><dd>{entry.paper.venue || "Not asserted"}</dd></div>
                    <div><dt>Year</dt><dd>{entry.paper.year || "Not asserted"}</dd></div>
                    <div><dt>Type</dt><dd>{entry.paper.type}</dd></div>
                  </dl>
                  {entry.paper.identifiers.length ? (
                    <ul aria-label="Identifiers asserted by proposal">
                      {entry.paper.identifiers.map((identifier, index) => (
                        <li key={`proposal-${identifier.scheme}-${identifier.value}-${index}`}>
                          <span>{identifier.scheme}</span><code>{identifier.value}</code>
                        </li>
                      ))}
                    </ul>
                  ) : <p>No identifiers asserted.</p>}
                </article>
                <article className="webmcp-canonical-candidate">
                  <span className="micro-label">Canonical match</span>
                  <h5>{entry.duplicateCandidate.title}</h5>
                  <p>
                    {entry.duplicateCandidate.authors.length
                      ? entry.duplicateCandidate.authors.join(", ")
                      : "No authors recorded"}
                  </p>
                  <dl>
                    <div><dt>Venue</dt><dd>{entry.duplicateCandidate.venue || "Not recorded"}</dd></div>
                    <div><dt>Year</dt><dd>{entry.duplicateCandidate.year || "Not recorded"}</dd></div>
                    <div><dt>Type</dt><dd>{entry.duplicateCandidate.type}</dd></div>
                  </dl>
                  {entry.duplicateCandidate.identifiers.length ? (
                    <ul aria-label="Identifiers on canonical match">
                      {entry.duplicateCandidate.identifiers.map((identifier, index) => (
                        <li key={`canonical-${identifier.scheme}-${identifier.value}-${index}`}>
                          <span>{identifier.scheme}</span><code>{identifier.value}</code>
                        </li>
                      ))}
                    </ul>
                  ) : <p>No identifiers recorded.</p>}
                </article>
              </div>
              <p className="webmcp-comparison-boundary">
                This comparison contains bibliographic identity only. It does not claim that the canonical record has a document, access rights, or Reader custody.
              </p>
            </section>
          ) : null}

          <section className="webmcp-abstract" aria-labelledby={`webmcp-abstract-${entry.id}`}>
            <h4 id={`webmcp-abstract-${entry.id}`}>Abstract asserted by source</h4>
            <p>{entry.paper.abstract || "No abstract was included in this proposal."}</p>
          </section>

          <section className="webmcp-identifiers" aria-labelledby={`webmcp-identifiers-${entry.id}`}>
            <div className="webmcp-section-head">
              <h4 id={`webmcp-identifiers-${entry.id}`}>Identifiers</h4>
              <span>{entry.paper.identifiers.length} asserted</span>
            </div>
            {entry.paper.identifiers.length ? (
              <ul>
                {entry.paper.identifiers.map((identifier, index) => (
                  <li key={`${identifier.scheme}-${identifier.value}-${index}`}>
                    <span>{identifier.scheme}</span>
                    <code>{identifier.value}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No DOI, arXiv ID, ISBN, or provider identifier was asserted.</p>
            )}
          </section>

          <section className="webmcp-access-claims" aria-labelledby={`webmcp-access-${entry.id}`}>
            <div className="webmcp-section-head">
              <h4 id={`webmcp-access-${entry.id}`}>Access claims</h4>
              <span>Unverified assertions</span>
            </div>
            <dl>
              <div>
                <dt>Open access</dt>
                <dd>{entry.paper.access?.isOpenAccess ? "Claimed by source" : "Not claimed"}</dd>
              </div>
              <div>
                <dt>License</dt>
                <dd>{entry.paper.access?.license || "Not asserted"}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{entry.paper.access?.version || entry.provenance.version || "Not asserted"}</dd>
              </div>
              <div className="webmcp-pdf-assertion">
                <dt>Candidate PDF location</dt>
                <dd>
                  {candidatePdfUrl ? (
                    <a
                      href={candidatePdfUrl.href}
                      target="_blank"
                      rel="noopener noreferrer external"
                      referrerPolicy="no-referrer"
                      title={`Open the source-asserted PDF location at ${candidatePdfUrl.origin}`}
                    >
                      <span>{candidatePdfUrl.href}</span>
                      <ExternalLink size={11} aria-hidden="true" />
                    </a>
                  ) : entry.paper.access?.pdfUrl ? (
                    "Withheld because the asserted address is not an eligible HTTPS URL"
                  ) : (
                    "No PDF location asserted"
                  )}
                </dd>
              </div>
            </dl>
          </section>
        </div>

        <aside className="webmcp-review-docket" aria-labelledby={`webmcp-review-${entry.id}`}>
          <div className="webmcp-review-head">
            <ShieldCheck size={17} aria-hidden="true" />
            <div>
              <span className="micro-label">Human review</span>
              <h4 id={`webmcp-review-${entry.id}`}>File the assertion</h4>
            </div>
          </div>

          <div className="webmcp-custody-ledger" id={custodyId} aria-label="Custody contributed by this proposal">
            <div>
              <span>Metadata</span>
              <strong>Staged assertion</strong>
            </div>
            <div>
              <span>Proposal PDF bytes</span>
              <strong>None acquired</strong>
            </div>
            <div>
              <span>Reader effect</span>
              <strong>No access added</strong>
            </div>
          </div>

          <form
            className="webmcp-review-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (submitDisabled) return;
              if (challenge && hasUsableChallenge && onApprove) {
                void onApprove(approvalSelection, challenge);
                return;
              }
              if (onPrepare) {
                if (challenge) onDiscardReview?.(entry.id);
                void onPrepare(currentSelection);
              }
            }}
          >
            <label className="field-group" htmlFor={`webmcp-project-${entry.id}`}>
              <span className="field-label">Destination project</span>
              <select
                className="inbox-project-select"
                id={`webmcp-project-${entry.id}`}
                value={selectedProjectId}
                disabled={
                  !canApprove
                  || !onPrepare
                  || !projects.length
                  || anotherApprovalInFlight
                  || !eligibleStatus
                  || Boolean(challenge)
                }
                required
                onChange={(event) => {
                  if (challenge) onDiscardReview?.(entry.id);
                  onSelectProject(event.target.value);
                }}
              >
                {!projects.length ? <option value="">Create a project first</option> : null}
                {projects.map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.name} · {project.visibility}
                  </option>
                ))}
              </select>
            </label>

            <fieldset
              className="webmcp-duplicate-fieldset"
              disabled={
                !canApprove
                || !onPrepare
                || anotherApprovalInFlight
                || !eligibleStatus
                || Boolean(challenge)
              }
            >
              <legend className="field-label">Duplicate decision</legend>
              <label className="webmcp-duplicate-choice">
                <input
                  type="checkbox"
                  name={`webmcp-duplicate-${entry.id}`}
                  value="acknowledged"
                  checked={decisionAcknowledged}
                  required
                  onChange={(event) => setAcknowledgedDecision({
                    identity: decisionIdentity,
                    acknowledged: event.target.checked,
                  })}
                />
                <span>
                  <strong>
                    {duplicateDecision.kind === "use_existing"
                      ? "I confirm: use the matched canonical record"
                      : "I confirm: create a new workspace record"}
                  </strong>
                  <small>
                    {duplicateDecision.kind === "use_existing"
                      ? entry.duplicateCandidate?.title ?? `Canonical paper ${duplicateDecision.canonicalPaperId}`
                      : "No canonical identifier match was supplied with this proposal."}
                  </small>
                </span>
              </label>
              <p>
                {duplicateDecision.kind === "use_existing"
                  ? "The asserted identifiers already resolve to this canonical record; a separate copy is not an eligible approval choice."
                  : "PaperPilot found no canonical match, so approval creates the workspace record before adding it to the project."}
              </p>
            </fieldset>

            <div className="webmcp-custody-note">
              <LockKeyhole size={15} aria-hidden="true" />
              <p>
                <strong>Approval files metadata only.</strong>{" "}
                This WebMCP proposal contributed no PDF bytes or Reader text, and approval grants no Reader access. Custody already attached to an existing canonical record is not represented in this dossier.
              </p>
            </div>

            {challenge ? (
              <section
                className={`webmcp-evidence-challenge${challengeExpired ? " is-expired" : ""}`}
                aria-labelledby={`webmcp-evidence-${entry.id}`}
              >
                <div className="webmcp-evidence-heading">
                  <div>
                    <span className="micro-label">Independent authority evidence</span>
                    <h5 id={`webmcp-evidence-${entry.id}`}>
                      {authorityLabels[challenge.evidence.authority]}
                    </h5>
                  </div>
                  <span className="webmcp-evidence-state">
                    {finalOutcomeUnknown
                      ? "Outcome unknown"
                      : challengeExpired
                        ? "Expired"
                        : challengeMatches
                          ? "Ready for consent"
                          : "Intent changed"}
                  </span>
                </div>

                <dl className="webmcp-evidence-ledger">
                  <div>
                    <dt>Authority</dt>
                    <dd>{challenge.evidence.authority}</dd>
                  </div>
                  <div>
                    <dt>Authority version</dt>
                    <dd>{challenge.evidence.authorityVersion}</dd>
                  </div>
                  <div>
                    <dt>Evidence expires exactly</dt>
                    <dd><time dateTime={challenge.expiresAt}>{challenge.expiresAt}</time></dd>
                  </div>
                  <div>
                    <dt>Evidence digest</dt>
                    <dd><code>{challenge.evidence.evidenceDigest}</code></dd>
                  </div>
                </dl>

                <details className="webmcp-evidence-snapshot" open>
                  <summary>Exact authority snapshot · read only</summary>
                  <pre>{JSON.stringify(challenge.evidence.verifiedSnapshot, null, 2)}</pre>
                </details>

                {finalOutcomeUnknown ? (
                  <p className="webmcp-evidence-warning" role="status">
                    PaperPilot did not receive a trustworthy final response. Retry sends the same operation ID and the exact same schema-v2 bytes; it will not prepare different evidence.
                  </p>
                ) : challengeExpired ? (
                  <p className="webmcp-evidence-warning" role="status">
                    This evidence capability expired. Preparing again will independently verify the current filing intent and show a fresh exact snapshot.
                  </p>
                ) : !challengeMatches ? (
                  <p className="webmcp-evidence-warning" role="status">
                    The proposal, project, or duplicate decision changed. This challenge cannot authorize the new intent.
                  </p>
                ) : (
                  <label className="webmcp-evidence-confirmation">
                    <input
                      type="checkbox"
                      checked={evidenceAcknowledged}
                      onChange={(event) => setAcknowledgedEvidence({
                        identity: evidenceIdentity,
                        acknowledged: event.target.checked,
                      })}
                    />
                    <span>
                      <strong>I reviewed this exact authority snapshot.</strong>
                      <small>I consent to file only the metadata bound to this evidence digest and destination.</small>
                    </span>
                  </label>
                )}

                {!finalOutcomeUnknown ? (
                  <button
                    className="button subtle full webmcp-change-review"
                    type="button"
                    disabled={isPreparing || isApproving}
                    onClick={() => onDiscardReview?.(entry.id)}
                  >
                    Change filing choices
                  </button>
                ) : null}
              </section>
            ) : null}

            {reviewError ? (
              <p className="webmcp-review-error" id={reviewErrorId} role="alert">
                <AlertTriangle size={13} aria-hidden="true" /> {reviewError}
              </p>
            ) : null}

            {!canApprove || !onPrepare || !onApprove ? (
              <p className="webmcp-review-unavailable" id={reviewHelpId} role="status">
                A workspace editor, administrator, or owner must approve this proposal through the reviewed filing command.
              </p>
            ) : !eligibleStatus ? (
              <p className="webmcp-review-unavailable" id={reviewHelpId} role="status">
                This proposal is not awaiting approval. Its current state is {statusLabels[entry.status].toLowerCase()}.
              </p>
            ) : anotherApprovalInFlight && !isApproving && !isPreparing ? (
              <p className="webmcp-review-unavailable" id={reviewHelpId} role="status">
                Another proposal approval is being resolved. This review will unlock when that request finishes or times out.
              </p>
            ) : null}

            <button
              className="button primary full webmcp-approve-button"
              type="submit"
              disabled={submitDisabled}
              aria-describedby={[
                custodyId,
                reviewError ? reviewErrorId : "",
                !canApprove || !onPrepare || !onApprove
                  || (!eligibleStatus && !finalOutcomeUnknown)
                  || (anotherApprovalInFlight && !isApproving && !isPreparing)
                  ? reviewHelpId
                  : "",
              ].filter(Boolean).join(" ") || undefined}
            >
              {isApproving
                ? <LoaderCircle className="auth-spinner" size={14} aria-hidden="true" />
                : isPreparing
                  ? <LoaderCircle className="auth-spinner" size={14} aria-hidden="true" />
                : <ShieldCheck size={14} aria-hidden="true" />}
              {isApproving
                ? "Submitting exact consent…"
                : isPreparing
                  ? "Verifying authority evidence…"
                  : finalOutcomeUnknown
                    ? "Retry exact approval attempt"
                    : challenge && hasUsableChallenge
                      ? "Approve exact evidence and file metadata"
                      : challengeExpired || (challenge && !challengeMatches)
                        ? "Prepare fresh authority evidence"
                        : "Prepare authority evidence"}
            </button>
            <p className="webmcp-review-fineprint">
              Preparation changes no project. Final approval is one-use and bound to the proposal fingerprint, destination, duplicate decision, authority snapshot, and expiry shown above.
            </p>
          </form>
        </aside>
      </div>
    </article>
  );
}

export function InboxView({
  entries,
  canLinkDocuments = true,
  papers = [],
  projects,
  onChooseProject,
  onLinkDocument = () => undefined,
  onOpenReader = () => undefined,
  onOpenSources,
  onOpenDiscover,
  filingEntryId,
  linkingDocumentId,
  canApproveWebMcp = false,
  preparingWebMcpEntryId,
  approvingWebMcpEntryId,
  webMcpApprovalReviews = {},
  webMcpReviewErrors = {},
  onPrepareWebMcp,
  onApproveWebMcp,
  onDiscardWebMcpReview,
}: InboxViewProps) {
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [paperLinks, setPaperLinks] = useState<Record<string, string>>({});
  const actionableCount = entries.filter((entry) =>
    ["awaiting-review", "possible-duplicate", "blocked"].includes(entry.status)
      || (isDocumentUploadInboxEntry(entry)
        && entry.upload.stage === "ready"
        && !entry.upload.linkedPaperId)
      || (isCrawlerDocumentInboxEntry(entry)
        && entry.crawler.stage === "ready"
        && !entry.crawler.linkedPaperId),
  ).length;
  const duplicateCount = entries.filter((entry) => entry.status === "possible-duplicate").length;
  const processingCount = entries.filter((entry) => entry.status === "processing").length;
  const sourceCount = new Set(entries.map((entry) => entry.sourceKind)).size;

  return (
    <section className="view inbox-view" aria-labelledby="inbox-title">
      <div className="view-header">
        <div>
          <span className="eyebrow">Research inbox</span>
          <h1 className="view-title" id="inbox-title">Review incoming papers</h1>
          <p className="view-subtitle">
            Imports pause here before they change a project, so you can inspect provenance, resolve versions, and choose a destination.
          </p>
        </div>
        <div className="button-group" aria-label="Inbox actions">
          <button className="button" type="button" onClick={onOpenDiscover}>
            <Search size={14} aria-hidden="true" /> Discover papers
          </button>
          <button className="button primary" type="button" onClick={onOpenSources}>
            <FileUp size={14} aria-hidden="true" /> Add papers
          </button>
        </div>
      </div>

      <div className="status-strip inbox-status-strip" aria-label="Inbox totals">
        <div className="status-cell"><strong>{actionableCount}</strong><span>Awaiting review</span></div>
        <div className="status-cell"><strong>{duplicateCount}</strong><span>Possible duplicates</span></div>
        <div className="status-cell"><strong>{processingCount}</strong><span>Processing</span></div>
        <div className="status-cell"><strong>{sourceCount}</strong><span>Import sources</span></div>
      </div>

      {entries.length ? (
        <section className="panel inbox-panel" aria-labelledby="inbox-list-title">
          <header className="panel-header">
            <h2 className="panel-title" id="inbox-list-title">Staged records</h2>
            <span className="micro-label">Import history stays visible</span>
          </header>
          <div className="inbox-list">
            {entries.map((entry) => {
              const SourceIcon = sourceIcons[entry.sourceKind];
              const StatusIcon = statusIcons[entry.status];
              const titleId = `inbox-entry-${entry.id}`;

              if (isDocumentUploadInboxEntry(entry)) {
                const isLinkEligible = entry.upload.stage === "ready"
                  && !entry.upload.linkedPaperId;
                const selectedPaperId = paperLinks[entry.upload.documentId]
                  ?? papers[0]?.id
                  ?? "";
                const isLinking = linkingDocumentId === entry.upload.documentId;
                const linkedPaper = entry.upload.linkedPaperId
                  ? papers.find((paper) => paper.id === entry.upload.linkedPaperId)
                  : undefined;
                const uploadState = uploadDisplayState(entry);
                const uploadChipStatus: InboxEntryStatus = entry.upload.linkedPaperId
                  ? entry.upload.extractionStage === "ready"
                    ? "ready"
                    : entry.upload.extractionStage === "no-text"
                      || entry.upload.extractionStage === "failed"
                      ? "blocked"
                      : "processing"
                  : entry.status;
                const UploadStatusIcon = statusIcons[uploadChipStatus];
                return (
                  <article
                    className="inbox-row inbox-row-document-upload"
                    aria-labelledby={titleId}
                    key={entry.id}
                  >
                    <span className="inbox-source-icon" aria-hidden="true">
                      <SourceIcon size={16} />
                    </span>
                    <div className="inbox-row-copy inbox-upload-summary">
                      <div className="inbox-row-heading">
                        <h3 id={titleId}>{entry.upload.fileName}</h3>
                        <span className={`status-chip inbox-status inbox-status-${uploadChipStatus}`}>
                          <UploadStatusIcon size={10} aria-hidden="true" />
                          {uploadState}
                        </span>
                      </div>
                      <p>
                        Authenticated PDF upload · {formatStagedAt(entry.createdAt)} · {formatBytes(entry.upload.expectedSizeBytes)}
                      </p>
                      <div className="tag-row" aria-label="Upload metadata">
                        <span className="tag">PDF</span>
                        <span className="tag">{uploadCustodyLabels[entry.upload.stage]}</span>
                        {linkedPaper ? <span className="tag">Linked · {linkedPaper.shortTitle}</span> : null}
                        {entry.upload.receivedSizeBytes !== undefined ? (
                          <span className="tag">{formatBytes(entry.upload.receivedSizeBytes)} received</span>
                        ) : null}
                      </div>
                      {entry.failure ? (
                        <p className="inbox-warning" role="alert">{entry.failure.message}</p>
                      ) : (
                        <p className="inbox-upload-boundary">
                          {uploadBoundaryMessage(entry)}
                        </p>
                      )}
                    </div>
                    <div className="inbox-row-actions inbox-upload-state" aria-label="Upload custody and link state">
                      {isLinkEligible && canLinkDocuments ? (
                        <>
                          <label className="field-group" htmlFor={`upload-paper-${entry.upload.documentId}`}>
                            <span className="field-label">Link to existing paper</span>
                            <select
                              className="inbox-project-select"
                              id={`upload-paper-${entry.upload.documentId}`}
                              value={selectedPaperId}
                              disabled={!papers.length || isLinking}
                              onChange={(event) => setPaperLinks((current) => ({
                                ...current,
                                [entry.upload.documentId]: event.target.value,
                              }))}
                            >
                              {!papers.length ? <option value="">No workspace papers available</option> : null}
                              {papers.map((paper) => (
                                <option value={paper.id} key={paper.id}>{paper.shortTitle}</option>
                              ))}
                            </select>
                          </label>
                          <button
                            className="button primary"
                            type="button"
                            disabled={!selectedPaperId || Boolean(linkingDocumentId)}
                            onClick={() => onLinkDocument(entry.upload.documentId, selectedPaperId)}
                          >
                            {isLinking
                              ? <LoaderCircle className="auth-spinner" size={13} aria-hidden="true" />
                              : <Link2 size={13} aria-hidden="true" />}
                            {isLinking ? "Linking…" : "Link validated PDF"}
                          </button>
                          <span className="inbox-link-note">
                            This creates an explicit, durable source link. It does not infer paper metadata from the filename.
                          </span>
                        </>
                      ) : entry.upload.linkedPaperId ? (
                        <>
                          <span className="micro-label">Linked document</span>
                          <strong>{linkedPaper?.shortTitle ?? "Visible workspace paper"}</strong>
                          <span>{uploadState}</span>
                          {entry.upload.readerAvailable ? (
                            <button
                              className="button primary"
                              type="button"
                              onClick={() => onOpenReader(entry.upload.linkedPaperId!)}
                            >
                              <BookOpenText size={13} aria-hidden="true" /> Open Reader
                            </button>
                          ) : null}
                        </>
                      ) : isLinkEligible ? (
                        <>
                          <span className="micro-label">Validated document</span>
                          <strong>Editor link required</strong>
                          <span>
                            You can read linked sources, but an editor, administrator, or owner must link this PDF to a workspace paper.
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="micro-label">Document state</span>
                          <strong>{uploadState}</strong>
                          <span>Linking and Reader remain locked until validation is complete.</span>
                        </>
                      )}
                    </div>
                  </article>
                );
              }

              if (isCrawlerDocumentInboxEntry(entry)) {
                const isLinkEligible = entry.crawler.stage === "ready"
                  && !entry.crawler.linkedPaperId;
                const selectedPaperId = paperLinks[entry.crawler.documentId]
                  ?? papers[0]?.id
                  ?? "";
                const isLinking = linkingDocumentId === entry.crawler.documentId;
                const linkedPaper = entry.crawler.linkedPaperId
                  ? papers.find((paper) => paper.id === entry.crawler.linkedPaperId)
                  : undefined;
                const crawlerState = crawlerDisplayState(entry);
                const crawlerChipStatus: InboxEntryStatus = entry.crawler.linkedPaperId
                  ? entry.crawler.extractionStage === "ready"
                    ? "ready"
                    : entry.crawler.extractionStage === "no-text"
                      || entry.crawler.extractionStage === "failed"
                      ? "blocked"
                      : "processing"
                  : entry.status;
                const CrawlerStatusIcon = statusIcons[crawlerChipStatus];
                return (
                  <article
                    className="inbox-row inbox-row-document-upload"
                    aria-labelledby={titleId}
                    key={entry.id}
                  >
                    <span className="inbox-source-icon" aria-hidden="true">
                      <SourceIcon size={16} />
                    </span>
                    <div className="inbox-row-copy inbox-upload-summary">
                      <div className="inbox-row-heading">
                        <h3 id={titleId}>{entry.crawler.fileName}</h3>
                        <span className={`status-chip inbox-status inbox-status-${crawlerChipStatus}`}>
                          <CrawlerStatusIcon size={10} aria-hidden="true" />
                          {crawlerState}
                        </span>
                      </div>
                      <p>Governed crawler PDF · {formatStagedAt(entry.createdAt)}</p>
                      <div className="tag-row" aria-label="Governed document metadata">
                        <span className="tag">PDF</span>
                        <span className="tag">URL withheld</span>
                        <span className="tag">Private document pipeline</span>
                        {linkedPaper ? <span className="tag">Linked · {linkedPaper.shortTitle}</span> : null}
                      </div>
                      {entry.failure ? (
                        <p className="inbox-warning" role="alert">{entry.failure.message}</p>
                      ) : (
                        <p className="inbox-upload-boundary">{crawlerBoundaryMessage(entry)}</p>
                      )}
                    </div>
                    <div className="inbox-row-actions inbox-upload-state" aria-label="Governed document custody and link state">
                      {isLinkEligible && canLinkDocuments ? (
                        <>
                          <label className="field-group" htmlFor={`crawler-paper-${entry.crawler.documentId}`}>
                            <span className="field-label">Link to existing paper</span>
                            <select
                              className="inbox-project-select"
                              id={`crawler-paper-${entry.crawler.documentId}`}
                              value={selectedPaperId}
                              disabled={!papers.length || isLinking}
                              onChange={(event) => setPaperLinks((current) => ({
                                ...current,
                                [entry.crawler.documentId]: event.target.value,
                              }))}
                            >
                              {!papers.length ? <option value="">No workspace papers available</option> : null}
                              {papers.map((paper) => (
                                <option value={paper.id} key={paper.id}>{paper.shortTitle}</option>
                              ))}
                            </select>
                          </label>
                          <button
                            className="button primary"
                            type="button"
                            disabled={!selectedPaperId || Boolean(linkingDocumentId)}
                            onClick={() => onLinkDocument(entry.crawler.documentId, selectedPaperId)}
                          >
                            {isLinking
                              ? <LoaderCircle className="auth-spinner" size={13} aria-hidden="true" />
                              : <Link2 size={13} aria-hidden="true" />}
                            {isLinking ? "Linking…" : "Link validated PDF"}
                          </button>
                          <span className="inbox-link-note">
                            This links the attested governed document without exposing its private source URL or inventing metadata from the filename.
                          </span>
                        </>
                      ) : entry.crawler.linkedPaperId ? (
                        <>
                          <span className="micro-label">Linked document</span>
                          <strong>{linkedPaper?.shortTitle ?? "Visible workspace paper"}</strong>
                          <span>{crawlerState}</span>
                          {entry.crawler.readerAvailable ? (
                            <button
                              className="button primary"
                              type="button"
                              onClick={() => onOpenReader(entry.crawler.linkedPaperId!)}
                            >
                              <BookOpenText size={13} aria-hidden="true" /> Open Reader
                            </button>
                          ) : null}
                        </>
                      ) : isLinkEligible ? (
                        <>
                          <span className="micro-label">Validated document</span>
                          <strong>Editor link required</strong>
                          <span>An editor, administrator, or owner must link this governed PDF to a workspace paper.</span>
                        </>
                      ) : (
                        <>
                          <span className="micro-label">Document state</span>
                          <strong>{crawlerState}</strong>
                          <span>Linking and Reader remain locked until the governed request is ready.</span>
                        </>
                      )}
                    </div>
                  </article>
                );
              }

              if (isWebMcpInboxEntry(entry)) {
                const selectedProjectId = destinations[entry.id]
                  ?? entry.destinationProjectId
                  ?? projects[0]?.id
                  ?? "";
                return (
                  <WebMcpDossier
                    key={[
                      entry.id,
                      entry.proposalDigest,
                      entry.duplicateOfPaperId ?? "create-new",
                      entry.duplicateCandidate?.id ?? "no-candidate",
                    ].join(":")}
                    entry={entry}
                    projects={projects}
                    selectedProjectId={selectedProjectId}
                    canApprove={canApproveWebMcp}
                    isPreparing={preparingWebMcpEntryId === entry.id}
                    isApproving={approvingWebMcpEntryId === entry.id}
                    anotherApprovalInFlight={Boolean(
                      preparingWebMcpEntryId || approvingWebMcpEntryId,
                    )}
                    review={webMcpApprovalReviews[entry.id]}
                    reviewError={webMcpReviewErrors[entry.id]}
                    onSelectProject={(projectId) => setDestinations((current) => ({
                      ...current,
                      [entry.id]: projectId,
                    }))}
                    onPrepare={onPrepareWebMcp}
                    onApprove={onApproveWebMcp}
                    onDiscardReview={onDiscardWebMcpReview}
                  />
                );
              }

              // Runtime defense in depth: a malformed WebMCP-shaped object
              // must never inherit the ordinary Inbox filing controls merely
              // because it failed the strict digest-bearing type guard.
              if ((entry as { sourceKind?: unknown }).sourceKind === "webmcp") {
                return (
                  <article
                    className="webmcp-dossier"
                    aria-labelledby={titleId}
                    key={`invalid-webmcp:${entry.id}`}
                  >
                    <header className="webmcp-dossier-head">
                      <span className="webmcp-source-seal" aria-hidden="true">
                        <AlertTriangle size={18} />
                      </span>
                      <div className="webmcp-dossier-heading">
                        <div className="webmcp-dossier-kicker">
                          <span>WebMCP source dossier</span>
                          <span>Authority unavailable</span>
                        </div>
                        <h3 id={titleId}>{entry.paper.title}</h3>
                        <p className="webmcp-byline">
                          This proposal could not be decoded as a digest-bound server record.
                        </p>
                      </div>
                    </header>
                    <p className="webmcp-review-unavailable" role="alert">
                      Filing is disabled. Refresh the Inbox; if this record remains, ask an administrator to inspect its stored proposal authority.
                    </p>
                  </article>
                );
              }

              const selectedProjectId = destinations[entry.id]
                ?? entry.destinationProjectId
                ?? projects[0]?.id
                ?? "";
              const cannotFile = entry.status === "processing" || entry.status === "blocked";
              const isFiling = filingEntryId === entry.id;

              return (
                <article className="inbox-row" aria-labelledby={titleId} key={entry.id}>
                  <span className="inbox-source-icon" aria-hidden="true">
                    <SourceIcon size={16} />
                  </span>
                  <div className="inbox-row-copy">
                    <div className="inbox-row-heading">
                      <h3 id={titleId}>{entry.paper.title}</h3>
                      <span className={`status-chip inbox-status inbox-status-${entry.status}`}>
                        <StatusIcon size={10} aria-hidden="true" /> {statusLabels[entry.status]}
                      </span>
                    </div>
                    <p>
                      {sourceLabels[entry.sourceKind]} · {entry.provenance.providerName} · {formatStagedAt(entry.createdAt)}
                    </p>
                    <div className="tag-row" aria-label="Paper metadata">
                      <span className="tag">{entry.paper.year}</span>
                      <span className="tag">{entry.paper.type}</span>
                      {entry.provenance.version ? <span className="tag">Version {entry.provenance.version}</span> : null}
                    </div>
                    {entry.status === "possible-duplicate" ? (
                      <p className="inbox-warning" role="status">
                        <AlertTriangle size={12} aria-hidden="true" /> A possible existing version needs review before filing.
                      </p>
                    ) : null}
                    {entry.status === "blocked" ? (
                      <p className="inbox-warning" role="alert">
                        This record needs source or metadata attention before it can enter a project.
                      </p>
                    ) : null}
                  </div>
                  <div className="inbox-row-actions">
                    <label className="field-group" htmlFor={`inbox-project-${entry.id}`}>
                      <span className="field-label">Destination project</span>
                      <select
                        className="inbox-project-select"
                        id={`inbox-project-${entry.id}`}
                        value={selectedProjectId}
                        disabled={!projects.length || cannotFile || isFiling}
                        onChange={(event) => setDestinations((current) => ({
                          ...current,
                          [entry.id]: event.target.value,
                        }))}
                      >
                        {!projects.length ? <option value="">Create a project first</option> : null}
                        {projects.map((project) => (
                          <option value={project.id} key={project.id}>{project.name}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="button primary"
                      type="button"
                      disabled={!selectedProjectId || cannotFile || Boolean(filingEntryId)}
                      onClick={() => onChooseProject(entry.id, selectedProjectId)}
                    >
                      {isFiling ? <LoaderCircle className="auth-spinner" size={13} /> : null}
                      {isFiling
                        ? "Filing…"
                        : entry.destinationProjectId ? "Add to project" : "Set destination"}
                      <ArrowRight size={13} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : (
        <div className="empty-state inbox-empty-state">
          <Inbox size={24} aria-hidden="true" />
          <strong>The inbox is clear.</strong>
          Search for a paper or upload a PDF to stage the next record.
          <div className="button-group">
            <button className="button" type="button" onClick={onOpenDiscover}>Open Discover</button>
            <button className="button primary" type="button" onClick={onOpenSources}>Browse sources</button>
          </div>
        </div>
      )}
    </section>
  );
}
