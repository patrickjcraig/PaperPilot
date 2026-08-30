/**
 * A full immutable extraction generation is the smallest safe retention unit:
 * its manifest and chunk hashes must remain internally consistent. Both a
 * grounded anchor and a direct EvidenceNote chunk FK protect that generation.
 */
export function protectedCrawlerExtractionIds(input: {
  anchoredExtractionIds: readonly string[];
  noteReferencedExtractionIds: readonly (string | null)[];
}): string[] {
  return [...new Set([
    ...input.anchoredExtractionIds,
    ...input.noteReferencedExtractionIds.filter(
      (extractionId): extractionId is string => extractionId !== null,
    ),
  ])].sort((left, right) => left.localeCompare(right));
}
