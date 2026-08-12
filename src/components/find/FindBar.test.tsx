import { afterEach, describe, expect, it } from "bun:test";
import { useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFind } from "../../lib/find/useFind";
import FindBar from "./FindBar";

/**
 * Exercises the bar against the hook it renders, since the interesting part is
 * the wiring: a shortcut opens it, typing counts matches in the surrounding
 * content, and stepping moves through them. The matching itself is covered by
 * the `lib/find` tests.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function Harness() {
  const contentRef = useRef<HTMLDivElement>(null);
  const find = useFind(contentRef);
  return (
    <div>
      <div ref={contentRef}>
        <p>alpha beta gamma</p>
        <p>Beta again</p>
      </div>
      <FindBar find={find} />
    </div>
  );
}

async function mountHarness(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<Harness />);
  await settle();
}

const findInput = () => host?.querySelector("input") as HTMLInputElement | null;
const status = () => host?.querySelector("[role='status']")?.textContent ?? null;

/** Types into the controlled input the way React's own change tracking expects. */
async function type(value: string): Promise<void> {
  const input = findInput();
  if (!input) throw new Error("the find bar is not open");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

async function press(key: string, options: KeyboardEventInit = {}): Promise<void> {
  const target = findInput() ?? window;
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...options }));
  await settle();
}

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

describe("FindBar", () => {
  it("stays out of the way until the shortcut opens it", async () => {
    await mountHarness();
    expect(findInput()).toBeNull();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    await settle();
    expect(findInput()).not.toBeNull();
  });

  it("counts the matches in the content it was given", async () => {
    await mountHarness();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    await settle();

    await type("beta");
    expect(status()).toBe("1/2");
  });

  it("says so when nothing matches", async () => {
    await mountHarness();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    await settle();

    await type("nowhere");
    expect(status()).toBe("No results");
  });

  it("steps forward on Enter and wraps around", async () => {
    await mountHarness();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    await settle();
    await type("beta");

    await press("Enter");
    expect(status()).toBe("2/2");
    await press("Enter");
    expect(status()).toBe("1/2");
  });

  it("steps back on Shift+Enter, wrapping to the last match", async () => {
    await mountHarness();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    await settle();
    await type("beta");

    await press("Enter", { shiftKey: true });
    expect(status()).toBe("2/2");
  });

  it("narrows the results when match case is turned on", async () => {
    await mountHarness();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    await settle();
    await type("beta");
    expect(status()).toBe("1/2");

    const toggle = host?.querySelector("[aria-label='Match case: off']") as HTMLButtonElement;
    toggle.click();
    await settle();
    expect(status()).toBe("1/1");
  });

  // Cmd+G is the shortcut for "same search, next hit" from wherever focus is,
  // so it is handled at the window rather than in the field.
  it("steps forward on Cmd+G from outside the field", async () => {
    await mountHarness();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    await settle();
    await type("beta");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", metaKey: true }));
    await settle();
    expect(status()).toBe("2/2");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", metaKey: true, shiftKey: true }));
    await settle();
    expect(status()).toBe("1/2");
  });

  it("closes on Escape", async () => {
    await mountHarness();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    await settle();

    await press("Escape");
    expect(findInput()).toBeNull();
  });
});
