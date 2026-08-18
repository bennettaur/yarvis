/**
 * Collapses a workspace repo's cached PR row into the single state its list-row
 * icon shows. The list is scanned, not read: one glyph per PR has to answer
 * "does this need me?", so the states are ordered by what the user would act on
 * first rather than by how the provider models them.
 */

import type { CheckRollup, WorkspaceSummaryPr } from "./workspaces";

export type PrGlance =
  | "merged"
  | "closed"
  | "draft"
  | "conflicts"
  | "checks_failing"
  | "changes_requested"
  | "checks_running"
  | "ready"
  | "open";

export interface PrGlanceBadge {
  state: PrGlance;
  icon: string;
  /** Tooltip/screen-reader text, PR number included. */
  label: string;
  /** Tailwind text color for the glyph. */
  className: string;
}

/**
 * True when the cached mergeable value signals conflicts against the base.
 * GitHub reports "dirty" (its `mergeable_state`); Azure reports "CONFLICTING"
 * (the shared enum the poller stores), which older GitHub GraphQL rows also
 * used — so match either, case-insensitively.
 */
export function hasConflicts(mergeable: string | null): boolean {
  const m = (mergeable ?? "").toLowerCase();
  return m === "dirty" || m === "conflicting";
}

/** A check rollup that leaves nothing red or in flight. */
function checksSettled(rollup: CheckRollup): boolean {
  return rollup === "success" || rollup === "none";
}

export function prGlance(pr: WorkspaceSummaryPr): PrGlance {
  const state = (pr.prState ?? "open").toLowerCase();
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  // A draft is the author's own "not ready" flag: nothing about its checks or
  // reviews is asking anyone for anything yet.
  if (pr.isDraft) return "draft";
  if (hasConflicts(pr.mergeable)) return "conflicts";
  if (pr.checkRollup === "failure") return "checks_failing";
  if (pr.reviewDecision === "changes_requested") return "changes_requested";
  if (pr.checkRollup === "pending") return "checks_running";
  if (pr.reviewDecision === "approved" && checksSettled(pr.checkRollup)) return "ready";
  return "open";
}

const GLANCE_STYLES: Record<PrGlance, { icon: string; label: string; className: string }> = {
  merged: { icon: "◆", label: "merged", className: "text-violet-400" },
  closed: { icon: "⊘", label: "closed", className: "text-zinc-500" },
  draft: { icon: "◌", label: "draft", className: "text-zinc-400" },
  conflicts: { icon: "⚠", label: "merge conflicts", className: "text-red-400" },
  checks_failing: { icon: "✗", label: "checks failing", className: "text-red-400" },
  changes_requested: { icon: "✎", label: "changes requested", className: "text-amber-400" },
  checks_running: { icon: "●", label: "checks running", className: "text-amber-400" },
  ready: { icon: "✓", label: "approved — ready to merge", className: "text-emerald-400" },
  open: { icon: "◇", label: "open — awaiting review", className: "text-sky-400" },
};

/** The icon, color and tooltip text for one PR's list-row badge. */
export function prGlanceBadge(pr: WorkspaceSummaryPr): PrGlanceBadge {
  const state = prGlance(pr);
  const style = GLANCE_STYLES[state];
  return {
    state,
    icon: style.icon,
    label: `${pr.repoName} #${pr.prNumber} ${style.label}`,
    className: style.className,
  };
}
