import type * as Monaco from "monaco-editor";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorZone } from "./types";
import { diffZones } from "./zones";

/** A zone resolved to the editor it is drawn in. */
export interface PlacedZone {
  zone: EditorZone;
  editor: Monaco.editor.ICodeEditor;
  afterLine: number;
}

interface Mounted {
  editor: Monaco.editor.ICodeEditor;
  afterLine: number;
  /** Handed to Monaco, which sizes and positions it. */
  viewZone: Monaco.editor.IViewZone;
  /** Where React renders; its natural height is what the zone is sized to. */
  content: HTMLDivElement;
  /** Whether the zone should be showing; Monaco only holds it while the editor has a model. */
  wanted: boolean;
  monacoId: string | null;
  observer: ResizeObserver;
  editorListeners: Monaco.IDisposable[];
}

// Monaco reacts to a press inside its view to place the cursor and take focus,
// which would pull focus out of a reply box in a thread.
const SHIELDED_EVENTS = ["mousedown", "pointerdown", "contextmenu"] as const;

function mount(editor: Monaco.editor.ICodeEditor, afterLine: number): Mounted {
  const domNode = document.createElement("div");
  // Monaco's text layer is stacked over its view zones and would take every
  // click meant for a button or reply box in one.
  domNode.style.zIndex = "1";
  const content = document.createElement("div");
  content.className = "review-zone";
  domNode.appendChild(content);
  for (const type of SHIELDED_EVENTS) {
    domNode.addEventListener(type, (event) => event.stopPropagation());
  }
  // Monaco hides a zone with no height, and hidden content never reports a
  // size to the observer, so a zone starts a pixel tall until it is measured.
  const viewZone: Monaco.editor.IViewZone = { afterLineNumber: afterLine, heightInPx: 1, domNode };
  const mounted: Mounted = {
    editor,
    afterLine,
    viewZone,
    content,
    wanted: false,
    monacoId: null,
    editorListeners: [],
    observer: new ResizeObserver(() => {
      const height = content.offsetHeight;
      if (height === viewZone.heightInPx || mounted.monacoId === null) return;
      viewZone.heightInPx = height;
      const id = mounted.monacoId;
      mounted.editor.changeViewZones((accessor) => accessor.layoutZone(id));
    }),
  };
  mounted.observer.observe(content);
  bindToEditor(mounted);
  return mounted;
}

/**
 * Keeps the content as wide as the visible text area and pinned to its left
 * edge. A view zone spans the full scroll width and scrolls sideways with the
 * code, which would push a thread off screen on a file with long lines.
 */
function bindToEditor(mounted: Mounted): void {
  const { editor, content } = mounted;
  const fit = () => {
    const layout = editor.getLayoutInfo();
    content.style.width = `${Math.max(0, layout.contentWidth - layout.verticalScrollbarWidth)}px`;
  };
  const pin = () => {
    content.style.transform = `translateX(${editor.getScrollLeft()}px)`;
  };
  // Monaco drops every view zone when an editor's model is swapped, and takes
  // none while it has no model, so the zone is put back for each new one.
  const restore = () => {
    mounted.monacoId = null;
    if (mounted.wanted) show(mounted);
  };
  fit();
  pin();
  mounted.editorListeners = [
    editor.onDidLayoutChange(fit),
    editor.onDidScrollChange(pin),
    editor.onDidChangeModel(restore),
  ];
}

function show(mounted: Mounted): void {
  mounted.wanted = true;
  if (!mounted.editor.getModel()) return;
  mounted.editor.changeViewZones((accessor) => {
    mounted.monacoId = accessor.addZone(mounted.viewZone);
  });
}

function hide(mounted: Mounted): void {
  mounted.wanted = false;
  const id = mounted.monacoId;
  mounted.monacoId = null;
  if (id !== null) mounted.editor.changeViewZones((accessor) => accessor.removeZone(id));
}

function unbind(mounted: Mounted): void {
  for (const listener of mounted.editorListeners) listener.dispose();
  mounted.editorListeners = [];
}

/**
 * Renders each zone's React content inside a Monaco view zone, through a
 * portal, and keeps the zone exactly as tall as that content as it grows
 * (a reply box opening, an answer streaming in).
 *
 * Returns the portals, for the caller to put anywhere in its own tree: they
 * render into Monaco's DOM but stay in the caller's React tree, so context and
 * events behave as they would inline.
 */
export function useZonePortals(placed: readonly PlacedZone[]): ReactNode[] {
  const mounted = useRef(new Map<string, Mounted>());
  const [hosts, setHosts] = useState<ReadonlyMap<string, HTMLElement>>(new Map());

  useLayoutEffect(() => {
    const current = mounted.current;
    const next = new Map(placed.map((p) => [p.zone.id, p]));
    const { add, remove } = diffZones(
      current,
      next,
      (a, b) => a.editor === b.editor && a.afterLine === b.afterLine,
    );

    for (const id of remove) {
      const m = current.get(id);
      if (!m) continue;
      hide(m);
      if (!next.has(id)) {
        m.observer.disconnect();
        unbind(m);
        current.delete(id);
      }
    }
    for (const [id, p] of add) {
      let m = current.get(id);
      if (!m) {
        m = mount(p.editor, p.afterLine);
        current.set(id, m);
      } else if (m.editor !== p.editor) {
        unbind(m);
        m.editor = p.editor;
        bindToEditor(m);
      }
      m.afterLine = p.afterLine;
      m.viewZone.afterLineNumber = p.afterLine;
      show(m);
    }

    if (add.length > 0 || remove.length > 0) {
      setHosts(new Map([...current].map(([id, m]) => [id, m.content])));
    }
  }, [placed]);

  // An editor takes its zones with it when disposed; only our side needs undoing.
  useEffect(() => {
    const current = mounted.current;
    return () => {
      for (const m of current.values()) {
        m.observer.disconnect();
        unbind(m);
      }
      current.clear();
    };
  }, []);

  return placed.flatMap(({ zone }) => {
    const host = hosts.get(zone.id);
    return host ? [createPortal(zone.render(), host, zone.id)] : [];
  });
}
