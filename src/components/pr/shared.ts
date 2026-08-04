import { refDomKey } from "../../lib/pr/ref";
import type { PrRef } from "../../lib/pr/types";

export type { PrRef } from "../../lib/pr/types";

/**
 * Stable DOM id for one file's diff, so a `PrFileList` item can scroll to the
 * matching `PrFileDiffs` entry — even when the two are separate components in
 * an Omni layout. The ref key keeps ids unique when several PRs share a page.
 */
export function prFileAnchorId(ref: PrRef, index: number): string {
  return `prfile-${refDomKey(ref)}-${index}`;
}

/**
 * A place in the diff the review wants the reader's eyes on — currently the
 * step of a guided review. The file is opened, scrolled to, and the lines are
 * marked.
 *
 * `nonce` is bumped every time the reader lands on the target, including
 * landing on the one they are already on. Without it, clicking a step's own
 * location to get back to it would change nothing to react to, and the jump
 * would silently do nothing.
 */
export interface DiffFocus {
  path: string;
  startLine: number | null;
  endLine: number | null;
  nonce: number;
}

/** The line range to mark within a file, or null when the focus names no lines. */
export function focusRange(focus: DiffFocus | null): { start: number; end: number } | null {
  if (!focus || focus.startLine == null) return null;
  return { start: focus.startLine, end: focus.endLine ?? focus.startLine };
}

/** Marks the first row of a focused range, so a scroll can find it in the DOM. */
export const FOCUS_ATTR = "data-pr-focus";

/**
 * Inline rather than a class: the row already carries a background from
 * `rowClass`, and two Tailwind utilities setting the same property leave which
 * one wins down to stylesheet order.
 */
export const FOCUS_STYLE = { boxShadow: "inset 3px 0 0 0 #38bdf8" } as const;
