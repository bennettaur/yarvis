import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SETUP_GUIDE_SEEN_KEY } from "../../lib/onboarding";
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
    expect(localStorage.getItem(SETUP_GUIDE_SEEN_KEY)).not.toBeNull();
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
