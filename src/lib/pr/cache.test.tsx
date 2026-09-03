import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// The cache module reads these from ./api at import time; stub the detail
// loader so we control what each (re)fetch resolves to without hitting a
// provider transport. `loadMs` holds a fetch open so a case can look at what
// the hook renders while one is in flight.
let draft = true;
let fetchCount = 0;
let loadMs = 0;
mock.module("./api", () => ({
  fetchPrDetail: async (ref: PrRef) => {
    fetchCount++;
    if (loadMs > 0) await new Promise((resolve) => setTimeout(resolve, loadMs));
    return { draft, number: ref.provider === "github" ? ref.number : ref.prId };
  },
  fetchPrFiles: async () => [],
  fetchPrStatus: async () => ({}),
  fetchPrFileDiff: async () => undefined,
}));

import { invalidate, prDetailKey, usePrDetail } from "./cache";
import type { PrRef } from "./types";

const ref: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 7 };
/** A second pull request, for moving a mounted hook from one key to another. */
const otherRef: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 8 };

// Renders detail as "draft" / "open" / "loading" so a subscriber's live state
// is observable in the DOM. `subject` lets a case exercise the null-key path.
function Probe({ subject }: { subject: PrRef | null }) {
  const { data } = usePrDetail(subject);
  return createElement("span", null, data ? (data.draft ? "draft" : "open") : "loading");
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// Renders which pull request the resolved detail describes, so a case can tell
// a stale value apart from the one belonging to the current key.
function Numbered({ subject }: { subject: PrRef }) {
  const { data } = usePrDetail(subject);
  return createElement("span", null, data ? `#${data.number}` : "loading");
}

// Mounts an element into a detached host, returning the host and root so a case
// can read the DOM, invalidate, and unmount at will — `renderToHtml` can't
// express the mount → invalidate → re-read flow these cases need.
function mount(element: ReturnType<typeof createElement>): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(element);
  return { host, root };
}

describe("cache invalidation", () => {
  beforeEach(() => {
    // Reset the stubbed loader and drop any cached entry / listeners so cases
    // reusing `ref` stay independent of each other.
    draft = true;
    fetchCount = 0;
    loadMs = 0;
    invalidate(prDetailKey(ref));
    invalidate(prDetailKey(otherRef));
  });

  it("refetches a mounted subscriber when its key is invalidated", async () => {
    draft = true;
    const { host, root } = mount(createElement(Probe, { subject: ref }));
    await settle();
    expect(host.textContent).toBe("draft");
    expect(fetchCount).toBe(1);

    // Simulate the "Ready for review" write: the PR is now open, and the write
    // handler invalidates the cached detail. The mounted probe must refetch and
    // flip to "open" without remounting.
    draft = false;
    invalidate(prDetailKey(ref));
    await settle();
    expect(host.textContent).toBe("open");
    expect(fetchCount).toBe(2);

    root.unmount();
    host.remove();
  });

  it("stops refetching once a subscriber unmounts", async () => {
    const { host, root } = mount(createElement(Probe, { subject: ref }));
    await settle();
    expect(fetchCount).toBe(1);

    root.unmount();
    host.remove();

    // With no mounted subscriber the listener must have been removed, so an
    // invalidation triggers no further fetch.
    invalidate(prDetailKey(ref));
    await settle();
    expect(fetchCount).toBe(1);
  });

  it("refetches every subscriber sharing a key on a single invalidation", async () => {
    draft = true;
    const a = mount(createElement(Probe, { subject: ref }));
    const b = mount(createElement(Probe, { subject: ref }));
    await settle();
    expect(a.host.textContent).toBe("draft");
    expect(b.host.textContent).toBe("draft");
    // Both probes share one in-flight fetch (cachedFetch joins concurrent
    // callers), so the initial load counts once.
    expect(fetchCount).toBe(1);

    draft = false;
    invalidate(prDetailKey(ref));
    await settle();
    expect(a.host.textContent).toBe("open");
    expect(b.host.textContent).toBe("open");
    // One shared refetch for both subscribers, not one per subscriber.
    expect(fetchCount).toBe(2);

    a.root.unmount();
    a.host.remove();
    b.root.unmount();
    b.host.remove();
  });

  // Clicking a layer of a stack points this hook at another pull request. The
  // detail already on screen belongs to the layer just left, so keeping it
  // would title the new review page with the old PR — which reads as a click
  // that did nothing (#268).
  it("drops the value it was showing when the key changes", async () => {
    const { host, root } = mount(createElement(Numbered, { subject: ref }));
    await settle();
    expect(host.textContent).toBe("#7");

    loadMs = 60;
    root.render(createElement(Numbered, { subject: otherRef }));
    await settle();
    expect(host.textContent).toBe("loading");

    await settle(120);
    expect(host.textContent).toBe("#8");

    root.unmount();
    host.remove();
  });

  // The counterpart: a write invalidates the key the hook is already on, and
  // blanking the header for the length of a refetch would flicker after every
  // approve or merge.
  it("keeps the value it is showing while the same key refetches", async () => {
    const { host, root } = mount(createElement(Numbered, { subject: ref }));
    await settle();
    expect(host.textContent).toBe("#7");

    loadMs = 60;
    invalidate(prDetailKey(ref));
    await settle();
    expect(host.textContent).toBe("#7");

    root.unmount();
    host.remove();
  });

  it("never subscribes or fetches for a null key", async () => {
    const { host, root } = mount(createElement(Probe, { subject: null }));
    await settle();
    expect(host.textContent).toBe("loading");
    expect(fetchCount).toBe(0);

    // A null-key hook registers no listener, so invalidation is a no-op for it.
    invalidate(prDetailKey(ref));
    await settle();
    expect(fetchCount).toBe(0);

    root.unmount();
    host.remove();
  });
});
