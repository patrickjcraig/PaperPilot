import "server-only";

import { createHash } from "node:crypto";

import type { Paper, PaperIdentifier, PaperType, Provenance } from "@/lib/types";
import type { StoredImportSnapshot } from "@/server/workspaces/import-dto";
import type {
  ZoteroItem,
  ZoteroLibraryRef,
  ZoteroVersion,
} from "./contracts";
import { normalizeZoteroItemKey } from "./protocol";

const MAX_NORMALIZED_SNAPSHOT_BYTES = 224 * 1_024;
const NOTE_CONTENT_FIELDS = new Set([
  "note",
  "annotationText",
  "annotationComment",
  // A linked-file attachment can expose an absolute path from the Zotero
  // user's machine. PaperPilot never needs that path for metadata sync or a
  // provider-hosted download, so do not retain it in the synchronized object.
  "path",
]);
const CHILD_ONLY_ITEM_TYPES = new Set(["attachment", "note", "annotation"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maximum);
}

function httpUrl(value: unknown): string | undefined {
  const candidate = text(value, 2_048);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
    ) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ":" + stableJson(record[key])
  ).join(",") + "}";
}

export function zoteroContentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

/**
 * Metadata synchronization never retains note or annotation body content.
 * Notes remain a later, separately consented policy surface even when an
 * existing OAuth key happens to have note permission.
 */
export function sanitizeZoteroMetadata(
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (NOTE_CONTENT_FIELDS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export function zoteroParentKey(
  data: Readonly<Record<string, unknown>>,
): string | undefined {
  const candidate = text(data.parentItem, 8);
  if (!candidate) return undefined;
  try {
    return normalizeZoteroItemKey(candidate);
  } catch {
    return undefined;
  }
}

function creatorName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const institutional = text(value.name, 300);
  if (institutional) return institutional;
  const first = text(value.firstName, 150);
  const last = text(value.lastName, 150);
  return [first, last].filter(Boolean).join(" ") || undefined;
}

function creators(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const records = value.filter(isRecord).slice(0, 200);
  const authored = records.filter((entry) => entry.creatorType === "author");
  const selected = authored.length ? authored : records;
  return selected.map(creatorName).filter((name): name is string => Boolean(name));
}

function publicationYear(value: unknown): number {
  const candidate = text(value, 200);
  const match = candidate?.match(/(?:^|\D)((?:1[5-9]|20|21)\d{2})(?:\D|$)/);
  if (!match) return 0;
  const year = Number(match[1]);
  return year <= new Date().getUTCFullYear() + 5 ? year : 0;
}

function paperType(itemType: string): PaperType {
  if (itemType === "conferencePaper" || itemType === "presentation") {
    return "conference paper";
  }
  if (itemType === "report" || itemType === "thesis" || itemType === "dataset") {
    return "application study";
  }
  return "journal article";
}

function venue(data: Readonly<Record<string, unknown>>): string {
  for (const field of [
    "publicationTitle",
    "proceedingsTitle",
    "conferenceName",
    "university",
    "institution",
    "publisher",
    "websiteTitle",
    "blogTitle",
  ]) {
    const value = text(data[field], 1_000);
    if (value) return value;
  }
  return "Unknown venue";
}

function doiIdentifier(value: unknown): PaperIdentifier | undefined {
  const raw = text(value, 1_024)
    ?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .toLowerCase();
  if (!raw || !/^10\.\d{4,9}\/\S+$/i.test(raw)) return undefined;
  return { scheme: "doi", value: raw };
}

function isbnIdentifier(value: unknown): PaperIdentifier | undefined {
  const candidates = text(value, 1_024)?.split(/[;,]/) ?? [];
  for (const candidate of candidates) {
    const normalized = candidate.toUpperCase().replace(/[^0-9X]/g, "");
    if (/^(?:\d{9}[\dX]|\d{13})$/.test(normalized)) {
      return { scheme: "isbn", value: normalized };
    }
  }
  return undefined;
}

function tags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => isRecord(entry) ? text(entry.tag, 120) : undefined)
    .filter((entry): entry is string => Boolean(entry))
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .slice(0, 50);
}

function itemApiUrl(library: ZoteroLibraryRef, key: string): string {
  const segment = library.kind === "user" ? "users" : "groups";
  return "https://api.zotero.org/" + segment + "/" + library.id + "/items/" + key;
}

function normalizedModifiedAt(value: unknown): string | undefined {
  const candidate = text(value, 100);
  if (!candidate) return undefined;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export interface ZoteroNormalizedItem {
  key: string;
  version: ZoteroVersion;
  parentKey?: string;
  data: Readonly<Record<string, unknown>>;
  contentHash: string;
  inboxSnapshot?: StoredImportSnapshot;
}

export function normalizeZoteroItemForSync(input: {
  item: ZoteroItem;
  library: ZoteroLibraryRef;
  retrievedAt: string;
}): ZoteroNormalizedItem {
  const key = normalizeZoteroItemKey(input.item.key);
  const data = sanitizeZoteroMetadata(input.item.data);
  const parentKey = zoteroParentKey(data);
  const itemType = text(data.itemType, 100) ?? "document";
  const title = text(data.title, 2_000);
  let inboxSnapshot: StoredImportSnapshot | undefined;

  if (!CHILD_ONLY_ITEM_TYPES.has(itemType) && !parentKey && title) {
    const sourceId = "zotero:" + input.library.kind + ":" + input.library.id + ":item:" + key;
    const providerUrl = itemApiUrl(input.library, key);
    const landingPage = httpUrl(data.url);
    const abstract = text(data.abstractNote, 150_000) ?? "";
    const identifiers: PaperIdentifier[] = [
      doiIdentifier(data.DOI),
      isbnIdentifier(data.ISBN),
      { scheme: "provider", value: sourceId },
    ].filter((entry): entry is PaperIdentifier => Boolean(entry));
    const paper: Paper = {
      id: sourceId,
      title,
      shortTitle: title.slice(0, 500),
      authors: creators(data.creators),
      year: publicationYear(data.date),
      venue: venue(data),
      type: paperType(itemType),
      abstract,
      abstractSnippet: abstract.slice(0, 5_000),
      whyRead: "Imported from a selected Zotero library for review.",
      relevanceScore: 0,
      relevanceTags: tags(data.tags),
      evidenceStrength: "unassessed",
      readingStatus: "unread",
      readingProgress: 0,
      estimatedMinutes: 0,
      identifiers,
      sourceUrl: landingPage ?? providerUrl,
      access: {
        isOpenAccess: false,
        hasFullText: false,
        landingPageUrl: landingPage ?? providerUrl,
        version: input.item.version,
      },
      providerUpdatedAt: normalizedModifiedAt(data.dateModified),
      isDemoRecord: false,
    };
    const provenance: Provenance = {
      id: sourceId + ":v:" + input.item.version,
      sourceType: "citation-library",
      sourceId,
      sourceTitle: title,
      sourceUrl: providerUrl,
      providerName: "Zotero",
      retrievedAt: input.retrievedAt,
      accessMethod: "oauth",
      version: input.item.version,
    };
    const candidate = { paper, provenance };
    if (Buffer.byteLength(stableJson(candidate), "utf8") <= MAX_NORMALIZED_SNAPSHOT_BYTES) {
      inboxSnapshot = candidate;
    }
  }

  return {
    key,
    version: input.item.version,
    parentKey,
    data,
    contentHash: zoteroContentHash(data),
    inboxSnapshot,
  };
}
