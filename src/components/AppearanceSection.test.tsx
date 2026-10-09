import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { setColorTheme } from "../lib/theme";
import { mountForInteraction } from "../test/render";
import AppearanceSection from "./AppearanceSection";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  setColorTheme("default");
});

describe("AppearanceSection", () => {
  it("offers both themes and shows the current one", async () => {
    setColorTheme("palenight");
    const mounted = await mountForInteraction(createElement(AppearanceSection));
    unmount = mounted.unmount;
    const select = mounted.host.querySelector("select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Default", "Palenight"]);
    expect(select.value).toBe("palenight");
  });
});
