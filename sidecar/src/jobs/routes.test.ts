import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { jobSchedulerName } from "./agentJobs.ts";
import { claimJob } from "./store.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "morning sweep",
    cron: "0 9 * * *",
    prompt: "summarize what is waiting for me",
    enabled: true,
    target: { kind: "yarvis", specialist: null },
    ...over,
  });

/** Creates a job through the API and answers with its id. */
async function create(over: Record<string, unknown> = {}): Promise<string> {
  const res = await app.request("/api/jobs/agent-jobs", {
    method: "POST",
    headers: jsonAuth,
    body: body(over),
  });
  expect(res.status).toBe(201);
  const { job } = (await res.json()) as { job: { id: string } };
  return job.id;
}

beforeEach(async () => {
  await sql`TRUNCATE scheduled_jobs, scheduled_job_runs, job_runs RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("scheduled agent job routes", () => {
  it("requires authentication", async () => {
    expect((await app.request("/api/jobs/agent-jobs")).status).toBe(401);
  });

  it("creates a job and lists it with its next firing", async () => {
    await create();
    const res = await app.request("/api/jobs/agent-jobs", { headers: auth });
    const { jobs } = (await res.json()) as {
      jobs: { job: { name: string }; nextRunAt: string | null; cronValid: boolean }[];
    };
    expect(jobs).toHaveLength(1);
    expect(jobs[0].job.name).toBe("morning sweep");
    expect(jobs[0].cronValid).toBe(true);
    expect(jobs[0].nextRunAt).not.toBeNull();
  });

  it("refuses a schedule the runner could not honor", async () => {
    const res = await app.request("/api/jobs/agent-jobs", {
      method: "POST",
      headers: jsonAuth,
      body: body({ cron: "every other tuesday" }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses an unknown agent backend", async () => {
    const res = await app.request("/api/jobs/agent-jobs", {
      method: "POST",
      headers: jsonAuth,
      body: body({ target: { kind: "somebody-elses-agent", cwd: "/tmp" } }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a Claude Code job with no working directory", async () => {
    const res = await app.request("/api/jobs/agent-jobs", {
      method: "POST",
      headers: jsonAuth,
      body: body({ target: { kind: "claude-code", cwd: "" } }),
    });
    expect(res.status).toBe(400);
  });

  it("updates a job", async () => {
    const id = await create();
    const res = await app.request(`/api/jobs/agent-jobs/${id}`, {
      method: "PUT",
      headers: jsonAuth,
      body: body({ name: "evening sweep", enabled: false }),
    });
    expect(res.status).toBe(200);
    const { job } = (await res.json()) as { job: { name: string; enabled: boolean } };
    expect(job.name).toBe("evening sweep");
    expect(job.enabled).toBe(false);
  });

  it("deletes a job", async () => {
    const id = await create();
    expect(
      (await app.request(`/api/jobs/agent-jobs/${id}`, { method: "DELETE", headers: auth })).status,
    ).toBe(200);
    const res = await app.request("/api/jobs/agent-jobs", { headers: auth });
    const { jobs } = (await res.json()) as { jobs: unknown[] };
    expect(jobs).toHaveLength(0);
  });

  it("answers 404 for a job that isn't there", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    expect(
      (await app.request(`/api/jobs/agent-jobs/${missing}/runs`, { headers: auth })).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/jobs/agent-jobs/${missing}/run`, { method: "POST", headers: auth }))
        .status,
    ).toBe(404);
  });

  it("records a run and serves its history", async () => {
    const id = await create();
    // No provider is configured in this suite, so the run fails — which is the
    // path worth checking here: the history has to hold a failure as readably as
    // a success, since that is what a user comes to the panel to find out.
    const run = await app.request(`/api/jobs/agent-jobs/${id}/run`, {
      method: "POST",
      headers: auth,
    });
    expect(run.status).toBe(200);
    const outcome = (await run.json()) as { status: string };
    expect(outcome.status).toBe("error");

    const history = await app.request(`/api/jobs/agent-jobs/${id}/runs`, { headers: auth });
    const { runs } = (await history.json()) as {
      runs: { id: string; status: string; trigger: string; error: string | null }[];
    };
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("error");
    expect(runs[0].trigger).toBe("manual");
    expect(runs[0].error).toBeTruthy();
  });

  it("refuses a second job with the same name rather than failing on the index", async () => {
    await create();
    const res = await app.request("/api/jobs/agent-jobs", {
      method: "POST",
      headers: jsonAuth,
      body: body(),
    });
    expect(res.status).toBe(409);
  });

  it("answers 400, not 500, for an id that isn't a uuid", async () => {
    for (const path of ["/api/jobs/agent-jobs/nope/runs", "/api/jobs/agent-jobs/nope"]) {
      const res = await app.request(path, { headers: auth });
      // The list route is a GET; the others are checked by method below.
      if (res.status !== 404) expect(res.status).toBe(400);
    }
    const del = await app.request("/api/jobs/agent-jobs/nope", { method: "DELETE", headers: auth });
    expect(del.status).toBe(400);
    const run = await app.request("/api/jobs/agent-jobs/nope/run", {
      method: "POST",
      headers: auth,
    });
    expect(run.status).toBe(400);
  });

  it("refuses a model that would read as another flag", async () => {
    const res = await app.request("/api/jobs/agent-jobs", {
      method: "POST",
      headers: jsonAuth,
      body: body({
        target: { kind: "claude-code", cwd: "/tmp", model: "--dangerously-skip-permissions" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("runs a paused job on demand, since trying one before scheduling it is the point", async () => {
    const id = await create({ name: "paused sweep", enabled: false });
    const res = await app.request(`/api/jobs/agent-jobs/${id}/run`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const history = await app.request(`/api/jobs/agent-jobs/${id}/runs`, { headers: auth });
    const { runs } = (await history.json()) as { runs: unknown[] };
    expect(runs).toHaveLength(1);
  });

  it("answers 409 while a copy of the job is already running", async () => {
    const id = await create();
    await claimJob(getDb(url).db, jobSchedulerName(id));
    const res = await app.request(`/api/jobs/agent-jobs/${id}/run`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(409);
  });

  it("still lists the jobs this repo ships as code", async () => {
    const res = await app.request("/api/jobs", { headers: auth });
    const { jobs } = (await res.json()) as { jobs: { name: string }[] };
    expect(jobs.some((job) => job.name === "consolidate-events")).toBe(true);
  });
});
