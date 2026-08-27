/**
 * A workspace repo's stacked pull requests.
 *
 * Two sources are combined here. The API-derived stack (`client.prStack`) knows
 * every layer's review state and check rollup but has to infer membership from
 * base/head branch names, because GitHub ships stacks through the `gh stack`
 * CLI and exposes no API for them. The CLI knows the real grouping — GitHub's
 * stack number, which branches belong, and whether each needs a rebase — but
 * only from inside a checkout, which is exactly what a workspace has.
 *
 * So: the CLI decides membership and order when it is available, the API
 * supplies each layer's status, and a repo without `gh stack` still gets the
 * derived stack rather than nothing.
 */

import { eq } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { repos, workspaceRepoPr, workspaceRepos } from "../db/schema.ts";
import { GitHubClient } from "../github/client.ts";
import type { MergeMethod, PrStack, StackEntry } from "../pr/types.ts";
import { type RunResult, run } from "./exec.ts";
import { parseRepoRemote } from "./service.ts";

/** Runs `gh <args>` in a worktree. Injectable so tests never shell out. */
export type GhRunner = (
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<RunResult>;

/** `gh stack view` is a couple of API calls; it should never take this long. */
const VIEW_TIMEOUT_MS = 30_000;

/** Merging a stack walks it PR by PR, and each merge waits on GitHub. */
const MERGE_TIMEOUT_MS = 5 * 60_000;

/**
 * The real runner. `gh` is invoked by us rather than by a user-authored script,
 * and it has to authenticate as the user to read the stack, so the GitHub token
 * is passed in deliberately — `scrubbedEnv` withholds it by default, and this
 * overlays that one secret rather than restoring the inherited environment.
 *
 * `GH_NO_UPDATE_NOTIFIER` keeps a version banner out of stdout, which is parsed
 * as JSON. Prompts need no suppressing: `run` pipes stdout, and `gh` refuses to
 * prompt when it is not attached to a terminal.
 */
export function ghRunner(token: string | undefined): GhRunner {
  return (args, opts) =>
    run(["gh", ...args], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      env: { GH_TOKEN: token, GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    });
}

/** One branch as `gh stack view --json` reports it. */
interface GhStackBranch {
  name?: string;
  isCurrent?: boolean;
  isMerged?: boolean;
  isQueued?: boolean;
  needsRebase?: boolean;
  pr?: { number?: number; url?: string; state?: string };
}

interface GhStackView {
  trunk?: string;
  currentBranch?: string;
  number?: number;
  branches?: GhStackBranch[];
}

/**
 * Reads the stack the worktree is on. A non-zero exit is the ordinary answer
 * here — no stack, no extension, no `gh` at all — so it comes back as a reason
 * rather than an exception: the caller still has an API-derived stack to show,
 * and the reason is what tells the user why the CLI half is missing.
 */
async function readGhStack(
  gh: GhRunner,
  cwd: string,
): Promise<{ view: GhStackView } | { unavailable: string }> {
  let result: RunResult;
  try {
    result = await gh(["stack", "view", "--json"], { cwd, timeoutMs: VIEW_TIMEOUT_MS });
  } catch (e) {
    return { unavailable: e instanceof Error ? e.message : String(e) };
  }
  if (result.exitCode !== 0) {
    return { unavailable: result.stderr.trim() || `gh stack view exited ${result.exitCode}` };
  }
  try {
    const view = JSON.parse(result.stdout) as GhStackView;
    if (!Array.isArray(view.branches)) return { unavailable: "gh stack view returned no branches" };
    return { view };
  } catch {
    return { unavailable: "could not parse gh stack view output" };
  }
}

/**
 * A layer the CLI knows about but the API walk did not reach — a branch pushed
 * with no pull request yet, or one whose PR the derived stack stopped short of.
 * Everything the API would have supplied is left empty rather than guessed, so
 * "no checks reported" and "checks passing" stay distinguishable.
 */
function entryFromBranch(branch: GhStackBranch, owner: string, repo: string): StackEntry {
  const number = branch.pr?.number;
  const state = String(branch.pr?.state ?? "").toLowerCase();
  return {
    ref: { provider: "github", owner, repo, number: number ?? 0 },
    number: number ?? 0,
    title: branch.name ?? "",
    url: branch.pr?.url ?? "",
    baseRef: "",
    headRef: branch.name ?? "",
    state: state || (number ? "open" : "none"),
    merged: Boolean(branch.isMerged) || state === "merged",
    draft: false,
    queued: Boolean(branch.isQueued) || state === "queued",
    checks: { total: 0, success: 0, failure: 0, pending: 0 },
    reviewDecision: null,
    isCurrent: Boolean(branch.isCurrent),
    needsUpdate: Boolean(branch.needsRebase),
  };
}

/**
 * Rebuilds the stack from the CLI's branch list, taking each layer's status
 * from the matching API entry.
 *
 * The CLI is authoritative on membership and order, so a PR the branch walk
 * picked up that `gh stack` does not consider part of the stack is dropped: the
 * walk cannot tell a stack from two unrelated PRs that happen to chain, and the
 * CLI can. `needsUpdate` is the union of both verdicts — the CLI compares real
 * commits, GitHub's `BEHIND` is computed server-side, and either one being sure
 * is enough.
 */
export function applyGhStack(
  derived: PrStack | null,
  view: GhStackView,
  owner: string,
  repo: string,
): PrStack {
  const byNumber = new Map((derived?.entries ?? []).map((e) => [e.number, e]));
  const byBranch = new Map((derived?.entries ?? []).map((e) => [e.headRef, e]));
  const currentNumber = derived?.entries.find((e) => e.isCurrent)?.number;

  const entries: StackEntry[] = [];
  for (const branch of view.branches ?? []) {
    const matched =
      (branch.pr?.number ? byNumber.get(branch.pr.number) : undefined) ??
      (branch.name ? byBranch.get(branch.name) : undefined);
    const base = matched ?? entryFromBranch(branch, owner, repo);
    entries.push({
      ...base,
      isCurrent: matched ? base.number === currentNumber : Boolean(branch.isCurrent),
      merged: base.merged || Boolean(branch.isMerged),
      queued: base.queued || Boolean(branch.isQueued),
      needsUpdate: base.needsUpdate || Boolean(branch.needsRebase),
    });
  }

  return {
    trunk: view.trunk ?? derived?.trunk ?? "",
    entries,
    stackNumber: typeof view.number === "number" ? view.number : null,
    source: "gh-stack",
  };
}

export interface WorkspaceStack {
  stack: PrStack | null;
  /** Why `gh stack` didn't contribute, when it didn't. Null when it did. */
  ghStackError: string | null;
}

/**
 * The stack for one workspace repo: derived from the API, then reconciled
 * against `gh stack` in the worktree.
 *
 * A failure on either half is survivable and reported as such — an unreachable
 * GitHub still leaves the CLI's branch list, and a repo with no `gh stack`
 * still leaves the derived stack.
 */
export async function loadWorkspaceStack(opts: {
  gh: GhRunner;
  client: GitHubClient | null;
  worktreePath: string;
  owner: string;
  repo: string;
  /** The PR on this repo's branch, when the poller has found one. */
  prNumber: number | null;
}): Promise<WorkspaceStack> {
  const { gh, client, worktreePath, owner, repo, prNumber } = opts;

  const [derived, cli] = await Promise.all([
    client && prNumber ? client.prStack(owner, repo, prNumber).catch(() => null) : null,
    readGhStack(gh, worktreePath),
  ]);

  if ("unavailable" in cli) return { stack: derived, ghStackError: cli.unavailable };
  return { stack: applyGhStack(derived, cli.view, owner, repo), ghStackError: null };
}

const MERGE_FLAG: Record<MergeMethod, string> = {
  MERGE: "--merge",
  SQUASH: "--squash",
  REBASE: "--rebase",
};

export interface StackMergeResult {
  merged: boolean;
  /** What `gh` said, so a refusal reaches the user with its reason intact. */
  output: string;
}

/**
 * Merges the stack in a worktree, up to and including `upToPrNumber`.
 *
 * Scoped to a pull request rather than merging the whole stack: the layers
 * above the one being looked at are the ones least likely to be ready, and
 * `gh stack merge <pr>` stops there. The merge is all-or-nothing on GitHub's
 * side — if any pull request in range can't merge, none do — so a failure here
 * leaves the stack as it was.
 *
 * Omitting the method leaves `gh` on the repo's last-used one, which is what
 * the CLI does when a user runs it by hand.
 */
export async function mergeStack(
  gh: GhRunner,
  worktreePath: string,
  upToPrNumber: number,
  method?: MergeMethod,
): Promise<StackMergeResult> {
  const args = ["stack", "merge", String(upToPrNumber), "--yes"];
  if (method) args.push(MERGE_FLAG[method]);
  const result = await gh(args, { cwd: worktreePath, timeoutMs: MERGE_TIMEOUT_MS });
  const output = [result.stdout, result.stderr]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  return { merged: result.exitCode === 0, output };
}

/**
 * Everything reading or merging a workspace repo's stack needs: where the
 * worktree is, which GitHub repo it belongs to, and the pull request the poller
 * last found on its branch.
 *
 * A repo that isn't on GitHub has no stack to read — Azure DevOps has no
 * equivalent — so it resolves to a refusal the routes turn into a 400 rather
 * than an empty stack that reads as "not stacked".
 */
async function stackContext(
  db: Db,
  workspaceRepoId: string,
): Promise<{ worktreePath: string; owner: string; repo: string; prNumber: number | null }> {
  const [row] = await db
    .select({ wr: workspaceRepos, repo: repos, pr: workspaceRepoPr })
    .from(workspaceRepos)
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .leftJoin(workspaceRepoPr, eq(workspaceRepoPr.workspaceRepoId, workspaceRepos.id))
    .where(eq(workspaceRepos.id, workspaceRepoId));
  if (!row) throw new Error("workspace repo not found");

  const remote = parseRepoRemote(row.repo.cloneUrl);
  if (remote && remote.provider !== "github") {
    throw new Error("stacked pull requests are a GitHub feature");
  }
  return {
    worktreePath: row.wr.worktreePath,
    // The clone URL is the source of truth for a repo that has one; the
    // registration columns are the fallback, as in the poller.
    owner: remote?.provider === "github" ? remote.owner : row.repo.owner,
    repo: remote?.provider === "github" ? remote.repo : row.repo.repo,
    prNumber: row.pr?.prNumber ?? null,
  };
}

/** The stack for one workspace repo, as the right-column Stack tab reads it. */
export async function workspaceRepoStack(
  db: Db,
  config: Config,
  workspaceRepoId: string,
  gh: GhRunner = ghRunner(config.secrets.githubToken),
): Promise<WorkspaceStack> {
  const context = await stackContext(db, workspaceRepoId);
  const token = config.secrets.githubToken;
  return loadWorkspaceStack({
    gh,
    client: token ? new GitHubClient(token) : null,
    ...context,
  });
}

/**
 * Merges the stack in a workspace repo's worktree, up to and including one of
 * its pull requests.
 *
 * The pull request has to be a layer of the stack we just read. Without that
 * check the route would merge whatever number it was handed, in a repo the
 * caller only nominally addressed — and `gh stack merge` merges every layer
 * below it too, so the blast radius of a wrong number is the whole stack.
 */
export async function mergeWorkspaceRepoStack(
  db: Db,
  config: Config,
  workspaceRepoId: string,
  upToPrNumber: number,
  method?: MergeMethod,
  gh: GhRunner = ghRunner(config.secrets.githubToken),
): Promise<StackMergeResult> {
  const context = await stackContext(db, workspaceRepoId);
  const { stack, ghStackError } = await loadWorkspaceStack({
    gh,
    client: config.secrets.githubToken ? new GitHubClient(config.secrets.githubToken) : null,
    ...context,
  });
  if (ghStackError) throw new Error(`gh stack is not available here: ${ghStackError}`);
  if (!stack?.entries.some((e) => e.number === upToPrNumber)) {
    throw new Error(`#${upToPrNumber} is not part of this stack`);
  }
  return mergeStack(gh, context.worktreePath, upToPrNumber, method);
}
