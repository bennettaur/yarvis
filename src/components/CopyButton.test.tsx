import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clipboardWrites, failNextClipboardWrite, resetClipboardWrites } from "../test/clipboard";

// Imported after the shared clipboard stub so it is in place.
const { default: CopyButton, FEEDBACK_MS } = await import("./CopyButton");

let root: Root | null = null;
let host: HTMLElement | null = null;

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mounts the button inside `wrapperHtml` — at `mountSelector`, or at the
 * wrapper's root element — and leaves it mounted, since every assertion here
 * happens after a click.
 */
async function mountButton(
  props: { value: string | (() => string); subject: string; title?: string },
  wrapperHtml = "<div></div>",
  mountSelector?: string,
): Promise<HTMLButtonElement> {
  host = document.createElement("div");
  host.innerHTML = wrapperHtml;
  document.body.appendChild(host);
  const mountPoint = mountSelector ? host.querySelector(mountSelector) : host.firstElementChild;
  root = createRoot(mountPoint as Element);
  root.render(createElement(CopyButton, props));
  await settle();
  return host.querySelector("button") as HTMLButtonElement;
}

/** What a screen reader is told, i.e. the live region rather than the button. */
const announcement = () => host?.querySelector("[role='status']")?.textContent;

beforeEach(resetClipboardWrites);

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

describe("CopyButton", () => {
  it("writes the value to the clipboard", async () => {
    const button = await mountButton({ value: "https://example.test/pull/1", subject: "PR link" });
    button.click();
    await settle();
    expect(clipboardWrites()).toEqual(["https://example.test/pull/1"]);
  });

  // Hosts that would otherwise build a whole file list on every render pass a
  // function instead of a string.
  it("takes a lazy value only when clicked", async () => {
    let calls = 0;
    const button = await mountButton({
      value: () => {
        calls++;
        return "a.ts\nb.ts";
      },
      subject: "file list",
    });
    expect(calls).toBe(0);
    button.click();
    await settle();
    expect(clipboardWrites()).toEqual(["a.ts\nb.ts"]);
    expect(calls).toBe(1);
  });

  it("announces the copy and then goes quiet", async () => {
    const button = await mountButton({ value: "x", subject: "path" });
    expect(announcement()).toBe("");
    button.click();
    await settle();
    expect(announcement()).toBe("Path copied");

    // The confirmation is transient: without the reset the button would sit on
    // "Path copied" for the rest of the review.
    await settle(FEEDBACK_MS + 50);
    expect(announcement()).toBe("");
  });

  it("says so when the copy fails", async () => {
    failNextClipboardWrite();
    const button = await mountButton({ value: "x", subject: "path" });
    const consoleError = console.error;
    // The component logs the failure by design; keep the expected noise out of
    // the run so a genuine error still stands out.
    console.error = () => {};
    try {
      button.click();
      await settle();
    } finally {
      console.error = consoleError;
    }
    expect(announcement()).toBe("Copying failed");
    expect(clipboardWrites()).toEqual([]);
  });

  it("names the value in the accessible name when given a title", async () => {
    const button = await mountButton({
      value: "src/a.ts",
      subject: "path",
      title: "Copy path src/a.ts",
    });
    expect(button.getAttribute("aria-label")).toBe("Copy path src/a.ts");
  });

  // The diff header is a `<summary>`, so a copy that folded the file the reader
  // is in the middle of would be worse than no button at all.
  it("does not fold the file it sits in the header of", async () => {
    const button = await mountButton(
      { value: "src/a.ts", subject: "path" },
      "<details><summary></summary><p>diff</p></details>",
      "summary",
    );
    button.click();
    await settle();
    expect(host?.querySelector("details")?.open).toBe(false);
    expect(clipboardWrites()).toEqual(["src/a.ts"]);
  });

  // The file list row's own click handler sits on a sibling button today, so
  // this guards the row against a future handler rather than a present one.
  it("keeps the click from reaching an enclosing row", async () => {
    let rowClicks = 0;
    const button = await mountButton({ value: "src/a.ts", subject: "path" });
    host?.addEventListener("click", () => rowClicks++);
    button.click();
    await settle();
    expect(rowClicks).toBe(0);
  });
});
