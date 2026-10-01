import { afterEach, describe, expect, it } from "bun:test";
import { mountForInteraction } from "../../test/render";
import type { Tab } from "../shell/nav";
import Tour from "./Tour";
import { TOUR_STEPS } from "./tourSteps";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("Tour", () => {
  it("switches to each page as it reaches that page's step", async () => {
    const tabs: Tab[] = [];
    const { host, unmount } = await mountForInteraction(
      <Tour open onClose={() => {}} onTabChange={(t) => tabs.push(t)} />,
    );
    cleanup = unmount;

    expect(host.textContent).toContain(TOUR_STEPS[0]!.title);
    press("ArrowRight");
    await settle();
    expect(host.textContent).toContain("Chat");
    expect(tabs).toEqual(["chat"]);
  });

  it("rings the step's target when it is on screen", async () => {
    const button = document.createElement("button");
    button.dataset.tour = "chat";
    document.body.appendChild(button);
    const { host, unmount } = await mountForInteraction(
      <Tour open onClose={() => {}} onTabChange={() => {}} />,
    );
    cleanup = () => {
      unmount();
      button.remove();
    };

    expect(host.querySelector(".ring-2")).toBeNull();
    press("ArrowRight");
    await settle();
    expect(host.querySelector(".ring-2")).not.toBeNull();
  });

  it("ends on Esc", async () => {
    let closed = false;
    const { unmount } = await mountForInteraction(
      <Tour open onClose={() => (closed = true)} onTabChange={() => {}} />,
    );
    cleanup = unmount;
    press("Escape");
    expect(closed).toBe(true);
  });

  it("closes from the last step's Finish", async () => {
    let closed = false;
    const { host, unmount } = await mountForInteraction(
      <Tour open onClose={() => (closed = true)} onTabChange={() => {}} />,
    );
    cleanup = unmount;
    for (let i = 1; i < TOUR_STEPS.length; i++) {
      press("ArrowRight");
      await settle();
    }
    expect(host.textContent).toContain("Finish");
    expect(closed).toBe(false);
    press("ArrowRight");
    expect(closed).toBe(true);
  });
});
