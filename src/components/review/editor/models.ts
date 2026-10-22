import type * as Monaco from "monaco-editor";
import { monacoLanguageForPath } from "./language";
import { loadMonaco, type MonacoApi } from "./loader";
import { ModelCache } from "./modelCache";
import { uriKey } from "./navigation";

const cache = new ModelCache<Monaco.editor.ITextModel>();

/**
 * The model for `uri` holding `content`, held until {@link releaseModel} is
 * called with the returned key. A model already open for the same URI is
 * shared and brought up to date, which is what lets two tabs on one file agree.
 */
export function acquireModel(
  monaco: MonacoApi,
  uri: string,
  content: string,
  language: string,
): { model: Monaco.editor.ITextModel; key: string } {
  const parsed = monaco.Uri.parse(uri);
  const key = uriKey(parsed);
  const model = cache.acquire(key, () => {
    const made =
      monaco.editor.getModel(parsed) ?? monaco.editor.createModel(content, language, parsed);
    made.onWillDispose(() => cache.forget(key));
    return made;
  });
  syncModel(monaco, model, content, language);
  return { model, key };
}

export function releaseModel(key: string): void {
  cache.release(key);
}

/** Brings a held model up to date with what the caller now has. */
export function syncModel(
  monaco: MonacoApi,
  model: Monaco.editor.ITextModel,
  content: string,
  language: string,
): void {
  if (model.getValue() !== content) model.setValue(content);
  if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);
}

/**
 * Puts a file the user has not opened in front of Monaco's language workers.
 * The TypeScript worker answers go-to-definition only from the models it
 * holds, so a host that knows which files a file imports can hand them over
 * here and jumps into them start working. The model stays until the returned
 * disposer runs.
 */
export async function addExtraModel(uri: string, content: string): Promise<() => void> {
  const monaco = await loadMonaco();
  const path = monaco.Uri.parse(uri).path;
  const { key } = acquireModel(monaco, uri, content, monacoLanguageForPath(path));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseModel(key);
  };
}
