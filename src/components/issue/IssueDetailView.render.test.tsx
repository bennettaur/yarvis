import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { IssueDetail, IssueSummary } from "../../lib/issues/types";
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
/** Issue state the fake sidecar serves, mutated by the PATCHes it receives. */
let stored: IssueDetail = detail();
/** When set, PATCH responds with this status instead of applying the edit. */
let patchFails = 0;
/** When set, start-work responds with this status instead of a workspace. */
let startFails = 0;

// Stubbing the transport rather than lib/issues/api keeps the URL, method, and
// body that api.ts builds under test — the same layer the PR render tests stub.
mock.module("../../lib/api", () => ({
  sidecarFetch: async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    sent.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : null });
    if (method === "PATCH") {
      if (patchFails) return new Response("nope", { status: patchFails });
      stored = { ...stored, ...(sent[sent.length - 1]?.body as Partial<IssueDetail>) };
    }
    if (path.endsWith("/start-work")) {
      if (startFails) return new Response("nope", { status: startFails });
      return new Response(
        JSON.stringify({ workspaceId: "w1", prompt: "seeded prompt", warnings: [] }),
        { status: 201 },
      );
    }
    return new Response(JSON.stringify(stored), { status: 200 });
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
    cleanup: () => {
      root.unmount();
      host.remove();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const button = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);

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
  patchFails = 0;
  startFails = 0;
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
