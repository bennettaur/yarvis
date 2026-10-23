import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { type OpenWorkspaceRequest, onOpenWorkspace } from "../../lib/nav";
import { prDetailKey } from "../../lib/pr/cache";
import type { PrDetail, PrRef } from "../../lib/pr/types";
import { cachedFetch, primeCache } from "../../lib/resourceCache";
import { mountForInteraction, renderToHtml, waitFor } from "../../test/render";
import PrConflictBanner from "./PrConflictBanner";

interface SentRequest {
  path: string;
  body: Record<string, unknown> | null;
}

const sent: SentRequest[] = [];
/** What the sidecar answers the next resolve requests with, in order. */
let replies: { status: number; body: unknown }[] = [];

// The transport is stubbed rather than lib/pr/conflicts, so the path and body
// that client builds stay under test.
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
    sent.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
    const reply = replies.shift() ?? { status: 200, body: null };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  },
  // Faithful copy of the real implementation: `mock.module` is process-global,
  // so a naive stub would leak into other test files' assertions.
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

const ref: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 3 };
const azureRef: PrRef = { provider: "azure", org: "acme", project: "Shop", repo: "web", prId: 9 };

const detail = (over: Partial<PrDetail> = {}) =>
  ({
    state: "OPEN",
    baseRef: "main",
    headRef: "feat",
    fromFork: false,
    mergeable: "CONFLICTING",
    ...over,
  }) as PrDetail;

let unmount = () => {};
let unsubscribe = () => {};
const opened: OpenWorkspaceRequest[] = [];

beforeEach(() => {
  sent.length = 0;
  replies = [];
  opened.length = 0;
  unsubscribe = onOpenWorkspace((r) => opened.push(r));
});

afterEach(() => {
  unmount();
  unsubscribe();
});

async function mount(d: PrDetail | null, prRef: PrRef = ref, recheckMs?: number) {
  const mounted = await mountForInteraction(
    createElement(PrConflictBanner, { prRef, detail: d, recheckMs }),
  );
  unmount = mounted.unmount;
  return mounted.host;
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label);

describe("PrConflictBanner", () => {
  it("names the base the PR conflicts with and offers to resolve it", async () => {
    const html = await renderToHtml(
      createElement(PrConflictBanner, { prRef: ref, detail: detail() }),
    );
    expect(html).toContain("Conflicts with main");
    expect(html).toContain("Resolve conflicts");
  });

  it("shows for GitHub's DIRTY merge state and for an Azure PR", async () => {
    expect(
      await renderToHtml(
        createElement(PrConflictBanner, {
          prRef: ref,
          detail: detail({ mergeable: "UNKNOWN", mergeStateStatus: "DIRTY" }),
        }),
      ),
    ).toContain("Conflicts with main");
    expect(
      await renderToHtml(
        createElement(PrConflictBanner, {
          prRef: azureRef,
          detail: detail({ state: "active", baseRef: "develop" }),
        }),
      ),
    ).toContain("Conflicts with develop");
  });

  it("shows nothing for a mergeable PR or one still being computed", async () => {
    const clean = await renderToHtml(
      createElement(PrConflictBanner, { prRef: ref, detail: detail({ mergeable: "MERGEABLE" }) }),
    );
    expect(clean).not.toContain("Conflicts with");
    const computing = await renderToHtml(
      createElement(PrConflictBanner, { prRef: ref, detail: detail({ mergeable: "UNKNOWN" }) }),
    );
    expect(computing).not.toContain("Conflicts with");
  });

  // GitHub works mergeability out lazily, so the first read after a push often
  // can't say; one more look settles it without polling.
  it("refetches the detail once while mergeability is being computed", async () => {
    primeCache(prDetailKey(ref), detail({ mergeable: "UNKNOWN" }));
    await mount(detail({ mergeable: "UNKNOWN" }), ref, 20);
    let reloads = 0;
    await waitFor(() => {
      void cachedFetch(prDetailKey(ref), async () => {
        reloads++;
        return detail();
      });
      return reloads > 0;
    }, "the detail to be invalidated");
    expect(reloads).toBe(1);
  });

  it("explains why a fork's PR can't be handed to an agent", async () => {
    const host = await mount(detail({ fromFork: true }));
    const resolve = button(host, "Resolve conflicts");
    expect(resolve?.disabled).toBe(true);
    expect(resolve?.title).toContain("comes from a fork");
    expect(host.textContent).toContain("comes from a fork");
  });

  it("sends the ref and reports the agent it reached", async () => {
    replies = [{ status: 200, body: { outcome: "sent", workspaceId: "w1", name: "Payments" } }];
    const host = await mount(detail());

    button(host, "Resolve conflicts")?.click();
    await waitFor(() => (host.textContent ?? "").includes("Sent to the agent"), "the result");

    expect(sent).toEqual([{ path: "/api/pr/resolve-conflicts", body: { ref, confirm: false } }]);
    expect(host.textContent).toContain("Sent to the agent in “Payments”.");
    // Sending to an existing agent leaves the user where they are.
    expect(opened).toEqual([]);
    button(host, "Open workspace")?.click();
    expect(opened).toEqual([{ id: "w1" }]);
  });

  it("asks before interrupting a busy agent, and sends once the user agrees", async () => {
    replies = [
      {
        status: 200,
        body: {
          outcome: "needs_confirm",
          workspaceId: "w1",
          name: "Payments",
          reason: "The agent is working on something.",
        },
      },
      { status: 200, body: { outcome: "sent", workspaceId: "w1", name: "Payments" } },
    ];
    const host = await mount(detail());

    button(host, "Resolve conflicts")?.click();
    await waitFor(() => button(host, "Send anyway") !== undefined, "the confirmation");
    expect(host.textContent).toContain("The agent is working on something. Send anyway?");

    button(host, "Send anyway")?.click();
    await waitFor(() => (host.textContent ?? "").includes("Sent to the agent"), "the send");
    expect(sent.map((s) => s.body?.confirm)).toEqual([false, true]);
  });

  it("can back out of interrupting a busy agent", async () => {
    replies = [
      {
        status: 200,
        body: { outcome: "needs_confirm", workspaceId: "w1", name: "Payments", reason: "Busy." },
      },
    ];
    const host = await mount(detail());
    button(host, "Resolve conflicts")?.click();
    await waitFor(() => button(host, "Cancel") !== undefined, "the confirmation");
    button(host, "Cancel")?.click();
    await waitFor(() => button(host, "Resolve conflicts") !== undefined, "the button");
    expect(sent).toHaveLength(1);
  });

  it("reports an agent started in an idle workspace", async () => {
    replies = [{ status: 200, body: { outcome: "started", workspaceId: "w1", name: "Payments" } }];
    const host = await mount(detail());
    button(host, "Resolve conflicts")?.click();
    await waitFor(() => (host.textContent ?? "").includes("Started an agent"), "the result");
    expect(opened).toEqual([]);
  });

  it("switches to a workspace it had to create, as Start workspace does", async () => {
    replies = [{ status: 201, body: { outcome: "created", workspaceId: "w9", name: "PR #3" } }];
    const host = await mount(detail());
    button(host, "Resolve conflicts")?.click();
    await waitFor(() => opened.length > 0, "the hand-over");
    expect(opened).toEqual([{ id: "w9" }]);
    expect(host.textContent).toContain("Created “PR #3”");
  });

  it("shows the sidecar's refusal inline", async () => {
    replies = [
      { status: 400, body: { error: "this pull request's repository is not registered" } },
    ];
    const host = await mount(detail());
    button(host, "Resolve conflicts")?.click();
    await waitFor(() => host.querySelector('[role="alert"]') !== null, "the error");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("not registered");
  });
});
