import { afterAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { WorkspaceDetail } from "../../lib/workspaces";
import { renderToHtml } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
import LinkWorkModal, { parseJiraKey } from "./LinkWorkModal";

stubSidecarApi({
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
});

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

afterAll(resetSidecarApi);
