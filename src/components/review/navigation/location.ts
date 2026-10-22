import { type EditorRange, parseReviewUri } from "../editor";

/** The tabs a jump can open; structurally a subset of the review tab model's `TabSpec`. */
export type NavigationTab =
  | { kind: "diff"; prId: string; path: string; revealLine?: number }
  | { kind: "file"; prId: string; path: string; revealLine?: number };

export interface NavigationTargets {
  prId: string;
  refKey: string;
  /** Every path at the PR's head. */
  tree: ReadonlySet<string>;
  /** Paths the PR changes, deleted ones included. */
  changed: ReadonlySet<string>;
}

/**
 * The tab a go-to-definition landing opens: the diff when the PR changes the
 * file, so the reviewer sees the change in context, the plain file otherwise.
 * The URI comes from a definition provider or the TypeScript worker reading
 * PR code, so it is checked, not trusted: it must be a review URI naming a
 * file this PR has.
 */
export function tabForLocation(
  uri: string,
  range: EditorRange | null,
  targets: NavigationTargets,
  shimTargets: ReadonlyMap<string, string> = new Map(),
): NavigationTab | null {
  const parsed = parseReviewUri(uri);
  if (!parsed || parsed.refKey !== targets.refKey) return null;
  // A jump on an alias's module string lands on its stand-in (`shims.ts`);
  // the file it stands for is what to open, at its top.
  const shimTarget = shimTargets.get(parsed.path);
  const path = shimTarget ?? parsed.path;
  const line = shimTarget ? undefined : range?.startLineNumber;
  const changed = targets.changed.has(path);
  if (!changed && !targets.tree.has(path)) return null;
  return {
    kind: changed ? "diff" : "file",
    prId: targets.prId,
    path,
    ...(line !== undefined ? { revealLine: line } : {}),
  };
}
