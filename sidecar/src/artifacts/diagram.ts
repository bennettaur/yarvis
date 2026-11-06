import { z } from "zod";
import { shapeHeight } from "./textMetrics.ts";

/**
 * The content of an `excalidraw` artifact: Excalidraw element skeletons, the
 * input `convertToExcalidrawElements` takes, each with an id the agent picked
 * so a later change can edit one element without resending the rest. The app
 * draws them as they are (`src/lib/artifactDiagram.ts`).
 *
 * Only the properties below are kept. Everything else is dropped, so a stored
 * diagram can't carry a link, an image or custom data into the app.
 *
 * An arrow bound to a shape at both ends gets its position from those shapes
 * on every write, so moving a shape moves its arrows.
 */

/** Past this a diagram is too big to read on screen, and too big to describe back to the model. */
export const MAX_DIAGRAM_ELEMENTS = 600;

export const SHAPE_TYPES = ["rectangle", "ellipse", "diamond"] as const;
export const ELEMENT_TYPES = [...SHAPE_TYPES, "text", "arrow", "line", "frame"] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];

/** Plain ids, so one can't break out of the element ids Excalidraw builds from it. */
const elementId = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,64}$/, "ids are 1-64 letters, digits, or _ . : -");
const coordinate = z.number().finite().min(-100_000).max(100_000);
const size = z.number().finite().min(1).max(5_000);
const color = z
  .string()
  .regex(
    /^(transparent|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$/,
    'a colour is a hex code like "#1971c2", or "transparent"',
  );
const text = z.string().max(500);
const fontSize = z.number().finite().min(8).max(200);
const textAlign = z.enum(["left", "center", "right"]);
const verticalAlign = z.enum(["top", "middle", "bottom"]);
const arrowhead = z.enum(["arrow", "bar", "dot", "circle", "triangle", "diamond"]).nullable();
/** 3 rounds a shape's corners, 2 curves a line through its points; null keeps them sharp. */
const roundness = z.object({ type: z.number().int().min(1).max(3) }).nullable();
/** Relative to x and y. The first point is usually [0, 0]. */
const points = z
  .array(z.tuple([coordinate, coordinate]))
  .min(2)
  .max(100);
const binding = z.object({ id: elementId });

const label = z.object({
  text,
  fontSize: fontSize.optional(),
  textAlign: textAlign.optional(),
  verticalAlign: verticalAlign.optional(),
  strokeColor: color.optional(),
});

const style = {
  strokeColor: color.optional(),
  backgroundColor: color.optional(),
  fillStyle: z.enum(["hachure", "cross-hatch", "solid", "zigzag"]).optional(),
  strokeWidth: z.number().finite().min(0.5).max(16).optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  roughness: z.number().finite().min(0).max(2).optional(),
  opacity: z.number().finite().min(0).max(100).optional(),
  /** Radians, clockwise. */
  angle: z.number().finite().min(-7).max(7).optional(),
  groupIds: z.array(elementId).max(8).optional(),
};

const shapeSchema = z.object({
  id: elementId,
  type: z.enum(SHAPE_TYPES),
  x: coordinate,
  y: coordinate,
  width: size,
  height: size,
  roundness: roundness.optional(),
  label: label.optional(),
  ...style,
});

const textSchema = z.object({
  id: elementId,
  type: z.literal("text"),
  x: coordinate,
  y: coordinate,
  text,
  fontSize: fontSize.optional(),
  textAlign: textAlign.optional(),
  verticalAlign: verticalAlign.optional(),
  ...style,
});

const arrowSchema = z.object({
  id: elementId,
  type: z.literal("arrow"),
  x: coordinate.optional(),
  y: coordinate.optional(),
  points: points.optional(),
  start: binding.optional(),
  end: binding.optional(),
  startArrowhead: arrowhead.optional(),
  endArrowhead: arrowhead.optional(),
  label: label.optional(),
  roundness: roundness.optional(),
  ...style,
});

/** Excalidraw binds, labels and puts heads on arrows only, so a line is just a path. */
const lineSchema = z.object({
  id: elementId,
  type: z.literal("line"),
  x: coordinate,
  y: coordinate,
  points,
  roundness: roundness.optional(),
  ...style,
});

/** Excalidraw gives a frame no style of its own. */
const frameSchema = z.object({
  id: elementId,
  type: z.literal("frame"),
  name: z.string().max(100).optional(),
  children: z.array(elementId).max(MAX_DIAGRAM_ELEMENTS),
  x: coordinate.optional(),
  y: coordinate.optional(),
  width: size.optional(),
  height: size.optional(),
});

export const diagramElementSchema = z.discriminatedUnion("type", [
  shapeSchema,
  textSchema,
  arrowSchema,
  lineSchema,
  frameSchema,
]);

export const diagramSchema = z.object({
  elements: z.array(diagramElementSchema).max(MAX_DIAGRAM_ELEMENTS),
});

export type DiagramElement = z.infer<typeof diagramElementSchema>;
export type ShapeElement = z.infer<typeof shapeSchema>;
export type ArrowElement = z.infer<typeof arrowSchema>;
export type Diagram = z.infer<typeof diagramSchema>;

/*
 * An upsert names an element by id and sends only the properties it changes.
 * Every property an element can have is listed here, so the tool's schema
 * shows the model what it can set.
 */
const patchable = {
  x: coordinate,
  y: coordinate,
  width: size,
  height: size,
  points,
  start: binding,
  end: binding,
  startArrowhead: arrowhead,
  endArrowhead: arrowhead,
  label,
  text,
  fontSize,
  textAlign,
  verticalAlign,
  roundness,
  name: frameSchema.shape.name.unwrap(),
  children: frameSchema.shape.children,
  strokeColor: color,
  backgroundColor: color,
  fillStyle: style.fillStyle.unwrap(),
  strokeWidth: style.strokeWidth.unwrap(),
  strokeStyle: style.strokeStyle.unwrap(),
  roughness: style.roughness.unwrap(),
  opacity: style.opacity.unwrap(),
  angle: style.angle.unwrap(),
  groupIds: style.groupIds.unwrap(),
};

export const elementPatchSchema = z.object({
  id: elementId,
  type: z.enum(ELEMENT_TYPES).optional(),
  ...(Object.fromEntries(
    Object.entries(patchable).map(([key, schema]) => [key, schema.nullable().optional()]),
  ) as { [K in keyof typeof patchable]: z.ZodOptional<z.ZodNullable<(typeof patchable)[K]>> }),
});

/**
 * Where null is a value of its own (no arrowhead, sharp corners) rather than
 * "not set". Everywhere else a null clears the property, or on a new element
 * leaves it unset, since some models fill every property they don't use with one.
 */
const NULL_IS_A_VALUE = new Set(["startArrowhead", "endArrowhead", "roundness"]);

/** A change to a diagram: removals first, then upserts in order. */
export const diagramChangesSchema = z.object({
  upsert: z.array(elementPatchSchema).max(MAX_DIAGRAM_ELEMENTS).optional(),
  /** Removing a shape also removes the arrows bound to it. */
  remove: z.array(elementId).max(MAX_DIAGRAM_ELEMENTS).optional(),
});

export type DiagramChanges = z.infer<typeof diagramChangesSchema>;

export class DiagramError extends Error {}

/**
 * True when the changes only add elements, never touching one already there.
 * A new frame that holds an existing element counts as touching it, since the
 * frame clips what it holds.
 */
export function onlyAdds(diagram: Diagram, changes: DiagramChanges): boolean {
  if (changes.remove?.length) return false;
  const ids = new Set(diagram.elements.map((e) => e.id));
  return !(changes.upsert ?? []).some(
    (e) => ids.has(e.id) || (e.children ?? []).some((child) => ids.has(child)),
  );
}

/** Reads stored content back. An empty string is an empty diagram, so a fresh row needs no seeding. */
export function parseDiagram(content: string): Diagram {
  if (content.trim() === "") return { elements: [] };
  return diagramSchema.parse(JSON.parse(content));
}

/** Zod's first issue, with its path, worded for the model to fix. */
function describeIssue(err: z.ZodError, id: string): string {
  const issue = err.issues[0];
  const path = issue?.path.join(".");
  return `element "${id}": ${path ? `${path}: ` : ""}${issue?.message ?? "invalid"}`;
}

const withoutUnsetNulls = (element: unknown) =>
  element && typeof element === "object"
    ? Object.fromEntries(
        Object.entries(element).filter(([k, v]) => v !== null || NULL_IS_A_VALUE.has(k)),
      )
    : element;

/** Parses elements a tool call sent, naming the first bad one. */
export function parseElements(elements: unknown[]): DiagramElement[] {
  return elements.map((element) => {
    const parsed = diagramElementSchema.safeParse(withoutUnsetNulls(element));
    if (parsed.success) return parsed.data;
    const id = (element as { id?: unknown } | null)?.id;
    throw new DiagramError(describeIssue(parsed.error, typeof id === "string" ? id : "?"));
  });
}

const isShape = (e: DiagramElement | undefined): e is ShapeElement =>
  e !== undefined && (SHAPE_TYPES as readonly string[]).includes(e.type);

/**
 * Checks what a whole diagram must satisfy beyond its schema, and places the
 * arrows bound at both ends. Throws DiagramError naming the first problem,
 * worded for the model to fix.
 */
export function checkDiagram(diagram: Diagram): Diagram {
  if (diagram.elements.length > MAX_DIAGRAM_ELEMENTS) {
    throw new DiagramError(`a diagram can have at most ${MAX_DIAGRAM_ELEMENTS} elements`);
  }
  const byId = new Map<string, DiagramElement>();
  for (const element of diagram.elements) {
    if (byId.has(element.id)) throw new DiagramError(`two elements have the id "${element.id}"`);
    byId.set(element.id, element);
  }
  const framed = new Set<string>();
  const elements = diagram.elements.map((element) => {
    if (element.type === "frame") {
      for (const child of element.children) {
        const target = byId.get(child);
        if (!target || target.type === "frame") {
          throw new DiagramError(
            `frame "${element.id}" lists "${child}", which is not an element it can hold`,
          );
        }
        if (framed.has(child)) throw new DiagramError(`"${child}" is in two frames`);
        framed.add(child);
      }
      return element;
    }
    if (element.type !== "arrow") return element;
    for (const end of [element.start, element.end]) {
      if (end && !isShape(byId.get(end.id))) {
        throw new DiagramError(
          `arrow "${element.id}" is bound to "${end.id}", which is not a rectangle, ellipse or diamond`,
        );
      }
    }
    if (element.start && element.start.id === element.end?.id) {
      throw new DiagramError(`arrow "${element.id}" starts and ends on the same shape`);
    }
    const from = element.start && (byId.get(element.start.id) as ShapeElement);
    const to = element.end && (byId.get(element.end.id) as ShapeElement);
    if (from && to) return connect(element, from, to);
    if (element.x === undefined || element.y === undefined || !element.points) {
      throw new DiagramError(
        `arrow "${element.id}" needs start and end shapes, or x, y and points`,
      );
    }
    return element;
  });
  return { elements };
}

/**
 * Applies removals, then upserts in order. An upsert merges into the element
 * with its id, a null clears a property (see `NULL_IS_A_VALUE`), and the
 * result must be a whole element of its type, so a new one needs everything
 * its type requires.
 */
export function applyDiagramChanges(diagram: Diagram, changes: DiagramChanges): Diagram {
  const removed = new Set(changes.remove ?? []);
  const elements = new Map<string, Record<string, unknown>>();
  for (const element of diagram.elements) {
    if (removed.has(element.id)) continue;
    const bound = element.type === "arrow" ? [element.start?.id, element.end?.id] : [];
    if (bound.some((id) => id !== undefined && removed.has(id))) continue;
    if (element.type === "frame") {
      elements.set(element.id, {
        ...element,
        children: element.children.filter((c) => !removed.has(c)),
      });
      continue;
    }
    elements.set(element.id, element);
  }

  for (const patch of changes.upsert ?? []) {
    const current = elements.get(patch.id);
    if (current && patch.type && patch.type !== current.type) {
      throw new DiagramError(
        `"${patch.id}" is a ${current.type}; remove it and add it again to make it a ${patch.type}`,
      );
    }
    if (!current && !patch.type) {
      throw new DiagramError(`new element "${patch.id}" needs a type`);
    }
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null && !NULL_IS_A_VALUE.has(key)) delete merged[key];
      else if (value !== undefined) merged[key] = value;
    }
    elements.set(patch.id, merged);
  }
  return checkDiagram({ elements: parseElements([...elements.values()]) });
}

export function serializeDiagram(diagram: Diagram): string {
  return JSON.stringify(diagram);
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const center = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** Where the line from a shape's centre toward `toward` leaves its outline. */
export function outlinePoint(
  shape: Box & { type: ShapeType },
  toward: { x: number; y: number },
): { x: number; y: number } {
  const c = center(shape);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const a = shape.width / 2;
  const b = shape.height / 2;
  const scale =
    shape.type === "ellipse"
      ? 1 / Math.sqrt((dx / a) ** 2 + (dy / b) ** 2)
      : shape.type === "diamond"
        ? 1 / (Math.abs(dx) / a + Math.abs(dy) / b)
        : Math.min(
            dx === 0 ? Number.POSITIVE_INFINITY : a / Math.abs(dx),
            dy === 0 ? Number.POSITIVE_INFINITY : b / Math.abs(dy),
          );
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/** A straight line from one shape's outline to the other's, at the height each is drawn. */
function connect(element: ArrowElement, from: ShapeElement, to: ShapeElement): ArrowElement {
  const a = { ...from, height: shapeHeight(from) };
  const b = { ...to, height: shapeHeight(to) };
  const start = outlinePoint(a, center(b));
  const end = outlinePoint(b, center(a));
  return {
    ...element,
    x: round(start.x),
    y: round(start.y),
    points: [
      [0, 0],
      [round(end.x - start.x), round(end.y - start.y)],
    ],
  };
}

const round = (n: number) => Math.round(n * 10) / 10;
