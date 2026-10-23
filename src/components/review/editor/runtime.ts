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
import { installNavigation } from "./navigation";
import { type QuickInfo, quickInfoHover } from "./quickInfo";
import { defineThemes, monacoThemeFor } from "./themes";
import { onlyUnresolvedImports, type WorkerDefinition } from "./tsDefinitions";
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
// description) and Monaco renders images in it, so no built-in hover is used.
// A mode's configuration is replaced whole and a missing key turns that
// feature off, hence the spread.
function withoutHovers<C extends { readonly hovers?: boolean }>(defaults: {
  readonly modeConfiguration: C;
  setModeConfiguration(configuration: C): void;
}): void {
  defaults.setModeConfiguration({ ...defaults.modeConfiguration, hovers: false });
}
withoutHovers(monaco.typescript.typescriptDefaults);
withoutHovers(monaco.typescript.javascriptDefaults);
// Go-to-definition is served below too, so it can leave out an unresolved import.
for (const defaults of [
  monaco.typescript.typescriptDefaults,
  monaco.typescript.javascriptDefaults,
]) {
  defaults.setModeConfiguration({ ...defaults.modeConfiguration, definitions: false });
}
withoutHovers(monaco.css.cssDefaults);
withoutHovers(monaco.css.scssDefaults);
withoutHovers(monaco.css.lessDefaults);
withoutHovers(monaco.html.htmlDefaults);
withoutHovers(monaco.html.handlebarDefaults);
withoutHovers(monaco.html.razorDefaults);
withoutHovers(monaco.json.jsonDefaults);

// TypeScript and JavaScript get their hover back from here: the same quick
// info Monaco's own provider shows, rendered by `quickInfoHover`, which
// escapes images and grants no trust or HTML.
for (const [language, getWorker] of [
  ["typescript", monaco.typescript.getTypeScriptWorker],
  ["javascript", monaco.typescript.getJavaScriptWorker],
] as const) {
  monaco.languages.registerHoverProvider(language, {
    async provideHover(model, position) {
      const worker = await (await getWorker())(model.uri);
      if (model.isDisposed()) return null;
      const info: QuickInfo | undefined = await worker.getQuickInfoAtPosition(
        model.uri.toString(),
        model.getOffsetAt(position),
      );
      if (!info || model.isDisposed()) return null;
      const start = model.getPositionAt(info.textSpan.start);
      const end = model.getPositionAt(info.textSpan.start + info.textSpan.length);
      return {
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        contents: quickInfoHover(info),
      };
    },
  });

  // Go-to-definition from the worker, less one answer: an import whose module
  // didn't resolve points back at its own binding, which would sit beside the
  // text search's guesses (`navigation.ts` providers) and turn every such
  // jump into a list of two. Targets without a model (the worker's lib files)
  // are left out; a review only opens its own files.
  monaco.languages.registerDefinitionProvider(language, {
    async provideDefinition(model, position) {
      const worker = await (await getWorker())(model.uri);
      if (model.isDisposed()) return null;
      const self = model.uri.toString();
      const entries: readonly WorkerDefinition[] | undefined = await worker.getDefinitionAtPosition(
        self,
        model.getOffsetAt(position),
      );
      if (!entries || model.isDisposed() || onlyUnresolvedImports(entries, self)) return null;
      return entries.flatMap((entry) => {
        const target = monaco.editor.getModel(monaco.Uri.parse(entry.fileName));
        if (!target) return [];
        const start = target.getPositionAt(entry.textSpan.start);
        const end = target.getPositionAt(entry.textSpan.start + entry.textSpan.length);
        return [
          {
            uri: target.uri,
            range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          },
        ];
      });
    },
  });
}

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
