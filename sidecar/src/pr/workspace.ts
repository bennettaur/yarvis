import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  createWorkspace,
  findRepoForPr,
  findWorkspaceForPr,
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

/** The locator shape the workspace lookups use, from a PR ref. */
export function locatorForRef(ref: PrRef): PrLocator {
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
  /** Name of the workspace, so a caller can say which one it opened. */
  name: string;
  /** True when a workspace for this PR already existed and was reused. */
  existing: boolean;
}

export interface PrWorkspaceOptions {
  /** Injectable so tests can assert the kick-off without running git. */
  kickOff?: (db: Db, workspaceId: string) => void;
}

/** Workspace name for a PR, e.g. `PR #42 · Rename the API`. Titles can be long
 *  and the slug is derived from this, so the title is bounded here. */
function workspaceName(number: number, title: string): string {
  const trimmed = title.trim().slice(0, 120);
  return trimmed ? `PR #${number} · ${trimmed}` : `PR #${number}`;
}

/**
 * Creates (or finds) the workspace for a pull request and starts provisioning
 * it in the background.
 *
 * Reusing an existing workspace is the point of the lookup: the PR view offers
 * this only when it has no backlink, but the poller's cache is what that
 * backlink reads and it can be a minute behind, so a second click must not cut
 * a second worktree on the same branch.
 *
 * Throws — with a message meant for the user — when the PR's repo isn't
 * registered or its branch isn't in that repo (a fork). Both are conditions no
 * amount of retrying fixes, so failing here beats a workspace that provisions
 * into a git error.
 */
export async function startWorkspaceForPr(
  db: Db,
  config: Config,
  source: PrCodeSource,
  { kickOff = startKickOff }: PrWorkspaceOptions = {},
): Promise<PrWorkspaceResult> {
  const locator = locatorForRef(source.ref);

  const existing = await findWorkspaceForPr(db, locator);
  if (existing) return { workspaceId: existing.id, name: existing.name, existing: true };

  const repo = await findRepoForPr(db, locator);
  if (!repo) {
    throw new Error(
      "this pull request's repository is not registered — add it under Settings → Repositories first",
    );
  }

  const detail = await source.detail();
  if (detail.fromFork) {
    throw new Error("this pull request comes from a fork, so its branch is not in the repository");
  }
  if (!detail.headRef) {
    throw new Error("could not determine the pull request's branch");
  }

  const workspace = await createWorkspace(db, config, {
    name: workspaceName(locator.number, detail.title),
    repoIds: [repo.id],
    existingBranches: { [repo.id]: detail.headRef },
  });

  // No pending prompt: the workspace opens on a session with nothing typed
  // into it. Provisioning is what the kick-off does here, and the frontend
  // starts the agent when it opens a provisioned workspace.
  kickOff(db, workspace.id);

  return { workspaceId: workspace.id, name: workspace.name, existing: false };
}
