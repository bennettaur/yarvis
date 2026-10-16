import type { AttentionNavTarget } from "../db/schema.ts";

/**
 * Where clicking the item lands. A workspace's pinned Claude session keeps the
 * `workspace-claude` target (the frontend already knows how to focus that tab);
 * anything else is a specific terminal session, so we address the tab directly
 * and carry the workspace along when there is one.
 */
export function navTargetFor(sessionKey: string, workspaceId?: string): AttentionNavTarget {
  if (workspaceId && sessionKey === `ws-claude:${workspaceId}`) {
    return { type: "workspace-claude", workspaceId };
  }
  return { type: "terminal", sessionKey, ...(workspaceId ? { workspaceId } : {}) };
}
