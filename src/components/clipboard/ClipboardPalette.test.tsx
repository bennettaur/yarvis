import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { ClipboardEntry } from "../../lib/clipboard";
import { nativeInvoke } from "../../test/nativeInvoke";
import { mountForInteraction, renderToHtml } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
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
    const body = path.startsWith("/api/clipboard/scan")
      ? { flagged: [{ id: "clip-1", kind: "aws-access-key-id", reason: "looks like a key" }] }
      : ENTRIES;
    return new Response(JSON.stringify(body), { status: 200 });
  },
});

// The entry list is debounced, so the render has to settle past the debounce.
const SETTLE_MS = 400;
/** Long enough for a tab click's state change to render. */
const TAB_SWITCH_MS = 50;

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

  it("keeps history off the Saved tab", async () => {
    const html = await renderToHtml(
      createElement(ClipboardPalette, { open: true, onClose: () => {} }),
      SETTLE_MS,
    );
    expect(html).not.toContain("kubectl -n production get pods");
    expect(html).not.toContain("Clear history");
    expect(html).not.toContain("clip hidden");
    expect(html).toContain("New entry");
  });

  describe("History tab", () => {
    let unmount: (() => void) | undefined;
    afterEach(() => unmount?.());

    async function openHistoryTab() {
      const mounted = await mountForInteraction(
        createElement(ClipboardPalette, { open: true, onClose: () => {} }),
        SETTLE_MS,
      );
      unmount = mounted.unmount;
      const historyTab = [...mounted.host.querySelectorAll("button[aria-pressed]")].find(
        (el) => el.textContent === "History",
      ) as HTMLElement | undefined;
      if (!historyTab) throw new Error("History tab not rendered");
      historyTab.click();
      await new Promise((resolve) => setTimeout(resolve, TAB_SWITCH_MS));
      return { host: mounted.host, historyTab };
    }

    it("offers a safe clip and withholds a flagged one, without saved entries", async () => {
      const { host, historyTab } = await openHistoryTab();
      const html = host.innerHTML;
      expect(historyTab.getAttribute("aria-pressed")).toBe("true");
      expect(html).toContain("kubectl -n production get pods");
      expect(html).toContain('aria-label="Save this clip as an entry"');
      // The credential-shaped clip must not reach the screen at all.
      expect(html).not.toContain("AKIAIOSFODNN7EXAMPLE");
      // …and the palette says one was withheld rather than quietly showing less.
      expect(html).toContain("1 clip hidden");
      expect(html).not.toContain("Staging identity");
    });

    it("swaps the tab's own controls in", async () => {
      const { host } = await openHistoryTab();
      const html = host.innerHTML;
      expect(html).toContain("Clear history");
      expect(html).not.toContain("New entry");
    });
  });
});

afterAll(resetSidecarApi);
