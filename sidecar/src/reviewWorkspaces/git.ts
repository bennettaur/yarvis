/**
 * Git operations for review workspaces: one blobless clone per repo, a detached
 * worktree per pull request, and the read-only queries the review UI runs
 * against them (changed files, the tree, file contents by side, per-file diffs).
 *
 * Everything reads commits, never the working tree. The worktree is there for
 * tools that need files on disk (a setup script, code navigation), but what the
 * reviewer is shown comes from the objects at the recorded shas, so nothing a
 * setup script writes can change what a diff says — and a review can start
 * before the checkout has finished.
 *
 * A blobless clone fetches file contents lazily from `origin` the first time a
 * command needs them, so every command here, not only clone and fetch, runs with
 * the remote's credentials available.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type RunBytesResult, runBytes } from "../workspaces/exec.ts";
import { CONTROL_CHARACTERS, isBinary, MAX_FILE_BYTES } from "../workspaces/files.ts";
import {
  existingWorktree,
  GIT_BASE_ENV,
  type GitRunner,
  git,
  gitRunnerWithEnv,
  NETWORK_TIMEOUT_MS,
  parseRawNumstat,
  splitNulFields,
} from "../workspaces/git.ts";

/** Reads stdout as bytes; injectable like {@link GitRunner}. */
export type GitBytesRunner = (
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<RunBytesResult>;

/** The two runners a review clone needs, sharing one environment. */
export interface ReviewGit {
  run: GitRunner;
  bytes: GitBytesRunner;
}

/** Builds the runners for a remote, with `env` (see {@link credentialEnv}) on every call. */
export function reviewGit(env: Record<string, string> = {}): ReviewGit {
  const merged = { ...GIT_BASE_ENV, ...env };
  return {
    run: gitRunnerWithEnv(env),
    bytes: (args, opts) => runBytes(["git", ...args], { ...opts, env: merged }),
  };
}

/**
 * A credential helper that answers only for `https://<host>`, reading the
 * secret from the environment. git runs a `!`-prefixed helper through the
 * shell with the operation (`get`, `store`, `erase`) as its argument and the
 * request on stdin; everything but a matching `get` is ignored, so the token is
 * never handed to another host and never stored anywhere.
 */
const CREDENTIAL_HELPER = [
  "!f() {",
  'test "$1" = get || exit 0;',
  "proto=; host=;",
  "while IFS= read -r line; do",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template.
  'case "$line" in protocol=*) proto="${line#protocol=}";; host=*) host="${line#host=}";; esac;',
  "done;",
  'test "$proto" = https && test "$host" = "$YARVIS_GIT_HOST" || exit 0;',
  'printf \'username=%s\\npassword=%s\\n\' "$YARVIS_GIT_USERNAME" "$YARVIS_GIT_TOKEN";',
  "}; f",
].join(" ");

/**
 * The environment that lets git authenticate to `host` over https with
 * `token`, without the token appearing in argv or being written to any config
 * file. The helper list is set through `GIT_CONFIG_*`, which git reads as
 * command-line configuration: the empty first entry clears any helper the user
 * configured (osxkeychain would otherwise *store* the token on success), and
 * the second is {@link CREDENTIAL_HELPER}, which reads the token back out of
 * this same environment.
 */
export function credentialEnv(
  host: string,
  username: string,
  token: string,
): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: CREDENTIAL_HELPER,
    YARVIS_GIT_HOST: host,
    YARVIS_GIT_USERNAME: username,
    YARVIS_GIT_TOKEN: token,
  };
}

/**
 * Makes sure a blobless clone of `url` exists at `clonePath` with `origin`
 * pointing at `url`. Not shallow: a review diffs against the merge-base, which
 * can be any distance back. Commits and trees come down now; file contents
 * arrive on demand. The URL is re-pointed when it changed (a repo registered
 * after its first review switches to the registered remote), since a blobless
 * clone fetches every missing blob from `origin`.
 */
export async function ensureReviewClone(
  runner: GitRunner,
  url: string,
  clonePath: string,
): Promise<void> {
  if (!existsSync(join(clonePath, ".git"))) {
    mkdirSync(dirname(clonePath), { recursive: true });
    await git(
      runner,
      ["clone", "--filter=blob:none", "--no-checkout", "--", url, clonePath],
      undefined,
      NETWORK_TIMEOUT_MS,
    );
    return;
  }
  const current = (await git(runner, ["remote", "get-url", "origin"], clonePath)).trim();
  if (current !== url) await git(runner, ["remote", "set-url", "origin", url], clonePath);
}

/** Where a pull request's head comes from, which differs by provider and by fork. */
export type HeadSource =
  /** A ref whose tip *is* the head: GitHub's `refs/pull/<n>/head`, or a branch. */
  | { kind: "ref"; ref: string }
  /** Azure's `refs/pull/<id>/merge`, whose second parent is the source commit. */
  | { kind: "merge-parent"; ref: string };

/** The local ref a pull request's fetched head (or merge commit) is kept under. */
function localPrRef(prNumber: number, kind: "head" | "merge"): string {
  return `refs/yarvis-review/pr-${prNumber}/${kind}`;
}

function localBaseRef(baseBranch: string): string {
  return `refs/remotes/origin/${baseBranch}`;
}

/** The refspecs that bring down a pull request's head and its base branch. */
export function prFetchRefspecs(prNumber: number, head: HeadSource, baseBranch: string): string[] {
  const headTarget = localPrRef(prNumber, head.kind === "ref" ? "head" : "merge");
  return [`+${head.ref}:${headTarget}`, `+refs/heads/${baseBranch}:${localBaseRef(baseBranch)}`];
}

/** The commits a review diffs: the PR's head, the base tip, and their merge-base. */
export interface PrShas {
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
}

/**
 * Fetches a pull request's head and base into the review clone and resolves
 * the three commits a review reads. Fetching the head by its pull ref rather
 * than by branch is what makes a fork's PR reviewable: the ref lives in the
 * target repo even though the branch doesn't.
 */
export async function fetchPr(
  runner: GitRunner,
  clonePath: string,
  prNumber: number,
  head: HeadSource,
  baseBranch: string,
): Promise<PrShas> {
  await git(
    runner,
    ["fetch", "--no-tags", "origin", ...prFetchRefspecs(prNumber, head, baseBranch)],
    clonePath,
    NETWORK_TIMEOUT_MS,
  );
  const headRev =
    head.kind === "ref" ? localPrRef(prNumber, "head") : `${localPrRef(prNumber, "merge")}^2`;
  const headSha = await revParse(runner, clonePath, headRev);
  const baseSha = await revParse(runner, clonePath, localBaseRef(baseBranch));
  const mergeBase = await runner(["merge-base", baseSha, headSha], { cwd: clonePath });
  const mergeBaseSha = mergeBase.stdout.trim();
  if (mergeBase.exitCode !== 0 || !mergeBaseSha) {
    throw new Error("the pull request shares no history with its base branch");
  }
  return { headSha, baseSha, mergeBaseSha };
}

async function revParse(runner: GitRunner, cwd: string, rev: string): Promise<string> {
  return (await git(runner, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], cwd)).trim();
}

/**
 * Registers a detached worktree at `worktreePath` without checking anything
 * out, unless one is already there. Only this touches the clone's worktree
 * list; the slow part, the checkout, is {@link checkoutWorktree}, which the
 * caller runs without holding the clone.
 */
export async function registerWorktree(
  runner: GitRunner,
  clonePath: string,
  worktreePath: string,
  sha: string,
): Promise<void> {
  if (await existingWorktree(runner, clonePath, worktreePath)) return;
  mkdirSync(dirname(worktreePath), { recursive: true });
  await git(
    runner,
    ["worktree", "add", "--no-checkout", "--detach", "--", worktreePath, sha],
    clonePath,
  );
}

/**
 * Checks the worktree out at `sha`. Forced: this checkout is for reading, and
 * a setup script that rewrote a lockfile must not stop a refresh. Untracked
 * files (installed dependencies) are left alone so a refresh doesn't undo the
 * setup.
 */
export async function checkoutWorktree(
  runner: GitRunner,
  worktreePath: string,
  sha: string,
): Promise<void> {
  await git(runner, ["checkout", "--force", "--detach", sha], worktreePath, NETWORK_TIMEOUT_MS);
}

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ReviewChangedFile {
  path: string;
  /** Where a renamed file came from. */
  oldPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  /** git reported no line counts, i.e. it treats the file as binary. */
  binary: boolean;
}

/** A changed file plus the blob sizes a diff request is checked against. */
export interface ChangedFileWithSizes extends ReviewChangedFile {
  /** Bytes on the base side; 0 for an added file. */
  oldSize: number;
  /** Bytes on the head side; 0 for a deleted file. */
  newSize: number;
}

const STATUS_LETTERS: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  T: "modified",
  D: "deleted",
  R: "renamed",
  // Copies aren't detected (`-M` only), but a new file that came from another
  // is still an addition as far as a reviewer is concerned.
  C: "added",
};

const NULL_OID = /^0+$/;

/**
 * Every file the pull request changes, `from..to` (merge-base to head), with no
 * cap on how many. One `diff --raw --numstat` gives the kind of change, the
 * line counts and both sides' blob ids. On a blobless clone that same diff is
 * what downloads every changed blob, both sides, in a single batched fetch —
 * so running it once at sync time means every file and diff the reviewer opens
 * afterwards is already local.
 */
export async function changedFilesBetween(
  runner: GitRunner,
  clonePath: string,
  from: string,
  to: string,
): Promise<ChangedFileWithSizes[]> {
  const records = parseRawNumstat(
    await git(
      runner,
      ["diff", "--raw", "--numstat", "-z", "-M", "--no-abbrev", `${from}..${to}`],
      clonePath,
      NETWORK_TIMEOUT_MS,
    ),
  );
  const oids = [
    ...new Set(
      records
        .flatMap((r) => [r.oldOid, r.newOid])
        .filter((o): o is string => !!o && !NULL_OID.test(o)),
    ),
  ];
  const sizes = await blobSizes(runner, clonePath, oids);
  const sizeOf = (oid: string | undefined) => (oid ? (sizes.get(oid) ?? 0) : 0);
  return records
    .map((r) => ({
      path: r.path,
      ...(r.oldPath && r.code.startsWith("R") ? { oldPath: r.oldPath } : {}),
      status: STATUS_LETTERS[r.code[0] ?? ""] ?? "modified",
      additions: r.additions,
      deletions: r.deletions,
      binary: r.binary,
      oldSize: sizeOf(r.oldOid),
      newSize: sizeOf(r.newOid),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Sizes of blobs, in one `cat-file --batch-check` (they are local by now). */
async function blobSizes(
  runner: GitRunner,
  clonePath: string,
  oids: string[],
): Promise<Map<string, number>> {
  if (oids.length === 0) return new Map();
  const out = await git(
    runner,
    ["cat-file", "--batch-check=%(objectname) %(objectsize)"],
    clonePath,
    NETWORK_TIMEOUT_MS,
    `${oids.join("\n")}\n`,
  );
  const sizes = new Map<string, number>();
  for (const line of out.split("\n")) {
    const [oid, size] = line.split(" ");
    if (oid && size && /^\d+$/.test(size)) sizes.set(oid, Number(size));
  }
  return sizes;
}

/** Every file path in the tree at `sha`. */
export async function treePaths(
  runner: GitRunner,
  clonePath: string,
  sha: string,
): Promise<string[]> {
  return splitNulFields(await git(runner, ["ls-tree", "-r", "-z", "--name-only", sha], clonePath));
}

export class UnsafePathError extends Error {
  constructor(path: string) {
    super(`invalid path: ${JSON.stringify(path.slice(0, 200))}`);
    this.name = "UnsafePathError";
  }
}

/**
 * Throws unless `path` is a plain repo-relative path: no absolute paths, no
 * empty, `.` or `..` segments, no control characters. Reads go through git's
 * object database rather than the filesystem, so this is about refusing a
 * request that can't name a real tree entry, not containment on disk — but a
 * path that passes here is also one that can never climb out of a worktree.
 */
export function assertSafeRepoPath(path: string): void {
  if (!path || path.length > 4096 || CONTROL_CHARACTERS.test(path) || path.startsWith("/")) {
    throw new UnsafePathError(path);
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") throw new UnsafePathError(path);
  }
}

/** One entry of `git ls-tree -l`. */
export interface TreeEntry {
  mode: string;
  type: string;
  object: string;
  /** Null for entries git reports no size for (trees, submodules). */
  size: number | null;
  path: string;
}

/** Parses `git ls-tree -z -l` output. */
export function parseTreeEntries(out: string): TreeEntry[] {
  return splitNulFields(out).flatMap((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) return [];
    const [mode, type, object, size] = record.slice(0, tab).split(/\s+/);
    if (!mode || !type || !object) return [];
    return [
      {
        mode,
        type,
        object,
        size: size && size !== "-" ? Number(size) : null,
        path: record.slice(tab + 1),
      },
    ];
  });
}

/**
 * The tree entry at exactly `path` in `sha`, or null when there is none.
 * `--literal-pathspecs` keeps a `*` or `:(glob)` in a requested path from
 * matching anything but a file of that literal name.
 */
async function treeEntry(
  runner: GitRunner,
  clonePath: string,
  sha: string,
  path: string,
): Promise<TreeEntry | null> {
  const out = await git(
    runner,
    ["--literal-pathspecs", "ls-tree", "-z", "-l", "--full-tree", sha, "--", path],
    clonePath,
  );
  return parseTreeEntries(out).find((entry) => entry.path === path) ?? null;
}

export interface FileAtSide {
  content: string;
  binary: boolean;
  tooLarge: boolean;
  /** Bytes in the file, whether or not its content was returned. */
  size: number;
}

/**
 * The contents of `path` at commit `sha`, or null when the tree has no file
 * there. Only blobs are read: a directory or submodule at that path is "not a
 * file". Anything over `maxBytes` comes back `tooLarge` with no content, and is
 * never downloaded — the size comes from the tree, which a blobless clone has.
 * A file is binary when git would say so (a NUL near the start) or when it
 * isn't valid UTF-8, which the editor couldn't show faithfully anyway.
 */
export async function readFileAt(
  runners: ReviewGit,
  clonePath: string,
  sha: string,
  path: string,
  maxBytes = MAX_FILE_BYTES,
): Promise<FileAtSide | null> {
  assertSafeRepoPath(path);
  const entry = await treeEntry(runners.run, clonePath, sha, path);
  if (entry?.type !== "blob") return null;
  const size = entry.size ?? 0;
  if (size > maxBytes) return { content: "", binary: false, tooLarge: true, size };

  const result = await runners.bytes(["cat-file", "blob", entry.object], {
    cwd: clonePath,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git cat-file failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  const binary = { content: "", binary: true, tooLarge: false, size };
  if (isBinary(result.stdout)) return binary;
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    return { content, binary: false, tooLarge: false, size };
  } catch {
    return binary;
  }
}

/**
 * The unified patch for one file between two commits. Passing the old path
 * too keeps a rename a rename: with only the new path as the pathspec, git
 * can't see the other half and reports a whole-file addition.
 */
export async function fileDiffBetween(
  runner: GitRunner,
  clonePath: string,
  from: string,
  to: string,
  path: string,
  oldPath?: string,
): Promise<string> {
  assertSafeRepoPath(path);
  if (oldPath) assertSafeRepoPath(oldPath);
  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
  return git(
    runner,
    ["--literal-pathspecs", "diff", "-M", `${from}..${to}`, "--", ...paths],
    clonePath,
    NETWORK_TIMEOUT_MS,
  );
}
