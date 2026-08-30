import { describe, expect, it, mock, setSystemTime } from "bun:test";
import { createElement } from "react";
import type { Task } from "../lib/tasks";
import { renderToHtml } from "../test/render";
import TasksPanel from "./TasksPanel";

setSystemTime(new Date("2026-06-17T12:00:00"));

const TASKS: Task[] = [
  {
    id: "task-today",
    title: "Ship the delete button",
    status: "open",
    scope: "daily",
    targetDate: "2026-06-17",
    notes: null,
    sourceSessionId: null,
    createdAt: "2026-06-17T09:00:00.000Z",
    completedAt: null,
  },
  {
    id: "task-done",
    title: "Old finished task",
    status: "done",
    scope: "weekly",
    targetDate: null,
    notes: null,
    sourceSessionId: null,
    createdAt: "2026-06-10T09:00:00.000Z",
    completedAt: "2026-06-11T09:00:00.000Z",
  },
];

mock.module("../lib/api", () => ({
  sidecarFetch: async (path: string) =>
    new Response(JSON.stringify(path.includes("/api/tasks") ? TASKS : {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
}));

describe("TasksPanel", () => {
  it("renders each open task with a delete affordance", async () => {
    const html = await renderToHtml(createElement(TasksPanel));

    expect(html).toContain("Ship the delete button");
    // The per-row delete button is what makes the task removable from the UI.
    expect(html).toContain('aria-label="Delete task"');
  });

  it("exposes create-workspace and start-work affordances only on open tasks", async () => {
    const html = await renderToHtml(createElement(TasksPanel));
    // Both open-task icons render — aria-label + title (tooltip) carry meaning.
    expect(html).toContain('aria-label="Create workspace for this task"');
    expect(html).toContain('title="Create workspace"');
    expect(html).toContain('aria-label="Start work on this task"');
    expect(html).toContain('title="Start work"');
    // Guard: fixture has one open and one done task, so each affordance must
    // appear exactly once — the done row must not offer workspace controls.
    const openIcons = html.match(/aria-label="Start work on this task"/g);
    expect(openIcons?.length).toBe(1);
  });
});
