import "server-only";

import { randomBytes } from "node:crypto";

import type {
  ApproveWebMcpProposalResult,
  WorkspaceCommandFailure,
  WorkspaceCommandResult,
} from "@/lib/workspace";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveLiveRetainedAuditPrincipal } from "@/server/audit/retained-principal";
import { HttpProblem } from "@/server/http/problem";
import {
  paperInboxEntryDto,
  type InboxEntryForDto,
} from "@/server/workspaces/import-dto";
import type { ImportSessionUser } from "@/server/workspaces/import-service";
import {
  inboxEntryVisibleTo,
  projectVisibleTo,
  requireWorkspaceMutationRole,
  workspacePaperVisibleTo,
} from "@/server/workspaces/project-access";
import { acquireWorkspaceMembershipAuthorityShared } from "@/server/workspaces/membership-lock";
import { paperDto, projectDto } from "@/server/workspaces/service";
import {
  parseWebMcpApprovalCommand,
  parseWebMcpApprovalPreparationCommand,
  type HistoricalWebMcpApprovalCommandV1,
  type WebMcpApprovalCommand,
  type WebMcpApprovalPreparationCommand,
} from "./approval-contract";
import {
  isOpenAlexVerifiedCanonicalSnapshot,
  OpenAlexWebMcpVerifier,
  webMcpVerificationEvidenceDigest,
  type OpenAlexVerifiedCanonicalSnapshot,
  type WebMcpCanonicalVerifier,
} from "./openalex-verifier";
import {
  isServerManagedWebMcpSnapshot,
  webMcpSnapshotDigest,
  type ServerManagedWebMcpSnapshot,
} from "./snapshot-contract";

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const APPROVAL_CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const MAX_TRANSACTION_ATTEMPTS = 4;
const APPROVAL_COMMAND = "approveWebMcpProposal";
const FILEABLE_WEB_MCP_STATUSES = new Set(["PENDING", "DUPLICATE"]);

interface ApprovalServiceOptions {
  verifier?: WebMcpCanonicalVerifier;
}

type ApprovalResult = WorkspaceCommandResult<ApproveWebMcpProposalResult>;

export interface WebMcpApprovalEvidenceDossier {
  schemaVersion: 1;
  challengeId: string;
  expiresAt: string;
  expectedVersion: number;
  inboxEntryId: string;
  proposalDigest: string;
  destinationProjectId: string;
  duplicateDecision: WebMcpApprovalCommand["duplicateDecision"];
  evidence: {
    authority: PreparedAuthority["kind"];
    authorityVersion: string;
    evidenceDigest: string;
    verifiedSnapshot: PreparedAuthority["verifiedSnapshot"];
  };
}

export interface PrepareWebMcpApprovalResult {
  challenge: WebMcpApprovalEvidenceDossier;
}

export type PrepareWebMcpApprovalResponse = WorkspaceCommandResult<
  PrepareWebMcpApprovalResult
>;

type PreparedAuthority =
  | {
      kind: "OPENALEX";
      authorityVersion: string;
      evidenceDigest: string;
      verifiedSnapshot: OpenAlexVerifiedCanonicalSnapshot;
    }
  | {
      kind: "HUMAN_REVIEW";
      authorityVersion: "human-review-v1";
      evidenceDigest: string;
      verifiedSnapshot: {
        schemaVersion: 1;
        kind: "human_review_identifier_free";
        authority: "HUMAN_REVIEW";
        authorityVersion: "human-review-v1";
        proposalDigest: string;
        evidenceDigest: string;
      };
    }
  | {
      kind: "EXISTING_CANONICAL";
      authorityVersion: "existing-canonical-v1";
      evidenceDigest: string;
      verifiedSnapshot: {
        schemaVersion: 1;
        kind: "existing_canonical";
        authority: "EXISTING_CANONICAL";
        authorityVersion: "existing-canonical-v1";
        proposalDigest: string;
        canonicalPaperId: string;
        evidenceDigest: string;
      };
    };

function failure(
  code: WorkspaceCommandFailure["code"],
  aggregateVersion: number,
  message: string,
): WorkspaceCommandFailure {
  return { ok: false, code, aggregateVersion, message };
}

function requestHash(
  command: WebMcpApprovalCommand | HistoricalWebMcpApprovalCommandV1,
): string {
  return webMcpVerificationEvidenceDigest({ command: APPROVAL_COMMAND, payload: command });
}

function replayedResult(
  response: unknown,
): ApprovalResult | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const candidate = response as {
    ok?: unknown;
    aggregateVersion?: unknown;
    data?: ApproveWebMcpProposalResult;
  };
  if (
    candidate.ok !== true
    || !candidate.data
    || typeof candidate.aggregateVersion !== "number"
    || !Number.isSafeInteger(candidate.aggregateVersion)
    || candidate.aggregateVersion < 0
  ) return null;
  return {
    ok: true,
    outcome: "replayed",
    aggregateVersion: candidate.aggregateVersion,
    data: candidate.data,
  };
}

async function replayHistoricalV1Approval(
  user: ImportSessionUser,
  workspaceId: string,
  command: HistoricalWebMcpApprovalCommandV1,
): Promise<ApprovalResult> {
  const membership = await prisma.member.findUnique({
    where: { organizationId_userId: { organizationId: workspaceId, userId: user.id } },
    include: { organization: true },
  });
  if (!membership) throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
  requireWorkspaceMutationRole(membership.role);

  const prior = await prisma.idempotencyRecord.findUnique({
    where: { organizationId_key: { organizationId: workspaceId, key: command.clientOperationId } },
  });
  const hash = requestHash(command);
  if (prior) {
    if (
      prior.actorUserId !== user.id
      || prior.command !== APPROVAL_COMMAND
      || prior.requestHash !== hash
    ) {
      return failure(
        "idempotency_conflict",
        membership.organization.revision,
        "clientOperationId was already used for a different command.",
      );
    }
    const replay = replayedResult(prior.response);
    if (replay) return replay;
  }
  throw new HttpProblem(
    409,
    "webmcp_approval_challenge_required",
    "Approval schema v1 is closed. Prepare a provider-evidence challenge and submit schema v2 consent.",
  );
}

function retryableTransactionError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2002" || error.code === "P2034");
}

async function withTransactionRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!retryableTransactionError(error) || attempt === MAX_TRANSACTION_ATTEMPTS) {
        if (retryableTransactionError(error)) {
          throw new HttpProblem(
            409,
            "concurrent_webmcp_approval_conflict",
            "Another reviewer resolved this proposal concurrently. Refresh before retrying.",
          );
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 8));
    }
  }
  throw new HttpProblem(409, "concurrent_webmcp_approval_conflict", "Approval could not be resolved safely.");
}

function approvalInboxInclude() {
  return {
    provenanceRecords: {
      select: {
        kind: true,
        paperId: true,
        documentId: true,
        payloadDigest: true,
        payload: true,
        paper: {
          select: {
            id: true,
            title: true,
            publicationYear: true,
            venueName: true,
            workType: true,
            authors: { select: { position: true, displayName: true } },
            identifiers: { select: { type: true, value: true } },
          },
        },
      },
    },
  } as const;
}

function projectInclude(workspaceId: string) {
  return {
    papers: {
      where: {
        organizationId: workspaceId,
        workspacePaper: { organizationId: workspaceId },
      },
      include: { workspacePaper: { select: { paperId: true } } },
    },
    evidenceNotes: {
      where: { organizationId: workspaceId },
      select: { id: true, supersedesId: true },
    },
    evidenceMemberships: {
      where: { organizationId: workspaceId },
      select: {
        evidenceNoteId: true,
        evidenceNote: { select: { id: true, supersedesId: true } },
      },
    },
    collections: { where: { organizationId: workspaceId }, select: { id: true } },
  } as const;
}

function stagedSnapshot(
  entry: {
    source: string;
    status: string;
    documentId: string | null;
    payload: unknown;
    provenanceRecords: Array<{
      kind: string;
      paperId: string | null;
      documentId: string | null;
      payloadDigest: string | null;
      payload: unknown;
    }>;
  },
  proposalDigest: string,
): ServerManagedWebMcpSnapshot | WorkspaceCommandFailure {
  if (
    entry.source !== "WEB_MCP"
    || !FILEABLE_WEB_MCP_STATUSES.has(entry.status)
    || entry.documentId !== null
    || entry.provenanceRecords.some((record) => record.documentId !== null)
  ) {
    return failure("validation", 0, "This WebMCP proposal is not awaiting review.");
  }
  if (!isServerManagedWebMcpSnapshot(entry.payload)) {
    throw new HttpProblem(500, "invalid_webmcp_snapshot", "Stored WebMCP proposal authority is invalid.");
  }
  const computedDigest = webMcpSnapshotDigest(entry.payload);
  if (computedDigest !== proposalDigest) {
    return failure(
      "validation",
      0,
      "The proposal changed or the review digest is stale. Refresh before approving.",
    );
  }
  const authorities = entry.provenanceRecords.filter((record) => record.kind === "WEB_MCP");
  if (
    authorities.length !== 1
    || authorities[0].payloadDigest !== proposalDigest
    || !isServerManagedWebMcpSnapshot(authorities[0].payload)
    || webMcpSnapshotDigest(authorities[0].payload) !== proposalDigest
  ) {
    throw new HttpProblem(
      500,
      "invalid_webmcp_authority",
      "Stored WebMCP provenance does not match the staged proposal.",
    );
  }
  return entry.payload;
}

function withAggregateVersion(
  result: ServerManagedWebMcpSnapshot | WorkspaceCommandFailure,
  aggregateVersion: number,
): ServerManagedWebMcpSnapshot | WorkspaceCommandFailure {
  return "ok" in result && result.ok === false
    ? { ...result, aggregateVersion }
    : result;
}

function isFailure(
  value: ServerManagedWebMcpSnapshot | WorkspaceCommandFailure,
): value is WorkspaceCommandFailure {
  return "ok" in value && value.ok === false;
}

function humanReviewAuthority(proposalDigest: string): PreparedAuthority {
  const evidence = {
    schemaVersion: 1 as const,
    kind: "human_review_identifier_free" as const,
    authority: "HUMAN_REVIEW" as const,
    authorityVersion: "human-review-v1" as const,
    proposalDigest,
  };
  const evidenceDigest = webMcpVerificationEvidenceDigest(evidence);
  const verifiedSnapshot = { ...evidence, evidenceDigest };
  return {
    kind: "HUMAN_REVIEW",
    authorityVersion: "human-review-v1",
    evidenceDigest,
    verifiedSnapshot,
  };
}

function existingCanonicalAuthority(
  proposalDigest: string,
  canonicalPaperId: string,
): PreparedAuthority {
  const evidence = {
    schemaVersion: 1 as const,
    kind: "existing_canonical" as const,
    authority: "EXISTING_CANONICAL" as const,
    authorityVersion: "existing-canonical-v1" as const,
    proposalDigest,
    canonicalPaperId,
  };
  const evidenceDigest = webMcpVerificationEvidenceDigest(evidence);
  const verifiedSnapshot = { ...evidence, evidenceDigest };
  return {
    kind: "EXISTING_CANONICAL",
    authorityVersion: "existing-canonical-v1",
    evidenceDigest,
    verifiedSnapshot,
  };
}

function verificationFailure(
  reason: Exclude<Awaited<ReturnType<WebMcpCanonicalVerifier["verify"]>>, { ok: true }>["reason"],
  aggregateVersion: number,
): WorkspaceCommandFailure {
  switch (reason) {
    case "not_configured":
      throw new HttpProblem(
        503,
        "openalex_not_configured",
        "OpenAlex identifier verification is not configured for this deployment.",
      );
    case "unsupported_identifier":
      return failure(
        "validation",
        aggregateVersion,
        "This proposal has identifiers, but none can be verified by the supported DOI/OpenAlex authority.",
      );
    case "not_found":
      return failure(
        "validation",
        aggregateVersion,
        "OpenAlex could not verify a scholarly work for the staged identifier.",
      );
    case "identifier_mismatch":
    case "proposal_mismatch":
      return failure(
        "validation",
        aggregateVersion,
        "The staged proposal does not match the independently verified scholarly record.",
      );
    case "provider_response_invalid":
      throw new HttpProblem(
        502,
        "openalex_response_invalid",
        "OpenAlex returned an invalid verification response. Retry before approving this proposal.",
      );
    case "provider_unavailable":
      throw new HttpProblem(
        503,
        "openalex_unavailable",
        "OpenAlex verification is temporarily unavailable. Retry before approving this proposal.",
      );
  }
}

function publicVerifiedIdentifiers(authority: PreparedAuthority) {
  if (authority.kind !== "OPENALEX") return [];
  return authority.verifiedSnapshot.paper.identifiers.map((identifier) => ({
    scheme: identifier.type === "DOI" ? "doi" as const : "provider" as const,
    value: identifier.type === "DOI" ? identifier.value : `openalex:${identifier.value}`,
    authority: "openalex" as const,
    evidenceDigest: authority.evidenceDigest,
  }));
}

function exactObjectKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && [...expected].sort().every((key, index) => keys[index] === key);
}

function preparedAuthorityIsClosed(authority: PreparedAuthority): boolean {
  if (authority.kind === "OPENALEX") {
    return authority.authorityVersion === "works-singleton-v1"
      && authority.evidenceDigest === authority.verifiedSnapshot.evidenceDigest
      && isOpenAlexVerifiedCanonicalSnapshot(authority.verifiedSnapshot);
  }
  const snapshot = authority.verifiedSnapshot;
  if (authority.kind === "HUMAN_REVIEW") {
    if (!exactObjectKeys(snapshot, [
      "schemaVersion", "kind", "authority", "authorityVersion", "proposalDigest", "evidenceDigest",
    ])) return false;
  } else if (!exactObjectKeys(snapshot, [
    "schemaVersion", "kind", "authority", "authorityVersion", "proposalDigest",
    "canonicalPaperId", "evidenceDigest",
  ])) return false;
  const { evidenceDigest, ...evidence } = snapshot;
  return evidenceDigest === authority.evidenceDigest
    && webMcpVerificationEvidenceDigest(evidence) === authority.evidenceDigest;
}

function preparedAuthorityFromStoredChallenge(value: {
  verificationAuthority: string;
  verificationAuthorityVersion: string;
  verificationEvidenceDigest: string;
  verifiedSnapshot: unknown;
}): PreparedAuthority | null {
  if (
    value.verificationAuthority !== "OPENALEX"
    && value.verificationAuthority !== "HUMAN_REVIEW"
    && value.verificationAuthority !== "EXISTING_CANONICAL"
  ) return null;
  const candidate = {
    kind: value.verificationAuthority,
    authorityVersion: value.verificationAuthorityVersion,
    evidenceDigest: value.verificationEvidenceDigest,
    verifiedSnapshot: value.verifiedSnapshot,
  } as PreparedAuthority;
  return preparedAuthorityIsClosed(candidate) ? candidate : null;
}

async function initialPreparationAuthorization(
  user: ImportSessionUser,
  workspaceId: string,
  command: WebMcpApprovalPreparationCommand,
): Promise<
  | { result: WorkspaceCommandFailure }
  | {
      aggregateVersion: number;
      snapshot: ServerManagedWebMcpSnapshot;
      stagedCanonicalPaperId?: string;
    }
> {
  const membership = await prisma.member.findUnique({
    where: { organizationId_userId: { organizationId: workspaceId, userId: user.id } },
    include: { organization: true },
  });
  if (!membership) throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
  requireWorkspaceMutationRole(membership.role);

  if (membership.organization.revision !== command.expectedVersion) {
    return {
      result: failure(
        "version_conflict",
        membership.organization.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      ),
    };
  }

  const entry = await prisma.inboxEntry.findFirst({
    where: { id: command.inboxEntryId, ...inboxEntryVisibleTo(user.id, workspaceId) },
    include: approvalInboxInclude(),
  });
  if (!entry) {
    return { result: failure("not_found", membership.organization.revision, "Inbox entry was not found.") };
  }
  const project = await prisma.project.findFirst({
    where: {
      id: command.destinationProjectId,
      organizationId: workspaceId,
      ...projectVisibleTo(user.id),
    },
    select: { id: true },
  });
  if (!project) {
    return {
      result: failure("not_found", membership.organization.revision, "Destination project was not found."),
    };
  }
  const snapshot = withAggregateVersion(
    stagedSnapshot(entry, command.proposalDigest),
    membership.organization.revision,
  );
  if (isFailure(snapshot)) return { result: snapshot };
  const existingApproval = await prisma.webMcpProposalApproval.findUnique({
    where: {
      organizationId_inboxEntryId: {
        organizationId: workspaceId,
        inboxEntryId: command.inboxEntryId,
      },
    },
    select: { id: true },
  });
  if (existingApproval) {
    return {
      result: failure("duplicate", membership.organization.revision, "This WebMCP proposal was already approved."),
    };
  }

  const stagedCanonicalPaperId = entry.provenanceRecords.find(
    (record) => record.kind === "WEB_MCP",
  )?.paperId ?? undefined;
  if (command.duplicateDecision.kind === "create_new" && stagedCanonicalPaperId) {
    return {
      result: failure(
        "duplicate",
        membership.organization.revision,
        "The staged proposal already has a canonical duplicate. Review the duplicate decision.",
      ),
    };
  }
  if (command.duplicateDecision.kind === "use_existing") {
    if (stagedCanonicalPaperId !== command.duplicateDecision.canonicalPaperId) {
      return {
        result: failure("not_found", membership.organization.revision, "Duplicate candidate was not found."),
      };
    }
    const candidate = await prisma.paper.findUnique({
      where: { id: stagedCanonicalPaperId },
      select: { id: true },
    });
    if (!candidate) {
      return {
        result: failure("not_found", membership.organization.revision, "Duplicate candidate was not found."),
      };
    }
    const workspacePaper = await prisma.workspacePaper.findUnique({
      where: {
        organizationId_paperId: { organizationId: workspaceId, paperId: candidate.id },
      },
      select: { id: true },
    });
    if (workspacePaper) {
      const visible = await prisma.workspacePaper.findFirst({
        where: { id: workspacePaper.id, ...workspacePaperVisibleTo(user.id, workspaceId) },
        select: { id: true },
      });
      if (!visible) {
        return {
          result: failure("not_found", membership.organization.revision, "Duplicate candidate was not found."),
        };
      }
    }
  }
  return {
    aggregateVersion: membership.organization.revision,
    snapshot,
    ...(stagedCanonicalPaperId ? { stagedCanonicalPaperId } : {}),
  };
}

/**
 * Verify and freeze the authority dossier before final human consent. The
 * verifier call is intentionally outside any database transaction; the
 * short persistence transaction then repeats the complete local authority
 * check before admitting the one-use challenge.
 */
export async function prepareWebMcpApprovalChallenge(
  user: ImportSessionUser,
  workspaceId: string,
  routeInboxEntryId: string,
  rawCommand: unknown,
  options: ApprovalServiceOptions = {},
): Promise<PrepareWebMcpApprovalResponse> {
  const command = parseWebMcpApprovalPreparationCommand(rawCommand, routeInboxEntryId);
  const initial = await initialPreparationAuthorization(user, workspaceId, command);
  if ("result" in initial) return initial.result;

  let authority: PreparedAuthority;
  if (command.duplicateDecision.kind === "use_existing") {
    authority = existingCanonicalAuthority(
      command.proposalDigest,
      command.duplicateDecision.canonicalPaperId,
    );
  } else if (initial.snapshot.paper.identifiers.length === 0) {
    authority = humanReviewAuthority(command.proposalDigest);
  } else {
    // This is the sole provider-I/O boundary in the approval workflow.
    const verification = await (options.verifier ?? new OpenAlexWebMcpVerifier()).verify(
      initial.snapshot,
    );
    if (!verification.ok) {
      return verificationFailure(verification.reason, initial.aggregateVersion);
    }
    if (!isOpenAlexVerifiedCanonicalSnapshot(verification.verified)) {
      return failure(
        "validation",
        initial.aggregateVersion,
        "The scholarly verifier returned invalid authority evidence.",
      );
    }
    authority = {
      kind: "OPENALEX",
      authorityVersion: verification.verified.authorityVersion,
      evidenceDigest: verification.verified.evidenceDigest,
      verifiedSnapshot: verification.verified,
    };
  }
  if (!preparedAuthorityIsClosed(authority)) {
    return failure(
      "validation",
      initial.aggregateVersion,
      "The approval authority snapshot is invalid.",
    );
  }

  return withTransactionRetry(() => prisma.$transaction(async (transaction) => {
    const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT transaction_timestamp() AS "now"`,
    );
    if (!clock?.now) {
      throw new HttpProblem(500, "database_clock_unavailable", "Database time was unavailable.");
    }
    const createdAt = clock.now;
    const expiresAt = new Date(createdAt.getTime() + APPROVAL_CHALLENGE_TTL_MS);
    await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, user.id);
    const membership = await transaction.member.findUnique({
      where: { organizationId_userId: { organizationId: workspaceId, userId: user.id } },
      include: { organization: true },
    });
    if (!membership) throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    requireWorkspaceMutationRole(membership.role);
    if (membership.organization.revision !== command.expectedVersion) {
      return failure(
        "version_conflict",
        membership.organization.revision,
        "Workspace changed while evidence was being verified. Refresh before retrying.",
      );
    }

    const entry = await transaction.inboxEntry.findFirst({
      where: { id: command.inboxEntryId, ...inboxEntryVisibleTo(user.id, workspaceId) },
      include: approvalInboxInclude(),
    });
    if (!entry) {
      return failure("not_found", membership.organization.revision, "Inbox entry was not found.");
    }
    const project = await transaction.project.findFirst({
      where: {
        id: command.destinationProjectId,
        organizationId: workspaceId,
        ...projectVisibleTo(user.id),
      },
      select: { id: true },
    });
    if (!project) {
      return failure(
        "not_found",
        membership.organization.revision,
        "Destination project was not found.",
      );
    }
    const snapshot = withAggregateVersion(
      stagedSnapshot(entry, command.proposalDigest),
      membership.organization.revision,
    );
    if (isFailure(snapshot)) return snapshot;
    const existingApproval = await transaction.webMcpProposalApproval.findUnique({
      where: {
        organizationId_inboxEntryId: {
          organizationId: workspaceId,
          inboxEntryId: command.inboxEntryId,
        },
      },
      select: { id: true },
    });
    if (existingApproval) {
      return failure(
        "duplicate",
        membership.organization.revision,
        "This WebMCP proposal was already approved.",
      );
    }

    const stagedCanonicalPaperId = entry.provenanceRecords.find(
      (record) => record.kind === "WEB_MCP",
    )?.paperId ?? undefined;
    if (command.duplicateDecision.kind === "create_new" && stagedCanonicalPaperId) {
      return failure(
        "duplicate",
        membership.organization.revision,
        "The staged proposal already has a canonical duplicate. Review the duplicate decision.",
      );
    }
    if (command.duplicateDecision.kind === "use_existing") {
      if (stagedCanonicalPaperId !== command.duplicateDecision.canonicalPaperId) {
        return failure(
          "not_found",
          membership.organization.revision,
          "Duplicate candidate was not found.",
        );
      }
      const candidate = await transaction.paper.findUnique({
        where: { id: stagedCanonicalPaperId },
        select: { id: true },
      });
      if (!candidate) {
        return failure(
          "not_found",
          membership.organization.revision,
          "Duplicate candidate was not found.",
        );
      }
      const workspacePaper = await transaction.workspacePaper.findUnique({
        where: {
          organizationId_paperId: { organizationId: workspaceId, paperId: candidate.id },
        },
        select: { id: true },
      });
      if (workspacePaper) {
        const visible = await transaction.workspacePaper.findFirst({
          where: { id: workspacePaper.id, ...workspacePaperVisibleTo(user.id, workspaceId) },
          select: { id: true },
        });
        if (!visible) {
          return failure(
            "not_found",
            membership.organization.revision,
            "Duplicate candidate was not found.",
          );
        }
      }
    }

    const challengeId = randomBytes(32).toString("base64url");
    const challenge = await transaction.webMcpApprovalChallenge.create({
      data: {
        id: challengeId,
        schemaVersion: 2,
        organizationId: workspaceId,
        actorUserId: user.id,
        inboxEntryId: command.inboxEntryId,
        proposalDigest: command.proposalDigest,
        destinationProjectId: command.destinationProjectId,
        decision: command.duplicateDecision.kind === "create_new" ? "CREATE_NEW" : "USE_EXISTING",
        selectedCanonicalPaperId: command.duplicateDecision.kind === "use_existing"
          ? command.duplicateDecision.canonicalPaperId
          : null,
        expectedOrganizationRevision: command.expectedVersion,
        verificationAuthority: authority.kind,
        verificationAuthorityVersion: authority.authorityVersion,
        verificationEvidenceDigest: authority.evidenceDigest,
        verifiedSnapshot: authority.verifiedSnapshot as unknown as Prisma.InputJsonValue,
        createdAt,
        expiresAt,
      },
    });
    return {
      ok: true,
      outcome: "applied",
      aggregateVersion: membership.organization.revision,
      data: {
        challenge: {
          schemaVersion: 1,
          challengeId: challenge.id,
          expiresAt: challenge.expiresAt.toISOString(),
          expectedVersion: command.expectedVersion,
          inboxEntryId: command.inboxEntryId,
          proposalDigest: command.proposalDigest,
          destinationProjectId: command.destinationProjectId,
          duplicateDecision: command.duplicateDecision,
          evidence: {
            authority: authority.kind,
            authorityVersion: authority.authorityVersion,
            evidenceDigest: authority.evidenceDigest,
            verifiedSnapshot: authority.verifiedSnapshot,
          },
        },
      },
    } satisfies PrepareWebMcpApprovalResponse;
  }, { isolationLevel: "Serializable" }));
}

/**
 * Final human-reviewed canonical promotion. This function performs no
 * provider I/O: it consumes only a closed evidence challenge prepared above.
 */
export async function approveWebMcpProposal(
  user: ImportSessionUser,
  workspaceId: string,
  routeInboxEntryId: string,
  rawCommand: unknown,
): Promise<ApprovalResult> {
  const parsed = parseWebMcpApprovalCommand(rawCommand, routeInboxEntryId);
  if (parsed.schemaVersion === 1) {
    return replayHistoricalV1Approval(user, workspaceId, parsed);
  }
  const command = parsed;
  const hash = requestHash(command);

  return withTransactionRetry(() => prisma.$transaction(async (transaction) => {
    await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, user.id);
    const membership = await transaction.member.findUnique({
      where: { organizationId_userId: { organizationId: workspaceId, userId: user.id } },
      include: { organization: true },
    });
    if (!membership) throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    requireWorkspaceMutationRole(membership.role);

    const prior = await transaction.idempotencyRecord.findUnique({
      where: { organizationId_key: { organizationId: workspaceId, key: command.clientOperationId } },
    });
    if (prior) {
      if (prior.actorUserId !== user.id || prior.command !== APPROVAL_COMMAND || prior.requestHash !== hash) {
        return failure(
          "idempotency_conflict",
          membership.organization.revision,
          "clientOperationId was already used for a different command.",
        );
      }
      return replayedResult(prior.response)
        ?? failure(
          "version_conflict",
          membership.organization.revision,
          "The prior approval is still being resolved. Refresh before retrying.",
        );
    }
    if (membership.organization.revision !== command.expectedVersion) {
      return failure(
        "version_conflict",
        membership.organization.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const entry = await transaction.inboxEntry.findFirst({
      where: { id: command.inboxEntryId, ...inboxEntryVisibleTo(user.id, workspaceId) },
      include: approvalInboxInclude(),
    });
    if (!entry) return failure("not_found", membership.organization.revision, "Inbox entry was not found.");
    const project = await transaction.project.findFirst({
      where: {
        id: command.destinationProjectId,
        organizationId: workspaceId,
        ...projectVisibleTo(user.id),
      },
      include: projectInclude(workspaceId),
    });
    if (!project) {
      return failure("not_found", membership.organization.revision, "Destination project was not found.");
    }
    const snapshot = withAggregateVersion(
      stagedSnapshot(entry, command.proposalDigest),
      membership.organization.revision,
    );
    if (isFailure(snapshot)) return snapshot;
    const existingApproval = await transaction.webMcpProposalApproval.findUnique({
      where: {
        organizationId_inboxEntryId: {
          organizationId: workspaceId,
          inboxEntryId: command.inboxEntryId,
        },
      },
      select: { id: true },
    });
    if (existingApproval) {
      return failure("duplicate", membership.organization.revision, "This WebMCP proposal was already approved.");
    }

    const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT transaction_timestamp() AS "now"`,
    );
    if (!clock?.now) {
      throw new HttpProblem(500, "database_clock_unavailable", "Database time was unavailable.");
    }
    const challenge = await transaction.webMcpApprovalChallenge.findFirst({
      where: { id: command.challengeId, organizationId: workspaceId },
    });
    const selectedCanonicalPaperId = command.duplicateDecision.kind === "use_existing"
      ? command.duplicateDecision.canonicalPaperId
      : null;
    const decision = command.duplicateDecision.kind === "create_new"
      ? "CREATE_NEW" as const
      : "USE_EXISTING" as const;
    if (
      !challenge
      || challenge.schemaVersion !== 2
      || challenge.actorUserId !== user.id
      || challenge.inboxEntryId !== command.inboxEntryId
      || challenge.proposalDigest !== command.proposalDigest
      || challenge.destinationProjectId !== command.destinationProjectId
      || challenge.decision !== decision
      || challenge.selectedCanonicalPaperId !== selectedCanonicalPaperId
      || challenge.expectedOrganizationRevision !== command.expectedVersion
      || challenge.verificationEvidenceDigest !== command.evidenceDigest
      || challenge.consumedAt !== null
      || challenge.expiresAt.getTime() <= clock.now.getTime()
    ) {
      return failure(
        "validation",
        membership.organization.revision,
        "The approval challenge is invalid, expired, consumed, or bound to different review intent.",
      );
    }
    const authority = preparedAuthorityFromStoredChallenge(challenge);
    if (!authority || authority.evidenceDigest !== command.evidenceDigest) {
      throw new HttpProblem(
        500,
        "invalid_webmcp_approval_challenge",
        "Stored WebMCP approval evidence is invalid.",
      );
    }

    const stagedCanonicalPaperId = entry.provenanceRecords.find(
      (record) => record.kind === "WEB_MCP",
    )?.paperId ?? undefined;
    if (command.duplicateDecision.kind === "create_new" && stagedCanonicalPaperId) {
      return failure(
        "duplicate",
        membership.organization.revision,
        "The staged proposal already has a canonical duplicate. Review the duplicate decision.",
      );
    }
    let existingCanonicalPaper = null;
    if (command.duplicateDecision.kind === "use_existing") {
      if (stagedCanonicalPaperId !== command.duplicateDecision.canonicalPaperId) {
        return failure("not_found", membership.organization.revision, "Duplicate candidate was not found.");
      }
      existingCanonicalPaper = await transaction.paper.findUnique({
        where: { id: command.duplicateDecision.canonicalPaperId },
        include: { authors: true, identifiers: true },
      });
      if (!existingCanonicalPaper) {
        return failure("not_found", membership.organization.revision, "Duplicate candidate was not found.");
      }
      const existingWorkspacePaper = await transaction.workspacePaper.findUnique({
        where: {
          organizationId_paperId: {
            organizationId: workspaceId,
            paperId: existingCanonicalPaper.id,
          },
        },
        select: { id: true },
      });
      if (existingWorkspacePaper) {
        const visible = await transaction.workspacePaper.findFirst({
          where: { id: existingWorkspacePaper.id, ...workspacePaperVisibleTo(user.id, workspaceId) },
          select: { id: true },
        });
        if (!visible) {
          return failure("not_found", membership.organization.revision, "Duplicate candidate was not found.");
        }
      }
    } else if (authority.kind === "OPENALEX") {
      const matches = await transaction.paperIdentifier.findMany({
        where: {
          OR: authority.verifiedSnapshot.paper.identifiers.map((identifier) => ({
            type: identifier.type,
            normalizedValue: identifier.normalizedValue,
          })),
        },
        select: { paperId: true },
      });
      if (new Set(matches.map((match) => match.paperId)).size > 0) {
        return failure(
          "duplicate",
          membership.organization.revision,
          "The verified identifiers already belong to a canonical paper. Review the duplicate decision.",
        );
      }
    }

    const consumed = await transaction.webMcpApprovalChallenge.updateMany({
      where: {
        id: command.challengeId,
        organizationId: workspaceId,
        actorUserId: user.id,
        inboxEntryId: command.inboxEntryId,
        proposalDigest: command.proposalDigest,
        destinationProjectId: command.destinationProjectId,
        decision,
        selectedCanonicalPaperId,
        expectedOrganizationRevision: command.expectedVersion,
        verificationEvidenceDigest: command.evidenceDigest,
        consumedAt: null,
        expiresAt: { gt: clock.now },
      },
      data: { consumedAt: clock.now },
    });
    if (consumed.count !== 1) {
      return failure(
        "validation",
        membership.organization.revision,
        "The approval challenge was consumed or expired. Prepare a new review dossier.",
      );
    }

    const bumped = await transaction.organization.updateMany({
      where: { id: workspaceId, revision: command.expectedVersion },
      data: { revision: { increment: 1 } },
    });
    if (bumped.count !== 1) {
      const current = await transaction.organization.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { revision: true },
      });
      return failure(
        "version_conflict",
        current.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const retainedPrincipal = await resolveLiveRetainedAuditPrincipal(
      transaction,
      workspaceId,
      user.id,
    );

    const canonicalPaper = existingCanonicalPaper ?? await transaction.paper.create({
      data: authority.kind === "OPENALEX"
        ? {
            title: authority.verifiedSnapshot.paper.title,
            abstractText: authority.verifiedSnapshot.paper.abstractText,
            publicationYear: authority.verifiedSnapshot.paper.publicationYear,
            publicationDate: authority.verifiedSnapshot.paper.publicationDate
              ? new Date(`${authority.verifiedSnapshot.paper.publicationDate}T00:00:00.000Z`)
              : null,
            language: authority.verifiedSnapshot.paper.language,
            workType: authority.verifiedSnapshot.paper.workType,
            venueName: authority.verifiedSnapshot.paper.venueName,
            citationCount: authority.verifiedSnapshot.paper.citationCount,
            isRetracted: authority.verifiedSnapshot.paper.isRetracted,
            primarySource: "OPENALEX",
            metadata: authority.verifiedSnapshot as unknown as Prisma.InputJsonValue,
            identifiers: { create: authority.verifiedSnapshot.paper.identifiers },
            authors: { create: authority.verifiedSnapshot.paper.authors },
          }
        : {
            title: snapshot.paper.title,
            abstractText: snapshot.paper.abstract || null,
            publicationYear: snapshot.paper.year || null,
            workType: snapshot.paper.type,
            venueName: snapshot.paper.venue || null,
            isRetracted: snapshot.paper.isRetracted ?? false,
            primarySource: "WEB_MCP",
            metadata: authority.verifiedSnapshot as unknown as Prisma.InputJsonValue,
            authors: {
              create: snapshot.paper.authors.map((displayName, position) => ({
                position,
                displayName,
              })),
            },
          },
      include: { authors: true, identifiers: true },
    });

    const workspacePaper = await transaction.workspacePaper.upsert({
      where: {
        organizationId_paperId: { organizationId: workspaceId, paperId: canonicalPaper.id },
      },
      update: { status: "SAVED" },
      create: {
        organizationId: workspaceId,
        paperId: canonicalPaper.id,
        status: "SAVED",
        addedById: user.id,
      },
    });
    await transaction.projectPaper.upsert({
      where: {
        organizationId: workspaceId,
        projectId_workspacePaperId: {
          projectId: project.id,
          workspacePaperId: workspacePaper.id,
        },
      },
      update: {},
      create: {
        organizationId: workspaceId,
        projectId: project.id,
        workspacePaperId: workspacePaper.id,
        addedById: user.id,
      },
    });
    const updated = await transaction.inboxEntry.update({
      where: { id: entry.id, organizationId: workspaceId },
      data: {
        projectId: project.id,
        workspacePaperId: workspacePaper.id,
        status: "IMPORTED",
        resolvedAt: new Date(),
        failureCode: null,
        failureMessage: null,
      },
    });
    const approval = await transaction.webMcpProposalApproval.create({
      data: {
        organizationId: workspaceId,
        inboxEntryId: entry.id,
        destinationProjectId: project.id,
        approvedById: user.id,
        approvedByPrincipalId: retainedPrincipal.id,
        approvalCommandSchemaVersion: 2,
        challengeId: command.challengeId,
        proposalDigest: command.proposalDigest,
        decision: command.duplicateDecision.kind === "create_new" ? "CREATE_NEW" : "USE_EXISTING",
        selectedCanonicalPaperId: command.duplicateDecision.kind === "use_existing"
          ? command.duplicateDecision.canonicalPaperId
          : null,
        canonicalPaperId: canonicalPaper.id,
        workspacePaperId: workspacePaper.id,
        verificationAuthority: authority.kind,
        verificationAuthorityVersion: authority.authorityVersion,
        verificationEvidenceDigest: authority.evidenceDigest,
        verifiedSnapshot: authority.verifiedSnapshot as unknown as Prisma.InputJsonValue,
        clientOperationId: command.clientOperationId,
        approvedAt: clock.now,
      },
    });
    if (authority.kind === "OPENALEX") {
      await transaction.provenanceRecord.create({
        data: {
          organizationId: workspaceId,
          kind: "METADATA",
          paperId: canonicalPaper.id,
          workspacePaperId: workspacePaper.id,
          inboxEntryId: entry.id,
          actorUserId: user.id,
          actorPrincipalId: retainedPrincipal.id,
          sourceProvider: "OpenAlex",
          sourceRecordId: authority.verifiedSnapshot.sourceRecordId,
          sourceUri: `https://openalex.org/${authority.verifiedSnapshot.sourceRecordId}`,
          retrievedAt: new Date(authority.verifiedSnapshot.retrievedAt),
          payloadDigest: authority.evidenceDigest,
          payload: authority.verifiedSnapshot as unknown as Prisma.InputJsonValue,
        },
      });
    }
    const importPayload = {
      schemaVersion: 1,
      approvalId: approval.id,
      proposalDigest: command.proposalDigest,
      destinationProjectId: project.id,
      decision: command.duplicateDecision.kind,
      canonicalPaperId: canonicalPaper.id,
      workspacePaperId: workspacePaper.id,
      verificationAuthority: authority.kind,
      verificationAuthorityVersion: authority.authorityVersion,
      verificationEvidenceDigest: authority.evidenceDigest,
    };
    await transaction.provenanceRecord.create({
      data: {
        organizationId: workspaceId,
        kind: "IMPORT",
        paperId: canonicalPaper.id,
        workspacePaperId: workspacePaper.id,
        inboxEntryId: entry.id,
        actorUserId: user.id,
        actorPrincipalId: retainedPrincipal.id,
        sourceProvider: "PaperPilot WebMCP review",
        sourceRecordId: approval.id,
        sourceUri: snapshot.provenance.sourceUrl,
        retrievedAt: approval.approvedAt,
        payloadDigest: webMcpVerificationEvidenceDigest(importPayload),
        payload: importPayload,
      },
    });
    // Surface deferred authority-integrity failures while this callback still
    // owns the checked-out client. Besides producing a deterministic service
    // failure, this avoids adapter commit/rollback overlap after a deferred
    // constraint rejects the transaction.
    await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");

    const hydratedEntry = await transaction.inboxEntry.findFirstOrThrow({
      where: { id: updated.id, organizationId: workspaceId },
      include: approvalInboxInclude(),
    });
    const hydratedPaper = await transaction.paper.findUniqueOrThrow({
      where: { id: canonicalPaper.id },
      include: { authors: true, identifiers: true },
    });
    const hydratedProject = await transaction.project.findFirstOrThrow({
      where: { id: project.id, organizationId: workspaceId, ...projectVisibleTo(user.id) },
      include: projectInclude(workspaceId),
    });
    const inboxEntry = paperInboxEntryDto(hydratedEntry as InboxEntryForDto);
    if (!inboxEntry || inboxEntry.sourceKind !== "webmcp" || !("proposalDigest" in inboxEntry)) {
      throw new HttpProblem(500, "invalid_webmcp_snapshot", "Approved WebMCP proposal could not be projected.");
    }
    const result: ApprovalResult = {
      ok: true,
      outcome: "applied",
      aggregateVersion: command.expectedVersion + 1,
      data: {
        approval: {
          id: approval.id,
          challengeId: command.challengeId,
          inboxEntryId: entry.id,
          proposalDigest: command.proposalDigest,
          destinationProjectId: project.id,
          decision: command.duplicateDecision.kind,
          canonicalPaperId: canonicalPaper.id,
          evidenceDigest: authority.evidenceDigest,
          verifiedIdentifiers: publicVerifiedIdentifiers(authority),
          approvedAt: approval.approvedAt.toISOString(),
        },
        inboxEntry,
        paper: paperDto(hydratedPaper),
        project: projectDto(hydratedProject),
        usedExistingPaper: command.duplicateDecision.kind === "use_existing",
      },
    };
    await transaction.idempotencyRecord.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        key: command.clientOperationId,
        command: APPROVAL_COMMAND,
        requestHash: hash,
        response: result as unknown as Prisma.InputJsonValue,
        status: "COMPLETED",
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        actorPrincipalId: retainedPrincipal.id,
        action: "webmcp.proposal.approved",
        entityType: "webmcp-proposal-approval",
        entityId: approval.id,
        requestId: command.clientOperationId,
        metadata: {
          inboxEntryId: entry.id,
          destinationProjectId: project.id,
          decision: command.duplicateDecision.kind,
          canonicalPaperId: canonicalPaper.id,
          workspacePaperId: workspacePaper.id,
          proposalDigest: command.proposalDigest,
          challengeId: command.challengeId,
          verificationAuthority: authority.kind,
          verificationAuthorityVersion: authority.authorityVersion,
          verificationEvidenceDigest: authority.evidenceDigest,
        },
      },
    });
    return result;
  }, { isolationLevel: "Serializable" }));
}
