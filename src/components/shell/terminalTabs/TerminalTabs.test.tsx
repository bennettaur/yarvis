import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { mountForInteraction } from "../../../test/render";
import { storageKeyFor } from "./sessionIds";
import type { SurfaceState } from "./surfaceState";

// A module mock replaces `lib/pty` for the whole test run; the real exports are
// spread back in so files reached transitively still link on what they import.
const realPty = await import("../../../lib/pty");

mock.module("../../../lib/pty", () => ({
  ...realPty,
  attachPty: async () => ({ scrollback: [], endOffset: 0 }),
  writePty: async () => {},
  resizePty: async () => {},
  killPty: async () => {},
  isPtyBusy: async () => false,
  onPtyOutput: async () => () => {},
  onPtyExit: async () => () => {},
}));

// The attention store hydrates and streams from the sidecar on mount; stubbed so
// these tests neither reach the network nor log a retry loop.
const realApi = await import("../../../lib/api");

mock.module("../../../lib/api", () => ({
  ...realApi,
  sidecarFetch: async () => new Response("[]", { headers: { "content-type": "application/json" } }),
}));

// Imported after the mock is registered so the component binds to the stubs.
const { default: TerminalTabs } = await import("./TerminalTabs");

const SURFACE = "tab:dimtest";

/** Class of the wash laid over an unfocused pane; see `PaneTreeView`. */
const DIM_CLASS = "bg-zinc-950/40";

function persist(state: SurfaceState) {
  localStorage.setItem(storageKeyFor(SURFACE), JSON.stringify(state));
}

const splitState: SurfaceState = {
  tabs: [
    {
      id: "t1",
      title: "Terminal",
      kind: "terminal",
      root: {
        kind: "split",
        direction: "vertical",
        first: { kind: "leaf", id: "pA" },
        second: { kind: "leaf", id: "pB" },
      },
    },
  ],
  activeTabId: "t1",
  focused: { t1: "pA" },
};

const dimmedPanes = (host: HTMLElement) => host.querySelectorAll(`[class*="${DIM_CLASS}"]`).length;

/** xterm's accessibility manager constructs one on open, and happy-dom has none. */
class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

beforeEach(() => {
  localStorage.clear();
  const global = globalThis as { IntersectionObserver?: unknown };
  if (!global.IntersectionObserver) global.IntersectionObserver = NoopIntersectionObserver;
});

describe("split pane dimming", () => {
  it("dims every pane but the focused one", async () => {
    persist(splitState);

    const { host, unmount } = await mountForInteraction(
      createElement(TerminalTabs, { storageKey: SURFACE }),
    );
    try {
      expect(dimmedPanes(host)).toBe(1);
    } finally {
      unmount();
    }
  });

  it("leaves an unsplit tab undimmed, wherever the keyboard is", async () => {
    persist({
      tabs: [{ id: "t1", title: "Terminal", kind: "terminal", root: { kind: "leaf", id: "pA" } }],
      activeTabId: "t1",
      focused: {},
    });

    const { host, unmount } = await mountForInteraction(
      createElement(TerminalTabs, { storageKey: SURFACE }),
    );
    try {
      expect(dimmedPanes(host)).toBe(0);
    } finally {
      unmount();
    }
  });

  it("moves the dimming when another pane takes focus", async () => {
    persist(splitState);

    const { host, unmount } = await mountForInteraction(
      createElement(TerminalTabs, { storageKey: SURFACE }),
    );
    try {
      const dimmed = host.querySelector(`[class*="${DIM_CLASS}"]`);
      // The wash covers the unfocused pane, so its own pane wrapper is the one
      // that must stop being dimmed once clicked.
      const unfocusedPane = dimmed?.parentElement;
      expect(unfocusedPane).toBeTruthy();

      unfocusedPane?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(dimmedPanes(host)).toBe(1);
      expect(unfocusedPane?.querySelector(`[class*="${DIM_CLASS}"]`)).toBeNull();
    } finally {
      unmount();
    }
  });
});
