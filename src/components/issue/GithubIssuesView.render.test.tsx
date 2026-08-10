import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { IssueRepo, IssueSummary } from "../../lib/issues/types";
import { type OpenWorkspaceRequest, onOpenWorkspace } from "../../lib/nav";

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

/** Routes the fake sidecar answers with a failure instead of a body. */
let failing: string | null = null;
/** When set, `/detail` hangs until this resolves, so a start can be observed
 *  mid-flight (the busy row) rather than only after it settles. */
let holdDetail: Promise<void> | null = null;

/** What the fake sidecar answers each route with. */
function responseFor(path: string): unknown {
  if (path.startsWith("/api/issues/github/repos")) return configured;
  if (path.startsWith("/api/issues/github/assigned")) return assigned;
  if (path.startsWith("/api/issues/github/detail")) return { ...issue, body: "the body" };
  if (path.startsWith("/api/issues/github/start-work"))
    return { workspaceId: "w1", prompt: "seeded prompt", warnings: [] };
  return [];
}

// Stubbing the transport (rather than lib/issues/api) keeps the request paths
// the api client builds under test, matching the PR render tests.
mock.module("../../lib/api", () => ({
  sidecarFetch: async (path: string, init: RequestInit = {}) => {
    fetched.push(path);
    if (init.method && init.method !== "GET")
      sent.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
    if (holdDetail && path.startsWith("/api/issues/github/detail")) await holdDetail;
    if (failing && path.startsWith(failing)) return new Response("nope", { status: 500 });
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

const startButtons = (host: HTMLElement) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="Start work on this issue"]'));

/** A second issue in the same repo, so both land in one group. */
const otherIssue: IssueSummary = {
  ...issue,
  externalId: "8",
  displayId: "#8",
  title: "Slow search",
  url: "https://github.com/octo/web/issues/8",
};

beforeEach(() => {
  fetched.length = 0;
  sent.length = 0;
  configured = repos;
  assigned = [];
  failing = null;
  holdDetail = null;
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
    const handoffs: OpenWorkspaceRequest[] = [];
    const unsubscribe = onOpenWorkspace((r) => handoffs.push(r));
    const { host, cleanup } = await mount();
    startButtons(host)[0]?.click();
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
    // The point of starting work: the Workspaces tab opens on the workspace.
    // The prompt doesn't ride along — the sidecar stored it with the workspace.
    expect(handoffs).toEqual([{ id: "w1" }]);
    // Starting work must not navigate into the detail view.
    expect(host.textContent).toContain("Assigned to me");
    expect(button(host, "← Back")).toBeUndefined();
    unsubscribe();
    cleanup();
  });

  it("marks only the clicked row busy while its detail loads", async () => {
    assigned = [issue, otherIssue];
    let release = () => {};
    holdDetail = new Promise((resolve) => {
      release = () => resolve();
    });
    const { host, cleanup } = await mount();
    const [first, second] = startButtons(host);
    first?.click();
    await settle();
    expect(first?.disabled).toBe(true);
    expect(second?.disabled).toBe(false);
    release();
    await settle();
    cleanup();
  });

  it("surfaces a failed start and leaves the row retryable", async () => {
    assigned = [issue];
    failing = "/api/issues/github/start-work";
    const { host, cleanup } = await mount();
    startButtons(host)[0]?.click();
    await settle();
    expect(host.textContent).toContain("/api/issues/github/start-work -> 500");
    expect(startButtons(host)[0]?.disabled).toBe(false);
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
