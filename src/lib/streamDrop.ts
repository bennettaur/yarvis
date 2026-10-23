import { getHealth, type HealthResponse } from "./api";
import type { DisplayError } from "./errors";

/**
 * True for the error a `fetch` throws when the connection itself fails, as
 * opposed to an HTTP error status or a bug in our own code. Each engine words it
 * differently: WebKit (the macOS app's webview) says "Load failed" or "The
 * network connection was lost.", Chromium "Failed to fetch" or "network error".
 */
export function isConnectionDrop(error: unknown): error is TypeError {
  return (
    error instanceof TypeError &&
    /load failed|failed to fetch|network (connection|error)|connection was lost/i.test(
      error.message,
    )
  );
}

export interface StreamDropContext {
  error: TypeError;
  /** When the turn was sent, in epoch ms. */
  startedAt: number;
  /** The last event the stream delivered before it dropped; "none" if it sent nothing. */
  lastEventType: string;
  lastEventAt: number;
  now?: number;
}

/**
 * Where the Rust core writes the sidecar's output. Settings → Diagnostics only
 * shows what the running sidecar has logged, so a crash or restart wipes it
 * there. The folder is named for the bundle id, which a dev instance changes.
 */
const SIDECAR_LOG_FILE = "sidecar.log, in the app's folder under ~/Library/Logs";

function seconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Explains a chat stream that was cut off. The browser only says "Load failed",
 * which gives the user nothing to act on, so this checks whether the sidecar is
 * still up and whether it restarted during the turn, and records how far the
 * turn got.
 */
export function describeStreamDrop(
  context: StreamDropContext,
  health: HealthResponse | Error,
): DisplayError {
  const now = context.now ?? Date.now();
  const elapsed = now - context.startedAt;
  const lines = [
    `Browser error: ${context.error.name}: ${context.error.message}`,
    `Turn ran for: ${seconds(elapsed)}`,
    `Last event received: ${context.lastEventType}, ${seconds(now - context.lastEventAt)} before the drop`,
  ];

  let message: string;
  if (health instanceof Error) {
    lines.push(`Sidecar now: not answering (${health.message})`);
    message = `Lost the connection to the sidecar mid-turn, and it isn't answering now. It may have crashed; its output is in ${SIDECAR_LOG_FILE}.`;
  } else if (health.uptimeMs < elapsed) {
    lines.push(`Sidecar now: up, restarted ${seconds(health.uptimeMs)} ago`);
    message = `The sidecar restarted during this turn, which cut the reply off. Saving keys in Settings restarts it; otherwise look for a crash in ${SIDECAR_LOG_FILE}.`;
  } else {
    lines.push(`Sidecar now: up for ${seconds(health.uptimeMs)}, so it did not restart`);
    message =
      "The connection to the sidecar dropped mid-turn. Settings → Diagnostics has a line for it under [chat].";
  }
  return { message, detail: lines.join("\n") };
}

/** `describeStreamDrop` with the sidecar's current health fetched for it. */
export async function explainStreamDrop(context: StreamDropContext): Promise<DisplayError> {
  const health = await getHealth().catch((e: unknown) =>
    e instanceof Error ? e : new Error(String(e)),
  );
  return describeStreamDrop(context, health);
}
