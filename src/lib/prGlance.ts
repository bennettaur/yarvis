/**
 * Collapses a workspace repo's cached PR row into the single state its list-row
 * icon shows. The list is scanned, not read: one glyph per PR has to answer
 * "does this need me?", so the states are ordered by what the user would act on
 * first rather than by how the provider models them.
 */

import type { StackEntry } from "./pr/types";
import type { WorkspaceSummaryPr } from "./workspaces";

export type PrGlance =
  | "merged"
  | "queued"
  | "closed"
  | "draft"
  | "conflicts"
  | "checks_failing"
  | "changes_requested"
  | "checks_running"
  | "approved"
  | "open"
  | "no_pr";

export interface PrGlanceBadge {
  icon: string;
  /** Tooltip/screen-reader text, PR number included. */
  label: string;
  /** The state on its own ("checks failing"), for showing beside the glyph. */
  status: string;
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

export function prGlance(pr: WorkspaceSummaryPr): PrGlance {
  // A row only reaches here with a PR number, so an unset state is a provider
  // that didn't say — which for a PR that exists means open.
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
  // Whatever reaches here has settled checks — failure and pending returned above.
  if (pr.reviewDecision === "approved") return "approved";
  return "open";
}

const GLANCE_BADGES: Record<PrGlance, { icon: string; label: string; className: string }> = {
  merged: { icon: "◆", label: "merged", className: "text-violet-400" },
  queued: { icon: "⇥", label: "queued to merge", className: "text-violet-300" },
  closed: { icon: "⊘", label: "closed", className: "text-zinc-500" },
  draft: { icon: "◌", label: "draft", className: "text-zinc-400" },
  conflicts: { icon: "⚠", label: "merge conflicts", className: "text-red-400" },
  checks_failing: { icon: "✗", label: "checks failing", className: "text-red-400" },
  changes_requested: { icon: "✎", label: "changes requested", className: "text-amber-400" },
  checks_running: { icon: "●", label: "checks running", className: "text-amber-400" },
  // "approved", not "ready to merge": one approval is all the poller knows
  // about, and a repo's own rules (required reviewers, CODEOWNERS) can still
  // hold the merge.
  approved: { icon: "✓", label: "approved", className: "text-emerald-400" },
  open: { icon: "◇", label: "open — awaiting review", className: "text-sky-400" },
  // Only a stack layer reaches this: `gh stack` tracks a branch from the moment
  // it is created, well before it is pushed and given a pull request.
  no_pr: { icon: "·", label: "no pull request yet", className: "text-zinc-600" },
};

/** The icon, color and tooltip text for one PR's list-row badge. */
export function prGlanceBadge(pr: WorkspaceSummaryPr): PrGlanceBadge {
  const style = GLANCE_BADGES[prGlance(pr)];
  return {
    icon: style.icon,
    label: `${pr.repoName} #${pr.prNumber} ${style.label}`,
    status: style.label,
    className: style.className,
  };
}

/**
 * The same one-glyph verdict for a layer of a stack. Shares the vocabulary with
 * the workspace list deliberately: a stack is read the same way, scanning for
 * the layer that is holding the rest up.
 *
 * Conflicts are absent because a stack entry carries no mergeable state — the
 * stack's equivalent, "the layer below moved", is rendered beside the badge
 * rather than folded into it, since a layer can need restacking and be failing
 * checks at once and the reader needs both.
 */
export function stackEntryGlance(entry: StackEntry): PrGlance {
  if (entry.merged) return "merged";
  if (entry.queued) return "queued";
  if (entry.number === 0) return "no_pr";
  if (entry.state === "closed") return "closed";
  if (entry.draft) return "draft";
  if (entry.checks.failure > 0) return "checks_failing";
  if (entry.reviewDecision === "changes_requested") return "changes_requested";
  if (entry.checks.pending > 0) return "checks_running";
  if (entry.reviewDecision === "approved") return "approved";
  return "open";
}

/** The icon, color and tooltip text for one stack layer's badge. */
export function stackEntryBadge(entry: StackEntry): PrGlanceBadge {
  const style = GLANCE_BADGES[stackEntryGlance(entry)];
  return {
    icon: style.icon,
    label: entry.number ? `#${entry.number} ${style.label}` : `${entry.headRef} ${style.label}`,
    status: style.label,
    className: style.className,
  };
}
