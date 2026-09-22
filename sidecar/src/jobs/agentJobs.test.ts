import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import {
  type AgentJob,
  type AgentJobInput,
  agentJobStatuses,
  createAgentJob,
  deleteAgentJob,
  failStaleRuns,
  jobSchedulerName,
  listAgentJobRuns,
  listAgentJobs,
  pruneAgentJobRuns,
  startAgentJobRun,
  toJobDefinition,
  truncateOutput,
  updateAgentJob,
} from "./agentJobs.ts";
import type { AgentJobRunner, RunnerSet } from "./runners.ts";
import { runJob } from "./scheduler.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });
const config = { databaseUrl: url, secrets: {} } as Config;

/** Runners that answer without touching a provider or a child process. */
function runners(yarvis: AgentJobRunner): RunnerSet {
  const unused: AgentJobRunner = async () => {
    throw new Error("the wrong runner was used");
  };
  return { yarvis, "claude-code": unused };
}

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

describe("storing a scheduled agent job", () => {
  it("round-trips a yarvis job", async () => {
    const job = await createAgentJob(
      db,
      input({ target: { kind: "yarvis", specialist: "planner" } }),
    );
    expect(job.target).toEqual({ kind: "yarvis", specialist: "planner" });
    expect((await listAgentJobs(db))[0].id).toBe(job.id);
  });

  it("round-trips a Claude Code job with its directory", async () => {
    const job = await createAgentJob(
      db,
      input({
        target: {
          kind: "claude-code",
          cwd: "/Users/me/dev/app",
          model: null,
          permissionMode: "plan",
        },
      }),
    );
    expect(job.target).toEqual({
      kind: "claude-code",
      cwd: "/Users/me/dev/app",
      model: null,
      permissionMode: "plan",
    });
  });

  it("changes a job's backend on update", async () => {
    const job = await createAgentJob(db, input());
    const updated = await updateAgentJob(
      db,
      job.id,
      input({
        target: { kind: "claude-code", cwd: "/tmp", model: "sonnet", permissionMode: null },
      }),
    );
    expect(updated?.target.kind).toBe("claude-code");
  });

  it("takes the job's runs with it when it is deleted", async () => {
    const job = await createAgentJob(db, input());
    await startAgentJobRun(db, job.id, "manual");
    expect(await deleteAgentJob(db, job.id)).toBe(true);
    expect(await listAgentJobRuns(db, job.id)).toHaveLength(0);
  });
});

describe("running a scheduled agent job", () => {
  async function run(job: AgentJob, runner: AgentJobRunner, trigger: "schedule" | "manual") {
    const definition = toJobDefinition(job, { runners: runners(runner) });
    return runJob(definition, config, db, new Date(), trigger);
  }

  it("records the agent's answer as the run's output", async () => {
    const job = await createAgentJob(db, input());
    const result = await run(job, async () => ({ output: "three PRs need review" }), "manual");

    expect(result.status).toBe("ok");
    const [stored] = await listAgentJobRuns(db, job.id);
    expect(stored.status).toBe("ok");
    expect(stored.output).toBe("three PRs need review");
    expect(stored.trigger).toBe("manual");
    expect(stored.finishedAt).not.toBeNull();
  });

  it("records a failure with the reason, and reports it to the scheduler", async () => {
    const job = await createAgentJob(db, input());
    const result = await run(
      job,
      async () => {
        throw new Error("no chat model is configured");
      },
      "schedule",
    );

    expect(result.status).toBe("error");
    const [stored] = await listAgentJobRuns(db, job.id);
    expect(stored.status).toBe("error");
    expect(stored.error).toContain("no chat model is configured");
  });

  it("refuses a second copy while one is already running", async () => {
    const job = await createAgentJob(db, input());
    const definition = toJobDefinition(job, {
      runners: runners(async () => ({ output: "done" })),
    });
    const slow = toJobDefinition(job, {
      runners: runners(async () => {
        await Bun.sleep(50);
        return { output: "done" };
      }),
    });

    const [first, second] = await Promise.all([
      runJob(slow, config, db, new Date(), "schedule"),
      Bun.sleep(5).then(() => runJob(definition, config, db, new Date(), "manual")),
    ]);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("busy");
  });

  it("hands the job's prompt and target to the runner", async () => {
    const job = await createAgentJob(db, input({ prompt: "check the release" }));
    let seen: { prompt: string; kind: string } | undefined;
    await run(
      job,
      async ({ prompt, target }) => {
        seen = { prompt, kind: target.kind };
        return { output: "" };
      },
      "schedule",
    );
    expect(seen).toEqual({ prompt: "check the release", kind: "yarvis" });
  });

  it("leases under the job's id, so renaming it keeps the same lease", async () => {
    const job = await createAgentJob(db, input());
    await run(job, async () => ({ output: "ok" }), "manual");
    const [lease] = await sql`select name from job_runs`;
    expect(lease.name).toBe(jobSchedulerName(job.id));
  });
});

describe("run history housekeeping", () => {
  it("closes a run left open by an app that stopped mid-run", async () => {
    const job = await createAgentJob(db, input());
    await startAgentJobRun(db, job.id, "schedule", new Date(Date.now() - 60 * 60 * 1000));
    expect(await failStaleRuns(db, job.id, new Date(Date.now() - 60_000))).toBe(1);
    const [stored] = await listAgentJobRuns(db, job.id);
    expect(stored.status).toBe("error");
  });

  it("keeps only the most recent runs", async () => {
    const job = await createAgentJob(db, input());
    for (let i = 0; i < 5; i++) {
      await startAgentJobRun(db, job.id, "schedule", new Date(Date.now() - i * 1_000));
    }
    await pruneAgentJobRuns(db, job.id, 2);
    expect(await listAgentJobRuns(db, job.id)).toHaveLength(2);
  });

  it("keeps both ends of an over-long answer", () => {
    const truncated = truncateOutput(`${"a".repeat(100)}${"b".repeat(100)}`, 20);
    expect(truncated.startsWith("aaaa")).toBe(true);
    expect(truncated.endsWith("bbbb")).toBe(true);
    expect(truncated).toContain("truncated");
  });
});

describe("what the panel is shown", () => {
  it("gives each job its next firing and last run", async () => {
    const job = await createAgentJob(db, input());
    await startAgentJobRun(db, job.id, "manual");
    const [status] = await agentJobStatuses(db);
    expect(status.cronValid).toBe(true);
    expect(status.nextRunAt).not.toBeNull();
    expect(status.running).toBe(true);
  });

  it("has no next firing for a disabled job", async () => {
    await createAgentJob(db, input({ enabled: false }));
    const [status] = await agentJobStatuses(db);
    expect(status.nextRunAt).toBeNull();
  });
});
