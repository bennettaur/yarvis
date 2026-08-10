import { EXPAND_STEP, type Gap } from "../../lib/pr/expand";

/**
 * The clickable stand-in for code a patch left out.
 *
 * The two arrows are read relative to the marker itself: "above" reveals the
 * lines that will appear directly over it, "below" the ones directly under. The
 * count in the middle opens the whole stretch at once.
 */
export default function GapMarker({
  gap,
  hidden,
  onExpand,
  onExpandFully,
  className = "",
}: {
  gap: Gap;
  hidden: number;
  onExpand: (gap: Gap, edge: "top" | "bottom") => void;
  onExpandFully: (gap: Gap) => void;
  className?: string;
}) {
  const step = Math.min(EXPAND_STEP, hidden);
  // With less than a step left there is only one thing to do, so a single
  // control saves the reader from picking an end that makes no difference.
  const splittable = hidden > step;

  return (
    <div
      className={`flex items-center gap-2 border-y border-zinc-800/60 bg-zinc-900/40 px-2 py-0.5 text-zinc-500 ${className}`}
    >
      {splittable && (
        <button
          type="button"
          onClick={() => onExpand(gap, "top")}
          title={`Show ${step} more lines above`}
          aria-label={`Show ${step} more lines above`}
          className="px-1 hover:text-zinc-200"
        >
          ↑
        </button>
      )}
      <button
        type="button"
        onClick={() => onExpandFully(gap)}
        title={`Show all ${hidden} hidden lines`}
        className="font-sans text-[11px] hover:text-zinc-200"
      >
        ⋯ {hidden} {hidden === 1 ? "line" : "lines"}
      </button>
      {splittable && (
        <button
          type="button"
          onClick={() => onExpand(gap, "bottom")}
          title={`Show ${step} more lines below`}
          aria-label={`Show ${step} more lines below`}
          className="px-1 hover:text-zinc-200"
        >
          ↓
        </button>
      )}
    </div>
  );
}
