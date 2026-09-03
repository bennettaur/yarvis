import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { recordEvent } from "../events/service.ts";
import { ccSessionDigestJob } from "./ccSessions.ts";
import { saveJobConfig } from "./config.ts";
import { consolidateEventsJob, dailyRollupJob } from "./consolidate.ts";
import { allJobs } from "./registry.ts";
import { everyHours } from "./schedule.ts";
import { jobStatuses, runJob, tick } from "./scheduler.ts";
import { claimJob, getJobRun } from "./store.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

/**
 * No provider keys, so any job that needs a model fails at resolution — which is
 * exactly the case worth pinning: a failed run must not consume its input.
 */
const config = {
  port: 0,
  token: "t",
  tokenGenerated: false,
  attentionToken: "a",
  mcpToken: "m",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
} as Config;

let settingsDir: string;

beforeEach(async () => {
  await sql`TRUNCATE job_runs, events, memories RESTART IDENTITY CASCADE`;
  // job_config now lives in ~/.yarvis/settings.json, not Postgres — point this
  // suite at an isolated file so it never touches the real one.
  settingsDir = await mkdtemp(join(tmpdir(), "yarvis-jobs-settings-"));
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterEach(async () => {
  await rm(settingsDir, { recursive: true, force: true });
});

afterAll(async () => {
  await sql.end();
});

describe("consolidate-events", () => {
  it("leaves every event unprocessed when the summary cannot be written", async () => {
    for (let i = 0; i < 5; i++) await recordEvent(db, { type: "pr.viewed" });

    const result = await runJob(consolidateEventsJob, config, db);
    expect(result.status).toBe("error");

    // The whole point: a run that produced no summary must not have consumed its
    // window, or that activity is lost with nothing to show for it.
    const [{ unprocessed }] = await sql`
      SELECT count(*)::int AS unprocessed FROM events WHERE processed_at IS NULL`;
    expect(unprocessed).toBe(5);
    expect((await sql`SELECT count(*)::int AS n FROM memories`)[0]!.n).toBe(0);
  });

  it("skips a window too thin to summarize, and consumes only its own bookkeeping", async () => {
    await recordEvent(db, { type: "pr.viewed" });
    await recordEvent(db, { type: "memory.consolidated" });
    await recordEvent(db, { type: "cc.session_summarized" });

    const result = await runJob(consolidateEventsJob, config, db);
    expect(result.status).toBe("skipped");

    // The two bookkeeping rows are claimed even on a skip: left unprocessed they
    // would eventually fill the window and wedge the job.
    const rows = await sql`SELECT type FROM events WHERE processed_at IS NULL`;
    expect(rows.map((r) => r.type)).toEqual(["pr.viewed"]);
  });

  it("records the failure on the job row so the UI can show it", async () => {
    for (let i = 0; i < 5; i++) await recordEvent(db, { type: "pr.viewed" });
    await runJob(consolidateEventsJob, config, db);

    const run = await getJobRun(db, consolidateEventsJob.name);
    expect(run?.lastStatus).toBe("error");
    expect(run?.lastError).toContain("activity-consolidator");
    // The lease is released either way, so the next tick can try again.
    expect(run?.leaseUntil).toBeNull();
  });
});

describe("daily rollup", () => {
  it("skips a day with nothing recorded", async () => {
    const result = await runJob(dailyRollupJob, config, db);
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("nothing recorded");
  });
});

describe("cc-session digest consent", () => {
  it("does nothing until it is switched on", async () => {
    const result = await runJob(ccSessionDigestJob, config, db);
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("off");
  });

  it("still does nothing when enabled with no project allowed", async () => {
    await saveJobConfig({ ccDigestEnabled: true, ccDigestProjectDirs: [] });
    const result = await runJob(ccSessionDigestJob, config, db);
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("no project directories");
  });
});

describe("the runner", () => {
  it("refuses to start a second copy of a job already in flight", async () => {
    await claimJob(db, consolidateEventsJob.name);
    const result = await runJob(consolidateEventsJob, config, db);
    expect(result).toEqual({ ran: false, status: "busy", detail: "already running" });
  });

  it("runs only what is due", async () => {
    const job = {
      name: "test-counter",
      description: "counts its runs",
      schedule: everyHours(4),
      run: async () => {
        runs += 1;
        return { detail: "ok" };
      },
    };
    let runs = 0;

    await tick([job], config, db);
    expect(runs).toBe(1);
    // Not due again for four hours, so a second tick is a no-op.
    await tick([job], config, db);
    expect(runs).toBe(1);
  });

  it("reports each registered job's state, including whether it is due", async () => {
    const before = await jobStatuses(allJobs(), db);
    expect(before.every((s) => s.due)).toBe(true);
    expect(before.every((s) => !s.running)).toBe(true);

    await claimJob(db, consolidateEventsJob.name);
    const after = await jobStatuses(allJobs(), db);
    const consolidate = after.find((s) => s.name === consolidateEventsJob.name);
    expect(consolidate?.running).toBe(true);
  });
});
