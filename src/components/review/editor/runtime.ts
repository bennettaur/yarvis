import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { getColorTheme, onColorTheme } from "../../../lib/theme";
import { installNavigation } from "./navigation";
import { defineThemes, monacoThemeFor } from "./themes";
import "./reviewEditor.css";

// Everything here runs once, the first time an editor mounts (`loader.ts`
// imports this module lazily).

// Workers are bundled by Vite as files of our own origin; Monaco's default
// would build them from a CDN URL, which the CSP's `script-src 'self'` refuses.
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

defineThemes(monaco);
monaco.editor.setTheme(monacoThemeFor(getColorTheme()));
// Monaco's theme is global to every editor, so one listener covers them all.
onColorTheme(() => monaco.editor.setTheme(monacoThemeFor(getColorTheme())));

installNavigation(monaco);

export { monaco };
