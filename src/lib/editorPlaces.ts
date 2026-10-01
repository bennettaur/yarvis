import type { EditorSelection, StateEffect } from "@codemirror/state";

/**
 * Where the user was in each open file: the cursor and the scroll position.
 *
 * Held app-wide for the same reason `fileDrafts` is — a tab switch unmounts the
 * editor, and a fresh CodeMirror view opens at the top with the cursor on line
 * one (#258). Keyed by `draftKey`, so a file's place and its buffer are found
 * the same way.
 *
 * Not reactive: the editor reads its place once, when it mounts, so nothing
 * needs to re-render when it changes. Memory only, like the drafts.
 */
export interface EditorPlace {
  selection: EditorSelection;
  /** From `EditorView.scrollSnapshot()`. It records a line and an offset from
   *  it rather than a pixel offset, so it survives the new view measuring its
   *  lines differently. */
  scroll: StateEffect<unknown> | null;
}

let places: Map<string, EditorPlace> = new Map();

export function getEditorPlace(key: string): EditorPlace | null {
  return places.get(key) ?? null;
}

export function setEditorPlace(key: string, place: EditorPlace): void {
  places.set(key, place);
}

/** Drops every place. For tests. */
export function resetEditorPlaces(): void {
  places = new Map();
}
