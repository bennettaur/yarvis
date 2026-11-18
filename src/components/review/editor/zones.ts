import type { DiffSide, EditorZone } from "./types";

/**
 * One changed hunk as Monaco's diff reports it (`ILineChange`). An end of 0
 * means that side has no lines in the hunk, and its start is then the line the
 * other side's lines sit after.
 */
export interface LineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

/**
 * Where a line of the original file shows up in an inline diff, which has no
 * original editor of its own: the modified line it sits after. A line in an
 * unchanged stretch maps to its twin; a removed line maps to the end of its
 * hunk, below both the removed lines and their replacements, so a thread on
 * it reads after the change it is about.
 */
export function originalLineInModified(line: number, changes: readonly LineChange[]): number {
  let shift = 0;
  for (const change of changes) {
    const originalHasLines = change.originalEndLineNumber > 0;
    const modifiedHasLines = change.modifiedEndLineNumber > 0;
    const originalStart = originalHasLines
      ? change.originalStartLineNumber
      : change.originalStartLineNumber + 1;
    if (line < originalStart) break;
    if (originalHasLines && line <= change.originalEndLineNumber) {
      return modifiedHasLines ? change.modifiedEndLineNumber : change.modifiedStartLineNumber;
    }
    const originalCount = originalHasLines
      ? change.originalEndLineNumber - change.originalStartLineNumber + 1
      : 0;
    const modifiedCount = modifiedHasLines
      ? change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1
      : 0;
    shift += modifiedCount - originalCount;
  }
  return Math.max(0, line + shift);
}

/** Which editor a zone is drawn in, and after which of that editor's lines. */
export interface ZonePlacement {
  editor: DiffSide;
  afterLine: number;
}

/**
 * Places each zone in a diff. Side by side, a zone sits in the editor for its
 * side. Inline there is only the modified editor, so left-side zones move into
 * it at their mapped line.
 */
export function placeZones(
  zones: readonly EditorZone[],
  sideBySide: boolean,
  changes: readonly LineChange[],
): Map<string, ZonePlacement> {
  const placed = new Map<string, ZonePlacement>();
  for (const zone of zones) {
    if (sideBySide || zone.side === "RIGHT") {
      placed.set(zone.id, { editor: zone.side, afterLine: zone.afterLine });
    } else {
      placed.set(zone.id, {
        editor: "RIGHT",
        afterLine: originalLineInModified(zone.afterLine, changes),
      });
    }
  }
  return placed;
}

export interface ZoneDiff<Next> {
  /** Ids to add, with where. */
  add: [string, Next][];
  /** Ids to take out. */
  remove: string[];
}

/**
 * What to change to go from the zones on screen to the zones wanted. A zone
 * that moved is removed and added again, since Monaco cannot move a view zone
 * to another line in place. The zone's DOM node is reused either way, so its
 * React content keeps its state (a half-written reply) through the move.
 */
export function diffZones<Current, Next>(
  current: ReadonlyMap<string, Current>,
  next: ReadonlyMap<string, Next>,
  samePlace: (was: Current, now: Next) => boolean,
): ZoneDiff<Next> {
  const add: [string, Next][] = [];
  const remove: string[] = [];
  for (const [id, was] of current) {
    const now = next.get(id);
    if (!now || !samePlace(was, now)) remove.push(id);
  }
  for (const [id, now] of next) {
    const was = current.get(id);
    if (!was || !samePlace(was, now)) add.push([id, now]);
  }
  return { add, remove };
}
