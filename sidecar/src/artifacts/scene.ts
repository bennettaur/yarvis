import {
  type Box,
  type Diagram,
  type DiagramElement,
  SHAPE_TYPES,
  type ShapeElement,
} from "./diagram.ts";
import { DEFAULT_FONT_SIZE, shapeHeight, textBox } from "./textMetrics.ts";

/**
 * What the agent sees of a diagram after each change: where every element
 * ended up and what looks wrong, so it can fix its own layout rather than
 * draw blind.
 *
 * Text sizes are estimates (`textMetrics.ts`), and Excalidraw grows a shape
 * to fit a label that doesn't.
 */

/** Past this many, the rest are counted rather than listed. */
const MAX_PROBLEMS = 25;

interface Placed extends Box {
  element: DiagramElement;
}

type PathElement = Extract<DiagramElement, { type: "arrow" | "line" }>;

function linearBox(element: PathElement): Box | null {
  if (element.x === undefined || element.y === undefined || !element.points) return null;
  const xs = element.points.map(([px]) => element.x! + px);
  const ys = element.points.map(([, py]) => element.y! + py);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Each element's box, with frames sized to their children when they have no size of their own. */
function place(diagram: Diagram): Map<string, Placed> {
  const placed = new Map<string, Placed>();
  for (const element of diagram.elements) {
    if ((SHAPE_TYPES as readonly string[]).includes(element.type)) {
      const shape = element as ShapeElement;
      placed.set(shape.id, { element, ...shape, height: shapeHeight(shape) });
    } else if (element.type === "text") {
      const size = textBox(element.text, element.fontSize ?? DEFAULT_FONT_SIZE);
      placed.set(element.id, { element, x: element.x, y: element.y, ...size });
    } else if (element.type === "arrow" || element.type === "line") {
      const box = linearBox(element);
      if (box) placed.set(element.id, { element, ...box });
    }
  }
  for (const element of diagram.elements) {
    if (element.type !== "frame") continue;
    // Excalidraw also puts the arrows bound to a frame's children in the frame.
    const held = new Set(element.children);
    for (const e of diagram.elements) {
      if (e.type === "arrow" && (held.has(e.start?.id ?? "") || held.has(e.end?.id ?? ""))) {
        held.add(e.id);
      }
    }
    const boxes = [...held].flatMap((c) => placed.get(c) ?? []);
    // Each of x, y, width and height is fitted to the children, padded by 10px,
    // unless the frame sets it; like Excalidraw, a 0 counts as unset.
    const fitX = boxes.length ? Math.min(...boxes.map((b) => b.x)) - 10 : 0;
    const fitY = boxes.length ? Math.min(...boxes.map((b) => b.y)) - 10 : 0;
    const right = boxes.length ? Math.max(...boxes.map((b) => b.x + b.width)) + 10 : 0;
    const bottom = boxes.length ? Math.max(...boxes.map((b) => b.y + b.height)) + 10 : 0;
    if (!boxes.length && !(element.width && element.height)) continue;
    placed.set(element.id, {
      element,
      x: element.x || fitX,
      y: element.y || fitY,
      width: element.width || right - fitX,
      height: element.height || bottom - fitY,
    });
  }
  return placed;
}

const n = (v: number) => Math.round(v);
const quote = (s: string) => JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}...` : s);

function describe(element: DiagramElement, box: Placed | undefined): string {
  const at = box ? ` at (${n(box.x)}, ${n(box.y)}) ${n(box.width)}x${n(box.height)}` : "";
  switch (element.type) {
    case "text":
      return `${element.id}: text${at} ${quote(element.text)}`;
    case "arrow":
    case "line": {
      const arrow = element.type === "arrow" ? element : undefined;
      const ends =
        arrow?.start && arrow.end
          ? ` ${arrow.start.id} -> ${arrow.end.id}`
          : arrow?.start
            ? ` from ${arrow.start.id}`
            : arrow?.end
              ? ` to ${arrow.end.id}`
              : "";
      const label = arrow?.label?.text ? ` label ${quote(arrow.label.text)}` : "";
      return `${element.id}: ${element.type}${ends}${at}${label}`;
    }
    case "frame":
      return `${element.id}: frame${element.name ? ` ${quote(element.name)}` : ""}${at} holding ${element.children.join(", ") || "nothing"}`;
    default: {
      const label = element.label?.text ? ` label ${quote(element.label.text)}` : "";
      const grown =
        box && box.height > element.height
          ? ` (grown from ${n(element.height)} to fit its label)`
          : "";
      return `${element.id}: ${element.type}${at}${label}${grown}`;
    }
  }
}

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/** Whether the segment from `p` to `q` passes through the box (Liang-Barsky clipping). */
function segmentHits(p: [number, number], q: [number, number], box: Box): boolean {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  let t0 = 0;
  let t1 = 1;
  const checks: [number, number][] = [
    [-dx, p[0] - box.x],
    [dx, box.x + box.width - p[0]],
    [-dy, p[1] - box.y],
    [dy, box.y + box.height - p[1]],
  ];
  for (const [pk, qk] of checks) {
    if (pk === 0) {
      if (qk < 0) return false;
      continue;
    }
    const t = qk / pk;
    if (pk < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/** Shrinks a box by `by` on every side, so an arrow ending on an outline doesn't count as crossing it. */
const inset = (box: Box, by: number): Box => ({
  x: box.x + by,
  y: box.y + by,
  width: Math.max(0, box.width - by * 2),
  height: Math.max(0, box.height - by * 2),
});

function findProblems(diagram: Diagram, placed: Map<string, Placed>): string[] {
  const problems: string[] = [];
  let found = 0;
  // Counts past the cap without building the strings, since 600 stacked boxes make 180k pairs.
  const report = (problem: () => string) => {
    found += 1;
    if (found <= MAX_PROBLEMS) problems.push(problem());
  };
  const solid = [...placed.values()].filter(
    (p) => p.element.type !== "frame" && p.element.type !== "arrow" && p.element.type !== "line",
  );

  for (const p of solid) {
    if (p.element.type !== "text" && p.height > (p.element as ShapeElement).height) {
      report(
        () =>
          `${p.element.id}'s label doesn't fit, so it grows to about ${n(p.height)} tall: widen it or shorten the label`,
      );
    }
  }
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i]!;
      const b = solid[j]!;
      if (intersects(a, b) && !contains(a, b) && !contains(b, a)) {
        report(() => `${a.element.id} and ${b.element.id} overlap`);
      }
    }
  }
  for (const element of diagram.elements) {
    if (element.type !== "arrow" && element.type !== "line") continue;
    if (!element.points || element.x === undefined || element.y === undefined) continue;
    const ends =
      element.type === "arrow" ? new Set([element.start?.id, element.end?.id]) : new Set();
    const points = element.points.map(
      ([px, py]) => [element.x! + px, element.y! + py] as [number, number],
    );
    for (const p of solid) {
      if (ends.has(p.element.id)) continue;
      const body = inset(p, 2);
      // An arrow that starts or ends inside a shape is attached to it, not crossing it.
      if (points.some(([px, py]) => contains(body, { x: px, y: py, width: 0, height: 0 })))
        continue;
      if (points.slice(1).some((q, k) => segmentHits(points[k]!, q, body))) {
        report(() => `${element.type} ${element.id} crosses ${p.element.id}`);
      }
    }
  }
  if (found > MAX_PROBLEMS) problems.push(`...and ${found - MAX_PROBLEMS} more`);
  return problems;
}

export interface DiagramScene {
  /** The box around everything drawn. */
  bounds: string;
  /** One line per element, in drawing order: later ones are drawn on top. */
  elements: string[];
  /** What looks wrong: overlaps, labels that don't fit, arrows through shapes. Names ids only. */
  problems: string[];
}

export function describeScene(diagram: Diagram): DiagramScene {
  const placed = place(diagram);
  const boxes = [...placed.values()];
  const bounds =
    boxes.length === 0
      ? "empty"
      : (() => {
          const x = Math.min(...boxes.map((b) => b.x));
          const y = Math.min(...boxes.map((b) => b.y));
          const right = Math.max(...boxes.map((b) => b.x + b.width));
          const bottom = Math.max(...boxes.map((b) => b.y + b.height));
          return `(${n(x)}, ${n(y)}) to (${n(right)}, ${n(bottom)})`;
        })();
  return {
    bounds,
    elements: diagram.elements.map((e) => describe(e, placed.get(e.id))),
    problems: findProblems(diagram, placed),
  };
}
