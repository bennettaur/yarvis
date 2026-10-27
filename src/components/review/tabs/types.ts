import type { PrRef } from "../../../lib/pr/types";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";

/** Tabs a PR has at most one of, pinned to the left of the strip in this order. */
export type StaticTabKind =
  | "description"
  | "reviewers"
  | "checks"
  | "comments"
  | "since-review"
  | "guide"
  | "verification"
  | "mutation";

export type TabSpec =
  | { kind: StaticTabKind; prId: string }
  | { kind: "diff"; prId: string; path: string; revealLine?: number; revealNonce?: number }
  | { kind: "file"; prId: string; path: string; revealLine?: number; revealNonce?: number }
  /**
   * How one file's part in the PR changed since a review. `from` is the
   * reviewed head, kept on the tab so a later "Mark reviewed here" doesn't
   * empty a tab the reader is still looking at.
   */
  | { kind: "since-file"; prId: string; path: string; from: string }
  /** One of the PR's commits, diffed against its parent; `subject` titles the tab. */
  | { kind: "commit"; prId: string; sha: string; subject?: string };

/** The kinds a PR can have many of, each naming a file or a commit. */
export type DynamicTabKind = Exclude<TabSpec["kind"], StaticTabKind>;

/** Identity of a tab: opening a spec whose id is already open focuses that tab. */
export const tabId = (t: TabSpec) =>
  `${t.kind}:${t.prId}${"path" in t ? `:${t.path}` : "sha" in t ? `:${t.sha}` : ""}`;

/** One PR's colour as Tailwind classes, written out in full so the build keeps them. */
export interface PrColor {
  name: string;
  bg: string;
  border: string;
  text: string;
}

/**
 * What every tab body is rendered with. One object per PR, kept while nothing
 * in it changes, so a tab out of sight isn't re-rendered by another's work.
 */
export interface TabContext {
  workspaceId: string;
  pr: ReviewWorkspacePr;
  prRef: PrRef;
  diffMode: "split" | "unified";
  openTab: (spec: TabSpec) => void;
  /** Opens the PR's setup consent prompt, which running its code waits on. */
  openSetup: () => void;
}
