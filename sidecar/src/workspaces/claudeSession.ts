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
 * provision, seed `.yarvis/brief.md`, launch — runs here, and the
 * frontend only ever attaches to the result.
 *
 * `remoteControl` adds `--remote-control`, making the session drivable from
 * claude.ai/code or the Claude mobile app. It is off unless the launch came from
 * somewhere the user isn't at the machine — see `startedRemotely` in the chat
 * agent. A session started at the laptop can be made remotely controllable from
 * inside the session itself.
 */

import { channelHub } from "../channel/hub.ts";
import { type ChannelSendOptions, sendOverChannel } from "../channel/send.ts";
import {
  killClaudeSession,
  sendClaudeInstruction,
  spawnClaudeSession,
} from "../core/controlClient.ts";
import type { Db } from "../db/client.ts";
import { emitEvent } from "../events/service.ts";
import { reapAndListAgentSessions } from "./agentSessions.ts";
import { type WorkspaceForSettings, writeClaudeSettings } from "./claudeSettings.ts";

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

/** The PTY id of a workspace's agent tab, which the core and the channel both key by. */
export function agentTabSessionKey(workspaceId: string): string {
  return `ws-claude:${workspaceId}`;
}

/** Asks the core to start the session; returns the key the frontend attaches to. */
export async function startClaudeSession(
  input: StartClaudeSessionInput,
): Promise<ClaudeSessionResult> {
  await spawnClaudeSession(input);
  return { sessionKey: agentTabSessionKey(input.workspaceId) };
}

/** Best-effort stop of a workspace's Claude session via the core. */
export async function stopClaudeSession(workspaceId: string): Promise<void> {
  // The session's replies go with it, so an archived workspace's don't linger.
  channelHub.forget(agentTabSessionKey(workspaceId));
  await killClaudeSession(workspaceId);
}

export interface SendSessionInstructionInput {
  /** Workspace whose session receives the instruction. */
  workspaceId: string;
  /** What to type at the session's prompt, as the user would have typed it. */
  instruction: string;
  /**
   * Pids of the Claude processes registered for the session's PTY. The core
   * treats the session as Claude's when one of them leads the PTY's foreground
   * process group, in addition to its own executable-name check.
   */
  agentPids: number[];
}

/**
 * The start of the core's refusal when neither a registered pid nor the
 * agent's executable name identifies what holds the prompt. Must match the
 * message in `send_session_instruction` in `src-tauri/src/pty.rs`.
 */
export const AGENT_NOT_RECOGNISED_ERROR =
  "the configured agent is not what is reading that session's prompt";

/**
 * The core's refusal when the workspace has no agent tab at all — nothing a
 * fresh spawn would collide with. Must match the message in
 * `send_session_instruction` in `src-tauri/src/pty.rs`.
 */
export const NO_AGENT_SESSION_ERROR = "no agent session is running for that workspace";

/**
 * The core's refusal when the agent tab's shell has itself exited. The dead
 * session still holds the tab's id, so a spawn is discarded until it is
 * killed. Must match `send_session_instruction` in `src-tauri/src/pty.rs`.
 */
export const AGENT_SESSION_EXITED_ERROR = "the agent session has exited";

/** Injectable sender so the workspace tool is testable without the core. */
export type ClaudeSessionMessenger = (input: SendSessionInstructionInput) => Promise<void>;

/**
 * Types an instruction at a workspace session's prompt and submits it, so an
 * already-running agent can be given follow-up work — resolving the conflicts a
 * bulk sync left behind, say — without a new session or the user switching tabs.
 *
 * The core refuses to send unless an agent, rather than the bare shell the
 * session was launched from, is reading the prompt; it also strips the control
 * characters that would submit a partial instruction. Both matter because the
 * instruction is composed by a model from text an outside party can influence.
 */
export async function sendSessionInstruction(input: SendSessionInstructionInput): Promise<void> {
  await sendClaudeInstruction(input);
}

/** Pids of the Claude sessions registered in a workspace's agent tab, oldest first. */
export async function agentTabPids(db: Db, workspaceId: string): Promise<number[]> {
  const sessionKey = agentTabSessionKey(workspaceId);
  const sessions = (await reapAndListAgentSessions(db, [workspaceId])).get(workspaceId) ?? [];
  return sessions.filter((s) => s.sessionKey === sessionKey).map((s) => s.pid);
}

/** Why an instruction didn't reach the agent, from the core's refusal. */
export type AgentSendFailure =
  /** The workspace has no agent tab; a fresh spawn would take it. */
  | "no_session"
  /** The tab's shell exited; its dead session still holds the id. */
  | "exited"
  /** Something other than a recognised agent holds the prompt. */
  | "not_recognised"
  | "error";

export type AgentSendResult =
  | { delivered: true; via: "pty" }
  /** Handed to the session's channel relay; replies come back under `messageId`. */
  | { delivered: true; via: "channel"; messageId: string }
  | { delivered: false; failure: AgentSendFailure; error: string };

/**
 * Gives an instruction to a workspace's agent and records that it did, shared
 * by every caller that forwards text into a session so they all keep the same
 * rules. It goes over the session's channel when one is listening, where it
 * arrives as its own turn and can't land in a dialog or a half-typed prompt,
 * and is typed at the agent tab otherwise. The event logs the instruction's
 * length, not its text: it can be composed from data an outside party
 * influenced, and the event log is read back into later prompts.
 *
 * On the typed path, when the core can't tell what holds the prompt and
 * nothing has registered, the agent most likely predates the workspace's registration hooks; writing
 * them now means a restarted session registers.
 */
export async function sendToWorkspaceAgent(
  db: Db,
  workspace: WorkspaceForSettings & { name: string },
  instruction: string,
  {
    agentPids,
    send = sendSessionInstruction,
    channel,
    eventSource,
    eventPayload = {},
  }: {
    /** From {@link agentTabPids}, which the caller has usually read already. */
    agentPids: number[];
    send?: ClaudeSessionMessenger;
    channel?: ChannelSendOptions;
    eventSource: string;
    eventPayload?: Record<string, unknown>;
  },
): Promise<AgentSendResult> {
  const recordSent = (result: Extract<AgentSendResult, { delivered: true }>) => {
    void emitEvent(db, {
      type: "workspace.instruction_sent",
      source: eventSource,
      payload: {
        workspaceId: workspace.id,
        name: workspace.name,
        chars: instruction.length,
        via: result.via,
        ...eventPayload,
      },
    });
    return result;
  };

  const message = sendOverChannel(
    agentTabSessionKey(workspace.id),
    instruction,
    agentPids,
    channel,
  );
  if (message) return recordSent({ delivered: true, via: "channel", messageId: message.id });

  try {
    await send({ workspaceId: workspace.id, instruction, agentPids });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    let failure: AgentSendFailure = "error";
    if (error.includes(NO_AGENT_SESSION_ERROR)) failure = "no_session";
    else if (error.includes(AGENT_SESSION_EXITED_ERROR)) failure = "exited";
    else if (error.includes(AGENT_NOT_RECOGNISED_ERROR)) failure = "not_recognised";
    if (failure === "not_recognised" && agentPids.length === 0) {
      writeClaudeSettings(workspace);
    }
    return { delivered: false, failure, error };
  }
  return recordSent({ delivered: true, via: "pty" });
}
