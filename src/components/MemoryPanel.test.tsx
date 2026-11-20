import { afterAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToHtml, textOf } from "../test/render";
import { resetSidecarApi, stubSidecarApi } from "../test/sidecarApi";

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
  streamSSE: async function* streamSSE() {},
  sidecarFetch: async (path: string) => {
    const body = path.startsWith("/api/memory")
      ? { items: [], total: 0, limit: 50, offset: 0 }
      : { types: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});

const MemoryPanel = (await import("./MemoryPanel")).default;

describe("MemoryPanel", () => {
  it("offers the four views of what the assistant knows", async () => {
    const text = textOf(await renderToHtml(createElement(MemoryPanel)));
    for (const label of ["Memories", "Activity", "Agent todos", "Projects"]) {
      expect(text).toContain(label);
    }
  });

  it("opens on the memory library", async () => {
    const text = textOf(await renderToHtml(createElement(MemoryPanel)));
    // The library's own sections, not the activity log's.
    expect(text).toContain("Recap");
    expect(text).toContain("Quick note");
    expect(text).not.toContain("Search events…");
  });
});

afterAll(resetSidecarApi);
