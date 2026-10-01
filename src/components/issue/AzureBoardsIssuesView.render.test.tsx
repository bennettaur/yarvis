import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { IssueSummary } from "../../lib/issues/types";

const item: IssueSummary = {
  provider: "azure",
  sourceKey: "Web App",
  sourceLabel: "Web App",
  externalId: "7",
  displayId: "#7",
  title: "Broken login",
  url: "https://dev.azure.com/acme/Web%20App/_workitems/edit/7",
  state: "open",
  author: "alice",
  assignees: [],
  labels: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  commentCount: 0,
  statusName: "New",
  statusCategory: "todo",
  issueType: "Bug",
};

let detail = {
  ...item,
  body: "the body",
  bodyField: "description",
  comments: [],
  assignee: null,
  priority: "2",
  states: [
    { name: "New", category: "todo" },
    { name: "Active", category: "in_progress" },
    { name: "Closed", category: "done" },
  ],
};

const fetched: string[] = [];
const sent: { path: string; body: Record<string, unknown> | null }[] = [];
/** Routes the fake sidecar answers with a failure instead of a body. */
let failing: string | null = null;
/** When set, the probe gets the gate's "not configured" 400. */
let notConfigured = false;

/** What the fake sidecar answers each route with. */
function responseFor(path: string): unknown {
  if (path.startsWith("/api/azure-boards/viewer")) return { login: "alice", uniqueName: "a@x" };
  if (path.startsWith("/api/azure-boards/assigned")) return [item];
  if (/^\/api\/azure-boards\/item\/\d+\/comment/.test(path))
    return { author: "alice", body: "on it", createdAt: "2026-01-03T00:00:00Z" };
  if (path.startsWith("/api/azure-boards/item/")) return detail;
  if (path.startsWith("/api/azure-boards/start-work")) return { workspaceId: "w1", warnings: [] };
  return [];
}

// Stubbing the transport (rather than lib/azureBoards/api) keeps the request
// paths the api client builds under test, matching the JIRA render test.
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
    if (notConfigured && path.startsWith("/api/azure-boards/viewer"))
      return new Response(JSON.stringify({ error: "azure boards not configured" }), {
        status: 400,
      });
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

const { default: AzureBoardsIssuesView } = await import("./AzureBoardsIssuesView");
const { invalidatePrefix } = await import("../../lib/resourceCache");
const { AZURE_BOARDS_ISSUES_PREFIX } = await import("../../lib/issues/cacheKeys");

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(AzureBoardsIssuesView));
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

beforeEach(() => {
  fetched.length = 0;
  sent.length = 0;
  failing = null;
  notConfigured = false;
  detail = { ...detail, bodyField: "description" };
  // The probe's answer is cached, so each test starts from a cold cache.
  invalidatePrefix(AZURE_BOARDS_ISSUES_PREFIX);
});

describe("AzureBoardsIssuesView", () => {
  it("opens the picker from a list row and starts work in the Active state", async () => {
    const { host, cleanup } = await mount();
    startButton(host)?.click();
    await settle();
    expect(fetched).toContain("/api/azure-boards/item/7");
    expect(host.textContent).toContain("Start work on #7");

    button(host, "Start (scratch)")?.click();
    await settle();
    expect(sent).toContainEqual({
      path: "/api/azure-boards/start-work",
      body: {
        sourceKey: "Web App",
        externalId: "7",
        title: "Broken login",
        body: "the body",
        url: item.url,
        repoIds: [],
        moveToInProgress: true,
        state: "Active",
      },
    });
    cleanup();
  });

  it("explains the missing Azure DevOps settings instead of showing an error", async () => {
    notConfigured = true;
    const { host, cleanup } = await mount();
    expect(host.textContent).toContain("Azure Boards isn’t configured");
    expect(fetched).not.toContain("/api/azure-boards/assigned");
    cleanup();
  });

  it("opens a work item typed as an id and changes its state", async () => {
    const { host, cleanup } = await mount();
    button(host, "Search")?.click();
    await settle();
    const input = host.querySelector<HTMLInputElement>(
      '[aria-label="WIQL query, title text or work item id"]',
    );
    if (!input) throw new Error("search input missing");
    // React tracks the value through the native setter, so set it that way.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "#7");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    // The tab and the submit button are both labelled "Search"; submit is last.
    const searchButtons = Array.from(host.querySelectorAll("button")).filter(
      (b) => b.textContent === "Search",
    );
    searchButtons[searchButtons.length - 1]?.click();
    await settle();
    expect(fetched).toContain("/api/azure-boards/item/7");

    const select = host.querySelector<HTMLSelectElement>('[aria-label="Change state"]');
    if (!select) throw new Error("state select missing");
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
      select,
      "Closed",
    );
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(sent).toContainEqual({
      path: "/api/azure-boards/item/7/state",
      body: { state: "Closed" },
    });
    cleanup();
  });

  /** Opens the first row's detail view. */
  async function openDetail(host: HTMLElement) {
    host.querySelector("li")?.click();
    await settle();
  }

  function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("saves tags split on ; and , with blanks dropped", async () => {
    const { host, cleanup } = await mount();
    await openDetail(host);
    host.querySelector<HTMLButtonElement>('[title="Edit tags"]')?.click();
    await settle();
    const input = host.querySelector<HTMLInputElement>('[aria-label="Tags"]');
    if (!input) throw new Error("tags input missing");
    type(input, "a b; c, ,d");
    await settle();
    button(host, "Save")?.click();
    await settle();
    expect(sent).toContainEqual({
      path: "/api/azure-boards/item/7",
      body: { tags: ["a b", "c", "d"] },
    });
    cleanup();
  });

  it("assigns the work item to the current user", async () => {
    const { host, cleanup } = await mount();
    await openDetail(host);
    button(host, "Assign to me")?.click();
    await settle();
    expect(sent).toContainEqual({
      path: "/api/azure-boards/item/7/assignee",
      body: { self: true },
    });
    cleanup();
  });

  it("shows a posted comment without reloading the work item", async () => {
    const { host, cleanup } = await mount();
    await openDetail(host);
    const box = host.querySelector<HTMLTextAreaElement>('[aria-label="New comment"]');
    if (!box) throw new Error("comment box missing");
    type(box, "on it");
    await settle();
    const detailLoads = fetched.filter((p) => p === "/api/azure-boards/item/7").length;
    button(host, "Comment")?.click();
    await settle();
    expect(sent).toContainEqual({
      path: "/api/azure-boards/item/7/comment",
      body: { body: "on it" },
    });
    expect(host.textContent).toContain("Comments (1)");
    expect(fetched.filter((p) => p === "/api/azure-boards/item/7").length).toBe(detailLoads);
    cleanup();
  });

  it("edits a bug's Repro Steps rather than its Description", async () => {
    detail = { ...detail, bodyField: "reproSteps" };
    const { host, cleanup } = await mount();
    await openDetail(host);
    expect(host.textContent).toContain("Repro steps");
    host.querySelector<HTMLButtonElement>('[title="Edit description"]')?.click();
    await settle();
    button(host, "Save")?.click();
    await settle();
    expect(sent).toContainEqual({
      path: "/api/azure-boards/item/7",
      body: { reproSteps: "the body" },
    });
    cleanup();
  });
});
