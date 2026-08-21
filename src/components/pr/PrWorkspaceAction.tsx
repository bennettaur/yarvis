import { useEffect, useState } from "react";
import { requestOpenWorkspace } from "../../lib/nav";
import { refKey } from "../../lib/pr/ref";
import type { PrRef } from "../../lib/pr/types";
import { startWorkspaceForPr } from "../../lib/pr/workspace";
import { findWorkspaceForPr, type WorkspaceForPr } from "../../lib/workspaces";

/** All this control needs of a workspace, so one just started — which has no
 *  cached row yet — can be adopted the same way as one that was looked up. */
type LinkedWorkspace = Pick<WorkspaceForPr, "id" | "name">;

/**
 * The workspace control for a PR under review, in whichever of its two states
 * applies. When the PR already has a workspace, it jumps back to it (via the
 * cross-tab open-workspace request). When it doesn't — someone else's PR, one
 * raised outside the app, one whose workspace was archived — it offers to open
 * one on the PR's branch, so the reviewer can edit the code or ask an agent
 * about it instead of only reading the diff. Works for GitHub and Azure DevOps
 * PRs, both of which the workspace poller tracks.
 *
 * Nothing renders until the lookup answers, so the start button never flashes
 * in front of a PR that turns out to have a workspace already. The one it
 * starts carries no prompt: the session it opens with is a blank agent prompt
 * to drive by hand.
 */
export default function PrWorkspaceAction({
  prRef,
  fromFork = false,
}: {
  prRef: PrRef;
  /**
   * Whether the PR's branch lives in a fork, from the loaded detail. A fork's
   * branch isn't on the registered repo's remote, so the sidecar refuses it —
   * knowing here turns that into a disabled button rather than a round trip.
   * False while the detail is still loading, which only costs that round trip.
   */
  fromFork?: boolean;
}) {
  const [workspace, setWorkspace] = useState<LinkedWorkspace | null>(null);
  const [lookedUp, setLookedUp] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clearing the state up front matters because this component outlives a
  // change of PR: the parent isn't keyed on the ref, so without it the previous
  // PR's backlink stays on screen until the new lookup answers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on ref identity, not the unstable ref object
  useEffect(() => {
    let live = true;
    setWorkspace(null);
    setLookedUp(false);
    setError(null);
    findWorkspaceForPr(prRef)
      .then((w) => live && setWorkspace(w))
      .catch(() => live && setWorkspace(null))
      .finally(() => live && setLookedUp(true));
    return () => {
      live = false;
    };
  }, [refKey(prRef)]);

  // The sidecar provisions in the background, so opening the workspace right
  // away is the point: the workspace view joins the run already going and puts
  // its log on screen. Adopting what came back also flips this control to the
  // backlink now rather than when the poller next runs, so coming back to the
  // PR doesn't offer to start a second one.
  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const { workspaceId, name } = await startWorkspaceForPr(prRef);
      setWorkspace({ id: workspaceId, name });
      requestOpenWorkspace({ id: workspaceId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  if (!lookedUp) return null;

  if (workspace) {
    return (
      <button
        type="button"
        onClick={() => requestOpenWorkspace({ id: workspace.id })}
        title={`Jump to the “${workspace.name}” workspace`}
        className="flex shrink-0 items-center gap-1 rounded-md border border-indigo-700/60 bg-indigo-900/30 px-2 py-1.5 text-xs text-indigo-200 hover:bg-indigo-900/60"
      >
        <span aria-hidden>⤴</span>
        <span className="max-w-[10rem] truncate">Workspace: {workspace.name}</span>
      </button>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {error && (
        <span role="alert" title={error} className="max-w-[18rem] truncate text-xs text-red-400">
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={() => void start()}
        disabled={starting || fromFork}
        title={
          fromFork
            ? "This pull request comes from a fork, so its branch is not in the repository"
            : "Create a workspace on this pull request's branch and open an agent session there"
        }
        className="flex shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
      >
        <span aria-hidden>⎇</span>
        <span>{starting ? "Starting…" : "Start workspace"}</span>
      </button>
    </div>
  );
}
