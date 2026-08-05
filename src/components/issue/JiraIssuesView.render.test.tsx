import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { IssueSummary } from "../../lib/issues/types";

const issue: IssueSummary = {
  provider: "jira",
  sourceKey: "PROJ",
  sourceLabel: "PROJ",
  externalId: "PROJ-45",
  displayId: "PROJ-45",
  title: "Broken login",
  url: "https://acme.atlassian.net/browse/PROJ-45",
  state: "open",
  author: "alice",
  assignees: [],
  labels: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  commentCount: 0,
  statusName: "To Do",
  statusCategory: "todo",
};

const detail = {
  ...issue,
  body: "the body",
  comments: [],
  reporter: "alice",
  assignee: null,
  assigneeAccountId: null,
  priority: null,
  linkedIssues: [],
  transitions: [
    { id: "31", name: "Start", toStatusName: "In Progress", toStatusCategory: "in_progress" },
  ],
};

const fetched: string[] = [];
const sent: { path: string; body: Record<string, unknown> | null }[] = [];

/** What the fake sidecar answers each route with. */
function responseFor(path: string): unknown {
  if (path.startsWith("/api/jira/viewer")) return { login: "alice", accountId: "a1" };
  if (path.startsWith("/api/jira/assigned")) return [issue];
  if (path.startsWith("/api/jira/issue/")) return detail;
  if (path.startsWith("/api/jira/start-work"))
    return { workspaceId: "w1", prompt: "prompt", warnings: [] };
  return [];
}

// Stubbing the transport (rather than lib/jira/api) keeps the request paths the
// api client builds under test, matching the GitHub issues render test.
mock.module("../../lib/api", () => ({
  sidecarFetch: async (path: string, init: RequestInit = {}) => {
    fetched.push(path);
    if (init.method && init.method !== "GET")
      sent.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(responseFor(path)), { status: 200 });
  },
  ensureOk: async (res: Response, context: string) => {
    if (!res.ok) throw new Error(`${context} -> ${res.status}`);
  },
  streamSSE: () => () => {},
}));

// The repo picker lists the registered repos; none are needed for a scratch
// workspace, which is what this test starts.
mock.module("../../lib/repos", () => ({ listRepos: async () => [] }));

const { default: JiraIssuesView } = await import("./JiraIssuesView");

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(JiraIssuesView));
  await settle();
  return {
    host,
    cleanup: () => {
      root.unmount();
      host.remove();
    },
  };
}

const button = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);

beforeEach(() => {
  fetched.length = 0;
  sent.length = 0;
});

describe("JiraIssuesView", () => {
  it("opens the repo picker from a list row and starts work on confirm", async () => {
    const { host, cleanup } = await mount();
    host.querySelector<HTMLButtonElement>('[aria-label="Start work on this ticket"]')?.click();
    await settle();
    // The row carries no transitions or description, so the flow pulls detail
    // before the picker can offer a target status.
    expect(fetched).toContain("/api/jira/issue/PROJ-45");
    expect(host.textContent).toContain("Start work on PROJ-45");

    button(host, "Start (scratch)")?.click();
    await settle();
    expect(sent).toContainEqual({
      path: "/api/jira/start-work",
      body: {
        sourceKey: "PROJ",
        externalId: "PROJ-45",
        title: "Broken login",
        body: "the body",
        url: issue.url,
        repoIds: [],
        transitionToInProgress: true,
        transitionId: "31",
      },
    });
    // Starting work must not navigate into the detail view.
    expect(host.textContent).toContain("Assigned to me");
    cleanup();
  });
});
