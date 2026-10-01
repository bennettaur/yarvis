import type { EditorSelection, Extension, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorPlace } from "../../lib/editorPlaces";

/**
 * What a new view needs to open at `initialPlace` and keep reporting where the
 * user is: the selection and scroll position to start with, and an extension
 * that calls `onPlaceChange` as either moves.
 *
 * The scroll snapshot needs no fit check, unlike the selection: CodeMirror clips
 * one that points past the end of a shorter document.
 */
export function placeConfig(
  initialPlace: EditorPlace | null | undefined,
  doc: string,
  onPlaceChange: (place: EditorPlace) => void,
): {
  selection: EditorSelection | undefined;
  scrollTo: StateEffect<unknown> | undefined;
  extension: Extension;
} {
  const scrollSnapshot = initialPlace?.scrollSnapshot ?? null;
  return {
    selection: restoredSelection(initialPlace, doc.length),
    scrollTo: scrollSnapshot ?? undefined,
    extension: trackPlace(scrollSnapshot, onPlaceChange),
  };
}

/**
 * Dropped when it no longer fits: a remounted tab re-reads the file, which may
 * have shrunk while it was away (the agent rewrote it), and a selection past the
 * end of the document is a RangeError.
 */
function restoredSelection(
  place: EditorPlace | null | undefined,
  docLength: number,
): EditorSelection | undefined {
  const selection = place?.selection;
  if (!selection || selection.ranges.some((range) => range.to > docLength)) return undefined;
  return selection;
}

function trackPlace(
  initialScrollSnapshot: EditorPlace["scrollSnapshot"],
  onPlaceChange: (place: EditorPlace) => void,
): Extension {
  // Starts as the snapshot the view opened at, so a cursor move before the
  // first scroll doesn't report the restored position as null.
  let scrollSnapshot = initialScrollSnapshot;
  return [
    EditorView.updateListener.of((update) => {
      // The snapshot names a document offset, so an edit above it would
      // otherwise restore to a few lines off.
      if (update.docChanged && scrollSnapshot) {
        scrollSnapshot = scrollSnapshot.map(update.changes) ?? null;
      }
      if (update.selectionSet || update.docChanged) {
        onPlaceChange({ selection: update.state.selection, scrollSnapshot });
      }
    }),
    // Taken on every scroll because it can't be taken at teardown: by the time
    // the unmount cleanup runs, the view is detached and reads as scrolled to
    // the top.
    EditorView.domEventHandlers({
      scroll: (_event, view) => {
        scrollSnapshot = view.scrollSnapshot();
        onPlaceChange({ selection: view.state.selection, scrollSnapshot });
      },
    }),
  ];
}
