import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Client for the Rust PTY sessions (`src-tauri/src/pty.rs`). Sessions are keyed
 * by a stable id and live in the core, so a component can detach (unmount) and
 * reattach later without losing its shell. Output and teardown arrive on
 * per-session events (`pty-output:<id>` / `pty-exit:<id>`) so a terminal only
 * receives its own bytes. Mirrors the event pattern in `lib/alarms.ts`.
 */

/** Attaches to session `id`, spawning a shell if it does not yet exist. Returns
 * the captured scrollback (raw bytes as a number array) to replay. `cwd` sets
 * the working directory for a freshly spawned shell (ignored on reattach). */
export const attachPty = (id: string, cols: number, rows: number, cwd?: string) =>
  invoke<number[]>("pty_attach", { id, cols, rows, cwd });

/** Sends user input to the session's shell. */
export const writePty = (id: string, data: string) => invoke("pty_write", { id, data });

/** Resizes the session's PTY to match the terminal viewport. */
export const resizePty = (id: string, cols: number, rows: number) =>
  invoke("pty_resize", { id, cols, rows });

/** Terminates the session's shell and frees it. */
export const killPty = (id: string) => invoke("pty_kill", { id });

/** True if a live session exists for `id` (without spawning one). */
export const ptyExists = (id: string) => invoke<boolean>("pty_exists", { id });

/** Starts a remote-controllable Claude session for a workspace, keyed
 * `ws-claude:<workspaceId>`. Resolves once the session is registered. */
export const startClaudeSession = (
  workspaceId: string,
  cwd: string,
  name: string,
  baseCommand?: string,
) => invoke("pty_start_claude", { workspaceId, cwd, name, baseCommand });

/** True when a non-shell foreground process is running in the session — used to
 * decide whether closing should require confirmation. False for unknown
 * sessions and for platforms that can't report a foreground process group. */
export const isPtyBusy = (id: string) => invoke<boolean>("pty_is_busy", { id });

/** Subscribe to output bytes for a single session. */
export const onPtyOutput = (id: string, cb: (bytes: Uint8Array) => void): Promise<UnlistenFn> =>
  listen<number[]>(`pty-output:${id}`, (e) => cb(new Uint8Array(e.payload)));

/** Subscribe to the exit signal for a single session. */
export const onPtyExit = (id: string, cb: () => void): Promise<UnlistenFn> =>
  listen(`pty-exit:${id}`, () => cb());
