import { CLAUDE_TAB_TITLE } from "../shell/terminalTabs/sessionIds";
import type { PinnedTab } from "../shell/terminalTabs/TerminalTabs";

/**
 * Instruction handed to Claude for a "Start work on issue" session. The issue
 * details are written to a known file under the workspace root (see the sidecar
 * `/prompt-file` route), so a static instruction to read that file is enough —
 * no need to inline the (potentially large) body into the command.
 */
const CLAUDE_ISSUE_INSTRUCTION =
  "Read the ticket details in .yarvis/issue-prompt.md and implement a first pass at the ticket, following the repository's conventions.";

/** Fallback base command while the configured one is still loading (matches the
 *  Rust core's default). */
export const DEFAULT_CLAUDE_COMMAND = "claude --permission-mode auto";

/**
 * Builds the issue "Start work" launch line from the configured base command
 * (e.g. `claude --permission-mode auto`), appending the instruction as a
 * double-quoted argument. The instruction contains an apostrophe but no double
 * quotes, so double-quote wrapping is safe.
 */
export function buildClaudeIssueCommand(base: string): string {
  return `${base} "${CLAUDE_ISSUE_INSTRUCTION}"`;
}

/** Inputs describing which (if any) Claude session a workspace should surface. */
export interface ClaudeTabInputs {
  /** The issue "Start work" prompt, when this workspace was launched from an issue. */
  claudePrompt?: string;
  /** True once the issue prompt file has been written and Claude may launch. */
  claudePromptReady: boolean;
  /** True when a core-spawned Claude session is live (the remote-control flow). */
  claudeActive: boolean;
  workspaceId: string;
  /** Workspace root — where `.yarvis/issue-prompt.md` lives; the issue flow launches here. */
  rootPath: string;
  /** cwd for a core-spawned session (the lone repo's worktree, or root when multi-repo). */
  claudeCwd: string;
  /** Configured base Claude command, used to build the issue launch line. */
  claudeCommand: string;
}

/**
 * Resolves the workspace's Claude session into a pinned terminal tab, or `null`
 * when none should show yet. The Claude session always rides along as a pinned
 * tab so every workspace — including ones started from an issue — keeps its own
 * splittable terminal tabs alongside it.
 *
 * Two flows, kept distinct because they must not cross:
 *  - Issue "Start work": this surface launches Claude itself via the tab's
 *    one-shot `initialCommand`, run at the workspace root where the issue prompt
 *    file lives. It waits on `claudePromptReady` (the file being written), never
 *    on `claudeActive`.
 *  - Otherwise: attach to a session the core already spawned. No `initialCommand`,
 *    so reattaching never re-runs a launch line on a live session.
 */
export function resolveClaudeTab({
  claudePrompt,
  claudePromptReady,
  claudeActive,
  workspaceId,
  rootPath,
  claudeCwd,
  claudeCommand,
}: ClaudeTabInputs): PinnedTab | null {
  const sessionId = `ws-claude:${workspaceId}`;
  if (claudePrompt) {
    if (!claudePromptReady) return null;
    return {
      key: "claude",
      title: CLAUDE_TAB_TITLE,
      sessionId,
      cwd: rootPath,
      initialCommand: buildClaudeIssueCommand(claudeCommand),
    };
  }
  if (!claudeActive) return null;
  return { key: "claude", title: "Claude", sessionId, cwd: claudeCwd };
}
