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
/** Routes the fake sidecar answers with a failure instead of a body. */
let failing: string | null = null;
/** When set, the detail fetch hangs until this resolves, so the window between
 *  clicking a row's Start work and the picker opening can be acted on. */
let holdDetail: Promise<void> | null = null;

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
  sidecarInfo: async () => ({ port: 0, token: "test-token" }),
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
  sidecarFetch: async (path: string, init: RequestInit = {}) => {
    fetched.push(path);
    if (init.method && init.method !== "GET")
      sent.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
    if (holdDetail && path.startsWith("/api/jira/issue/")) await holdDetail;
    if (failing && path.startsWith(failing)) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify(responseFor(path)), { status: 200 });
  },
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

const startButton = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('[aria-label="Start work on this ticket"]');

/** The picker renders in a fixed overlay; its own subtree is what must carry a
 *  start failure, since it covers the list underneath. */
const modal = (host: HTMLElement) => host.querySelector(".fixed.inset-0");

beforeEach(() => {
  fetched.length = 0;
  sent.length = 0;
  failing = null;
  holdDetail = null;
});

describe("JiraIssuesView", () => {
  it("opens the repo picker from a list row and starts work on confirm", async () => {
    const { host, cleanup } = await mount();
    startButton(host)?.click();
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

  it("shows a failed start inside the picker that covers the list", async () => {
    failing = "/api/jira/start-work";
    const { host, cleanup } = await mount();
    startButton(host)?.click();
    await settle();
    button(host, "Start (scratch)")?.click();
    await settle();
    // The dialog stays open so the repo/status choice survives the retry, and
    // the message has to live inside it — the list behind is not visible.
    expect(modal(host)?.textContent).toContain("/api/jira/start-work failed (500): nope");
    expect(button(host, "Start (scratch)")?.disabled).toBe(false);
    cleanup();
  });

  it("drops a start when the row is opened before its detail lands", async () => {
    let release = () => {};
    holdDetail = new Promise((resolve) => {
      release = () => resolve();
    });
    const { host, cleanup } = await mount();
    startButton(host)?.click();
    // Open the ticket while its detail is still in flight, then come back.
    host.querySelector("li")?.click();
    await settle();
    expect(button(host, "← Back")).toBeDefined();
    release();
    await settle();
    holdDetail = null;
    button(host, "← Back")?.click();
    await settle();
    // The abandoned start must not spring its picker open on the way back.
    expect(modal(host)).toBeNull();
    cleanup();
  });
});
