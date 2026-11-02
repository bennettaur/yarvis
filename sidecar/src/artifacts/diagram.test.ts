import { describe, expect, it } from "bun:test";
import {
  applyDiagramChanges,
  checkDiagram,
  type Diagram,
  DiagramError,
  MAX_DIAGRAM_NODES,
  onlyAdds,
  parseDiagram,
} from "./diagram.ts";

const base: Diagram = {
  nodes: [
    { id: "api", label: "API" },
    { id: "db", label: "Postgres", shape: "ellipse" },
  ],
  edges: [{ id: "api-db", from: "api", to: "db", label: "reads" }],
};

describe("diagram changes", () => {
  it("merges an upsert into the node with that id and keeps its other fields", () => {
    const next = applyDiagramChanges(base, { upsertNodes: [{ id: "db", color: "blue" }] });
    expect(next.nodes[1]).toEqual({ id: "db", label: "Postgres", shape: "ellipse", color: "blue" });
  });

  it("adds a node and an edge to it in one call", () => {
    const next = applyDiagramChanges(base, {
      upsertNodes: [{ id: "cache", label: "Redis" }],
      upsertEdges: [{ id: "api-cache", from: "api", to: "cache" }],
    });
    expect(next.nodes.map((n) => n.id)).toEqual(["api", "db", "cache"]);
    expect(next.edges.map((e) => e.id)).toEqual(["api-db", "api-cache"]);
  });

  it("removes a node's edges with it", () => {
    const next = applyDiagramChanges(base, { removeNodes: ["db"] });
    expect(next.nodes.map((n) => n.id)).toEqual(["api"]);
    expect(next.edges).toEqual([]);
  });

  it("removes before it upserts, so a node can be replaced and re-pointed in one call", () => {
    const next = applyDiagramChanges(base, {
      removeNodes: ["db"],
      upsertNodes: [{ id: "db", label: "MySQL" }],
      upsertEdges: [{ id: "api-db", from: "api", to: "db" }],
    });
    expect(next.nodes[1]).toEqual({ id: "db", label: "MySQL" });
    expect(next.edges).toEqual([{ id: "api-db", from: "api", to: "db" }]);
  });

  it("refuses a new edge without both ends, or one to a missing node", () => {
    expect(() => applyDiagramChanges(base, { upsertEdges: [{ id: "x", from: "api" }] })).toThrow(
      DiagramError,
    );
    expect(() =>
      applyDiagramChanges(base, { upsertEdges: [{ id: "x", from: "api", to: "nope" }] }),
    ).toThrow(/not a node/);
  });

  it("keeps an existing edge's ends when an upsert only relabels it", () => {
    const next = applyDiagramChanges(base, { upsertEdges: [{ id: "api-db", label: "writes" }] });
    expect(next.edges[0]).toEqual({ id: "api-db", from: "api", to: "db", label: "writes" });
  });

  it("refuses to grow past the node cap", () => {
    const many = Array.from({ length: MAX_DIAGRAM_NODES }, (_, i) => ({ id: `n${i}` }));
    const full = checkDiagram({ nodes: many, edges: [] });
    expect(() => applyDiagramChanges(full, { upsertNodes: [{ id: "one-more" }] })).toThrow(
      /at most/,
    );
  });

  it("tells additions apart from changes to what is there", () => {
    expect(onlyAdds(base, { upsertNodes: [{ id: "new" }] })).toBe(true);
    expect(onlyAdds(base, { upsertNodes: [{ id: "api", label: "x" }] })).toBe(false);
    expect(onlyAdds(base, { upsertEdges: [{ id: "api-db", label: "x" }] })).toBe(false);
    expect(onlyAdds(base, { removeEdges: ["api-db"] })).toBe(false);
  });
});

describe("whole diagrams", () => {
  it("refuses duplicate ids and dangling edges", () => {
    expect(() => checkDiagram({ nodes: [{ id: "a" }, { id: "a" }], edges: [] })).toThrow(
      /two nodes/,
    );
    expect(() =>
      checkDiagram({ nodes: [{ id: "a" }], edges: [{ id: "e", from: "a", to: "b" }] }),
    ).toThrow(/not a node/);
  });

  it("reads empty content as an empty diagram", () => {
    expect(parseDiagram("")).toEqual({ nodes: [], edges: [] });
  });
});
