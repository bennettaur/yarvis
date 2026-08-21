import { describe, expect, it } from "bun:test";
import { formatChord, isCheatSheetShortcut, SHORTCUT_GROUPS } from "./shortcuts";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("formatChord", () => {
  it("renders modifiers as their mac glyphs and leaves other keys alone", () => {
    expect(formatChord(["Mod", "1"])).toBe("⌘1");
    expect(formatChord(["Mod", "Shift", "]"])).toBe("⌘⇧]");
    expect(formatChord(["Ctrl", "Shift", "Space"])).toBe("⌃⇧Space");
    expect(formatChord(["Esc"])).toBe("Esc");
  });
});

describe("isCheatSheetShortcut", () => {
  it("matches Cmd+/ and Ctrl+/", () => {
    expect(isCheatSheetShortcut(key({ key: "/", metaKey: true }))).toBe(true);
    expect(isCheatSheetShortcut(key({ key: "/", ctrlKey: true }))).toBe(true);
  });

  it("ignores a bare slash, and the combo with Alt held", () => {
    expect(isCheatSheetShortcut(key({ key: "/" }))).toBe(false);
    expect(isCheatSheetShortcut(key({ key: "/", metaKey: true, altKey: true }))).toBe(false);
    expect(isCheatSheetShortcut(key({ key: "f", metaKey: true }))).toBe(false);
  });
});

describe("SHORTCUT_GROUPS", () => {
  it("describes every shortcut exactly once", () => {
    const descriptions = SHORTCUT_GROUPS.flatMap((g) => g.shortcuts).map((s) => s.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});
