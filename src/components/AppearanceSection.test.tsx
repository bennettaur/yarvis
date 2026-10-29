import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { nativeInvoke } from "../test/nativeInvoke";
import { mountForInteraction } from "../test/render";

let rejectSave = false;
const sweepSaves: unknown[] = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: { value?: unknown }) => {
    if ((command === "set_color_theme" || command === "set_attention_sweep") && rejectSave)
      throw new Error("disk full");
    if (command === "set_attention_sweep") sweepSaves.push(args?.value);
    return nativeInvoke(command);
  },
}));

const { getColorTheme, setColorTheme } = await import("../lib/theme");
const { getAttentionSweep, loadAttentionSweep } = await import("../lib/attentionSweep");
const AppearanceSection = (await import("./AppearanceSection")).default;

let unmount: (() => void) | null = null;
afterEach(async () => {
  unmount?.();
  unmount = null;
  rejectSave = false;
  await setColorTheme("default");
  loadAttentionSweep(null);
  sweepSaves.length = 0;
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

  it("turns the attention sweep off and back on, storing off as false and on as the default", async () => {
    const mounted = await mountForInteraction(createElement(AppearanceSection));
    unmount = mounted.unmount;
    const box = mounted.host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);

    box.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getAttentionSweep()).toBe(false);
    expect(box.checked).toBe(false);

    box.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getAttentionSweep()).toBe(true);
    expect(sweepSaves).toEqual([false, null]);
  });

  it("shows the sweep as off when it was stored off", async () => {
    loadAttentionSweep(false);
    const mounted = await mountForInteraction(createElement(AppearanceSection));
    unmount = mounted.unmount;
    const box = mounted.host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
  });

  it("says so when the sweep toggled but couldn't be saved", async () => {
    rejectSave = true;
    const mounted = await mountForInteraction(createElement(AppearanceSection));
    unmount = mounted.unmount;
    (mounted.host.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getAttentionSweep()).toBe(false);
    expect(mounted.host.textContent).toContain("couldn't be saved");
  });
});
