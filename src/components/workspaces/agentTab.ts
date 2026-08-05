import { DEFAULT_AGENT_TAB_TITLE } from "../shell/terminalTabs/sessionIds";
import type { PinnedTab } from "../shell/terminalTabs/surfaceState";

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
  issuePrompt?: string;
  /** True once the issue prompt file has been written and the agent may launch. */
  issuePromptReady: boolean;
  /** True when a session is live under this workspace's agent session id. */
  agentActive: boolean;
  /** True once the user has closed the agent tab, until they ask for it back. */
  dismissed: boolean;
  workspaceId: string;
  /** Where the session runs: always the workspace root (see
   *  `agentCwdForWorkspace`), which is also where `.yarvis/issue-prompt.md` is
   *  seeded, so the issue flow can launch there too. */
  cwd: string;
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
 */
export function resolveAgentTab({
  issuePrompt,
  issuePromptReady,
  agentActive,
  dismissed,
  workspaceId,
  cwd,
  agentName,
  agentCommand,
}: AgentTabInputs): PinnedTab | null {
  // Closing the tab has to actually close it: while the user has dismissed it,
  // no branch below may put it back.
  if (dismissed) return null;
  const tab: PinnedTab = {
    key: "agent",
    title: agentName,
    sessionId: agentSessionId(workspaceId),
    cwd,
  };
  if (issuePrompt) {
    // This surface launches the agent itself for the issue flow, so it waits on
    // the prompt file being written and never falls through to the attach branch
    // below — showing a tab first would spawn a bare shell with nothing to run.
    if (!issuePromptReady) return null;
    // Once the session is live this is an ordinary attach. Handing back the
    // launch line again would re-run the whole ticket on the next fresh spawn.
    return agentActive ? tab : { ...tab, initialCommand: buildAgentIssueCommand(agentCommand) };
  }
  if (!agentActive) return null;
  return tab;
}

/** Inputs deciding whether opening a workspace should start an agent session. */
export interface AutoStartInputs {
  /** Set for the issue flow, which launches its own session via the tab. */
  issuePrompt?: string;
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
 */
export function shouldAutoStartAgent({
  issuePrompt,
  dismissed,
  workspaceStatus,
  probed,
  agentActive,
  alreadyStarted,
}: AutoStartInputs): boolean {
  // The issue flow launches its own session, seeded with the prompt file; the
  // two must not both fire at the same session id.
  if (issuePrompt) return false;
  // Closing the tab must not be undone by the effect that opened it.
  if (dismissed) return false;
  // Only a provisioned workspace has worktrees to run in.
  if (workspaceStatus !== "active") return false;
  // Starting before the liveness poll answers would spawn a second session into
  // a workspace that already has one.
  if (!probed) return false;
  return !agentActive && !alreadyStarted;
}
