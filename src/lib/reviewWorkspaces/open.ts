import { type OpenReviewRequest, requestOpenReview } from "../nav";
import { refDisplayRepo, refKey, refNumber } from "../pr/ref";
import type { PrRef } from "../pr/types";
import { primeCache } from "../resourceCache";
import {
  addReviewPr,
  createReviewWorkspace,
  listReviewWorkspaces,
  type ReviewWorkspace,
  type ReviewWorkspaceSummary,
} from "./api";
import { invalidateReviewWorkspace, REVIEW_WORKSPACES_KEY, reviewWorkspaceKey } from "./cache";

/** The PR's page on its provider, for "open on GitHub" when only the ref is known. */
export function prWebUrl(ref: PrRef): string {
  if (ref.provider === "github") {
    return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
  }
  const seg = (s: string) => encodeURIComponent(s);
  return `https://dev.azure.com/${seg(ref.org)}/${seg(ref.project)}/_git/${seg(ref.repo)}/pullrequest/${ref.prId}`;
}

/** "repo#12", the short name a new workspace gets when its PR's title isn't known. */
export const shortPrName = (ref: PrRef) =>
  `${refDisplayRepo(ref).split("/").pop()}#${refNumber(ref)}`;

/**
 * The active workspace already reviewing `ref`, most recently opened first, so
 * opening a PR twice lands on the same tabs instead of a second checkout.
 */
export function findWorkspaceWithPr(
  workspaces: ReviewWorkspaceSummary[],
  ref: PrRef,
): { workspaceId: string; prId: string } | null {
  const key = refKey(ref);
  const opened = (w: ReviewWorkspaceSummary) => w.lastOpenedAt ?? w.createdAt;
  const candidates = workspaces
    .filter((w) => w.status === "active")
    .sort((a, b) => opened(b).localeCompare(opened(a)));
  for (const w of candidates) {
    const pr = w.prs.find((p) => p.refKey === key);
    if (pr) return { workspaceId: w.id, prId: pr.id };
  }
  return null;
}

function remember(ws: ReviewWorkspace): void {
  primeCache(reviewWorkspaceKey(ws.id), ws);
  primeCache<ReviewWorkspaceSummary[]>(REVIEW_WORKSPACES_KEY, (current) => {
    const list = current ?? [];
    return list.some((w) => w.id === ws.id)
      ? list.map((w) => (w.id === ws.id ? ws : w))
      : [ws, ...list];
  });
}

/**
 * Opens `ref` in the review workspace already holding it, or a new one named
 * after it, and asks the app to show the Review tab there. The clone runs in
 * the background; the workspace is usable before it finishes. `tab` picks the
 * PR tab to open there instead of its description.
 */
export async function openInReviewWorkspace(
  ref: PrRef,
  title?: string,
  tab?: OpenReviewRequest["tab"],
): Promise<void> {
  const existing = findWorkspaceWithPr(await listReviewWorkspaces(), ref);
  if (existing) {
    requestOpenReview({ ...existing, tab });
    return;
  }
  const ws = await createReviewWorkspace({ name: title?.trim() || shortPrName(ref), refs: [ref] });
  remember(ws);
  requestOpenReview({ workspaceId: ws.id, prId: ws.prs[0]?.id, tab });
}

/** Adds `ref` to an existing workspace and shows it there. */
export async function addToReviewWorkspace(workspaceId: string, ref: PrRef): Promise<void> {
  const pr = await addReviewPr(workspaceId, ref);
  // The Review tab may be holding this workspace without the new PR.
  invalidateReviewWorkspace(workspaceId);
  requestOpenReview({ workspaceId, prId: pr.id });
}
