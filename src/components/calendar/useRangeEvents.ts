import { useEffect, useState } from "react";
import { calEventsRange, type CalendarEvent } from "../../lib/calendar";

/**
 * A Date that re-renders on an interval, for the "now" line and time-based
 * scrolling. Defaults to a 30s tick — fine for a minute-resolution marker.
 */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Loads the events whose start falls within [rangeStart, rangeEnd) for the grid
 * views. Re-fetches whenever the range moves (the caller passes new Date bounds
 * when navigating weeks/months/days).
 */
export function useRangeEvents(rangeStart: Date, rangeEnd: Date) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const startIso = rangeStart.toISOString();
  const endIso = rangeEnd.toISOString();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    calEventsRange(startIso, endIso)
      .then((evts) => {
        if (cancelled) return;
        setEvents(evts);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [startIso, endIso]);

  return { events, error, loading };
}
