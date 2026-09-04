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
