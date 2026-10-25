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
 * Two runners, because the clone is shared with code the user may have agreed
 * to run (a PR's setup script runs in a worktree whose git dir is this clone's):
 *  - `network` talks to the remote and is the only one that carries the
 *    provider token. It runs clone, fetch, the batched blob downloads, and the
 *    changed-file diff, which is itself a batched download.
 *  - `local` never reaches the network: `GIT_NO_LAZY_FETCH` makes a missing
 *    blob an error instead of a silent fetch, so blobs a read needs are fetched
 *    explicitly, in one narrow call, with `network`.
 * Both carry {@link HARDENING}, which switches off what repo config could use
 * to run code or redirect traffic.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type CappedRunResult,
  type RunBytesResult,
  type RunOptions,
  run,
  runBytes,
  runCapped,
} from "../workspaces/exec.ts";
import { CONTROL_CHARACTERS, isBinary, MAX_FILE_BYTES } from "../workspaces/files.ts";
import {
  existingWorktree,
  GIT_BASE_ENV,
  type GitRunner,
  git,
  NETWORK_TIMEOUT_MS,
  parseRawNumstat,
  splitNulFields,
} from "../workspaces/git.ts";
import type { CappedGitRunner } from "./definitions.ts";

/** Reads stdout as bytes; injectable like {@link GitRunner}. */
export type GitBytesRunner = (
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<RunBytesResult>;

/** The runners for one review clone; see the module comment for which is which. */
export interface ReviewGit {
  network: GitRunner;
  local: GitRunner;
  bytes: GitBytesRunner;
  /** Local, with output cut off at a byte cap or a timeout rather than failing (a search). */
  search: CappedGitRunner;
}

/** How to authenticate to the provider over https. */
export interface GitCredentials {
  host: string;
  username: string;
  token: string;
}

export interface ReviewGitOptions {
  credentials?: GitCredentials;
  /** Lets tests use a `file://` remote; never set outside them. */
  allowFileProtocol?: boolean;
}

/** The process spawners, injectable so tests can see every command and its env. */
export interface Spawners {
  run: (
    args: string[],
    opts: RunOptions,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  runBytes: (args: string[], opts: RunOptions) => Promise<RunBytesResult>;
  runCapped?: (args: string[], opts: RunOptions & { maxBytes: number }) => Promise<CappedRunResult>;
}

/**
 * Configuration applied to every review git command, as command-line config so
 * it outranks anything in the clone's own config. Each line closes a way for
 * config written into the shared clone — by a setup script, say — to act on a
 * later command:
 *  - hooks: `core.hooksPath` points at nothing, so no hook runs;
 *  - `core.fsmonitor` would run its value as a command on every status/checkout;
 *  - `core.askPass` would run a program when credentials are wanted;
 *  - `http.sslVerify` and an empty `http.proxy` keep traffic, and the token in
 *    it, going straight to the real host over verified TLS;
 *  - transports are limited to https and ssh (`ext::` and the like execute
 *    commands); `file` is allowed only for tests;
 *  - the empty `credential.helper` clears every helper configured elsewhere, so
 *    a planted helper can't receive the token and the user's keychain helper
 *    can't store it.
 * What can't be switched off this way — `include.path`, `url.*.insteadOf`,
 * `filter.*` and similar keys with names of their own — is why the clone's
 * config is also snapshotted and restored around a setup run (`setupGuard.ts`).
 * Diffs additionally pass `--no-ext-diff --no-textconv`, since `diff.external`
 * and textconv drivers are commands too.
 */
export function hardeningConfig(allowFileProtocol = false): [string, string][] {
  return [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["core.askPass", ""],
    ["http.sslVerify", "true"],
    ["http.proxy", ""],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["protocol.ssh.allow", "always"],
    ...(allowFileProtocol ? ([["protocol.file.allow", "always"]] as [string, string][]) : []),
    ["credential.helper", ""],
  ];
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

/** `GIT_CONFIG_*` variables for `pairs`, which git reads as command-line config. */
function configEnv(pairs: [string, string][]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/**
 * The environment for one runner. With credentials, the helper above is added
 * after the hardening config cleared every other one, and the token rides in
 * the environment only — never in argv or any config file.
 */
export function reviewGitEnv(
  options: ReviewGitOptions,
  kind: "network" | "local",
): Record<string, string> {
  const pairs = hardeningConfig(options.allowFileProtocol);
  const creds = kind === "network" ? options.credentials : undefined;
  if (creds) pairs.push(["credential.helper", CREDENTIAL_HELPER]);
  return {
    ...GIT_BASE_ENV,
    ...configEnv(pairs),
    ...(kind === "local" ? { GIT_NO_LAZY_FETCH: "1" } : {}),
    ...(creds
      ? {
          YARVIS_GIT_HOST: creds.host,
          YARVIS_GIT_USERNAME: creds.username,
          YARVIS_GIT_TOKEN: creds.token,
        }
      : {}),
  };
}

/** Builds the runners for a review clone. */
export function reviewGit(
  options: ReviewGitOptions = {},
  spawners: Spawners = { run, runBytes },
): ReviewGit {
  const networkEnv = reviewGitEnv(options, "network");
  const localEnv = reviewGitEnv(options, "local");
  return {
    network: (args, opts) => spawners.run(["git", ...args], { ...opts, env: networkEnv }),
    local: (args, opts) => spawners.run(["git", ...args], { ...opts, env: localEnv }),
    bytes: (args, opts) => spawners.runBytes(["git", ...args], { ...opts, env: localEnv }),
    search: (args, opts) =>
      (spawners.runCapped ?? runCapped)(["git", ...args], { ...opts, env: localEnv }),
  };
}

/**
 * Makes sure a blobless clone of `url` exists at `clonePath` with `origin`
 * pointing at `url`. Not shallow: a review diffs against the merge-base, which
 * can be any distance back. Commits and trees come down now; file contents
 * arrive when fetched. The URL is re-pointed when it changed (a repo registered
 * after its first review switches to the registered remote).
 */
export async function ensureReviewClone(
  runners: ReviewGit,
  url: string,
  clonePath: string,
): Promise<void> {
  if (!existsSync(join(clonePath, ".git"))) {
    mkdirSync(dirname(clonePath), { recursive: true });
    await git(
      runners.network,
      ["clone", "--filter=blob:none", "--no-checkout", "--", url, clonePath],
      undefined,
      NETWORK_TIMEOUT_MS,
    );
    return;
  }
  const current = (await git(runners.local, ["remote", "get-url", "origin"], clonePath)).trim();
  if (current !== url) await git(runners.local, ["remote", "set-url", "origin", url], clonePath);
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
  runners: ReviewGit,
  clonePath: string,
  prNumber: number,
  head: HeadSource,
  baseBranch: string,
): Promise<PrShas> {
  await git(
    runners.network,
    ["fetch", "--no-tags", "origin", ...prFetchRefspecs(prNumber, head, baseBranch)],
    clonePath,
    NETWORK_TIMEOUT_MS,
  );
  const headRev =
    head.kind === "ref" ? localPrRef(prNumber, "head") : `${localPrRef(prNumber, "merge")}^2`;
  const headSha = await revParse(runners.local, clonePath, headRev);
  const baseSha = await revParse(runners.local, clonePath, localBaseRef(baseBranch));
  const mergeBase = await runners.local(["merge-base", baseSha, headSha], { cwd: clonePath });
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
 * Downloads blobs by id in one request, the way git's own lazy fetch does, but
 * on purpose and with the credentials only this call carries.
 */
export async function fetchBlobs(
  runners: ReviewGit,
  clonePath: string,
  oids: readonly string[],
): Promise<void> {
  if (oids.length === 0) return;
  await git(
    runners.network,
    [
      "-c",
      "fetch.negotiationAlgorithm=noop",
      "fetch",
      "origin",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      "--filter=blob:none",
      "--stdin",
    ],
    clonePath,
    NETWORK_TIMEOUT_MS,
    `${oids.join("\n")}\n`,
  );
}

/** Downloads every blob in the tree at `sha` that the clone doesn't have yet. */
export async function prefetchTree(
  runners: ReviewGit,
  clonePath: string,
  sha: string,
): Promise<void> {
  // `--missing=print` lists what is absent instead of fetching it; `--no-walk`
  // keeps this to the one commit's tree.
  const out = await git(
    runners.local,
    ["rev-list", "--objects", "--no-walk", "--missing=print", sha],
    clonePath,
  );
  const missing = out
    .split("\n")
    .filter((line) => line.startsWith("?"))
    .map((line) => line.slice(1).trim());
  await fetchBlobs(runners, clonePath, missing);
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
 * setup. Local only: run {@link prefetchTree} first.
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

/** Flags every diff here passes, so no configured program runs on a diff. */
const SAFE_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"];

/**
 * Every file the pull request changes, `from..to` (merge-base to head), with no
 * cap on how many. One `diff --raw --numstat` gives the kind of change, the
 * line counts and both sides' blob ids. On a blobless clone that same diff is
 * what downloads every changed blob, both sides, in a single batched fetch —
 * which is why it runs on the network runner, and why every file and diff the
 * reviewer opens afterwards can be read locally.
 */
export async function changedFilesBetween(
  runners: ReviewGit,
  clonePath: string,
  from: string,
  to: string,
): Promise<ChangedFileWithSizes[]> {
  const records = parseRawNumstat(
    await git(
      runners.network,
      [
        "diff",
        ...SAFE_DIFF_FLAGS,
        "--raw",
        "--numstat",
        "-z",
        "-M",
        "--no-abbrev",
        `${from}..${to}`,
      ],
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
  const sizes = await blobSizes(runners.local, clonePath, oids);
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
    undefined,
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
 * matching anything but a file of that literal name. Trees are always local in
 * a blobless clone, and `-l` reads sizes from the object store's headers —
 * for a missing blob that would mean a fetch, so the size is only read once
 * the blob is known to be present (see {@link readFileAt}).
 */
async function treeEntry(
  runner: GitRunner,
  clonePath: string,
  sha: string,
  path: string,
): Promise<TreeEntry | null> {
  const out = await git(
    runner,
    ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", sha, "--", path],
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
 * file". A blob the clone doesn't have yet — any file the PR didn't change —
 * is fetched by id first, the one network call a read can make. Anything over
 * `maxBytes` comes back `tooLarge` with no content. A file is binary when git
 * would say so (a NUL near the start) or when it isn't valid UTF-8, which the
 * editor couldn't show faithfully anyway.
 */
export async function readFileAt(
  runners: ReviewGit,
  clonePath: string,
  sha: string,
  path: string,
  maxBytes = MAX_FILE_BYTES,
  { fetchMissing = true }: { fetchMissing?: boolean } = {},
): Promise<FileAtSide | null> {
  assertSafeRepoPath(path);
  const entry = await treeEntry(runners.local, clonePath, sha, path);
  if (entry?.type !== "blob") return null;

  const present = await runners.local(["cat-file", "-e", entry.object], { cwd: clonePath });
  if (present.exitCode !== 0) {
    // A caller that promised never to reach the network reads a missing blob as no file.
    if (!fetchMissing) return null;
    await fetchBlobs(runners, clonePath, [entry.object]);
  }
  const size = Number(
    (await git(runners.local, ["cat-file", "-s", entry.object], clonePath)).trim(),
  );
  if (size > maxBytes) return { content: "", binary: false, tooLarge: true, size };

  const result = await runners.bytes(["cat-file", "blob", entry.object], { cwd: clonePath });
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
 * can't see the other half and reports a whole-file addition. Local: the
 * changed-file listing that the caller checks the path against has already
 * downloaded both sides.
 */
export async function fileDiffBetween(
  runner: GitRunner,
  clonePath: string,
  from: string,
  to: string,
  path: string,
  oldPath?: string,
): Promise<string> {
  return git(runner, fileDiffArgs(from, to, path, oldPath), clonePath);
}

function fileDiffArgs(from: string, to: string, path: string, oldPath?: string): string[] {
  assertSafeRepoPath(path);
  if (oldPath) assertSafeRepoPath(oldPath);
  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
  return [
    "--literal-pathspecs",
    "diff",
    ...SAFE_DIFF_FLAGS,
    "-M",
    `${from}..${to}`,
    "--",
    ...paths,
  ];
}

/** How long one capped file diff may take; a multi-megabyte generated file takes a few seconds. */
const CAPPED_DIFF_TIMEOUT_MS = 60_000;

/**
 * {@link fileDiffBetween}, read only up to `maxBytes`: for a reader of every
 * changed file, where one generated file's diff can run to hundreds of
 * megabytes. `complete` is false when the output reached the cap or the time
 * ran out, and the patch is then what had arrived, cut at a line.
 */
export async function fileDiffCapped(
  runner: CappedGitRunner,
  clonePath: string,
  from: string,
  to: string,
  path: string,
  oldPath: string | undefined,
  maxBytes: number,
): Promise<{ patch: string; complete: boolean }> {
  const args = fileDiffArgs(from, to, path, oldPath);
  const result = await runner(args, {
    cwd: clonePath,
    timeoutMs: CAPPED_DIFF_TIMEOUT_MS,
    maxBytes,
  });
  if (result.stopped === null && result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return { patch: result.stdout, complete: result.stopped === null };
}
