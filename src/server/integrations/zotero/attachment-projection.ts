import "server-only";

import { normalizeUploadDisplayFilename } from "@/server/uploads/validation";
import { normalizeZoteroItemKey } from "./protocol";

/**
 * Zotero's documented attachment link modes. Keep this closed so a new
 * provider mode remains ineligible until its custody semantics are reviewed.
 */
export const ZOTERO_ATTACHMENT_LINK_MODES = [
  "imported_file",
  "imported_url",
  "linked_file",
  "linked_url",
  "embedded_image",
] as const;

export type ZoteroAttachmentLinkMode =
  (typeof ZOTERO_ATTACHMENT_LINK_MODES)[number];

export type ZoteroStoredAttachmentLinkMode = Extract<
  ZoteroAttachmentLinkMode,
  "imported_file" | "imported_url"
>;

export const ZOTERO_ATTACHMENT_INELIGIBLE_REASON_CODES = [
  "source_not_item",
  "item_not_attachment",
  "linked_file_not_downloadable",
  "linked_url_not_downloadable",
  "embedded_image_not_downloadable",
  "unsupported_link_mode",
  "content_type_not_pdf",
  "filename_not_pdf",
] as const;

export type ZoteroAttachmentIneligibleReasonCode =
  (typeof ZOTERO_ATTACHMENT_INELIGIBLE_REASON_CODES)[number];

export const ZOTERO_ATTACHMENT_MALFORMED_REASON_CODES = [
  "invalid_metadata",
  "invalid_link_mode",
  "invalid_content_type",
  "invalid_filename",
  "invalid_md5",
  "invalid_mtime",
  "invalid_parent_item",
] as const;

export type ZoteroAttachmentMalformedReasonCode =
  (typeof ZOTERO_ATTACHMENT_MALFORMED_REASON_CODES)[number];

export interface ZoteroDownloadableAttachmentCandidate {
  /** Attachments continue to use the existing Zotero ITEM object namespace. */
  objectType: "ITEM";
  linkMode: ZoteroStoredAttachmentLinkMode;
  contentType: "application/pdf";
  /** NFC-normalized, bounded display text; never a storage path or object key. */
  filename: string;
  /** Canonical lower-case hexadecimal provider content identity. */
  md5: string;
  /** Canonical unsigned decimal Unix epoch milliseconds, when present. */
  mtime?: string;
  /** Canonical Zotero parent key. Omitted for a top-level attachment. */
  parentItem?: string;
}

export type ZoteroAttachmentProjection =
  | {
      outcome: "downloadable";
      candidate: ZoteroDownloadableAttachmentCandidate;
    }
  | {
      outcome: "ineligible";
      reasonCode: ZoteroAttachmentIneligibleReasonCode;
    }
  | {
      outcome: "malformed";
      reasonCode: ZoteroAttachmentMalformedReasonCode;
    };

export interface ZoteroAttachmentProjectionInput {
  /** Database/source object discriminator. Attachment records remain ITEMs. */
  objectType: unknown;
  /** Sanitized Zotero item data. */
  data: unknown;
}

const LINK_MODE_SET = new Set<string>(ZOTERO_ATTACHMENT_LINK_MODES);
const CANONICAL_MD5_PATTERN = /^[0-9a-f]{32}$/;
const CANONICAL_UNSIGNED_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recognizedLinkMode(value: string): value is ZoteroAttachmentLinkMode {
  return LINK_MODE_SET.has(value);
}

function normalizeDisplayFilename(value: unknown): string | undefined {
  try {
    return normalizeUploadDisplayFilename(value);
  } catch {
    return undefined;
  }
}

function normalizeOptionalMtime(
  value: unknown,
): { valid: true; value?: string } | { valid: false } {
  if (value === undefined) return { valid: true };
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0
      ? { valid: true, value: String(value) }
      : { valid: false };
  }
  if (
    typeof value !== "string"
    || !CANONICAL_UNSIGNED_DECIMAL_PATTERN.test(value)
  ) {
    return { valid: false };
  }
  const parsed = BigInt(value);
  return parsed <= MAX_SAFE_INTEGER_BIGINT
    ? { valid: true, value: parsed.toString(10) }
    : { valid: false };
}

function normalizeOptionalParentItem(
  value: unknown,
): { valid: true; value?: string } | { valid: false } {
  // Zotero v3 permits a top-level attachment to omit `parentItem` or set it
  // explicitly to false. No other falsey/non-string representation is valid.
  if (value === undefined || value === false) return { valid: true };
  if (typeof value !== "string") return { valid: false };
  try {
    return { valid: true, value: normalizeZoteroItemKey(value) };
  } catch {
    return { valid: false };
  }
}

function ineligible(
  reasonCode: ZoteroAttachmentIneligibleReasonCode,
): ZoteroAttachmentProjection {
  return { outcome: "ineligible", reasonCode };
}

function malformed(
  reasonCode: ZoteroAttachmentMalformedReasonCode,
): ZoteroAttachmentProjection {
  return { outcome: "malformed", reasonCode };
}

/**
 * Project synchronized Zotero ITEM metadata into a download admission
 * candidate. This is intentionally metadata-only: bytes still require a
 * separately authorized, bounded provider fetch and the normal quarantine,
 * validation, and extraction custody path.
 */
export function projectZoteroAttachment(
  input: ZoteroAttachmentProjectionInput,
): ZoteroAttachmentProjection {
  if (input.objectType !== "ITEM") return ineligible("source_not_item");
  if (!isRecord(input.data)) return malformed("invalid_metadata");
  if (input.data.itemType !== "attachment") {
    return ineligible("item_not_attachment");
  }

  const rawLinkMode = input.data.linkMode;
  if (typeof rawLinkMode !== "string" || rawLinkMode.length === 0) {
    return malformed("invalid_link_mode");
  }
  if (!recognizedLinkMode(rawLinkMode)) {
    return ineligible("unsupported_link_mode");
  }
  if (rawLinkMode === "linked_file") {
    return ineligible("linked_file_not_downloadable");
  }
  if (rawLinkMode === "linked_url") {
    return ineligible("linked_url_not_downloadable");
  }
  if (rawLinkMode === "embedded_image") {
    return ineligible("embedded_image_not_downloadable");
  }

  if (typeof input.data.contentType !== "string") {
    return malformed("invalid_content_type");
  }
  if (input.data.contentType !== "application/pdf") {
    return ineligible("content_type_not_pdf");
  }

  const filename = normalizeDisplayFilename(input.data.filename);
  if (!filename) return malformed("invalid_filename");
  if (!filename.toLowerCase().endsWith(".pdf")) {
    return ineligible("filename_not_pdf");
  }

  if (
    typeof input.data.md5 !== "string"
    || !CANONICAL_MD5_PATTERN.test(input.data.md5)
  ) {
    return malformed("invalid_md5");
  }

  const mtime = normalizeOptionalMtime(input.data.mtime);
  if (!mtime.valid) return malformed("invalid_mtime");
  const parentItem = normalizeOptionalParentItem(input.data.parentItem);
  if (!parentItem.valid) return malformed("invalid_parent_item");

  return {
    outcome: "downloadable",
    candidate: {
      objectType: "ITEM",
      linkMode: rawLinkMode,
      contentType: "application/pdf",
      filename,
      md5: input.data.md5,
      ...(mtime.value === undefined ? {} : { mtime: mtime.value }),
      ...(parentItem.value === undefined
        ? {}
        : { parentItem: parentItem.value }),
    },
  };
}
