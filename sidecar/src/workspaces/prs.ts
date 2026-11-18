import type { WorkspaceRepoPr } from "../db/schema.ts";

/**
 * Picking among a workspace repo's PRs. A repo can have several, but some
 * places need one: the right column's checks, the stack view's anchor, the
 * merged PR archive records. They use the main PR: the newest open PR on the
 * repo's own worktree branch, then the newest merged one there, then the
 * newest of the rest.
 */

type Pr = Pick<WorkspaceRepoPr, "prNumber" | "prState" | "headBranch" | "dismissed">;

/**
 * Whether a PR merges from `branch`. A PR with no head branch recorded was
 * found by a search of the repo's own branch before head branches were kept.
 */
export function isOnBranch(pr: Pr, branch: string): boolean {
  return pr.headBranch === null || pr.headBranch === branch;
}

/** Open before merged before closed; newest (highest number) first within each. */
function byRelevance(a: Pr, b: Pr): number {
  const rank = (pr: Pr) => (pr.prState === "merged" ? 1 : pr.prState === "closed" ? 2 : 0);
  return rank(a) - rank(b) || b.prNumber - a.prNumber;
}

/** The PRs to show for a repo, the main one first: own branch first, then by relevance. */
export function orderPrs<T extends Pr>(prs: T[], branch: string): T[] {
  return prs
    .filter((pr) => !pr.dismissed)
    .sort(
      (a, b) => Number(isOnBranch(b, branch)) - Number(isOnBranch(a, branch)) || byRelevance(a, b),
    );
}

/** The repo's main PR, or null when it has none. */
export function mainPr<T extends Pr>(prs: T[], branch: string): T | null {
  return orderPrs(prs, branch)[0] ?? null;
}

/** The main PR among those on `branch` only, or null. */
export function branchPr<T extends Pr>(prs: T[], branch: string): T | null {
  return mainPr(
    prs.filter((pr) => isOnBranch(pr, branch)),
    branch,
  );
}
