import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToHtml, textOf } from "../test/render";

mock.module("../lib/api", () => ({
  sidecarFetch: async (path: string) => {
    const body = path.startsWith("/api/memory")
      ? { items: [], total: 0, limit: 50, offset: 0 }
      : { types: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

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
