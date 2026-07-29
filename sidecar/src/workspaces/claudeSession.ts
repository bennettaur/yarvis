/**
 * Starting and stopping a workspace's Claude Code session.
 *
 * The session does not run in the sidecar. Instead the sidecar asks the Rust
 * core (over the control channel) to spawn the configured agent in a PTY keyed
 * `ws-claude:<workspaceId>`. That session lives in the core, independent of the
 * webview, so it can be started headlessly (e.g. from Telegram) and the frontend
 * attaches to the same live terminal later by id.
 *
 * `remoteControl` adds `--remote-control`, making the session drivable from
 * claude.ai/code or the Claude mobile app. It is off unless the launch came from
 * somewhere the user isn't at the machine — see `startedRemotely` in the chat
 * agent. A session started at the laptop can be made remotely controllable from
 * inside the session itself.
 */

import { killClaudeSession, spawnClaudeSession } from "../core/controlClient.ts";

export interface StartClaudeSessionInput {
  /** Workspace the session belongs to; forms the PTY session key. */
  workspaceId: string;
  /** Directory the session works in (a worktree, or the workspace root). */
  cwd: string;
  /** Session title shown in claude.ai/code and the mobile app. */
  name: string;
  /** Launch with Remote Control enabled. See this module's header. */
  remoteControl: boolean;
}

export interface ClaudeSessionResult {
  /** PTY session id the frontend attaches to (`ws-claude:<workspaceId>`). */
  sessionKey: string;
}

/** Injectable starter type so the workspace tool is testable without the core. */
export type ClaudeSessionStarter = (input: StartClaudeSessionInput) => Promise<ClaudeSessionResult>;

/** Asks the core to start the session; returns the key the frontend attaches to. */
export async function startClaudeSession(
  input: StartClaudeSessionInput,
): Promise<ClaudeSessionResult> {
  await spawnClaudeSession(input);
  return { sessionKey: `ws-claude:${input.workspaceId}` };
}

/** Best-effort stop of a workspace's Claude session via the core. */
export async function stopClaudeSession(workspaceId: string): Promise<void> {
  await killClaudeSession(workspaceId);
}
