import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { mountForInteraction } from "../../../test/render";
import type { Pane } from "./paneTree";
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

// The attention store hydrates and streams from the sidecar on mount. Both
// exports it uses are named rather than inherited from the real module: another
// test file may already have replaced `lib/api` wholesale, in which case the
// spread carries that file's stub rather than the real one.
const realApi = await import("../../../lib/api");

mock.module("../../../lib/api", () => ({
  ...realApi,
  sidecarFetch: async () => new Response("[]", { headers: { "content-type": "application/json" } }),
  streamSSE: async function* () {},
}));

// Imported after the mocks are registered so the component binds to the stubs.
const { default: TerminalTabs } = await import("./TerminalTabs");

const SURFACE_KEY = "ws:dimtest";

/** Class of the wash laid over an unfocused pane; see `PaneTreeView`. */
const DIM_CLASS = "bg-zinc-950/40";

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const terminalTab = (root: Pane, focused: string | null): SurfaceState => ({
  tabs: [{ id: "t1", title: "Terminal", kind: "terminal", root }],
  activeTabId: "t1",
  focused: focused ? { t1: focused } : {},
});

const split = (first: Pane, second: Pane): Pane => ({
  kind: "split",
  direction: "vertical",
  first,
  second,
});

const pane = (id: string): Pane => ({ kind: "leaf", id });

let unmount: (() => void) | null = null;
/** Set when this file installed the IntersectionObserver stub, so it can undo it. */
let installedObserver = false;

/** xterm's accessibility manager constructs one on open, and happy-dom has none. */
class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const globalWithObserver = globalThis as { IntersectionObserver?: unknown };

async function mountTabs(state: SurfaceState): Promise<HTMLElement> {
  localStorage.setItem(storageKeyFor(SURFACE_KEY), JSON.stringify(state));
  const mounted = await mountForInteraction(
    createElement(TerminalTabs, { storageKey: SURFACE_KEY }),
  );
  unmount = mounted.unmount;
  return mounted.host;
}

/** Pane ids whose wrapper carries the wash, in document order. */
const dimmedPaneIds = (host: HTMLElement) =>
  [...host.querySelectorAll(`[class~="${DIM_CLASS}"]`)].map(
    (wash) => wash.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? "?",
  );

beforeEach(() => {
  localStorage.clear();
  if (!globalWithObserver.IntersectionObserver) {
    globalWithObserver.IntersectionObserver = NoopIntersectionObserver;
    installedObserver = true;
  }
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

afterAll(() => {
  // Another file may assert on the absence of one, which is production code's
  // own feature-detect (`useExpandOnApproach`).
  if (installedObserver) globalWithObserver.IntersectionObserver = undefined;
});

describe("split pane dimming", () => {
  it("washes every pane in a split but the one clicked into", async () => {
    const host = await mountTabs(
      terminalTab(split(pane("pA"), split(pane("pB"), pane("pC"))), "pA"),
    );

    host
      .querySelector('[data-pane-id="pB"]')
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await settle();

    expect(dimmedPaneIds(host)).toEqual(["pA", "pC"]);
  });

  it("lets a click through to the pane under the wash", async () => {
    const host = await mountTabs(terminalTab(split(pane("pA"), pane("pB")), "pA"));

    const wash = host.querySelector(`[class~="${DIM_CLASS}"]`);
    // happy-dom has no hit testing, so the class is the only evidence available
    // that the wash does not swallow the mousedown that focuses the pane.
    expect(wash?.className ?? "").toContain("pointer-events-none");
  });

  it("does not wash a tab's only pane, even with no pane focused", async () => {
    const host = await mountTabs(terminalTab(pane("pA"), null));

    expect(dimmedPaneIds(host)).toEqual([]);
  });

  it("washes one pane when the persisted focus names a pane that is gone", async () => {
    const host = await mountTabs(terminalTab(split(pane("pA"), pane("pB")), "stale"));

    expect(dimmedPaneIds(host)).toHaveLength(1);
  });

  it("clears the wash when closing a pane collapses the split", async () => {
    const host = await mountTabs(terminalTab(split(pane("pA"), pane("pB")), "pA"));

    const closeButtons = host.querySelectorAll('[aria-label="Close pane"]');
    expect(closeButtons).toHaveLength(2);
    closeButtons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(host.querySelectorAll("[data-pane-id]")).toHaveLength(1);
    expect(dimmedPaneIds(host)).toEqual([]);
  });
});
