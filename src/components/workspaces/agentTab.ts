import { DEFAULT_AGENT_TAB_TITLE } from "../shell/terminalTabs/sessionIds";
import type { PinnedTab } from "../shell/terminalTabs/surfaceState";

/** Fallbacks while the configured agent is still loading. Match the Rust core's
 *  defaults in `pty.rs`. */
export const DEFAULT_AGENT_NAME = DEFAULT_AGENT_TAB_TITLE;
export const DEFAULT_AGENT_COMMAND = "claude --permission-mode auto";

/**
 * A workspace's agent session id. Stays `ws-claude:` prefixed regardless of which
 * agent is configured: the id is a stable key that the core, the sidecar and
 * already-running sessions all share, so renaming it would orphan live sessions.
 */
export function agentSessionId(workspaceId: string): string {
  return `ws-claude:${workspaceId}`;
}

/** Inputs describing which (if any) agent session a workspace should surface. */
export interface AgentTabInputs {
  /** True when a session is live under this workspace's agent session id. */
  agentActive: boolean;
  /** True once the user has closed the agent tab, until they ask for it back. */
  dismissed: boolean;
  workspaceId: string;
  /** Where the session runs: always the workspace root (see
   *  `agentCwdForWorkspace`). */
  cwd: string;
  /** Configured agent name, used as the tab title. */
  agentName: string;
}

/**
 * Resolves the workspace's agent session into a pinned terminal tab, or `null`
 * when none should show. This surface only ever *attaches* — nothing here starts
 * a session on a ticket. A workspace opened from an issue's "Start work" already
 * has one, launched by the sidecar as the last step of provisioning, so by the
 * time the workspace can be looked at there is a live session to pick up.
 */
export function resolveAgentTab({
  agentActive,
  dismissed,
  workspaceId,
  cwd,
  agentName,
}: AgentTabInputs): PinnedTab | null {
  // Closing the tab has to actually close it.
  if (dismissed) return null;
  if (!agentActive) return null;
  return { key: "agent", title: agentName, sessionId: agentSessionId(workspaceId), cwd };
}

/** Inputs deciding whether opening a workspace should start an agent session. */
export interface AutoStartInputs {
  /** True once the user has closed the agent tab. */
  dismissed: boolean;
  workspaceStatus: string;
  /** True once the liveness poll has answered for this workspace. */
  probed: boolean;
  agentActive: boolean;
  /** True once this view has already fired a start. */
  alreadyStarted: boolean;
}

/**
 * Whether a workspace should start an agent session on open. Every provisioned
 * workspace surfaces one, so opening a workspace is enough to get a tab you can
 * drive — but four things have to hold first, and each guards a distinct way of
 * getting it wrong. Extracted from the effect in `WorkspacesPanel` so those are
 * testable without mounting a workspace full of live shells.
 *
 * A workspace kicked off from an issue needs nothing special here: its session
 * already exists before the workspace reports itself provisioned, so `probed`
 * resolves to `agentActive` and this declines to start a second one.
 */
export function shouldAutoStartAgent({
  dismissed,
  workspaceStatus,
  probed,
  agentActive,
  alreadyStarted,
}: AutoStartInputs): boolean {
  // Closing the tab must not be undone by the effect that opened it.
  if (dismissed) return false;
  // Only a provisioned workspace has worktrees to run in.
  if (workspaceStatus !== "active") return false;
  // Starting before the liveness poll answers would spawn a second session into
  // a workspace that already has one.
  if (!probed) return false;
  return !agentActive && !alreadyStarted;
}
