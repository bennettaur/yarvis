import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToHtml, textOf } from "../../test/render";

const TODOS = [
  {
    id: "t1",
    title: "Draft the demo script",
    details: "for Thursday's review",
    status: "in_progress",
    priority: "urgent",
    projectId: null,
    dueAt: "2026-08-27T09:00:00.000Z",
    notes: [{ at: "2026-08-24T10:00:00.000Z", text: "outline done" }],
    createdAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
    closedAt: null,
  },
  {
    id: "t2",
    title: "Check whether that PR merged",
    details: null,
    status: "blocked",
    priority: "medium",
    projectId: null,
    dueAt: null,
    notes: [{ at: "2026-08-24T11:00:00.000Z", text: "waiting on CI" }],
    createdAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T11:00:00.000Z",
    closedAt: null,
  },
];

const requested: string[] = [];

mock.module("../../lib/api", () => ({
  sidecarFetch: async (path: string) => {
    requested.push(path);
    return new Response(JSON.stringify(TODOS), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

const TodosTab = (await import("./TodosTab")).default;

describe("TodosTab", () => {
  it("shows each todo with its status, priority and latest note", async () => {
    const text = textOf(await renderToHtml(createElement(TodosTab)));
    expect(text).toContain("Draft the demo script");
    expect(text).toContain("In progress");
    expect(text).toContain("urgent");
    expect(text).toContain("outline done");
    expect(text).toContain("Blocked");
    expect(text).toContain("waiting on CI");
  });

  it("says whose list this is, so it isn't mistaken for the user's tasks", async () => {
    const text = textOf(await renderToHtml(createElement(TodosTab)));
    expect(text).toContain("your tasks live on the Tasks tab");
  });

  it("asks only for the open statuses until closed ones are requested", async () => {
    requested.length = 0;
    await renderToHtml(createElement(TodosTab));
    const query = requested.find((path) => path.includes("/api/todos")) ?? "";
    expect(query).toContain("status=pending");
    expect(query).toContain("status=blocked");
    expect(query).not.toContain("status=done");
  });
});
