import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  assertSafeBranchName,
  createWorkspace,
  findRepoForPr,
  findWorkspaceForPr,
  findWorkspaceOnBranch,
  type PrLocator,
  startKickOff,
} from "../workspaces/service.ts";
import type { PrCodeSource } from "./source.ts";
import type { PrRef } from "./types.ts";

/**
 * Opening a workspace on a pull request someone else raised.
 *
 * The issue "Start work" flow cuts a fresh branch and hands the agent a ticket.
 * This is its counterpart for a PR that already exists: the workspace checks
 * out the PR's own head branch and starts nothing, so the session that comes up
 * when the workspace is opened is a blank prompt to ask questions at or push
 * edits from. Like "Start work", provisioning runs in the sidecar's background
 * — the caller gets the workspace id and opens it.
 */

/**
 * A refusal the reviewer can act on — an unregistered repo, a fork — as opposed
 * to a provider or database failure. The route answers 400 for these and 502
 * for the rest, so a rate-limited GitHub isn't reported as a bad request.
 */
export class PrWorkspaceRefusal extends Error {}

/** The locator shape the workspace lookups use, from a PR ref. */
function locatorForRef(ref: PrRef): PrLocator {
  return ref.provider === "github"
    ? { provider: "github", owner: ref.owner, repo: ref.repo, number: ref.number }
    : {
        provider: "azure",
        org: ref.org,
        project: ref.project,
        repo: ref.repo,
        number: ref.prId,
      };
}

export interface PrWorkspaceResult {
  workspaceId: string;
  /** Name of the workspace, so the caller can label what it opened. */
  name: string;
  /** True when a workspace for this branch already existed and was reused. */
  existing: boolean;
}

export interface PrWorkspaceOptions {
  /** Injectable so tests can assert the kick-off without running git. */
  kickOff?: (db: Db, workspaceId: string) => void;
}

/** Workspace name for a PR, e.g. `PR #42 · Rename the API`. The title is bounded
 *  so the name stays readable in the workspace list; the slug it feeds has its
 *  own, shorter cap. */
function workspaceName(number: number, title: string): string {
  const trimmed = title.trim().slice(0, 120);
  return trimmed ? `PR #${number} · ${trimmed}` : `PR #${number}`;
}

/**
 * Creates (or finds) the workspace for a pull request and starts provisioning
 * it in the background.
 *
 * Two lookups, because neither alone covers the PR view's second click: the
 * cached PR match is free but only exists once the poller has seen a
 * provisioned workspace, and the branch match is the fact the create path
 * writes itself, so it holds from the moment the row exists. Without the
 * second, a click during provisioning cuts a second worktree on a branch git
 * has already checked out, which fails and leaves a stranded workspace behind.
 *
 * Throws a {@link PrWorkspaceRefusal} when the PR's repo isn't registered or
 * its branch isn't in that repo (a fork). Both are conditions no amount of
 * retrying fixes, so failing here beats a workspace that provisions into a git
 * error.
 */
export async function startWorkspaceForPr(
  db: Db,
  config: Config,
  source: PrCodeSource,
  { kickOff = startKickOff }: PrWorkspaceOptions = {},
): Promise<PrWorkspaceResult> {
  const locator = locatorForRef(source.ref);

  const cached = await findWorkspaceForPr(db, locator);
  if (cached) return { workspaceId: cached.id, name: cached.name, existing: true };

  const repo = await findRepoForPr(db, locator);
  if (!repo) {
    throw new PrWorkspaceRefusal(
      "this pull request's repository is not registered — add it under Settings → Repositories first",
    );
  }

  const detail = await source.detail();
  if (detail.fromFork) {
    throw new PrWorkspaceRefusal(
      "this pull request comes from a fork, so its branch is not in the repository",
    );
  }
  if (!detail.headRef) {
    throw new PrWorkspaceRefusal("could not determine the pull request's branch");
  }

  // `createWorkspace` checks this too, but as a plain error — checking here
  // keeps a branch name git would refuse a 400 like the other refusals rather
  // than a 502 blaming the provider that reported it.
  try {
    assertSafeBranchName(detail.headRef);
  } catch (e) {
    throw new PrWorkspaceRefusal(e instanceof Error ? e.message : String(e));
  }

  const onBranch = await findWorkspaceOnBranch(db, repo.id, detail.headRef);
  if (onBranch) return { workspaceId: onBranch.id, name: onBranch.name, existing: true };

  const workspace = await createWorkspace(db, config, {
    name: workspaceName(locator.number, detail.title),
    repoIds: [repo.id],
    existingBranches: { [repo.id]: detail.headRef },
  });

  // No pending prompt: the workspace opens on a session with nothing typed
  // into it. Provisioning is all the kick-off does here, and the frontend
  // starts the agent when it opens a provisioned workspace. That also means
  // `resumeKickOffs` won't re-drive this one after a sidecar restart — it
  // selects on a pending prompt — so an interrupted provision is left to the
  // poller's orphan sweep and the workspace view's retry button.
  kickOff(db, workspace.id);

  return { workspaceId: workspace.id, name: workspace.name, existing: false };
}
