/**
 * A scratch graph of how a pull request's code fits together, built up by the
 * agent as it reads.
 *
 * Working out a review order means holding a shape in mind — this handler calls
 * that service, which writes to that table — and a model that only has its own
 * transcript to work from tends to lose track of the far end of a chain by the
 * time it reaches the near one. Writing the relationships down as it goes gives
 * it something to query back, and gives the caller a structure to order steps
 * from once the exploring is done.
 *
 * The graph lives for one agent run and is never persisted: it describes the
 * code at one commit, and re-deriving it is cheaper than deciding whether a
 * stored copy is still true.
 */

export interface GraphNode {
  id: string;
  /** What the node is: "endpoint", "function", "table", "component", … */
  kind: string;
  file?: string;
  line?: number;
  summary?: string;
  /** True when this node is part of the pull request's own changes. */
  changed?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** How they relate: "calls", "imports", "reads", "writes", "renders", … */
  kind: string;
}

export interface CodeGraph {
  addNode(node: GraphNode): GraphNode;
  addEdge(edge: GraphEdge): GraphEdge | null;
  node(id: string): GraphNode | undefined;
  /** Edges touching `id`, in either direction. */
  edgesFor(id: string): { outgoing: GraphEdge[]; incoming: GraphEdge[] };
  nodes(): GraphNode[];
  edges(): GraphEdge[];
  /**
   * Nodes nothing points at. These are where a review starts — the outermost
   * edge of the change, an HTTP handler or a UI event, from which everything
   * else is reached.
   */
  entryPoints(): GraphNode[];
}

export function newCodeGraph(): CodeGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  return {
    addNode(node) {
      // Merge rather than replace: the agent often meets a node twice, once as
      // a bare name in a caller and later with a file and a summary, and the
      // second sighting should not erase what the first one established.
      const merged = { ...nodes.get(node.id), ...node };
      nodes.set(node.id, merged);
      return merged;
    },

    addEdge(edge) {
      if (edge.from === edge.to) return null;
      const duplicate = edges.some(
        (e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind,
      );
      if (duplicate) return null;
      // An edge implies both ends exist, so a node named only here is created
      // as a placeholder for a later `record_node` to fill in.
      for (const id of [edge.from, edge.to]) {
        if (!nodes.has(id)) nodes.set(id, { id, kind: "unknown" });
      }
      edges.push(edge);
      return edge;
    },

    node: (id) => nodes.get(id),

    edgesFor: (id) => ({
      outgoing: edges.filter((e) => e.from === id),
      incoming: edges.filter((e) => e.to === id),
    }),

    nodes: () => [...nodes.values()],
    edges: () => [...edges],

    entryPoints() {
      // A graph with no edges has nothing to order yet, and calling every
      // isolated node an entry point would say the change is entirely
      // disconnected — which is a claim about the code, not about the graph.
      if (edges.length === 0) return [];
      const pointedAt = new Set(edges.map((e) => e.to));
      return [...nodes.values()].filter((n) => !pointedAt.has(n.id));
    },
  };
}
