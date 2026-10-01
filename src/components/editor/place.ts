import type { EditorSelection, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorPlace } from "../../lib/editorPlaces";

/**
 * The selection to open a document with, from a place recorded on an earlier
 * view. Dropped when it no longer fits: the file may have shrunk since (a
 * reload from disk), and a selection past the end of the document is a
 * RangeError.
 */
export function restoredSelection(
  place: EditorPlace | null | undefined,
  docLength: number,
): EditorSelection | undefined {
  const selection = place?.selection;
  if (!selection || selection.ranges.some((range) => range.to > docLength)) return undefined;
  return selection;
}

/** Reports the cursor and scroll position each time either changes.
 *  `initialScroll` is where the view opened, carried until the user scrolls. */
export function trackPlace(
  initialScroll: EditorPlace["scroll"],
  onChange: (place: EditorPlace) => void,
): Extension {
  let scroll = initialScroll;
  return [
    EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) {
        onChange({ selection: update.state.selection, scroll });
      }
    }),
    // Snapshotted on scroll rather than per keystroke, since taking one reads
    // layout.
    EditorView.domEventHandlers({
      scroll: (_event, view) => {
        scroll = view.scrollSnapshot();
        onChange({ selection: view.state.selection, scroll });
      },
    }),
  ];
}
