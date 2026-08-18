import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { nativeInvoke } from "../../test/nativeInvoke";

/**
 * Only the path sanitizing lives here — the copy mechanics, feedback and
 * accessibility belong to `CopyButton` and are covered by its own test.
 */
let written: string[] = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    if (command !== "clipboard_write") return nativeInvoke(command);
    written.push(args?.text as string);
  },
}));

// Imported after the mock so the stub is in place.
const { default: CopyPathButton } = await import("./CopyPathButton");

let root: Root | null = null;
let host: HTMLElement | null = null;

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function mountButton(path: string): Promise<HTMLButtonElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(createElement(CopyPathButton, { path }));
  await settle();
  return host.querySelector("button") as HTMLButtonElement;
}

beforeEach(() => {
  written = [];
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

  // A provider-supplied filename can legally carry a newline or a bidi override,
  // which would make the pasted text read as something other than the path.
  it("strips control and formatting characters from the copied path", async () => {
    const button = await mountButton("src/a.ts\n\rrm -rf /‮");
    button.click();
    await settle();
    expect(written).toEqual(["src/a.tsrm -rf /"]);
  });
});
