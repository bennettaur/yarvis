/**
 * Move the tab with `dragId` next to the tab with `targetId`. `position`
 * "before" places the dragged tab immediately before the target; "after"
 * places it immediately after. If either id is unknown, or the drop would
 * be a no-op (dragged tab already sits where it would land), returns the
 * original array unchanged so callers using referential equality can skip
 * the state update.
 *
 * Pure so the reorder math is unit-testable without a React tree.
 */
export function reorderTabs<T extends { id: string }>(
  tabs: T[],
  dragId: string,
  targetId: string,
  position: "before" | "after",
): T[] {
  if (dragId === targetId) return tabs;
  const fromIndex = tabs.findIndex((t) => t.id === dragId);
  const targetIndex = tabs.findIndex((t) => t.id === targetId);
  if (fromIndex === -1 || targetIndex === -1) return tabs;

  const without = tabs.filter((_, i) => i !== fromIndex);
  // `without`'s target index shifts left by one if the dragged tab was to
  // its left; convert that to the desired insertion index by adding one for
  // an "after" drop.
  const anchor = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
  const insertAt = position === "before" ? anchor : anchor + 1;
  // No-op when the drop would land where the dragged tab already sits — the
  // insertion index in `without` equals the tab's original index in `tabs`.
  if (insertAt === fromIndex) return tabs;

  without.splice(insertAt, 0, tabs[fromIndex]);
  return without;
}
