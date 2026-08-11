import { useAlarmTakeoverQueue } from "../lib/alarmStore";
import AlarmOverlay from "./AlarmOverlay";

/**
 * Drives the full-screen takeover from the alarm store's queue. Several alarms
 * set for the same time all fire in one scheduler tick, so they are shown one
 * at a time, oldest first — the store drops each as it's acknowledged, snoozed,
 * or cancelled, and the next one takes the screen.
 *
 * Reads the takeover queue rather than the ringing list: an alarm left unhandled
 * by a previous run is still worth listing on the alarms page, but must not
 * hijack the screen at launch.
 */
export default function AlarmTakeover() {
  const queue = useAlarmTakeoverQueue();
  const active = queue[0];
  if (!active) return null;

  // Keyed so advancing to the next alarm remounts the overlay and its
  // "overdue by" timer restarts against that alarm's own fire time.
  return <AlarmOverlay key={active.id} alarm={active} remaining={queue.length - 1} />;
}
