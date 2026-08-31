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

import { and, eq } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { repos, workspaceRepoPr, workspaceRepos } from "../db/schema.ts";
import { GitHubClient } from "../github/client.ts";
import { redactSecrets } from "../llm/errors.ts";
import { type MergeMethod, NO_PULL_REQUEST, type PrStack, type StackEntry } from "../pr/types.ts";
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
 * The real runner.
 *
 * `gh` has to authenticate as the user to reach the stack, so the GitHub token
 * is overlaid onto the env `scrubbedEnv` withholds it from. Be clear about what
 * that hands it to: `gh stack` is a third-party extension binary under the
 * user's home directory, and `gh stack merge` drives `git` inside a worktree an
 * agent session can write to — so both see the token. That is inherent to
 * shelling out, since GitHub offers no other way to read or merge a stack, but
 * it is a wider reach than `scrubbedEnv`'s usual contract and any new `gh` call
 * inherits it. With no configured token this passes none and `gh` falls back to
 * the user's own `gh auth login`.
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
 * Everything `gh` writes reaches the user's screen, and it is the combined
 * output of a third-party extension and the `git` subprocesses it drives.
 * Redacting is cheaper than reasoning about what all of that might print.
 */
const ghOutput = (result: RunResult): string =>
  redactSecrets(
    [result.stdout, result.stderr]
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n"),
  );

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
    // A missing `gh` binary throws out of the spawn rather than exiting
    // non-zero, and "the CLI isn't installed" is the most ordinary reason here.
    result = await gh(["stack", "view", "--json"], { cwd, timeoutMs: VIEW_TIMEOUT_MS });
  } catch (e) {
    return { unavailable: redactSecrets(e instanceof Error ? e.message : String(e)) };
  }
  if (result.exitCode !== 0) {
    return { unavailable: ghOutput(result) || `gh stack view exited ${result.exitCode}` };
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
 * Everything the API would have supplied is left empty rather than guessed, and
 * `statusKnown` says so, because empty checks are otherwise indistinguishable
 * from passing ones.
 */
function entryFromBranch(branch: GhStackBranch, owner: string, repo: string): StackEntry {
  const number = branch.pr?.number ?? NO_PULL_REQUEST;
  const state = String(branch.pr?.state ?? "").toLowerCase();
  return {
    ref: { provider: "github", owner, repo, number },
    number,
    title: "",
    url: branch.pr?.url ?? "",
    baseRef: "",
    headRef: branch.name ?? "",
    state: state || (number === NO_PULL_REQUEST ? "none" : "open"),
    merged: Boolean(branch.isMerged) || state === "merged",
    draft: false,
    queued: Boolean(branch.isQueued) || state === "queued",
    checks: { total: 0, success: 0, failure: 0, pending: 0 },
    reviewDecision: null,
    isCurrent: Boolean(branch.isCurrent),
    needsUpdate: Boolean(branch.needsRebase),
    statusKnown: false,
  };
}

/**
 * Rebuilds the stack from the CLI's branch list, taking each layer's status
 * from the matching API entry.
 *
 * The CLI is authoritative on membership and order, so a PR the branch walk
 * picked up that `gh stack` does not consider part of the stack is dropped: the
 * walk cannot tell a stack from two unrelated PRs that happen to chain, and the
 * CLI can. It settles `isCurrent` for the same reason — it reads the branch the
 * worktree is actually on, where the walk only knows which pull request it was
 * seeded from, and honouring both would let two layers claim the spot.
 *
 * `needsUpdate` is the one field taken as the union of the two verdicts: both
 * sides compare real commits, and either being sure is enough.
 */
export function applyGhStack(
  derived: PrStack | null,
  view: GhStackView,
  owner: string,
  repo: string,
): PrStack {
  const byNumber = new Map((derived?.entries ?? []).map((entry) => [entry.number, entry]));
  const byBranch = new Map((derived?.entries ?? []).map((entry) => [entry.headRef, entry]));

  const entries: StackEntry[] = [];
  for (const branch of view.branches ?? []) {
    const matched =
      (branch.pr?.number ? byNumber.get(branch.pr.number) : undefined) ??
      (branch.name ? byBranch.get(branch.name) : undefined);
    const base = matched ?? entryFromBranch(branch, owner, repo);
    entries.push({
      ...base,
      isCurrent: Boolean(branch.isCurrent),
      merged: base.merged || Boolean(branch.isMerged),
      queued: base.queued || Boolean(branch.isQueued),
      needsUpdate: base.needsUpdate || Boolean(branch.needsRebase),
    });
  }

  return {
    trunk: view.trunk ?? derived?.trunk ?? "",
    entries,
    stackNumber: typeof view.number === "number" ? view.number : null,
    // The CLI lists the stack in full, so nothing is cut off once it has spoken.
    truncated: false,
  };
}

/**
 * The layers `gh stack merge <upToPrNumber>` would actually land: that pull
 * request and everything below it not already merged, bottom-first — the order
 * the merge happens in.
 *
 * Mirrored by `mergePlan` in `src/lib/pr/stack.ts`, which is what the confirm
 * button counts. Keeping the two in step is the point; see
 * {@link mergeWorkspaceRepoStack}.
 */
export function mergePlan(stack: PrStack, upToPrNumber: number): number[] {
  if (upToPrNumber === NO_PULL_REQUEST) return [];
  const top = stack.entries.findIndex((entry) => entry.number === upToPrNumber);
  if (top === -1) return [];
  return stack.entries
    .slice(0, top + 1)
    .filter((entry) => entry.number !== NO_PULL_REQUEST && !entry.merged)
    .map((entry) => entry.number);
}

export interface WorkspaceStack {
  stack: PrStack | null;
  /** Why `gh stack` didn't contribute, when it didn't. Null when it did. */
  ghStackError: string | null;
  /**
   * Why GitHub didn't contribute, when it didn't. A stack still renders without
   * it, but every layer comes back with `statusKnown` false, and the reason is
   * what explains the blanks.
   */
  prStackError: string | null;
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
    client && prNumber
      ? client
          .prStack(owner, repo, prNumber)
          .then((stack) => ({ stack }))
          .catch((e: unknown) => ({
            error: redactSecrets(e instanceof Error ? e.message : String(e)),
          }))
      : { stack: null },
    readGhStack(gh, worktreePath),
  ]);

  const stack = "stack" in derived ? derived.stack : null;
  const prStackError = "error" in derived ? derived.error : null;
  if ("unavailable" in cli) return { stack, ghStackError: cli.unavailable, prStackError };
  return { stack: applyGhStack(stack, cli.view, owner, repo), ghStackError: null, prStackError };
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
  return { merged: result.exitCode === 0, output: ghOutput(result) };
}

/**
 * Everything reading or merging a workspace repo's stack needs: where the
 * worktree is, which GitHub repo it belongs to, and the pull request the poller
 * last found on its branch.
 *
 * The repo is matched on its workspace as well as its own id. The sibling
 * read-only routes here trust the repo id alone, but this one leads to an
 * irreversible merge, and that should be reachable only through the workspace
 * that actually holds the worktree it runs in.
 *
 * A repo that isn't on GitHub has no stack to read — Azure DevOps has no
 * equivalent — so it refuses rather than answering with an empty stack, which
 * would read as "not stacked".
 */
async function stackContext(
  db: Db,
  workspaceId: string,
  workspaceRepoId: string,
): Promise<{ worktreePath: string; owner: string; repo: string; prNumber: number | null }> {
  const [row] = await db
    .select({ wr: workspaceRepos, repo: repos, pr: workspaceRepoPr })
    .from(workspaceRepos)
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .leftJoin(workspaceRepoPr, eq(workspaceRepoPr.workspaceRepoId, workspaceRepos.id))
    .where(
      and(eq(workspaceRepos.id, workspaceRepoId), eq(workspaceRepos.workspaceId, workspaceId)),
    );
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

/** Resolves the repo and reads its stack, for the two entry points below. */
async function readStack(
  db: Db,
  config: Config,
  workspaceId: string,
  workspaceRepoId: string,
  gh: GhRunner,
): Promise<WorkspaceStack & { worktreePath: string }> {
  const context = await stackContext(db, workspaceId, workspaceRepoId);
  const token = config.secrets.githubToken;
  const loaded = await loadWorkspaceStack({
    gh,
    client: token ? new GitHubClient(token) : null,
    ...context,
  });
  return { ...loaded, worktreePath: context.worktreePath };
}

/** The stack for one workspace repo, as the right-column Stack tab reads it. */
export async function workspaceRepoStack(
  db: Db,
  config: Config,
  workspaceId: string,
  workspaceRepoId: string,
  gh: GhRunner = ghRunner(config.secrets.githubToken),
): Promise<WorkspaceStack> {
  const { stack, ghStackError, prStackError } = await readStack(
    db,
    config,
    workspaceId,
    workspaceRepoId,
    gh,
  );
  return { stack, ghStackError, prStackError };
}

/**
 * Merges the stack in a workspace repo's worktree, up to and including one of
 * its pull requests.
 *
 * `expected` is the merge plan the user was shown — the layers the confirm
 * button counted. The stack is re-read here and the plan recomputed, and a
 * mismatch refuses the merge. Membership alone would not be enough:
 * `gh stack merge` takes every layer below the number it is handed too, so an
 * agent restacking in this same worktree between the click and the call could
 * turn a confirmed "merge 2" into five, irreversibly, without anyone being
 * asked again. Restacking mid-review is how the feature is meant to be used,
 * not an exotic race.
 */
export async function mergeWorkspaceRepoStack(
  db: Db,
  config: Config,
  workspaceId: string,
  workspaceRepoId: string,
  upToPrNumber: number,
  expected: number[],
  method?: MergeMethod,
  gh: GhRunner = ghRunner(config.secrets.githubToken),
): Promise<StackMergeResult> {
  const { stack, ghStackError, worktreePath } = await readStack(
    db,
    config,
    workspaceId,
    workspaceRepoId,
    gh,
  );
  if (ghStackError) throw new Error(`gh stack is not available here: ${ghStackError}`);
  if (!stack?.entries.some((entry) => entry.number === upToPrNumber)) {
    throw new Error(`#${upToPrNumber} is not part of this stack`);
  }
  const plan = mergePlan(stack, upToPrNumber);
  if (plan.join(",") !== expected.join(",")) {
    const would = plan.map((n) => `#${n}`).join(", ") || "nothing";
    throw new Error(`the stack changed since you looked — it would now merge ${would}`);
  }
  return mergeStack(gh, worktreePath, upToPrNumber, method);
}
