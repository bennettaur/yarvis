import { useState } from "react";
import { runDurationMs, type ScheduledJobRun } from "../../lib/scheduledJobs";

/**
 * A job's run history, newest first, with each run's output behind its row.
 *
 * The output is the reason the history is kept — "did it work" is answered by
 * the status, but "what did it say" is the thing the user came for — so a row
 * expands in place rather than opening anything.
 */

const STATUS_COLOR: Record<ScheduledJobRun["status"], string> = {
  ok: "text-emerald-400",
  error: "text-red-400",
  running: "text-amber-400",
};

function describeDuration(run: ScheduledJobRun): string {
  const ms = runDurationMs(run);
  if (ms === null) return "running";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function RunRow({ run }: { run: ScheduledJobRun }) {
  const [open, setOpen] = useState(false);
  const body = run.error ?? run.output ?? "";

  return (
    <li className="border-b border-zinc-900 last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-zinc-900/60"
        onClick={() => setOpen(!open)}
      >
        <span className={`w-14 shrink-0 font-medium ${STATUS_COLOR[run.status]}`}>
          {run.status}
        </span>
        <span className="text-zinc-300">{new Date(run.startedAt).toLocaleString()}</span>
        <span className="text-xs text-zinc-600">{run.trigger}</span>
        <span className="ml-auto text-xs text-zinc-600">{describeDuration(run)}</span>
      </button>
      {open ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words bg-zinc-950 px-3 py-2 text-xs text-zinc-300">
          {body || "No output."}
        </pre>
      ) : null}
    </li>
  );
}

export default function JobRunList({ runs }: { runs: ScheduledJobRun[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-zinc-500">This job hasn't run yet.</p>;
  }
  return (
    <ul className="divide-y divide-zinc-900 rounded-lg border border-zinc-800">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} />
      ))}
    </ul>
  );
}
