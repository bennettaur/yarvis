import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ensureOk } from "./api";
import { inTauri, serverFetch } from "./server";

/**
 * Commands that act on the machine in front of the user, not on the server:
 * the clipboard history, focusing the window, silencing an alarm's ring. The
 * Tauri app answers them itself, and a browser has no such feature.
 */
const LOCAL_COMMANDS = new Set([
  "clipboard_history",
  "clipboard_clear_history",
  "clipboard_write",
  "focus_main_window",
  "release_alarm",
]);

/** True when the machine-local commands above can run here. */
export function localFeaturesAvailable(): boolean {
  return inTauri();
}

/** A machine-local command asked for outside the Tauri app. */
export class LocalOnlyError extends Error {
  constructor(command: string) {
    super(`${command} only works in the Yarvis desktop app`);
    this.name = "LocalOnlyError";
  }
}

/**
 * Runs one of the core's commands (settings, secrets, PTY control) on the
 * server, as `POST /api/core/{command}` with the same arguments `invoke` took.
 * Resolves undefined when the server answers 204.
 */
export async function core<T = void>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (LOCAL_COMMANDS.has(command)) {
    if (!localFeaturesAvailable()) throw new LocalOnlyError(command);
    return invoke<T>(command, args);
  }
  const res = await serverFetch(`/api/core/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  await ensureOk(res, command);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Subscribes to an event the Tauri app raises on this machine, such as a
 * global shortcut. Outside the app there is no such event, so this resolves a
 * no-op unsubscribe.
 */
export async function onNativeEvent(event: string, cb: () => void): Promise<UnlistenFn> {
  if (!localFeaturesAvailable()) return () => {};
  return listen(event, () => cb());
}
