import type { PrRef } from "../../../lib/pr/types";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";

/** Tabs a PR has at most one of, pinned to the left of the strip in this order. */
export type StaticTabKind =
  | "description"
  | "reviewers"
  | "checks"
  | "comments"
  | "guide"
  | "verification"
  | "mutation";

export type TabSpec =
  | { kind: StaticTabKind; prId: string }
  | { kind: "diff"; prId: string; path: string; revealLine?: number; revealNonce?: number }
  | { kind: "file"; prId: string; path: string; revealLine?: number; revealNonce?: number };

/** Identity of a tab: opening a spec whose id is already open focuses that tab. */
export const tabId = (t: TabSpec) => `${t.kind}:${t.prId}${"path" in t ? `:${t.path}` : ""}`;

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
