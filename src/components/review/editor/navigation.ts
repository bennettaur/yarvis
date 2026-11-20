import type * as Monaco from "monaco-editor";
import { useEffect } from "react";
import type { MonacoApi } from "./loader";
import type { EditorRange } from "./types";
import { REVIEW_SCHEME, reviewUriFromParts } from "./uri";

export interface DefinitionTarget {
  uri: string;
  range: EditorRange;
}

/**
 * A source of go-to-definition answers for review files, on top of what
 * Monaco's own TypeScript worker finds within the files it holds. `uri` is a
 * `review://` URI; positions are 1-based, as Monaco's are.
 */
export interface NavigationProvider {
  provideDefinition(
    uri: string,
    position: { lineNumber: number; column: number },
  ): Promise<DefinitionTarget[]>;
}

/**
 * Called when a jump lands in a file other than the one on screen. `uri` is
 * always a `review://` URI, but it can come from a definition provider or
 * the language worker reading PR code, so a host must check it with
 * `parseReviewUri` (and that it names a PR and path it has) before acting.
 */
export type OpenLocationHandler = (uri: string, range: EditorRange | null) => void;

const providers = new Set<NavigationProvider>();

/** Adds a definition provider for every review editor. Returns the unregister. */
export function registerNavigationProvider(provider: NavigationProvider): () => void {
  providers.add(provider);
  return () => {
    providers.delete(provider);
  };
}

/**
 * {@link registerNavigationProvider} for the lifetime of a component. The
 * provider must be stable (memoized): a new object each render would be
 * unregistered and registered again on every one.
 */
export function useMonacoNavigation(provider: NavigationProvider | null): void {
  useEffect(() => (provider ? registerNavigationProvider(provider) : undefined), [provider]);
}

const openHandlers = new WeakMap<
  Monaco.editor.ICodeEditor,
  () => OpenLocationHandler | undefined
>();

/**
 * Routes jumps out of `editor` to the host. Takes a getter so the host's
 * latest callback is used without re-registering on every render.
 */
export function setOpenLocationHandler(
  editor: Monaco.editor.ICodeEditor,
  handler: () => OpenLocationHandler | undefined,
): void {
  openHandlers.set(editor, handler);
}

/**
 * The string form the rest of the review editor keys by. Monaco re-encodes a
 * URI's path its own way when printing it, so a review URI is rebuilt from its
 * decoded parts rather than taken from `toString()`.
 */
export function uriKey(
  uri: Pick<Monaco.Uri, "scheme" | "authority" | "path" | "toString">,
): string {
  if (uri.scheme !== REVIEW_SCHEME) return uri.toString();
  return reviewUriFromParts(uri.authority, uri.path) ?? uri.toString();
}

function toRange(at: Monaco.IRange | Monaco.IPosition | undefined): EditorRange | null {
  if (!at) return null;
  if ("startLineNumber" in at) {
    return {
      startLineNumber: at.startLineNumber,
      startColumn: at.startColumn,
      endLineNumber: at.endLineNumber,
      endColumn: at.endColumn,
    };
  }
  return {
    startLineNumber: at.lineNumber,
    startColumn: at.column,
    endLineNumber: at.lineNumber,
    endColumn: at.column,
  };
}

/**
 * Wires the registry into Monaco, once, when it loads. The definition provider
 * asks every registered provider and merges what they say; one that fails is
 * dropped from the answer rather than failing the jump. The opener is what
 * makes a cross-file jump reach the host: standalone Monaco only knows how to
 * move within the model already on screen. It takes only review files; any
 * other URI is refused, and links go to `openExternal` instead (`runtime.ts`).
 */
export function installNavigation(monaco: MonacoApi): void {
  monaco.languages.registerDefinitionProvider(
    { scheme: REVIEW_SCHEME },
    {
      async provideDefinition(model, position) {
        if (providers.size === 0) return null;
        const uri = uriKey(model.uri);
        const at = { lineNumber: position.lineNumber, column: position.column };
        const answers = await Promise.allSettled(
          [...providers].map((provider) => provider.provideDefinition(uri, at)),
        );
        return answers.flatMap((answer) =>
          answer.status === "fulfilled"
            ? answer.value.map((target) => ({
                uri: monaco.Uri.parse(target.uri),
                range: target.range,
              }))
            : [],
        );
      },
    },
  );

  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      if (resource.scheme !== REVIEW_SCHEME) return false;
      const handler = openHandlers.get(source)?.();
      if (!handler) return false;
      handler(uriKey(resource), toRange(selectionOrPosition));
      return true;
    },
  });
}
