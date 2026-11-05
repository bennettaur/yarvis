import type { ShapeElement } from "./diagram.ts";

/**
 * Estimates of how big Excalidraw draws text, so the sidecar can aim arrows
 * at a shape grown to fit its label and tell the agent what doesn't fit. The
 * app measures with the real font when it draws, so these are approximate.
 */

/** Excalidraw's default size, Helvetica's line height, and the gap inside a shape. */
export const DEFAULT_FONT_SIZE = 20;
const LINE_HEIGHT = 1.15;
const LABEL_PADDING = 5;
/** Helvetica averages about half its size per character. */
const CHAR_WIDTH = 0.5;
/** How much of a shape's width and height a label can use: Excalidraw fits it inside the outline. */
const LABEL_SHARE: Record<ShapeElement["type"], number> = {
  rectangle: 1,
  ellipse: 0.7,
  diamond: 0.5,
};

/** Lines after wrapping at word boundaries to `width`, as Excalidraw does, or as written with no width. */
function textLines(text: string, fontSize: number, width?: number): number {
  const perLine = width ? Math.max(1, Math.floor(width / (fontSize * CHAR_WIDTH))) : Infinity;
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    let used = 0;
    lines += 1;
    for (const word of paragraph.split(" ")) {
      const needed = used === 0 ? word.length : used + 1 + word.length;
      if (needed <= perLine) {
        used = needed;
        continue;
      }
      // A word longer than a line is broken across as many lines as it needs.
      const extra =
        used === 0 ? Math.ceil(word.length / perLine) - 1 : Math.ceil(word.length / perLine);
      lines += extra;
      used = word.length % perLine || perLine;
    }
  }
  return lines;
}

/** A free text element's size: it isn't wrapped, so its width is its longest line. */
export function textBox(text: string, fontSize: number): { width: number; height: number } {
  const longest = Math.max(...text.split("\n").map((l) => l.length));
  return {
    width: Math.ceil(longest * fontSize * CHAR_WIDTH),
    height: Math.ceil(textLines(text, fontSize) * fontSize * LINE_HEIGHT),
  };
}

/** The height a shape ends up, once Excalidraw has grown it downward to fit its label. */
export function shapeHeight(shape: ShapeElement): number {
  if (!shape.label?.text) return shape.height;
  const fontSize = shape.label.fontSize ?? DEFAULT_FONT_SIZE;
  const room = shape.width * LABEL_SHARE[shape.type] - LABEL_PADDING * 2;
  const needed =
    textLines(shape.label.text, fontSize, room) * fontSize * LINE_HEIGHT + LABEL_PADDING * 2;
  return Math.max(shape.height, Math.ceil(needed / LABEL_SHARE[shape.type]));
}
