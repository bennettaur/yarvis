/**
 * Client for the Rust core's control channel (`src-tauri/src/control.rs`).
 *
 * The core listens on a Unix domain socket whose path is injected as
 * `YARVIS_CORE_SOCK`; this is how the sidecar asks the core to do things only it
 * can — spawning/killing a Claude Code session in a workspace PTY, writing
 * refreshed MCP OAuth credentials into the Keychain, and reading a Claude Code
 * harness's environment for a verification run. The wire protocol is
 * newline-delimited JSON: each request `{ id, method, params }` gets one reply
 * `{ id, ok, result?, error? }`, with `result` only from a method that answers
 * with data.
 */

import net from "node:net";
import { z } from "zod";
import type { McpOAuthCredentials } from "../config.ts";

interface Pending {
  resolve: (result: unknown) => void;
  reject: (e: Error) => void;
}

let socket: net.Socket | null = null;
let connecting: Promise<net.Socket> | null = null;
let buffer = "";
let nextId = 1;
const pending = new Map<number, Pending>();

/** How long to wait for a reply before failing a request. */
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Review sessions are started and ended under a per-workspace lock that
 * removals and archives wait on, so a hung core holds them up for 5s, or 10s
 * when a start times out and its session is then ended.
 */
const REVIEW_SESSION_TIMEOUT_MS = 5_000;
/** Reading a harness's secrets can wait on a 1Password unlock the user has to answer. */
const HARNESS_RUN_ENV_TIMEOUT_MS = 60_000;

function socketPath(): string {
  const path = process.env.YARVIS_CORE_SOCK;
  if (!path) {
    throw new Error("YARVIS_CORE_SOCK is not set; the core control channel is unavailable");
  }
  return path;
}

function onData(chunk: string): void {
  buffer += chunk;
  let idx = buffer.indexOf("\n");
  while (idx >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf("\n");
    if (!line.trim()) continue;
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg.id !== "number") continue;
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "control request failed"));
  }
}

function onClose(): void {
  socket = null;
  buffer = "";
  const err = new Error("core control connection closed");
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

async function getSocket(): Promise<net.Socket> {
  if (socket && !socket.destroyed) return socket;
  if (connecting) return connecting;
  // Read before the promise exists: a throw inside it would leave `connecting`
  // holding a rejection that every later call returns, even once the path is set.
  const path = socketPath();
  connecting = new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection({ path });
    s.setEncoding("utf8");
    const onConnectError = (e: Error) => {
      connecting = null;
      reject(e);
    };
    s.once("error", onConnectError);
    s.once("connect", () => {
      s.removeListener("error", onConnectError);
      s.on("data", onData);
      s.on("close", onClose);
      s.on("error", (e) => console.error("[control] socket error:", e.message));
      socket = s;
      connecting = null;
      resolve(s);
    });
  });
  return connecting;
}

/** A request the core didn't answer in time. It may still act on it later. */
export class ControlTimeoutError extends Error {}

async function rpc(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const s = await getSocket();
  const id = nextId++;
  const payload = `${JSON.stringify({ id, method, params })}\n`;
  return await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new ControlTimeoutError(`control RPC '${method}' timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    s.write(payload, (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  });
}

/** Asks the core to start an agent session in `cwd`, optionally with Remote
 *  Control enabled, resuming an earlier Claude Code session, starting on an
 *  instruction, or with a harness other than the default. */
export async function spawnClaudeSession(input: {
  workspaceId: string;
  cwd: string;
  name: string;
  remoteControl: boolean;
  resumeSessionId?: string;
  instruction?: string;
  harness?: string;
}): Promise<void> {
  await rpc("claude.spawn", {
    harness: input.harness,
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    name: input.name,
    remoteControl: input.remoteControl,
    resume: input.resumeSessionId,
    instruction: input.instruction,
  });
}

/** What a headless run needs to use a harness the user saved. */
export interface HarnessRunEnv {
  /** Which CLI it is, so the run knows how to drive it. */
  kind: "claude-code" | "opencode" | "pi";
  program: string;
  /** The harness's environment, its secret variables included. */
  env: Record<string, string>;
}

const harnessRunEnvSchema = z.object({
  kind: z.enum(["claude-code", "opencode", "pi"]),
  program: z.string().min(1),
  env: z.record(z.string(), z.string()),
});

/**
 * Asks the core for harness `harness`'s kind, program and environment, secrets
 * included, for a verification run. The core refuses any harness that isn't
 * Claude Code, OpenCode or Pi. The values are credentials: they go into the run's
 * environment and nowhere else, never into a log, a row or a reply.
 */
export async function harnessRunEnv(harness: string): Promise<HarnessRunEnv> {
  return harnessRunEnvSchema.parse(
    await rpc("harness.runEnv", { harness }, HARNESS_RUN_ENV_TIMEOUT_MS),
  );
}

/**
 * Asks the core to start Claude Code for a review workspace, keyed
 * `review-claude:<workspaceId>`, in `cwd` with each of `addDirs` added.
 * `settings` (JSON text) is its only settings and `context` is appended to the
 * core's own guardrail prompt. The core builds the rest of the launch line.
 */
export async function spawnReviewClaudeSession(input: {
  workspaceId: string;
  cwd: string;
  addDirs: string[];
  settings: string;
  context: string;
  /** Whether the session loads the repos' own skills and CLAUDE.md. */
  loadRepoConfig: boolean;
}): Promise<void> {
  await rpc("claude.spawnReview", input, REVIEW_SESSION_TIMEOUT_MS);
}

/** Asks the core to end a review workspace's Ask Claude session, if one is running. */
export async function killReviewClaudeSession(workspaceId: string): Promise<void> {
  await rpc("claude.killReview", { workspaceId }, REVIEW_SESSION_TIMEOUT_MS);
}

/** Asks the core to kill a workspace's Claude session, if one is running. */
export async function killClaudeSession(workspaceId: string): Promise<void> {
  await rpc("claude.kill", { workspaceId });
}

/**
 * Asks the core to type `instruction` at the prompt of a workspace's running
 * agent session and submit it. Rejects when no session is running, when the
 * agent has exited, when neither a registered `agentPids` entry nor the
 * configured agent's executable is what holds the prompt, or when the
 * instruction sanitizes to nothing — see `send_session_instruction` in
 * `src-tauri/src/pty.rs`.
 */
export async function sendClaudeInstruction(input: {
  workspaceId: string;
  instruction: string;
  agentPids: number[];
}): Promise<void> {
  await rpc("claude.send", {
    workspaceId: input.workspaceId,
    instruction: input.instruction,
    agentPids: input.agentPids,
  });
}

/**
 * Asks the core to type slash command `command` (with any `arguments`) at a
 * workspace's running agent session and submit it. The core refuses a command
 * that isn't on its allowlist, as well as everything `sendClaudeInstruction`
 * refuses — see `send_session_slash_command` in `src-tauri/src/pty.rs`.
 */
export async function sendClaudeSlashCommand(input: {
  workspaceId: string;
  command: string;
  arguments?: string;
  agentPids: number[];
}): Promise<void> {
  await rpc("claude.slash", {
    workspaceId: input.workspaceId,
    command: input.command,
    arguments: input.arguments,
    agentPids: input.agentPids,
  });
}

/**
 * Asks the core to store an MCP server's OAuth credentials in the Keychain, or
 * to forget them when `credentials` is null. The sidecar can't reach the
 * Keychain itself, and a token refresh must not wait for an app restart to be
 * durable — see `sidecar/src/mcp/oauth.ts`.
 */
export async function saveMcpOAuth(
  serverId: string,
  credentials: McpOAuthCredentials | null,
): Promise<void> {
  await rpc("mcp.saveOAuth", { serverId, oauth: credentials });
}

/**
 * Asks the core to store the GitHub token from a device-flow sign-in in the
 * Keychain. The sidecar picks it up on its next start, like a pasted token.
 */
export async function saveGitHubToken(token: string): Promise<void> {
  await rpc("github.saveToken", { token });
}

/** Whether a core is listening. False under `sidecar:dev` and in tests, where nothing can ring an alarm. */
export function hasCoreChannel(): boolean {
  return Boolean(process.env.YARVIS_CORE_SOCK);
}

/** The alarm shape the core rings and hands on to the webview's takeover. */
export interface CoreAlarm {
  id: string;
  label: string;
  fireAtMs: number;
  sound: boolean;
  meetLink: string | null;
  status: string;
}

/**
 * Asks the core to ring an alarm the sidecar marked fired: it takes over the
 * window, shows a notification, and plays the sound until the alarm is released.
 */
export async function fireAlarm(alarm: CoreAlarm): Promise<void> {
  await rpc("alarm.fire", { alarm });
}

/** Asks the core to stop ringing an alarm and hand the window back. A no-op for one not ringing. */
export async function releaseAlarm(id: string): Promise<void> {
  await rpc("alarm.release", { id });
}
