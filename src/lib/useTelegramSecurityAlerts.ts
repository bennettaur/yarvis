import { useEffect, useRef } from "react";
import { notify } from "./notify";
import { getSecurityEvents, type TelegramSecurityEvent } from "./telegram";

/** How often to check for new Telegram auth events. */
const POLL_MS = 15_000;

/** Maps an event to a notification, or null for events we don't surface. */
export function describeSecurityEvent(
  event: TelegramSecurityEvent,
): { title: string; body: string } | null {
  switch (event.type) {
    case "unlock":
      return { title: "Telegram unlocked", body: "A Telegram chat unlocked Yarvis." };
    case "lockout":
      return {
        title: "Telegram locked out",
        body: "Too many failed unlock attempts on Telegram.",
      };
    case "failed":
      return {
        title: "Telegram unlock failed",
        body: "An invalid unlock code was submitted on Telegram.",
      };
    default:
      // "lock" is a deliberate user action; no alert needed.
      return null;
  }
}

/**
 * Polls the sidecar for Telegram auth activity and raises an OS notification for
 * unlock/failed/lockout events, so the user is aware of remote-access attempts
 * they didn't initiate. The first poll primes the sequence cursor without
 * notifying, so opening the app doesn't replay history. A monotonic sequence
 * (not a timestamp) is the cursor, so same-millisecond events aren't dropped.
 * Intended to be mounted once, app-wide.
 */
export function useTelegramSecurityAlerts(): void {
  const lastSeqRef = useRef(0);
  const primedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const events = await getSecurityEvents(lastSeqRef.current);
        for (const event of events) {
          lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
        }
        // The first successful poll only establishes the cursor; events that
        // predate mounting are history, not new activity to alert on.
        if (!primedRef.current) {
          primedRef.current = true;
        } else {
          for (const event of events) {
            const message = describeSecurityEvent(event);
            if (message) await notify(message.title, message.body);
          }
        }
      } catch {
        // Sidecar not ready or Telegram not configured — retry next tick.
      }
      if (!cancelled) timer = setTimeout(() => void tick(), POLL_MS);
    };

    // Prime immediately so activity in the first interval isn't missed.
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
}
