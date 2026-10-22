/**
 * Git operations for review workspaces: one blobless clone per repo, a detached
 * worktree per pull request, and the read-only queries the review UI runs
 * against them (changed files, the tree, file contents by side, per-file diffs).
 *
 * Everything reads commits, never the working tree. The worktree is there for
 * tools that need files on disk (a setup script, code navigation), but what the
 * reviewer is shown comes from the objects at the recorded shas, so nothing a
 * setup script writes can change what a diff says.
 *
 * A blobless clone fetches file contents lazily from `origin` the first time a
 * command needs them — a checkout, a diff, a `cat-file` — so every command here,
 * not only clone and fetch, runs with the remote's credentials available.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type RunBytesResult, run, runBytes } from "../workspaces/exec.ts";
import { existingWorktree, type GitRunner } from "../workspaces/git.ts";

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

/** Network operations — and a first checkout, which downloads blobs — can be slow. */
const NETWORK_TIMEOUT_MS = 10 * 60 * 1000;

/** Largest file `readFileAtSide` returns; anything bigger is reported `tooLarge`. */
export const MAX_REVIEW_FILE_BYTES = 2_000_000;

/** How far into a file to look for a NUL byte, matching git's own heuristic. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Base environment for every review git command. `GIT_TERMINAL_PROMPT=0` makes
 * a missing credential fail instead of hanging on a prompt nobody can answer;
 * `LC_ALL=C` keeps git's messages in English for the logs.
 */
const BASE_ENV = { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

/** Builds the runners for a remote, with `env` (see {@link credentialEnv}) on every call. */
export function reviewGit(env: Record<string, string> = {}): ReviewGit {
  const merged = { ...BASE_ENV, ...env };
  return {
    run: (args, opts) => run(["git", ...args], { ...opts, env: merged }),
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

async function git(
  runner: GitRunner,
  args: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<string> {
  const result = await runner(args, { cwd, timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout;
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
  if (current !== url) await git(runner, ["remote", "set-url", "origin", "--", url], clonePath);
}

/** Where a pull request's head comes from, which differs by provider and by fork. */
export type HeadSource =
  /** A ref whose tip *is* the head: GitHub's `refs/pull/<n>/head`, or a branch. */
  | { kind: "ref"; ref: string }
  /** Azure's `refs/pull/<id>/merge`, whose second parent is the source commit. */
  | { kind: "merge-parent"; ref: string };

/** The local ref a pull request's fetched head (or merge commit) is kept under. */
export function localPrRef(prNumber: number, kind: "head" | "merge"): string {
  return `refs/yarvis-review/pr-${prNumber}/${kind}`;
}

/** The remote-tracking ref for a base branch. */
export function localBaseRef(baseBranch: string): string {
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
  const mergeBaseSha = (await git(runner, ["merge-base", baseSha, headSha], clonePath)).trim();
  if (!mergeBaseSha) throw new Error("the pull request shares no history with its base branch");
  return { headSha, baseSha, mergeBaseSha };
}

async function revParse(runner: GitRunner, cwd: string, rev: string): Promise<string> {
  return (await git(runner, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], cwd)).trim();
}

/**
 * Puts a detached worktree at `worktreePath` checked out at `sha`, or moves the
 * one already there. The move is forced: this checkout is for reading, and a
 * setup script that rewrote a lockfile must not stop a refresh. Untracked files
 * (installed dependencies) are left alone so a refresh doesn't undo the setup.
 */
export async function ensureDetachedWorktree(
  runner: GitRunner,
  clonePath: string,
  worktreePath: string,
  sha: string,
): Promise<void> {
  const existing = await existingWorktree(runner, clonePath, worktreePath);
  if (existing) {
    await git(runner, ["checkout", "--force", "--detach", sha], worktreePath, NETWORK_TIMEOUT_MS);
    return;
  }
  mkdirSync(dirname(worktreePath), { recursive: true });
  await git(
    runner,
    ["worktree", "add", "--detach", "--", worktreePath, sha],
    clonePath,
    NETWORK_TIMEOUT_MS,
  );
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

/** Splits NUL-terminated output, dropping the empty field the final NUL leaves. */
function splitNul(out: string): string[] {
  const fields = out.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  return fields;
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

/**
 * Joins `git diff --name-status -z -M` and `git diff --numstat -z -M` output
 * into one entry per file, keyed by where the file ended up.
 *
 * In `-z` form a rename is a status field followed by two path fields in
 * name-status, and an empty path column followed by two path fields in
 * numstat. Only numstat's first two tabs are delimiters: a tab is legal in a
 * filename and `-z` leaves it raw.
 */
export function parseChangedFiles(nameStatus: string, numstat: string): ReviewChangedFile[] {
  const byPath = new Map<string, ReviewChangedFile>();

  const statusFields = splitNul(nameStatus);
  for (let i = 0; i < statusFields.length; ) {
    const code = statusFields[i] ?? "";
    const twoPaths = code.startsWith("R") || code.startsWith("C");
    const oldPath = twoPaths ? statusFields[i + 1] : undefined;
    const path = statusFields[i + (twoPaths ? 2 : 1)] ?? "";
    i += twoPaths ? 3 : 2;
    if (!path) continue;
    byPath.set(path, {
      path,
      ...(oldPath ? { oldPath } : {}),
      status: STATUS_LETTERS[code[0] ?? ""] ?? "modified",
      additions: 0,
      deletions: 0,
      binary: false,
    });
  }

  const countFields = splitNul(numstat);
  for (let i = 0; i < countFields.length; ) {
    const [add, del, ...rest] = (countFields[i] ?? "").split("\t");
    const inline = rest.join("\t");
    const path = (inline ? inline : countFields[i + 2]) ?? "";
    i += inline ? 1 : 3;
    if (!path) continue;
    const entry = byPath.get(path) ?? {
      path,
      status: "modified" as const,
      additions: 0,
      deletions: 0,
      binary: false,
    };
    entry.binary = add === "-" && del === "-";
    entry.additions = entry.binary ? 0 : Number(add) || 0;
    entry.deletions = entry.binary ? 0 : Number(del) || 0;
    byPath.set(path, entry);
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Every file the pull request changes, `from..to` (merge-base to head). No cap. */
export async function changedFilesBetween(
  runner: GitRunner,
  clonePath: string,
  from: string,
  to: string,
): Promise<ReviewChangedFile[]> {
  const range = `${from}..${to}`;
  const [nameStatus, numstat] = await Promise.all([
    git(runner, ["diff", "--name-status", "-z", "-M", range], clonePath, NETWORK_TIMEOUT_MS),
    git(runner, ["diff", "--numstat", "-z", "-M", range], clonePath, NETWORK_TIMEOUT_MS),
  ]);
  return parseChangedFiles(nameStatus, numstat);
}

/** Every file path in the tree at `sha`. */
export async function treePaths(
  runner: GitRunner,
  clonePath: string,
  sha: string,
): Promise<string[]> {
  return splitNul(await git(runner, ["ls-tree", "-r", "-z", "--name-only", sha], clonePath));
}

/**
 * Throws unless `path` is a plain repo-relative path: no absolute paths, no
 * empty, `.` or `..` segments, no control characters. Reads go through git's
 * object database rather than the filesystem, so this is about refusing a
 * request that can't name a real tree entry, not containment on disk — but a
 * path that passes here is also one that can never climb out of a worktree.
 */
export function assertSafeRepoPath(path: string): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters never name a file we show.
  if (!path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) {
    throw new UnsafePathError(path);
  }
  if (path.startsWith("/")) throw new UnsafePathError(path);
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") throw new UnsafePathError(path);
  }
}

export class UnsafePathError extends Error {
  constructor(path: string) {
    super(`invalid path: ${JSON.stringify(path.slice(0, 200))}`);
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
  return splitNul(out).flatMap((record) => {
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
export async function treeEntry(
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
 * Whether bytes look binary: a NUL in the first {@link BINARY_SNIFF_BYTES}, as
 * git decides, or anything that isn't valid UTF-8, which the editor couldn't
 * show faithfully anyway.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/**
 * The contents of `path` at commit `sha`, or null when the tree has no file
 * there. Only blobs are read: a directory or submodule at that path is "not a
 * file". Anything over `maxBytes` comes back `tooLarge` with no content, and is
 * never downloaded — the size comes from the tree, which a blobless clone has.
 */
export async function readFileAt(
  git: ReviewGit,
  clonePath: string,
  sha: string,
  path: string,
  maxBytes = MAX_REVIEW_FILE_BYTES,
): Promise<FileAtSide | null> {
  assertSafeRepoPath(path);
  const entry = await treeEntry(git.run, clonePath, sha, path);
  if (entry?.type !== "blob") return null;
  const size = entry.size ?? 0;
  if (size > maxBytes) return { content: "", binary: false, tooLarge: true, size };

  const result = await git.bytes(["cat-file", "blob", entry.object], {
    cwd: clonePath,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git cat-file failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  if (looksBinary(result.stdout)) return { content: "", binary: true, tooLarge: false, size };
  return {
    content: new TextDecoder().decode(result.stdout),
    binary: false,
    tooLarge: false,
    size,
  };
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
