import { describe, expect, it, mock, setSystemTime } from "bun:test";
import { createElement } from "react";
import { renderToHtml } from "../test/render";
import TasksPanel from "./TasksPanel";

setSystemTime(new Date("2026-06-17T12:00:00"));

const TASKS = [
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
});
