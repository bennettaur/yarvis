const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

/**
 * Formats an ISO timestamp as a relative phrase like "3 days ago" or
 * "in 2 hours", matching how GitHub labels PR dates. Returns "" for missing or
 * unparseable input so callers can skip rendering.
 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return "";

  let duration = (ms - Date.now()) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return "";
}
