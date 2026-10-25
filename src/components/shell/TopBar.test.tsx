import { afterAll, describe, expect, it, mock } from "bun:test";
import * as realApi from "../../lib/api";
import type { AttentionItem } from "../../lib/attention";
import { renderToHtml } from "../../test/render";

let pending: AttentionItem[] = [];

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
  // The attention store subscribes to an SSE stream; an empty one keeps it quiet.
  streamSSE: async function* () {},
}));

afterAll(() => {
  mock.module("../../lib/api", () => realApi);
});

const TopBar = (await import("./TopBar")).default;

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

  // Runs last so the shared store is left empty for any later test file.
  it("stays still when nothing is pending", async () => {
    pending = [];
    const html = await renderToHtml(<TopBar title="Chat" onOpenAttention={() => {}} />);

    expect(html).not.toContain('data-testid="attention-sweep"');
    expect(html).not.toContain("yarvis-bell-ring");
  });
});
