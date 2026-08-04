import { describe, expect, it } from "bun:test";
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { parsePatch } from "../../lib/pr/diff";
import { expandRows } from "../../lib/pr/expand";
import { useAskSelection } from "./useAskSelection";
import type { InsightsController, LineSelection } from "./usePrInsights";

const rows = expandRows(
  parsePatch(["@@ -1,5 +1,5 @@", " one", "+two", "+three", "-gone", " four"].join("\n")),
  [],
  new Map(),
);

/** Captures what the hook hands to `openAsk`. */
function stubController(sink: LineSelection[]): InsightsController {
  return {
    byPath: new Map(),
    loading: false,
    error: null,
    asking: null,
    openAsk: (s) => sink.push(s),
    closeAsk: () => {},
    pending: false,
    submit: async () => {},
    post: async () => {},
    remove: async () => {},
  };
}

/**
 * Mounts the hook and replays a sequence of clicks through it, so the anchor it
 * keeps between them is exercised the way a reviewer would drive it.
 */
async function clicks(
  sequence: [line: number, extend: boolean][],
  /** Explicitly undefined for the no-review case, which must be inert. */
  build: (sink: LineSelection[]) => InsightsController | undefined = stubController,
): Promise<LineSelection[]> {
  const sink: LineSelection[] = [];
  const ctrl = build(sink);
  function Harness() {
    const ask = useAskSelection("src/a.ts", rows, ctrl);
    useEffect(() => {
      for (const [line, extend] of sequence) ask(line, extend);
    }, [ask]);
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(Harness));
  await new Promise((r) => setTimeout(r, 20));
  root.unmount();
  host.remove();
  return sink;
}

describe("useAskSelection", () => {
  it("asks about a single line on a plain click", async () => {
    const [selection] = await clicks([[2, false]]);
    expect(selection).toMatchObject({ path: "src/a.ts", startLine: 2, endLine: 2 });
  });

  // The point of shift-click: pick out a block without a drag gesture that
  // would fight the browser's own text selection.
  it("extends from the last line asked about", async () => {
    const results = await clicks([
      [2, false],
      [4, true],
    ]);
    expect(results[1]).toMatchObject({ startLine: 2, endLine: 4 });
  });

  it("orders the range regardless of which end was clicked first", async () => {
    const results = await clicks([
      [4, false],
      [2, true],
    ]);
    expect(results[1]).toMatchObject({ startLine: 2, endLine: 4 });
  });

  // With nothing to extend from, a shift-click has to mean the line itself
  // rather than a range running back to the top of the file.
  it("falls back to a single line when there is no anchor yet", async () => {
    const [selection] = await clicks([[3, true]]);
    expect(selection).toMatchObject({ startLine: 3, endLine: 3 });
  });

  it("carries the selected lines' text", async () => {
    const [selection] = await clicks([[2, false]]);
    expect(selection!.selection).toBe("+two");
  });

  // Deleted lines have no right-side number, so they fall outside a range
  // expressed in new-file lines — and the agent is told what the reviewer sees.
  it("takes only the lines the range covers", async () => {
    const results = await clicks([
      [1, false],
      [3, true],
    ]);
    expect(results[1]!.selection).toBe([" one", "+two", "+three"].join("\n"));
  });

  // The diff also renders outside a review (an Omni widget), where there is no
  // controller to open a composer on. Clicking must be inert, not throw.
  it("is inert where there is no review to ask in", async () => {
    expect(await clicks([[2, false]], () => undefined)).toHaveLength(0);
  });
});
