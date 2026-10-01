import { afterEach, describe, expect, it } from "bun:test";
import { createRoot, type Root } from "react-dom/client";
import { mountForInteraction, renderToHtml } from "../../test/render";
import NavRail from "../shell/NavRail";
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

const noop = () => {};

describe("Tour", () => {
  it("switches to each page as it reaches that page's step, and only then", async () => {
    const tabs: Tab[] = [];
    const { unmount } = await mountForInteraction(
      <Tour open onClose={noop} onTabChange={(t) => tabs.push(t)} />,
    );
    cleanup = unmount;

    for (let i = 1; i < TOUR_STEPS.length; i++) {
      press("ArrowRight");
      await settle();
    }
    expect(tabs).toEqual(TOUR_STEPS.flatMap((s) => (s.tab ? [s.tab] : [])));
  });

  it("rings the step's target when it is on screen", async () => {
    const button = document.createElement("button");
    button.dataset.tour = "chat";
    document.body.appendChild(button);
    const { host, unmount } = await mountForInteraction(
      <Tour open onClose={noop} onTabChange={noop} />,
    );
    cleanup = () => {
      unmount();
      button.remove();
    };

    expect(host.querySelector("[data-tour-highlight]")).toBeNull();
    press("ArrowRight");
    await settle();
    expect(host.querySelector("[data-tour-highlight]")).not.toBeNull();
  });

  it("ends on Esc", async () => {
    let closed = false;
    const { unmount } = await mountForInteraction(
      <Tour open onClose={() => (closed = true)} onTabChange={noop} />,
    );
    cleanup = unmount;
    press("Escape");
    expect(closed).toBe(true);
  });

  it("leaves Enter to the focused card button", async () => {
    const { host, unmount } = await mountForInteraction(
      <Tour open onClose={noop} onTabChange={noop} />,
    );
    cleanup = unmount;
    press("Enter");
    await settle();
    expect(host.textContent).toContain(TOUR_STEPS[0].title);
  });

  it("closes from the last step's Finish", async () => {
    let closed = false;
    const { host, unmount } = await mountForInteraction(
      <Tour open onClose={() => (closed = true)} onTabChange={noop} />,
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

  it("restarts at the welcome step, without revisiting the page it ended on", async () => {
    const tabs: Tab[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root: Root = createRoot(host);
    cleanup = () => {
      root.unmount();
      host.remove();
    };
    let open = true;
    const render = () =>
      root.render(
        <Tour
          open={open}
          onClose={() => {
            open = false;
            render();
          }}
          onTabChange={(t) => tabs.push(t)}
        />,
      );
    render();
    await settle();
    press("ArrowRight");
    await settle();
    press("Escape");
    await settle();
    expect(tabs).toEqual(["chat"]);

    open = true;
    render();
    await settle();
    expect(host.textContent).toContain(TOUR_STEPS[0].title);
    expect(tabs).toEqual(["chat"]);
  });
});

describe("TOUR_STEPS", () => {
  it("only targets buttons the nav rail actually renders", async () => {
    const html = await renderToHtml(
      <NavRail
        tab="chat"
        onTabChange={noop}
        onOpenOmniChat={noop}
        onOpenClipboard={noop}
        onOpenShortcuts={noop}
        onOpenSetupGuide={noop}
        onStartTour={noop}
        attentionPending={false}
      />,
      0,
    );
    const onRail = [...html.matchAll(/data-tour="([^"]+)"/g)].map((m) => m[1]);
    const targets = TOUR_STEPS.flatMap((s) => {
      const target = s.target ?? s.tab;
      return target ? [target] : [];
    });
    expect(onRail).toEqual(expect.arrayContaining(targets));
  });
});
