import { describe, expect, it } from "bun:test";
import {
  emptyJobInput,
  jobInputFrom,
  runDurationMs,
  type ScheduledJob,
  type ScheduledJobRun,
} from "./scheduledJobs";

const job: ScheduledJob = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Morning sweep",
  description: null,
  cron: "0 9 * * 1-5",
  prompt: "summarize what is waiting for me",
  enabled: true,
  target: { kind: "yarvis", specialist: "planner" },
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:00:00.000Z",
};

const run = (over: Partial<ScheduledJobRun> = {}): ScheduledJobRun => ({
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  jobId: job.id,
  trigger: "schedule",
  status: "ok",
  output: "done",
  error: null,
  startedAt: "2026-09-21T09:00:00.000Z",
  finishedAt: "2026-09-21T09:00:12.000Z",
  ...over,
});

describe("editing a job", () => {
  it("carries a saved job's fields into the form", () => {
    expect(jobInputFrom(job)).toEqual({
      name: job.name,
      description: null,
      cron: job.cron,
      prompt: job.prompt,
      enabled: job.enabled,
      target: job.target,
    });
  });

  it("starts a new job on the in-app agent, enabled, with nothing to say yet", () => {
    const blank = emptyJobInput();
    expect(blank.target).toEqual({ kind: "yarvis", specialist: null });
    expect(blank.prompt).toBe("");
    expect(blank.enabled).toBe(true);
  });
});

describe("how long a run took", () => {
  it("measures a finished run", () => {
    expect(runDurationMs(run())).toBe(12_000);
  });

  it("has no duration while the run is still going", () => {
    expect(runDurationMs(run({ finishedAt: null, status: "running" }))).toBeNull();
  });
});
