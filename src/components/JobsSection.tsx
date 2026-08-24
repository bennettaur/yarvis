import { useCallback, useEffect, useState } from "react";
import { type JobStatus, listJobs, runJob } from "../lib/agents";

/**
 * The background jobs that turn activity into memory. Worth surfacing because
 * their output is what the assistant recalls later: if the nightly digest has
 * been failing, the symptom is an assistant that seems to have forgotten a
 * week, and nothing else in the app would say why.
 */

function describeSchedule(schedule: JobStatus["schedule"]): string {
  return schedule.kind === "interval"
    ? `every ${Math.round(schedule.everyMs / 3_600_000)}h`
    : `daily around ${String(schedule.hour).padStart(2, "0")}:00`;
}

const STATUS_COLOR: Record<string, string> = {
  ok: "text-emerald-400",
  skipped: "text-zinc-500",
  error: "text-red-400",
};

export default function JobsSection() {
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setJobs(await listJobs());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const trigger = async (name: string) => {
    setBusy(name);
    setOutcome(null);
    try {
      const result = await runJob(name);
      setOutcome(`${name}: ${result.status}${result.detail ? ` — ${result.detail}` : ""}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Background jobs
      </h2>
      <p className="mb-3 text-sm text-zinc-500">
        These fold the activity log and your Claude Code sessions into memory. Running one by hand
        does exactly what the schedule would.
      </p>

      <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
        {jobs.map((job) => (
          <li key={job.name} className="px-4 py-3">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-sm text-zinc-200">{job.name}</span>
              <span className="text-xs text-zinc-600">{describeSchedule(job.schedule)}</span>
              {job.running && <span className="text-xs text-indigo-300">running</span>}
              {!job.running && job.due && <span className="text-xs text-amber-300">due</span>}
              <button
                type="button"
                disabled={busy === job.name || job.running}
                onClick={() => void trigger(job.name)}
                className="ml-auto rounded-md border border-zinc-700 px-2 py-0.5 text-xs hover:bg-zinc-800 disabled:opacity-40"
              >
                {busy === job.name ? "Running…" : "Run now"}
              </button>
            </div>
            <p className="mt-1 text-sm text-zinc-400">{job.description}</p>
            <p className="mt-0.5 text-xs text-zinc-600">
              {job.lastFinishedAt ? (
                <>
                  last run {new Date(job.lastFinishedAt).toLocaleString()} ·{" "}
                  <span className={STATUS_COLOR[job.lastStatus ?? ""] ?? "text-zinc-500"}>
                    {job.lastStatus}
                  </span>
                </>
              ) : (
                "never run"
              )}
            </p>
            {job.lastError && <p className="mt-0.5 text-xs text-red-400">{job.lastError}</p>}
          </li>
        ))}
      </ul>

      {jobs.length === 0 && <p className="text-sm text-zinc-600">No jobs registered.</p>}
      {outcome && <p className="mt-2 text-sm text-zinc-500">{outcome}</p>}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
