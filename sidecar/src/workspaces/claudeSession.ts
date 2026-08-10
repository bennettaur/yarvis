/**
 * Starting and stopping a workspace's Claude Code session.
 *
 * The session does not run in the sidecar. Instead the sidecar asks the Rust
 * core (over the control channel) to spawn the configured agent in a PTY keyed
 * `ws-claude:<workspaceId>`. That session lives in the core, independent of the
 * webview, so it can be started headlessly (e.g. from Telegram) and the frontend
 * attaches to the same live terminal later by id.
 *
 * A session can also be given an `instruction` to start on, which is how the
 * issue "Start work" sequence hands over its ticket: the whole sequence —
 * provision, seed `.yarvis/issue-prompt.md`, launch — runs here, and the
 * frontend only ever attaches to the result.
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
  /**
   * What the session starts on, appended to the launch line as one quoted
   * argument by the core. Set by the issue "Start work" sequence so the ticket
   * is under way without anyone having to type it; omitted for a session the
   * user drives themselves.
   */
  instruction?: string;
}

export interface ClaudeSessionResult {
  /** PTY session id the frontend attaches to (`ws-claude:<workspaceId>`). */
  sessionKey: string;
}

/** Injectable starter type so the workspace tool is testable without the core. */
export type ClaudeSessionStarter = (input: StartClaudeSessionInput) => Promise<ClaudeSessionResult>;

/**
 * How a tool's description refers to the session it starts. The model relays
 * this to the user as fact, so a turn that won't enable Remote Control must not
 * advertise a session the user can drive from their phone.
 */
export function sessionDescription(remoteControl: boolean): string {
  return remoteControl
    ? "a remote-controllable Claude Code session (drivable from claude.ai/code or the Claude mobile app by its name, and visible as a live terminal in the Workspaces tab)"
    : "a Claude Code session (visible as a live terminal in the Workspaces tab)";
}

/** What a tool reports back after starting a session. Shares its wording with
 *  `sessionDescription` so the two can't drift apart. */
export function sessionStartedMessage(name: string, remoteControl: boolean): string {
  return remoteControl
    ? `Started a remote-controllable Claude Code session in workspace "${name}". Open it from claude.ai/code or the Claude mobile app by the name "${name}", or view it live in the Workspaces tab.`
    : `Started a Claude Code session in workspace "${name}". View it live in the Workspaces tab. It is not remotely controllable — say so if the user asks to drive it from elsewhere.`;
}

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
