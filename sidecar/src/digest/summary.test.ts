import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { recordEvent } from "../events/service.ts";
import { chooseEmbedder } from "../memory/embedder.ts";
import { PgVectorMemoryStore } from "../memory/index.ts";
import { completeTask, createTask } from "../tasks/service.ts";
import { weeklySummaryMaterial, weekWindow } from "./summary.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

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

beforeEach(async () => {
  await sql`TRUNCATE memories, events, tasks RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("weekWindow", () => {
  it("runs from Monday to now for the current week", () => {
    // A Wednesday.
    const { from, to } = weekWindow(new Date("2026-08-26T15:00:00"));
    expect(from.getDay()).toBe(1);
    expect(from.getHours()).toBe(0);
    expect(to.getHours()).toBe(15);
  });

  it("covers a whole past week rather than ending at the same clock time", () => {
    const { from, to } = weekWindow(new Date("2026-08-26T15:00:00"), 1);
    expect(from.getDay()).toBe(1);
    expect(to.getDay()).toBe(1);
    expect(Math.round((to.getTime() - from.getTime()) / 86_400_000)).toBe(7);
  });
});

describe("weekly summary material", () => {
  it("keeps to its window at both ends", async () => {
    const memory = new PgVectorMemoryStore(db, await chooseEmbedder(config, db));
    const inWindow = await memory.add("Monday: wrote the consolidation job", {
      kind: "day-summary",
    });
    const later = await memory.add("this week: something else entirely", { kind: "day-summary" });
    // Backdate one summary into the window under test and leave the other in the
    // present, which is where an unbounded read would find it.
    await sql`UPDATE memories SET created_at = '2026-08-19T18:00:00Z' WHERE id = ${inWindow.id}`;

    const material = await weeklySummaryMaterial(db, config, {
      from: new Date("2026-08-17T00:00:00Z"),
      to: new Date("2026-08-24T00:00:00Z"),
    });

    expect(material.daySummaries.map((d) => d.content)).toEqual([
      "Monday: wrote the consolidation job",
    ]);
    expect(material.daySummaries.map((d) => d.content)).not.toContain(
      (await memory.get(later.id))?.content,
    );
  });

  it("gathers the week's activity, verdicts and finished tasks", async () => {
    await recordEvent(db, {
      type: "pr.approved",
      payload: { ref: "gh:me/app/12" },
    });
    await recordEvent(db, { type: "pr.viewed", payload: { ref: "gh:me/app/13" } });
    const task = await createTask(db, { title: "ship the migration", scope: "weekly" });
    await completeTask(db, task.id);

    const material = await weeklySummaryMaterial(db, config, weekWindow());
    expect(material.activity.find((a) => a.type === "pr.approved")?.count).toBe(1);
    expect(material.reviewsGiven.map((r) => r.ref)).toEqual(["gh:me/app/12"]);
    expect(material.tasksCompleted.map((t) => t.title)).toEqual(["ship the migration"]);
    // No GitHub token in this config, so the summary says so rather than lying.
    expect(material.unavailable[0]).toContain("github");
  });

  it("reads a structured pr.viewed ref as the same key a dismissal would use", async () => {
    await recordEvent(db, {
      type: "pr.commented",
      payload: { ref: { provider: "github", owner: "me", repo: "app", number: 7 } },
    });
    const material = await weeklySummaryMaterial(db, config, weekWindow());
    expect(material.reviewsGiven.map((r) => r.ref)).toEqual(["gh:me/app/7"]);
  });
});
