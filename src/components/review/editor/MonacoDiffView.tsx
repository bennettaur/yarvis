import type * as Monaco from "monaco-editor";
import { useEffect, useMemo, useRef, useState } from "react";
import { monacoLanguageForPath } from "./language";
import { attachLineActions } from "./lineActions";
import { type MonacoApi, useMonaco } from "./loader";
import { BASE_EDITOR_OPTIONS, EditorPlaceholder } from "./MonacoFileView";
import { acquireModel, ModelHold, syncModel } from "./models";
import { type OpenLocationHandler, setOpenLocationHandler } from "./navigation";
import type { EditorZone, LineAction } from "./types";
import { type PlacedZone, useZonePortals } from "./useZonePortals";
import { type LineChange, placeZones } from "./zones";

export interface MonacoDiffViewProps {
  /** The base side's `review://` URI (from `reviewUri(…, "base", oldPath ?? path)`). */
  originalUri: string;
  /** The head side's `review://` URI. */
  modifiedUri: string;
  /** Picks the language for both sides. */
  path: string;
  original: string;
  modified: string;
  /** Two columns, or one with removed lines shown above their replacements. */
  sideBySide: boolean;
  /** Folds unchanged stretches away behind a bar that expands them. */
  hideUnchanged: boolean;
  zones?: EditorZone[];
  onLineAction?: (action: LineAction) => void;
  /** A line of the modified side, scrolled to and centred whenever it changes. */
  revealLine?: number;
  /** A go-to-definition that lands in another file. */
  onOpenLocation?: OpenLocationHandler;
}

/**
 * A read-only diff of one file in Monaco. Size it with its parent: it fills it.
 *
 * Inline, there is no original editor to hang things on, so left-side zones
 * are drawn in the modified editor under the change they belong to, and the
 * line buttons only offer the right side.
 */
export function MonacoDiffView(props: MonacoDiffViewProps) {
  const state = useMonaco();
  if (state.status !== "ready") {
    return <EditorPlaceholder error={state.status === "error" ? state.error : undefined} />;
  }
  return <DiffEditor monaco={state.monaco} {...props} />;
}

function diffOptions(
  sideBySide: boolean,
  hideUnchanged: boolean,
): Monaco.editor.IDiffEditorOptions {
  return {
    renderSideBySide: sideBySide,
    // The caller decides the layout; Monaco would otherwise switch to inline
    // by itself whenever the pane is narrow.
    useInlineViewWhenSpaceIsLimited: false,
    hideUnchangedRegions: {
      enabled: hideUnchanged,
      contextLineCount: 3,
      minimumLineCount: 3,
      revealLineCount: 20,
    },
  };
}

function DiffEditor({
  monaco,
  originalUri,
  modifiedUri,
  path,
  original,
  modified,
  sideBySide,
  hideUnchanged,
  zones,
  onLineAction,
  revealLine,
  onOpenLocation,
}: MonacoDiffViewProps & { monaco: MonacoApi }) {
  const container = useRef<HTMLDivElement>(null);
  const [diff, setDiff] = useState<Monaco.editor.IStandaloneDiffEditor | null>(null);
  // The models on screen and the URIs they were made for, so content is only
  // ever written into the models it belongs to.
  const [held, setHeld] = useState<{
    originalUri: string;
    modifiedUri: string;
    original: Monaco.editor.ITextModel;
    modified: Monaco.editor.ITextModel;
  } | null>(null);
  const hold = useRef<ModelHold | null>(null);
  const [changes, setChanges] = useState<LineChange[]>([]);
  const callbacks = useRef({ onLineAction, onOpenLocation });
  callbacks.current = { onLineAction, onOpenLocation };
  const language = monacoLanguageForPath(path);

  // biome-ignore lint/correctness/useExhaustiveDependencies: later layout changes go through updateOptions
  useEffect(() => {
    if (!container.current) return;
    const made = monaco.editor.createDiffEditor(container.current, {
      ...BASE_EDITOR_OPTIONS,
      ...diffOptions(sideBySide, hideUnchanged),
      originalEditable: false,
      enableSplitViewResizing: true,
      renderMarginRevertIcon: false,
      renderOverviewRuler: false,
    });
    const getOpen = () => callbacks.current.onOpenLocation;
    setOpenLocationHandler(made.getOriginalEditor(), getOpen);
    setOpenLocationHandler(made.getModifiedEditor(), getOpen);
    const getAction = () => callbacks.current.onLineAction;
    const actions = [
      attachLineActions(monaco, made.getOriginalEditor(), () => "LEFT", getAction),
      attachLineActions(monaco, made.getModifiedEditor(), () => "RIGHT", getAction),
    ];
    // `getLineChanges` is the only public view of the computed diff in this
    // Monaco version; the richer `getDiffComputationResult` is internal.
    const diffUpdates = made.onDidUpdateDiff(() => setChanges(made.getLineChanges() ?? []));
    setDiff(made);
    return () => {
      diffUpdates.dispose();
      for (const a of actions) a.dispose();
      made.setModel(null);
      hold.current?.release();
      hold.current = null;
      made.dispose();
      setDiff(null);
    };
  }, [monaco]);

  useEffect(() => {
    diff?.updateOptions(diffOptions(sideBySide, hideUnchanged));
  }, [diff, sideBySide, hideUnchanged]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: content and language are synced separately
  useEffect(() => {
    if (!diff) return;
    const base = acquireModel(monaco, originalUri, original, language);
    const head = acquireModel(monaco, modifiedUri, modified, language);
    const mine = new ModelHold([base.key, head.key]);
    hold.current = mine;
    // The last diff's hunks describe other files until this one is computed.
    setChanges([]);
    diff.setModel({ original: base.model, modified: head.model });
    setHeld({ originalUri, modifiedUri, original: base.model, modified: head.model });
    return () => {
      // On unmount the editor's own cleanup has already let go.
      if (hold.current !== mine) return;
      diff.setModel(null);
      mine.release();
      hold.current = null;
    };
  }, [monaco, diff, originalUri, modifiedUri]);

  useEffect(() => {
    if (held?.originalUri !== originalUri || held.modifiedUri !== modifiedUri) return;
    syncModel(monaco, held.original, original, language);
    syncModel(monaco, held.modified, modified, language);
  }, [monaco, held, originalUri, modifiedUri, original, modified, language]);

  useEffect(() => {
    if (!diff || !held || !revealLine) return;
    const editor = diff.getModifiedEditor();
    editor.revealLineInCenter(revealLine);
    editor.setPosition({ lineNumber: revealLine, column: 1 });
  }, [diff, held, revealLine]);

  const placed = useMemo<PlacedZone[]>(() => {
    if (!diff || !zones?.length) return [];
    const where = placeZones(zones, sideBySide, changes);
    return zones.flatMap((zone) => {
      const at = where.get(zone.id);
      if (!at) return [];
      const editor = at.editor === "LEFT" ? diff.getOriginalEditor() : diff.getModifiedEditor();
      return [{ zone, editor, afterLine: at.afterLine }];
    });
  }, [diff, zones, sideBySide, changes]);
  const portals = useZonePortals(placed);

  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0" ref={container} />
      {portals}
    </div>
  );
}
