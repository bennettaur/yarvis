import { afterEach, describe, expect, it } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorPlace } from "../../lib/editorPlaces";
import { placeConfig } from "./place";

const DOC = "one\ntwo\nthree\nfour\n";

let views: EditorView[] = [];

afterEach(() => {
  for (const view of views) view.destroy();
  views = [];
});

/** Opens a view at `place` with `placeConfig`, as `CodeEditor` does. */
const open = (
  doc: string,
  place: EditorPlace | null,
  onPlaceChange: (place: EditorPlace) => void = () => undefined,
) => {
  const config = placeConfig(place, doc, onPlaceChange);
  const view = new EditorView({
    parent: document.body,
    scrollTo: config.scrollTo,
    state: EditorState.create({ doc, selection: config.selection, extensions: config.extension }),
  });
  views.push(view);
  return view;
};

/** A real snapshot of `doc`, taken off a view of its own. */
const snapshotOf = (doc: string) => open(doc, null).scrollSnapshot();

const scroll = (view: EditorView) => view.scrollDOM.dispatchEvent(new Event("scroll"));

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

    const second = open(DOC, reported);

    expect(second.state.selection.main.anchor).toBe(4);
    expect(second.state.selection.main.head).toBe(7);
  });

  it("starts at the top when the remembered cursor is past the end of the file", () => {
    const place: EditorPlace = {
      selection: EditorSelection.single(DOC.length),
      scrollSnapshot: null,
    };

    const view = open("one\n", place);

    expect(view.state.selection.main.head).toBe(0);
  });

  it("keeps a remembered cursor at the very end of the file", () => {
    const place: EditorPlace = { selection: EditorSelection.single(4), scrollSnapshot: null };

    const view = open("one\n", place);

    expect(view.state.selection.main.head).toBe(4);
  });

  it("reports a scroll position once the editor scrolls", () => {
    let reported = null as EditorPlace | null;
    const view = open(DOC, null, (place) => (reported = place));

    scroll(view);

    expect(reported?.scrollSnapshot).not.toBeNull();
  });

  it("keeps the scroll position it opened with when only the cursor moves", () => {
    const snapshot = snapshotOf(DOC);
    let reported = null as EditorPlace | null;
    const view = open(
      DOC,
      { selection: EditorSelection.single(0), scrollSnapshot: snapshot },
      (place) => (reported = place),
    );

    view.dispatch({ selection: { anchor: 9 } });

    expect(reported?.scrollSnapshot).toBe(snapshot);
  });

  it("maps the scroll position through an edit", () => {
    const snapshot = snapshotOf(DOC);
    let reported = null as EditorPlace | null;
    const view = open(
      DOC,
      { selection: EditorSelection.single(0), scrollSnapshot: snapshot },
      (place) => (reported = place),
    );

    view.dispatch({ changes: { from: 0, insert: "zero\n" } });

    expect(reported?.scrollSnapshot).not.toBe(snapshot);
    expect(reported?.scrollSnapshot).not.toBeNull();
  });

  it("opens a shorter file when the remembered scroll is past its end", () => {
    const place: EditorPlace = {
      selection: EditorSelection.single(0),
      scrollSnapshot: snapshotOf(DOC.repeat(50)),
    };

    expect(() => open("one\n", place)).not.toThrow();
  });
});
