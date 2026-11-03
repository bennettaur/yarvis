import { describe, expect, it } from "bun:test";
import { diagramToSkeleton, parseDiagram } from "./artifactDiagram";

type Positioned = {
  id?: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
};

describe("parseDiagram", () => {
  it("drops malformed nodes, and edges to nodes that aren't there", () => {
    const diagram = parseDiagram(
      JSON.stringify({
        nodes: [
          { id: "a", shape: "hexagon", color: "chartreuse" },
          { id: "bad id!" },
          { label: "no id" },
        ],
        edges: [
          { id: "a-a", from: "a", to: "a" },
          { id: "a-z", from: "a", to: "z" },
        ],
      }),
    );
    expect(diagram.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(diagram.nodes[0]?.shape).toBeUndefined();
    expect(diagram.nodes[0]?.color).toBeUndefined();
    expect(diagram.edges.map((e) => e.id)).toEqual(["a-a"]);
  });

  it("drops a colour that is only an object's inherited key", () => {
    const names = ["toString", "constructor", "__proto__", "hasOwnProperty"];
    const diagram = parseDiagram(
      JSON.stringify({ nodes: names.map((color, i) => ({ id: `n${i}`, color })), edges: [] }),
    );
    expect(diagram.nodes.map((n) => n.color)).toEqual(names.map(() => undefined));
    expect(parseDiagram('{"nodes":[{"id":"a","color":"blue"}]}').nodes[0]?.color).toBe("blue");
  });

  it("keeps a label's newlines but strips other control characters", () => {
    const diagram = parseDiagram(
      JSON.stringify({ nodes: [{ id: "a", label: "one\ntwo\u0007\u2028\u2029" }], edges: [] }),
    );
    expect(diagram.nodes[0]?.label).toBe("one\ntwo");
  });
});

describe("diagramToSkeleton", () => {
  it("lays unplaced nodes out left to right along their edges", () => {
    const elements = diagramToSkeleton({
      nodes: [{ id: "db" }, { id: "api" }],
      edges: [{ id: "api-db", from: "api", to: "db" }],
    }) as Positioned[];
    const api = elements.find((e) => e.id === "node:api");
    const db = elements.find((e) => e.id === "node:db");
    expect(api?.x).toBe(0);
    expect(db?.x).toBeGreaterThan(api!.x);
  });

  it("puts a node with x and y where it says", () => {
    const [box] = diagramToSkeleton({
      nodes: [{ id: "a", x: 500, y: -20 }],
      edges: [],
    }) as Positioned[];
    expect(box).toMatchObject({ x: 500, y: -20 });
  });

  it("never lays an unplaced node over a placed one, wherever it sits in the list", () => {
    const elements = diagramToSkeleton({
      nodes: [
        { id: "free" },
        { id: "pinned", x: 0, y: 0 },
        { id: "big", x: 0, y: 200, height: 300 },
      ],
      edges: [],
    }) as Positioned[];
    const free = elements.find((e) => e.id === "node:free");
    expect(free?.x).toBe(0);
    // "big" ends at y 500, and the first row clear of both placed boxes starts below it.
    expect(free?.y).toBeGreaterThanOrEqual(500);
  });

  it("draws an arrow between the facing edges of its two shapes, bound to both", () => {
    const elements = diagramToSkeleton({
      nodes: [
        { id: "a", x: 0, y: 0, width: 100, height: 50 },
        { id: "b", x: 300, y: 0, width: 100, height: 50 },
      ],
      edges: [{ id: "a-b", from: "a", to: "b", dashed: true }],
    });
    const arrow = elements.find((e) => e.id === "edge:a-b") as Positioned & Record<string, unknown>;
    expect(arrow).toMatchObject({ x: 100, y: 25, width: 200, height: 0, strokeStyle: "dashed" });
    expect(arrow.start).toEqual({ id: "node:a" });
    expect(arrow.end).toEqual({ id: "node:b" });
  });

  it("draws a text node as free text, not a labelled box", () => {
    const [el] = diagramToSkeleton({
      nodes: [{ id: "t", shape: "text", label: "Note" }],
      edges: [],
    });
    expect(el).toMatchObject({ type: "text", text: "Note" });
  });
});
