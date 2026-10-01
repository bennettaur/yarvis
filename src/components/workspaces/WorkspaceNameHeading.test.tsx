import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { mountForInteraction } from "../../test/render";
import WorkspaceNameHeading from "./WorkspaceNameHeading";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(onRename: (name: string) => Promise<void>) {
  const mounted = await mountForInteraction(
    createElement(WorkspaceNameHeading, { name: "Old name", onRename }),
  );
  unmount = mounted.unmount;
  return mounted.host;
}

async function startEditing(host: HTMLElement): Promise<HTMLInputElement> {
  [...host.querySelectorAll("button")].find((b) => b.textContent === "Rename")?.click();
  await settle();
  const input = host.querySelector("input");
  if (!input) throw new Error("no name field");
  return input;
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("WorkspaceNameHeading", () => {
  it("saves the trimmed name on Enter", async () => {
    const saved: string[] = [];
    const host = await mount(async (name) => {
      saved.push(name);
    });
    const input = await startEditing(host);
    expect(input.value).toBe("Old name");

    type(input, "  New name  ");
    press(input, "Enter");
    await settle();

    expect(saved).toEqual(["New name"]);
    expect(host.querySelector("input")).toBeNull();
  });

  it("drops the edit on Escape without saving", async () => {
    const saved: string[] = [];
    const host = await mount(async (name) => {
      saved.push(name);
    });
    const input = await startEditing(host);

    type(input, "Something else");
    press(input, "Escape");
    await settle();

    expect(saved).toEqual([]);
    expect(host.querySelector("input")).toBeNull();
    expect(host.textContent).toContain("Old name");
  });

  it("doesn't save a blank or unchanged name", async () => {
    const saved: string[] = [];
    const host = await mount(async (name) => {
      saved.push(name);
    });

    type(await startEditing(host), "   ");
    press(host.querySelector("input")!, "Enter");
    await settle();

    type(await startEditing(host), "Old name");
    press(host.querySelector("input")!, "Enter");
    await settle();

    expect(saved).toEqual([]);
  });

  it("keeps the field open with the error when saving fails", async () => {
    const host = await mount(async () => {
      throw new Error("rename workspace failed (500)");
    });
    const input = await startEditing(host);

    type(input, "New name");
    press(input, "Enter");
    await settle();

    expect(host.querySelector("input")).not.toBeNull();
    expect(host.textContent).toContain("rename workspace failed (500)");
  });
});
