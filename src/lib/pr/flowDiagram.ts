/**
 * Lays out a guide's code graph as a left-to-right flow diagram.
 *
 * The output is Excalidraw's element skeleton format, kept as plain data here
 * so the layout can be tested without loading Excalidraw itself, which needs a
 * canvas and is only fetched when the diagram is opened.
 */

/** A piece of code the guide agent recorded while exploring the change. */
export interface PrGraphNode {
  id: string;
  kind: string;
  file?: string;
  line?: number;
  summary?: string;
  /** True when the pull request changes this code. */
  changed?: boolean;
}

export interface PrGraphEdge {
  from: string;
  to: string;
  kind: string;
}

export interface PrGuideGraph {
  nodes: PrGraphNode[];
  edges: PrGraphEdge[];
}

const BOX_WIDTH = 240;
const BOX_HEIGHT = 80;
/** Wide enough for an edge's label to sit on its arrow between two columns. */
const COLUMN_GAP = 140;
const ROW_GAP = 40;

/** Sky for the change's own code, grey and dashed for the code around it. */
const CHANGED_STYLE = { strokeColor: "#38bdf8", backgroundColor: "#0c4a6e" } as const;
const CONTEXT_STYLE = { strokeColor: "#71717a", backgroundColor: "transparent" } as const;

/**
 * Each node's column: how many hops it sits from the outermost code that calls
 * into it, taking the longest route so a node always lands to the right of
 * everything that reaches it.
 *
 * A cycle has no longest route, so relaxing stops after one pass per node. That
 * is enough to place every node of an acyclic graph, and in a cyclic one it
 * leaves the cycle's nodes in some column rather than looping.
 */
export function layerNodes(graph: PrGuideGraph): Map<string, number> {
  const layer = new Map(graph.nodes.map((n) => [n.id, 0]));
  const edges = graph.edges.filter((e) => layer.has(e.from) && layer.has(e.to));
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let moved = false;
    for (const edge of edges) {
      const next = (layer.get(edge.from) ?? 0) + 1;
      if (next > (layer.get(edge.to) ?? 0) && next < graph.nodes.length) {
        layer.set(edge.to, next);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return layer;
}

/** The box text: the node's name, then what it is and where it lives. */
function boxLabel(node: PrGraphNode): string {
  const where = node.file
    ? `${node.file.split("/").pop()}${node.line ? `:${node.line}` : ""}`
    : undefined;
  return [node.id, [node.kind, where].filter(Boolean).join(" · ")].join("\n");
}

/** Element ids are generated rather than taken from the graph, whose ids are model-written free text. */
const boxId = (index: number) => `node-${index}`;

/**
 * Excalidraw element skeletons for the graph, ready for
 * `convertToExcalidrawElements`. Nodes are boxes in columns by
 * {@link layerNodes}; edges are arrows bound to the boxes at either end, so
 * dragging a box in the diagram drags its arrows with it.
 */
export function toExcalidrawSkeleton(graph: PrGuideGraph): Record<string, unknown>[] {
  const layers = layerNodes(graph);
  const rowsUsed = new Map<number, number>();
  const ids = new Map<string, string>();
  const elements: Record<string, unknown>[] = [];

  graph.nodes.forEach((node, index) => {
    const column = layers.get(node.id) ?? 0;
    const row = rowsUsed.get(column) ?? 0;
    rowsUsed.set(column, row + 1);
    const id = boxId(index);
    ids.set(node.id, id);
    elements.push({
      type: "rectangle",
      id,
      x: column * (BOX_WIDTH + COLUMN_GAP),
      y: row * (BOX_HEIGHT + ROW_GAP),
      width: BOX_WIDTH,
      height: BOX_HEIGHT,
      roundness: { type: 3 },
      ...(node.changed ? CHANGED_STYLE : CONTEXT_STYLE),
      fillStyle: "solid",
      strokeStyle: node.changed ? "solid" : "dashed",
      label: { text: boxLabel(node), fontSize: 14 },
    });
  });

  for (const edge of graph.edges) {
    const start = ids.get(edge.from);
    const end = ids.get(edge.to);
    if (!start || !end) continue;
    elements.push({
      type: "arrow",
      // Excalidraw routes a bound arrow between its boxes, so the position only
      // has to be somewhere sensible before it does.
      x: 0,
      y: 0,
      strokeColor: "#a1a1aa",
      start: { id: start },
      end: { id: end },
      label: { text: edge.kind, fontSize: 12 },
    });
  }
  return elements;
}
