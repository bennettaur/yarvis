/** What heads-down mode is doing right now. */
export type AgentState = "working" | "sleeping" | "off";

const LABEL: Record<AgentState, string> = {
  working: "Heads down is working",
  sleeping: "Heads down is sleeping",
  off: "Heads down is off",
};

/**
 * The Yarvis logo, showing at a glance whether heads-down mode is working,
 * sleeping between passes, or off. Working spins a ring around it, sleeping
 * dims it, off greys it out.
 */
export default function AgentMark({
  state,
  className = "h-10 w-10",
}: {
  state: AgentState;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={LABEL[state]}
      title={LABEL[state]}
      data-state={state}
      className={`relative inline-flex shrink-0 items-center justify-center ${className}`}
    >
      {state === "working" && (
        <span
          aria-hidden
          className="absolute -inset-1 animate-spin rounded-xl bg-[conic-gradient(from_0deg,#22d3ee,#a855f7,transparent_70%,#22d3ee)] [animation-duration:2.5s] motion-reduce:animate-none"
        />
      )}
      <img
        src="/yarvis-logo.png"
        alt=""
        className={`relative h-full w-full rounded-lg transition duration-500 ${
          state === "working"
            ? ""
            : state === "sleeping"
              ? "opacity-60 saturate-50"
              : "opacity-40 grayscale"
        }`}
      />
      {state === "sleeping" && (
        <span
          aria-hidden
          className="absolute -right-1.5 -top-2 text-xs font-semibold text-indigo-300"
        >
          z<sup>z</sup>
        </span>
      )}
    </span>
  );
}
