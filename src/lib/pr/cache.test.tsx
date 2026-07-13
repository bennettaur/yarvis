import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// The cache module reads these from ./api at import time; stub the detail
// loader so we control what each (re)fetch resolves to without hitting a
// provider transport.
let draft = true;
let fetchCount = 0;
mock.module("./api", () => ({
  fetchPrDetail: async () => {
    fetchCount++;
    return { draft };
  },
  fetchPrFiles: async () => [],
  fetchPrStatus: async () => ({}),
  fetchPrFileDiff: async () => undefined,
}));

import { invalidate, prDetailKey, usePrDetail } from "./cache";
import type { PrRef } from "./types";

const ref: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 7 };

// Renders detail as "draft" / "open" / "loading" so a subscriber's live state
// is observable in the DOM. `subject` lets a case exercise the null-key path.
function Probe({ subject }: { subject: PrRef | null }) {
  const { data } = usePrDetail(subject);
  return createElement("span", null, data ? (data.draft ? "draft" : "open") : "loading");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

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
    invalidate(prDetailKey(ref));
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
