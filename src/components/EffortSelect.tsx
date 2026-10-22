import {
  EFFORT_HINT,
  EFFORT_LABELS,
  isReasoningEffort,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "../lib/effort";

/** The effort picker shown beside a model picker when the chosen model takes one. */
export default function EffortSelect({
  value,
  onChange,
  ariaLabel = "Effort",
  className = "rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm",
}: {
  value: ReasoningEffort | undefined;
  onChange: (value: ReasoningEffort | undefined) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <select
      title={EFFORT_HINT}
      aria-label={ariaLabel}
      value={value ?? ""}
      onChange={(e) => onChange(isReasoningEffort(e.target.value) ? e.target.value : undefined)}
      className={className}
    >
      <option value="">Default effort</option>
      {REASONING_EFFORTS.map((level) => (
        <option key={level} value={level}>
          {EFFORT_LABELS[level]} effort
        </option>
      ))}
    </select>
  );
}
