import { describe, expect, it } from "bun:test";
import { resolveTabShortcut, type ShortcutEvent } from "./useTabShortcuts";

const ev = (over: Partial<ShortcutEvent>): ShortcutEvent => ({
  key: "1",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe("resolveTabShortcut", () => {
  it("jumps to the Nth top-level tab on Cmd/Ctrl+digit", () => {
    expect(resolveTabShortcut(ev({ metaKey: true, key: "1" }), "settings")).toBe("chat");
    expect(resolveTabShortcut(ev({ metaKey: true, key: "5" }), "chat")).toBe("tasks");
    expect(resolveTabShortcut(ev({ ctrlKey: true, key: "3" }), "chat")).toBe("terminal");
  });

  it("cycles forward and wraps with Cmd/Ctrl+Shift+]", () => {
    expect(resolveTabShortcut(ev({ metaKey: true, shiftKey: true, key: "]" }), "chat")).toBe(
      "omni",
    );
    // settings is the last tab → wraps to the first.
    expect(resolveTabShortcut(ev({ metaKey: true, shiftKey: true, key: "}" }), "settings")).toBe(
      "chat",
    );
  });

  it("cycles backward and wraps with Cmd/Ctrl+Shift+[", () => {
    expect(resolveTabShortcut(ev({ metaKey: true, shiftKey: true, key: "[" }), "chat")).toBe(
      "settings",
    );
    expect(resolveTabShortcut(ev({ metaKey: true, shiftKey: true, key: "{" }), "omni")).toBe(
      "chat",
    );
  });

  it("ignores keys that aren't tab shortcuts", () => {
    expect(resolveTabShortcut(ev({ key: "1" }), "chat")).toBeNull(); // no modifier
    expect(resolveTabShortcut(ev({ metaKey: true, altKey: true, key: "1" }), "chat")).toBeNull();
    expect(resolveTabShortcut(ev({ metaKey: true, key: "0" }), "chat")).toBeNull();
    expect(resolveTabShortcut(ev({ metaKey: true, key: "a" }), "chat")).toBeNull();
  });
});
