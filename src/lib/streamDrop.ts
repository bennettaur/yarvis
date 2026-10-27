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
  /** The last event the turn sent before the drop, heartbeats aside; type "none" if it sent nothing. */
  lastEvent: { type: string; at: number };
  /** Defaults to `Date.now()`; tests pin it. */
  now?: number;
}

/**
 * Where to find the log the Rust core keeps of the sidecar's output.
 * Diagnostics lists only what the running sidecar has logged, so a crash or
 * restart clears it there, but the section also shows this file's path.
 */
const SIDECAR_LOG_LOCATION = "sidecar.log (Settings → Diagnostics shows its full path)";

/** A dead sidecar refuses the connection at once; a hung one would never answer. */
const HEALTH_TIMEOUT_MS = 3_000;

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Explains a chat stream that was cut off. The browser only reports a generic
 * fetch failure ("Load failed" in WebKit), which gives the user nothing to act
 * on, so this checks whether the sidecar is still up and whether it restarted
 * during the turn, and records how far the turn got.
 */
export function describeStreamDrop(
  context: StreamDropContext,
  health: HealthResponse | Error,
): DisplayError {
  const now = context.now ?? Date.now();
  const elapsed = now - context.startedAt;
  const { lastEvent } = context;
  const lines = [
    `Browser error: ${context.error.name}: ${context.error.message}`,
    `Turn ran for: ${formatElapsed(elapsed)}`,
    lastEvent.type === "none"
      ? "Last event received: none"
      : `Last event received: ${lastEvent.type}, ${formatElapsed(now - lastEvent.at)} before the drop`,
  ];

  let message: string;
  if (health instanceof Error) {
    lines.push(`Sidecar now: not answering (${health.message})`);
    message = `Lost the connection to the sidecar mid-turn, and it isn't answering now. It may have crashed; check ${SIDECAR_LOG_LOCATION}.`;
  } else if (health.uptimeMs < elapsed) {
    lines.push(`Sidecar now: up, restarted ${formatElapsed(health.uptimeMs)} ago`);
    message = `The sidecar restarted during this turn, which cut the reply off. Saving API keys or other secrets in Settings restarts it; if you didn't, check ${SIDECAR_LOG_LOCATION} for a crash.`;
  } else {
    lines.push(`Sidecar now: up for ${formatElapsed(health.uptimeMs)}, so it did not restart`);
    message =
      'The connection to the sidecar dropped mid-turn, though the sidecar kept running. Settings → Diagnostics may show a matching "[chat] client closed the stream" warning.';
  }
  return { message, detail: lines.join("\n") };
}

/** `describeStreamDrop` with the sidecar's current health fetched for it. */
export async function explainStreamDrop(context: StreamDropContext): Promise<DisplayError> {
  const timeout = new Promise<Error>((resolve) =>
    setTimeout(
      () => resolve(new Error(`no answer within ${HEALTH_TIMEOUT_MS / 1000}s`)),
      HEALTH_TIMEOUT_MS,
    ),
  );
  const health = await Promise.race([
    getHealth().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    timeout,
  ]);
  return describeStreamDrop(context, health);
}
