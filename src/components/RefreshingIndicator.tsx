/**
 * Says a list on screen is being brought up to date behind the reader. Shown
 * only while there is already data to read — a cold load has its own empty or
 * "Loading…" state, and labelling that as a *re*fresh would be a lie.
 */
export default function RefreshingIndicator({
  active,
  label = "Refreshing…",
}: {
  active: boolean;
  label?: string;
}) {
  if (!active) return null;
  return (
    <span role="status" aria-live="polite" className="animate-pulse text-xs text-indigo-300">
      {label}
    </span>
  );
}
