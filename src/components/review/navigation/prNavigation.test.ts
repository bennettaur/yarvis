import { describe, expect, it } from "bun:test";
import type { NavigationProvider } from "../editor";
import { reviewUri } from "../editor";
import {
  acquirePrNavigation,
  MAX_PREVIEW_MODELS,
  type NavigationDeps,
  type ReviewNavigationSource,
  workerAnswers,
} from "./prNavigation";

const REF = "gh:o/r/9";
const uri = (path: string) => reviewUri(REF, "head", path);

/** A URI as Monaco hands it over; not the review scheme, so `uriKey` keeps its string. */
const fakeUri = (value: string) => ({
  scheme: "fake",
  authority: "",
  path: "",
  toString: () => value,
});

function fakeModel(path: string, content: string, word = "load", language = "python") {
  return {
    uri: fakeUri(uri(path)),
    getValue: () => content,
    getLanguageId: () => language,
    getWordAtPosition: () => ({ word, startColumn: 1, endColumn: word.length + 1 }),
    getOffsetAt: () => 0,
    isDisposed: () => false,
  };
}

type FakeModel = ReturnType<typeof fakeModel>;

function fakeEditor(model: FakeModel | null) {
  const changeListeners = new Set<() => void>();
  const disposeListeners = new Set<() => void>();
  let current = model;
  return {
    getModel: () => current,
    onDidChangeModel(cb: () => void) {
      changeListeners.add(cb);
      return { dispose: () => changeListeners.delete(cb) };
    },
    onDidDispose(cb: () => void) {
      disposeListeners.add(cb);
      return { dispose: () => disposeListeners.delete(cb) };
    },
    show(next: FakeModel) {
      current = next;
      for (const cb of changeListeners) cb();
    },
    dispose() {
      for (const cb of [...disposeListeners]) cb();
    },
    listeners: () => changeListeners.size + disposeListeners.size,
  };
}

/** Monaco, the editor module's functions and a PR, all in memory. */
function harness(files: Record<string, string>, opts: { search?: string[] } = {}) {
  const definitionProviders = new Set<NavigationProvider>();
  const referenceProviders = new Set<unknown>();
  const models = new Map<string, FakeModel>();
  const loaded = new Map<string, string>();
  const released: string[] = [];
  const editors: ReturnType<typeof fakeEditor>[] = [];
  let monacoReady: (() => void) | null = null;
  const monacoGate = new Promise<void>((resolve) => {
    monacoReady = resolve;
  });
  let gateMonaco = false;

  const monaco = {
    editor: {
      getEditors: () => editors,
      onDidCreateEditor: () => ({ dispose() {} }),
      getModel: (u: { toString(): string }) => models.get(u.toString()) ?? null,
    },
    Uri: { parse: (value: string) => fakeUri(value) },
    languages: {
      registerReferenceProvider(_selector: unknown, provider: unknown) {
        referenceProviders.add(provider);
        return { dispose: () => referenceProviders.delete(provider) };
      },
    },
    typescript: {
      getTypeScriptWorker: async () => async () => ({
        getDefinitionAtPosition: async () => [],
      }),
      getJavaScriptWorker: async () => async () => ({ getDefinitionAtPosition: async () => [] }),
    },
  };

  const deps: NavigationDeps = {
    loadMonaco: async () => {
      if (gateMonaco) await monacoGate;
      return monaco as never;
    },
    addExtraModel: async (u, content) => {
      loaded.set(u, content);
      return () => {
        released.push(u);
        loaded.delete(u);
      };
    },
    registerNavigationProvider: (provider) => {
      definitionProviders.add(provider);
      return () => definitionProviders.delete(provider);
    },
  };

  let readGate: Promise<void> | null = null;
  const source: ReviewNavigationSource = {
    tree: async () => Object.keys(files),
    changedFiles: async () => [],
    readFile: async (path) => {
      if (readGate) await readGate;
      return files[path] ?? null;
    },
    search: async () =>
      (opts.search ?? []).map((path) => ({ path, line: 1, column: 5, preview: "def load():" })),
  };

  // Each harness is its own PR as far as the shared registry knows.
  const key = `harness-${nextId++}`;
  return {
    loaded,
    released,
    editors,
    definitionProviders,
    referenceProviders,
    acquire: () =>
      acquirePrNavigation({ key, refKey: REF, prId: "pr-9", source: () => source, deps }),
    gateMonaco: () => {
      gateMonaco = true;
      return () => monacoReady?.();
    },
    gateReads: () => {
      let open = () => {};
      readGate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        readGate = null;
        open();
      };
    },
    addModel(path: string, content: string, word?: string, language?: string) {
      const model = fakeModel(path, content, word, language);
      models.set(uri(path), model);
      return model;
    },
  };
}
let nextId = 0;

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("acquirePrNavigation", () => {
  it("shares one navigation across holders and ends it with the last (StrictMode's double effect)", async () => {
    const h = harness({ "a.py": "" });
    const first = h.acquire();
    const second = h.acquire();
    expect(second.navigation).toBe(first.navigation);
    await settle();
    expect(h.definitionProviders.size).toBe(1);
    expect(h.referenceProviders.size).toBe(1);

    first.release();
    first.release();
    expect(h.definitionProviders.size).toBe(1);
    second.release();
    expect(h.definitionProviders.size).toBe(0);
    expect(h.referenceProviders.size).toBe(0);

    const again = h.acquire();
    expect(again.navigation).not.toBe(first.navigation);
    again.release();
  });

  it("registers nothing when released before Monaco has loaded", async () => {
    const h = harness({ "a.py": "" });
    const open = h.gateMonaco();
    const held = h.acquire();
    held.release();
    open();
    await settle();
    expect(h.definitionProviders.size).toBe(0);
    expect(h.referenceProviders.size).toBe(0);
  });
});

describe("PrNavigation", () => {
  const files = {
    "tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
    "src/main.ts": 'import { add } from "./math";\nimport { greet } from "@/greet";\n',
    "src/math.ts": "export const add = 1;",
    "src/greet.ts": "export const greet = 1;",
  };

  it("loads a shown file's imports and alias stand-ins, and lets them all go on release", async () => {
    const h = harness(files);
    h.editors.push(fakeEditor(h.addModel("src/main.ts", files["src/main.ts"])));
    const held = h.acquire();
    await settle();
    expect([...h.loaded.keys()].sort()).toEqual(
      [uri("node_modules/@/greet.ts"), uri("src/greet.ts"), uri("src/math.ts")].sort(),
    );

    // A jump on the alias's module string lands on the stand-in; the real file opens.
    const opened: unknown[] = [];
    await held.navigation.open(uri("node_modules/@/greet.ts"), null, (tab) => opened.push(tab));
    expect(opened).toEqual([{ kind: "file", prId: "pr-9", path: "src/greet.ts" }]);

    held.release();
    expect(h.loaded.size).toBe(0);
  });

  it("releases what a preload finishes after the navigation ended", async () => {
    const h = harness(files);
    h.editors.push(fakeEditor(h.addModel("src/main.ts", files["src/main.ts"])));
    const open = h.gateReads();
    const held = h.acquire();
    await settle();
    held.release();
    open();
    await settle();
    expect(h.loaded.size).toBe(0);
  });

  it("drops an editor's subscriptions when the editor goes", async () => {
    const h = harness(files);
    const editor = fakeEditor(null);
    h.editors.push(editor);
    const held = h.acquire();
    await settle();
    expect(editor.listeners()).toBe(2);
    editor.dispose();
    expect(editor.listeners()).toBe(0);
    held.release();
  });

  it("keeps preview models to the limit, never one an editor is showing", async () => {
    const paths = Array.from({ length: MAX_PREVIEW_MODELS + 5 }, (_, i) => `m${i}.py`);
    const h = harness(Object.fromEntries(paths.map((p) => [p, "def load(): pass"])), {
      search: paths,
    });
    const asking = h.addModel("ask.py", "load()");
    // The first match is on screen, in a peek, say.
    const shown = h.addModel("m0.py", "def load(): pass");
    h.editors.push(fakeEditor(shown));
    const held = h.acquire();
    await settle();
    const [provider] = [...h.definitionProviders];
    const targets = await provider?.provideDefinition(asking.uri.toString(), {
      lineNumber: 1,
      column: 1,
    });
    expect(targets).toHaveLength(paths.length);
    const previews = [...h.loaded.keys()].filter((u) => u.includes("/head/m"));
    expect(previews.length).toBeLessThanOrEqual(MAX_PREVIEW_MODELS);
    expect(h.released).not.toContain(uri("m0.py"));
    expect(h.released.length).toBe(paths.length - MAX_PREVIEW_MODELS);
    held.release();
    expect(h.loaded.size).toBe(0);
  });
});

describe("workerAnswers", () => {
  const model = {
    uri: fakeUri(uri("a.ts")),
    getOffsetAt: () => 10,
    isDisposed: () => false,
  } as never;
  const at = { lineNumber: 1, column: 1 };
  const answering = (entries: { fileName: string; kind: string }[]) => async () => ({
    getDefinitionAtPosition: async () => entries,
  });

  it("is no answer when the only definition is an unresolved import's own binding", async () => {
    // However the import is wrapped (a Prettier-wrapped `import {\n a,\n} from`),
    // the worker reports the binding as kind `alias` in the asking file.
    expect(
      await workerAnswers(answering([{ fileName: uri("a.ts"), kind: "alias" }]), model, at),
    ).toBe(false);
  });

  it("is an answer when the worker lands anywhere real", async () => {
    expect(
      await workerAnswers(answering([{ fileName: uri("b.ts"), kind: "function" }]), model, at),
    ).toBe(true);
    expect(
      await workerAnswers(answering([{ fileName: uri("a.ts"), kind: "const" }]), model, at),
    ).toBe(true);
  });

  it("is no answer when there is nothing, or the worker fails", async () => {
    expect(await workerAnswers(answering([]), model, at)).toBe(false);
    const failing = async () => {
      throw new Error("TypeScript not registered!");
    };
    expect(await workerAnswers(failing as never, model, at)).toBe(false);
  });
});
