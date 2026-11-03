import { describe, expect, it } from "bun:test";
import {
  applyDiagramChanges,
  checkDiagram,
  type Diagram,
  diagramChangesSchema,
  diagramSchema,
  MAX_ARTIFACT_DIAGRAM_EDGES,
  MAX_ARTIFACT_DIAGRAM_NODES,
  onlyAdds,
  parseDiagram,
  placesNodes,
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
      /needs both from and to/,
    );
    expect(() => applyDiagramChanges(base, { upsertEdges: [{ id: "x", to: "api" }] })).toThrow(
      /needs both from and to/,
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
    const many = Array.from({ length: MAX_ARTIFACT_DIAGRAM_NODES }, (_, i) => ({ id: `n${i}` }));
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
    // One new element beside one existing one is still a change to what is there.
    expect(onlyAdds(base, { upsertNodes: [{ id: "new" }, { id: "api", label: "x" }] })).toBe(false);
    expect(
      onlyAdds(base, {
        upsertEdges: [
          { id: "new-edge", from: "api", to: "db" },
          { id: "api-db", label: "x" },
        ],
      }),
    ).toBe(false);
  });

  it("tells a placed or sized node from one left to the layout", () => {
    expect(placesNodes({ upsertNodes: [{ id: "a", label: "A" }] })).toBe(false);
    expect(placesNodes({ upsertEdges: [{ id: "e", from: "a", to: "b" }] })).toBe(false);
    for (const field of ["x", "y", "width", "height"]) {
      expect(placesNodes({ upsertNodes: [{ id: "b" }, { id: "a", [field]: 20 }] })).toBe(true);
    }
  });
});

describe("what a tool call may send", () => {
  it("takes a normal change", () => {
    const parsed = diagramChangesSchema.safeParse({
      upsertNodes: [{ id: "queue", label: "Queue", shape: "diamond", color: "orange", x: 10 }],
      upsertEdges: [{ id: "api-queue", from: "api", to: "queue", dashed: true }],
      removeNodes: ["db"],
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses ids that aren't plain", () => {
    for (const id of ["a b", 'x"y', "api;", "", "a".repeat(65)]) {
      expect(diagramSchema.safeParse({ nodes: [{ id }], edges: [] }).success).toBe(false);
    }
    expect(diagramSchema.safeParse({ nodes: [{ id: "a".repeat(64) }], edges: [] }).success).toBe(
      true,
    );
  });

  it("refuses oversized labels, far coordinates and tiny or huge sizes", () => {
    const node = (extra: object) =>
      diagramChangesSchema.safeParse({ upsertNodes: [{ id: "a", ...extra }] });
    expect(node({ label: "x".repeat(500) }).success).toBe(true);
    expect(node({ label: "x".repeat(501) }).success).toBe(false);
    expect(node({ x: 100_000, y: -100_000 }).success).toBe(true);
    expect(node({ x: 100_001 }).success).toBe(false);
    expect(node({ y: -100_001 }).success).toBe(false);
    expect(node({ width: 10, height: 5_000 }).success).toBe(true);
    expect(node({ width: 9 }).success).toBe(false);
    expect(node({ height: 5_001 }).success).toBe(false);
  });

  it("caps how many elements one call sends", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);
    const nodes = (n: number) => ids(n).map((id) => ({ id }));
    expect(
      diagramChangesSchema.safeParse({ upsertNodes: nodes(MAX_ARTIFACT_DIAGRAM_NODES) }).success,
    ).toBe(true);
    expect(
      diagramChangesSchema.safeParse({ upsertNodes: nodes(MAX_ARTIFACT_DIAGRAM_NODES + 1) })
        .success,
    ).toBe(false);
    expect(
      diagramChangesSchema.safeParse({ removeNodes: ids(MAX_ARTIFACT_DIAGRAM_NODES + 1) }).success,
    ).toBe(false);
    expect(
      diagramChangesSchema.safeParse({ removeEdges: ids(MAX_ARTIFACT_DIAGRAM_EDGES + 1) }).success,
    ).toBe(false);
    expect(
      diagramChangesSchema.safeParse({
        upsertEdges: ids(MAX_ARTIFACT_DIAGRAM_EDGES + 1).map((id) => ({ id })),
      }).success,
    ).toBe(false);
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
    const ab = [{ id: "a" }, { id: "b" }];
    expect(() =>
      checkDiagram({
        nodes: ab,
        edges: [
          { id: "e", from: "a", to: "b" },
          { id: "e", from: "b", to: "a" },
        ],
      }),
    ).toThrow(/two edges/);
  });

  it("caps the edges a merge adds up to", () => {
    const ab = [{ id: "a" }, { id: "b" }];
    const edges = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `e${i}`, from: "a", to: "b" }));
    expect(() =>
      checkDiagram({ nodes: ab, edges: edges(MAX_ARTIFACT_DIAGRAM_EDGES) }),
    ).not.toThrow();
    expect(() => checkDiagram({ nodes: ab, edges: edges(MAX_ARTIFACT_DIAGRAM_EDGES + 1) })).toThrow(
      /at most/,
    );
  });

  it("reads empty content as an empty diagram", () => {
    expect(parseDiagram("")).toEqual({ nodes: [], edges: [] });
  });
});
