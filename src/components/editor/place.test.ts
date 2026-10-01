import { afterEach, describe, expect, it } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorPlace } from "../../lib/editorPlaces";
import { restoredSelection, trackPlace } from "./place";

const DOC = "one\ntwo\nthree\nfour\n";

let views: EditorView[] = [];

afterEach(() => {
  for (const view of views) view.destroy();
  views = [];
});

/** Opens a view the way `CodeEditor` does, restoring `place` and reporting to
 *  `onChange`. */
const open = (doc: string, place: EditorPlace | null, onChange: (p: EditorPlace) => void) => {
  const view = new EditorView({
    parent: document.body,
    scrollTo: place?.scroll ?? undefined,
    state: EditorState.create({
      doc,
      selection: restoredSelection(place, doc.length),
      extensions: [trackPlace(place?.scroll ?? null, onChange)],
    }),
  });
  views.push(view);
  return view;
};

describe("editor place", () => {
  it("reports where the cursor moved", () => {
    let reported = null as EditorPlace | null;
    const view = open(DOC, null, (place) => (reported = place));

    view.dispatch({ selection: { anchor: 9 } });

    expect(reported?.selection.main.head).toBe(9);
  });

  it("opens a second view where the first one left off", () => {
    let reported = null as EditorPlace | null;
    open(DOC, null, (place) => (reported = place)).dispatch({ selection: { anchor: 4, head: 7 } });

    const second = open(DOC, reported, () => undefined);

    expect(second.state.selection.main.anchor).toBe(4);
    expect(second.state.selection.main.head).toBe(7);
  });

  it("starts at the top when the remembered cursor is past the end of the file", () => {
    const place: EditorPlace = { selection: EditorSelection.single(DOC.length), scroll: null };

    const view = open("one\n", place, () => undefined);

    expect(view.state.selection.main.head).toBe(0);
  });

  it("keeps a remembered cursor that still fits a shorter file", () => {
    const place: EditorPlace = { selection: EditorSelection.single(2), scroll: null };
    expect(restoredSelection(place, 4)?.main.head).toBe(2);
  });
});
