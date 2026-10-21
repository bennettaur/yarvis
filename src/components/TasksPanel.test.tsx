import { describe, expect, it, mock, setSystemTime } from "bun:test";
import { createElement } from "react";
import { clearResourceCache } from "../lib/resourceCache";
import type { Task } from "../lib/tasks";
import { firstPaintOf, renderToHtml } from "../test/render";
import TasksPanel, { groupTasks } from "./TasksPanel";

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

/** What the mocked sidecar returns for tasks; a test may swap it and must restore it. */
let currentTasks: Task[] = TASKS;

mock.module("../lib/api", () => ({
  sidecarInfo: async () => ({ port: 0, token: "test-token" }),
  // Faithful copy of the real implementation: a naive stub here would leak
  // into any other test file that runs in the same process (`mock.module` is
  // process-global, not file-scoped) and break its assertions about the
  // actual error-detail-extraction behavior.
  ensureOk: async (res: Response, context: string) => {
    if (res.ok) return;
    let raw = "";
    try {
      raw = (await res.text()).trim();
    } catch {
      // no body to read
    }
    let detail: string | null = null;
    if (raw) {
      try {
        const body = JSON.parse(raw) as { error?: unknown };
        const err = body?.error;
        if (typeof err === "string") {
          detail = err;
        } else if (err && typeof err === "object") {
          const flat = err as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
          const parts: string[] = [];
          if (Array.isArray(flat.formErrors)) parts.push(...flat.formErrors);
          for (const [field, msgs] of Object.entries(flat.fieldErrors ?? {})) {
            if (Array.isArray(msgs) && msgs.length) parts.push(`${field}: ${msgs.join(", ")}`);
          }
          if (parts.length) detail = parts.join("; ");
        }
        if (detail === null) detail = raw;
      } catch {
        detail = raw;
      }
    }
    throw new Error(
      detail ? `${context} failed (${res.status}): ${detail}` : `${context} failed: ${res.status}`,
    );
  },
  getHealth: async () => ({
    status: "ok",
    service: "sidecar",
    uptimeMs: 0,
    ready: true,
    phase: "ready" as const,
  }),
  waitForSidecarReady: async () => {},
  getStatus: async () => ({
    service: "sidecar",
    databaseConfigured: true,
    providers: { anthropic: false, gemini: false, cerebras: false, huggingface: false },
  }),
  getDbHealth: async () => ({ configured: true, reachable: true }),
  streamSSE: async function* streamSSE() {},
  sidecarFetch: async (path: string) =>
    new Response(JSON.stringify(path.includes("/api/tasks") ? currentTasks : {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
}));

describe("TasksPanel", () => {
  it("shows a loading indicator, not empty groups, before the first load lands", async () => {
    clearResourceCache();
    const cold = firstPaintOf(createElement(TasksPanel));
    expect(cold.text).toContain("Loading tasks…");
    expect(cold.text).not.toContain("Nothing here yet.");
    cold.unmount();

    const html = await renderToHtml(createElement(TasksPanel));
    expect(html).not.toContain("Loading tasks…");
  });

  it("shows Upcoming only when a task is due on a later day", async () => {
    clearResourceCache();
    expect(await renderToHtml(createElement(TasksPanel))).not.toContain("Upcoming");

    currentTasks = [
      ...TASKS,
      { ...TASKS[0], id: "task-friday", title: "Send the plan", targetDate: "2026-06-19" },
    ];
    try {
      clearResourceCache();
      const html = await renderToHtml(createElement(TasksPanel));
      expect(html).toContain("Upcoming");
      expect(html).toContain("Send the plan");
    } finally {
      currentTasks = TASKS;
      clearResourceCache();
    }
  });

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

describe("groupTasks", () => {
  const task = (id: string, scope: Task["scope"], targetDate: string | null): Task => ({
    id,
    title: id,
    status: "open",
    scope,
    targetDate,
    notes: null,
    sourceSessionId: null,
    createdAt: "2026-06-10T09:00:00.000Z",
    completedAt: null,
  });
  const ids = (tasks: Task[]) => tasks.map((t) => t.id);

  it("puts a daily task dated after today under Upcoming", () => {
    const groups = groupTasks([task("friday", "daily", "2026-06-19")], "2026-06-17");
    expect(ids(groups.upcoming)).toEqual(["friday"]);
    expect(ids(groups.today)).toEqual([]);
  });

  it("lists an overdue weekly task once, under Overdue", () => {
    const groups = groupTasks([task("late", "weekly", "2026-06-12")], "2026-06-17");
    expect(ids(groups.overdue)).toEqual(["late"]);
    expect(ids(groups.weekly)).toEqual([]);
  });

  it("puts every task in exactly one group", () => {
    const tasks = [
      task("today", "daily", "2026-06-17"),
      task("undated-daily", "daily", null),
      task("weekly", "weekly", null),
      task("weekly-friday", "weekly", "2026-06-19"),
      task("upcoming", "daily", "2026-06-20"),
      task("overdue", "daily", "2026-06-16"),
    ];
    const groups = groupTasks(tasks, "2026-06-17");
    expect(ids(groups.today)).toEqual(["today"]);
    expect(ids(groups.weekly)).toEqual(["undated-daily", "weekly", "weekly-friday"]);
    expect(ids(groups.upcoming)).toEqual(["upcoming"]);
    expect(ids(groups.overdue)).toEqual(["overdue"]);
  });
});
