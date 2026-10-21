import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { nativeInvoke } from "../test/nativeInvoke";
import { mountForInteraction } from "../test/render";

let rejectSave = false;

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command === "set_color_theme" && rejectSave) throw new Error("disk full");
    return nativeInvoke(command);
  },
}));

const { getColorTheme, setColorTheme } = await import("../lib/theme");
const AppearanceSection = (await import("./AppearanceSection")).default;

let unmount: (() => void) | null = null;
afterEach(async () => {
  unmount?.();
  unmount = null;
  rejectSave = false;
  await setColorTheme("default");
});

function choose(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("AppearanceSection", () => {
  it("offers both themes and shows the current one", async () => {
    await setColorTheme("palenight");
    const mounted = await mountForInteraction(createElement(AppearanceSection));
    unmount = mounted.unmount;
    const select = mounted.host.querySelector("select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Default", "Palenight"]);
    expect(select.value).toBe("palenight");
  });

  it("says so when the theme applied but couldn't be saved", async () => {
    rejectSave = true;
    const mounted = await mountForInteraction(createElement(AppearanceSection));
    unmount = mounted.unmount;
    choose(mounted.host.querySelector("select") as HTMLSelectElement, "palenight");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getColorTheme()).toBe("palenight");
    expect(mounted.host.textContent).toContain("couldn't be saved");
  });
});
