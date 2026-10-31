import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { type OpenWorkspaceRequest, onOpenWorkspace } from "../../lib/nav";
import { prDetailKey } from "../../lib/pr/cache";
import type { PrDetail, PrRef } from "../../lib/pr/types";
import { cachedFetch, primeCache } from "../../lib/resourceCache";
import { mountForInteraction, renderToHtml, waitFor } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
import PrConflictBanner from "./PrConflictBanner";

interface SentRequest {
  path: string;
  body: Record<string, unknown> | null;
}

const sent: SentRequest[] = [];
/** What the sidecar answers the next resolve requests with, in order. */
let replies: { status: number; body: unknown }[] = [];
/** When set, replies wait on it. */
let holdReply: Promise<void> | null = null;

// The transport is stubbed rather than lib/pr/conflicts, so the path and body
// that client builds stay under test.
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
  sidecarFetch: async (path: string, init: RequestInit = {}) => {
    sent.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
    if (holdReply) await holdReply;
    const reply = replies.shift() ?? { status: 200, body: null };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  },
  streamSSE: async function* () {},
});

const ref: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 3 };
const azureRef: PrRef = { provider: "azure", org: "acme", project: "Shop", repo: "web", prId: 9 };

const detail = (over: Partial<PrDetail> = {}) =>
  ({
    state: "OPEN",
    baseRef: "main",
    headRef: "feat",
    fromFork: false,
    mergeable: "CONFLICTING",
    hasConflicts: true,
    ...over,
  }) as PrDetail;

let unmount = () => {};
let unsubscribe = () => {};
const opened: OpenWorkspaceRequest[] = [];

beforeEach(() => {
  sent.length = 0;
  replies = [];
  holdReply = null;
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
          detail: detail({ mergeable: "UNKNOWN", hasConflicts: true }),
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
      createElement(PrConflictBanner, {
        prRef: ref,
        detail: detail({ mergeable: "MERGEABLE", hasConflicts: false }),
      }),
    );
    expect(clean).not.toContain("Conflicts with");
    const computing = await renderToHtml(
      createElement(PrConflictBanner, {
        prRef: ref,
        detail: detail({ mergeable: "UNKNOWN", hasConflicts: false }),
      }),
    );
    expect(computing).not.toContain("Conflicts with");
  });

  // GitHub works mergeability out lazily, so the first read after a push often
  // can't say; one more look settles it without polling.
  it("refetches the detail once while mergeability is being computed", async () => {
    primeCache(prDetailKey(ref), detail({ mergeable: "UNKNOWN", hasConflicts: false }));
    await mount(detail({ mergeable: "UNKNOWN", hasConflicts: false }), ref, 20);
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

  // A pending permission prompt is refused by the sidecar outright; there is
  // nothing to confirm past.
  it("offers no way past a permission prompt", async () => {
    replies = [
      {
        status: 400,
        body: { error: "The agent is waiting on a permission prompt. Answer it first." },
      },
    ];
    const host = await mount(detail());
    button(host, "Resolve conflicts")?.click();
    await waitFor(() => host.querySelector('[role="alert"]') !== null, "the error");
    expect(host.textContent).toContain("permission prompt");
    expect(button(host, "Send anyway")).toBeUndefined();
  });

  it("sends once for a double click", async () => {
    let release = () => {};
    // Hold the request open so the second click lands while it is in flight.
    holdReply = new Promise<void>((resolve) => {
      release = resolve;
    });
    replies = [{ status: 200, body: { outcome: "sent", workspaceId: "w1", name: "Payments" } }];
    const host = await mount(detail());
    button(host, "Resolve conflicts")?.click();
    await waitFor(() => button(host, "Handing off…")?.disabled === true, "the busy button");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Handing the conflicts");
    button(host, "Handing off…")?.click();
    release();
    await waitFor(() => (host.textContent ?? "").includes("Sent to the agent"), "the result");
    expect(sent).toHaveLength(1);
  });

  it("asks before sending a second time", async () => {
    replies = [
      { status: 200, body: { outcome: "sent", workspaceId: "w1", name: "Payments" } },
      { status: 200, body: { outcome: "sent", workspaceId: "w1", name: "Payments" } },
    ];
    const host = await mount(detail());
    button(host, "Resolve conflicts")?.click();
    await waitFor(() => button(host, "Send again") !== undefined, "the result");
    expect(button(host, "Resolve conflicts")).toBeUndefined();

    button(host, "Send again")?.click();
    await waitFor(() => button(host, "Yes, send again") !== undefined, "the confirmation");
    expect(sent).toHaveLength(1);
    button(host, "Yes, send again")?.click();
    await waitFor(() => sent.length === 2, "the second send");
  });
});

afterAll(resetSidecarApi);
