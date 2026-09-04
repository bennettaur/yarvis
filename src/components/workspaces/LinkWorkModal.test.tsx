import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { WorkspaceDetail } from "../../lib/workspaces";
import { renderToHtml } from "../../test/render";
import LinkWorkModal, { parseJiraKey } from "./LinkWorkModal";

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
    const body = path.includes("/api/tasks")
      ? [{ id: "task-1", title: "Ship the thing", status: "open", scope: "daily" }]
      : path.includes("/api/issues/github/all")
        ? []
        : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

describe("parseJiraKey", () => {
  it("accepts a bare key and uppercases the project", () => {
    expect(parseJiraKey("proj-123")).toEqual({ project: "PROJ", key: "PROJ-123" });
  });

  it("extracts the key from a browse URL", () => {
    expect(parseJiraKey("https://acme.atlassian.net/browse/ABC-42")).toEqual({
      project: "ABC",
      key: "ABC-42",
    });
  });

  it("rejects input without a key-shaped token", () => {
    expect(parseJiraKey("just some text")).toBeNull();
    expect(parseJiraKey("")).toBeNull();
    expect(parseJiraKey("123-456")).toBeNull(); // project must start with a letter
  });
});

const detail = {
  id: "ws-1",
  name: "Workspace",
  status: "active",
  repos: [],
  tasks: [],
  issues: [],
} as unknown as WorkspaceDetail;

describe("LinkWorkModal", () => {
  it("shows the three source tabs and lists open tasks by default", async () => {
    const html = await renderToHtml(
      createElement(LinkWorkModal, {
        detail,
        onClose: () => {},
        onLinked: async () => {},
      }),
    );
    expect(html).toContain("Tasks");
    expect(html).toContain("GitHub");
    expect(html).toContain("JIRA");
    expect(html).toContain("Ship the thing");
  });
});
