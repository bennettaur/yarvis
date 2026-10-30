import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { PrGuideGraph } from "../../lib/pr/flowDiagram";
import type { PrGuide } from "../../lib/pr/guide";
import { mountForInteraction, renderToHtml, textOf } from "../../test/render";

// Excalidraw needs a real canvas, which happy-dom does not have, so the lazy
// chunk is replaced with a stand-in that shows what it was handed.
mock.module("./PrFlowDiagram", () => ({
  default: ({ graph }: { graph: PrGuideGraph }) =>
    createElement("div", { "data-diagram": graph.nodes.map((n) => n.id).join(",") }),
}));

const { default: PrFlowDiagramSection } = await import("./PrFlowDiagramSection");

const graph: PrGuideGraph = {
  nodes: [
    { id: "route", kind: "endpoint", file: "a.ts", changed: true },
    { id: "store", kind: "function", changed: false },
  ],
  edges: [{ from: "route", to: "store", kind: "calls" }],
};

const guide = (over: Partial<PrGuide> = {}): PrGuide => ({
  headSha: "a".repeat(40),
  steps: [],
  graph,
  currentStep: 0,
  stale: false,
  createdAt: "",
  ...over,
});

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

describe("PrFlowDiagramSection", () => {
  // Guides from before the graph was kept have none, and must show nothing.
  it("renders nothing without a graph to draw", async () => {
    expect(await renderToHtml(createElement(PrFlowDiagramSection, { guide: null }))).toBe("");
    for (const g of [guide({ graph: null }), guide({ graph: undefined })]) {
      expect(await renderToHtml(createElement(PrFlowDiagramSection, { guide: g }))).toBe("");
    }
    const empty = guide({ graph: { nodes: [], edges: [] } });
    expect(await renderToHtml(createElement(PrFlowDiagramSection, { guide: empty }))).toBe("");
  });

  it("counts the code it shows and says when the guide is out of date", async () => {
    const fresh = textOf(
      await renderToHtml(createElement(PrFlowDiagramSection, { guide: guide() })),
    );
    expect(fresh).toContain("2 pieces of code, 1 changed");
    expect(fresh).not.toContain("out of date");
    const stale = textOf(
      await renderToHtml(createElement(PrFlowDiagramSection, { guide: guide({ stale: true }) })),
    );
    expect(stale).toContain("out of date");
  });

  // Mounting the diagram while closed would fetch Excalidraw for every review.
  it("mounts the diagram only once opened", async () => {
    const mounted = await mountForInteraction(
      createElement(PrFlowDiagramSection, { guide: guide() }),
    );
    unmount = mounted.unmount;
    const button = mounted.host.querySelector("button")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(mounted.host.querySelector("[data-diagram]")).toBeNull();

    button.click();
    // The lazy chunk resolves on its own schedule; the loading line shows meanwhile.
    for (let i = 0; i < 40 && !mounted.host.querySelector("[data-diagram]"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(mounted.host.querySelector("[data-diagram]")?.getAttribute("data-diagram")).toBe(
      "route,store",
    );

    button.click();
    await new Promise((r) => setTimeout(r, 50));
    expect(mounted.host.querySelector("[data-diagram]")).toBeNull();
  });
});
