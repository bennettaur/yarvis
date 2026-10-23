import { useEffect, useRef, useState } from "react";
import type { ToolActivity } from "../../lib/chat";
import { type PassEvent, streamHeadsDown } from "../../lib/headsDown";

/** What the pass in flight has done so far, built from its streamed events. */
export interface LivePass {
  passId: string;
  activity: ToolActivity[];
  /** The latest stretch of reasoning: what it thought before its last call or reply. */
  thought: string;
  /** Reasoning is still streaming into `thought`; the next stretch replaces it. */
  thinking: boolean;
  text: string;
  /** The provider error the turn just hit; the pass may be about to try again. */
  error: string | null;
}

export function newLivePass(passId: string): LivePass {
  return { passId, activity: [], thought: "", thinking: false, text: "", error: null };
}

/** Folds one streamed event into the live pass. */
export function applyPassEvent(live: LivePass, event: PassEvent): LivePass {
  switch (event.type) {
    case "delta":
      return { ...live, text: live.text + event.text, thinking: false, error: null };
    case "reasoning":
      return {
        ...live,
        thought: live.thinking ? live.thought + event.text : event.text,
        thinking: true,
        error: null,
      };
    case "error":
      return { ...live, thinking: false, error: event.message };
    case "tool_call":
      return {
        ...live,
        thinking: false,
        error: null,
        activity: [
          ...live.activity,
          {
            id: event.id,
            name: event.name,
            server: event.server,
            args: event.args,
            status: "pending",
          },
        ],
      };
    case "tool_result":
      return {
        ...live,
        activity: live.activity.map((a) =>
          a.id === event.id
            ? { ...a, status: event.status, result: event.result, durationMs: event.durationMs }
            : a,
        ),
      };
    default:
      return live;
  }
}

/** How long to wait before reconnecting a dropped stream. */
const RECONNECT_MS = 5_000;

/**
 * Follows heads-down mode live: the pass in flight, and a call to `onChanged`
 * whenever something the page lists may have changed. Reconnects on its own,
 * re-reading the lists each time, since the stream doesn't replay what it missed.
 */
export function useLivePass(onChanged: () => void): LivePass | null {
  const [live, setLive] = useState<LivePass | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      // A pass that finished while the stream was down sent its pass-finished
      // to nobody, so what was live is re-read from the lists instead.
      setLive(null);
      try {
        onChangedRef.current();
        for await (const event of streamHeadsDown(controller.signal)) {
          if (event.type === "pass-started") {
            setLive(newLivePass(event.passId));
          } else if (event.type === "pass-event") {
            setLive((current) =>
              current && current.passId === event.passId
                ? applyPassEvent(current, event.event)
                : current,
            );
          } else if (event.type === "pass-finished") {
            setLive(null);
            onChangedRef.current();
          } else if (event.type === "changed") {
            onChangedRef.current();
          }
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        console.warn("[heads-down] stream dropped, reconnecting:", e);
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void connect(), RECONNECT_MS);
    };

    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  return live;
}
