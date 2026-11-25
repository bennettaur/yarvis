import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { agentRuns, reviewWorkspacePrs, reviewWorkspaces } from "../db/schema.ts";
import { feedbackSince } from "./feedback.ts";
import { createReviewWorkspaceRoutes } from "./routes.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;

const config = { databaseUrl: url, workspacesRoot: "" } as Config;
const app = new Hono().route("/rw", createReviewWorkspaceRoutes(config));

const REF_KEY = "gh:o/r/1";

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/rw${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seed(refKey = REF_KEY): Promise<{ wsId: string; prId: string; runId: string }> {
  const [ws] = await db.insert(reviewWorkspaces).values({ name: "Review" }).returning();
  const [pr] = await db
    .insert(reviewWorkspacePrs)
    .values({
      workspaceId: ws.id,
      refKey,
      ref: { provider: "github", owner: "o", repo: "r", number: 1 },
      colorIndex: 0,
      position: 0,
      worktreePath: "/tmp/none",
    })
    .returning();
  const [run] = await db
    .insert(agentRuns)
    .values({
      kind: "verification-report",
      targetKey: `${refKey}@abc`,
      status: "succeeded",
      instance: "test",
      meta: { refKey, headSha: "abc", sections: ["risk"], format: 2 },
    })
    .returning();
  return { wsId: ws.id, prId: pr.id, runId: run.id };
}

const concern = {
  section: "risk",
  kind: "concern",
  itemKey: "concern:Voice keeps sending:src/x.ts:12",
  item: { title: "Voice keeps sending", detail: "The mic stays live.", path: "src/x.ts", line: 12 },
};

beforeEach(async () => {
  await sql`TRUNCATE review_workspaces, review_workspace_prs, agent_runs, verification_feedback RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("verification feedback", () => {
  it("records a rejection with its reason, then a change of mind, on one row", async () => {
    const { wsId, prId, runId } = await seed();
    const path = `/${wsId}/prs/${prId}/verification/feedback`;

    const rejected = await call("PUT", path, {
      ...concern,
      runId,
      verdict: "rejected",
      reason: "The mic is stopped on unmount.",
    });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({
      verdict: "rejected",
      reason: "The mic is stopped on unmount.",
      actions: [],
    });

    const rerated = await call("PUT", path, {
      ...concern,
      runId,
      verdict: "rerated",
      rating: "low",
      reason: "Real, but only with continuous voice on.",
    });
    expect(await rerated.json()).toMatchObject({ verdict: "rerated", rating: "low" });

    const list = (await (await call("GET", path)).json()) as { feedback: unknown[] };
    expect(list.feedback).toHaveLength(1);
    expect(list.feedback[0]).toMatchObject({
      verdict: "rerated",
      rating: "low",
      reason: "Real, but only with continuous voice on.",
    });
  });

  it("keeps each action once, beside the verdict", async () => {
    const { wsId, prId, runId } = await seed();
    const path = `/${wsId}/prs/${prId}/verification/feedback`;
    await call("PUT", path, { ...concern, runId, verdict: "accepted" });
    await call("PUT", path, { ...concern, runId, action: "posted-pr" });
    const again = await call("PUT", path, { ...concern, runId, action: "posted-pr" });
    expect(await again.json()).toMatchObject({ verdict: "accepted", actions: ["posted-pr"] });
  });

  it("refuses a run that isn't this PR's verification run", async () => {
    const { wsId, prId } = await seed();
    const other = await seed("gh:o/r/2");
    const res = await call("PUT", `/${wsId}/prs/${prId}/verification/feedback`, {
      ...concern,
      runId: other.runId,
      verdict: "accepted",
    });
    expect(res.status).toBe(400);
  });

  it("refuses feedback that gives neither a verdict nor an action, and a rerate with no rating", async () => {
    const { wsId, prId, runId } = await seed();
    const path = `/${wsId}/prs/${prId}/verification/feedback`;
    expect((await call("PUT", path, { ...concern, runId })).status).toBe(400);
    expect((await call("PUT", path, { ...concern, runId, verdict: "rerated" })).status).toBe(400);
  });

  it("gives a reflection what was said since a date, leaving out cleared rows", async () => {
    const { wsId, prId, runId } = await seed();
    const path = `/${wsId}/prs/${prId}/verification/feedback`;
    await call("PUT", path, { ...concern, runId, verdict: "rejected", reason: "Wrong file." });
    const cleared = { ...concern, itemKey: "concern:other", item: { title: "Other", detail: "" } };
    await call("PUT", path, { ...cleared, runId, verdict: "accepted" });
    await call("PUT", path, { ...cleared, runId, verdict: null });

    const { feedback, truncated } = await feedbackSince(db, new Date(Date.now() - 60_000));
    expect(truncated).toBe(false);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({
      refKey: REF_KEY,
      section: "risk",
      kind: "concern",
      verdict: "rejected",
      reason: "Wrong file.",
      item: { title: "Voice keeps sending" },
    });
    expect((await feedbackSince(db, new Date(Date.now() + 60_000))).feedback).toHaveLength(0);
  });
});
