import { useCallback, useMemo, useState } from "react";
import { refKey } from "../../../lib/pr/ref";
import type { PrRef } from "../../../lib/pr/types";
import { listViewed, markManyViewed, setViewed } from "../../../lib/pr/viewed";
import {
  PROVIDER_FRESHNESS,
  primeCache,
  type Resource,
  SIDECAR_FRESHNESS,
  useCachedResource,
} from "../../../lib/resourceCache";
import {
  type ReviewFileContent,
  type ReviewTree,
  type ReviewWorkspacePr,
  reviewFile,
  reviewTree,
} from "../../../lib/reviewWorkspaces/api";
import {
  AT_COMMIT,
  changedFilesKey,
  reviewWorkspacePrefix,
  useReviewChangedFiles,
} from "../../../lib/reviewWorkspaces/cache";
import { type LatestRereview, latestRereview } from "../../../lib/reviewWorkspaces/rereview";
import {
  type LatestVerification,
  latestVerification,
  type VerificationMustRead,
  type VerificationReport,
} from "../../../lib/reviewWorkspaces/verification";
import { type ModelSide, reviewUri } from "../editor";

// Re-exported so the tabs and trees reach every review read through this module.
export { changedFilesKey, useReviewChangedFiles };

/**
 * The review workspace's reads, all through `lib/resourceCache` so every tab
 * and tree naming the same PR shares one request, and a tab that remounts
 * paints from the cache rather than blank.
 */

type PrShas = Pick<ReviewWorkspacePr, "id" | "headSha" | "mergeBaseSha">;

export const treeKey = (pr: PrShas) =>
  pr.headSha ? `${reviewWorkspacePrefix(pr.id)}tree:${pr.headSha}` : null;

export function fileKey(pr: PrShas, path: string | null, side: ModelSide): string | null {
  const sha = side === "head" ? pr.headSha : pr.mergeBaseSha;
  return path && sha ? `${reviewWorkspacePrefix(pr.id)}file:${side}:${sha}:${path}` : null;
}

export function useReviewTree(workspaceId: string, pr: PrShas): Resource<ReviewTree> {
  const key = treeKey(pr);
  return useCachedResource(key, () => reviewTree(workspaceId, pr.id), AT_COMMIT);
}

/** One side of a file; `path` null skips the read (an added file has no base). */
export function useReviewFile(
  workspaceId: string,
  pr: PrShas,
  path: string | null,
  side: ModelSide,
): Resource<ReviewFileContent> {
  const key = fileKey(pr, path, side);
  return useCachedResource(key, () => reviewFile(workspaceId, pr.id, path ?? "", side), AT_COMMIT);
}

export const verificationKey = (prId: string) => `${reviewWorkspacePrefix(prId)}verification`;

/** The PR's mutation-testing state: its latest pass and whether a new one may start. */
export const mutationKey = (prId: string) => `${reviewWorkspacePrefix(prId)}mutation`;

/** The PR's latest verification run. Not pinned to a commit: a run finishing changes it. */
export function useLatestVerification(
  workspaceId: string,
  prId: string,
): Resource<LatestVerification> {
  return useCachedResource(
    verificationKey(prId),
    () => latestVerification(workspaceId, prId),
    SIDECAR_FRESHNESS,
  );
}

/** The PR's "What's changed" summaries, for the range from `from` (the last review when null). */
export const rereviewKey = (prId: string, from: string | null) =>
  `${reviewWorkspacePrefix(prId)}rereview:${from ?? "last"}`;

/** The PR's latest re-review summary. Not pinned to a commit: a run finishing changes it. */
export function useLatestRereview(
  workspaceId: string,
  prId: string,
  from: string | null,
): Resource<LatestRereview> {
  return useCachedResource(
    rereviewKey(prId, from),
    () => latestRereview(workspaceId, prId, from ?? undefined),
    SIDECAR_FRESHNESS,
  );
}

/** The report of the latest run that produced one, whatever head it was made at. */
export function reportOf(latest: LatestVerification | null): VerificationReport | null {
  return latest?.lastSucceeded?.run.result ?? null;
}

/** The must-read entry naming `path`, if the report lists it. */
export function mustReadFor(
  report: VerificationReport | null,
  path: string,
): VerificationMustRead | null {
  return report?.mustRead.find((entry) => entry.path === path) ?? null;
}

/** The must-read entries by path, for a tree marking many files at once. */
export function mustReadByPath(
  report: VerificationReport | null,
): ReadonlyMap<string, VerificationMustRead> {
  return new Map((report?.mustRead ?? []).map((entry) => [entry.path, entry]));
}

/**
 * The `review://` URI of a file at one side of a PR. Built in this one place
 * so every tab of a PR names a file the same way and shares its model.
 */
export function modelUri(ref: PrRef, side: ModelSide, path: string): string {
  return reviewUri(refKey(ref), side, path);
}

export const reviewViewedKey = (ref: PrRef) => `review-ws:viewed:${refKey(ref)}`;

export interface ReviewViewed {
  viewed: ReadonlySet<string>;
  /** False until the provider's list has arrived; writes wait for it. */
  ready: boolean;
  error: string | null;
  toggle: (path: string) => Promise<void>;
  /** Marks files viewed without unmarking any already marked. */
  markAllViewed: (paths: string[]) => Promise<void>;
}

/** `current` with `paths` added or removed, as the sorted list the cache holds. */
export function withViewed(
  current: readonly string[] | null,
  paths: readonly string[],
  viewed: boolean,
): string[] {
  const next = new Set(current ?? []);
  for (const p of paths) {
    if (viewed) next.add(p);
    else next.delete(p);
  }
  return [...next].sort();
}

/**
 * Which files the reviewer has marked viewed, shared by every tab and tree of
 * the PR: ticking a file in its diff ticks it in the tree at once. Held as a
 * sorted list rather than a `Set`, since the cache compares values by their
 * JSON and every `Set` serialises to `{}`.
 *
 * A write lands in the cache first and is rolled back if the provider refuses
 * it, the same optimism `usePrViewedFiles` has.
 */
export function useReviewViewed(ref: PrRef): ReviewViewed {
  const key = reviewViewedKey(ref);
  const resource = useCachedResource(
    key,
    async () => [...(await listViewed(ref))].sort(),
    PROVIDER_FRESHNESS,
  );
  const [writeError, setWriteError] = useState<string | null>(null);
  const viewed = useMemo(() => new Set(resource.data ?? []), [resource.data]);
  const ready = resource.data !== null;

  const write = useCallback(
    async (paths: string[], value: boolean, save: () => Promise<string[]>) => {
      if (paths.length === 0) return;
      setWriteError(null);
      primeCache<string[]>(key, (current) => withViewed(current, paths, value));
      const failed = await save();
      if (failed.length === 0) return;
      primeCache<string[]>(key, (current) => withViewed(current, failed, !value));
      setWriteError(
        failed.length === 1
          ? `Could not mark ${failed[0]} ${value ? "viewed" : "unviewed"}`
          : `Could not mark ${failed.length} files viewed`,
      );
    },
    [key],
  );

  const toggle = useCallback(
    async (path: string) => {
      if (!ready) return;
      const value = !viewed.has(path);
      await write([path], value, () =>
        setViewed(ref, path, value).then(
          () => [],
          (e) => {
            console.error(`[review] could not mark ${path}:`, e);
            return [path];
          },
        ),
      );
    },
    [ready, viewed, write, ref],
  );

  const markAllViewed = useCallback(
    async (paths: string[]) => {
      if (!ready) return;
      const added = [...new Set(paths)].filter((p) => !viewed.has(p));
      await write(added, true, () => markManyViewed(ref, added));
    },
    [ready, viewed, write, ref],
  );

  return { viewed, ready, error: writeError ?? resource.error, toggle, markAllViewed };
}
