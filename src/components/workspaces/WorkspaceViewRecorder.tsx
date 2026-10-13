import { useWorkspaceViewEvents } from "../../lib/workspaceViews";

/**
 * Records `workspace.viewed` events. A component of its own so the viewed-scope
 * subscription re-renders only this, not the workspace view around it.
 */
export default function WorkspaceViewRecorder({ name }: { name: string | undefined }) {
  useWorkspaceViewEvents(name);
  return null;
}
