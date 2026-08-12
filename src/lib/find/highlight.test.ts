import { afterAll, beforeEach, describe, expect, it } from "bun:test";

/**
 * happy-dom has no CSS Custom Highlight API, so the registry is stood in for
 * here. The assertions are about what ends up registered rather than about
 * pixels: a highlight has to be registered once and then edited in place, since
 * replacing the entry leaves the previous query's matches painted.
 */

class FakeHighlight extends Set<Range> {}

const registry = new Map<string, FakeHighlight>();
// happy-dom defines `CSS` as a read-only accessor, so the stand-ins go in by
// redefining the properties rather than assigning to them.
const realCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
const realHighlight = Object.getOwnPropertyDescriptor(globalThis, "Highlight");

Object.defineProperty(globalThis, "CSS", {
  value: { highlights: registry },
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "Highlight", {
  value: FakeHighlight,
  configurable: true,
  writable: true,
});

// Imported after the stand-ins are in place, though the module reads them per
// call rather than at load.
const { clearMatches, highlightsSupported, showMatches } = await import("./highlight");

/** A throwaway range, distinguishable by the text it wraps. */
function range(text: string): Range {
  const node = document.createTextNode(text);
  document.body.appendChild(node);
  const created = document.createRange();
  created.selectNodeContents(node);
  return created;
}

const painted = (key: string) => [...(registry.get(key) ?? [])].map((r) => r.toString()).sort();

beforeEach(() => {
  clearMatches();
});

// The registry is a global, so it goes back the way it was for whichever suite
// runs next in this process.
afterAll(() => {
  if (realCss) Object.defineProperty(globalThis, "CSS", realCss);
  if (realHighlight) Object.defineProperty(globalThis, "Highlight", realHighlight);
  else Reflect.deleteProperty(globalThis, "Highlight");
});

describe("showMatches", () => {
  it("is available once the registry is", () => {
    expect(highlightsSupported()).toBe(true);
  });

  it("picks the active match out of the rest", () => {
    showMatches([range("one"), range("two"), range("three")], 1);
    expect(painted("yarvis-find")).toEqual(["one", "three"]);
    expect(painted("yarvis-find-active")).toEqual(["two"]);
  });

  it("leaves nothing from the previous query behind", () => {
    showMatches([range("ro"), range("ro")], 0);
    showMatches([range("root")], 0);
    expect(painted("yarvis-find")).toEqual([]);
    expect(painted("yarvis-find-active")).toEqual(["root"]);
  });

  // The regression guard. Typing "ro" and then "root" left the "ro" matches
  // painted because each call registered a *replacement* highlight, and swapping
  // the entry doesn't reliably invalidate what the old one drew. The registry
  // contents looked right either way — only the identity tells the two apart,
  // which is why this is the assertion that would have caught it.
  it("keeps the same highlight registered across calls", () => {
    showMatches([range("first")], 0);
    const before = registry.get("yarvis-find");
    showMatches([range("second"), range("third")], 0);
    expect(registry.get("yarvis-find")).toBe(before);
  });

  it("empties both layers when the search is cleared", () => {
    showMatches([range("alpha"), range("beta")], 0);
    clearMatches();
    expect(painted("yarvis-find")).toEqual([]);
    expect(painted("yarvis-find-active")).toEqual([]);
  });
});
