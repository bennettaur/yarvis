/**
 * The pane layout inside a terminal tab. A leaf is one terminal; a split is two
 * panes laid out either side-by-side ("vertical" divider) or stacked
 * ("horizontal" divider). The structure mirrors how tmux/iTerm think of splits.
 *
 * Pure data — no React, no DOM — so the splitting/closing math is unit-testable.
 */

export type PaneId = string;

/** "vertical" = vertical divider (panes side-by-side), "horizontal" = horizontal divider (panes stacked). */
export type SplitDirection = "vertical" | "horizontal";

export type Pane =
  | { kind: "leaf"; id: PaneId }
  | { kind: "split"; direction: SplitDirection; first: Pane; second: Pane };

export const leaf = (id: PaneId): Pane => ({ kind: "leaf", id });

/** Pre-order list of every leaf id in the tree. */
export function allLeafIds(pane: Pane): PaneId[] {
  if (pane.kind === "leaf") return [pane.id];
  return [...allLeafIds(pane.first), ...allLeafIds(pane.second)];
}

/** The first (leftmost/topmost) leaf id in the tree — never null because a tree always has at least one leaf. */
export function firstLeafId(pane: Pane): PaneId {
  return pane.kind === "leaf" ? pane.id : firstLeafId(pane.first);
}

/**
 * Splits the leaf with id `target` in two: the original on one side, a new leaf
 * with id `newId` on the other. With `placeNewAfter` true (the default) the new
 * pane appears to the right (vertical) or below (horizontal); flip it to place
 * the new pane before instead.
 *
 * Returns the same tree reference if `target` is not found — callers should
 * treat that as a no-op rather than special-case it.
 */
export function splitPane(
  pane: Pane,
  target: PaneId,
  direction: SplitDirection,
  newId: PaneId,
  placeNewAfter = true,
): Pane {
  if (pane.kind === "leaf") {
    if (pane.id !== target) return pane;
    const fresh = leaf(newId);
    return {
      kind: "split",
      direction,
      first: placeNewAfter ? pane : fresh,
      second: placeNewAfter ? fresh : pane,
    };
  }
  const first = splitPane(pane.first, target, direction, newId, placeNewAfter);
  if (first !== pane.first) return { ...pane, first };
  const second = splitPane(pane.second, target, direction, newId, placeNewAfter);
  if (second !== pane.second) return { ...pane, second };
  return pane;
}

/**
 * Removes the leaf with id `target`. When the leaf is one side of a split, the
 * surviving side replaces the split, collapsing the parent.
 *
 * Returns `null` when the only leaf in the tree is removed; callers treat that
 * as "this tab is now empty" and close the tab itself.
 */
export function removePane(pane: Pane, target: PaneId): Pane | null {
  if (pane.kind === "leaf") return pane.id === target ? null : pane;
  const first = removePane(pane.first, target);
  if (first === null) return pane.second;
  const second = removePane(pane.second, target);
  if (second === null) return pane.first;
  if (first === pane.first && second === pane.second) return pane;
  return { ...pane, first, second };
}

/**
 * The pane that should receive focus after `removed` is closed: the first leaf
 * id in the surviving tree, or `null` when the tree itself is gone.
 */
export function nextFocusAfterRemove(pane: Pane, removed: PaneId): PaneId | null {
  const next = removePane(pane, removed);
  return next ? firstLeafId(next) : null;
}

/** True if the tree contains a leaf with the given id. */
export function hasPane(pane: Pane, id: PaneId): boolean {
  if (pane.kind === "leaf") return pane.id === id;
  return hasPane(pane.first, id) || hasPane(pane.second, id);
}
