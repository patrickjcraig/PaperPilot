import "server-only";

import { createHash } from "node:crypto";
import type { Paper, Provenance } from "@/lib/types";
import type { StageImportResult, WorkspaceCommandResult } from "@/lib/workspace";
import type { ImportSessionUser } from "@/server/workspaces/import-service";
import { WEB_MCP_PROVIDER_NAME } from "./authority";
import {
  parseWebMcpProposalCommand,
  type WebMcpProposalCommand,
} from "./intake-contract";
import {
  WEB_MCP_SNAPSHOT_SCHEMA_VERSION,
  type ServerManagedWebMcpSnapshotV2,
} from "./snapshot-contract";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function shortTitle(title: string): string {
  return Array.from(title).slice(0, 500).join("");
}

function abstractSnippet(abstract: string | undefined): string {
  if (!abstract) return "";
  return Array.from(abstract).slice(0, 5_000).join("");
}

export function webMcpProposalSnapshot(
  command: WebMcpProposalCommand,
  retrievedAt: Date = new Date(),
): ServerManagedWebMcpSnapshotV2 {
  const proposal = command.proposal;
  const sourceDigest = digest(proposal.sourcePageUrl);
  const paperId = `webmcp-${sourceDigest}`;
  const snippet = abstractSnippet(proposal.abstract);
  const paper: Paper = {
    id: paperId,
    title: proposal.title,
    shortTitle: shortTitle(proposal.title),
    authors: proposal.authors,
    year: proposal.year,
    venue: proposal.venue,
    type: proposal.publicationType,
    abstract: proposal.abstract ?? "",
    abstractSnippet: snippet,
    whyRead: "",
    relevanceScore: 0,
    relevanceTags: [],
    evidenceStrength: "unassessed",
    readingStatus: "unread",
    readingProgress: 0,
    estimatedMinutes: 0,
    identifiers: proposal.identifiers ?? [],
    sourceUrl: proposal.sourcePageUrl,
    access: {
      isOpenAccess: proposal.isOpenAccess ?? false,
      // A URL assertion is not byte custody. Reader remains unavailable until
      // a separately authenticated upload is validated and explicitly linked.
      hasFullText: false,
      landingPageUrl: proposal.sourcePageUrl,
      ...(proposal.candidatePdfUrl ? { pdfUrl: proposal.candidatePdfUrl } : {}),
      ...(proposal.license ? { license: proposal.license } : {}),
      ...(proposal.version ? { version: proposal.version } : {}),
    },
    isDemoRecord: false,
  };
  const provenance: Provenance = {
    id: `webmcp-provenance-${sourceDigest}`,
    sourceType: "web-source",
    sourceId: proposal.sourcePageUrl,
    sourceTitle: proposal.title,
    sourceUrl: proposal.sourcePageUrl,
    providerName: WEB_MCP_PROVIDER_NAME,
    retrievedAt: retrievedAt.toISOString(),
    accessMethod: "webmcp",
    ...(snippet ? { excerpt: snippet } : {}),
    ...(proposal.version ? { version: proposal.version } : {}),
  };
  return {
    schemaVersion: WEB_MCP_SNAPSHOT_SCHEMA_VERSION,
    paper,
    provenance,
  };
}

export async function proposeWebMcpWorkspaceImport(
  user: ImportSessionUser,
  workspaceId: string,
  rawCommand: unknown,
): Promise<WorkspaceCommandResult<StageImportResult>> {
  const command = parseWebMcpProposalCommand(rawCommand);
  // Keep the pure proposal transformer importable by unit tests without
  // initializing Prisma. The database boundary is loaded only for a command.
  const { stageServerManagedWebMcpProposal } = await import(
    "@/server/workspaces/import-service"
  );
  return stageServerManagedWebMcpProposal(user, workspaceId, {
    clientOperationId: command.clientOperationId,
    expectedVersion: command.expectedVersion,
    snapshot: webMcpProposalSnapshot(command),
  });
}
