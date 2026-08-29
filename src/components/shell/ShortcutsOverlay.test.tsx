import { describe, expect, it } from "bun:test";
import { renderToHtml, textOf } from "../../test/render";
import ShortcutsOverlay from "./ShortcutsOverlay";
import { SHORTCUT_GROUPS } from "./shortcuts";

describe("ShortcutsOverlay", () => {
  it("renders nothing while closed", async () => {
    const html = await renderToHtml(<ShortcutsOverlay open={false} onClose={() => {}} />, 0);
    expect(html).toBe("");
  });

  it("lists every catalogued shortcut", async () => {
    const text = textOf(await renderToHtml(<ShortcutsOverlay open onClose={() => {}} />, 0));
    for (const group of SHORTCUT_GROUPS) {
      expect(text).toContain(group.title);
      for (const shortcut of group.shortcuts) {
        expect(text).toContain(shortcut.description);
      }
    }
    expect(text).toContain("⌘1");
  });
});
