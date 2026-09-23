import type { PrSummary } from "./types";

/** One row of a PR list: a PR, and the PRs stacked on it when it is a stack's bottom. */
export interface PrListItem {
  pr: PrSummary;
  /** The layers above `pr`, bottom-first. Empty for a PR that is not stacked. */
  layers: PrSummary[];
}

function createdMs(pr: PrSummary): number {
  return new Date(pr.createdAt).getTime() || 0;
}

/**
 * Nests each stack in one repo's PRs under its bottom PR.
 *
 * A PR is stacked on another when it targets that PR's head branch — the same
 * inference the sidecar's `prStack` walk makes. Only PRs in the list are
 * linked, so a stack whose middle layer is missing from the list shows as two.
 * Stacks keep the position of their newest PR, so a fresh layer on an old stack
 * still surfaces near the top.
 *
 * @param prs One repo's PRs in display order. Branch names only mean something
 *   within a repo, so mixing repos would nest unrelated PRs.
 */
export function nestStacks(prs: PrSummary[]): PrListItem[] {
  const byHead = new Map<string, PrSummary>();
  for (const pr of prs) {
    if (pr.headRef && !byHead.has(pr.headRef)) byHead.set(pr.headRef, pr);
  }

  const parentOf = new Map<PrSummary, PrSummary>();
  for (const pr of prs) {
    const parent = pr.baseRef ? byHead.get(pr.baseRef) : undefined;
    if (parent && parent !== pr) parentOf.set(pr, parent);
  }
  // GitHub allows two PRs to target each other's head branch. A PR whose chain
  // leads back to itself is treated as a bottom so every walk below ends.
  for (const pr of prs) {
    const seen = new Set<PrSummary>([pr]);
    for (let p = parentOf.get(pr); p; p = parentOf.get(p)) {
      if (seen.has(p)) {
        if (p === pr) parentOf.delete(pr);
        break;
      }
      seen.add(p);
    }
  }

  const childrenOf = new Map<PrSummary, PrSummary[]>();
  for (const [child, parent] of parentOf) {
    const list = childrenOf.get(parent);
    if (list) list.push(child);
    else childrenOf.set(parent, [child]);
  }
  // Depth-first, oldest child first: the order the layers were stacked in.
  const layersAbove = (pr: PrSummary): PrSummary[] =>
    [...(childrenOf.get(pr) ?? [])]
      .sort((a, b) => createdMs(a) - createdMs(b))
      .flatMap((child) => [child, ...layersAbove(child)]);

  const bottomOf = (pr: PrSummary): PrSummary => {
    let bottom = pr;
    for (let p = parentOf.get(pr); p; p = parentOf.get(p)) bottom = p;
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
