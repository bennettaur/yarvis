import type { ReviewStream as ReviewStreamData } from "../../lib/reviewPrep";
import { formatRelativeTime } from "../../lib/time";
import RiskBadge from "../attention/RiskBadge";

const STATE_LABEL: Record<string, string> = {
  queued: "waiting for a check slot",
  verifying: "being verified",
  ready: "ready for review",
  "needs-go-ahead": "needs your go-ahead",
};

/** The PRs review prep has ready or is preparing, and the queue behind them. */
export default function ReviewStream({ data }: { data: ReviewStreamData }) {
  const { maxReady, slots, queue } = data;
  return (
    <div className="space-y-2 text-sm">
      <p className="text-zinc-300">
        {slots.length} of {maxReady} prepared
        {slots.length > maxReady ? " (a stack went over)" : ""}
        {" · "}
        {queue.length} queued
      </p>
      {slots.length > 0 && (
        <ul className="space-y-1">
          {slots.map((slot) => (
            <li key={slot.pr} className="flex items-center gap-2 text-xs text-zinc-400">
              <span className="font-mono text-zinc-200">{slot.pr}</span>
              <span>{STATE_LABEL[slot.state] ?? slot.state}</span>
              {slot.risk && <RiskBadge risk={slot.risk} />}
            </li>
          ))}
        </ul>
      )}
      {queue.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-200">
            Queue, next first
          </summary>
          <ol className="mt-1 space-y-1">
            {queue.map((item) => (
              <li key={item.pr} className="flex items-center gap-2 text-xs text-zinc-400">
                <span className="font-mono text-zinc-200">{item.pr}</span>
                {item.queuedAt && <span>queued {formatRelativeTime(item.queuedAt)}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
