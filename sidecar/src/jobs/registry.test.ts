import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { type AgentJobInput, createAgentJob, jobSchedulerName } from "./agentJobs.ts";
import { allJobs, allJobsWithAgentJobs, findAnyJob } from "./registry.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

const input = (over: Partial<AgentJobInput> = {}): AgentJobInput => ({
  name: "morning sweep",
  description: null,
  cron: "0 9 * * *",
  prompt: "summarize what is waiting for me",
  enabled: true,
  target: { kind: "yarvis", specialist: null },
  ...over,
});

beforeEach(async () => {
  await sql`TRUNCATE scheduled_jobs, scheduled_job_runs, job_runs RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("what a tick considers", () => {
  it("adds the user's jobs to the ones that ship as code", async () => {
    const job = await createAgentJob(db, input());
    const names = (await allJobsWithAgentJobs(db)).map((j) => j.name);
    expect(names).toContain("consolidate-events");
    expect(names).toContain(jobSchedulerName(job.id));
  });

  it("leaves a paused job out", async () => {
    const paused = await createAgentJob(db, input({ name: "paused", enabled: false }));
    const names = (await allJobsWithAgentJobs(db)).map((j) => j.name);
    expect(names).not.toContain(jobSchedulerName(paused.id));
    expect(names).toEqual(allJobs().map((j) => j.name));
  });
});

describe("resolving a job by name", () => {
  it("resolves a paused job, so it can still be tried by hand", async () => {
    const paused = await createAgentJob(db, input({ enabled: false }));
    expect(await findAnyJob(db, jobSchedulerName(paused.id))).toBeDefined();
  });

  it("still resolves the jobs that ship as code", async () => {
    expect(await findAnyJob(db, "consolidate-events")).toBeDefined();
  });

  it("has nothing for a name that is neither", async () => {
    expect(await findAnyJob(db, "agent-job:00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(await findAnyJob(db, "not-a-job")).toBeUndefined();
  });
});
