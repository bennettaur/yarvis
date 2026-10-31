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
 * The graph is built fresh for each agent run rather than updated: it
 * describes the code at one commit, and re-deriving it is cheaper than deciding
 * whether a stored copy is still true. A guide keeps the finished graph beside
 * its steps, stamped with the same commit, to draw the change's flow diagram.
 */

/** Most nodes kept for a diagram; past this it is a wall of boxes, not a picture. */
export const MAX_DIAGRAM_NODES = 60;
/** A loose bound on the stored payload, about two and a half edges per node. */
export const MAX_DIAGRAM_EDGES = 150;
/**
 * Longest span a node may claim when matched against the diff. The span is the
 * model's word, so without a bound one node could cover a whole file and take
 * the highlight from any change in it. A longer span counts as its first line.
 */
export const MAX_NODE_SPAN = 200;

export interface GraphNode {
  id: string;
  /** What the node is: "endpoint", "function", "table", "component", … */
  kind: string;
  file?: string;
  line?: number;
  /** Last line of the code, when it spans more than `line`. */
  endLine?: number;
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

/** Inclusive line ranges, at the PR head, that a pull request adds or removes lines at. */
export type LineRange = [start: number, end: number];

/**
 * The head-side lines a unified diff touches: each added line, plus the line a
 * deletion sits before. Context lines are left out, since the hunk only shows
 * them for reading.
 */
export function changedLineRanges(patch: string): LineRange[] {
  const ranges: LineRange[] = [];
  const mark = (line: number) => {
    const last = ranges.at(-1);
    if (last && line <= last[1] + 1) last[1] = Math.max(last[1], line);
    else ranges.push([line, line]);
  };
  let line: number | null = null;
  for (const row of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (header) {
      line = Number(header[1]);
    } else if (line === null || row.startsWith("\\")) {
      // Before the first hunk, or "\ No newline at end of file".
    } else if (row.startsWith("+")) {
      mark(line++);
    } else if (row.startsWith("-")) {
      mark(Math.max(line, 1));
    } else {
      line++;
    }
  }
  return ranges;
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
  /**
   * The graph as stored for a diagram, cut to {@link MAX_DIAGRAM_NODES}.
   * A node counts as changed only when its file and lines overlap what the
   * diff changes, keyed by path in `changedLines`. The model's own `changed`
   * flag is ignored, and so is a file name without lines on a real change.
   * The lines are still the model's, so a misled agent can place a box on a
   * real change under a misleading name, but not highlight code nothing
   * touched.
   */
  snapshot(changedLines: Map<string, LineRange[]>): { nodes: GraphNode[]; edges: GraphEdge[] };
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
      // A new first line makes the old last line meaningless.
      if (node.line !== undefined && node.endLine === undefined) delete merged.endLine;
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

    snapshot(changedLines) {
      const touchesDiff = (n: GraphNode) => {
        if (n.file === undefined || n.line === undefined) return false;
        const start = n.line;
        const end =
          n.endLine && n.endLine > start && n.endLine - start <= MAX_NODE_SPAN ? n.endLine : start;
        return (changedLines.get(n.file) ?? []).some(([from, to]) => from <= end && to >= start);
      };
      const marked = [...nodes.values()].map((n) => ({ ...n, changed: touchesDiff(n) }));
      // The change's own code is what the diagram is about, so it is kept first
      // and the surrounding flow fills what room is left.
      const kept = [...marked.filter((n) => n.changed), ...marked.filter((n) => !n.changed)].slice(
        0,
        MAX_DIAGRAM_NODES,
      );
      const keptIds = new Set(kept.map((n) => n.id));
      return {
        // Back in recording order, so the diagram's rows follow the exploration.
        nodes: marked.filter((n) => keptIds.has(n.id)),
        edges: edges
          .filter((e) => keptIds.has(e.from) && keptIds.has(e.to))
          .slice(0, MAX_DIAGRAM_EDGES),
      };
    },
  };
}
