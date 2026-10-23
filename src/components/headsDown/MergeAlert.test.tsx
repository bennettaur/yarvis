import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { AttentionItem } from "../../lib/attention";
import { mountForInteraction } from "../../test/render";

const MERGE: AttentionItem = {
  id: "a1",
  seq: 2,
  source: "system",
  sessionKey: "heads-down-merge:acme/infra#7",
  workspaceId: null,
  kind: "info",
  title: "Heads down is merging acme/infra#7",
  body: "Bump the load balancer timeout",
  status: "pending",
  navTarget: { type: "pr", owner: "acme", repo: "infra", number: 7 },
  payload: {
    headsDownMerge: {
      repo: "acme/infra",
      number: 7,
      title: "Bump the load balancer timeout",
      risk: "high",
      why: "You approved it when I asked.",
    },
  },
  createdAt: "2026-10-22T15:00:00Z",
  updatedAt: "2026-10-22T15:00:00Z",
};

/** An ordinary bell item, which mustn't pop up. */
const OTHER: AttentionItem = {
  ...MERGE,
  id: "a2",
  seq: 1,
  sessionKey: "heads-down:q1",
  title: "Heads down has a question",
  payload: null,
};

let pending: AttentionItem[] = [];
const patches: { path: string; body: unknown }[] = [];

// Only the transport is stubbed; see ScheduledJobsPanel.test.tsx for why the
// rest of the module is kept.
const actualApi = await import("../../lib/api");
mock.module("../../lib/api", () => ({
  ...actualApi,
  sidecarInfo: async () => ({ port: 0, token: "test-token" }),
  // Held open until the store stops, so it doesn't loop on reconnects.
  streamSSE: (_path: string, init?: RequestInit) =>
    (async function* () {
      await new Promise<void>((resolve) => {
        const signal = init?.signal;
        if (!signal || signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    })(),
  sidecarFetch: async (path: string, init?: RequestInit) => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (init?.method === "PATCH") {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      patches.push({ path, body });
      return json({ ...MERGE, status: body?.status });
    }
    if (path.startsWith("/api/attention")) return json(pending);
    return new Response("{}", { status: 404 });
  },
}));

const MergeAlert = (await import("./MergeAlert")).default;

const mounted: (() => void)[] = [];
const opened: AttentionItem[] = [];

async function mount() {
  const view = await mountForInteraction(
    createElement(MergeAlert, { onOpen: (item: AttentionItem) => opened.push(item) }),
  );
  mounted.push(view.unmount);
  return view.host;
}

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  pending = [];
  patches.length = 0;
  opened.length = 0;
});

describe("MergeAlert", () => {
  it("pops up a pending merge with its risk, and ignores other bell items", async () => {
    pending = [MERGE, OTHER];
    const host = await mount();

    const dialog = host.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Heads down is merging a PR");
    expect(dialog?.textContent).toContain("acme/infra#7");
    expect(dialog?.textContent).toContain("High risk");
    expect(dialog?.textContent).toContain("You approved it when I asked.");
    expect(dialog?.textContent).not.toContain("more merge");
  });

  it("clears the item when dismissed", async () => {
    pending = [MERGE];
    const host = await mount();

    [...host.querySelectorAll("button")].find((b) => b.textContent === "Got it")?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(patches).toEqual([{ path: "/api/attention/a1", body: { status: "dismissed" } }]);
  });

  it("shows nothing when no merge is waiting", async () => {
    pending = [OTHER];
    const host = await mount();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
