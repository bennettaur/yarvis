import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * The button copies through the Rust core's `clipboard_write`, so the test
 * stands in for that command and records what it was handed. A module mock
 * replaces `@tauri-apps/api/core` for the whole run, so every other command
 * falls through to whichever stub was already installed — the shared defaults
 * from `src/test/setup.ts`, or another suite's stub if one ran first.
 */
let written: string[] = [];
let failNext = false;

const { invoke: fallbackInvoke } = await import("@tauri-apps/api/core");

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    if (command !== "clipboard_write") return fallbackInvoke(command, args);
    if (failNext) throw new Error("clipboard unavailable");
    written.push(args?.text as string);
  },
}));

// Imported after the mock so the stub is in place.
const { default: CopyPathButton } = await import("./CopyPathButton");

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Mounts the button and leaves it mounted, since every assertion follows a click. */
async function mountButton(path: string): Promise<HTMLButtonElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(createElement(CopyPathButton, { path }));
  await settle();
  return host.querySelector("button") as HTMLButtonElement;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  written = [];
  failNext = false;
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

describe("CopyPathButton", () => {
  it("writes the full path to the clipboard", async () => {
    const button = await mountButton("src/components/pr/PrFileList.tsx");
    button.click();
    await settle();
    expect(written).toEqual(["src/components/pr/PrFileList.tsx"]);
  });

  it("confirms the copy in place", async () => {
    const button = await mountButton("src/a.ts");
    expect(button.textContent).toContain("Copy path");
    button.click();
    await settle();
    expect(button.textContent).toContain("Path copied");
  });

  it("says so when the copy fails", async () => {
    failNext = true;
    const button = await mountButton("src/a.ts");
    button.click();
    await settle();
    expect(button.textContent).toContain("Copying failed");
    expect(written).toEqual([]);
  });

  // The button sits inside a `<summary>` that folds the file and a row that
  // scrolls the diff into view; a copy must not also trigger either of those.
  it("keeps the click from reaching the surrounding row", async () => {
    let rowClicks = 0;
    host = document.createElement("div");
    host.innerHTML = "<div></div>";
    host.addEventListener("click", () => rowClicks++);
    document.body.appendChild(host);
    root = createRoot(host.firstElementChild as Element);
    root.render(createElement(CopyPathButton, { path: "src/a.ts" }));
    await settle();

    (host.querySelector("button") as HTMLButtonElement).click();
    await settle();
    expect(rowClicks).toBe(0);
    expect(written).toEqual(["src/a.ts"]);
  });
});
