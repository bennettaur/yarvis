import { describe, expect, it } from "bun:test";
import { changedLineRanges, MAX_DIAGRAM_EDGES, MAX_DIAGRAM_NODES, newCodeGraph } from "./graph.ts";

describe("newCodeGraph", () => {
  it("keeps what an earlier sighting established", () => {
    const graph = newCodeGraph();
    graph.addNode({
      id: "handler",
      kind: "endpoint",
      file: "src/api.ts",
      summary: "creates an order",
    });
    // A second sighting names the line but says nothing about the file, and
    // must not wipe out what was already known.
    const merged = graph.addNode({ id: "handler", kind: "endpoint", line: 42 });
    expect(merged).toEqual({
      id: "handler",
      kind: "endpoint",
      file: "src/api.ts",
      summary: "creates an order",
      line: 42,
    });
  });

  it("creates placeholders for nodes named only by an edge", () => {
    const graph = newCodeGraph();
    graph.addEdge({ from: "a", to: "b", kind: "calls" });
    expect(graph.node("a")).toEqual({ id: "a", kind: "unknown" });
    expect(graph.node("b")).toEqual({ id: "b", kind: "unknown" });
  });

  it("does not stack duplicate edges", () => {
    const graph = newCodeGraph();
    expect(graph.addEdge({ from: "a", to: "b", kind: "calls" })).not.toBeNull();
    expect(graph.addEdge({ from: "a", to: "b", kind: "calls" })).toBeNull();
    expect(graph.edges()).toHaveLength(1);
  });

  // The same pair can relate in more than one way.
  it("keeps edges of different kinds between the same nodes", () => {
    const graph = newCodeGraph();
    graph.addEdge({ from: "a", to: "b", kind: "calls" });
    graph.addEdge({ from: "a", to: "b", kind: "imports" });
    expect(graph.edges()).toHaveLength(2);
  });

  it("refuses an edge from a node to itself", () => {
    const graph = newCodeGraph();
    expect(graph.addEdge({ from: "a", to: "a", kind: "calls" })).toBeNull();
    expect(graph.edges()).toEqual([]);
  });

  it("reports both directions around a node", () => {
    const graph = newCodeGraph();
    graph.addEdge({ from: "route", to: "service", kind: "calls" });
    graph.addEdge({ from: "service", to: "table", kind: "writes" });
    expect(graph.edgesFor("service")).toEqual({
      outgoing: [{ from: "service", to: "table", kind: "writes" }],
      incoming: [{ from: "route", to: "service", kind: "calls" }],
    });
  });

  // The outside-in order a review wants starts from whatever nothing else
  // reaches — the HTTP handler, not the table it eventually writes.
  it("finds the outermost nodes", () => {
    const graph = newCodeGraph();
    graph.addEdge({ from: "route", to: "service", kind: "calls" });
    graph.addEdge({ from: "service", to: "table", kind: "writes" });
    expect(graph.entryPoints().map((n) => n.id)).toEqual(["route"]);
  });

  // Otherwise every isolated node would come back as an entry point, which
  // reads as a claim that the change is entirely disconnected.
  it("names no entry points before any relationship is recorded", () => {
    const graph = newCodeGraph();
    graph.addNode({ id: "a", kind: "function" });
    graph.addNode({ id: "b", kind: "function" });
    expect(graph.entryPoints()).toEqual([]);
  });

  it("finds several entry points when a change has more than one way in", () => {
    const graph = newCodeGraph();
    graph.addEdge({ from: "http", to: "service", kind: "calls" });
    graph.addEdge({ from: "cron", to: "service", kind: "calls" });
    expect(
      graph
        .entryPoints()
        .map((n) => n.id)
        .sort(),
    ).toEqual(["cron", "http"]);
  });

  describe("snapshot", () => {
    it("marks a node changed from the diff, not the model's claim", () => {
      const graph = newCodeGraph();
      graph.addNode({
        id: "handler",
        kind: "endpoint",
        file: "src/api.ts",
        line: 12,
        changed: false,
      });
      graph.addNode({
        id: "store",
        kind: "function",
        file: "src/store.ts",
        line: 3,
        changed: true,
      });
      // No file to check the claim against, so it is not taken.
      graph.addNode({ id: "orders", kind: "table", changed: true });
      const { nodes } = graph.snapshot(new Map([["src/api.ts", [[10, 14]]]]));
      expect(Object.fromEntries(nodes.map((n) => [n.id, n.changed]))).toEqual({
        handler: true,
        store: false,
        orders: false,
      });
    });

    // A file name alone is the model's word too: an injected node can point at
    // a changed file to borrow its highlight.
    it("does not mark a node in a changed file whose lines the diff doesn't touch", () => {
      const graph = newCodeGraph();
      graph.addNode({
        id: "helper",
        kind: "function",
        file: "src/api.ts",
        line: 80,
        changed: true,
      });
      graph.addNode({ id: "unplaced", kind: "function", file: "src/api.ts", changed: true });
      const { nodes } = graph.snapshot(new Map([["src/api.ts", [[10, 14]]]]));
      expect(nodes.map((n) => n.changed)).toEqual([false, false]);
    });

    it("marks a node whose span takes in a change below its first line", () => {
      const graph = newCodeGraph();
      graph.addNode({ id: "fn", kind: "function", file: "src/api.ts", line: 5, endLine: 20 });
      // An end before the start is read as a single line, not a span.
      graph.addNode({ id: "odd", kind: "function", file: "src/api.ts", line: 6, endLine: 1 });
      const { nodes } = graph.snapshot(new Map([["src/api.ts", [[18, 18]]]]));
      expect(nodes.map((n) => n.changed)).toEqual([true, false]);
    });

    it("keeps changed code first when the graph is too big to draw", () => {
      const graph = newCodeGraph();
      for (let i = 0; i < MAX_DIAGRAM_NODES; i++) {
        graph.addNode({ id: `context-${i}`, kind: "function", file: `src/context${i}.ts` });
      }
      graph.addNode({ id: "changed", kind: "function", file: "src/changed.ts", line: 1 });
      graph.addEdge({ from: "changed", to: "context-0", kind: "calls" });
      graph.addEdge({ from: "context-1", to: `context-${MAX_DIAGRAM_NODES - 1}`, kind: "calls" });

      const { nodes, edges } = graph.snapshot(new Map([["src/changed.ts", [[1, 1]]]]));
      expect(nodes).toHaveLength(MAX_DIAGRAM_NODES);
      expect(nodes.map((n) => n.id)).toContain("changed");
      expect(nodes.map((n) => n.id)).not.toContain(`context-${MAX_DIAGRAM_NODES - 1}`);
      // An edge to a node that was cut would point at nothing.
      expect(edges).toEqual([{ from: "changed", to: "context-0", kind: "calls" }]);
    });

    it("caps the edges it keeps", () => {
      const graph = newCodeGraph();
      for (let from = 0; from < 20; from++) {
        for (let to = 0; to < 20; to++) {
          if (from !== to) graph.addEdge({ from: `n${from}`, to: `n${to}`, kind: "calls" });
        }
      }
      expect(graph.snapshot(new Map()).edges).toHaveLength(MAX_DIAGRAM_EDGES);
    });
  });
});

describe("changedLineRanges", () => {
  it("takes the added lines and where a deletion sits, not the context", () => {
    const patch = [
      "@@ -1,5 +1,6 @@",
      " import a",
      "-import b",
      "+import c",
      "+import d",
      " ",
      " export {}",
      "@@ -20,4 +21,3 @@ function f() {",
      " one",
      "-two",
      " three",
      "\\ No newline at end of file",
    ].join("\n");
    expect(changedLineRanges(patch)).toEqual([
      [2, 3],
      [22, 22],
    ]);
  });

  it("reads a new file as all added", () => {
    expect(changedLineRanges("@@ -0,0 +1,2 @@\n+a\n+b")).toEqual([[1, 2]]);
  });
});
