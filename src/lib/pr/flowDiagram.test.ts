import { describe, expect, it } from "bun:test";
import {
  nodeColumns,
  type PrGraphNode,
  type PrGuideGraph,
  toExcalidrawSkeleton,
} from "./flowDiagram";

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

  // With no longest route, the cycle stops at the last column a graph this size
  // could need rather than going round until the passes run out.
  it("keeps a cycle within the graph's columns", () => {
    const layers = nodeColumns(
      graph([
        ["a", "b"],
        ["b", "a"],
      ]),
    );
    expect(Object.fromEntries(layers)).toEqual({ a: 0, b: 1 });
  });

  it("ignores an edge with either end outside the graph", () => {
    const g = graph([], ["a", "b"]);
    g.edges.push({ from: "a", to: "missing", kind: "calls" });
    g.edges.push({ from: "missing", to: "b", kind: "calls" });
    expect(Object.fromEntries(nodeColumns(g))).toEqual({ a: 0, b: 0 });
  });
});

describe("toExcalidrawSkeleton", () => {
  it("places each box by its column, stacking the boxes that share one", () => {
    const elements = toExcalidrawSkeleton(
      graph([
        ["route", "store"],
        ["route", "cache"],
      ]),
    );
    const boxes = elements.filter((e) => e.type === "rectangle");
    expect(boxes.map((b) => [b.x, b.y, b.width, b.height])).toEqual([
      [0, 0, 240, 80],
      [380, 0, 240, 80],
      [380, 120, 240, 80],
    ]);
  });

  it("keeps the same spacing further out", () => {
    const elements = toExcalidrawSkeleton(
      graph([
        ["a", "b"],
        ["b", "c"],
        ["a", "d"],
        ["a", "e"],
      ]),
    );
    const box = (n: number) => elements[n] as { x: number; y: number };
    expect(box(2)).toMatchObject({ x: 760, y: 0 });
    expect(box(4)).toMatchObject({ x: 380, y: 240 });
  });

  it("draws no arrow for an edge whose other end is not in the graph", () => {
    const g = graph([["route", "store"]]);
    g.edges.push({ from: "route", to: "missing", kind: "calls" });
    g.edges.push({ from: "missing", to: "store", kind: "calls" });
    expect(toExcalidrawSkeleton(g).filter((e) => e.type === "arrow")).toHaveLength(1);
  });

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
      edges: [{ from: "handler", to: "db", kind: "writes" }],
    });
    expect(elements[0]).toMatchObject({
      strokeStyle: "solid",
      strokeColor: "#1971c2",
      fillStyle: "solid",
      roundness: { type: 3 },
    });
    expect(elements[1]).toMatchObject({ strokeStyle: "dashed", strokeColor: "#868e96" });
    expect(elements[2]).toMatchObject({ type: "arrow", label: { text: "writes" } });
  });

  // The name is the model's, so the real path and lines go under it.
  it("labels each box with its name and kind over its full path and lines", () => {
    const label = (node: PrGraphNode) =>
      (toExcalidrawSkeleton({ nodes: [node], edges: [] })[0] as { label: { text: string } }).label
        .text;
    const fn = { id: "load", kind: "function" };
    expect(label({ ...fn, file: "src/api/load.ts", line: 3 })).toBe(
      "load · function\nsrc/api/load.ts:3",
    );
    expect(label({ ...fn, file: "src/api/load.ts", line: 3, endLine: 9 })).toBe(
      "load · function\nsrc/api/load.ts:3-9",
    );
    // A last line that is not past the first reads as a single line.
    expect(label({ ...fn, file: "src/load.ts", line: 3, endLine: 3 })).toBe(
      "load · function\nsrc/load.ts:3",
    );
    expect(label({ ...fn, file: "src/load.ts", line: 3, endLine: 1 })).toBe(
      "load · function\nsrc/load.ts:3",
    );
    // Lines mean nothing without a file, and a last line nothing without a first.
    expect(label({ ...fn, file: "src/load.ts", endLine: 9 })).toBe("load · function\nsrc/load.ts");
    expect(label({ ...fn, line: 12 })).toBe("load · function");
    // A newline in a name can't stand in for the path line.
    expect(
      label({ id: "verify\nsrc/auth/verify.ts:40\n\n", kind: "fn\t", file: "src/a.ts", line: 3 }),
    ).toBe("verify src/auth/verify.ts:40 · fn\nsrc/a.ts:3");
  });
});
