import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

/** The Tailwind zinc steps the rest of the app reaches through classes. Spelled
 *  out here because CodeMirror is styled through a JS theme, not the class list,
 *  and a palette change has to be able to find them. */
const ZINC = {
  950: "#09090b",
  900: "#18181b",
  800: "#27272a",
  600: "#52525b",
  400: "#a1a1aa",
};

/** Background and gutter, so the editor sits in the app's palette rather than
 *  One Dark's. The syntax colours are One Dark's and left alone. */
const appSurface = EditorView.theme({
  "&": { height: "100%", backgroundColor: ZINC[950], fontSize: "12px" },
  ".cm-gutters": {
    backgroundColor: ZINC[950],
    borderRight: `1px solid ${ZINC[800]}`,
    color: ZINC[600],
  },
  ".cm-activeLine": { backgroundColor: ZINC[900] },
  ".cm-activeLineGutter": { backgroundColor: ZINC[900], color: ZINC[400] },
  "&.cm-focused": { outline: "none" },
});

/** Holds the grammar, which arrives after the view is already on screen. A
 *  compartment is a stateless marker, so one shared by every editor is enough. */
const LANGUAGE_SLOT = new Compartment();

/**
 * A CodeMirror 6 editor, wrapped so React owns when it exists and CodeMirror
 * owns what is inside it.
 *
 * The view is created once per mount and then driven by dispatches rather than
 * re-rendered: rebuilding it on every keystroke would throw away the selection,
 * the undo history, and the scroll position. `value` is therefore treated as the
 * text the document *should* hold — a change to it the editor didn't make (a
 * reload from disk) is applied as a replacement, and one it did make is already
 * there and ignored. A different file belongs in a different mount, so that its
 * undo history cannot reach back into the file before it; the caller keys it.
 *
 * Grammars load lazily. `@codemirror/language-data` describes every language it
 * supports without pulling any of them in, so the bundle carries one grammar per
 * language actually opened, fetched as its own chunk.
 */
export default function CodeEditor({
  value,
  path,
  onChange,
  onSave,
}: {
  value: string;
  /** Chooses the grammar; the file's name is what carries the language. */
  path: string;
  onChange: (text: string) => void;
  /** Cmd/Ctrl+S inside the editor. */
  onSave: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The handlers the extensions call. Held in refs so a fresh closure from the
  // parent's render doesn't mean tearing down and rebuilding the editor.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  // Mount-only: `value` seeds the document and is synced by the effect below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is created once and then dispatched to
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          oneDark,
          appSurface,
          LANGUAGE_SLOT.of([]),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    let live = true;
    // The basename, not the path: `matchFilename` matches whole-filename
    // grammars (Dockerfile, Makefile) against what it is given, so a path would
    // leave `docker/Dockerfile` uncoloured while a root one worked.
    const description = LanguageDescription.matchFilename(languages, path.split("/").pop() ?? path);
    if (!description) {
      viewRef.current?.dispatch({ effects: LANGUAGE_SLOT.reconfigure([]) });
      return;
    }
    // A grammar we have no chunk for (or that fails to load) leaves the file
    // uncoloured, which is what an unrecognised extension already gets.
    void description
      .load()
      .then((support: LanguageSupport) => {
        if (live) viewRef.current?.dispatch({ effects: LANGUAGE_SLOT.reconfigure(support) });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [path]);

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />;
}
