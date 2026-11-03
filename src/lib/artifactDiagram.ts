/**
 * Draws a diagram artifact: turns its nodes and edges into Excalidraw element
 * skeletons for `convertToExcalidrawElements`.
 *
 * Plain data here so the layout can be tested without loading Excalidraw,
 * which needs a canvas and is only fetched when a diagram is opened.
 */

import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import {
  ADAPTIVE_RADIUS,
  ARROW_COLOR,
  COLUMN_GAP,
  LABEL_FONT_FAMILY,
  nodeColumns,
  ROW_GAP,
} from "./pr/flowDiagram";

/*
 * These mirror the sidecar's `Diagram` (`sidecar/src/artifacts/diagram.ts`),
 * which validates what the agent writes.
 */

export type DiagramShape = "rectangle" | "ellipse" | "diamond" | "text";
export type DiagramColor = "gray" | "blue" | "green" | "yellow" | "orange" | "red" | "purple";

export interface DiagramNode {
  id: string;
  label?: string;
  shape?: DiagramShape;
  color?: DiagramColor;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

const SHAPES = new Set<string>(["rectangle", "ellipse", "diamond", "text"]);

/*
 * Light-theme colours from Excalidraw's palette. Its dark theme inverts the
 * whole canvas, so dark-tuned colours would come out flipped.
 */
const COLORS: Record<DiagramColor, { strokeColor: string; backgroundColor: string }> = {
  gray: { strokeColor: "#495057", backgroundColor: "#e9ecef" },
  blue: { strokeColor: "#1971c2", backgroundColor: "#a5d8ff" },
  green: { strokeColor: "#2f9e44", backgroundColor: "#b2f2bb" },
  yellow: { strokeColor: "#f08c00", backgroundColor: "#ffec99" },
  orange: { strokeColor: "#e8590c", backgroundColor: "#ffd8a8" },
  red: { strokeColor: "#e03131", backgroundColor: "#ffc9c9" },
  purple: { strokeColor: "#6741d9", backgroundColor: "#d0bfff" },
};
/** Own keys only: an `in` check would also pass "toString" and the like. */
const COLOR_NAMES = new Set<string>(Object.keys(COLORS));
const PLAIN = { strokeColor: "#1e1e1e", backgroundColor: "transparent" } as const;

const DEFAULT_SIZE: Record<DiagramShape, { width: number; height: number }> = {
  rectangle: { width: 200, height: 80 },
  ellipse: { width: 180, height: 90 },
  diamond: { width: 180, height: 120 },
  text: { width: 200, height: 40 },
};
/** Widest and tallest default size, so auto-placed nodes of any shape share one grid. */
const CELL = { width: 200, height: 120 };

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The sidecar's cap on a label, applied again here. */
const MAX_LABEL = 500;

const finiteOrUndefined = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const cleanLabel = (v: unknown): string | undefined =>
  // Newlines stay, since a label may want two lines. Other control characters
  // go, and so do format characters like a right-to-left override, which can
  // make a label read differently from what it says.
  typeof v === "string" ? v.replace(/(?!\n)[\p{Cc}\p{Cf}]/gu, "").slice(0, MAX_LABEL) : undefined;

/**
 * Reads an artifact's stored content. The sidecar validated it on write, but
 * the content is still model-written text, so anything malformed is dropped
 * here rather than handed to Excalidraw.
 */
export function parseDiagram(content: string): Diagram {
  if (content.trim() === "") return { nodes: [], edges: [] };
  const raw = JSON.parse(content) as { nodes?: unknown; edges?: unknown };
  const nodes: DiagramNode[] = [];
  for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
    if (typeof n?.id !== "string" || !ID.test(n.id)) continue;
    nodes.push({
      id: n.id,
      label: cleanLabel(n.label),
      shape: SHAPES.has(n.shape) ? n.shape : undefined,
      color: COLOR_NAMES.has(n.color) ? n.color : undefined,
      x: finiteOrUndefined(n.x),
      y: finiteOrUndefined(n.y),
      width: finiteOrUndefined(n.width),
      height: finiteOrUndefined(n.height),
    });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges: DiagramEdge[] = [];
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (typeof e?.id !== "string" || !ID.test(e.id)) continue;
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    edges.push({
      id: e.id,
      from: e.from,
      to: e.to,
      label: cleanLabel(e.label),
      dashed: e.dashed === true,
    });
  }
  return { nodes, edges };
}

interface Box {
  elementId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where a node sits: its own x/y when it has both, otherwise a grid cell by
 * its column along the edges (see `nodeColumns`) and its order in that column.
 */
function layout(diagram: Diagram): Map<string, Box> {
  const columns = nodeColumns(diagram);
  const rowsUsed = new Map<number, number>();
  const boxes = new Map<string, Box>();
  for (const node of diagram.nodes) {
    const size = DEFAULT_SIZE[node.shape ?? "rectangle"];
    const width = node.width ?? size.width;
    const height = node.height ?? size.height;
    let { x, y } = node;
    if (x === undefined || y === undefined) {
      const column = columns.get(node.id) ?? 0;
      const row = rowsUsed.get(column) ?? 0;
      rowsUsed.set(column, row + 1);
      x = column * (CELL.width + COLUMN_GAP);
      y = row * (CELL.height + ROW_GAP);
    }
    boxes.set(node.id, { elementId: `node:${node.id}`, x, y, width, height });
  }
  return boxes;
}

/** Where the line from a box's centre toward `toward` crosses the box's edge. */
function edgePoint(box: Box, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : box.width / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : box.height / 2 / Math.abs(dy),
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}

const center = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/**
 * Excalidraw element skeletons for the diagram. Element ids come from the
 * diagram's own ids, so a redraw after an edit keeps each element's identity.
 * Arrows are bound to the shapes at either end, so dragging a shape drags its
 * arrows with it.
 */
export function diagramToSkeleton(diagram: Diagram): ExcalidrawElementSkeleton[] {
  const boxes = layout(diagram);
  const elements: ExcalidrawElementSkeleton[] = [];

  for (const node of diagram.nodes) {
    const box = boxes.get(node.id);
    if (!box) continue;
    const shape = node.shape ?? "rectangle";
    if (shape === "text") {
      elements.push({
        type: "text",
        id: box.elementId,
        x: box.x,
        y: box.y,
        text: node.label ?? "",
        fontSize: 16,
        fontFamily: LABEL_FONT_FAMILY,
        strokeColor: node.color ? COLORS[node.color].strokeColor : PLAIN.strokeColor,
      });
      continue;
    }
    elements.push({
      type: shape,
      id: box.elementId,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      ...(shape === "rectangle" ? { roundness: { type: ADAPTIVE_RADIUS } } : {}),
      ...(node.color ? COLORS[node.color] : PLAIN),
      fillStyle: "solid",
      ...(node.label
        ? { label: { text: node.label, fontSize: 16, fontFamily: LABEL_FONT_FAMILY } }
        : {}),
    });
  }

  for (const edge of diagram.edges) {
    const start = boxes.get(edge.from);
    const end = boxes.get(edge.to);
    if (!start || !end) continue;
    // Excalidraw binds the arrow's ends but keeps the points it is given, so
    // the arrow is drawn from one shape's edge to the other's.
    const from = edgePoint(start, center(end));
    const to = edgePoint(end, center(start));
    elements.push({
      type: "arrow",
      id: `edge:${edge.id}`,
      x: from.x,
      y: from.y,
      width: to.x - from.x,
      height: to.y - from.y,
      strokeColor: ARROW_COLOR,
      strokeStyle: edge.dashed ? "dashed" : "solid",
      start: { id: start.elementId },
      end: { id: end.elementId },
      ...(edge.label
        ? { label: { text: edge.label, fontSize: 13, fontFamily: LABEL_FONT_FAMILY } }
        : {}),
    });
  }
  return elements;
}
