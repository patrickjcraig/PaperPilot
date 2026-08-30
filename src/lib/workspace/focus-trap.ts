export type FocusTrapTarget = "container" | "first" | "last" | "native";

/**
 * Choose a deterministic modal focus destination. Programmatically focused
 * titles have tabindex=-1 and therefore report an active index of -1; treating
 * that as an edge prevents the first Shift+Tab from escaping behind the modal.
 */
export function focusTrapTarget(
  focusableCount: number,
  activeIndex: number,
  backwards: boolean,
): FocusTrapTarget {
  if (focusableCount < 1) return "container";
  if (backwards && activeIndex <= 0) return "last";
  if (!backwards && (activeIndex < 0 || activeIndex >= focusableCount - 1)) {
    return "first";
  }
  return "native";
}
