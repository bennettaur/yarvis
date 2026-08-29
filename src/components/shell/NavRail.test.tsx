import { describe, expect, it } from "bun:test";
import { renderToHtml, textOf } from "../../test/render";
import NavRail from "./NavRail";

const noop = () => {};

const rail = (showHints: boolean) => (
  <NavRail
    tab="chat"
    onTabChange={noop}
    onOpenOmniChat={noop}
    onOpenClipboard={noop}
    onOpenShortcuts={noop}
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
