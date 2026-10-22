import * as monaco from "monaco-editor";
// `monaco-editor` is pinned to an exact version in package.json because these
// worker paths are internal to its package layout, not public API, and have
// moved between minor releases (0.53 and 0.55 both reshuffled the package).
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { getColorTheme, onColorTheme } from "../../../lib/theme";
import { openExternal } from "../../../lib/url";
import { safeHoverContents } from "./hoverSafety";
import { installNavigation } from "./navigation";
import { defineThemes, monacoThemeFor } from "./themes";
import "./reviewEditor.css";

// Everything here runs once, the first time an editor mounts (`loader.ts`
// imports this module lazily).

// Workers are bundled by Vite as files of our own origin. Without this, Monaco
// starts each worker from a `blob:` bootstrap script, which the CSP refuses:
// it sets no `worker-src`, so workers fall under `script-src 'self'`.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

// A review shows files lifted out of their project, with none of its
// dependencies or config, so the worker's diagnostics would be almost all
// unresolved imports. The worker stays for navigation and hovers.
for (const defaults of [
  monaco.typescript.typescriptDefaults,
  monaco.typescript.javascriptDefaults,
]) {
  defaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  });
  // Without this the worker only sees models some editor is showing, and a
  // file added for cross-file navigation would be invisible to it.
  defaults.setEagerModelSync(true);
  defaults.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
  });
}

// Hover text comes from the code under review (a JSDoc comment, a schema
// description), so every hover provider's answer is passed through
// `safeHoverContents` before Monaco renders it. The language modes register
// their providers through this same object when a language is first used,
// which is after this runs, so wrapping the registration covers all of them.
const registerHoverProvider = monaco.languages.registerHoverProvider;
(
  monaco.languages as { registerHoverProvider: typeof registerHoverProvider }
).registerHoverProvider = (selector, provider) =>
  registerHoverProvider(selector, {
    async provideHover(model, position, token, context) {
      const hover = await provider.provideHover(model, position, token, context);
      return hover ? { ...hover, contents: safeHoverContents(hover.contents) } : hover;
    },
  });

// A link in code or in a hover would otherwise go to `window.open`, or
// navigate the webview itself. Everything is handled here, and only http(s)
// reaches the system browser.
monaco.editor.registerLinkOpener({
  open(resource) {
    openExternal(resource.toString());
    return true;
  },
});

defineThemes(monaco);
monaco.editor.setTheme(monacoThemeFor(getColorTheme()));
// Monaco's theme is global to every editor, so one listener covers them all.
onColorTheme(() => monaco.editor.setTheme(monacoThemeFor(getColorTheme())));

installNavigation(monaco);

export { monaco };
