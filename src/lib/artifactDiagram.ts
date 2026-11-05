/**
 * Reads a diagram artifact into Excalidraw element skeletons for
 * `convertToExcalidrawElements`.
 *
 * The agent writes the skeletons itself and the sidecar validates them
 * (`sidecar/src/artifacts/diagram.ts`), placing arrows bound at both ends.
 * This file keeps only the same properties again, since the content is still
 * model-written. Plain data here so it can be tested without loading
 * Excalidraw, which needs a canvas and is only fetched when a diagram is opened.
 */

import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { LABEL_FONT_FAMILY } from "./pr/flowDiagram";

type Obj = Record<string, unknown>;

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const COLOR = /^(transparent|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$/;
const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);
const FILL_STYLES = new Set(["hachure", "cross-hatch", "solid", "zigzag"]);
const STROKE_STYLES = new Set(["solid", "dashed", "dotted"]);
const TEXT_ALIGNS = new Set(["left", "center", "right"]);
const VERTICAL_ALIGNS = new Set(["top", "middle", "bottom"]);
const ARROWHEADS = new Set(["arrow", "bar", "dot", "circle", "triangle", "diamond"]);

/** The sidecar's caps, applied again here. */
const MAX_TEXT = 500;
const MAX_POINTS = 100;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
const coord = (v: unknown) => num(v, -100_000, 100_000);
const oneOf = (v: unknown, set: Set<string>): string | undefined =>
  typeof v === "string" && set.has(v) ? v : undefined;
const color = (v: unknown): string | undefined =>
  typeof v === "string" && COLOR.test(v) ? v : undefined;
const cleanText = (v: unknown): string | undefined =>
  // Newlines stay, since a label may want two lines. Other control characters
  // and line or paragraph separators go, and so do format characters like a
  // right-to-left override, which can make a label read differently from what
  // it says.
  typeof v === "string"
    ? v.replace(/(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").slice(0, MAX_TEXT)
    : undefined;

/** Drops the keys whose value didn't survive cleaning, so Excalidraw applies its own default. */
const defined = (o: Obj): Obj =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function style(e: Obj): Obj {
  return defined({
    strokeColor: color(e.strokeColor),
    backgroundColor: color(e.backgroundColor),
    fillStyle: oneOf(e.fillStyle, FILL_STYLES),
    strokeWidth: num(e.strokeWidth, 0.5, 16),
    strokeStyle: oneOf(e.strokeStyle, STROKE_STYLES),
    roughness: num(e.roughness, 0, 2),
    opacity: num(e.opacity, 0, 100),
    angle: num(e.angle, -7, 7),
    groupIds: Array.isArray(e.groupIds)
      ? e.groupIds.filter((g): g is string => typeof g === "string" && ID.test(g)).slice(0, 8)
      : undefined,
  });
}

/** Text settings shared by a text element and a label. The font is always Helvetica: see `LABEL_FONT_FAMILY`. */
function textStyle(e: Obj): Obj {
  return defined({
    fontSize: num(e.fontSize, 8, 200),
    fontFamily: LABEL_FONT_FAMILY,
    textAlign: oneOf(e.textAlign, TEXT_ALIGNS),
    verticalAlign: oneOf(e.verticalAlign, VERTICAL_ALIGNS),
  });
}

function label(v: unknown): Obj | undefined {
  if (!isObj(v)) return undefined;
  const text = cleanText(v.text);
  if (!text) return undefined;
  return { text, ...textStyle(v), ...defined({ strokeColor: color(v.strokeColor) }) };
}

function points(v: unknown): [number, number][] | undefined {
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_POINTS) return undefined;
  const out: [number, number][] = [];
  for (const p of v) {
    const x = Array.isArray(p) ? coord(p[0]) : undefined;
    const y = Array.isArray(p) ? coord(p[1]) : undefined;
    if (x === undefined || y === undefined) return undefined;
    out.push([x, y]);
  }
  return out;
}

/**
 * Reads an artifact's stored content into skeletons. The sidecar validated it
 * on write, but anything malformed is dropped here rather than handed to
 * Excalidraw.
 */
export function diagramToSkeleton(content: string): ExcalidrawElementSkeleton[] {
  if (content.trim() === "") return [];
  const raw = JSON.parse(content) as { elements?: unknown };
  const all = (Array.isArray(raw.elements) ? raw.elements : []).filter(
    (e): e is Obj => isObj(e) && typeof e.id === "string" && ID.test(e.id),
  );
  const shapeIds = new Set(all.filter((e) => SHAPES.has(e.type as string)).map((e) => e.id));
  const framable = new Set(all.filter((e) => e.type !== "frame").map((e) => e.id));
  const bind = (v: unknown) =>
    isObj(v) && typeof v.id === "string" && shapeIds.has(v.id) ? { id: v.id } : undefined;

  const out: Obj[] = [];
  for (const e of all) {
    const x = coord(e.x);
    const y = coord(e.y);
    if (SHAPES.has(e.type as string)) {
      const width = num(e.width, 1, 5_000);
      const height = num(e.height, 1, 5_000);
      if (x === undefined || y === undefined || width === undefined || height === undefined) {
        continue;
      }
      const roundness =
        e.roundness === null
          ? null
          : isObj(e.roundness) && num(e.roundness.type, 1, 3) !== undefined
            ? { type: e.roundness.type }
            : undefined;
      out.push(
        defined({
          type: e.type,
          id: e.id,
          x,
          y,
          width,
          height,
          roundness,
          label: label(e.label),
          ...style(e),
        }),
      );
    } else if (e.type === "text") {
      const text = cleanText(e.text);
      if (x === undefined || y === undefined || !text) continue;
      out.push({ type: "text", id: e.id, x, y, text, ...textStyle(e), ...style(e) });
    } else if (e.type === "arrow" || e.type === "line") {
      const pts = points(e.points);
      if (x === undefined || y === undefined || !pts) continue;
      const xs = pts.map(([px]) => px);
      const ys = pts.map(([, py]) => py);
      out.push(
        defined({
          type: e.type,
          id: e.id,
          x,
          y,
          points: pts,
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
          start: bind(e.start),
          end: bind(e.end),
          startArrowhead: e.startArrowhead === null ? null : oneOf(e.startArrowhead, ARROWHEADS),
          endArrowhead: e.endArrowhead === null ? null : oneOf(e.endArrowhead, ARROWHEADS),
          label: label(e.label),
          ...style(e),
        }),
      );
    } else if (e.type === "frame") {
      const children = Array.isArray(e.children)
        ? e.children.filter((c): c is string => typeof c === "string" && framable.has(c))
        : [];
      out.push(
        defined({
          type: "frame",
          id: e.id,
          children,
          name: cleanText(e.name)?.slice(0, 100),
          x,
          y,
          width: num(e.width, 1, 5_000),
          height: num(e.height, 1, 5_000),
        }),
      );
    }
  }
  return out as unknown as ExcalidrawElementSkeleton[];
}
