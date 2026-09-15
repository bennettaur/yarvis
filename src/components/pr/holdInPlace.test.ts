import { afterEach, describe, expect, it } from "bun:test";
import { holdInPlace, releaseHold } from "./holdInPlace";

const mounted: HTMLElement[] = [];
const releases: (() => void)[] = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const el of mounted.splice(0)) el.remove();
});

/** Starts a hold that is torn down after the test, whatever it asserted. */
function hold(el: HTMLElement, holdMs?: number): void {
  releases.push(holdInPlace(el, holdMs));
}

/**
 * happy-dom has no layout, so the target's position is modelled by hand: it
 * sits `above` pixels down the content, less however far the pane has scrolled.
 * Growing `above` is a file opening over the target.
 */
function mountHeldTarget({ inPane = true } = {}) {
  const pane = document.createElement("div");
  if (inPane) pane.setAttribute("data-pr-scroll", "");
  const target = document.createElement("details");
  pane.appendChild(target);
  document.body.appendChild(pane);
  mounted.push(pane);

  const layout = { above: 0 };
  let scrollTop = 0;
  Object.defineProperty(pane, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  pane.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  target.getBoundingClientRect = () => ({ top: layout.above - scrollTop }) as DOMRect;
  return { pane, target, layout };
}

const waitForFrames = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

describe("holdInPlace", () => {
  it("scrolls by however far content above pushes the target", async () => {
    const { pane, target, layout } = mountHeldTarget();
    hold(target);

    layout.above = 240;
    await waitForFrames();

    expect(pane.scrollTop).toBe(240);
  });

  // The hold exists to finish a jump, not to fight a reader who has moved on.
  it("lets go once the reader scrolls themselves", async () => {
    const { pane, target, layout } = mountHeldTarget();
    hold(target);

    pane.dispatchEvent(new Event("wheel"));
    layout.above = 240;
    await waitForFrames();

    expect(pane.scrollTop).toBe(0);
  });

  it("lets go when the hold time runs out", async () => {
    const { pane, target, layout } = mountHeldTarget();
    hold(target, 0);

    await waitForFrames();
    layout.above = 240;
    await waitForFrames();

    expect(pane.scrollTop).toBe(0);
  });

  // A guided-review scroll starting mid-hold would otherwise be dragged back.
  it("lets go when another scroll in the pane releases it", async () => {
    const { pane, target, layout } = mountHeldTarget();
    hold(target);

    releaseHold(target);
    layout.above = 240;
    await waitForFrames();

    expect(pane.scrollTop).toBe(0);
  });

  // Two holds correcting the same drift would scroll the pane twice as far.
  it("replaces a hold already running in the same pane", async () => {
    const { pane, target, layout } = mountHeldTarget();
    hold(target);
    hold(target);

    layout.above = 240;
    await waitForFrames();

    expect(pane.scrollTop).toBe(240);
  });

  it("lets go when the target leaves the page", async () => {
    const { pane, target, layout } = mountHeldTarget();
    hold(target);

    target.remove();
    layout.above = 240;
    await waitForFrames();

    expect(pane.scrollTop).toBe(0);
  });

  it("does nothing outside a review scroll pane", async () => {
    const { pane, target, layout } = mountHeldTarget({ inPane: false });
    hold(target);

    layout.above = 240;
    await waitForFrames();

    expect(pane.scrollTop).toBe(0);
  });
});
