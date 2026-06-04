import type { CalendarEvent } from "../../lib/calendar";
import { isArmable } from "../../lib/calendarAlarms";

/** A small bell glyph, filled when an alarm is set. */
function Bell({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.4"
      role="img"
    >
      <title>{filled ? "Alarm set" : "Set alarm"}</title>
      <path d="M8 2a3 3 0 0 0-3 3v2.5c0 .7-.3 1.4-.8 1.9L3 11h10l-1.2-1.6c-.5-.5-.8-1.2-.8-1.9V5a3 3 0 0 0-3-3Z" />
      <path d="M6.5 13a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

/**
 * The shared alarm control for a calendar event. Renders nothing for events
 * that can't be armed (all-day or already past). Otherwise shows whether an
 * alarm is set and lets the user set one. `compact` renders an icon-only toggle
 * for dense layouts like the month grid; the default shows a labelled control.
 */
export default function EventAlarmButton({
  event,
  armed,
  onArm,
  compact = false,
}: {
  event: CalendarEvent;
  armed: boolean;
  onArm: (event: CalendarEvent) => void;
  compact?: boolean;
}) {
  if (!isArmable(event)) return null;

  const arm = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    if (!armed) onArm(event);
  };

  if (compact) {
    return (
      <button
        onClick={arm}
        disabled={armed}
        title={armed ? "Alarm set" : "Set alarm"}
        className={`shrink-0 ${armed ? "text-emerald-400" : "text-zinc-500 hover:text-zinc-200"}`}
      >
        <Bell filled={armed} />
      </button>
    );
  }

  return armed ? (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
      <Bell filled /> alarm set
    </span>
  ) : (
    <button
      onClick={arm}
      className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
    >
      <Bell filled={false} /> Set alarm
    </button>
  );
}
