/**
 * Review marks as a review workspace uses them: the last review of a PR, the
 * commit it was at kept alive in the review clone, and the reads built on it —
 * what changed since (files and commits), one file's interdiff, the PR's
 * commits and one commit's own diff.
 *
 * The git is in `sinceReview.ts`; this resolves which commits to compare, from
 * the PR row and its marks, and caches the answers by sha.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { PrReviewMark } from "../db/schema.ts";
import { describeError } from "../llm/errors.ts";
import {
  findReviewMark,
  latestReviewMark,
  providerMarks,
  type ReviewMarkInput,
  type ReviewMarkResponse,
  recordReviewMark,
  setMarkMergeBase,
  toMarkResponse,
} from "../pr/reviewMarks.ts";
import type { PrRef } from "../pr/types.ts";
import { MAX_FILE_BYTES } from "../workspaces/files.ts";
import { git } from "../workspaces/git.ts";
import { stringsSize } from "./cache.ts";
import { type FileAtSide, fileDiffBetween, type ReviewChangedFile } from "./git.ts";
import {
  cache,
  cachedFileAt,
  changedFiles,
  defaultReviewDeps,
  getReviewPr,
  keepReviewedCommit,
  type ReadyPr,
  type ReviewDeps,
  ReviewWorkspaceError,
  refDomKey,
  requireReadyPr,
  reviewClonePath,
  withCloneLock,
} from "./service.ts";
import {
  commitsSince,
  ensureCommit,
  fastForward,
  fileSince,
  filesSince,
  isAncestor,
  listCommits,
  MAX_COUNTED_FILES,
  mergeBaseOf,
  overCap,
  parentOf,
  pinReviewedCommit,
  type ReviewCommit,
  type SinceCommits,
  type SinceEntry,
  type SinceFile,
  type SinceFileView,
  type SinceRange,
} from "./sinceReview.ts";

/**
 * Pins `sha` in the PR repo's review clone, when there is one: a mark made
 * from the classic page is still worth keeping alive for the next review
 * workspace. Null when there is no clone; false when the commit can't be had.
 */
async function pinInClone(
  config: Config,
  ref: PrRef,
  sha: string,
  deps: ReviewDeps,
): Promise<boolean | null> {
  const clonePath = reviewClonePath(config, ref);
  if (!existsSync(join(clonePath, ".git"))) return null;
  const runners = deps.git({ credentials: deps.credentialsFor(ref) });
  return keepReviewedCommit(runners, clonePath, ref, sha);
}

/**
 * Records a mark for a review or comment that has already gone through, and
 * pins its commit in the background. Never throws: the review is posted
 * whatever happens here, so a failure is logged rather than reported as the
 * review failing.
 */
export async function markReviewed(
  db: Db,
  config: Config,
  input: ReviewMarkInput,
  deps: ReviewDeps = defaultReviewDeps(db, config),
): Promise<PrReviewMark | null> {
  try {
    const mark = await recordReviewMark(db, input);
    void pinInClone(config, input.ref, input.headSha, deps).catch((e) =>
      console.warn("[review-workspaces] could not keep the reviewed commit:", describeError(e)),
    );
    return mark;
  } catch (e) {
    console.warn("[review-workspaces] could not record the review mark:", describeError(e));
    return null;
  }
}

export interface LastReview {
  mark: ReviewMarkResponse | null;
  /**
   * The review clone has the mark's commit (fetching it if it had to; the
   * next refresh pins it); null before the PR is cloned.
   */
  shaExists: boolean | null;
  /** The commit the checkout is at. */
  headSha: string | null;
  /** The mark is at the checkout's head: nothing to see since. */
  upToDate: boolean;
}

/** The PR's latest mark, after reading the viewer's provider-side reviews in. */
async function latestMark(db: Db, ref: PrRef, deps: ReviewDeps): Promise<PrReviewMark | null> {
  await providerMarks.sync(db, ref, deps.markProvider?.(ref) ?? null);
  return latestReviewMark(db, ref);
}

export async function reviewLastReview(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
): Promise<LastReview> {
  const pr = await getReviewPr(db, workspaceId, prId);
  const mark = await latestMark(db, pr.ref, deps);
  if (!mark) return { mark: null, shaExists: null, headSha: pr.headSha, upToDate: false };
  // A read: fetches the commit if it must, without the clone lock, and leaves
  // pinning it to the refresh or the mark that records it.
  const shaExists =
    pr.status === "ready"
      ? await ensureCommit(
          deps.git({ credentials: deps.credentialsFor(pr.ref) }),
          reviewClonePath(config, pr.ref),
          mark.headSha,
        )
      : null;
  return {
    mark: toMarkResponse(mark),
    shaExists,
    headSha: pr.headSha,
    upToDate: mark.headSha === pr.headSha,
  };
}

/** "Mark reviewed here": a manual mark at the commit the checkout is at. */
export async function markReviewPrHere(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
): Promise<ReviewMarkResponse> {
  const ready = await requireReadyPr(db, config, workspaceId, prId, deps);
  const mark = await recordReviewMark(db, {
    ref: ready.pr.ref,
    headSha: ready.headSha,
    baseSha: ready.pr.baseSha,
    mergeBaseSha: ready.mergeBaseSha,
    source: "manual",
  });
  await withCloneLock(ready.clonePath, () =>
    pinReviewedCommit(ready.runners, ready.clonePath, refDomKey(ready.pr.ref), ready.headSha),
  );
  return toMarkResponse(mark);
}

/**
 * The commits to compare: the reviewed head (`from`, else the last mark's) and
 * its merge-base, against the checkout's. `from` has to be a commit a review
 * of this PR was recorded at, so a request can't make the clone fetch, or
 * compare from, an arbitrary sha. The reviewed commit is fetched if the clone
 * lacks it — without the clone lock, and without pinning it, which the mark's
 * recording and each refresh do. Its merge-base is the mark's when it recorded
 * one that is an ancestor of it; otherwise it is worked out against today's
 * base tip, which gives the same answer for a base that has only moved
 * forward since — and is stored on a mark that had none.
 */
async function resolveRange(
  db: Db,
  ready: ReadyPr,
  deps: ReviewDeps,
  from: string | undefined,
): Promise<{ range: SinceRange; mark: PrReviewMark }> {
  const mark = from
    ? await findReviewMark(db, ready.pr.ref, from)
    : await latestMark(db, ready.pr.ref, deps);
  if (!mark) {
    if (from) throw new ReviewWorkspaceError("from must be a commit a review was recorded at", 400);
    throw new ReviewWorkspaceError("no review of this pull request is recorded yet", 404);
  }
  const fromHead = mark.headSha;
  if (!(await ensureCommit(ready.runners, ready.clonePath, fromHead))) {
    throw new ReviewWorkspaceError(
      `the reviewed commit ${fromHead.slice(0, 12)} can no longer be fetched`,
      404,
    );
  }
  let fromMergeBase = mark.mergeBaseSha;
  // A recorded merge-base came from a client; it counts only if it is one.
  if (
    fromMergeBase &&
    !(await isAncestor(ready.runners, ready.clonePath, fromMergeBase, fromHead))
  ) {
    fromMergeBase = null;
  }
  if (!fromMergeBase) {
    fromMergeBase = await mergeBaseOf(
      ready.runners,
      ready.clonePath,
      ready.pr.baseSha ?? ready.mergeBaseSha,
      fromHead,
    );
    if (!fromMergeBase) {
      throw new ReviewWorkspaceError("the reviewed commit shares no history with the base", 409);
    }
    await setMarkMergeBase(db, mark.id, fromMergeBase);
  }
  return {
    range: {
      fromHead,
      fromMergeBase,
      toHead: ready.headSha,
      toMergeBase: ready.mergeBaseSha,
    },
    mark,
  };
}

const rangeKey = (clonePath: string, r: SinceRange) =>
  `${clonePath}:${r.fromMergeBase}..${r.fromHead}:${r.toMergeBase}..${r.toHead}`;

function sinceEntries(ready: ReadyPr, range: SinceRange): Promise<SinceEntry[]> {
  return cache.get(
    `since:${rangeKey(ready.clonePath, range)}`,
    () =>
      filesSince(ready.runners, ready.clonePath, range, (from, to) =>
        changedFiles(ready.runners, ready.clonePath, from, to),
      ),
    (entries) => stringsSize(entries.map((e) => e.path)) + entries.length * 128,
  );
}

function sinceView(ready: ReadyPr, range: SinceRange, entry: SinceEntry): Promise<SinceFileView> {
  return cache.get(
    `since-file:${rangeKey(ready.clonePath, range)}:${entry.path}`,
    () => fileSince(ready.runners, range, entry, (sha, path) => cachedFileAt(ready, sha, path)),
    (view) =>
      (view.original?.content.length ?? 0) +
      (view.modified?.content.length ?? 0) +
      view.patch.length +
      128,
  );
}

function sinceCommits(ready: ReadyPr, range: SinceRange): Promise<SinceCommits> {
  return cache.get(
    `since-commits:${rangeKey(ready.clonePath, range)}`,
    () => commitsSince(ready.runners, ready.clonePath, range),
    (c) => (c.commits.length + c.removed.length) * 256,
  );
}

const unreadable = (entry: SinceEntry) => entry.binary || overCap(entry.sizes);

export interface SinceReview {
  fromHeadSha: string;
  toHeadSha: string;
  fromMergeBase: string;
  toMergeBase: string;
  /** History was rewritten: the reviewed head isn't in today's head (a rebase or force-push). */
  rebased: boolean;
  /** The merge-base moved: a rebase onto, or a merge of, a newer base. */
  baseMoved: boolean;
  /** The mark this compares from: the last review's, or the one `from` named. */
  mark: ReviewMarkResponse;
  files: SinceFile[];
  /** More files changed than were counted; the rest list with zero counts. */
  filesTruncated: boolean;
  /** Today's commits, each flagged with whether it is new since the review. */
  commits: ReviewCommit[];
  /** Reviewed commits with no counterpart in today's head: dropped or rewritten. */
  removedCommits: ReviewCommit[];
  commitsTruncated: boolean;
  /** Too many commits to match rebased ones to what was reviewed: each rewritten commit reads as new. */
  rebaseMatchSkipped: boolean;
}

/**
 * What changed in the PR's own change since the last review (or since
 * `from`): the files whose change differs, with interdiff line counts, and the
 * commits. Upstream changes brought in by a rebase or merge are left out; see
 * `sinceReview.ts` for how.
 */
export async function reviewSinceReview(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
  from?: string,
): Promise<SinceReview> {
  const ready = await requireReadyPr(db, config, workspaceId, prId, deps);
  const { range, mark } = await resolveRange(db, ready, deps, from);
  const entries = await sinceEntries(ready, range);
  const files: SinceFile[] = [];
  let counted = 0;
  // Serial on purpose, like `reviewPatches`: each view is a few local git calls.
  for (const entry of entries) {
    const skip = unreadable(entry);
    const view = !skip && counted < MAX_COUNTED_FILES ? await sinceView(ready, range, entry) : null;
    if (view) counted++;
    files.push({
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
      additions: view?.additions ?? 0,
      deletions: view?.deletions ?? 0,
      binary: entry.binary,
      tooLarge: !entry.binary && overCap(entry.sizes),
    });
  }
  const commits = await sinceCommits(ready, range);
  return {
    fromHeadSha: range.fromHead,
    toHeadSha: range.toHead,
    fromMergeBase: range.fromMergeBase,
    toMergeBase: range.toMergeBase,
    rebased: !(await fastForward(ready.runners, ready.clonePath, range)),
    baseMoved: range.fromMergeBase !== range.toMergeBase,
    mark: toMarkResponse(mark),
    files,
    filesTruncated: entries.filter((e) => !unreadable(e)).length > counted,
    commits: commits.commits,
    removedCommits: commits.removed,
    commitsTruncated: commits.truncated,
    rebaseMatchSkipped: commits.rebaseMatchSkipped,
  };
}

/** One file's interdiff since the last review (or `from`); 404 unless the file is listed there. */
export async function reviewSinceReviewFile(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  path: string,
  deps: ReviewDeps,
  from?: string,
): Promise<SinceFileView & { fromHeadSha: string; toHeadSha: string; tooLarge: boolean }> {
  const ready = await requireReadyPr(db, config, workspaceId, prId, deps);
  const { range } = await resolveRange(db, ready, deps, from);
  const entry = (await sinceEntries(ready, range)).find((e) => e.path === path);
  if (!entry) {
    throw new ReviewWorkspaceError(`${path} hasn't changed since the review`, 404);
  }
  const shas = { fromHeadSha: range.fromHead, toHeadSha: range.toHead };
  if (unreadable(entry)) {
    return {
      ...shas,
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
      // Nothing is carried for a file that can't be read: past a base move it
      // is the reviewed file as it was, upstream lines and all.
      mode: range.fromMergeBase === range.toMergeBase ? "direct" : "upstream-included",
      original: null,
      modified: null,
      patch: "",
      additions: 0,
      deletions: 0,
      tooLarge: !entry.binary,
    };
  }
  return { ...shas, ...(await sinceView(ready, range, entry)), tooLarge: false };
}

function prCommits(ready: ReadyPr) {
  return cache.get(
    `commits:${ready.clonePath}:${ready.mergeBaseSha}..${ready.headSha}`,
    () => listCommits(ready.runners, ready.clonePath, ready.mergeBaseSha, ready.headSha),
    (c) => c.commits.length * 256,
  );
}

export interface PrCommits {
  headSha: string;
  mergeBaseSha: string;
  /** The reviewed head `isNew` is measured from; null when nothing is recorded. */
  fromHeadSha: string | null;
  commits: ReviewCommit[];
  truncated: boolean;
}

/**
 * The PR's commits, `merge-base..head`, newest first. With a last review (or
 * `from`), each says whether it is new since; without one, none is.
 */
export async function reviewCommits(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
  from?: string,
): Promise<PrCommits> {
  const ready = await requireReadyPr(db, config, workspaceId, prId, deps);
  const base = { headSha: ready.headSha, mergeBaseSha: ready.mergeBaseSha };
  let range: SinceRange | null = null;
  try {
    range = (await resolveRange(db, ready, deps, from)).range;
  } catch (e) {
    // No mark, or a reviewed commit that's gone, still leaves a list worth showing.
    if (!(e instanceof ReviewWorkspaceError) || from) throw e;
  }
  if (!range) {
    const { commits, truncated } = await prCommits(ready);
    return {
      ...base,
      fromHeadSha: null,
      commits: commits.map((c) => ({ ...c, isNew: false })),
      truncated,
    };
  }
  const since = await sinceCommits(ready, range);
  return {
    ...base,
    fromHeadSha: range.fromHead,
    commits: since.commits,
    truncated: since.truncated,
  };
}

export interface CommitFiles {
  sha: string;
  parentSha: string;
  files: ReviewChangedFile[];
}

export interface CommitFileDiff {
  sha: string;
  parentSha: string;
  path: string;
  oldPath?: string;
  status: ReviewChangedFile["status"];
  /** The file at the commit's first parent; null when the commit added it. */
  original: FileAtSide | null;
  /** The file at the commit; null when the commit deleted it. */
  modified: FileAtSide | null;
  patch: string;
  tooLarge: boolean;
}

/**
 * One of the PR's commits, diffed against its first parent: its files, or with
 * `path` that file's two versions and patch. Only a commit in the PR's own
 * `merge-base..head` is read, so a sha from the request can't name anything
 * else in the clone.
 */
export async function reviewCommitDiff(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  sha: string,
  path: string | undefined,
  deps: ReviewDeps,
): Promise<CommitFiles | CommitFileDiff> {
  const ready = await requireReadyPr(db, config, workspaceId, prId, deps);
  const commit = (await prCommits(ready)).commits.find((c) => c.sha === sha);
  if (!commit) throw new ReviewWorkspaceError("that commit isn't part of this pull request", 404);
  const parentSha = parentOf(commit);
  const files = await changedFiles(ready.runners, ready.clonePath, parentSha, sha);
  if (path === undefined) {
    return {
      sha,
      parentSha,
      files: files.map(({ oldSize: _old, newSize: _new, ...file }) => file),
    };
  }
  const file = files.find((f) => f.path === path);
  if (!file) throw new ReviewWorkspaceError(`${path} isn't changed by that commit`, 404);
  const base = {
    sha,
    parentSha,
    path,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    status: file.status,
  };
  if (file.binary || file.oldSize > MAX_FILE_BYTES || file.newSize > MAX_FILE_BYTES) {
    return { ...base, original: null, modified: null, patch: "", tooLarge: !file.binary };
  }
  const [original, modified, patch] = await Promise.all([
    file.status === "added"
      ? Promise.resolve(null)
      : cachedFileAt(ready, parentSha, file.oldPath ?? path),
    file.status === "deleted" ? Promise.resolve(null) : cachedFileAt(ready, sha, path),
    cache.get(
      `diff:${ready.clonePath}:${parentSha}..${sha}:${path}`,
      () =>
        fileDiffBetween(ready.runners.local, ready.clonePath, parentSha, sha, path, file.oldPath),
      (p) => p.length + 64,
    ),
  ]);
  return { ...base, original, modified, patch, tooLarge: false };
}

export interface SincePatch {
  file: SinceFile;
  /** The file's interdiff; null when it is left out, for the reason in `omitted`. */
  patch: string | null;
  omitted: "binary" | "too-large" | "over-budget" | null;
}

/** Commit messages read for an agent; past this, the rest are listed by subject only. */
const MAX_COMMIT_MESSAGES = 50;

/**
 * Each listed file's interdiff, and the full message of each new and removed
 * commit, for an agent reading what changed since a review. Takes the answer
 * {@link reviewSinceReview} gave, so both describe the same four commits; 409
 * when the checkout has moved since. A patch over `maxFileBytes`, or one that
 * would take the total past `maxTotalBytes`, is listed but not included.
 */
export async function reviewSincePatches(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
  since: Pick<
    SinceReview,
    "fromHeadSha" | "fromMergeBase" | "toHeadSha" | "toMergeBase" | "commits" | "removedCommits"
  >,
  limits: { maxFileBytes: number; maxTotalBytes: number },
): Promise<{ patches: SincePatch[]; messages: Map<string, string> }> {
  const ready = await requireReadyPr(db, config, workspaceId, prId, deps);
  if (ready.headSha !== since.toHeadSha) {
    throw new ReviewWorkspaceError("the checkout moved while reading what changed", 409);
  }
  const range: SinceRange = {
    fromHead: since.fromHeadSha,
    fromMergeBase: since.fromMergeBase,
    toHead: since.toHeadSha,
    toMergeBase: since.toMergeBase,
  };
  const patches: SincePatch[] = [];
  let total = 0;
  for (const entry of await sinceEntries(ready, range)) {
    const tooLarge = !entry.binary && overCap(entry.sizes);
    const file: SinceFile = {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
      additions: 0,
      deletions: 0,
      binary: entry.binary,
      tooLarge,
    };
    if (entry.binary || tooLarge) {
      patches.push({ file, patch: null, omitted: entry.binary ? "binary" : "too-large" });
      continue;
    }
    const view = await sinceView(ready, range, entry);
    const sized = { ...file, additions: view.additions, deletions: view.deletions };
    const bytes = view.patch.length;
    if (bytes > limits.maxFileBytes) {
      patches.push({ file: sized, patch: null, omitted: "too-large" });
    } else if (total + bytes > limits.maxTotalBytes) {
      patches.push({ file: sized, patch: null, omitted: "over-budget" });
    } else {
      total += bytes;
      patches.push({ file: sized, patch: view.patch, omitted: null });
    }
  }

  const shas = [...since.commits.filter((c) => c.isNew), ...since.removedCommits]
    .map((c) => c.sha)
    .filter((sha) => COMMIT_SHA_PATTERN.test(sha))
    .slice(0, MAX_COMMIT_MESSAGES);
  const messages = new Map<string, string>();
  if (shas.length > 0) {
    const out = await git(
      ready.runners.local,
      ["log", "--no-walk=unsorted", "--format=%H%x1f%B%x1e", ...shas, "--"],
      ready.clonePath,
    );
    for (const record of out.split("\x1e")) {
      const [sha, body] = record.replace(/^\n/, "").split("\x1f");
      if (sha && body !== undefined) messages.set(sha, body.trim());
    }
  }
  return { patches, messages };
}
