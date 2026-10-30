import { streamSSE } from "./api";

/**
 * Client for the sidecar's live activity stream (`/api/activity/stream`), which
 * feeds the Agent Field page. Mirrors the sidecar's `ActivityEvent`.
 */
export interface ActivityEvent {
  origin: "claude" | "yarvis";
  type: string;
  source: string;
  label: string;
}

type ActivityFrame = { type: "event"; event: ActivityEvent } | { type: "ping" };

const RECONNECT_MS = 2_000;

/**
 * Follows the stream until the returned function is called, reconnecting when
 * it drops. `onStatus` reports whether the stream is currently open, so the page
 * can show it is live. Events missed while disconnected are gone; the page only
 * draws the present.
 */
export function subscribeActivity(
  onEvent: (event: ActivityEvent) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  const controller = new AbortController();
  const signal = controller.signal;

  void (async () => {
    while (!signal.aborted) {
      try {
        for await (const data of streamSSE("/api/activity/stream", { signal })) {
          let frame: ActivityFrame;
          try {
            frame = JSON.parse(data) as ActivityFrame;
          } catch (e) {
            console.warn("[activity] dropped unparseable stream frame:", e);
            continue;
          }
          // The stream opens with a ping, so the first frame of either kind means it is live.
          onStatus(true);
          if (frame.type === "event") onEvent(frame.event);
        }
      } catch (e) {
        if (!signal.aborted) console.warn("[activity] stream dropped, reconnecting:", e);
      }
      if (signal.aborted) break;
      onStatus(false);
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
    }
  })();

  return () => controller.abort();
}
