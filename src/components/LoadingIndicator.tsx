import { Spinner } from "./ThinkingIndicator";

/**
 * The placeholder for a surface with nothing to show yet: a spinner beside a
 * label naming what is loading. For data already on screen being brought up to
 * date, use `RefreshingIndicator` instead.
 */
export default function LoadingIndicator({
  label = "Loading…",
  className = "text-sm text-zinc-500",
}: {
  label?: string;
  /** Text size, color and any padding for where it sits. */
  className?: string;
}) {
  return (
    <div role="status" aria-live="polite" className={`flex items-center gap-2 ${className}`}>
      <Spinner />
      {label}
    </div>
  );
}
