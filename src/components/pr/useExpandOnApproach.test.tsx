import { afterEach, describe, expect, it } from "bun:test";
import { createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EXPAND_AHEAD_PX, useExpandOnApproach } from "./useExpandOnApproach";

/**
 * happy-dom has no IntersectionObserver, so these tests install a fake that
 * records what it was constructed with and lets a test drive its callback by
 * hand. That is the whole point of the exercise: the hook's contract is which
 * root and margin it observes against, and that it fires exactly once.
 */
interface FakeObserver {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit | undefined;
  observed: Element[];
  disconnected: boolean;
}

let observers: FakeObserver[] = [];

function installFakeObserver(): void {
  observers = [];
  class Fake {
    callback: IntersectionObserverCallback;
    options: IntersectionObserverInit | undefined;
    observed: Element[] = [];
    disconnected = false;
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.callback = callback;
      this.options = options;
      observers.push(this as unknown as FakeObserver);
    }
    observe(el: Element) {
      this.observed.push(el);
    }
    disconnect() {
      this.disconnected = true;
    }
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = Fake;
}

/** Feeds the observer an entry, as the browser would when the target scrolls in. */
function fire(observer: FakeObserver, isIntersecting: boolean): void {
  observer.callback(
    [{ isIntersecting } as IntersectionObserverEntry],
    observer as unknown as IntersectionObserver,
  );
}

/** A component that hooks a div and counts how often it was approached. */
function Harness({ enabled, onApproach }: { enabled: boolean; onApproach: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useExpandOnApproach(ref, enabled, onApproach);
  return createElement("div", { ref });
}

let root: Root | null = null;
let host: HTMLElement | null = null;

/**
 * Mounts the harness inside `wrapperHtml` and settles effects. Unlike
 * `renderToHtml` the tree stays mounted, because every assertion here happens
 * after the test drives the observer.
 */
async function mount(
  enabled: boolean,
  onApproach: () => void,
  wrapperHtml = "<div></div>",
): Promise<void> {
  host = document.createElement("div");
  host.innerHTML = wrapperHtml;
  document.body.appendChild(host);
  root = createRoot(host.firstElementChild as Element);
  root.render(createElement(Harness, { enabled, onApproach }));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
});

describe("useExpandOnApproach", () => {
  it("fires once when the target intersects and then stops observing", async () => {
    installFakeObserver();
    let approached = 0;
    await mount(true, () => approached++);

    expect(observers).toHaveLength(1);
    const observer = observers[0]!;
    fire(observer, true);
    expect(approached).toBe(1);
    // Disconnecting on the first hit is what keeps this a one-shot: a file that
    // has already opened has nothing left to reveal, and an observer left
    // running would keep costing intersection work for the rest of the review.
    expect(observer.disconnected).toBe(true);
  });

  it("ignores entries that are not intersecting", async () => {
    installFakeObserver();
    let approached = 0;
    await mount(true, () => approached++);

    fire(observers[0]!, false);
    expect(approached).toBe(0);
    expect(observers[0]!.disconnected).toBe(false);
  });

  it("observes nothing while disabled", async () => {
    installFakeObserver();
    await mount(false, () => {});
    expect(observers).toHaveLength(0);
  });

  // The margin must grow the root downward only: extending it upward would let
  // a file the reader already scrolled past expand and push the page under them.
  it("extends the root margin below the pane and nowhere else", async () => {
    installFakeObserver();
    await mount(true, () => {});
    expect(observers[0]!.options?.rootMargin).toBe(`0px 0px ${EXPAND_AHEAD_PX}px 0px`);
  });

  // Rooting on the scroll pane is what makes the margin reach at all: against
  // the default viewport root the pane clips everything below its bottom edge.
  it("roots on the enclosing review scroll pane", async () => {
    installFakeObserver();
    await mount(true, () => {}, "<div data-pr-scroll></div>");
    const pane = host?.querySelector("[data-pr-scroll]");
    expect(observers[0]!.options?.root).toBe(pane as Element);
  });

  it("falls back to the viewport when there is no scroll pane", async () => {
    installFakeObserver();
    await mount(true, () => {});
    expect(observers[0]!.options?.root).toBe(null);
  });

  it("does nothing when the environment has no IntersectionObserver", async () => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    let approached = 0;
    await mount(true, () => approached++);
    expect(approached).toBe(0);
  });
});
