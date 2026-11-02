import { z } from "zod";

/**
 * The content of an `excalidraw` artifact: boxes, free text and arrows, each
 * with an id the agent picked, so a later turn can change one element without
 * resending the rest. The app turns it into Excalidraw elements when it draws
 * it (`src/lib/artifacts/diagram.ts`).
 *
 * This is a smaller language than Excalidraw's own scene: a model gets arrow
 * bindings and coordinates wrong far more often than it gets "a box called api
 * points at a box called db" wrong. Positions are optional, and nodes without
 * one are laid out left to right by the app.
 */

/** Past these a diagram is too big to read on screen, and too big to send back to the model whole. */
export const MAX_DIAGRAM_NODES = 300;
export const MAX_DIAGRAM_EDGES = 600;

/** Colour names, not hex: the app maps them onto Excalidraw's palette so they read in both themes. */
export const DIAGRAM_COLORS = [
  "gray",
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
] as const;

export const DIAGRAM_SHAPES = ["rectangle", "ellipse", "diamond", "text"] as const;

/** Plain ids, so one can't break out of the element ids the app builds from it. */
const elementId = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,64}$/, "ids are 1-64 letters, digits, or _ . : -");
const label = z.string().max(500);
const coordinate = z.number().finite().min(-100_000).max(100_000);
const size = z.number().finite().min(10).max(5_000);

export const diagramNodeSchema = z.object({
  id: elementId,
  label: label.optional(),
  shape: z.enum(DIAGRAM_SHAPES).optional(),
  color: z.enum(DIAGRAM_COLORS).optional(),
  x: coordinate.optional(),
  y: coordinate.optional(),
  width: size.optional(),
  height: size.optional(),
});

export const diagramEdgeSchema = z.object({
  id: elementId,
  from: elementId,
  to: elementId,
  label: label.optional(),
  dashed: z.boolean().optional(),
});

export const diagramSchema = z.object({
  nodes: z.array(diagramNodeSchema).max(MAX_DIAGRAM_NODES),
  edges: z.array(diagramEdgeSchema).max(MAX_DIAGRAM_EDGES),
});

export type DiagramNode = z.infer<typeof diagramNodeSchema>;
export type DiagramEdge = z.infer<typeof diagramEdgeSchema>;
export type Diagram = z.infer<typeof diagramSchema>;

/** A change to a diagram. Upserts merge into an element with the same id, or add one. */
export const diagramChangesSchema = z.object({
  upsertNodes: z.array(diagramNodeSchema).max(MAX_DIAGRAM_NODES).optional(),
  upsertEdges: z
    .array(diagramEdgeSchema.partial({ from: true, to: true }))
    .max(MAX_DIAGRAM_EDGES)
    .optional(),
  /** Removing a node removes the edges attached to it. */
  removeNodes: z.array(elementId).max(MAX_DIAGRAM_NODES).optional(),
  removeEdges: z.array(elementId).max(MAX_DIAGRAM_EDGES).optional(),
});

export type DiagramChanges = z.infer<typeof diagramChangesSchema>;

export class DiagramError extends Error {}

/** True when the changes only add elements, never touching one already there. */
export function onlyAdds(diagram: Diagram, changes: DiagramChanges): boolean {
  if (changes.removeNodes?.length || changes.removeEdges?.length) return false;
  const nodeIds = new Set(diagram.nodes.map((n) => n.id));
  const edgeIds = new Set(diagram.edges.map((e) => e.id));
  return (
    !(changes.upsertNodes ?? []).some((n) => nodeIds.has(n.id)) &&
    !(changes.upsertEdges ?? []).some((e) => edgeIds.has(e.id))
  );
}

/** Reads stored content back. An empty string is an empty diagram, so a fresh row needs no seeding. */
export function parseDiagram(content: string): Diagram {
  if (content.trim() === "") return { nodes: [], edges: [] };
  return diagramSchema.parse(JSON.parse(content));
}

/**
 * Checks what a whole diagram must satisfy beyond its schema: unique ids, and
 * every edge joining two nodes that exist. Throws DiagramError naming the
 * first problem, worded for the model to fix.
 */
export function checkDiagram(diagram: Diagram): Diagram {
  const nodeIds = new Set<string>();
  for (const node of diagram.nodes) {
    if (nodeIds.has(node.id)) throw new DiagramError(`two nodes have the id "${node.id}"`);
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of diagram.edges) {
    if (edgeIds.has(edge.id)) throw new DiagramError(`two edges have the id "${edge.id}"`);
    edgeIds.add(edge.id);
    for (const end of [edge.from, edge.to]) {
      if (!nodeIds.has(end)) {
        throw new DiagramError(`edge "${edge.id}" points at "${end}", which is not a node`);
      }
    }
  }
  if (diagram.nodes.length > MAX_DIAGRAM_NODES) {
    throw new DiagramError(`a diagram can have at most ${MAX_DIAGRAM_NODES} nodes`);
  }
  if (diagram.edges.length > MAX_DIAGRAM_EDGES) {
    throw new DiagramError(`a diagram can have at most ${MAX_DIAGRAM_EDGES} edges`);
  }
  return diagram;
}

/**
 * Applies changes in a fixed order: removals, then node upserts, then edge
 * upserts, so one call can replace a node and re-point its edges. A new edge
 * needs `from` and `to`; an existing one keeps its ends unless given new ones.
 */
export function applyDiagramChanges(diagram: Diagram, changes: DiagramChanges): Diagram {
  const removedNodes = new Set(changes.removeNodes ?? []);
  const removedEdges = new Set(changes.removeEdges ?? []);
  const nodes = new Map(
    diagram.nodes.filter((n) => !removedNodes.has(n.id)).map((n) => [n.id, n] as const),
  );
  const edges = new Map(
    diagram.edges
      .filter(
        (e) => !removedEdges.has(e.id) && !removedNodes.has(e.from) && !removedNodes.has(e.to),
      )
      .map((e) => [e.id, e] as const),
  );

  for (const node of changes.upsertNodes ?? []) {
    nodes.set(node.id, { ...nodes.get(node.id), ...node });
  }
  for (const edge of changes.upsertEdges ?? []) {
    const merged = { ...edges.get(edge.id), ...edge };
    if (merged.from === undefined || merged.to === undefined) {
      throw new DiagramError(`new edge "${edge.id}" needs both from and to`);
    }
    edges.set(edge.id, merged as DiagramEdge);
  }
  return checkDiagram({ nodes: [...nodes.values()], edges: [...edges.values()] });
}

export function serializeDiagram(diagram: Diagram): string {
  return JSON.stringify(diagram);
}
