import type * as Monaco from "monaco-editor";
import type { ReviewSymbolMatch, ReviewSymbolSearchKind } from "../../../lib/reviewWorkspaces/api";
import {
  addExtraModel,
  type DefinitionTarget,
  type EditorRange,
  loadMonaco,
  onlyUnresolvedImports,
  parseReviewUri,
  REVIEW_SCHEME,
  registerNavigationProvider,
  reviewUri,
  uriKey,
} from "../editor";
import { ImportCollector } from "./importGraph";
import { isTsJsPath } from "./imports";
import { type NavigationTab, type NavigationTargets, tabForLocation } from "./location";

type MonacoApi = typeof Monaco;

/** What navigation reads about one PR; the sidecar in the app, a fixture in tests. */
export interface ReviewNavigationSource {
  tree(): Promise<string[]>;
  /** Paths the PR changes, deleted ones included. */
  changedFiles(): Promise<string[]>;
  /** A file at the head; null when missing, binary or too large. Throws when the read failed. */
  readFile(path: string): Promise<string | null>;
  search(
    kind: ReviewSymbolSearchKind,
    query: { path: string; symbol: string; line: number },
  ): Promise<ReviewSymbolMatch[]>;
}

/** The editor functions navigation uses; replaced in tests. */
export interface NavigationDeps {
  loadMonaco(): Promise<MonacoApi>;
  addExtraModel(uri: string, content: string): Promise<() => void>;
  registerNavigationProvider: typeof registerNavigationProvider;
}

const editorDeps: NavigationDeps = { loadMonaco, addExtraModel, registerNavigationProvider };

/** Identifier characters, and the trailing `?` or `!` a Ruby method may end in. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*[?!]?$/;
const TS_LANGUAGES = new Set(["typescript", "javascript"]);
/** Files loaded only so a result list can preview them; the oldest go first. */
export const MAX_PREVIEW_MODELS = 40;
/** Distinct files a reference list loads for its previews; matches beyond them are dropped. */
const MAX_REFERENCE_FILES = 30;
/** File texts kept for the import graph and previews. */
const MAX_CACHED_FILES = 300;

/** Remembered reads, least recently used out first. A failed read isn't remembered. */
class FileCache {
  private readonly files = new Map<string, Promise<string | null>>();

  constructor(private readonly read: (path: string) => Promise<string | null>) {}

  get(path: string): Promise<string | null> {
    const hit = this.files.get(path);
    if (hit) {
      this.files.delete(path);
      this.files.set(path, hit);
      return hit;
    }
    const file = this.read(path).catch(() => {
      if (this.files.get(path) === file) this.files.delete(path);
      return null;
    });
    this.files.set(path, file);
    while (this.files.size > MAX_CACHED_FILES) {
      const oldest = this.files.keys().next().value as string;
      this.files.delete(oldest);
    }
    return file;
  }
}

/** A model held for a peek list; `release` is null while it loads. */
interface PreviewSlot {
  release: (() => void) | null;
  ready: Promise<boolean>;
}

/**
 * Code navigation for one PR's head, shared by every tab showing it:
 *  - TypeScript and JavaScript get Monaco's own worker, fed with what each
 *    shown file imports (`importGraph.ts`), and with a stand-in module per
 *    tsconfig alias (`shims.ts`) so the worker resolves those too.
 *  - Every language, and TypeScript where the worker finds nothing better
 *    than the import binding itself, gets the sidecar's text search for
 *    definitions; "Find references" uses the same search.
 * Only models of this PR are answered for; another PR in the same workspace
 * has its own.
 */
export class PrNavigation {
  private readonly files: FileCache;
  /** Import-graph files and alias stand-ins; null while one loads. */
  private readonly importModels = new Map<string, (() => void) | null>();
  private readonly previewModels = new Map<string, PreviewSlot>();
  /** Stand-in path → the file it re-exports. */
  private readonly shimTargets = new Map<string, string>();
  private readonly editorSubscriptions = new Map<Monaco.editor.ICodeEditor, Monaco.IDisposable>();
  private readonly disposers: (() => void)[] = [];
  private readonly collector: Promise<ImportCollector>;
  private monaco: MonacoApi | null = null;
  /** Tree and changed files, loaded once; a jump waits for them. */
  readonly targets: Promise<NavigationTargets>;
  private disposed = false;

  constructor(
    private readonly refKey: string,
    readonly prId: string,
    private readonly source: ReviewNavigationSource,
    private readonly deps: NavigationDeps = editorDeps,
  ) {
    this.files = new FileCache((path) => source.readFile(path));
    const tree = source.tree().then((paths) => new Set(paths));
    this.targets = Promise.all([tree, source.changedFiles()]).then(([paths, changed]) => ({
      prId,
      refKey,
      tree: paths,
      changed: new Set(changed),
    }));
    this.collector = tree.then(
      (paths) => new ImportCollector({ tree: paths, readFile: (path) => this.files.get(path) }),
    );
    // Nothing to navigate without a tree; the jump just finds nothing.
    this.targets.catch((e) => console.warn("[review-navigation] couldn't list files:", e));
  }

  /** Registers the providers and starts following the editors. */
  async start(): Promise<void> {
    const monaco = await this.deps.loadMonaco();
    if (this.disposed) return;
    this.monaco = monaco;
    this.disposers.push(
      this.deps.registerNavigationProvider({
        provideDefinition: (uri, position) => this.provideDefinition(monaco, uri, position),
      }),
    );
    const references = monaco.languages.registerReferenceProvider(
      { scheme: REVIEW_SCHEME },
      { provideReferences: (model, position) => this.provideReferences(model, position) },
    );
    this.disposers.push(() => references.dispose());
    this.followEditors(monaco);
  }

  /** Opens a jump's landing as a tab, once it is known to be one of this PR's files. */
  async open(
    uri: string,
    range: EditorRange | null,
    openTab: (tab: NavigationTab) => void,
  ): Promise<void> {
    const targets = await this.targets.catch(() => null);
    const tab = targets && tabForLocation(uri, range, targets, this.shimTargets);
    if (tab && !this.disposed) openTab(tab);
  }

  dispose(): void {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const sub of this.editorSubscriptions.values()) sub.dispose();
    this.editorSubscriptions.clear();
    for (const release of this.importModels.values()) release?.();
    for (const slot of this.previewModels.values()) slot.release?.();
    this.importModels.clear();
    this.previewModels.clear();
  }

  /** The head path a model of this PR holds, or null for any other model. */
  private ownPath(uri: string, side: "head" | "any" = "head"): string | null {
    const parsed = parseReviewUri(uri);
    if (!parsed || parsed.refKey !== this.refKey) return null;
    if (side === "head" && parsed.side !== "head") return null;
    return parsed.path;
  }

  /**
   * Preloads the imports of whatever file an editor shows, including one
   * opened before this PR's navigation started and the file a peek shows.
   * Each editor's subscription goes with the editor.
   */
  private followEditors(monaco: MonacoApi): void {
    const watch = (editor: Monaco.editor.ICodeEditor) => {
      if (this.editorSubscriptions.has(editor)) return;
      const shown = editor.getModel();
      if (shown) this.preload(shown);
      const changed = editor.onDidChangeModel(() => {
        const model = editor.getModel();
        if (model) this.preload(model);
      });
      const gone = editor.onDidDispose(() => {
        this.editorSubscriptions.get(editor)?.dispose();
        this.editorSubscriptions.delete(editor);
      });
      this.editorSubscriptions.set(editor, {
        dispose: () => {
          changed.dispose();
          gone.dispose();
        },
      });
    };
    for (const editor of monaco.editor.getEditors()) watch(editor);
    const created = monaco.editor.onDidCreateEditor(watch);
    this.disposers.push(() => created.dispose());
  }

  private preload(model: Monaco.editor.ITextModel): void {
    const path = this.ownPath(uriKey(model.uri));
    if (!path || !isTsJsPath(path) || this.shimTargets.has(path)) return;
    const content = model.getValue();
    void this.collector
      .then((collector) => collector.collect({ path, content }))
      .then(async (found) => {
        for (const shim of found.shims) this.shimTargets.set(shim.path, shim.target);
        const load = [...found.files, ...found.shims];
        await Promise.all(load.map((file) => this.holdImport(file.path, file.content)));
      })
      .catch((e) => console.warn("[review-navigation] couldn't load imports:", e));
  }

  private async holdImport(path: string, content: string): Promise<void> {
    const uri = reviewUri(this.refKey, "head", path);
    if (this.disposed || this.importModels.has(uri)) return;
    // Claimed before the await so a second preload doesn't load it twice.
    this.importModels.set(uri, null);
    const release = await this.deps.addExtraModel(uri, content);
    if (this.disposed) release();
    else this.importModels.set(uri, release);
  }

  private async provideDefinition(
    monaco: MonacoApi,
    uri: string,
    position: { lineNumber: number; column: number },
  ): Promise<DefinitionTarget[]> {
    const path = this.ownPath(uri, "any");
    const model = path === null ? null : monaco.editor.getModel(monaco.Uri.parse(uri));
    if (path === null || !model) return [];
    const word = model.getWordAtPosition(position);
    if (!word || !IDENTIFIER.test(word.word)) return [];
    if (TS_LANGUAGES.has(model.getLanguageId())) {
      const getWorker = async () => {
        const forLanguage =
          model.getLanguageId() === "typescript"
            ? monaco.typescript.getTypeScriptWorker
            : monaco.typescript.getJavaScriptWorker;
        return (await forLanguage())(model.uri);
      };
      if (await workerAnswers(getWorker, model, position)) return [];
    }
    const matches = await this.search("definitions", path, word.word, position);
    return this.withPreviews(matches, word.word.length);
  }

  private async provideReferences(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
  ): Promise<Monaco.languages.Location[]> {
    const monaco = this.monaco;
    const path = this.ownPath(uriKey(model.uri), "any");
    if (path === null || !monaco) return [];
    const word = model.getWordAtPosition(position);
    if (!word || !IDENTIFIER.test(word.word)) return [];
    const matches = await this.search("references", path, word.word, position);
    const targets = await this.withPreviews(matches, word.word.length, MAX_REFERENCE_FILES);
    return targets.map((target) => ({ uri: monaco.Uri.parse(target.uri), range: target.range }));
  }

  private search(
    kind: ReviewSymbolSearchKind,
    path: string,
    symbol: string,
    position: { lineNumber: number },
  ): Promise<ReviewSymbolMatch[]> {
    return this.source.search(kind, { path, symbol, line: position.lineNumber }).catch((e) => {
      // A checkout still running answers 409; a jump that finds nothing says enough.
      console.warn(`[review-navigation] ${kind} search failed:`, e);
      return [];
    });
  }

  /**
   * Targets for `matches`, with each file loaded as a model first: Monaco's
   * peek list and its Cmd-hover preview read a target from its model, and
   * drop one that has none. Matches in files that can't be loaded are dropped.
   */
  private async withPreviews(
    matches: ReviewSymbolMatch[],
    length: number,
    maxFiles = Number.POSITIVE_INFINITY,
  ): Promise<DefinitionTarget[]> {
    const paths = [...new Set(matches.map((match) => match.path))].slice(0, maxFiles);
    const loaded = new Set<string>();
    await Promise.all(
      paths.map(async (path) => {
        const uri = reviewUri(this.refKey, "head", path);
        // An import model still loading doesn't count; the preview hold waits for its own.
        if (this.importModels.get(uri) || (await this.holdPreview(uri, path))) loaded.add(path);
      }),
    );
    return matches
      .filter((match) => loaded.has(match.path))
      .map((match) => ({
        uri: reviewUri(this.refKey, "head", match.path),
        range: {
          startLineNumber: match.line,
          startColumn: match.column,
          endLineNumber: match.line,
          endColumn: match.column + length,
        },
      }));
  }

  private holdPreview(uri: string, path: string): Promise<boolean> {
    const held = this.previewModels.get(uri);
    if (held) {
      // Most recently used goes to the back.
      this.previewModels.delete(uri);
      this.previewModels.set(uri, held);
      return held.ready;
    }
    // Claimed before any await, so a second request for the file shares this one.
    const slot: PreviewSlot = { release: null, ready: Promise.resolve(false) };
    this.previewModels.set(uri, slot);
    slot.ready = (async () => {
      const content = await this.files.get(path);
      if (content === null || this.disposed || this.previewModels.get(uri) !== slot) {
        if (this.previewModels.get(uri) === slot) this.previewModels.delete(uri);
        return false;
      }
      const release = await this.deps.addExtraModel(uri, content);
      if (this.disposed || this.previewModels.get(uri) !== slot) {
        release();
        return false;
      }
      slot.release = release;
      this.evictPreviews();
      return true;
    })();
    return slot.ready;
  }

  /**
   * Drops the oldest preview models past the limit, keeping any an editor
   * (a peek's embedded one included) is showing and any still loading.
   */
  private evictPreviews(): void {
    if (this.previewModels.size <= MAX_PREVIEW_MODELS) return;
    const shown = new Set(
      (this.monaco?.editor.getEditors() ?? []).flatMap((editor) => {
        const model = editor.getModel();
        return model ? [uriKey(model.uri)] : [];
      }),
    );
    for (const [uri, slot] of this.previewModels) {
      if (this.previewModels.size <= MAX_PREVIEW_MODELS) return;
      if (!slot.release || shown.has(uri)) continue;
      this.previewModels.delete(uri);
      slot.release();
    }
  }
}

/**
 * Whether the TypeScript worker already has a real answer here, in which case
 * the text search stays out of the way: its guesses would turn the worker's
 * one exact jump into a list. An unresolved import is no answer
 * (`onlyUnresolvedImports`), so the search is wanted.
 */
export async function workerAnswers(
  getWorker: () => Promise<{
    getDefinitionAtPosition(
      fileName: string,
      offset: number,
    ): Promise<readonly { fileName: string; kind: string }[] | undefined>;
  }>,
  model: Pick<Monaco.editor.ITextModel, "uri" | "getOffsetAt" | "isDisposed">,
  position: { lineNumber: number; column: number },
): Promise<boolean> {
  try {
    const worker = await getWorker();
    const self = model.uri.toString();
    const entries = await worker.getDefinitionAtPosition(self, model.getOffsetAt(position));
    if (!entries || entries.length === 0 || model.isDisposed()) return false;
    return !onlyUnresolvedImports(entries, self);
  } catch {
    // The worker isn't up yet or failed; the search still can answer.
    return false;
  }
}

const live = new Map<string, { navigation: PrNavigation; holders: number }>();

/**
 * The shared navigation for a PR, made on first use and torn down when the
 * last holder releases it. `key` names the PR at one head, so a refresh to a
 * new head starts over with the new tree.
 */
export function acquirePrNavigation(input: {
  key: string;
  refKey: string;
  prId: string;
  source: () => ReviewNavigationSource;
  deps?: NavigationDeps;
}): { navigation: PrNavigation; release: () => void } {
  let entry = live.get(input.key);
  if (!entry) {
    const navigation = new PrNavigation(input.refKey, input.prId, input.source(), input.deps);
    entry = { navigation, holders: 0 };
    live.set(input.key, entry);
    navigation.start().catch((e) => console.warn("[review-navigation] couldn't start:", e));
  }
  entry.holders++;
  const held = entry;
  let released = false;
  return {
    navigation: held.navigation,
    release: () => {
      if (released) return;
      released = true;
      held.holders--;
      if (held.holders > 0) return;
      live.delete(input.key);
      held.navigation.dispose();
    },
  };
}
