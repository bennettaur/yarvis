import type * as Monaco from "monaco-editor";
import { useEffect, useMemo, useRef, useState } from "react";
import { monacoLanguageForPath } from "./language";
import { attachLineActions } from "./lineActions";
import { type MonacoApi, useMonaco } from "./loader";
import { acquireModel, ModelHold, syncModel } from "./models";
import { type OpenLocationHandler, setOpenLocationHandler } from "./navigation";
import type { DiffSide, EditorZone, LineAction, LineDecoration } from "./types";
import { type PlacedZone, useZonePortals } from "./useZonePortals";

/** What every review editor shares: read-only, with room in the margin for the line buttons. */
export const BASE_EDITOR_OPTIONS: Monaco.editor.IEditorOptions = {
  readOnly: true,
  domReadOnly: true,
  automaticLayout: true,
  glyphMargin: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  lineNumbersMinChars: 4,
  renderLineHighlight: "none",
  // The editor sits in a tab of its own, so it scrolls itself rather than
  // passing the wheel to the page when it reaches an end.
  scrollbar: { alwaysConsumeMouseWheel: true },
};

/** Shown in the editor's place while Monaco loads or if it failed to. */
export function EditorPlaceholder({ error }: { error?: unknown }) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-zinc-500">
      {error ? `Couldn't load the editor: ${String(error)}` : "Loading editor…"}
    </div>
  );
}

export interface MonacoFileViewProps {
  /** A `review://` URI from `reviewUri`; the model's identity. */
  uri: string;
  /** Picks the language when `language` is not given. */
  path: string;
  content: string;
  /** A Monaco language id, overriding the one read from `path`. */
  language?: string;
  /** Scrolled to and centred whenever it changes. */
  revealLine?: number;
  /** Changed to reveal `revealLine` again when it hasn't changed itself. */
  revealKey?: number;
  decorations?: LineDecoration[];
  /** Every zone is shown; `side` only matters in a diff. */
  zones?: EditorZone[];
  onLineAction?: (action: LineAction) => void;
  /** A go-to-definition that lands in another file. */
  onOpenLocation?: OpenLocationHandler;
  /** Which side line actions report. A file on its own is the head's. */
  side?: DiffSide;
}

/** One file, read-only, in Monaco. Size it with its parent: it fills it. */
export function MonacoFileView(props: MonacoFileViewProps) {
  const state = useMonaco();
  if (state.status !== "ready") {
    return <EditorPlaceholder error={state.status === "error" ? state.error : undefined} />;
  }
  return <FileEditor monaco={state.monaco} {...props} />;
}

function FileEditor({
  monaco,
  uri,
  path,
  content,
  language,
  revealLine,
  revealKey,
  decorations,
  zones,
  onLineAction,
  onOpenLocation,
  side = "RIGHT",
}: MonacoFileViewProps & { monaco: MonacoApi }) {
  const container = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [lineDecorations, setLineDecorations] =
    useState<Monaco.editor.IEditorDecorationsCollection | null>(null);
  // The model on screen and the URI it was made for, so content is only ever
  // written into the model it belongs to.
  const [held, setHeld] = useState<{ uri: string; model: Monaco.editor.ITextModel } | null>(null);
  const hold = useRef<ModelHold | null>(null);
  const latest = useRef({ onLineAction, onOpenLocation, side });
  latest.current = { onLineAction, onOpenLocation, side };
  const languageId = language ?? monacoLanguageForPath(path);

  useEffect(() => {
    if (!container.current) return;
    const made = monaco.editor.create(container.current, { ...BASE_EDITOR_OPTIONS, model: null });
    setOpenLocationHandler(made, () => latest.current.onOpenLocation);
    const actions = attachLineActions(
      monaco,
      made,
      () => latest.current.side,
      () => latest.current.onLineAction,
    );
    setLineDecorations(made.createDecorationsCollection());
    setEditor(made);
    return () => {
      actions.dispose();
      made.setModel(null);
      hold.current?.release();
      hold.current = null;
      made.dispose();
      setEditor(null);
      setLineDecorations(null);
    };
  }, [monaco]);

  // The model follows the URI. Content and language changes for the same URI
  // update it in place (below), so the view keeps its scroll and selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: content and language are synced separately
  useEffect(() => {
    if (!editor) return;
    const { model, key } = acquireModel(monaco, uri, content, languageId);
    const mine = new ModelHold([key]);
    hold.current = mine;
    editor.setModel(model);
    setHeld({ uri, model });
    return () => {
      // On unmount the editor's own cleanup has already let go.
      if (hold.current !== mine) return;
      editor.setModel(null);
      mine.release();
      hold.current = null;
    };
  }, [monaco, editor, uri]);

  useEffect(() => {
    if (held?.uri === uri) syncModel(monaco, held.model, content, languageId);
  }, [monaco, held, uri, content, languageId]);

  useEffect(() => {
    if (!editor || !held || !revealLine) return;
    editor.revealLineInCenter(revealLine);
    editor.setPosition({ lineNumber: revealLine, column: 1 });
    // `revealKey` is read by its change alone.
    void revealKey;
  }, [editor, held, revealLine, revealKey]);

  useEffect(() => {
    if (!lineDecorations || !held) return;
    lineDecorations.set(
      (decorations ?? []).map((d) => ({
        range: new monaco.Range(d.startLine, 1, d.endLine, 1),
        options: {
          isWholeLine: true,
          className: d.className,
          linesDecorationsClassName: d.marginClassName,
          hoverMessage: d.hoverMessage ? { value: d.hoverMessage } : undefined,
        },
      })),
    );
  }, [monaco, lineDecorations, held, decorations]);

  const placed = useMemo<PlacedZone[]>(
    () =>
      editor ? (zones ?? []).map((zone) => ({ zone, editor, afterLine: zone.afterLine })) : [],
    [editor, zones],
  );
  const portals = useZonePortals(placed);

  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0" ref={container} />
      {portals}
    </div>
  );
}
