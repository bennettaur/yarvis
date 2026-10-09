import { useEffect, useRef } from "react";
import { agentSessionId } from "../components/workspaces/agentTab";
import { useViewedScope, type ViewedScope } from "./attentionScope";
import { recordEvent } from "./events";

/**
 * Records `workspace.viewed` events so the assistant can tell which workspaces
 * the user has been in lately. Reads the same viewed scope the attention stream
 * uses, so "viewed" means on screen with the window focused.
 */

/** What the workspace was showing: its agent session, one of its shells, or anything else (a diff, a file, a setup log). */
export type ViewedTab = "agent" | "terminal" | "other";

/** How long a workspace has to stay on screen to count, so clicking past one doesn't. */
export const VIEW_DWELL_MS = 3_000;

/**
 * At most one event per workspace and tab kind in this window. Sitting in a
 * workspace all afternoon is a handful of rows rather than one per tab switch.
 */
export const VIEW_THROTTLE_MS = 15 * 60 * 1000;

export function viewedTab(scope: ViewedScope, workspaceId: string): ViewedTab {
  if (scope.sessionKeys.has(agentSessionId(workspaceId))) return "agent";
  // A workspace's own shells are keyed under its `TerminalTabs` surface, `ws:<id>`.
  const shellPrefix = `ws:${workspaceId}/`;
  for (const key of scope.sessionKeys) {
    if (key.startsWith(shellPrefix)) return "terminal";
  }
  return "other";
}

// Module scope so the throttle survives the panel unmounting on a tab switch.
const lastRecordedAt = new Map<string, number>();

/** Claims the throttle window for `key`; false when a view was recorded inside it. */
export function claimView(key: string, now: number, recorded = lastRecordedAt): boolean {
  const last = recorded.get(key);
  if (last !== undefined && now - last < VIEW_THROTTLE_MS) return false;
  recorded.set(key, now);
  return true;
}

/**
 * Records a view of the on-screen workspace once it has held the screen for
 * {@link VIEW_DWELL_MS}. Re-renders on every focus and tab change, so mount it
 * in a leaf (`WorkspaceViewRecorder`), not in a large view.
 */
export function useWorkspaceViewEvents(
  workspaceName: string | undefined,
  record: typeof recordEvent = recordEvent,
): void {
  const scope = useViewedScope();
  const workspaceId = scope.focused ? scope.workspaceId : null;
  const tab = workspaceId ? viewedTab(scope, workspaceId) : null;
  // A ref so a rename doesn't restart the dwell timer.
  const nameRef = useRef(workspaceName);
  nameRef.current = workspaceName;

  useEffect(() => {
    if (!workspaceId || !tab) return;
    const timer = setTimeout(() => {
      if (!claimView(`${workspaceId}:${tab}`, Date.now())) return;
      void record(
        "workspace.viewed",
        { workspaceId, name: nameRef.current ?? null, tab },
        "workspaces",
      );
    }, VIEW_DWELL_MS);
    return () => clearTimeout(timer);
  }, [workspaceId, tab, record]);
}
