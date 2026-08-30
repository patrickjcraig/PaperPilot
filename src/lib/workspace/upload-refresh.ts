import type {
  DocumentUploadInboxEntry,
  DocumentUploadStage,
  DocumentTextExtractionStage,
  WorkspaceInboxEntry,
} from "../types";
import {
  isCrawlerDocumentInboxEntry,
  isDocumentUploadInboxEntry,
} from "../types";

const REFRESHABLE_UPLOAD_STAGES = new Set<DocumentUploadStage>([
  "quarantined",
  "validating",
]);

export function isDocumentUploadRefreshPending(
  stage: DocumentUploadStage,
  extractionStage: DocumentTextExtractionStage = "not-started",
): boolean {
  return REFRESHABLE_UPLOAD_STAGES.has(stage)
    || extractionStage === "queued"
    || extractionStage === "extracting";
}

export function getRefreshableDocumentUploadIds(
  entries: WorkspaceInboxEntry[],
): string[] {
  return entries.flatMap((entry) =>
    isDocumentUploadInboxEntry(entry)
      && isDocumentUploadRefreshPending(
        entry.upload.stage,
        entry.upload.extractionStage,
      )
      ? [entry.upload.id]
      : []);
}

/**
 * Bootstrap Inbox rows are newest-first. Preserve the first linked document
 * for each paper so an older retained document source cannot override current
 * Reader UI.
 */
export function getLatestPaperExtractionStages(
  entries: WorkspaceInboxEntry[],
): Partial<Record<string, DocumentTextExtractionStage>> {
  return entries.reduce<Partial<Record<string, DocumentTextExtractionStage>>>(
    (stages, entry) => {
      if (
        isDocumentUploadInboxEntry(entry)
        && entry.upload.linkedPaperId
        && stages[entry.upload.linkedPaperId] === undefined
      ) {
        stages[entry.upload.linkedPaperId] = entry.upload.extractionStage;
      } else if (
        isCrawlerDocumentInboxEntry(entry)
        && entry.crawler.linkedPaperId
        && stages[entry.crawler.linkedPaperId] === undefined
      ) {
        stages[entry.crawler.linkedPaperId] = entry.crawler.extractionStage;
      }
      return stages;
    },
    {},
  );
}

/** Replace only existing upload entries, preserving Inbox order and paper entries. */
export function mergeRefreshedDocumentUploads(
  entries: WorkspaceInboxEntry[],
  refreshedEntries: DocumentUploadInboxEntry[],
): WorkspaceInboxEntry[] {
  if (!refreshedEntries.length) return entries;

  const refreshedByUploadId = new Map(
    refreshedEntries.map((entry) => [entry.upload.id, entry]),
  );
  let changed = false;
  const merged = entries.map((entry) => {
    if (!isDocumentUploadInboxEntry(entry)) return entry;
    const refreshed = refreshedByUploadId.get(entry.upload.id);
    if (!refreshed) return entry;
    changed = true;
    return refreshed;
  });

  return changed ? merged : entries;
}
