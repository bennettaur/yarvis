import { afterEach, describe, expect, it } from "bun:test";
import { mountForInteraction, renderToHtml, textOf } from "../../test/render";
import NavRail from "./NavRail";

const noop = () => {};

const rail = (showHints: boolean) => (
  <NavRail
    tab="chat"
    onTabChange={noop}
    onOpenOmniChat={noop}
    onOpenClipboard={noop}
    onOpenShortcuts={noop}
    onOpenSetupGuide={noop}
    onStartTour={noop}
    attentionPending={false}
    showHints={showHints}
  />
);

describe("NavRail", () => {
  it("labels each shortcut-bearing button while the modifier is held", async () => {
    const text = textOf(await renderToHtml(rail(true), 0));
    // The nine digit targets plus the cheat sheet's slash.
    expect(text).toBe("123456789/");
  });

  it("shows no labels otherwise", async () => {
    expect(textOf(await renderToHtml(rail(false), 0))).toBe("");
  });

  it("names the chord in every button's tooltip, held or not", async () => {
    const html = await renderToHtml(rail(false), 0);
    expect(html).toContain('title="Chat (⌘1)"');
    expect(html).toContain('title="Keyboard shortcuts (⌘/)"');
    // The pinned-bottom tabs have no digit, so their tooltip stays bare.
    expect(html).toContain('title="Settings"');
  });
});

describe("NavRail Help", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  async function mountRail() {
    const calls: string[] = [];
    const { host, unmount } = await mountForInteraction(
      <NavRail
        tab="chat"
        onTabChange={noop}
        onOpenOmniChat={() => calls.push("omnichat")}
        onOpenClipboard={noop}
        onOpenShortcuts={noop}
        onOpenSetupGuide={() => calls.push("setup")}
        onStartTour={() => calls.push("tour")}
        attentionPending={false}
      />,
      0,
    );
    cleanup = unmount;
    const help = host.querySelector<HTMLButtonElement>('[data-tour="help"]');
    if (!help) throw new Error("no Help button");
    const item = (label: string) =>
      [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label));
    return { host, help, item, calls };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("opens a panel of three choices without claiming to be the current page", async () => {
    const { help, item } = await mountRail();
    expect(help.getAttribute("aria-expanded")).toBe("false");
    help.click();
    await flush();
    expect(help.getAttribute("aria-expanded")).toBe("true");
    expect(help.getAttribute("aria-current")).toBeNull();
    expect(item("Setup guide")).toBeDefined();
    expect(item("Tour the app")).toBeDefined();
    expect(item("Ask Yarvis")).toBeDefined();
  });

  it("runs the picked choice and closes", async () => {
    const { help, item, calls } = await mountRail();
    for (const [label, call] of [
      ["Setup guide", "setup"],
      ["Tour the app", "tour"],
      ["Ask Yarvis", "omnichat"],
    ]) {
      help.click();
      await flush();
      item(label)?.click();
      await flush();
      expect(calls[calls.length - 1]).toBe(call);
      expect(help.getAttribute("aria-expanded")).toBe("false");
    }
  });

  it("closes on Esc and on a click elsewhere", async () => {
    const { help } = await mountRail();
    help.click();
    await flush();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    expect(help.getAttribute("aria-expanded")).toBe("false");

    help.click();
    await flush();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await flush();
    expect(help.getAttribute("aria-expanded")).toBe("false");
  });
});
