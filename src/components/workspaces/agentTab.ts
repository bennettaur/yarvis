import type { PinnedTab } from "../shell/terminalTabs/TerminalTabs";

/**
 * Instruction handed to the agent for a "Start work on issue" session. The issue
 * details are written to a known file under the workspace root (see the sidecar
 * `/prompt-file` route), so a static instruction to read that file is enough —
 * no need to inline the (potentially large) body into the command.
 */
const AGENT_ISSUE_INSTRUCTION =
  "Read the ticket details in .yarvis/issue-prompt.md and implement a first pass at the ticket, following the repository's conventions.";

/** Fallbacks while the configured agent is still loading. Match the Rust core's
 *  defaults in `pty.rs`. */
export const DEFAULT_AGENT_NAME = "Claude";
export const DEFAULT_AGENT_COMMAND = "claude --permission-mode auto";

/**
 * Builds the issue "Start work" launch line from the configured base command
 * (e.g. `claude --permission-mode auto`), appending the instruction as a
 * double-quoted argument. The instruction contains an apostrophe but no double
 * quotes, so double-quote wrapping is safe.
 */
export function buildAgentIssueCommand(base: string): string {
  return `${base} "${AGENT_ISSUE_INSTRUCTION}"`;
}

/** Inputs describing which (if any) agent session a workspace should surface. */
export interface AgentTabInputs {
  /** The issue "Start work" prompt, when this workspace was launched from an issue. */
  claudePrompt?: string;
  /** True once the issue prompt file has been written and the agent may launch. */
  claudePromptReady: boolean;
  /** True when a session is live under this workspace's agent session id. */
  agentActive: boolean;
  /** True once the user has closed the agent tab, until they ask for it back. */
  dismissed: boolean;
  workspaceId: string;
  /** Workspace root — where `.yarvis/issue-prompt.md` lives; the issue flow launches here. */
  rootPath: string;
  /** cwd for a core-spawned session (the lone repo's worktree, or root when multi-repo). */
  agentCwd: string;
  /** Configured agent name, used as the tab title. */
  agentName: string;
  /** Configured base command, used to build the issue launch line. */
  agentCommand: string;
}

/**
 * Resolves the workspace's agent session into a pinned terminal tab, or `null`
 * when none should show. The agent session always rides along as a pinned tab so
 * every workspace — including ones started from an issue — keeps its own
 * splittable terminal tabs alongside it.
 *
 * The issue "Start work" flow launches the agent itself, via the tab's one-shot
 * `initialCommand`, run at the workspace root where the prompt file lives; it
 * waits on the prompt file being written rather than on a live session, since
 * there isn't one yet. Every other case attaches to a session the core already
 * spawned, with no `initialCommand` so reattaching never re-runs a launch line.
 * Once the issue session is live it becomes one of those cases, so a later
 * reattach can't replay the prompt.
 */
export function resolveAgentTab({
  claudePrompt,
  claudePromptReady,
  agentActive,
  dismissed,
  workspaceId,
  rootPath,
  agentCwd,
  agentName,
  agentCommand,
}: AgentTabInputs): PinnedTab | null {
  // Closing the tab has to actually close it: while the user has dismissed it,
  // no branch below may put it back.
  if (dismissed) return null;
  const sessionId = `ws-claude:${workspaceId}`;
  if (claudePrompt && !agentActive) {
    if (!claudePromptReady) return null;
    return {
      key: "agent",
      title: agentName,
      sessionId,
      cwd: rootPath,
      initialCommand: buildAgentIssueCommand(agentCommand),
    };
  }
  if (!agentActive) return null;
  return { key: "agent", title: agentName, sessionId, cwd: agentCwd };
}
