import { useCallback, useState } from "react";
import { listSpecialists, type Specialist } from "../lib/agents";
import { useCachedResource } from "../lib/resourceCache";
import {
  createScheduledJob,
  deleteScheduledJob,
  emptyJobInput,
  jobInputFrom,
  listScheduledJobRuns,
  listScheduledJobs,
  runScheduledJob,
  type ScheduledJobInput,
  type ScheduledJobRun,
  type ScheduledJobStatus,
  updateScheduledJob,
} from "../lib/scheduledJobs";
import JobEditor from "./jobs/JobEditor";
import JobRunList from "./jobs/JobRunList";
import RefreshingIndicator from "./RefreshingIndicator";

/**
 * Scheduled agent jobs: the user's own prompts, on a cron schedule, run by
 * either the in-app assistant or a headless Claude Code session.
 *
 * A panel rather than a Settings section because the history is the point. The
 * jobs the app ships as code are configuration — is the nightly digest running —
 * and stay in Settings; these produce output the user comes back to read.
 */

const JOBS_KEY = "jobs:agent-jobs";
const runsKey = (id: string) => `jobs:agent-jobs:${id}:runs`;

const NO_JOBS: ScheduledJobStatus[] = [];
const NO_RUNS: ScheduledJobRun[] = [];
const NO_SPECIALISTS: Specialist[] = [];

function describeNext(status: ScheduledJobStatus): string {
  if (!status.cronValid) return "schedule not understood";
  if (!status.job.enabled) return "paused";
  if (!status.nextRunAt) return "no further runs";
  return `next ${new Date(status.nextRunAt).toLocaleString()}`;
}

export default function ScheduledJobsPanel() {
  const jobsRes = useCachedResource<ScheduledJobStatus[]>(JOBS_KEY, listScheduledJobs);
  const specialistsRes = useCachedResource<Specialist[]>("jobs:specialists", async () =>
    (await listSpecialists()).specialists.filter((s) => s.enabled),
  );
  const jobs = jobsRes.data ?? NO_JOBS;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduledJobInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);

  const runsRes = useCachedResource<ScheduledJobRun[]>(
    selectedId ? runsKey(selectedId) : null,
    // The key is null whenever there is no selection, so the loader only runs
    // with one — but it closes over the state, not the key, hence the guard.
    async () => (selectedId ? listScheduledJobRuns(selectedId) : []),
  );

  // `refresh` invalidates its own key first, so there is nothing to clear here.
  const reloadJobs = useCallback(() => jobsRes.refresh(), [jobsRes]);

  const select = (status: ScheduledJobStatus) => {
    setSelectedId(status.job.id);
    setDraft(jobInputFrom(status.job));
    setError(null);
    setRunNotice(null);
  };

  const startNew = () => {
    setSelectedId(null);
    setDraft(emptyJobInput());
    setError(null);
    setRunNotice(null);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const saved = selectedId
        ? await updateScheduledJob(selectedId, draft)
        : await createScheduledJob(draft);
      setSelectedId(saved.id);
      setDraft(jobInputFrom(saved));
      await reloadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    try {
      await deleteScheduledJob(selectedId);
      setSelectedId(null);
      setDraft(null);
      await reloadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Runs to completion before answering, so the history below is already
  // up to date when the notice appears.
  const runNow = async (id: string) => {
    setRunNotice("Running…");
    try {
      const outcome = await runScheduledJob(id);
      setRunNotice(
        outcome.status === "busy"
          ? "Already running."
          : outcome.status === "error"
            ? `Failed: ${outcome.detail ?? "no detail"}`
            : "Finished.",
      );
      await Promise.all([runsRes.refresh(), reloadJobs()]);
    } catch (e) {
      setRunNotice(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">Jobs</h2>
          <RefreshingIndicator active={jobsRes.refreshing} />
          <button
            type="button"
            className="ml-auto rounded-lg border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-600"
            onClick={startNew}
          >
            New job
          </button>
        </div>
        {jobsRes.error ? <p className="text-sm text-red-400">{jobsRes.error}</p> : null}
        {jobs.length === 0 && !jobsRes.loading ? (
          <p className="text-sm text-zinc-500">
            No scheduled jobs yet. A job is a prompt, a schedule, and the agent that runs it.
          </p>
        ) : null}
        <ul className="space-y-2">
          {jobs.map((status) => (
            <li key={status.job.id}>
              <button
                type="button"
                className={`w-full rounded-xl border px-3 py-2 text-left ${
                  status.job.id === selectedId
                    ? "border-indigo-700 bg-indigo-950/30"
                    : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
                }`}
                onClick={() => select(status)}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-zinc-100">{status.job.name}</span>
                  {status.running ? (
                    <span className="text-xs text-amber-400">running</span>
                  ) : status.lastRun ? (
                    <span
                      className={`text-xs ${
                        status.lastRun.status === "error" ? "text-red-400" : "text-emerald-400"
                      }`}
                    >
                      {status.lastRun.status}
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
                  <span>{status.job.target.kind === "yarvis" ? "Yarvis" : "Claude Code"}</span>
                  <span>·</span>
                  <span className="truncate">{describeNext(status)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-4">
        {draft ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
            <JobEditor
              key={selectedId ?? "new"}
              value={draft}
              specialists={specialistsRes.data ?? NO_SPECIALISTS}
              savedId={selectedId}
              saving={saving}
              error={error}
              onChange={setDraft}
              onSave={save}
              onCancel={() => {
                setDraft(null);
                setSelectedId(null);
              }}
              onDelete={remove}
            />
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Pick a job to see its runs, or create one.</p>
        )}

        {selectedId ? (
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                Run history
              </h2>
              <RefreshingIndicator active={runsRes.refreshing} />
              <button
                type="button"
                className="ml-auto rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 hover:bg-zinc-700"
                onClick={() => runNow(selectedId)}
              >
                Run now
              </button>
            </div>
            {runNotice ? <p className="text-sm text-zinc-400">{runNotice}</p> : null}
            {runsRes.error ? <p className="text-sm text-red-400">{runsRes.error}</p> : null}
            <JobRunList runs={runsRes.data ?? NO_RUNS} />
          </div>
        ) : null}
      </section>
    </div>
  );
}
