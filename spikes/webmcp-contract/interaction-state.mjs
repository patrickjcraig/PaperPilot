// @ts-check

/**
 * Presentation-only refresh and focus decisions. No browser globals, graph
 * mutations, source geometry, or persisted evidence enter this module.
 */

/** @typedef {{ documentKey: string, graph: unknown, workspaceRevision: number, workspaceDigest: string, anchorCount: number, mentorKey: string }} RenderStamp */
/** @typedef {{ key: string, regionKey: string, rowKey: string, available: boolean }} InteractionTarget */
/** @typedef {{ target: InteractionTarget, rowOrder: string[] }} FocusBookmark */

/**
 * Focus-only changes and repeated callbacks do not invalidate content controls.
 * A replacement graph must repaint even if its semantic digest is unchanged.
 * @param {RenderStamp | null} previous
 * @param {RenderStamp} next
 */
export function planInteractionRefresh(previous, next) {
  const content = !previous
    || previous.documentKey !== next.documentKey
    || previous.graph !== next.graph
    || previous.workspaceRevision !== next.workspaceRevision
    || previous.workspaceDigest !== next.workspaceDigest
    || previous.anchorCount !== next.anchorCount;
  return Object.freeze({ content, mentor: content || previous?.mentorKey !== next.mentorKey });
}

/**
 * Capture stable identities and the pre-change order, never a visual index or
 * label. A reader outside these controls must not be pulled into the graph.
 * @param {string | null} activeKey
 * @param {ReadonlyArray<InteractionTarget>} targets
 * @returns {FocusBookmark | null}
 */
export function captureFocusBookmark(activeKey, targets) {
  const target = targets.find((candidate) => candidate.key === activeKey);
  if (!target) return null;
  return {
    target: { ...target },
    rowOrder: [...new Set(targets.filter((candidate) => candidate.regionKey === target.regionKey).map((candidate) => candidate.rowKey))],
  };
}

/**
 * Keep the same action after a rename/reorder. If its row disappears, prefer
 * the next surviving old row, then the previous one, then the region itself.
 * @param {FocusBookmark | null} bookmark
 * @param {ReadonlyArray<InteractionTarget>} targets
 * @returns {string | null}
 */
export function resolveFocusBookmark(bookmark, targets) {
  if (!bookmark) return null;
  const available = targets.filter((target) => target.available && target.regionKey === bookmark.target.regionKey);
  const exact = available.find((target) => target.key === bookmark.target.key);
  if (exact) return exact.key;
  const index = bookmark.rowOrder.indexOf(bookmark.target.rowKey);
  const fallbackRows = [
    ...bookmark.rowOrder.slice(index + 1),
    ...bookmark.rowOrder.slice(0, index).reverse(),
    bookmark.target.rowKey,
  ];
  for (const rowKey of fallbackRows) {
    const target = available.find((candidate) => candidate.rowKey === rowKey);
    if (target) return target.key;
  }
  return available[0]?.key || null;
}

/**
 * Explanation identity is part of the key: a new draft receives its own
 * defaults instead of inheriting disclosures from a different explanation.
 * @param {ReadonlyMap<string, boolean>} previous
 * @param {string} key
 * @param {boolean} initiallyOpen
 */
export function disclosureOpenState(previous, key, initiallyOpen) {
  return previous.has(key) ? previous.get(key) === true : initiallyOpen;
}
