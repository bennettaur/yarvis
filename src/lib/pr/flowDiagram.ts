/**
 * Lays out a guide's code graph as a left-to-right flow diagram.
 *
 * The output is Excalidraw's element skeleton format, kept as plain data here
 * so the layout can be tested without loading Excalidraw itself, which needs a
 * canvas and is only fetched when the diagram is opened.
 */

import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";

/*
 * The graph types mirror the sidecar's `GraphNode`, `GraphEdge` and
 * `PrGuideGraph` (`sidecar/src/pr/graph.ts`, `sidecar/src/db/schema.ts`), the
 * way `guide.ts` mirrors the step types.
 */

/** A piece of code the guide agent recorded while exploring the change. */
export interface PrGraphNode {
  id: string;
  kind: string;
  file?: string;
  line?: number;
  endLine?: number;
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

/*
 * The change's own code stands out; the code around it recedes. These are
 * light-theme colours from Excalidraw's palette: its dark theme draws the
 * light colours and inverts the whole canvas, so dark-tuned colours would come
 * out flipped.
 */
const CHANGED_STYLE = { strokeColor: "#1971c2", backgroundColor: "#a5d8ff" } as const;
const CONTEXT_STYLE = { strokeColor: "#868e96", backgroundColor: "transparent" } as const;
const ARROW_COLOR = "#495057";

/**
 * Excalidraw's Helvetica, which is a system font. Its hand-drawn default is
 * fetched from a CDN, which the app's content security policy refuses.
 */
export const LABEL_FONT_FAMILY = 2;

/** Excalidraw's `ROUNDNESS.ADAPTIVE_RADIUS`, written out so this file loads no Excalidraw code. */
const ADAPTIVE_RADIUS = 3;

/**
 * Each node's column: how many hops it sits from the outermost code that calls
 * into it, taking the longest route so a node always lands to the right of
 * everything that reaches it.
 *
 * A cycle has no longest route, so relaxing stops after one pass per node, and
 * no node goes past the last column an acyclic graph could need. That places
 * every node of an acyclic graph, and in a cyclic one it leaves the cycle's
 * nodes in some column rather than pushing them ever further right.
 */
export function nodeColumns(graph: PrGuideGraph): Map<string, number> {
  const column = new Map(graph.nodes.map((n) => [n.id, 0]));
  const lastColumn = graph.nodes.length - 1;
  const edges = graph.edges.filter((e) => column.has(e.from) && column.has(e.to));
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let moved = false;
    for (const edge of edges) {
      const next = (column.get(edge.from) ?? 0) + 1;
      if (next > (column.get(edge.to) ?? 0) && next <= lastColumn) {
        column.set(edge.to, next);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return column;
}

/** The box text: the node's name, then what it is and where it lives. */
function boxLabel(node: PrGraphNode): string {
  const fileName = node.file?.split("/").pop();
  const location = fileName && node.line ? `${fileName}:${node.line}` : fileName;
  return [node.id, [node.kind, location].filter(Boolean).join(" · ")].join("\n");
}

/**
 * Excalidraw element skeletons for the graph, ready for
 * `convertToExcalidrawElements`. Nodes are boxes in columns by
 * {@link nodeColumns}; edges are arrows bound to the boxes at either end, so
 * dragging a box in the diagram drags its arrows with it.
 */
export function toExcalidrawSkeleton(graph: PrGuideGraph): ExcalidrawElementSkeleton[] {
  const columns = nodeColumns(graph);
  const rowsUsed = new Map<number, number>();
  const boxes = new Map<string, { id: string; x: number; y: number }>();
  const elements: ExcalidrawElementSkeleton[] = [];

  graph.nodes.forEach((node, index) => {
    const column = columns.get(node.id) ?? 0;
    const row = rowsUsed.get(column) ?? 0;
    rowsUsed.set(column, row + 1);
    // Generated rather than taken from the graph, whose ids are model-written free text.
    const box = {
      id: `node-${index}`,
      x: column * (BOX_WIDTH + COLUMN_GAP),
      y: row * (BOX_HEIGHT + ROW_GAP),
    };
    boxes.set(node.id, box);
    elements.push({
      type: "rectangle",
      ...box,
      width: BOX_WIDTH,
      height: BOX_HEIGHT,
      roundness: { type: ADAPTIVE_RADIUS },
      ...(node.changed ? CHANGED_STYLE : CONTEXT_STYLE),
      fillStyle: "solid",
      strokeStyle: node.changed ? "solid" : "dashed",
      label: { text: boxLabel(node), fontSize: 14, fontFamily: LABEL_FONT_FAMILY },
    });
  });

  for (const edge of graph.edges) {
    const start = boxes.get(edge.from);
    const end = boxes.get(edge.to);
    if (!start || !end) continue;
    // Excalidraw binds the arrow's ends to the boxes but keeps the points it is
    // given, so it has to be drawn from one box's right edge to the other's left.
    const x = start.x + BOX_WIDTH;
    const y = start.y + BOX_HEIGHT / 2;
    elements.push({
      type: "arrow",
      x,
      y,
      width: end.x - x,
      height: end.y + BOX_HEIGHT / 2 - y,
      strokeColor: ARROW_COLOR,
      start: { id: start.id },
      end: { id: end.id },
      label: { text: edge.kind, fontSize: 12, fontFamily: LABEL_FONT_FAMILY },
    });
  }
  return elements;
}
