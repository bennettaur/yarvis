import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { claimJob, finishJob, getJobRun } from "./store.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE job_runs RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("job leases", () => {
  it("lets one claimant in and turns the second away", async () => {
    expect(await claimJob(db, "consolidate")).not.toBeNull();
    expect(await claimJob(db, "consolidate")).toBeNull();
  });

  it("hands the lease on once it has expired", async () => {
    await claimJob(db, "consolidate");
    await sql`UPDATE job_runs SET lease_until = now() - interval '1 minute' WHERE name = 'consolidate'`;
    expect(await claimJob(db, "consolidate")).not.toBeNull();
  });

  it("releases the lease and records the outcome and cursor", async () => {
    await claimJob(db, "nightly");
    await finishJob(db, "nightly", { status: "ok", cursor: { lastSession: "abc" } });

    const run = await getJobRun(db, "nightly");
    expect(run?.lastStatus).toBe("ok");
    expect(run?.leaseUntil).toBeNull();
    expect(run?.cursor).toEqual({ lastSession: "abc" });
    // With the lease gone, the next run can claim it.
    expect(await claimJob(db, "nightly")).not.toBeNull();
  });

  it("leaves the stored cursor alone when a run doesn't supply one", async () => {
    await claimJob(db, "nightly");
    await finishJob(db, "nightly", { status: "ok", cursor: { seen: 1 } });
    await claimJob(db, "nightly");
    await finishJob(db, "nightly", { status: "error", error: "boom" });

    const run = await getJobRun(db, "nightly");
    expect(run?.cursor).toEqual({ seen: 1 });
    expect(run?.lastError).toBe("boom");
  });
});
