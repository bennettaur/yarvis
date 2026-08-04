import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { ClipboardEntry } from "../../lib/clipboard";
import { nativeInvoke } from "../../test/nativeInvoke";
import { renderToHtml } from "../../test/render";
import ClipboardPalette from "./ClipboardPalette";

const ENTRIES: ClipboardEntry[] = [
  {
    id: "entry-1",
    label: "Staging identity",
    content: "3f8a1c22-9b4e-4d2f-8a6c-1e5b7d9f0a31",
    tags: ["staging"],
    pinned: true,
    useCount: 4,
    lastUsedAt: "2026-06-17T09:00:00.000Z",
    createdAt: "2026-06-01T09:00:00.000Z",
    updatedAt: "2026-06-01T09:00:00.000Z",
  },
];

/** One safe clip and one that the sidecar's screen flags as a credential. */
const HISTORY = [
  { id: "clip-2", text: "kubectl -n production get pods", capturedAtMs: 1_781_000_000_000 },
  { id: "clip-1", text: "AKIAIOSFODNN7EXAMPLE", capturedAtMs: 1_780_000_000_000 },
];

// A module mock replaces `@tauri-apps/api/core` for the whole run, so anything
// this file doesn't answer delegates to the shared defaults rather than
// returning undefined to a suite that runs after it.
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string) =>
    command === "clipboard_history" ? HISTORY : nativeInvoke(command),
}));

mock.module("../../lib/api", () => ({
  sidecarFetch: async (path: string) => {
    const body = path.startsWith("/api/clipboard/scan")
      ? { flagged: [{ id: "clip-1", kind: "aws-access-key-id", reason: "looks like a key" }] }
      : ENTRIES;
    return new Response(JSON.stringify(body), { status: 200 });
  },
  ensureOk: async (res: Response, context: string) => {
    if (!res.ok) throw new Error(`${context} failed: ${res.status}`);
  },
}));

// The entry list is debounced, so the render has to settle past the debounce.
const SETTLE_MS = 400;

describe("ClipboardPalette", () => {
  it("renders nothing while closed", async () => {
    const html = await renderToHtml(
      createElement(ClipboardPalette, { open: false, onClose: () => {} }),
      SETTLE_MS,
    );
    expect(html).toBe("");
  });

  it("lists saved entries with their tags and a content preview", async () => {
    const html = await renderToHtml(
      createElement(ClipboardPalette, { open: true, onClose: () => {} }),
      SETTLE_MS,
    );
    expect(html).toContain("Staging identity");
    expect(html).toContain("3f8a1c22-9b4e-4d2f-8a6c-1e5b7d9f0a31");
    expect(html).toContain("staging");
    expect(html).toContain('aria-label="Unpin entry"');
    expect(html).toContain('aria-label="Delete entry"');
  });

  it("offers a safe clip from history and withholds a flagged one", async () => {
    const html = await renderToHtml(
      createElement(ClipboardPalette, { open: true, onClose: () => {} }),
      SETTLE_MS,
    );
    expect(html).toContain("kubectl -n production get pods");
    expect(html).toContain('aria-label="Save this clip as an entry"');
    // The credential-shaped clip must not reach the screen at all.
    expect(html).not.toContain("AKIAIOSFODNN7EXAMPLE");
    // …and the palette says one was withheld rather than quietly showing less.
    expect(html).toContain("1 clip hidden");
  });
});
