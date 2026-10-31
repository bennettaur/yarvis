import { describe, expect, it } from "bun:test";
import { nodeColumns, type PrGuideGraph, toExcalidrawSkeleton } from "./flowDiagram";

const graph = (edges: [string, string][], extra: string[] = []): PrGuideGraph => {
  const ids = [...new Set([...edges.flat(), ...extra])];
  return {
    nodes: ids.map((id) => ({ id, kind: "function" })),
    edges: edges.map(([from, to]) => ({ from, to, kind: "calls" })),
  };
};

describe("nodeColumns", () => {
  it("puts each node right of everything that reaches it, by the longest route", () => {
    // route → service → store, and route → store directly: the store still
    // belongs after the service, not beside it.
    const layers = nodeColumns(
      graph([
        ["route", "service"],
        ["service", "store"],
        ["route", "store"],
      ]),
    );
    expect(Object.fromEntries(layers)).toEqual({ route: 0, service: 1, store: 2 });
  });

  it("finishes on a cycle", () => {
    const layers = nodeColumns(
      graph([
        ["a", "b"],
        ["b", "a"],
      ]),
    );
    expect(layers.size).toBe(2);
  });

  it("ignores an edge to a node that is not in the graph", () => {
    const g = graph([], ["a"]);
    g.edges.push({ from: "a", to: "missing", kind: "calls" });
    expect(Object.fromEntries(nodeColumns(g))).toEqual({ a: 0 });
  });
});

describe("toExcalidrawSkeleton", () => {
  it("binds each arrow to the boxes it joins", () => {
    const elements = toExcalidrawSkeleton(graph([["route", "store"]]));
    const boxes = elements.filter((e) => e.type === "rectangle");
    const arrows = elements.filter((e) => e.type === "arrow");
    expect(boxes.map((b) => b.id)).toEqual(["node-0", "node-1"]);
    expect(arrows).toHaveLength(1);
    expect(arrows[0]).toMatchObject({ start: { id: "node-0" }, end: { id: "node-1" } });
  });

  // Excalidraw keeps an arrow's own points, so arrows drawn anywhere else pile
  // up in one spot rather than joining their boxes.
  it("draws each arrow from its source box's right edge to its target's left edge", () => {
    const elements = toExcalidrawSkeleton(
      graph([
        ["route", "store"],
        ["route", "cache"],
      ]),
    );
    const box = (id: string) =>
      elements.find((e) => e.id === id) as { x: number; y: number; width: number; height: number };
    const arrows = elements.filter((e) => e.type === "arrow");
    for (const arrow of arrows as {
      x: number;
      y: number;
      width: number;
      height: number;
      end: { id: string };
    }[]) {
      const from = box("node-0");
      const to = box(arrow.end.id);
      expect(arrow.x).toBe(from.x + from.width);
      expect(arrow.y).toBe(from.y + from.height / 2);
      expect(arrow.x + arrow.width).toBe(to.x);
      expect(arrow.y + arrow.height).toBe(to.y + to.height / 2);
    }
    expect(new Set(arrows.map((a) => (a as { height: number }).height)).size).toBe(2);
  });

  it("styles the change's own code apart from the code around it", () => {
    const elements = toExcalidrawSkeleton({
      nodes: [
        { id: "handler", kind: "endpoint", file: "src/api/orders.ts", line: 12, changed: true },
        { id: "db", kind: "table" },
      ],
      edges: [],
    });
    expect(elements[0]).toMatchObject({
      strokeStyle: "solid",
      label: { text: "handler\nendpoint · orders.ts:12" },
    });
    expect(elements[1]).toMatchObject({ strokeStyle: "dashed", label: { text: "db\ntable" } });
  });
});
