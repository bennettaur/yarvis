import { afterEach, describe, expect, it } from "bun:test";
import { getColorTheme, onColorTheme, parseColorTheme, setColorTheme } from "./theme";

afterEach(() => setColorTheme("default"));

describe("parseColorTheme", () => {
  it("falls back to the default for anything it does not know", () => {
    expect(parseColorTheme("palenight")).toBe("palenight");
    expect(parseColorTheme(null)).toBe("default");
    expect(parseColorTheme("solarized")).toBe("default");
  });
});

describe("setColorTheme", () => {
  it("starts on the default theme", () => {
    expect(getColorTheme()).toBe("default");
  });

  it("puts the theme on the root element, stores it and tells subscribers", () => {
    let calls = 0;
    const off = onColorTheme(() => calls++);
    setColorTheme("palenight");
    expect(document.documentElement.dataset.theme).toBe("palenight");
    expect(localStorage.getItem("yarvis.colorTheme")).toBe("palenight");
    expect(calls).toBe(1);
    setColorTheme("palenight");
    expect(calls).toBe(1);
    off();
  });
});
