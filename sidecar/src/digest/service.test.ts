import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { recordEvent } from "../events/service.ts";
import { createTask } from "../tasks/service.ts";
import { createTodo } from "../todos/service.ts";
import { clearDismissal, dismissedKeys, recordDismissal } from "./dismissals.ts";
import { findDanglingWork, reviewCadence, suggestNextWork } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

/** No GitHub token: the local sources still answer, which is the point. */
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
  await sql`TRUNCATE tasks, agent_todos, events, suggestion_dismissals, workspaces RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("dangling work", () => {
  it("reports overdue tasks, open todos and active workspaces, and says github is unavailable", async () => {
    await createTask(db, { title: "slipped task", scope: "daily", targetDate: "2026-01-01" });
    await createTask(db, { title: "future task", scope: "daily", targetDate: "2099-01-01" });
    await createTodo(db, { title: "my own follow-up" });
    await sql`
      INSERT INTO workspaces (name, slug, root_path, status)
      VALUES ('live workspace', 'live-workspace', '/tmp/ws', 'active')`;

    const { items, unavailable } = await findDanglingWork(db, config);
    const titles = items.map((i) => i.title);
    expect(titles).toContain("slipped task");
    expect(titles).toContain("my own follow-up");
    expect(titles).toContain("live workspace");
    // Today's or tomorrow's work is the plan, not something left hanging.
    expect(titles).not.toContain("future task");
    expect(unavailable[0]).toContain("github");
  });

  it("leaves out anything the user has dismissed, until the dismissal is cleared", async () => {
    const todo = await createTodo(db, { title: "not doing this" });
    await recordDismissal(db, { refKey: `todo:${todo.id}`, reason: "not this week" });

    expect((await findDanglingWork(db, config)).items).toEqual([]);
    expect((await findDanglingWork(db, config, { includeDismissed: true })).items.length).toBe(1);

    await clearDismissal(db, `todo:${todo.id}`);
    expect((await findDanglingWork(db, config)).items.length).toBe(1);
  });

  it("treats an expired dismissal as lifted", async () => {
    const todo = await createTodo(db, { title: "back on the table" });
    await recordDismissal(db, {
      refKey: `todo:${todo.id}`,
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await dismissedKeys(db)).toEqual(new Set());
    expect((await findDanglingWork(db, config)).items.length).toBe(1);
  });

  it("records a dismissal once per item, keeping the latest reason", async () => {
    await recordDismissal(db, { refKey: "gh:me/app/1", reason: "first" });
    await recordDismissal(db, { refKey: "gh:me/app/1", reason: "second" });
    const rows = await sql`SELECT reason FROM suggestion_dismissals`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.reason).toBe("second");
  });
});

describe("review cadence", () => {
  it("calls a week with no review activity low", async () => {
    const cadence = await reviewCadence(db);
    expect(cadence.lastWeek).toBe(0);
    expect(cadence.lowActivity).toBe(true);
  });

  it("stops calling it low once enough review events exist", async () => {
    for (const type of ["pr.viewed", "pr.approved", "pr.commented"] as const) {
      await recordEvent(db, { type });
    }
    const cadence = await reviewCadence(db);
    expect(cadence.lastWeek).toBe(3);
    expect(cadence.lowActivity).toBe(false);
  });

  it("ignores review events outside the week", async () => {
    await recordEvent(db, { type: "pr.approved", occurredAt: new Date("2026-01-01T00:00:00Z") });
    expect((await reviewCadence(db)).lastWeek).toBe(0);
  });
});

describe("next-work suggestions", () => {
  it("puts started work above a task that was merely due", async () => {
    await createTask(db, { title: "overdue admin", scope: "daily", targetDate: "2026-01-01" });
    await sql`
      INSERT INTO workspaces (name, slug, root_path, status)
      VALUES ('half-finished feature', 'half-finished', '/tmp/ws', 'active')`;

    const { suggestions } = await suggestNextWork(db, config);
    expect(suggestions[0]!.title).toBe("half-finished feature");
    expect(suggestions[0]!.rationale).toContain("already started");
  });

  it("returns at most the requested number", async () => {
    for (let i = 0; i < 6; i++) await createTodo(db, { title: `todo ${i}` });
    expect((await suggestNextWork(db, config)).suggestions.length).toBe(3);
    expect((await suggestNextWork(db, config, { limit: 2 })).suggestions.length).toBe(2);
  });

  it("reports the review cadence alongside the suggestions", async () => {
    await createTodo(db, { title: "something" });
    const result = await suggestNextWork(db, config);
    expect(result.cadence.lowActivity).toBe(true);
  });
});
