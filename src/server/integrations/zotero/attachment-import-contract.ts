import "server-only";

import { createHash } from "node:crypto";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const PAYLOAD_KEYS = new Set(["schemaVersion", "attachmentImportId"]);

/**
 * The download queue deliberately carries only the immutable import command
 * identity. Tenant, connection, library, document, asset, and intake bindings
 * live in typed Job columns and are re-read transactionally by the worker.
 */
export interface ZoteroAttachmentDownloadJobPayload {
  schemaVersion: 1;
  attachmentImportId: string;
}

function requireOpaqueId(value: string, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

export function zoteroAttachmentDownloadJobPayload(
  attachmentImportId: string,
): ZoteroAttachmentDownloadJobPayload {
  return {
    schemaVersion: 1,
    attachmentImportId: requireOpaqueId(
      attachmentImportId,
      "Zotero attachment import identifier",
    ),
  };
}

export function parseZoteroAttachmentDownloadJobPayload(
  value: unknown,
): ZoteroAttachmentDownloadJobPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1
    || typeof record.attachmentImportId !== "string"
    || !OPAQUE_ID_PATTERN.test(record.attachmentImportId)
    || Object.keys(record).length !== PAYLOAD_KEYS.size
    || Object.keys(record).some((key) => !PAYLOAD_KEYS.has(key))
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    attachmentImportId: record.attachmentImportId,
  };
}

export function zoteroAttachmentDownloadJobPayloadHash(
  payload: ZoteroAttachmentDownloadJobPayload,
): string {
  const canonical = zoteroAttachmentDownloadJobPayload(
    payload.attachmentImportId,
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: canonical.schemaVersion,
        attachmentImportId: canonical.attachmentImportId,
      }),
      "utf8",
    )
    .digest("hex");
}

export function zoteroAttachmentDownloadJobDedupeKey(
  attachmentImportId: string,
): string {
  return `zotero-attachment-download:${requireOpaqueId(
    attachmentImportId,
    "Zotero attachment import identifier",
  )}`;
}
