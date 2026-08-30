import type { WorkspaceDetail } from "../../lib/workspaces";

/**
 * Whether opening a workspace should put a failed repo's setup log on screen,
 * and which repo's. Keyed on the *workspace* status rather than on any repo
 * being in `error`: accepting the failure flips the workspace back to `active`,
 * and that is what stops it leading with the error page on every visit.
 *
 * A teardown that failed leaves repos in `error` too, and parks the workspace in
 * `archiving` — the setup log has nothing to say about that, and the archive
 * raises its own attention item, so it is deliberately not surfaced there.
 *
 * Extracted from the effect in `WorkspacesPanel` so it is testable without
 * mounting a workspace full of live shells (see `shouldAutoStartAgent`).
 */
export function setupLogToAutoOpen(
  detail: WorkspaceDetail | null,
  alreadyOpened: boolean,
): { workspaceRepoId: string; title: string } | null {
  if (alreadyOpened || detail?.status !== "error") return null;
  const failed = detail.repos.find((wr) => wr.status === "error");
  return failed ? { workspaceRepoId: failed.id, title: failed.repo.name } : null;
}

/** What the bar above a workspace's terminal offers, given where it stands. */
export interface ProvisionActions {
  /** Whether the bar shows at all. */
  show: boolean;
  label: string;
  /** Whether to offer taking the failure as read and using the space anyway. */
  showIgnore: boolean;
}

/**
 * The provisioning actions a workspace should offer. The retry outlives the
 * error being ignored — the workspace reads `active` again, but a repo that
 * failed still has no worktree to work in — while the ignore is offered only
 * while the workspace itself is the thing parked on a failure.
 *
 * A workspace being archived is left out of both: its repos land in `error` when
 * a teardown fails, and that failure is the archive's to retry.
 */
export function provisionActions(detail: WorkspaceDetail): ProvisionActions {
  const inArchiveFlow = detail.status === "archiving" || detail.status === "archived";
  const failed =
    !inArchiveFlow &&
    (detail.status === "error" || detail.repos.some((wr) => wr.status === "error"));

  return {
    show: failed || detail.status !== "active",
    label: failed
      ? "Retry provisioning"
      : detail.repos.length === 0
        ? "Create folder"
        : "Provision worktrees",
    showIgnore: detail.status === "error",
  };
}
