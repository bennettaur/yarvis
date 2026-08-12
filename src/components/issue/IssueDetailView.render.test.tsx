import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { IssueDetail, IssueRepoMeta, IssueSummary } from "../../lib/issues/types";
import { type OpenWorkspaceRequest, onOpenWorkspace } from "../../lib/nav";
import IssueDetailView from "./IssueDetailView";

const summary = (state: string): IssueSummary => ({
  provider: "github",
  sourceKey: "octo/web",
  sourceLabel: "octo/web",
  externalId: "7",
  displayId: "#7",
  title: "Broken login",
  url: "https://github.com/octo/web/issues/7",
  state,
  author: "alice",
  assignees: [],
  labels: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  commentCount: 0,
});

const detail = (over: Partial<IssueDetail> = {}): IssueDetail => ({
  ...summary("open"),
  body: "the body",
  comments: [],
  ...over,
});

interface SentRequest {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

const sent: SentRequest[] = [];
/** Issue state the fake sidecar serves, mutated by the writes it receives. */
let stored: IssueDetail = detail();
/** The label and assignee sets the fake repo offers its pickers. */
let repoMeta: IssueRepoMeta = {
  labels: [
    { name: "bug", color: "d73a4a" },
    { name: "chore", color: null },
  ],
  assignees: ["alice", "bob"],
  truncated: { labels: false, assignees: false },
};
/** When set, PATCH responds with this status instead of applying the edit. */
let patchFails = 0;
/** When set, start-work responds with this status instead of a workspace. */
let startFails = 0;
/** When set, posting a comment responds with this status instead of storing it. */
let commentFails = 0;
/** When set, repo-meta responds with this status instead of the sets. */
let repoMetaFails = 0;
/** When set, the comment POST waits on this before responding. */
let holdComment: Promise<void> | null = null;
/**
 * Assignees the fake stores regardless of what a PATCH asked for, modelling
 * GitHub silently dropping logins it will not accept.
 */
let assigneesGitHubKeeps: string[] | null = null;

/**
 * Applies a PATCH body the way the real route does — by re-reading the issue
 * from GitHub — so `labels` arrives back as the repo's coloured label objects
 * rather than the bare names the request carried.
 */
function applyPatch(body: Record<string, unknown>): IssueDetail {
  const { labels, assignees, ...rest } = body;
  const next = { ...stored, ...(rest as Partial<IssueDetail>) };
  if (Array.isArray(labels)) {
    next.labels = labels.map(
      (name) => repoMeta.labels.find((l) => l.name === name) ?? { name: String(name), color: null },
    );
  }
  if (Array.isArray(assignees)) {
    next.assignees = assigneesGitHubKeeps ?? (assignees as string[]);
  }
  return next;
}

/** Detail served for issues other than the default #7, keyed by externalId. */
let othersById: Record<string, IssueDetail> = {};

/** The detail the fake should serve for whichever issue a path addresses. */
function servedFor(path: string): IssueDetail {
  const id = path.match(/\/detail\/[^/]+\/[^/]+\/(\d+)/)?.[1];
  return (id && othersById[id]) || stored;
}

// Stubbing the transport rather than lib/issues/api keeps the URL, method, and
// body that api.ts builds under test — the same layer the PR render tests stub.
mock.module("../../lib/api", () => ({
  sidecarFetch: async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    sent.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : null });
    const body = sent[sent.length - 1]?.body ?? {};
    if (method === "PATCH") {
      if (patchFails) return new Response("nope", { status: patchFails });
      stored = applyPatch(body);
    }
    if (path.includes("/repo-meta/")) {
      if (repoMetaFails) return new Response("nope", { status: repoMetaFails });
      return new Response(JSON.stringify(repoMeta), { status: 200 });
    }
    if (path.endsWith("/comments") && method === "POST") {
      if (holdComment) await holdComment;
      if (commentFails) return new Response("nope", { status: commentFails });
      stored = {
        ...stored,
        comments: [
          ...stored.comments,
          { author: "me", body: String(body.body), createdAt: "2026-01-03T00:00:00Z" },
        ],
      };
      return new Response(JSON.stringify(stored), { status: 201 });
    }
    if (path.endsWith("/start-work")) {
      if (startFails) return new Response("nope", { status: startFails });
      return new Response(
        JSON.stringify({ workspaceId: "w1", prompt: "seeded prompt", warnings: [] }),
        { status: 201 },
      );
    }
    return new Response(JSON.stringify(servedFor(path)), { status: 200 });
  },
  ensureOk: async (res: Response, context: string) => {
    if (!res.ok) throw new Error(`${context} -> ${res.status}`);
  },
  streamSSE: () => () => {},
}));

/** Mounts the view and settles effects, returning a live host to click on. */
async function mount(listState = "open") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(IssueDetailView, { summary: summary(listState), onBack: () => {} }));
  await settle();
  return {
    host,
    /** Re-renders with a different issue, as navigating the list would. */
    show: async (next: IssueSummary) => {
      root.render(createElement(IssueDetailView, { summary: next, onBack: () => {} }));
      await settle();
    },
    cleanup: () => {
      root.unmount();
      host.remove();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const button = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);

/** A row inside an open label/assignee picker; the leading ✓ marks it staged. */
const option = (host: HTMLElement, name: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.replace("✓", "") === name);

const isStaged = (host: HTMLElement, name: string) =>
  option(host, name)?.textContent?.startsWith("✓") ?? false;

/** Types into a React-controlled field (React tracks the value setter itself). */
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  sent.length = 0;
  stored = detail();
  repoMeta = {
    labels: [
      { name: "bug", color: "d73a4a" },
      { name: "chore", color: null },
    ],
    assignees: ["alice", "bob"],
    truncated: { labels: false, assignees: false },
  };
  patchFails = 0;
  startFails = 0;
  commentFails = 0;
  repoMetaFails = 0;
  holdComment = null;
  assigneesGitHubKeeps = null;
  othersById = {};
});

describe("IssueDetailView", () => {
  it("follows the loaded detail, not the list summary, for the issue state", async () => {
    stored = detail({ state: "closed" });
    const { host, cleanup } = await mount("open");
    expect(button(host, "Reopen issue")).toBeDefined();
    expect(button(host, "Close issue")).toBeUndefined();
    cleanup();
  });

  it("closes an open issue and flips the button to Reopen", async () => {
    const { host, cleanup } = await mount();
    button(host, "Close issue")?.click();
    await settle();
    expect(sent).toContainEqual({
      path: "/api/issues/github/detail/octo/web/7",
      method: "PATCH",
      body: { state: "closed" },
    });
    expect(button(host, "Reopen issue")).toBeDefined();
    cleanup();
  });

  it("reopens a closed issue", async () => {
    stored = detail({ state: "closed" });
    const { host, cleanup } = await mount("closed");
    button(host, "Reopen issue")?.click();
    await settle();
    expect(sent[sent.length - 1]).toMatchObject({ method: "PATCH", body: { state: "open" } });
    cleanup();
  });

  it("saves a trimmed title and renders what came back", async () => {
    const { host, cleanup } = await mount();
    host.querySelector<HTMLButtonElement>('button[title="Edit title"]')?.click();
    await settle();
    const field = host.querySelector("input");
    expect(field).not.toBeNull();
    if (field) type(field, "  Login is broken  ");
    await settle();
    button(host, "Save")?.click();
    await settle();
    expect(sent[sent.length - 1]).toMatchObject({
      method: "PATCH",
      body: { title: "Login is broken" },
    });
    expect(host.querySelector("h1")?.textContent).toBe("Login is broken");
    cleanup();
  });

  it("clears a description when the draft is emptied", async () => {
    const { host, cleanup } = await mount();
    host.querySelector<HTMLButtonElement>('button[title="Edit description"]')?.click();
    await settle();
    const field = host.querySelector("textarea");
    if (field) type(field, "");
    await settle();
    button(host, "Save")?.click();
    await settle();
    expect(sent[sent.length - 1]).toMatchObject({ method: "PATCH", body: { body: "" } });
    cleanup();
  });

  it("leaves the repo's label and assignee sets unfetched until a picker opens", async () => {
    const { host, cleanup } = await mount();
    expect(sent.some((r) => r.path.includes("/repo-meta/"))).toBe(false);
    host.querySelector<HTMLButtonElement>('button[title="Edit labels"]')?.click();
    await settle();
    expect(sent).toContainEqual({
      path: "/api/issues/github/repo-meta/octo/web",
      method: "GET",
      body: null,
    });
    cleanup();
  });

  it("reuses the repo's sets across issues in that repo, and drops them on a new one", async () => {
    const { host, show, cleanup } = await mount();
    const metaCalls = () => sent.filter((r) => r.path.includes("/repo-meta/"));
    host.querySelector<HTMLButtonElement>('button[title="Edit labels"]')?.click();
    await settle();
    expect(metaCalls()).toHaveLength(1);

    // Same repo: the sets still describe it, so nothing is re-fetched.
    await show({ ...summary("open"), externalId: "8", displayId: "#8" });
    host.querySelector<HTMLButtonElement>('button[title="Edit labels"]')?.click();
    await settle();
    expect(metaCalls()).toHaveLength(1);

    // Different repo: the old sets do not apply, so they are fetched again.
    await show({ ...summary("open"), sourceKey: "octo/api", sourceLabel: "octo/api" });
    host.querySelector<HTMLButtonElement>('button[title="Edit labels"]')?.click();
    await settle();
    expect(metaCalls()).toHaveLength(2);
    expect(metaCalls()[1]?.path).toBe("/api/issues/github/repo-meta/octo/api");
    cleanup();
  });

  it("sends the whole staged label set, not just what changed", async () => {
    stored = detail({ labels: [{ name: "bug", color: "d73a4a" }] });
    const { host, cleanup } = await mount();
    host.querySelector<HTMLButtonElement>('button[title="Edit labels"]')?.click();
    await settle();
    // The picker opens with the issue's current labels already staged.
    expect(isStaged(host, "bug")).toBe(true);
    expect(isStaged(host, "chore")).toBe(false);
    option(host, "chore")?.click();
    await settle();
    button(host, "Save")?.click();
    await settle();
    expect(sent[sent.length - 1]).toMatchObject({
      method: "PATCH",
      body: { labels: ["bug", "chore"] },
    });
    // Rendered from what came back, so the repo's colour reaches the pill.
    expect(host.textContent).toContain("chore");
    cleanup();
  });

  it("unassigns by sending an empty assignee set", async () => {
    stored = detail({ assignees: ["alice"] });
    const { host, cleanup } = await mount();
    host.querySelector<HTMLButtonElement>('button[title="Edit assignees"]')?.click();
    await settle();
    option(host, "alice")?.click();
    await settle();
    button(host, "Save")?.click();
    await settle();
    expect(sent[sent.length - 1]).toMatchObject({ method: "PATCH", body: { assignees: [] } });
    expect(host.textContent).toContain("Unassigned.");
    cleanup();
  });

  it("discards a staged selection when the picker is cancelled", async () => {
    stored = detail({ labels: [{ name: "bug", color: "d73a4a" }] });
    const { host, cleanup } = await mount();
    host.querySelector<HTMLButtonElement>('button[title="Edit labels"]')?.click();
    await settle();
    option(host, "chore")?.click();
    await settle();
    button(host, "Cancel")?.click();
    await settle();
    expect(sent.some((r) => r.method === "PATCH")).toBe(false);
    expect(host.textContent).not.toContain("chore");
    cleanup();
  });

  it("posts a trimmed comment and renders the one the server stored", async () => {
    const { host, cleanup } = await mount();
    const field = host.querySelector("textarea");
    expect(field).not.toBeNull();
    if (field) type(field, "  looking into it  ");
    await settle();
    button(host, "Comment")?.click();
    await settle();
    expect(sent[sent.length - 1]).toEqual({
      path: "/api/issues/github/detail/octo/web/7/comments",
      method: "POST",
      body: { body: "looking into it" },
    });
    expect(host.textContent).toContain("looking into it");
    expect(host.textContent).toContain("Comments (1)");
    // The draft is cleared, so the button is no longer armed.
    expect(button(host, "Comment")?.disabled).toBe(true);
    cleanup();
  });

  it("keeps a rejected comment in the box so the draft isn't lost", async () => {
    commentFails = 502;
    const { host, cleanup } = await mount();
    const field = host.querySelector("textarea");
    if (field) type(field, "looking into it");
    await settle();
    button(host, "Comment")?.click();
    await settle();
    expect(host.textContent).toContain("502");
    expect(host.querySelector("textarea")?.value).toBe("looking into it");
    expect(button(host, "Comment")?.disabled).toBe(false);
    cleanup();
  });

  it("lists a label the repo no longer offers, so it can still be removed", async () => {
    // `legacy` is on the issue but absent from repoMeta — a label deleted from
    // the repo after it was applied. Without it in the options there is no row
    // to uncheck, and Save would silently put it back.
    stored = detail({
      labels: [
        { name: "legacy", color: null },
        { name: "bug", color: "d73a4a" },
      ],
    });
    const { host, cleanup } = await mount();
    host.querySelector<HTMLButtonElement>('button[title="Edit labels"]')?.click();
    await settle();
    expect(option(host, "legacy")).toBeDefined();
    option(host, "legacy")?.click();
    await settle();
    button(host, "Save")?.click();
    await settle();
    expect(sent[sent.length - 1]).toMatchObject({ method: "PATCH", body: { labels: ["bug"] } });
    cleanup();
  });

  it("keeps the picker open with its draft intact when the save is rejected", async () => {
    patchFails = 403;
    const { host, cleanup } = await mount();
    host.querySelector<HTMLButtonElement>('button[title="Edit labels"]')?.click();
    await settle();
    option(host, "bug")?.click();
    await settle();
    button(host, "Save")?.click();
    await settle();
    expect(host.textContent).toContain("403");
    // Still open and still staged — a picker that closed here would throw away
    // the whole selection the user just made.
    expect(isStaged(host, "bug")).toBe(true);
    expect(button(host, "Save")?.disabled).toBe(false);
    cleanup();
  });

  it("renders the assignee set the server stored, not the one that was sent", async () => {
    // GitHub drops logins it will not accept and returns what it kept.
    assigneesGitHubKeeps = ["alice"];
    const { host, cleanup } = await mount();
    host.querySelector<HTMLButtonElement>('button[title="Edit assignees"]')?.click();
    await settle();
    option(host, "alice")?.click();
    option(host, "bob")?.click();
    await settle();
    button(host, "Save")?.click();
    await settle();
    expect(sent[sent.length - 1]).toMatchObject({ body: { assignees: ["alice", "bob"] } });
    expect(host.textContent).toContain("alice");
    expect(host.textContent).not.toContain("bob");
    cleanup();
  });

  it("says the filter matched nothing rather than claiming the repo is empty", async () => {
    const { host, cleanup } = await mount();
    host.querySelector<HTMLButtonElement>('button[title="Edit labels"]')?.click();
    await settle();
    const filter = host.querySelector<HTMLInputElement>('input[aria-label="Filter labels"]');
    expect(filter).not.toBeNull();
    if (filter) type(filter, "zzz");
    await settle();
    expect(host.textContent).toContain("No matches.");
    expect(host.textContent).not.toContain("No labels in this repo.");
    cleanup();
  });

  it("reports a failed repo-meta load in the picker instead of loading forever", async () => {
    repoMetaFails = 500;
    const { host, cleanup } = await mount();
    host.querySelector<HTMLButtonElement>('button[title="Edit labels"]')?.click();
    await settle();
    expect(host.textContent).toContain("Could not load labels");
    expect(host.textContent).not.toContain("Loading…");
    cleanup();
  });

  it("warns when the repo offers more options than were listed", async () => {
    repoMeta = { ...repoMeta, truncated: { labels: false, assignees: true } };
    const { host, cleanup } = await mount();
    host.querySelector<HTMLButtonElement>('button[title="Edit assignees"]')?.click();
    await settle();
    expect(host.textContent).toContain("Showing the first 100");
    cleanup();
  });

  it("closes an open picker on Escape and on an outside click", async () => {
    const { host, cleanup } = await mount();
    host.querySelector<HTMLButtonElement>('button[title="Edit labels"]')?.click();
    await settle();
    expect(option(host, "chore")).toBeDefined();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(option(host, "chore")).toBeUndefined();

    host.querySelector<HTMLButtonElement>('button[title="Edit labels"]')?.click();
    await settle();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await settle();
    expect(option(host, "chore")).toBeUndefined();
    cleanup();
  });

  it("does not let a write for the previous issue overwrite the one now shown", async () => {
    let release = () => {};
    holdComment = new Promise<void>((resolve) => {
      release = resolve;
    });
    othersById["8"] = detail({ externalId: "8", displayId: "#8", title: "A different issue" });

    const { host, show, cleanup } = await mount();
    const field = host.querySelector("textarea");
    if (field) type(field, "on issue 7");
    await settle();
    button(host, "Comment")?.click();
    await settle();

    // Move to another issue while the POST is still in flight, then let it land.
    await show({
      ...summary("open"),
      externalId: "8",
      displayId: "#8",
      title: "A different issue",
    });
    release();
    await settle();

    expect(host.querySelector("h1")?.textContent).toBe("A different issue");
    expect(host.textContent).not.toContain("on issue 7");
    cleanup();
  });

  it("surfaces a rejected edit instead of pretending it applied", async () => {
    patchFails = 403;
    const { host, cleanup } = await mount();
    button(host, "Close issue")?.click();
    await settle();
    expect(host.textContent).toContain("403");
    // Still open, and the button is usable again for a retry.
    expect(button(host, "Close issue")?.disabled).toBe(false);
    cleanup();
  });

  it("starts work from the detail it already loaded", async () => {
    const handoffs: OpenWorkspaceRequest[] = [];
    const unsubscribe = onOpenWorkspace((r) => handoffs.push(r));
    const { host, cleanup } = await mount();
    sent.length = 0;
    button(host, "Start work")?.click();
    await settle();
    // The body is already on screen, so it must not be re-fetched.
    expect(sent.filter((r) => r.method === "GET")).toEqual([]);
    expect(sent).toContainEqual({
      path: "/api/issues/github/start-work",
      method: "POST",
      body: {
        sourceKey: "octo/web",
        externalId: "7",
        title: "Broken login",
        body: "the body",
        url: "https://github.com/octo/web/issues/7",
      },
    });
    expect(handoffs).toEqual([{ id: "w1" }]);
    unsubscribe();
    cleanup();
  });

  it("shows a failed start even when an earlier edit also failed", async () => {
    patchFails = 403;
    startFails = 500;
    const { host, cleanup } = await mount();
    button(host, "Close issue")?.click();
    await settle();
    button(host, "Start work")?.click();
    await settle();
    // The stale edit error must not stand in for the start the user just ran.
    expect(host.textContent).toContain("/api/issues/github/start-work -> 500");
    expect(button(host, "Start work")?.disabled).toBe(false);
    cleanup();
  });
});
