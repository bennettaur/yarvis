import { useEffect, useState } from "react";
import { requestOpenWorkspace } from "../../lib/nav";
import { refKey } from "../../lib/pr/ref";
import type { PrRef } from "../../lib/pr/types";
import { startWorkspaceForPr } from "../../lib/pr/workspace";
import { findWorkspaceForPr, type WorkspaceForPr } from "../../lib/workspaces";

/**
 * The workspace control for a PR under review, in whichever of its two states
 * applies. When the PR was raised from an active workspace, it jumps back to it
 * (via the cross-tab open-workspace request). When it wasn't — someone else's
 * PR, or one raised outside the app — it offers to open one on the PR's branch,
 * so the reviewer can edit the code or ask an agent about it instead of only
 * reading the diff. Works for GitHub and Azure DevOps PRs, both of which the
 * workspace poller tracks.
 *
 * Nothing renders until the lookup answers, so the start button never flashes
 * in front of a PR that turns out to have a workspace already. The one it
 * starts carries no prompt: the session it opens with is a blank agent prompt
 * to drive by hand.
 */
export default function PrWorkspaceAction({ prRef }: { prRef: PrRef }) {
  const [workspace, setWorkspace] = useState<WorkspaceForPr | null>(null);
  const [looked, setLooked] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on ref identity, not the unstable ref object
  useEffect(() => {
    let live = true;
    findWorkspaceForPr(prRef)
      .then((w) => live && setWorkspace(w))
      .catch(() => live && setWorkspace(null))
      .finally(() => live && setLooked(true));
    return () => {
      live = false;
    };
  }, [refKey(prRef)]);

  // The sidecar provisions in the background, so opening the workspace right
  // away is the point: the workspace view joins the run already going and puts
  // its log on screen.
  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const { workspaceId } = await startWorkspaceForPr(prRef);
      requestOpenWorkspace({ id: workspaceId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  if (!looked) return null;

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
      {error && <span className="max-w-[18rem] truncate text-xs text-red-400">{error}</span>}
      <button
        type="button"
        onClick={() => void start()}
        disabled={starting}
        title="Create a workspace on this pull request's branch and open an agent session there"
        className="flex shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
      >
        <span aria-hidden>⎇</span>
        <span>{starting ? "Starting…" : "Start workspace"}</span>
      </button>
    </div>
  );
}
