import type * as Monaco from "monaco-editor";
import type { MonacoApi } from "./loader";
import type { DiffSide, LineAction, LineActionKind } from "./types";

/** The lines a selection covers, not counting a last line it only touches at column 1. */
export function selectionLines(selection: {
  startLineNumber: number;
  endLineNumber: number;
  endColumn: number;
}): { startLine: number; endLine: number } {
  const endLine =
    selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
      ? selection.endLineNumber - 1
      : selection.endLineNumber;
  return { startLine: selection.startLineNumber, endLine };
}

const ACTION_LABELS: Record<LineActionKind, string> = { comment: "Comment", ask: "Ask" };

/**
 * Adds the comment and ask affordances to one editor: a pair of buttons in the
 * glyph margin of the line under the pointer, and a small bar beside any
 * selection. A click on a line's button acts on the selection when the line is
 * inside it, so dragging out a range and then clicking either way does the same.
 *
 * `getHandler` is read at click time, so the host can pass a fresh callback on
 * every render without the listeners being rebuilt.
 */
export function attachLineActions(
  monaco: MonacoApi,
  editor: Monaco.editor.ICodeEditor,
  side: DiffSide,
  getHandler: () => ((action: LineAction) => void) | undefined,
): Monaco.IDisposable {
  const { GlyphMarginLane, MouseTargetType } = monaco.editor;
  const disposables: Monaco.IDisposable[] = [];

  // Two lanes are reserved for good: Monaco widens the margin to fit the
  // most glyphs any line has, so without these the code would shift sideways
  // each time the pointer reached a line.
  const lanes = editor.createDecorationsCollection();
  const reserveLanes = () => {
    if (!editor.getModel()) return;
    lanes.set(
      [GlyphMarginLane.Left, GlyphMarginLane.Right].map((position) => ({
        range: new monaco.Range(1, 1, 1, 1),
        options: {
          glyphMarginClassName: "review-glyph-lane",
          glyphMargin: { position, persistLane: true },
        },
      })),
    );
  };
  reserveLanes();
  disposables.push(editor.onDidChangeModel(reserveLanes));

  const hover = editor.createDecorationsCollection();
  let hoveredLine = 0;
  const showButtons = (line: number) => {
    if (line === hoveredLine) return;
    hoveredLine = line;
    if (line === 0) {
      hover.clear();
      return;
    }
    hover.set([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: "review-glyph review-glyph-comment",
          glyphMarginHoverMessage: { value: "Comment on this line" },
          glyphMargin: { position: GlyphMarginLane.Left },
        },
      },
      {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: "review-glyph review-glyph-ask",
          glyphMarginHoverMessage: { value: "Ask about this line" },
          glyphMargin: { position: GlyphMarginLane.Right },
        },
      },
    ]);
  };

  const emit = (kind: LineActionKind, startLine: number, endLine: number) => {
    getHandler()?.({ kind, side, startLine, endLine });
  };

  disposables.push(
    editor.onMouseMove((e) => {
      showButtons(e.target.position?.lineNumber ?? 0);
    }),
    editor.onMouseLeave(() => showButtons(0)),
    editor.onMouseDown((e) => {
      if (e.target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      if (!line) return;
      const kind = e.target.detail.glyphMarginLane === GlyphMarginLane.Right ? "ask" : "comment";
      const selection = editor.getSelection();
      const covered = selection && !selection.isEmpty() ? selectionLines(selection) : null;
      if (covered && line >= covered.startLine && line <= covered.endLine) {
        emit(kind, covered.startLine, covered.endLine);
      } else {
        emit(kind, line, line);
      }
      e.event.preventDefault();
    }),
  );

  // The bar beside a selection.
  const bar = document.createElement("div");
  bar.className = "review-selection-actions";
  for (const kind of ["comment", "ask"] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = ACTION_LABELS[kind];
    // Keeps the editor's selection, which a mousedown on the button would clear.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const selection = editor.getSelection();
      if (!selection || selection.isEmpty()) return;
      const { startLine, endLine } = selectionLines(selection);
      emit(kind, startLine, endLine);
    });
    bar.appendChild(button);
  }
  let barLine = 0;
  const widget: Monaco.editor.IContentWidget = {
    getId: () => `review.selectionActions.${side}`,
    getDomNode: () => bar,
    getPosition: () =>
      barLine === 0
        ? null
        : {
            position: { lineNumber: barLine, column: 1 },
            preference: [
              monaco.editor.ContentWidgetPositionPreference.ABOVE,
              monaco.editor.ContentWidgetPositionPreference.BELOW,
            ],
          },
  };
  editor.addContentWidget(widget);
  disposables.push(
    editor.onDidChangeCursorSelection((e) => {
      barLine = e.selection.isEmpty() ? 0 : e.selection.startLineNumber;
      editor.layoutContentWidget(widget);
    }),
  );

  return {
    dispose() {
      for (const d of disposables) d.dispose();
      editor.removeContentWidget(widget);
      hover.clear();
      lanes.clear();
    },
  };
}
