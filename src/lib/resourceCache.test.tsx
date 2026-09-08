import { beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  clearResourceCache,
  combineResources,
  invalidate,
  invalidatePrefix,
  primeCache,
  type Resource,
  useCachedResource,
} from "./resourceCache";

/** What the stub loader resolves to, and how many times it has been called. */
let value = "first";
let fetchCount = 0;
/** Holds a load open so a case can look at what the hook renders mid-flight. */
let loadMs = 0;
/** When set, the loader rejects with this message instead of resolving. */
let failWith: string | null = null;
/**
 * Per-call answers, consumed in order, for a case that needs two loads of the
 * same key to differ — a slow one overtaken by a fast one, say. Falls back to
 * the flags above once exhausted.
 */
let script: { value?: string; ms?: number; fail?: string }[] = [];

async function load(): Promise<string> {
  fetchCount++;
  const step = script.shift();
  const ms = step?.ms ?? loadMs;
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  const fail = step?.fail ?? failWith;
  if (fail) throw new Error(fail);
  return step?.value ?? value;
}

/** Every state the probe has rendered, in order. React commits asynchronously,
 *  so "what did the user actually see" is a question about the sequence rather
 *  than about the DOM at any one instant. */
const rendered: string[] = [];

/** The sequence with consecutive repeats collapsed — React is free to re-render
 *  a component that produced the same output, and that is not a state change. */
function statesSeen(): string[] {
  return rendered.filter((state, i) => state !== rendered[i - 1]);
}

/**
 * Renders the three states a surface distinguishes — nothing to show, data with
 * a load behind it, settled data — so a case can read them out of the DOM.
 */
function Probe({ subject }: { subject: string | null }) {
  const { data, loading, refreshing, error } = useCachedResource(subject, load);
  const state = loading ? "loading" : refreshing ? "refreshing" : "idle";
  const text = `${data ?? "-"}/${state}/${error ?? "-"}`;
  rendered.push(text);
  return createElement("span", null, text);
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(element: ReturnType<typeof createElement>): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(element);
  return { host, root };
}

beforeEach(() => {
  clearResourceCache();
  value = "first";
  fetchCount = 0;
  loadMs = 0;
  failWith = null;
  script = [];
  rendered.length = 0;
});

describe("useCachedResource", () => {
  it("reports a first load as loading, with nothing to show", async () => {
    loadMs = 40;
    const { host, root } = mount(createElement(Probe, { subject: "k" }));
    await settle(10);
    expect(host.textContent).toBe("-/loading/-");
    await settle(60);
    expect(host.textContent).toBe("first/idle/-");
    root.unmount();
  });

  it("paints a remount from the cache instead of an empty first frame", async () => {
    const first = mount(createElement(Probe, { subject: "k" }));
    await settle();
    first.root.unmount();

    // What a tab switch does: the panel is gone and comes back a moment later.
    rendered.length = 0;
    const second = mount(createElement(Probe, { subject: "k" }));
    await settle();
    // The point of the cache: not one frame of the remount is empty.
    expect(statesSeen()).toEqual(["first/idle/-"]);
    second.root.unmount();
  });

  it("refreshes behind the cached data once it goes stale", async () => {
    const { root } = mount(createElement(Probe, { subject: "k" }));
    await settle();
    expect(fetchCount).toBe(1);

    value = "second";
    loadMs = 40;
    // A remount inside the TTL serves the cache without reaching the network.
    root.unmount();
    const warm = mount(createElement(Probe, { subject: "k" }));
    await settle(10);
    expect(fetchCount).toBe(1);
    expect(warm.host.textContent).toBe("first/idle/-");
    warm.root.unmount();

    // Forcing past the TTL is what a stale entry does: the old value stays on
    // screen, marked as refreshing, until the new one lands.
    const stale = mount(createElement(Probe, { subject: "k" }));
    await settle(10);
    invalidate("k");
    await settle(10);
    expect(stale.host.textContent).toBe("first/refreshing/-");
    await settle(60);
    expect(stale.host.textContent).toBe("second/idle/-");
    stale.root.unmount();
  });

  it("keeps the cached data on screen when a refresh fails", async () => {
    const { host, root } = mount(createElement(Probe, { subject: "k" }));
    await settle();
    expect(host.textContent).toBe("first/idle/-");

    // A failed background refresh is no reason to take the list away — the
    // error is reported beside the data the user was already reading.
    failWith = "sidecar down";
    invalidate("k");
    await settle();
    expect(host.textContent).toBe("first/idle/sidecar down");
    root.unmount();
  });

  it("seeds a key change from that key's own cache, not the previous key's", async () => {
    const { host, root } = mount(createElement(Probe, { subject: "a" }));
    await settle();
    expect(host.textContent).toBe("first/idle/-");

    value = "second";
    loadMs = 40;
    root.render(createElement(Probe, { subject: "b" }));
    await settle(10);
    // "a"'s value must not be shown under "b" — a different key is a different
    // resource, and there is nothing cached for it yet.
    expect(host.textContent).toBe("-/loading/-");
    await settle(60);
    expect(host.textContent).toBe("second/idle/-");
    root.unmount();
  });

  it("fetches nothing while the key is null", async () => {
    const { host, root } = mount(createElement(Probe, { subject: null }));
    await settle();
    expect(fetchCount).toBe(0);
    expect(host.textContent).toBe("-/idle/-");
    root.unmount();
  });

  it("joins one in-flight load for concurrent subscribers on a key", async () => {
    loadMs = 40;
    const a = mount(createElement(Probe, { subject: "k" }));
    const b = mount(createElement(Probe, { subject: "k" }));
    await settle(60);
    expect(fetchCount).toBe(1);
    expect(a.host.textContent).toBe("first/idle/-");
    expect(b.host.textContent).toBe("first/idle/-");
    a.root.unmount();
    b.root.unmount();
  });

  it("primes through an updater, so a load landing in between isn't clobbered", async () => {
    primeCache("k", ["a"]);
    primeCache<string[]>("k", (current) => [...(current ?? []), "b"]);
    const { host, root } = mount(
      createElement(function Probe2() {
        const { data } = useCachedResource<string[]>("k", async () => []);
        return createElement("span", null, (data ?? []).join(","));
      }),
    );
    await settle();
    expect(host.textContent).toBe("a,b");
    root.unmount();
  });

  it("hands the updater null while a load is in flight, not the value it will get", async () => {
    // The trap this pins: an updater that treats null as "empty" would write an
    // empty value over a load about to fill it, and the identity guard in
    // `cachedFetch` means that load can no longer put it back.
    loadMs = 60;
    const { root } = mount(createElement(Probe, { subject: "k" }));
    await settle(10);
    let seen: string | null | undefined;
    primeCache<string>("k", (current) => {
      seen = current;
      return "primed";
    });
    expect(seen).toBeNull();
    await settle(100);
    root.unmount();
  });

  it("primes a value a caller already has, without a load", async () => {
    primeCache("k", "polled");
    const { host, root } = mount(createElement(Probe, { subject: "k" }));
    await settle();
    expect(statesSeen()).toEqual(["polled/idle/-"]);
    expect(host.textContent).toBe("polled/idle/-");
    expect(fetchCount).toBe(0);
    root.unmount();
  });

  it("ignores a superseded load's value, however late it lands", async () => {
    // The first load is still in flight when the key is invalidated, and it
    // resolves after the load that replaced it. Writing it back would leave the
    // cache holding the older answer under a fresh timestamp — so the next
    // visit would paint stale data, which is what this cache exists to avoid.
    script = [
      { value: "slow", ms: 60 },
      { value: "fast", ms: 0 },
    ];
    const first = mount(createElement(Probe, { subject: "k" }));
    await settle(10);
    invalidate("k");
    await settle(100);
    first.root.unmount();

    const revisit = mount(createElement(Probe, { subject: "k" }));
    await settle();
    expect(revisit.host.textContent).toBe("fast/idle/-");
    revisit.root.unmount();
  });

  it("ignores a superseded load's failure, however late it lands", async () => {
    // The mirror case: the stale load rejects, and dropping the entry on its way
    // out would discard the newer load's value and send the next caller back to
    // the provider this cache exists to spare.
    script = [
      { fail: "gone", ms: 60 },
      { value: "fast", ms: 0 },
    ];
    const first = mount(createElement(Probe, { subject: "k" }));
    await settle(10);
    invalidate("k");
    await settle(100);
    first.root.unmount();

    fetchCount = 0;
    const revisit = mount(createElement(Probe, { subject: "k" }));
    await settle();
    expect(revisit.host.textContent).toBe("fast/idle/-");
    expect(fetchCount).toBe(0);
    revisit.root.unmount();
  });

  it("reloads every mounted key under an invalidated prefix", async () => {
    const a = mount(createElement(Probe, { subject: "issues:a" }));
    const b = mount(createElement(Probe, { subject: "issues:b" }));
    const other = mount(createElement(Probe, { subject: "prs:a" }));
    await settle();
    expect(fetchCount).toBe(3);

    invalidatePrefix("issues:");
    await settle();
    expect(fetchCount).toBe(5);

    a.root.unmount();
    b.root.unmount();
    other.root.unmount();
  });
});

describe("combineResources", () => {
  const resource = (over: Partial<Resource<unknown>>): Resource<unknown> => ({
    data: null,
    error: null,
    loading: false,
    refreshing: false,
    refresh: async () => {},
    ...over,
  });

  it("is loading or refreshing while any one of them is", () => {
    const combined = combineResources([resource({}), resource({ refreshing: true })]);
    expect(combined.loading).toBe(false);
    expect(combined.refreshing).toBe(true);
  });

  it("reports the first error in the order given", () => {
    const combined = combineResources([
      resource({}),
      resource({ error: "first" }),
      resource({ error: "second" }),
    ]);
    expect(combined.error).toBe("first");
  });
});
