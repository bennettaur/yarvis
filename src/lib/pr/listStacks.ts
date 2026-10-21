import type { PrSummary } from "./types";

/** One row of a PR list: a PR, and the PRs stacked on it when it is a stack's bottom. */
export interface PrListItem {
  pr: PrSummary;
  /** The layers above `pr`, bottom-first. Empty for a PR that is not stacked. */
  layers: PrSummary[];
}

function createdAtMs(pr: PrSummary): number {
  return new Date(pr.createdAt).getTime() || 0;
}

/**
 * Maps each PR to the PR whose head branch it targets.
 *
 * When two listed PRs share a head branch — one branch opened against two bases,
 * say — the first listed claims it, so a PR on that branch nests under one of
 * them rather than under both.
 */
function linkParents(prs: PrSummary[]): Map<PrSummary, PrSummary> {
  const byHead = new Map<string, PrSummary>();
  for (const pr of prs) {
    if (pr.headRef && !byHead.has(pr.headRef)) byHead.set(pr.headRef, pr);
  }
  const parentOf = new Map<PrSummary, PrSummary>();
  for (const pr of prs) {
    const parent = pr.baseRef ? byHead.get(pr.baseRef) : undefined;
    if (parent) parentOf.set(pr, parent);
  }
  return parentOf;
}

/**
 * GitHub lets PRs target each other's head branches in a loop. Each loop is cut
 * at its first-listed PR, which becomes the bottom, so every walk up or down a
 * stack ends.
 */
function breakCycles(prs: PrSummary[], parentOf: Map<PrSummary, PrSummary>): void {
  for (const pr of prs) {
    const seen = new Set<PrSummary>([pr]);
    for (let ancestor = parentOf.get(pr); ancestor; ancestor = parentOf.get(ancestor)) {
      if (seen.has(ancestor)) {
        if (ancestor === pr) parentOf.delete(pr);
        break;
      }
      seen.add(ancestor);
    }
  }
}

/**
 * Nests each stack in one repo's PRs under its bottom PR.
 *
 * A PR is stacked on another when it targets that PR's head branch — the same
 * inference `GitHubClient.prStack` (sidecar/src/github/client.ts) makes. A list
 * row has no worktree to ask `gh stack`, so this is branch inference only; a
 * PR's own stack view stays the authority. Only PRs in the list are linked, so
 * a stack whose middle layer is missing from the list shows as two.
 *
 * A stack takes the position of its first PR in `prs`. For the newest-first
 * lists that is its newest PR, so a fresh layer on an old stack still surfaces
 * near the top.
 *
 * @param prs One repo's PRs in display order. Branch names only mean something
 *   within a repo, so mixing repos would nest unrelated PRs.
 */
export function nestStacks(prs: PrSummary[]): PrListItem[] {
  const parentOf = linkParents(prs);
  breakCycles(prs, parentOf);

  const childrenOf = new Map<PrSummary, PrSummary[]>();
  for (const [child, parent] of parentOf) {
    const list = childrenOf.get(parent);
    if (list) list.push(child);
    else childrenOf.set(parent, [child]);
  }
  // Depth-first, oldest child first: the order the layers were stacked in.
  const layersAbove = (pr: PrSummary): PrSummary[] =>
    [...(childrenOf.get(pr) ?? [])]
      .sort((a, b) => createdAtMs(a) - createdAtMs(b))
      .flatMap((child) => [child, ...layersAbove(child)]);

  const bottomOf = (pr: PrSummary): PrSummary => {
    let bottom = pr;
    for (let ancestor = parentOf.get(pr); ancestor; ancestor = parentOf.get(ancestor)) {
      bottom = ancestor;
    }
    return bottom;
  };

  const items: PrListItem[] = [];
  const placed = new Set<PrSummary>();
  for (const pr of prs) {
    const bottom = bottomOf(pr);
    if (placed.has(bottom)) continue;
    placed.add(bottom);
    items.push({ pr: bottom, layers: layersAbove(bottom) });
  }
  return items;
}
