import { afterEach, describe, expect, it, mock } from "bun:test";
import { nativeInvoke } from "../test/nativeInvoke";

const saved: unknown[] = [];
let rejectSave = false;

// Through `invoke` rather than a stubbed `lib/settings`, so the command name and
// argument shape the Rust side expects are asserted somewhere.
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: { value?: unknown }) => {
    if (command === "set_color_theme") {
      if (rejectSave) throw new Error("disk full");
      saved.push(args.value);
      return;
    }
    return nativeInvoke(command);
  },
}));

const { getColorTheme, loadColorTheme, onColorTheme, parseColorTheme, setColorTheme } =
  await import("./theme");

afterEach(async () => {
  rejectSave = false;
  await setColorTheme("default");
  saved.length = 0;
});

describe("parseColorTheme", () => {
  it("falls back to the default for anything it does not know", () => {
    expect(parseColorTheme("palenight")).toBe("palenight");
    expect(parseColorTheme(null)).toBe("default");
    expect(parseColorTheme("solarized")).toBe("default");
  });
});

describe("loadColorTheme", () => {
  it("takes the stored theme and puts it on the root element", () => {
    loadColorTheme("palenight");
    expect(getColorTheme()).toBe("palenight");
    expect(document.documentElement.dataset.theme).toBe("palenight");
    loadColorTheme(null);
    expect(getColorTheme()).toBe("default");
  });
});

describe("setColorTheme", () => {
  it("starts on the default theme", () => {
    expect(getColorTheme()).toBe("default");
  });

  it("applies the theme, saves it and tells subscribers", async () => {
    let calls = 0;
    const off = onColorTheme(() => calls++);
    await setColorTheme("palenight");
    expect(document.documentElement.dataset.theme).toBe("palenight");
    expect(saved).toEqual(["palenight"]);
    expect(calls).toBe(1);
    await setColorTheme("palenight");
    expect(calls).toBe(1);
    off();
  });

  it("saves the default as unset", async () => {
    await setColorTheme("palenight");
    await setColorTheme("default");
    expect(saved).toEqual(["palenight", null]);
  });

  it("keeps the theme for this run when the save fails", async () => {
    rejectSave = true;
    await expect(setColorTheme("palenight")).rejects.toThrow("disk full");
    expect(getColorTheme()).toBe("palenight");
  });
});
