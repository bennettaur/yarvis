import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { createTask } from "../tasks/service.ts";
import {
  addProjectItem,
  findProjectByName,
  listProjectItems,
  listProjects,
  projectOverview,
  removeProjectItem,
  updateProject,
  updateProjectItem,
  upsertProject,
} from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE projects, tasks, events RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("projects", () => {
  it("creates a project and finds it by name regardless of case", async () => {
    const { project, created } = await upsertProject(db, {
      name: "Events Consolidation",
      summary: "fold the event log into memory",
    });
    expect(created).toBe(true);
    expect((await findProjectByName(db, "events consolidation"))?.id).toBe(project.id);
  });

  it("returns the existing project instead of failing on a duplicate name", async () => {
    const first = await upsertProject(db, { name: "calendar" });
    const second = await upsertProject(db, { name: "Calendar", focus: "demo by Thursday" });

    expect(second.created).toBe(false);
    expect(second.project.id).toBe(first.project.id);
    // A gap gets filled, so a second mention can add the focus it now has.
    expect(second.project.focus).toBe("demo by Thursday");
    expect((await listProjects(db)).length).toBe(1);
  });

  it("does not let a re-create overwrite an existing focus", async () => {
    const { project } = await upsertProject(db, { name: "calendar", focus: "ship the read side" });
    const again = await upsertProject(db, { name: "calendar", focus: "something else" });
    expect(again.project.focus).toBe("ship the read side");
    expect(project.id).toBe(again.project.id);
  });

  it("records project creation and updates as events", async () => {
    const { project } = await upsertProject(db, { name: "events" });
    await updateProject(db, project.id, { status: "shipped" });
    const types = (await sql`SELECT type FROM events ORDER BY occurred_at`).map(
      (r) => r.type as string,
    );
    expect(types).toEqual(["project.created", "project.updated"]);
  });

  it("tracks a ticket once per project and updates it when re-added", async () => {
    const { project } = await upsertProject(db, { name: "events" });
    await addProjectItem(db, {
      projectId: project.id,
      kind: "jira",
      externalKey: "PROJ-45",
      title: "Fold events into memory",
      priority: "medium",
    });
    const again = await addProjectItem(db, {
      projectId: project.id,
      kind: "jira",
      externalKey: "PROJ-45",
      title: "Fold events into memory",
      priority: "urgent",
    });

    const items = await listProjectItems(db, project.id);
    expect(items.length).toBe(1);
    expect(items[0]!.id).toBe(again.id);
    expect(items[0]!.priority).toBe("urgent");
  });

  it("orders items by priority, urgent first", async () => {
    const { project } = await upsertProject(db, { name: "events" });
    for (const [key, priority] of [
      ["A-1", "low"],
      ["A-2", "urgent"],
      ["A-3", "medium"],
    ] as const) {
      await addProjectItem(db, {
        projectId: project.id,
        kind: "jira",
        externalKey: key,
        title: key,
        priority,
      });
    }
    expect((await listProjectItems(db, project.id)).map((i) => i.externalKey)).toEqual([
      "A-2",
      "A-3",
      "A-1",
    ]);
  });

  it("hides a done item unless asked for, and can reopen it", async () => {
    const { project } = await upsertProject(db, { name: "events" });
    const item = await addProjectItem(db, {
      projectId: project.id,
      kind: "note",
      title: "write the migration",
    });
    await updateProjectItem(db, item.id, { done: true });

    expect((await listProjectItems(db, project.id)).length).toBe(0);
    expect((await listProjectItems(db, project.id, { includeDone: true })).length).toBe(1);

    await updateProjectItem(db, item.id, { done: false });
    expect((await listProjectItems(db, project.id)).length).toBe(1);
    expect(await removeProjectItem(db, item.id)).toBe(true);
  });

  it("reads a project with its items and the user's open tasks for it", async () => {
    const { project } = await upsertProject(db, { name: "events" });
    await addProjectItem(db, { projectId: project.id, kind: "note", title: "the migration" });
    await createTask(db, { title: "write the job", scope: "weekly", projectId: project.id });
    await createTask(db, { title: "unrelated", scope: "daily" });

    const overview = await projectOverview(db, project.id);
    expect(overview?.items.length).toBe(1);
    expect(overview?.openTasks.map((t) => t.title)).toEqual(["write the job"]);
  });

  it("answers null for an overview of a project that doesn't exist", async () => {
    expect(await projectOverview(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
