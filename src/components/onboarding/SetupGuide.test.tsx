import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createRoot } from "react-dom/client";
import type { AppPlace } from "../../lib/appPlace";
import { SETUP_GUIDE_SEEN_KEY, shouldAutoOpenSetupGuide } from "../../lib/onboarding";
import { mountForInteraction } from "../../test/render";
import SetupGuide from "./SetupGuide";

let cleanup: (() => void) | null = null;
beforeEach(() => localStorage.removeItem(SETUP_GUIDE_SEEN_KEY));
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!found) throw new Error(`no "${text}" button`);
  return found;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("SetupGuide", () => {
  it("opens on the welcome step and moves forward", async () => {
    const { host, unmount } = await mountForInteraction(
      <SetupGuide open onClose={() => {}} onNavigate={() => {}} onStartTour={() => {}} />,
    );
    cleanup = unmount;

    expect(host.textContent).toContain("Welcome to Yarvis");
    button(host, "Get started").click();
    await settle();
    expect(host.textContent).toContain("Choose where secrets are kept");
  });

  it("stops opening itself once skipped", async () => {
    let closed = false;
    const { host, unmount } = await mountForInteraction(
      <SetupGuide
        open
        onClose={() => (closed = true)}
        onNavigate={() => {}}
        onStartTour={() => {}}
      />,
    );
    cleanup = unmount;

    button(host, "Skip setup").click();
    expect(closed).toBe(true);
    expect(await shouldAutoOpenSetupGuide()).toBe(false);
  });

  it("counts Esc and Done as closing it too", async () => {
    let closes = 0;
    const { host, unmount } = await mountForInteraction(
      <SetupGuide open onClose={() => closes++} onNavigate={() => {}} onStartTour={() => {}} />,
    );
    cleanup = unmount;

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(closes).toBe(1);
    expect(localStorage.getItem(SETUP_GUIDE_SEEN_KEY)).not.toBeNull();

    localStorage.removeItem(SETUP_GUIDE_SEEN_KEY);
    host.querySelector<HTMLButtonElement>('[aria-label="Next steps"]')?.click();
    await settle();
    button(host, "Done").click();
    expect(closes).toBe(2);
    expect(localStorage.getItem(SETUP_GUIDE_SEEN_KEY)).not.toBeNull();
  });

  it("leaves for an integration's page from the last step", async () => {
    const places: AppPlace[] = [];
    let closed = false;
    const { host, unmount } = await mountForInteraction(
      <SetupGuide
        open
        onClose={() => (closed = true)}
        onNavigate={(place) => places.push(place)}
        onStartTour={() => {}}
      />,
    );
    cleanup = unmount;

    host.querySelector<HTMLButtonElement>('[aria-label="Next steps"]')?.click();
    await settle();
    button(host, "Open").click();
    expect(closed).toBe(true);
    expect(places).toEqual([{ kind: "settings", tab: "credentials" }]);
  });

  it("reopens on the welcome step, wherever it was closed", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    cleanup = () => {
      root.unmount();
      host.remove();
    };
    let open = true;
    const render = () =>
      root.render(
        <SetupGuide
          open={open}
          onClose={() => {
            open = false;
            render();
          }}
          onNavigate={() => {}}
          onStartTour={() => {}}
        />,
      );
    render();
    await settle();
    host.querySelector<HTMLButtonElement>('[aria-label="Next steps"]')?.click();
    await settle();
    button(host, "Skip setup").click();
    await settle();

    open = true;
    render();
    await settle();
    expect(host.textContent).toContain("Welcome to Yarvis");
  });

  it("hands off to the tour from the last step", async () => {
    let toured = false;
    const { host, unmount } = await mountForInteraction(
      <SetupGuide
        open
        onClose={() => {}}
        onNavigate={() => {}}
        onStartTour={() => (toured = true)}
      />,
    );
    cleanup = unmount;

    host.querySelector<HTMLButtonElement>('[aria-label="Next steps"]')?.click();
    await settle();
    button(host, "Take the tour").click();
    expect(toured).toBe(true);
    expect(localStorage.getItem(SETUP_GUIDE_SEEN_KEY)).not.toBeNull();
  });
});
