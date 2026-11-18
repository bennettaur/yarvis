/**
 * "What changed since I last reviewed": the git side of comparing a pull
 * request as it is now against the commit the reviewer last looked at.
 *
 * The question is about the PR's *own* change. A rebase onto a base that moved,
 * or a merge of the base into the head, changes every file the base touched,
 * and none of that is the author answering review comments. So the comparison
 * is between the two PR-only changes — `fromMergeBase..fromHead` (the change as
 * reviewed) and `toMergeBase..toHead` (the change now) — and never a plain
 * `fromHead..toHead`, which would carry the upstream changes along:
 *
 *  - Which files: a file is listed when the PR's change to it differs. Where
 *    the base side didn't move under the file, that is a blob comparison; where
 *    it did, the two `-U0` patches are compared with their line numbers taken
 *    out, so a hunk that only shifted because upstream lines were added above
 *    it reads as unchanged — the same idea as `git patch-id`.
 *  - What a file shows: the reviewed version of the file *carried onto today's
 *    base* (a three-way merge of the old PR change onto the new merge-base's
 *    file) against the file at today's head. Both sides then hold the same
 *    upstream lines and only the author's edits differ. When that merge
 *    conflicts — upstream rewrote the very lines the PR changed — the reviewed
 *    version is shown as it was and the view says upstream lines are included.
 *  - Which commits are new: commits the reviewed head didn't have, minus those
 *    a rebase merely re-created, matched by `git patch-id` against the old
 *    range's commits.
 *
 * Everything runs on the local runner except blob downloads, which go through
 * the network runner in batches the way the rest of the review clone's reads do.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError } from "../llm/errors.ts";
import { COMMIT_SHA_PATTERN } from "../pr/types.ts";
import { MAX_FILE_BYTES } from "../workspaces/files.ts";
import { git, NETWORK_TIMEOUT_MS } from "../workspaces/git.ts";
import {
  assertSafeRepoPath,
  type ChangedFileWithSizes,
  type FileAtSide,
  fetchBlobs,
  parseTreeEntries,
  type ReviewGit,
} from "./git.ts";

/** Where a reviewed commit is kept alive in the review clone. */
const REVIEWED_REF_PREFIX = "refs/yarvis/reviewed";

/** Commits listed per pull request; a PR with more is cut off and says so. */
export const MAX_COMMITS = 250;

/** Files whose interdiff line counts are computed; past this the list still names them. */
export const MAX_COUNTED_FILES = 300;

/**
 * Blobs a commit-equivalence check may download. Matching rebased commits needs
 * every intermediate version of every file; past this it isn't worth the
 * download and every rewritten commit simply counts as new.
 */
const MAX_PATCH_ID_BLOBS = 5000;

/**
 * Commits either range may have for rebased commits to be matched: the match
 * reads every one's full patch (`git log -p`). Past this, every rewritten
 * commit counts as new and the answer says matching was skipped.
 */
const MAX_PATCH_ID_COMMITS = 500;

/**
 * Commits the "which are new" sets read. Far past {@link MAX_COMMITS}, so it
 * only bounds a pathological range (a head that shares no recent history).
 */
const MAX_REV_LIST = 10_000;

/** The tree of an empty repository, the parent a root commit is diffed against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const SAFE_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color"];

/** The two PR-only changes being compared. */
export interface SinceRange {
  fromHead: string;
  fromMergeBase: string;
  toHead: string;
  toMergeBase: string;
}

export function refForReviewed(prKey: string, sha: string): string {
  return `${REVIEWED_REF_PREFIX}/${prKey}/${sha}`;
}

async function hasCommit(runners: ReviewGit, clonePath: string, sha: string): Promise<boolean> {
  const res = await runners.local(["cat-file", "-e", `${sha}^{commit}`], { cwd: clonePath });
  return res.exitCode === 0;
}

/**
 * Makes sure `sha` is in the review clone, fetching it by id when it isn't (a
 * review made on the provider's site, of a commit a force-push has since
 * dropped). False when the remote doesn't have it either. Writes no ref, so it
 * needs no clone lock: a read can call it without queueing behind a refresh.
 */
export async function ensureCommit(
  runners: ReviewGit,
  clonePath: string,
  sha: string,
): Promise<boolean> {
  if (!COMMIT_SHA_PATTERN.test(sha)) return false;
  if (await hasCommit(runners, clonePath, sha)) return true;
  const fetched = await runners.network(
    ["fetch", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", "origin", sha],
    { cwd: clonePath, timeoutMs: NETWORK_TIMEOUT_MS },
  );
  return fetched.exitCode === 0 && (await hasCommit(runners, clonePath, sha));
}

/**
 * Holds `sha`, already in the clone (see {@link ensureCommit}), with a ref of
 * its own so neither the next refresh nor `git gc` can lose it. False when the
 * clone doesn't have it. The caller holds the clone lock: this writes a ref.
 */
export async function pinReviewedCommit(
  runners: ReviewGit,
  clonePath: string,
  prKey: string,
  sha: string,
): Promise<boolean> {
  if (!COMMIT_SHA_PATTERN.test(sha) || !(await hasCommit(runners, clonePath, sha))) return false;
  await git(runners.local, ["update-ref", refForReviewed(prKey, sha), sha], clonePath);
  return true;
}

/** Drops every reviewed-commit ref one PR holds. The caller holds the clone lock. */
export async function unpinReviewedCommits(
  runners: ReviewGit,
  clonePath: string,
  prKey: string,
): Promise<void> {
  const refs = await git(
    runners.local,
    ["for-each-ref", "--format=%(refname)", `${REVIEWED_REF_PREFIX}/${prKey}/`],
    clonePath,
  );
  const deletes = refs
    .split("\n")
    .filter(Boolean)
    .map((ref) => `delete ${ref}\n`)
    .join("");
  if (deletes) await git(runners.local, ["update-ref", "--stdin"], clonePath, undefined, deletes);
}

export async function mergeBaseOf(
  runners: ReviewGit,
  clonePath: string,
  a: string,
  b: string,
): Promise<string | null> {
  const res = await runners.local(["merge-base", a, b], { cwd: clonePath });
  const sha = res.stdout.trim();
  return res.exitCode === 0 && sha ? sha : null;
}

export async function isAncestor(
  runners: ReviewGit,
  clonePath: string,
  ancestor: string,
  of: string,
): Promise<boolean> {
  const res = await runners.local(["merge-base", "--is-ancestor", ancestor, of], {
    cwd: clonePath,
  });
  return res.exitCode === 0;
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export interface ReviewCommit {
  sha: string;
  subject: string;
  author: string;
  /** Author date, ISO 8601: what a rebase keeps, so the order the author wrote things in. */
  date: string;
  parents: string[];
  /** The reviewed head didn't have this commit, nor one with the same change. */
  isNew: boolean;
  /** The reviewed commit this one re-creates (a rebase), when there is one. */
  rebasedFrom?: string;
}

const FIELD = "\x1f";
const RECORD = "\x1e";

/** `mergeBase..head`, newest first, at most `max` (one more is read to tell whether there were more). */
export async function listCommits(
  runners: ReviewGit,
  clonePath: string,
  mergeBase: string,
  head: string,
  max = MAX_COMMITS,
): Promise<{ commits: Omit<ReviewCommit, "isNew">[]; truncated: boolean }> {
  const out = await git(
    runners.local,
    [
      "log",
      `--max-count=${max + 1}`,
      `--format=%H${FIELD}%P${FIELD}%an${FIELD}%aI${FIELD}%s${RECORD}`,
      `${mergeBase}..${head}`,
      "--",
    ],
    clonePath,
  );
  const commits = out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => {
      const [sha = "", parents = "", author = "", date = "", subject = ""] = record.split(FIELD);
      return { sha, parents: parents.split(" ").filter(Boolean), author, date, subject };
    });
  return { commits: commits.slice(0, max), truncated: commits.length > max };
}

/** The commits in `head` that `exclude` doesn't reach, newest first, at most {@link MAX_REV_LIST}. */
async function revList(
  runners: ReviewGit,
  clonePath: string,
  head: string,
  exclude: string[],
): Promise<Set<string>> {
  const out = await git(
    runners.local,
    ["rev-list", `--max-count=${MAX_REV_LIST}`, head, ...exclude.map((sha) => `^${sha}`), "--"],
    clonePath,
  );
  return new Set(out.split("\n").filter(Boolean));
}

/** How many commits `from..to` has, counting no further than `cap + 1`. */
async function countCommits(
  runners: ReviewGit,
  clonePath: string,
  from: string,
  to: string,
  cap: number,
): Promise<number> {
  const out = await git(
    runners.local,
    ["rev-list", "--count", `--max-count=${cap + 1}`, `${from}..${to}`, "--"],
    clonePath,
  );
  return Number.parseInt(out.trim(), 10) || 0;
}

const NULL_OID = /^0+$/;
const GITLINK_MODE = "160000";

/**
 * Downloads every blob the commits of `ranges` diff — both sides of each of
 * their changes, so the first commit's parent's versions too — in one batch,
 * unless more than `maxBlobs` are missing. `log --raw --no-renames` names
 * them from the trees alone, without reading a blob.
 */
async function prefetchRanges(
  runners: ReviewGit,
  clonePath: string,
  ranges: [string, string][],
  maxBlobs: number,
): Promise<boolean> {
  const wanted = new Set<string>();
  for (const [from, to] of ranges) {
    const out = await git(
      runners.local,
      [
        "log",
        "--raw",
        "--no-abbrev",
        "--no-renames",
        "--no-merges",
        "--format=",
        `--max-count=${MAX_PATCH_ID_COMMITS}`,
        `${from}..${to}`,
        "--",
      ],
      clonePath,
    );
    for (const line of out.split("\n")) {
      // `:<old mode> <new mode> <old oid> <new oid> <status>\t<path>`
      if (!line.startsWith(":")) continue;
      const [oldMode, newMode, oldOid, newOid] = line.slice(1).split(" ");
      if (oldOid && oldMode !== GITLINK_MODE && !NULL_OID.test(oldOid)) wanted.add(oldOid);
      if (newOid && newMode !== GITLINK_MODE && !NULL_OID.test(newOid)) wanted.add(newOid);
    }
  }
  if (wanted.size === 0) return true;
  const checked = await git(
    runners.local,
    ["cat-file", "--batch-check=%(objectname)"],
    clonePath,
    undefined,
    `${[...wanted].join("\n")}\n`,
  );
  const missing = checked
    .split("\n")
    .filter((line) => line.endsWith(" missing"))
    .map((line) => line.slice(0, -" missing".length));
  if (missing.length > maxBlobs) return false;
  await fetchBlobs(runners, clonePath, missing);
  return true;
}

/** `git patch-id --stable` of each non-merge commit in `from..to`: commit sha → patch id. */
async function patchIds(
  runners: ReviewGit,
  clonePath: string,
  from: string,
  to: string,
): Promise<Map<string, string>> {
  const log = await git(
    runners.local,
    ["log", "-p", "--no-merges", ...SAFE_DIFF_FLAGS, "--format=commit %H", `${from}..${to}`, "--"],
    clonePath,
  );
  const ids = new Map<string, string>();
  if (!log.trim()) return ids;
  const out = await git(runners.local, ["patch-id", "--stable"], clonePath, undefined, log);
  for (const line of out.split("\n")) {
    const [patchId, commit] = line.split(" ");
    if (patchId && commit) ids.set(commit, patchId);
  }
  return ids;
}

export interface SinceCommits {
  commits: ReviewCommit[];
  removed: ReviewCommit[];
  truncated: boolean;
  /** Rebased commits weren't matched to the reviewed ones (too many to compare), so each reads as new. */
  rebaseMatchSkipped: boolean;
}

/**
 * The PR's commits now, each flagged with whether it is new since `from` —
 * plus the reviewed commits that no longer have a counterpart (dropped or
 * rewritten by a force-push). A commit re-created by a rebase is matched to
 * the reviewed one with the same patch id and isn't new — unless either range
 * is too big to match (`rebaseMatchSkipped`), when it reads as new. `limits`
 * replaces the caps, for tests.
 */
export async function commitsSince(
  runners: ReviewGit,
  clonePath: string,
  range: SinceRange,
  limits: { maxCommits?: number; maxBlobs?: number } = {},
): Promise<SinceCommits> {
  const maxCommits = limits.maxCommits ?? MAX_PATCH_ID_COMMITS;
  const maxBlobs = limits.maxBlobs ?? MAX_PATCH_ID_BLOBS;
  const { commits, truncated } = await listCommits(
    runners,
    clonePath,
    range.toMergeBase,
    range.toHead,
  );
  const unseen = await revList(runners, clonePath, range.toHead, [
    range.fromHead,
    range.toMergeBase,
  ]);
  const gone = await revList(runners, clonePath, range.fromHead, [
    range.toHead,
    range.fromMergeBase,
  ]);

  // Only a rewrite can re-create a commit, so the patch ids are only worth
  // computing when reviewed commits have gone missing from the head.
  let oldByPatchId = new Map<string, string>();
  let newPatchIds = new Map<string, string>();
  let rebaseMatchSkipped = false;
  if (gone.size > 0 && unseen.size > 0) {
    try {
      const ranges: [string, string][] = [
        [range.fromMergeBase, range.fromHead],
        [range.toMergeBase, range.toHead],
      ];
      const sizes = await Promise.all(
        ranges.map(([from, to]) => countCommits(runners, clonePath, from, to, maxCommits)),
      );
      const fetched =
        sizes.every((n) => n <= maxCommits) &&
        (await prefetchRanges(runners, clonePath, ranges, maxBlobs));
      if (fetched) {
        const old = await patchIds(runners, clonePath, range.fromMergeBase, range.fromHead);
        oldByPatchId = new Map(
          [...old].filter(([sha]) => gone.has(sha)).map(([sha, id]) => [id, sha]),
        );
        newPatchIds = await patchIds(runners, clonePath, range.toMergeBase, range.toHead);
      } else {
        rebaseMatchSkipped = true;
      }
    } catch (e) {
      // Equivalence is a refinement: without it a rebased commit just reads as new.
      console.warn("[review-workspaces] could not match rebased commits:", describeError(e));
      rebaseMatchSkipped = true;
    }
  }

  const matched = new Set<string>();
  const flagged = commits.map((commit): ReviewCommit => {
    if (!unseen.has(commit.sha)) return { ...commit, isNew: false };
    const patchId = newPatchIds.get(commit.sha);
    const rebasedFrom = patchId ? oldByPatchId.get(patchId) : undefined;
    if (!rebasedFrom) return { ...commit, isNew: true };
    matched.add(rebasedFrom);
    return { ...commit, isNew: false, rebasedFrom };
  });

  const removed =
    gone.size === 0
      ? []
      : (
          await listCommits(runners, clonePath, range.fromMergeBase, range.fromHead)
        ).commits.flatMap((c) =>
          gone.has(c.sha) && !matched.has(c.sha) ? [{ ...c, isNew: false }] : [],
        );
  return { commits: flagged, removed, truncated, rebaseMatchSkipped };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * How a file's part in the PR changed since the review:
 *  - `added`: the PR changes a file now that it didn't touch then;
 *  - `modified`: the PR changed it then and changes it differently now;
 *  - `reverted`: the PR changed it then and leaves it alone now.
 */
export type SinceStatus = "added" | "modified" | "reverted";

export interface SinceFile {
  path: string;
  oldPath?: string;
  status: SinceStatus;
  /** Lines the author added and removed since the review, PR-only. */
  additions: number;
  deletions: number;
  /** Either version is binary or over the size cap, so no counts or content. */
  binary: boolean;
  tooLarge: boolean;
}

type TreeOids = Map<string, string>;

/** Blob ids at `sha` for `paths`, from the tree alone: no blob is needed. */
async function oidsAt(
  runners: ReviewGit,
  clonePath: string,
  sha: string,
  paths: string[],
): Promise<TreeOids> {
  if (paths.length === 0) return new Map();
  const out = await git(
    runners.local,
    ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", sha, "--", ...paths],
    clonePath,
  );
  return new Map(parseTreeEntries(out).map((e) => [e.path, e.object]));
}

/**
 * A unified diff's lines, each saying whether it is inside a hunk: from an
 * `@@` line until the next file's `diff --git`. Only outside one are `---` and
 * `+++` file headers; inside, they are a removed `-- comment` or an added `++i`.
 */
function* diffLines(patch: string): Generator<{ line: string; inHunk: boolean }> {
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    else if (line.startsWith("@@")) inHunk = true;
    yield { line, inHunk };
  }
}

/**
 * A patch's change with its positions taken out: the removed and added lines
 * of each hunk, in order, and the lines that say a file is binary or changed
 * mode. Two of these are equal when the same edit was made, wherever it landed.
 */
export function changeSignature(patch: string): string {
  const kept: string[] = [];
  for (const { line, inHunk } of diffLines(patch)) {
    if (line.startsWith("@@")) kept.push("@@");
    else if (inHunk) {
      if (line.startsWith("+") || line.startsWith("-")) kept.push(line);
    } else if (
      line.startsWith("Binary files") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode")
    ) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

async function zeroContextPatch(
  runners: ReviewGit,
  clonePath: string,
  from: string,
  to: string,
  path: string,
  oldPath?: string,
): Promise<string> {
  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
  return git(
    runners.local,
    [
      "--literal-pathspecs",
      "diff",
      ...SAFE_DIFF_FLAGS,
      "-U0",
      "-M",
      `${from}..${to}`,
      "--",
      ...paths,
    ],
    clonePath,
  );
}

/**
 * Where a listed file is read from at each of the four commits. They differ
 * only around renames: a file the PR renamed sits under its old name at the
 * merge-bases, and a rename the PR has since dropped leaves today's head with
 * the old name too.
 */
export interface SincePaths {
  reviewedBase: string;
  reviewedHead: string;
  currentBase: string;
  currentHead: string;
}

/** A file {@link filesSince} lists, before its line counts are known. */
export interface SinceEntry {
  path: string;
  oldPath?: string;
  status: SinceStatus;
  paths: SincePaths;
  /** Blob sizes on every side, for the size cap. */
  sizes: number[];
  binary: boolean;
}

/**
 * The files whose PR-only change differs between the two ranges, with no line
 * counts yet. `changed` lists a range's changed files (cached by the caller),
 * and listing the reviewed range is also what downloads its blobs.
 */
export async function filesSince(
  runners: ReviewGit,
  clonePath: string,
  range: SinceRange,
  changed: (from: string, to: string) => Promise<ChangedFileWithSizes[]>,
): Promise<SinceEntry[]> {
  const [before, now] = await Promise.all([
    changed(range.fromMergeBase, range.fromHead),
    changed(range.toMergeBase, range.toHead),
  ]);
  const beforeByPath = new Map(before.map((file) => [file.path, file]));
  const nowByPath = new Map(now.map((file) => [file.path, file]));

  // The same file then and now: by path, or across a rename one side has and
  // the other doesn't (the PR renamed it since, or dropped its rename), so the
  // move doesn't read as one file reverted and another newly changed.
  const pairs: [was: ChangedFileWithSizes, is: ChangedFileWithSizes][] = [];
  const pairedBefore = new Set<string>();
  const pairedNow = new Set<string>();
  const pair = (was: ChangedFileWithSizes | undefined, is: ChangedFileWithSizes) => {
    if (!was || pairedBefore.has(was.path) || pairedNow.has(is.path)) return;
    pairs.push([was, is]);
    pairedBefore.add(was.path);
    pairedNow.add(is.path);
  };
  for (const is of now) pair(beforeByPath.get(is.path), is);
  const unpairedBefore = before.filter((was) => !pairedBefore.has(was.path));
  for (const is of now) {
    if (pairedNow.has(is.path)) continue;
    pair(
      unpairedBefore.find(
        (was) =>
          (is.oldPath && was.path === is.oldPath) || (was.oldPath && was.oldPath === is.path),
      ),
      is,
    );
  }

  const sameBase = range.fromMergeBase === range.toMergeBase;
  const baseOf = (file: ChangedFileWithSizes) => file.oldPath ?? file.path;
  const [fromHeadOids, toHeadOids, fromBaseOids, toBaseOids] = await Promise.all([
    oidsAt(
      runners,
      clonePath,
      range.fromHead,
      pairs.map(([was]) => was.path),
    ),
    oidsAt(
      runners,
      clonePath,
      range.toHead,
      pairs.map(([, is]) => is.path),
    ),
    sameBase
      ? Promise.resolve(new Map())
      : oidsAt(runners, clonePath, range.fromMergeBase, [
          ...new Set(pairs.map(([was]) => baseOf(was))),
        ]),
    sameBase
      ? Promise.resolve(new Map())
      : oidsAt(runners, clonePath, range.toMergeBase, [
          ...new Set(pairs.map(([, is]) => baseOf(is))),
        ]),
  ]);

  const out: Awaited<ReturnType<typeof filesSince>> = [];
  const sizesOf = (...files: (ChangedFileWithSizes | undefined)[]) =>
    files.flatMap((f) => (f ? [f.oldSize, f.newSize] : []));

  for (const [was, is] of pairs) {
    const moved = was.path !== is.path || was.oldPath !== is.oldPath;
    const headSame = fromHeadOids.get(was.path) === toHeadOids.get(is.path);
    const baseSame = sameBase || fromBaseOids.get(baseOf(was)) === toBaseOids.get(baseOf(is));
    let differs: boolean;
    if (moved) differs = true;
    else if (baseSame) differs = !headSame;
    else {
      const [a, b] = await Promise.all([
        zeroContextPatch(
          runners,
          clonePath,
          range.fromMergeBase,
          range.fromHead,
          was.path,
          was.oldPath,
        ),
        zeroContextPatch(runners, clonePath, range.toMergeBase, range.toHead, is.path, is.oldPath),
      ]);
      differs = changeSignature(a) !== changeSignature(b);
    }
    if (!differs) continue;
    out.push({
      path: is.path,
      ...(is.oldPath ? { oldPath: is.oldPath } : {}),
      status: "modified",
      paths: {
        reviewedBase: baseOf(was),
        reviewedHead: was.path,
        currentBase: baseOf(is),
        currentHead: is.path,
      },
      sizes: sizesOf(was, is),
      binary: was.binary || is.binary,
    });
  }
  for (const [path, file] of nowByPath) {
    if (pairedNow.has(path)) continue;
    // Untouched by the PR when reviewed: under whatever name the base had for it.
    const before = file.oldPath ?? path;
    out.push({
      path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: "added",
      paths: { reviewedBase: before, reviewedHead: before, currentBase: before, currentHead: path },
      sizes: sizesOf(file),
      binary: file.binary,
    });
  }
  for (const [path, file] of beforeByPath) {
    if (pairedBefore.has(path)) continue;
    // Left alone now: today's head has it under the base's name.
    const base = file.oldPath ?? path;
    out.push({
      path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: "reverted",
      paths: { reviewedBase: base, reviewedHead: path, currentBase: base, currentHead: base },
      sizes: sizesOf(file),
      binary: file.binary,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** How the reviewed version on the left of a since-review view was arrived at. */
export type CarriedMode =
  /** The base didn't move: the reviewed file exactly as it was. */
  | "direct"
  /** The reviewed change, three-way merged onto today's merge-base. */
  | "carried"
  /** Upstream rewrote what the PR changed, so the reviewed file is shown as it was, upstream lines and all. */
  | "upstream-included";

export interface SinceFileView {
  path: string;
  oldPath?: string;
  status: SinceStatus;
  mode: CarriedMode;
  /** The reviewed version, carried onto today's base; null when there was no file. */
  original: FileAtSide | null;
  /** The file at today's head; null when the PR deletes it. */
  modified: FileAtSide | null;
  /** Unified diff of `original` → `modified`; empty when they match or can't be diffed. */
  patch: string;
  additions: number;
  deletions: number;
}

type Read = (sha: string, path: string) => Promise<FileAtSide | null>;

const sameText = (a: FileAtSide | null, b: FileAtSide | null) =>
  a === null || b === null ? a === b : a.content === b.content && !a.binary && !b.binary;

const unreadable = (f: FileAtSide | null) => !!f && (f.binary || f.tooLarge);

/** Runs `fn` with a private scratch folder that is removed afterwards. */
async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "yarvis-since-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The reviewed file moved onto today's merge-base: the old PR change applied
 * to the new base's version with `git merge-file`, so upstream edits elsewhere
 * in the file show up on both sides and cancel out.
 */
async function carryOnto(
  runners: ReviewGit,
  base: FileAtSide | null,
  reviewed: FileAtSide | null,
  current: FileAtSide | null,
): Promise<{ file: FileAtSide | null; mode: CarriedMode }> {
  // The old change didn't touch the file: it reads as today's base does.
  if (sameText(base, reviewed)) return { file: current, mode: "carried" };
  // Upstream didn't touch it, or made the same edit: the reviewed file stands.
  if (sameText(base, current) || sameText(reviewed, current)) {
    return { file: reviewed, mode: "carried" };
  }
  if (
    !base ||
    !reviewed ||
    !current ||
    unreadable(base) ||
    unreadable(reviewed) ||
    unreadable(current)
  ) {
    return { file: reviewed, mode: "upstream-included" };
  }
  return withScratch(async (dir) => {
    const files = {
      current: join(dir, "current"),
      base: join(dir, "base"),
      other: join(dir, "other"),
    };
    writeFileSync(files.current, current.content);
    writeFileSync(files.base, base.content);
    writeFileSync(files.other, reviewed.content);
    const res = await runners.local(
      ["merge-file", "-p", "--", files.current, files.base, files.other],
      { cwd: dir },
    );
    // Exit 0 is a clean merge; a positive code counts conflicts.
    if (res.exitCode !== 0) return { file: reviewed, mode: "upstream-included" };
    const content = res.stdout;
    const size = new TextEncoder().encode(content).length;
    return { file: { content, binary: false, tooLarge: false, size }, mode: "carried" };
  });
}

/** Counts the `+` and `-` lines of a unified diff, leaving out its headers. */
export function countChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const { line, inHunk } of diffLines(patch)) {
    if (!inHunk) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/**
 * A unified diff of two texts, labelled with `path`. `git diff --no-index`
 * on scratch files, with its own headers swapped for ones naming the file.
 */
export async function diffTexts(
  runners: ReviewGit,
  path: string,
  before: string | null,
  after: string | null,
): Promise<string> {
  if (before === after) return "";
  return withScratch(async (dir) => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    if (before !== null) writeFileSync(a, before);
    if (after !== null) writeFileSync(b, after);
    const res = await runners.local(
      [
        "diff",
        "--no-index",
        ...SAFE_DIFF_FLAGS,
        "--",
        before === null ? "/dev/null" : a,
        after === null ? "/dev/null" : b,
      ],
      { cwd: dir },
    );
    // `--no-index` exits 1 when the files differ.
    if (res.exitCode !== 0 && res.exitCode !== 1) {
      throw new Error(`git diff --no-index failed (${res.exitCode}): ${res.stderr.trim()}`);
    }
    const hunks = res.stdout.indexOf("\n@@");
    if (hunks < 0) return "";
    const header = `--- ${before === null ? "/dev/null" : `a/${path}`}\n+++ ${after === null ? "/dev/null" : `b/${path}`}`;
    return `${header}${res.stdout.slice(hunks)}`;
  });
}

/**
 * One file's since-review view: the reviewed version, carried onto today's
 * base, against today's head. `read` reads a file at a commit (fetching a
 * missing blob); `entry` is the file's row from {@link filesSince}.
 */
export async function fileSince(
  runners: ReviewGit,
  range: SinceRange,
  entry: Pick<SinceEntry, "path" | "oldPath" | "status" | "paths">,
  read: Read,
): Promise<SinceFileView> {
  assertSafeRepoPath(entry.path);
  const [base, reviewed, current, modified] = await Promise.all([
    read(range.fromMergeBase, entry.paths.reviewedBase),
    read(range.fromHead, entry.paths.reviewedHead),
    read(range.toMergeBase, entry.paths.currentBase),
    read(range.toHead, entry.paths.currentHead),
  ]);
  const carried =
    range.fromMergeBase === range.toMergeBase
      ? { file: reviewed, mode: "direct" as const }
      : await carryOnto(runners, base, reviewed, current);
  const original = carried.file;
  const diffable = !unreadable(original) && !unreadable(modified);
  const patch = diffable
    ? await diffTexts(runners, entry.path, original?.content ?? null, modified?.content ?? null)
    : "";
  return {
    path: entry.path,
    ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
    status: entry.status,
    mode: carried.mode,
    original,
    modified,
    patch,
    ...countChanges(patch),
  };
}

/** Whether a file's sizes on any side rule out reading it whole. */
export const overCap = (sizes: number[]) => sizes.some((s) => s > MAX_FILE_BYTES);

/** Whether `fromHead..toHead` is a plain fast-forward (no history rewritten). */
export async function fastForward(
  runners: ReviewGit,
  clonePath: string,
  range: SinceRange,
): Promise<boolean> {
  return isAncestor(runners, clonePath, range.fromHead, range.toHead);
}

// ---------------------------------------------------------------------------
// One commit's own diff
// ---------------------------------------------------------------------------

/** The commit a commit is diffed against: its first parent, or the empty tree for a root. */
export function parentOf(commit: Pick<ReviewCommit, "parents">): string {
  return commit.parents[0] ?? EMPTY_TREE;
}
