import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToHtml, textOf } from "../../test/render";

const PROJECT = {
  id: "p1",
  name: "Events consolidation",
  status: "active",
  summary: "fold the event log into memory",
  focus: "ship the nightly rollup",
  repoIds: [],
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-24T09:00:00.000Z",
};

const OVERVIEW = {
  project: PROJECT,
  items: [
    {
      id: "i1",
      projectId: "p1",
      kind: "jira",
      externalKey: "PROJ-45",
      title: "Write the consolidation job",
      priority: "urgent",
      note: "blocked on the embedder",
      doneAt: null,
    },
  ],
  openTasks: [
    { id: "task1", title: "review the migration", scope: "weekly", targetDate: "2026-08-28" },
  ],
};

mock.module("../../lib/api", () => ({
  sidecarFetch: async (path: string) => {
    const body = path === "/api/projects" ? [PROJECT] : OVERVIEW;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

const ProjectsTab = (await import("./ProjectsTab")).default;

describe("ProjectsTab", () => {
  it("selects the first project and shows its focus and tickets", async () => {
    const text = textOf(await renderToHtml(createElement(ProjectsTab)));
    expect(text).toContain("Events consolidation");
    expect(text).toContain("Focus: ship the nightly rollup");
    expect(text).toContain("PROJ-45");
    expect(text).toContain("urgent");
    expect(text).toContain("blocked on the embedder");
  });

  it("shows the user's own open tasks for the project", async () => {
    const text = textOf(await renderToHtml(createElement(ProjectsTab)));
    expect(text).toContain("review the migration");
    expect(text).toContain("2026-08-28");
  });
});
