import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Client for the Rust PTY sessions (`src-tauri/src/pty.rs`). Sessions are keyed
 * by a stable id and live in the core, so a component can detach (unmount) and
 * reattach later without losing its shell. Output arrives as `pty-output`
 * events; teardown as `pty-exit`. Mirrors the event pattern in `lib/alarms.ts`.
 */

export interface PtyAttach {
  /** True if the session already existed (so `scrollback` should be replayed). */
  existed: boolean;
  /** Captured output to replay into a fresh view; raw bytes as a number array. */
  scrollback: number[];
}

/** Attaches to session `id`, spawning a shell if it does not yet exist. */
export const attachPty = (id: string, cols: number, rows: number) =>
  invoke<PtyAttach>("pty_attach", { id, cols, rows });

/** Sends user input to the session's shell. */
export const writePty = (id: string, data: string) =>
  invoke("pty_write", { id, data });

/** Resizes the session's PTY to match the terminal viewport. */
export const resizePty = (id: string, cols: number, rows: number) =>
  invoke("pty_resize", { id, cols, rows });

/** Terminates the session's shell and frees it. */
export const killPty = (id: string) => invoke("pty_kill", { id });

/** Subscribe to output bytes for a single session. */
export const onPtyOutput = (
  id: string,
  cb: (bytes: Uint8Array) => void,
): Promise<UnlistenFn> =>
  listen<{ id: string; bytes: number[] }>("pty-output", (e) => {
    if (e.payload.id === id) cb(new Uint8Array(e.payload.bytes));
  });

/** Subscribe to the exit signal for a single session. */
export const onPtyExit = (id: string, cb: () => void): Promise<UnlistenFn> =>
  listen<{ id: string }>("pty-exit", (e) => {
    if (e.payload.id === id) cb();
  });
