import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import * as realApi from "../../lib/api";
import type { AttentionItem } from "../../lib/attention";
import { loadAttentionSweep } from "../../lib/attentionSweep";
import { mountForInteraction, renderToHtml } from "../../test/render";

let pending: AttentionItem[] = [];
// Sends a frame down the open attention stream, as the sidecar would.
let pushFrame: (data: string) => void = () => {};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

mock.module("../../lib/api", () => ({
  ...realApi,
  getHealth: async () => ({
    status: "ok",
    service: "sidecar",
    uptimeMs: 0,
    ready: true,
    phase: "ready" as const,
  }),
  sidecarFetch: async (path: string) =>
    path.startsWith("/api/attention") ? json(pending) : json([]),
  // Stays open until the store aborts it, so a test can stream items in.
  streamSSE: async function* (_path: string, init: RequestInit = {}) {
    const queue: string[] = [];
    let wake = () => {};
    pushFrame = (data) => {
      queue.push(data);
      wake();
    };
    init.signal?.addEventListener("abort", () => wake());
    while (!init.signal?.aborted) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  },
}));

afterAll(() => {
  mock.module("../../lib/api", () => realApi);
});

const TopBar = (await import("./TopBar")).default;

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

const item = (id: string, seq: number): AttentionItem => ({
  id,
  seq,
  source: "claude-hook",
  sessionKey: null,
  workspaceId: `ws-${id}`,
  kind: "permission",
  title: "Permission needed",
  body: null,
  status: "pending",
  navTarget: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

describe("TopBar attention animation", () => {
  it("sweeps the bar and rings the bell while something is pending", async () => {
    pending = [item("a", 2), item("b", 1)];
    const html = await renderToHtml(<TopBar title="Chat" onOpenAttention={() => {}} />);

    expect(html).toContain('data-testid="attention-sweep"');
    expect(html).toContain("yarvis-bell-ring");
  });

  it("restarts the sweep and the bell when a newer item arrives, and only then", async () => {
    pending = [item("a", 2)];
    const mounted = await mountForInteraction(<TopBar title="Chat" onOpenAttention={() => {}} />);
    unmount = mounted.unmount;
    const sweep = () => mounted.host.querySelector('[data-testid="attention-sweep"]');
    const bell = () => mounted.host.querySelector("svg");
    const firstSweep = sweep();
    const firstBell = bell();
    expect(firstSweep).not.toBeNull();

    // An update to an item already on screen keeps the cycle running as it was.
    pushFrame(JSON.stringify({ type: "item", item: { ...item("a", 2), title: "Edited" } }));
    await settle();
    expect(sweep()).toBe(firstSweep);
    expect(bell()).toBe(firstBell);

    pushFrame(JSON.stringify({ type: "item", item: item("c", 5) }));
    await settle();
    expect(sweep()).not.toBeNull();
    expect(sweep()).not.toBe(firstSweep);
    expect(bell()).not.toBe(firstBell);

    // Clearing the newest item leaves an older one as the newest; that is no
    // reason to announce again.
    const afterArrival = sweep();
    pushFrame(JSON.stringify({ type: "item", item: { ...item("c", 5), status: "dismissed" } }));
    await settle();
    expect(sweep()).toBe(afterArrival);
  });

  it("rings the bell without the sweep when the sweep is turned off", async () => {
    pending = [item("a", 2)];
    loadAttentionSweep(false);
    try {
      const html = await renderToHtml(<TopBar title="Chat" onOpenAttention={() => {}} />);
      expect(html).not.toContain('data-testid="attention-sweep"');
      expect(html).toContain("yarvis-bell-ring");
    } finally {
      loadAttentionSweep(null);
    }
  });

  // Runs last so the shared store is left empty for any later test file.
  it("stays still when nothing is pending", async () => {
    pending = [];
    const html = await renderToHtml(<TopBar title="Chat" onOpenAttention={() => {}} />);

    expect(html).not.toContain('data-testid="attention-sweep"');
    expect(html).not.toContain("yarvis-bell-ring");
  });
});
