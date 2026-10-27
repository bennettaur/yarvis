import { describe, expect, it } from "bun:test";
import { resolveTabShortcut } from "../shell/useTabShortcuts";
import { resolveReviewShortcut } from "./reviewShortcuts";

const press = (
  key: string,
  mods: Partial<Record<"meta" | "ctrl" | "shift" | "alt", boolean>> = {},
  code = "",
) => ({
  key,
  code,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
});

describe("resolveReviewShortcut", () => {
  it("cycles tabs on Ctrl+Tab and Cmd+Option+arrows", () => {
    expect(resolveReviewShortcut(press("Tab", { ctrl: true }))).toBe("next-tab");
    expect(resolveReviewShortcut(press("Tab", { ctrl: true, shift: true }))).toBe("prev-tab");
    expect(resolveReviewShortcut(press("ArrowRight", { meta: true, alt: true }))).toBe("next-tab");
    expect(resolveReviewShortcut(press("ArrowLeft", { meta: true, alt: true }))).toBe("prev-tab");
  });

  it("closes on Cmd+W and moves sides on Cmd+\\", () => {
    expect(resolveReviewShortcut(press("w", { meta: true }))).toBe("close-tab");
    expect(resolveReviewShortcut(press("\\", { meta: true }))).toBe("other-group");
  });

  it("steps files on Option+J/K by key position, whatever character Option makes", () => {
    expect(resolveReviewShortcut(press("∆", { alt: true }, "KeyJ"))).toBe("next-file");
    expect(resolveReviewShortcut(press("˚", { alt: true }, "KeyK"))).toBe("prev-file");
  });

  it("leaves plain typing and the app's own view shortcuts alone", () => {
    expect(resolveReviewShortcut(press("j", {}, "KeyJ"))).toBeNull();
    expect(resolveReviewShortcut(press("w"))).toBeNull();
    for (const e of [press("1", { meta: true }), press("]", { meta: true, shift: true })]) {
      expect(resolveReviewShortcut(e)).toBeNull();
      expect(resolveTabShortcut(e, "review")).not.toBeNull();
    }
  });
});
