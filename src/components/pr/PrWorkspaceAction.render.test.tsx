import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { type OpenWorkspaceRequest, onOpenWorkspace } from "../../lib/nav";
import type { PrRef } from "../../lib/pr/types";
import { renderToHtml } from "../../test/render";
import PrWorkspaceAction from "./PrWorkspaceAction";

interface SentRequest {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

const sent: SentRequest[] = [];
/** The workspace the lookup finds for the PR, or null for "none yet". */
let matched: Record<string, unknown> | null = null;
/** When set, the start responds with this status instead of a workspace. */
let startFails = 0;
/** When set, the start waits on this before responding. */
let holdStart: Promise<void> | null = null;

// The transport is stubbed rather than lib/workspaces or lib/pr/workspace, so
// the path, method and body those clients build stay under test.
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
    const method = init.method ?? "GET";
    sent.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : null });
    if (path === "/api/pr/workspace") {
      if (holdStart) await holdStart;
      if (startFails) return new Response("nope", { status: startFails });
      return new Response(
        JSON.stringify({ workspaceId: "w1", name: "PR #1 · Rename the API", existing: false }),
        { status: 201 },
      );
    }
    return new Response(JSON.stringify(matched), { status: 200 });
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

const ghRef: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 1 };
const azRef: PrRef = { provider: "azure", org: "acme", project: "Shop", repo: "web", prId: 42 };

const workspace = { id: "ws-1", name: "Rename API", slug: "rename-api", status: "active" };

const render = (prRef: PrRef) => renderToHtml(createElement(PrWorkspaceAction, { prRef }));

/** Mounts the control and settles effects, returning a live host to click on. */
async function mount(prRef: PrRef = ghRef, fromFork = false) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(PrWorkspaceAction, { prRef, fromFork }));
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

/** The control renders exactly one button in either state; in the no-workspace
 *  state it is the start button, whose label changes while a start is running. */
const startButton = (host: HTMLElement) => host.querySelector("button");

beforeEach(() => {
  sent.length = 0;
  matched = null;
  startFails = 0;
  holdStart = null;
});

describe("PrWorkspaceAction", () => {
  it("renders the backlink button for a GitHub PR that has a workspace", async () => {
    matched = workspace;
    expect(await render(ghRef)).toContain("Workspace: Rename API");
  });

  it("renders the backlink button for an Azure PR (no longer early-returns)", async () => {
    matched = workspace;
    expect(await render(azRef)).toContain("Workspace: Rename API");
  });

  it("offers to start one for a PR with no workspace", async () => {
    const html = await render(ghRef);
    expect(html).toContain("Start workspace");
    expect(html).not.toContain("Workspace: ");
  });

  // A fork's branch isn't on the registered repo's remote, so the round trip
  // could only come back refused.
  it("disables the button for a PR raised from a fork", async () => {
    const open = await mount();
    expect(startButton(open.host)?.disabled).toBe(false);
    open.cleanup();

    const fork = await mount(ghRef, true);
    expect(startButton(fork.host)?.disabled).toBe(true);
    fork.cleanup();
  });

  it("posts the ref and hands the user over to the new workspace", async () => {
    const handoffs: OpenWorkspaceRequest[] = [];
    const unsubscribe = onOpenWorkspace((r) => handoffs.push(r));
    const { host, cleanup } = await mount();
    sent.length = 0;

    startButton(host)?.click();
    await settle();

    expect(sent).toEqual([{ path: "/api/pr/workspace", method: "POST", body: { ref: ghRef } }]);
    expect(handoffs).toEqual([{ id: "w1" }]);
    unsubscribe();
    cleanup();
  });

  it("sends the azure-shaped ref for an Azure PR", async () => {
    const { host, cleanup } = await mount(azRef);
    sent.length = 0;
    startButton(host)?.click();
    await settle();
    expect(sent[0]?.body).toEqual({ ref: azRef });
    cleanup();
  });

  // The poller won't have cached the new workspace for up to a minute, so the
  // control has to adopt what it just created or it would offer to start a
  // second one.
  it("becomes the backlink to the workspace it just started", async () => {
    const { host, cleanup } = await mount();
    startButton(host)?.click();
    await settle();
    expect(host.textContent).toContain("Workspace: PR #1 · Rename the API");
    cleanup();
  });

  it("reads as busy and refuses a second click while the start is in flight", async () => {
    let release = () => {};
    holdStart = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host, cleanup } = await mount();
    sent.length = 0;

    startButton(host)?.click();
    await settle();
    expect(host.textContent).toContain("Starting…");
    expect(startButton(host)?.disabled).toBe(true);
    startButton(host)?.click();
    await settle();
    expect(sent).toHaveLength(1);

    release();
    await settle();
    cleanup();
  });

  it("shows a refused start beside the button and leaves it usable for a retry", async () => {
    startFails = 400;
    const { host, cleanup } = await mount();
    startButton(host)?.click();
    await settle();
    expect(host.textContent).toContain("start workspace failed (400): nope");
    expect(startButton(host)?.disabled).toBe(false);
    cleanup();
  });
});
