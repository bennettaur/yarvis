import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { IssueRepo, IssueSummary } from "../../lib/issues/types";

const repos: IssueRepo[] = [{ id: "r1", owner: "octo", repo: "web", name: "web" }];

const issue: IssueSummary = {
  provider: "github",
  sourceKey: "octo/web",
  sourceLabel: "octo/web",
  externalId: "7",
  displayId: "#7",
  title: "Broken login",
  url: "https://github.com/octo/web/issues/7",
  state: "open",
  author: "alice",
  assignees: [],
  labels: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  commentCount: 0,
};

/** Repos the fake sidecar reports as configured to pull issues. */
let configured: IssueRepo[] = repos;
/** Issues the fake sidecar serves on the "assigned to me" list. */
let assigned: IssueSummary[] = [];
const fetched: string[] = [];
const sent: { path: string; body: Record<string, unknown> | null }[] = [];

/** What the fake sidecar answers each route with. */
function responseFor(path: string): unknown {
  if (path.startsWith("/api/issues/github/repos")) return configured;
  if (path.startsWith("/api/issues/github/assigned")) return assigned;
  if (path.startsWith("/api/issues/github/detail")) return { ...issue, body: "the body" };
  if (path.startsWith("/api/issues/github/start-work"))
    return { workspaceId: "w1", prompt: "prompt", warnings: [] };
  return [];
}

// Stubbing the transport (rather than lib/issues/api) keeps the request paths
// the api client builds under test, matching the PR render tests.
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

const { default: GithubIssuesView } = await import("./GithubIssuesView");

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(GithubIssuesView));
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
  configured = repos;
  assigned = [];
});

describe("GithubIssuesView", () => {
  it("re-pulls the lists when Refresh is clicked", async () => {
    const { host, cleanup } = await mount();
    fetched.length = 0;
    button(host, "↻ Refresh")?.click();
    await settle();
    expect(fetched).toContain("/api/issues/github/assigned");
    expect(fetched).toContain("/api/issues/github/all");
    cleanup();
  });

  it("keeps Refresh reachable when no repo pulls issues yet", async () => {
    // Enabling "Pull issues" in Settings doesn't remount this view, so the
    // empty state needs its own way to re-pull.
    configured = [];
    const { host, cleanup } = await mount();
    expect(host.textContent).toContain("No repositories are set to pull issues");
    button(host, "↻ Refresh")?.click();
    await settle();
    expect(fetched.filter((p) => p === "/api/issues/github/repos").length).toBe(2);
    cleanup();
  });

  it("starts work from a list row without opening the issue", async () => {
    assigned = [issue];
    const { host, cleanup } = await mount();
    const start = host.querySelector<HTMLButtonElement>('[aria-label="Start work on this issue"]');
    start?.click();
    await settle();
    // The row carries no body, so the flow pulls detail before starting.
    expect(fetched).toContain("/api/issues/github/detail/octo/web/7");
    expect(sent).toContainEqual({
      path: "/api/issues/github/start-work",
      body: {
        sourceKey: "octo/web",
        externalId: "7",
        title: "Broken login",
        body: "the body",
        url: issue.url,
      },
    });
    // Starting work must not navigate into the detail view.
    expect(host.textContent).toContain("Assigned to me");
    cleanup();
  });

  it("offers New issue only once a repo is configured", async () => {
    const { host, cleanup } = await mount();
    expect(button(host, "+ New issue")?.disabled).toBe(false);
    cleanup();

    configured = [];
    const empty = await mount();
    expect(button(empty.host, "+ New issue")).toBeUndefined();
    empty.cleanup();
  });
});
