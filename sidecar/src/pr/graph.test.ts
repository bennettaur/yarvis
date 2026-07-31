import { describe, expect, it } from "bun:test";
import { newCodeGraph } from "./graph.ts";

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
});
