import type { ReactNode } from "react";

/** Which half of a diff a line belongs to, in the providers' own terms. */
export type DiffSide = "LEFT" | "RIGHT";

/** Which version of a file a model holds: the merge-base or the PR's head. */
export type ModelSide = "base" | "head";

export type LineActionKind = "comment" | "ask";

/** A request to comment on, or ask about, one line or a run of lines. */
export interface LineAction {
  kind: LineActionKind;
  side: DiffSide;
  startLine: number;
  endLine: number;
}

/**
 * React content shown between lines: a comment thread, an answer. In a diff,
 * `side` picks the editor it sits in and `afterLine` is that side's numbering.
 */
export interface EditorZone {
  id: string;
  /** 0 puts the zone above the first line. */
  afterLine: number;
  side: DiffSide;
  render: () => ReactNode;
}

/**
 * Highlights a run of lines in a file view. Class names must be plain CSS
 * identifiers: Monaco turns characters such as `/` and `:` into spaces, so a
 * Tailwind class like `bg-amber-500/10` arrives as two unrelated classes.
 */
export interface LineDecoration {
  startLine: number;
  endLine: number;
  /** Applied to the whole line. */
  className?: string;
  /** Applied to the line-number gutter. */
  marginClassName?: string;
  /** Rendered as markdown; pass untrusted text through `plainHoverText`. */
  hoverMessage?: string;
}

/** A 1-based range in Monaco's terms, without depending on Monaco's types. */
export interface EditorRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}
