/**
 * Browser-independent activity and provenance presentation helpers.
 *
 * This module deliberately owns no clock, DOM, storage, or mutable singleton.
 * Page code supplies timestamps and retains the live array; these helpers only
 * create copied records, merge restored records, bound a display projection,
 * and format the same reader-visible strings used by the current spike.
 */

/** @typedef {Record<string, unknown> & {
 *   eventId?: unknown,
 *   observedAt?: unknown,
 *   eventType?: unknown,
 *   actor?: unknown,
 *   toolName?: unknown,
 *   status?: unknown,
 * }} ActivityEvent */

/** @typedef {{
 *   current: readonly ActivityEvent[],
 *   restored?: readonly ActivityEvent[] | null,
 * }} RestoredActivityMerge */

export const DEFAULT_VISIBLE_ACTIVITY_LIMIT = 80;

/**
 * Creates one deterministic activity record from a caller-supplied timestamp.
 *
 * Details intentionally retain the current page behavior: their keys are
 * spread last, so an explicitly supplied `eventType` or `observedAt` wins.
 * The details object is never mutated.
 *
 * @param {unknown} eventType
 * @param {Readonly<Record<string, unknown>>} [details]
 * @param {unknown} [observedAt]
 * @returns {ActivityEvent}
 */
export function createActivityRecord(eventType, details = {}, observedAt = undefined) {
  return { observedAt, eventType, ...details };
}

/**
 * Converts internal underscore-separated values to their current visible form.
 * This is deliberately not title-casing: existing capitalization is retained.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function humanReadable(value) {
  return String(value ?? "").replaceAll("_", " ");
}

/**
 * Maps internal actor aliases to the labels shown in the evidence activity UI.
 * Unknown actors retain the same underscore-only formatting as event types.
 *
 * @param {unknown} actor
 * @returns {string}
 */
export function presentedActor(actor) {
  if (actor === "agent" || actor === "webmcp_caller" || actor === "WebMCP caller") return "WebMCP caller";
  if (actor === "page" || actor === "PaperPilot page") return "PaperPilot page";
  if (actor === "human") return "Human";
  return humanReadable(actor || "");
}

/**
 * Formats one activity event exactly as the current public evidence list.
 * Optional actor, tool, and status segments are included only when truthy.
 *
 * @param {ActivityEvent} event
 * @returns {string}
 */
export function formatActivityEvent(event) {
  const actor = event.actor ? ` · ${presentedActor(event.actor)}` : "";
  const tool = event.toolName ? ` · ${event.toolName}` : "";
  const outcome = event.status ? ` · ${event.status}` : "";
  return `${event.observedAt} · ${humanReadable(event.eventType)}${actor}${tool}${outcome}`;
}

/**
 * Pure equivalent of the current browser snapshot restore merge.
 *
 * - Existing current records are retained, even when they already repeat an ID.
 * - A restored record with a truthy `eventId` is skipped when that ID has
 *   already appeared in the current ledger or earlier restored input.
 * - Id-less restored records are retained, including content duplicates.
 * - All returned top-level records are copies.
 * - The combined result is ordered by the same string comparison over
 *   `observedAt`; equal timestamps preserve input order via stable sort.
 *
 * @param {RestoredActivityMerge} input
 * @returns {ActivityEvent[]}
 */
export function mergeRestoredActivity({ current, restored = [] }) {
  const merged = current.map((event) => ({ ...event }));
  const knownEventIds = new Set(merged.map((event) => event.eventId).filter(Boolean));

  for (const event of restored || []) {
    if (event.eventId && knownEventIds.has(event.eventId)) continue;
    merged.push({ ...event });
    if (event.eventId) knownEventIds.add(event.eventId);
  }

  return merged.sort((left, right) => (
    String(left.observedAt || "").localeCompare(String(right.observedAt || ""))
  ));
}

/**
 * Returns the newest bounded activity records in newest-first display order.
 * The input array and its records are not mutated.
 *
 * @param {readonly ActivityEvent[]} events
 * @param {number} [limit]
 * @returns {ActivityEvent[]}
 */
export function boundActivityForDisplay(events, limit = DEFAULT_VISIBLE_ACTIVITY_LIMIT) {
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  if (boundedLimit === 0) return [];
  return events.slice(-boundedLimit).reverse();
}

/**
 * Builds the exact bounded text projection consumed by a plain DOM list.
 *
 * @param {readonly ActivityEvent[]} events
 * @param {number} [limit]
 * @returns {string[]}
 */
export function formatActivityForDisplay(events, limit = DEFAULT_VISIBLE_ACTIVITY_LIMIT) {
  return boundActivityForDisplay(events, limit).map(formatActivityEvent);
}
